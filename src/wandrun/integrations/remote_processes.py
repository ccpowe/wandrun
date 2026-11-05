"""Session-bound remote command ownership, live output and honest terminal results.

The table implements the same command-tool contract as Local, not a local OS process
facade. A lost session ends tracking with an unknown result; it never resubmits a run
or reconnects in order to signal a possibly reused PID.
"""

from __future__ import annotations

import asyncio
import base64
import posixpath
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.integrations.ssh_backend import ChannelClosed, SSHBackend

INLINE_HEAD = 20_000
INLINE_TAIL = 30_000
PREPARE_STOP_LIMIT = 5.0


class CommandExecution(Protocol):
    process_id: str
    owner: str
    state: str
    log_path: str | Path
    settled: asyncio.Future[dict]

    def result(self, *, tail_only: int | None = None) -> dict: ...
    def request_stop(self, reason: str) -> asyncio.Future[dict]: ...


class CommandProcessTable(Protocol):
    def start(
        self, command: str, owner: str, *,
        on_settled: Callable[[CommandExecution], None],
        on_log_error: Callable[[CommandExecution], None],
        cwd: Path | None = None, env: dict[str, str] | None = None,
    ) -> CommandExecution: ...

    def get(self, process_id: str) -> CommandExecution | None: ...
    def pending(self) -> bool: ...
    def pending_owners(self) -> set[str]: ...
    async def stop_owners(self, owners: set[str]) -> list[str]: ...
    async def aclose(self) -> None: ...


class _Summary:
    def __init__(self):
        self.head = bytearray()
        self.tail: deque[bytes] = deque()
        self.tail_size = 0
        self.total = 0

    def append(self, chunk: bytes) -> None:
        self.total += len(chunk)
        room = INLINE_HEAD - len(self.head)
        self.head += chunk[:room]
        chunk = chunk[room:]
        if chunk:
            self.tail.append(chunk)
            self.tail_size += len(chunk)
        while self.tail_size > INLINE_TAIL:
            excess = self.tail_size - INLINE_TAIL
            first = self.tail.popleft()
            removed = min(excess, len(first))
            self.tail_size -= removed
            if removed < len(first):
                self.tail.appendleft(first[removed:])

    def text(self, tail_only: int | None = None) -> str:
        head, tail = bytes(self.head), b"".join(self.tail)
        if tail_only is not None:
            return (head + tail)[-tail_only:].decode("utf-8", errors="replace")
        omitted = self.total - len(head) - len(tail)
        if omitted <= 0:
            return (head + tail).decode("utf-8", errors="replace")
        return (head.decode("utf-8", errors="replace")
                + f"\n... 省略 {omitted} 字节，完整输出见日志 ...\n"
                + tail.decode("utf-8", errors="replace"))


class RemoteExecution:
    def __init__(self, table, process_id, owner, command, cwd, env, on_settled, on_log_error):
        self.process_id = process_id
        self.owner = owner
        self.command = command
        self.log_path = posixpath.join(table.log_dir, process_id + ".log")
        self.state = "running"
        self.stop_reason = None
        self._table = table
        self._cwd = str(cwd) if cwd is not None else table.workdir
        self._env = env or {}
        self._on_settled = on_settled
        self._on_log_error = on_log_error
        self._output = _Summary()
        self._stopping = asyncio.Event()
        self._terminal = None
        self._backend = None
        self._call = None
        self.settled = asyncio.get_running_loop().create_future()
        self._lifecycle = asyncio.create_task(self._run(), name=f"remote-process:{process_id}")

    def _event(self, message):
        if message["type"] == "output":
            self._output.append(base64.b64decode(message["data"], validate=True))
        elif message["type"] == "finalizing":
            self.state = "finalizing"
        elif message["type"] == "log_error":
            self._log_error = message["error"]
            self._on_log_error(self)

    async def _run(self):
        async def prepare():
            if self._stopping.is_set():
                return None
            return await self._table.prepare()

        preparing = asyncio.create_task(prepare())
        self._preparing = preparing
        preparing.add_done_callback(self._consume_preparation)
        stopping = asyncio.create_task(self._stopping.wait())
        why = "远端会话断开，原执行结果未知；不要自动重试有副作用的命令。"
        try:
            await asyncio.wait({preparing, stopping}, return_when=asyncio.FIRST_COMPLETED)
            if self._stopping.is_set():
                preparing.cancel()
                await asyncio.wait({preparing}, timeout=PREPARE_STOP_LIMIT)
                self._terminal = self._not_submitted("命令在准备期间已停止，本次未提交。")
                if not preparing.done():
                    self._terminal.update(cleanup="unconfirmed", error="本次命令未提交，但准备任务收尾未确认。")
                elif not preparing.cancelled() and isinstance(preparing.exception(), CleanupUnconfirmedError):
                    self._terminal.update(cleanup="unconfirmed", error="本次命令未提交，但准备任务清理未确认。")
                return
            self._backend = await preparing
            self._call = self._backend._channel.register(self._event)
            call = self._call
            channel = self._backend._channel
            sending = asyncio.create_task(channel.send({
                "type": "managed", "id": call.id, "command": self.command,
                "cwd": self._cwd, "env": self._env, "log": self.log_path,
            }, call, can_send=lambda: not self._stopping.is_set() and not self._table._closed))
            try:
                try:
                    async with asyncio.timeout(self._backend._stop_limit):
                        await asyncio.wait({sending, stopping}, return_when=asyncio.FIRST_COMPLETED)
                        if sending.done():
                            sending.result()
                except (TimeoutError, ChannelClosed):
                    pass  # The sent/result record, not the wait exception, decides the outcome.
            finally:
                if not sending.done():
                    sending.cancel()  # Release a queued send or drain; never retract bytes already written.
                await asyncio.gather(sending, return_exceptions=True)
            if not call.sent:
                self._terminal = self._not_submitted("命令在写出前已停止或连接失败，本次未提交。")
                return
            arriving = asyncio.create_task(channel.wait(call))
            try:
                await asyncio.wait({arriving, stopping}, return_when=asyncio.FIRST_COMPLETED)
                if self._stopping.is_set() and call.result is None:
                    self.state = "finalizing"
                    await self._backend._cancel(call)
                elif not arriving.done():
                    await arriving
            finally:
                arriving.cancel()
                await asyncio.gather(arriving, return_exceptions=True)
            if call.result is not None:
                self._terminal = call.result
            else:
                self._terminal = {"reason": "unknown", "exit_code": None, "cleanup": "unconfirmed",
                                  "error": why, "output_complete": False, "output_settled": False}
            self._backend._record(call, why)
        except asyncio.CancelledError:
            if self._call is not None and self._call.sent:
                await self._backend._cancel(self._call)
                self._backend._record(self._call, "取消执行跟踪后未确认收尾")
                self._terminal = self._call.result or {
                    "reason": "unknown", "exit_code": None, "cleanup": "unconfirmed",
                    "error": "执行跟踪被取消，原执行结果未知；不会自动重发。",
                    "output_complete": False, "output_settled": False,
                }
            else:
                self._terminal = self._not_submitted("环境准备已取消，本次命令未提交。")
        except CleanupUnconfirmedError as error:
            self._terminal = self._not_submitted(str(error))
            self._terminal["cleanup"] = "unconfirmed"
        except Exception as error:
            if self._call is not None and self._call.sent:
                self._backend._record(self._call, "执行跟踪失败，原结果未知")
                self._terminal = {"reason": "unknown", "exit_code": None, "cleanup": "unconfirmed",
                                  "error": "执行跟踪失败，原执行结果未知；不要自动重发。",
                                  "output_complete": False, "output_settled": False}
            else:
                self._terminal = self._not_submitted(str(error))
        finally:
            stopping.cancel()
            await asyncio.gather(stopping, return_exceptions=True)
            if self._call is not None:
                self._backend._channel.calls.pop(self._call.id, None)
            self.state = "settled"
            self.settled.set_result(self.result())
            try:
                self._on_settled(self)
            finally:
                if not self._owns_resources():
                    self._table._executions.pop(self.process_id, None)

    def _owns_resources(self):
        """Preparation owns its resources; this record owns its waiter and submitted command."""
        if self._preparing is not None and not self._preparing.done():
            return True
        return (
            self._call is not None and self._call.sent
            and (self._terminal is None or self._terminal["cleanup"] != "confirmed")
        )

    def _consume_preparation(self, task):
        if not task.cancelled():
            task.exception()
        if self.state == "settled" and not self._owns_resources():
            self._table._executions.pop(self.process_id, None)

    @staticmethod
    def _not_submitted(message):
        return {"reason": "not_submitted", "exit_code": None, "cleanup": "confirmed",
                "error": message, "output_complete": False, "output_settled": True}

    def request_stop(self, reason):
        if self.state != "settled":
            if self.state == "running" and self.stop_reason is None:
                self.stop_reason = reason
            # finalizing is an observation, not a terminal receipt. A live but
            # silent channel must still enter the bounded cancel/unknown path.
            self._stopping.set()
        return self.settled

    def output(self, tail_only=None):
        return self._output.text(tail_only)

    def result(self, *, tail_only=None):
        submitted = self._call is not None and self._call.sent
        status = "preparing" if self.state != "settled" and not submitted else self.state
        result = {"process_id": self.process_id, "status": status, "submitted": submitted,
                  "log": self.log_path, "output": self.output(tail_only)}
        if hasattr(self, "_log_error"):
            result["log_error"] = self._log_error
        if self._terminal is not None:
            terminal = self._terminal
            reason = terminal["reason"]
            result.update(
                status=("not_submitted" if reason in ("not_submitted", "not_started") else
                        "unknown" if terminal["cleanup"] != "confirmed" else
                        "stopped" if self.stop_reason is not None or reason == "cancelled" else "exited"),
                exit_code=terminal["exit_code"], cleanup=terminal["cleanup"],
                output_complete=terminal.get("output_complete", False),
                output_settled=terminal.get("output_settled", True),
            )
            if self.stop_reason is not None:
                result["stopped_by"] = self.stop_reason
            for key in ("error", "log_error"):
                if terminal.get(key):
                    result[key] = terminal[key]
        return result


class RemoteProcessTable:
    """Own commands and preparation waiters, not the environment resources borrowed by prepare.

    The preparer retains its SSH/skill cleanup ledger. A completed, unsubmitted
    preparation can report unknown cleanup without creating a permanent command debt.
    """

    def __init__(self, prepare: Callable[[], Awaitable[SSHBackend]], *, workdir: str):
        self.prepare = prepare
        self.workdir = workdir
        self._run_id = uuid4().hex[:12]
        self.log_dir = posixpath.join(workdir, ".wandrun", "processes", self._run_id)
        self._count = 0
        self._executions: dict[str, RemoteExecution] = {}
        self._closed = False

    def start(self, command, owner, *, on_settled, on_log_error, cwd=None, env=None):
        if self._closed:
            raise RuntimeError("执行环境已关闭，不再启动命令")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("命令不能为空")
        self._count += 1
        process_id = f"p{self._run_id}-{self._count}"
        execution = RemoteExecution(self, process_id, owner, command, cwd, env, on_settled, on_log_error)
        self._executions[process_id] = execution
        return execution

    def get(self, process_id):
        return self._executions.get(process_id)

    def pending(self):
        return any(item.state != "settled" for item in self._executions.values())

    def pending_owners(self) -> set[str]:
        """Include submitted-unknown commands and preparation waiters retained after settlement."""
        return {item.owner for item in self._executions.values()}

    async def stop_owners(self, owners):
        executions = [item for item in list(self._executions.values()) if item.owner in owners]
        if executions:
            await asyncio.shield(asyncio.gather(*(item.request_stop("cancelled") for item in executions)))
        return self._reports(executions)

    @staticmethod
    def _reports(executions):
        return [f"{item.process_id}（{'准备任务收尾未确认' if item._call is None else '远端进程组清理未确认，原执行结果未知'}）"
                for item in executions if item._owns_resources() and item.result().get("cleanup") != "confirmed"]

    async def aclose(self):
        self._closed = True
        executions = list(self._executions.values())
        if executions:
            await asyncio.gather(*(item.request_stop("closed") for item in executions))
        reports = self._reports(executions)
        if reports:
            raise CleanupUnconfirmedError("远端执行收尾未确认：" + "；".join(reports))
