"""本机后台执行：一次命令以前台 shell 为生命周期边界（ADR-0017）。

一次执行是一个 setsid 进程组，组长是 shell。调用方等多久与执行无关；shell 退出或显式停止触发统一收尾：
观察退出但不回收组长（PGID 不会被复用）→ 终止原进程组 → 有界收集输出 → 结算。

结算与释放是两个事实：结算表示结果已经确定并可交付；释放表示组长已回收、输出读取已停止，
本模块不再持有该执行的任何资源。二者通常同时发生；收尾期限内做不到释放时，结果如实标明，
执行继续由执行表持有，之后释放，关闭时仍未释放的汇总报告。
只依赖 POSIX 进程接口；剩余组员的判定需要 Linux /proc，其他平台一律报告清理未确认。
"""

from __future__ import annotations

import asyncio
import os
import select
import signal
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from wandrun.integrations.shell_backend import CleanupUnconfirmedError

_POLL = 0.05
# 结算后仍未释放的执行，多久检查一次。
_RELEASE_POLL = 0.5
# 收尾时等待管道 EOF 的上限；脱组后代持有写端时到此为止。
OUTPUT_GRACE = 2.0
# 请求停止读取后，读取线程最多再用多久退出（它每 _READ_WAIT 检查一次停止标志）。
_READER_STOP = 1.0
_READ_WAIT = 0.1
_READ_CHUNK = 65536
# 启动失败回滚时，等待被 SIGKILL 的组长退出的上限。
_ROLLBACK_WAIT = 1.0
LOG_LIMIT = 10 * 1024 * 1024
INLINE_HEAD = 20_000
INLINE_TAIL = 30_000


def live_members(pgid: int) -> list[int] | None:
    """Linux /proc 中 PGID 相同、状态不是僵尸的进程（包括仍在运行的组长）；无法扫描时返回 None。

    扫描不是原子快照：组员可能在扫描期间 fork 后退出。结果只能用来缩短等待，
    或在 SIGKILL 之后（组内进程不能再创建新成员，组只会缩小）确认组已清空。
    """
    try:
        entries = os.listdir("/proc")
    except OSError:
        return None
    members = []
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat", "rb") as file:
                stat = file.read()
        except (FileNotFoundError, ProcessLookupError):
            continue  # 扫描期间退出并已被回收
        except OSError:
            return None
        # comm 可能含空格和括号，以最后一个 ")" 为界：其后依次是 state、ppid、pgrp。
        fields = stat.rsplit(b")", 1)[1].split()
        if int(fields[2]) == pgid and fields[0] not in (b"Z", b"X"):
            members.append(int(entry))
    return members


class _Output:
    """一个执行的输出：读取线程把管道写入日志（超限轮换为 .1），内存中保留头尾两段供交付。

    契约：finish() 有界结束读取，返回后 eof 与 stopped 是确定的事实；stopped 为 False 表示读取线程
    （例如卡在日志写入中）仍可能写日志，持有者须继续等待 stopped，不能当作已停止。
    """

    def __init__(self, pipe, log_path: Path, on_log_error: Callable[[str], None]):
        self._pipe = pipe
        self._log_path = log_path
        self._on_log_error = on_log_error
        self._lock = threading.Lock()
        self._head = bytearray()
        self._tail: deque[bytes] = deque()
        self._tail_size = 0
        self._total = 0
        self.eof = False
        self.log_error: str | None = None
        self._log_size = 0
        self._log = None
        try:
            self._log = open(log_path, "wb")
        except OSError as error:
            self._fail(error)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="wandrun-process-output", daemon=True)
        try:
            self._thread.start()
        except BaseException:
            self._close_log()
            raise

    @property
    def stopped(self) -> bool:
        return not self._thread.is_alive()

    async def finish(self) -> None:
        """等管道 EOF（最多 OUTPUT_GRACE），再请求停止读取并最多等 _READER_STOP。"""
        deadline = time.monotonic() + OUTPUT_GRACE
        while not self.stopped and time.monotonic() < deadline:
            await asyncio.sleep(_POLL)
        self._stop.set()
        deadline = time.monotonic() + _READER_STOP
        while not self.stopped and time.monotonic() < deadline:
            await asyncio.sleep(_POLL)

    def text(self, tail_only: int | None = None) -> str:
        """已读取的输出：总量不超过头尾两段时完整返回，否则标出省略的字节数。"""
        with self._lock:
            head = bytes(self._head)
            tail = b"".join(self._tail)
            total = self._total
        if tail_only is not None:
            return (head + tail)[-tail_only:].decode("utf-8", errors="replace")
        omitted = total - len(head) - len(tail)
        if omitted <= 0:
            return (head + tail).decode("utf-8", errors="replace")
        return (
            head.decode("utf-8", errors="replace")
            + f"\n... 省略 {omitted} 字节，完整输出见日志 ...\n"
            + tail.decode("utf-8", errors="replace")
        )

    def _run(self) -> None:
        fd = self._pipe.fileno()
        poller = select.poll()
        poller.register(fd, select.POLLIN | select.POLLHUP | select.POLLERR)
        try:
            while not self._stop.is_set():
                if not poller.poll(_READ_WAIT * 1000):
                    continue
                chunk = os.read(fd, _READ_CHUNK)
                if not chunk:
                    self.eof = True
                    return
                self._keep(chunk)
                self._write(chunk)
        finally:
            self._close_log()
            self._pipe.close()

    def _keep(self, chunk: bytes) -> None:
        with self._lock:
            self._total += len(chunk)
            room = INLINE_HEAD - len(self._head)
            if room > 0:
                self._head += chunk[:room]
                chunk = chunk[room:]
            if chunk:
                self._tail.append(chunk)
                self._tail_size += len(chunk)
            # 按字节裁剪，尾部恰好不超过 INLINE_TAIL，与管道的读取分块无关。
            while self._tail_size > INLINE_TAIL:
                excess = self._tail_size - INLINE_TAIL
                oldest = self._tail[0]
                if len(oldest) <= excess:
                    self._tail.popleft()
                    self._tail_size -= len(oldest)
                else:
                    self._tail[0] = oldest[excess:]
                    self._tail_size -= excess

    def _write(self, chunk: bytes) -> None:
        if self._log is None:
            return  # 写入已失败：继续读取并丢弃，避免写端因管道写满而阻塞
        try:
            if self._log_size and self._log_size + len(chunk) > LOG_LIMIT:
                self._log.close()
                os.replace(self._log_path, f"{self._log_path}.1")
                self._log = open(self._log_path, "wb")
                self._log_size = 0
            self._log.write(chunk)
            self._log.flush()
            self._log_size += len(chunk)
        except OSError as error:
            self._fail(error)

    def _close_log(self) -> None:
        if self._log is not None:
            log, self._log = self._log, None
            try:
                log.close()
            except OSError as error:
                self._fail(error)

    def _fail(self, error: OSError) -> None:
        self._close_log()
        if self.log_error is None:
            self.log_error = f"{type(error).__name__}: {error}"
            self._on_log_error(self.log_error)


class Execution:
    """一次 exec_command：running → finalizing → settled，只结算一次；之后在 released 时释放全部资源。

    退出观察、发信号和最终回收都由本对象的生命周期任务完成。收尾结束前任何路径都不回收组长，
    因此不使用 Popen.poll/wait/communicate。构造失败时已回滚派生的进程组，不留下未登记的命令。
    """

    def __init__(
        self,
        table: ProcessTable,
        process_id: str,
        owner: str,
        command: str,
        log_path: Path,
        cwd: Path,
        on_settled: Callable[[Execution], None],
        on_log_error: Callable[[Execution], None],
        env: dict[str, str] | None = None,
    ):
        self.process_id = process_id
        self.owner = owner
        self.command = command
        self.log_path = log_path
        self.state = "running"
        self.exit_code: int | None = None
        self.exit_observed = False
        self.stop_reason: str | None = None
        self.cleanup_confirmed: bool | None = None
        self.error: str | None = None
        self.reaped = False
        self.released = False
        self._table = table
        self._on_settled = on_settled
        self._on_log_error = on_log_error
        self._log_reported = False
        loop = asyncio.get_running_loop()
        self.settled: asyncio.Future[dict] = loop.create_future()
        self._process = subprocess.Popen(  # noqa: S602
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            cwd=cwd,
            env={**os.environ, **env} if env else None,
            start_new_session=True,
        )
        self.pgid = self._process.pid
        try:
            self._output = _Output(
                self._process.stdout,
                log_path,
                lambda message: loop.call_soon_threadsafe(self._log_failed),
            )
            self._lifecycle = asyncio.create_task(self._run(), name=f"process:{process_id}")
        except BaseException:
            self._roll_back_start()
            raise

    def _roll_back_start(self) -> None:
        """派生后初始化失败：终止整组、回收组长、关闭管道。只在构造中调用，尚无其他持有者。"""
        try:
            os.killpg(self.pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + _ROLLBACK_WAIT
        while time.monotonic() < deadline:
            pid, status = os.waitpid(self.pgid, os.WNOHANG)
            if pid:
                self._process.returncode = os.waitstatus_to_exitcode(status)
                break
            time.sleep(0.01)
        # 仍未退出（不可中断等待）时交给 Popen：对象被回收后由 subprocess 的后台清理回收组长。
        self._process.stdout.close()

    # 生命周期

    async def _run(self) -> None:
        try:
            while not self._observe_exit() and self.stop_reason is None:
                await asyncio.sleep(_POLL)
            self.state = "finalizing"
            await self._terminate()
            await self._output.finish()
            self._observe_exit()
        except Exception as error:
            # 收尾自身出错也必须结算，否则等待结果的调用方会一直挂起；清理按未确认报告。
            self.cleanup_confirmed = False
            self.error = f"{type(error).__name__}: {error}"
        self.state = "settled"
        self.settled.set_result(self.result())
        try:
            self._on_settled(self)  # 交付可能失败（如调度存储提交失败），异常在释放之后照常传播
        finally:
            # 释放不依赖交付是否成功。期限内做不到的，结果已如实交付，在此等到为止。
            while not self._try_release():
                await asyncio.sleep(_RELEASE_POLL)

    def _try_release(self) -> bool:
        """组长已退出就回收；组长已回收且读取已停止时释放，执行表不再持有本执行。"""
        if self._observe_exit():
            self._reap()
        if not self.released and self.reaped and self._output.stopped:
            self.released = True
            self._table._release(self)
        return self.released

    def _observe_exit(self) -> bool:
        """非阻塞观察组长是否退出；WNOWAIT 只读取状态，组长保持未回收，PGID 继续有效。"""
        if self.exit_observed:
            return True
        try:
            info = os.waitid(os.P_PID, self.pgid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        except ChildProcessError:
            # 不应发生：组长只由这里回收。按已退出、退出码未知处理，不再向该 PGID 发信号。
            self.exit_observed = self.reaped = True
            return True
        if info is None:
            return False
        self.exit_code = info.si_status if info.si_code == os.CLD_EXITED else -info.si_status
        self.exit_observed = True
        return True

    def _signal(self, sig: int) -> None:
        if self.reaped:
            return
        try:
            os.killpg(self.pgid, sig)
        except ProcessLookupError:
            pass

    async def _terminate(self) -> None:
        """TERM → 宽限 → 无条件 KILL → 宽限。扫描只缩短等待；KILL 之后组不再增长，空扫描才算确认。"""
        grace = self._table.termination_grace
        self._signal(signal.SIGTERM)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and live_members(self.pgid) != []:
            await asyncio.sleep(_POLL)
        self._signal(signal.SIGKILL)
        deadline = time.monotonic() + grace
        while True:
            members = live_members(self.pgid)
            if members == []:
                self.cleanup_confirmed = True
                return
            if members is None or time.monotonic() >= deadline:
                self.cleanup_confirmed = False
                return
            await asyncio.sleep(_POLL)

    def _reap(self) -> None:
        if self.reaped:
            return
        try:
            os.waitpid(self.pgid, 0)  # 已观察到退出，不会阻塞
        except ChildProcessError:
            pass
        self.reaped = True
        # 告诉 Popen 进程已回收，它不会再对这个（可能被复用的）PID 调用 waitpid。
        self._process.returncode = self.exit_code if self.exit_code is not None else -signal.SIGKILL

    def _log_failed(self) -> None:
        if self.state != "settled" and not self._log_reported:
            self._log_reported = True
            self._on_log_error(self)

    # 对外

    def request_stop(self, reason: str) -> asyncio.Future[dict]:
        """显式停止：只在仍运行时生效；已在收尾或已结算时等待同一次收尾。"""
        if self.state == "running" and self.stop_reason is None:
            self.stop_reason = reason
        return self.settled

    def output(self, tail_only: int | None = None) -> str:
        return self._output.text(tail_only)

    def unconfirmed(self) -> list[str]:
        """收尾中无法确认的事实；为空表示清理已确认且全部资源已释放（或即将释放）。"""
        problems = []
        if self.cleanup_confirmed is False:
            problems.append("进程组清理未确认")
        if not self.exit_observed:
            problems.append("组长未退出")
        elif not self.reaped:
            problems.append("组长未回收")
        if self.state == "settled" and not self._output.stopped:
            problems.append("输出读取未停止")
        return problems

    def result(self, *, tail_only: int | None = None) -> dict:
        """只报告实际掌握的事实；未结算时是当前快照。"""
        data: dict = {
            "process_id": self.process_id,
            "status": self.state if self.state != "settled" else (
                "stopped" if self.stop_reason is not None else "exited"
            ),
            "log": str(self.log_path),
        }
        if self.state == "settled":
            if self.stop_reason is not None:
                data["stopped_by"] = self.stop_reason
            data["exit_code"] = self.exit_code
            if not self.exit_observed:
                data["note"] = "组长在收尾期限内没有退出：退出码未知，进程可能仍在运行，不能认定已停止。"
            data["cleanup"] = "confirmed" if self.cleanup_confirmed else "unconfirmed"
            data["output_complete"] = self._output.eof
            # 读取线程已停止：输出与日志不会再变化。否则日志仍可能被写入。
            data["output_settled"] = self._output.stopped
        if self.error is not None:
            data["error"] = self.error
        if self._output.log_error is not None:
            data["log_error"] = self._output.log_error
        data["output"] = self.output(tail_only)
        return data


class ProcessTable:
    """一个本机环境的执行表：登记、显式停止、按 owner 停止、关闭；不解释 Worker 调度与结果交付。

    表持有每个执行直到它释放资源；关闭时汇总无法确认的收尾。
    """

    def __init__(self, *, cwd: Path, log_dir: Path, termination_grace: float):
        self.cwd = cwd
        self.termination_grace = termination_grace
        self._run_id = uuid4().hex[:6]
        self._log_dir = log_dir / self._run_id
        self._count = 0
        self._executions: dict[str, Execution] = {}
        self._closed = False

    def start(
        self,
        command: str,
        owner: str,
        *,
        on_settled: Callable[[Execution], None],
        on_log_error: Callable[[Execution], None],
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> Execution:
        """启动并登记；返回前已登记。启动失败时抛出异常，且不留下任何进程。"""
        if self._closed:
            raise RuntimeError("执行环境已关闭，不再启动命令")
        if not command.strip():
            raise ValueError("命令不能为空")
        self._count += 1
        process_id = f"p{self._run_id}-{self._count}"
        self._log_dir.mkdir(parents=True, exist_ok=True)
        execution = Execution(
            self,
            process_id,
            owner,
            command,
            self._log_dir / f"{process_id}.log",
            cwd or self.cwd,
            on_settled,
            on_log_error,
            env,
        )
        self._executions[process_id] = execution
        return execution

    def get(self, process_id: str) -> Execution | None:
        """仍由本表持有（未结算或未释放）的执行。"""
        return self._executions.get(process_id)

    def _release(self, execution: Execution) -> None:
        self._executions.pop(execution.process_id, None)

    def pending(self) -> bool:
        """是否还有待交付结果的执行（运行中或收尾中）。"""
        return any(item.state != "settled" for item in self._executions.values())

    async def stop_owners(self, owners: set[str]) -> list[str]:
        """停止这些 owner 名下的全部执行，等待它们结算（不等待未释放的资源）。

        返回结算时清理未确认的执行说明，为空表示都已确认；结果本身仍按交付规则送达 owner。
        """
        executions = [
            execution
            for execution in list(self._executions.values())
            if execution.owner in owners
        ]
        if executions:
            await asyncio.shield(
                asyncio.gather(*(execution.request_stop("cancelled") for execution in executions))
            )
        return [report for execution in executions if (report := _unconfirmed_report(execution))]

    async def aclose(self) -> None:
        """停止接收命令，收尾全部执行；清理未确认或仍未释放的执行汇总报告。幂等。

        关闭期间的结果不会再交给 Agent，所以这里是这些事实唯一的报告路径。
        """
        self._closed = True
        executions = list(self._executions.values())
        await asyncio.gather(*(execution.request_stop("closed") for execution in executions))
        for execution in executions:
            execution._try_release()  # 已退出未回收的在此回收，不能只清空记录
        reports = [report for execution in executions if (report := _unconfirmed_report(execution))]
        for execution in executions:
            if not execution.released:
                execution._lifecycle.cancel()  # 不再等待释放：已作为未确认报告
        self._executions.clear()
        if reports:
            raise CleanupUnconfirmedError("本机执行收尾未确认：" + "；".join(reports))


def _unconfirmed_report(execution: Execution) -> str | None:
    """一个执行收尾中无法确认的事实，形如“p…-1（进程组清理未确认）”；都已确认时为 None。"""
    problems = execution.unconfirmed()
    return f"{execution.process_id}（{'、'.join(problems)}）" if problems else None
