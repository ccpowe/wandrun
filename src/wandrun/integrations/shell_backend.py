"""在任务取消、命令超时或关闭时终止完整进程组的本地 shell 后端。"""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import sys
import time
from collections.abc import Iterator
from concurrent.futures import Future
from threading import RLock, Thread

from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import ExecuteResponse

_POLL_INTERVAL = 0.01


class ManagedShellBackend(LocalShellBackend):
    """保留 LocalShellBackend 接口，并显式管理正在运行的子进程组。"""

    def __init__(self, *args, termination_grace: float = 2.0, **kwargs):
        super().__init__(*args, **kwargs)
        self._termination_grace = termination_grace
        self._processes: set[subprocess.Popen] = set()
        self._process_lock = RLock()
        self._closed = False

    def _group_alive(self, process: subprocess.Popen) -> bool:
        """进程组是否仍有成员；顺带回收已退出的组长。组长退出不代表同组进程都已退出。"""
        if process.poll() is None:
            return True
        if sys.platform == "win32":
            return False
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return False
        return True

    def _signal_group(self, process: subprocess.Popen, *, force: bool) -> None:
        if sys.platform == "win32":
            if process.poll() is None:
                process.kill() if force else process.terminate()
            return
        try:
            os.killpg(process.pid, signal.SIGKILL if force else signal.SIGTERM)
        except ProcessLookupError:
            pass

    def _termination(self, process: subprocess.Popen) -> Iterator[float]:
        """先 SIGTERM，宽限期后整组仍有成员再 SIGKILL；产出每次检查前要等待的秒数。

        同步和异步调用方各自执行等待，共用同一套终止判定。SIGKILL 后仍等一个宽限期：
        成员已死但无人回收（如容器内 PID 1 不回收孤儿）时组会一直“存在”，不能无限等待。
        """
        for force in (False, True):
            if not self._group_alive(process):
                return
            self._signal_group(process, force=force)
            deadline = time.monotonic() + self._termination_grace
            while self._group_alive(process) and time.monotonic() < deadline:
                yield _POLL_INTERVAL

    def _stop_process(self, process: subprocess.Popen) -> None:
        for delay in self._termination(process):
            time.sleep(delay)

    async def _astop_process(self, process: subprocess.Popen) -> None:
        # 在事件循环上等待，不排在可能已被命令等待占满的线程池后面。
        for delay in self._termination(process):
            await asyncio.sleep(delay)

    def close(self) -> None:
        """停止接收命令，并终止已启动的进程；与 execute 的启动注册互斥。"""
        with self._process_lock:
            self._closed = True
            processes = list(self._processes)
        for process in processes:
            self._stop_process(process)

    def _start(self, command: str, *, env: dict[str, str] | None = None) -> subprocess.Popen:
        with self._process_lock:
            if self._closed:
                raise RuntimeError("Shell backend is closed")
            process = subprocess.Popen(  # noqa: S602
                command,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                env={**(self._env or os.environ), **env} if env else self._env,
                cwd=str(self.cwd),
                start_new_session=(sys.platform != "win32"),
            )
            self._processes.add(process)
        return process

    def _collect(self, process: subprocess.Popen, timeout: int) -> ExecuteResponse:
        timed_out = False
        try:
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                self._stop_process(process)
                stdout, stderr = process.communicate()
        finally:
            with self._process_lock:
                self._processes.discard(process)

        if timed_out:
            return timed_out_response(timeout)
        return execute_response(stdout, stderr, process.returncode, self._max_output_bytes)

    def _timeout(self, timeout: int | None) -> int:
        effective_timeout = timeout if timeout is not None else self._default_timeout
        if effective_timeout <= 0:
            raise ValueError(f"timeout must be positive, got {effective_timeout}")
        return effective_timeout

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if not command or not isinstance(command, str):
            return invalid_command_response()
        effective_timeout = self._timeout(timeout)
        return self._collect(self._start(command), effective_timeout)

    async def aexecute(
        self, command: str, *, timeout: int | None = None, env: dict[str, str] | None = None  # noqa: ASYNC109
    ) -> ExecuteResponse:
        """等待放在专用线程中；调用方被取消时由这里终止进程组，而不是等到超时或关闭。

        进程在事件循环线程中启动，取消无论落在哪个 await 上都能拿到它。
        收集线程随进程立即启动，不在共享线程池中排队：超时从启动起计算，
        管道关闭和注销也不会因取消而被跳过。
        取消传播出去时，整个进程组已经终止（或已到 SIGKILL 后的宽限上限）。
        """
        if not command or not isinstance(command, str):
            return invalid_command_response()
        effective_timeout = self._timeout(timeout)
        process = self._start(command, env=env)
        collected: Future[ExecuteResponse] = Future()
        # 标记为运行中：调用方取消时不能撤销它，收尾始终由收集线程完成。
        collected.set_running_or_notify_cancel()

        def collect() -> None:
            try:
                collected.set_result(self._collect(process, effective_timeout))
            except BaseException as error:
                collected.set_exception(error)

        try:
            Thread(target=collect, name="wandrun-shell-collect", daemon=True).start()
        except BaseException:
            self._stop_process(process)
            self._collect(process, effective_timeout)
            raise
        try:
            return await asyncio.wrap_future(collected)
        except asyncio.CancelledError:
            stopping = asyncio.create_task(self._astop_process(process))
            # 再次取消不截断终止，等终止完成后仍传播取消（与 session 的收尾方式相同）。
            while not stopping.done():
                try:
                    await asyncio.shield(stopping)
                except asyncio.CancelledError:
                    pass
            stopping.result()
            raise


class CleanupUnconfirmedError(RuntimeError):
    """环境中有无法确认已结束的命令：远端调用（ADR-0014）或本机遗留执行（ADR-0017）。只在关闭时用于汇总报告。

    运行中不抛出：无法确认时工具结果已如实告诉 Agent，由它检查和纠正。
    """


def timed_out_response(timeout: int) -> ExecuteResponse:
    return ExecuteResponse(
        output=f"Error: Command timed out after {timeout} seconds.",
        exit_code=124,
        truncated=False,
    )


def execute_response(
    stdout: str, stderr: str, returncode: int, max_output_bytes: int, *, dropped: bool = False
) -> ExecuteResponse:
    """本机与远端命令共用的结果格式：stdout、逐行标注的 stderr、截断说明和非零退出码。

    dropped 表示收集阶段已经丢弃了部分输出（按字节），不能从最终字符串长度推断。
    """
    output_parts = []
    if stdout:
        output_parts.append(stdout)
    if stderr:
        output_parts.extend(f"[stderr] {line}" for line in stderr.strip().split("\n"))
    output = "\n".join(output_parts) if output_parts else "<no output>"
    truncated = False
    if dropped or len(output) > max_output_bytes:
        output = output[:max_output_bytes]
        output += f"\n\n... Output truncated at {max_output_bytes} bytes."
        truncated = True
    if returncode != 0:
        output = f"{output.rstrip()}\n\nExit code: {returncode}"
    return ExecuteResponse(output=output, exit_code=returncode, truncated=truncated)


def invalid_command_response() -> ExecuteResponse:
    return ExecuteResponse(
        output="Error: Command must be a non-empty string.",
        exit_code=1,
        truncated=False,
    )
