"""经 SSH 在远端主机执行命令和传输文件的 backend（ADR-0014）。

文件读写由 deepagents 的 BaseSandbox 翻译成远端命令；这里实现命令执行、SFTP 传输和取消。
SSH 通道只是传输，不管理进程生命周期：一个环境在远端只启动一个会话服务（`remote_session.py`），
经一个 SSH exec 通道的 stdin/stdout 交换 NDJSON 消息，所有命令进程都由它持有。文件传输走同一连接上的 SFTP。

每条调用在通道里有一条记录（是否已写出、收到的 result）。等待无论因超时、断开还是取消结束，结论都只按记录下：
有 result 按 result；没写出就是没发出；写出了却没有确认的 result，就是无法确认。远端是否已停止只能经网络回复确认，
回复可能不来（业界实现同样不提供这种确认）：无法确认时如实告诉 Agent 命令可能仍在运行、继续前先检查，
由它检查和纠正；远端期限是残留命令的停止上界；运行时退出时汇总报告（取舍见 ADR-0014）。
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import json
import posixpath
import shlex
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

import asyncssh
from asyncssh.constants import FILEXFER_TYPE_DIRECTORY, FILEXFER_TYPE_REGULAR
from deepagents.backends.protocol import (
    FILE_NOT_FOUND,
    INVALID_PATH,
    IS_DIRECTORY,
    PERMISSION_DENIED,
    DeleteResult,
    EditResult,
    ExecuteResponse,
    FileDownloadResponse,
    FileUploadResponse,
    GlobResult,
    GrepResult,
    LsResult,
    ReadResult,
    WriteResult,
)
from deepagents.backends.sandbox import BaseSandbox

from wandrun.integrations import remote_session
from wandrun.integrations.shell_backend import (
    CleanupUnconfirmedError,
    execute_response,
    invalid_command_response,
    timed_out_response,
)

SESSION_SOURCE = Path(remote_session.__file__)
SESSION_HASH = hashlib.sha256(SESSION_SOURCE.read_bytes()).hexdigest()
# 宿主等待远端结果的额外余量：远端期限与宽限应先到，余量只覆盖网络延迟。
NETWORK_SLACK = 10.0
_READY_TIMEOUT = 30.0
# 打开环境：创建工作目录，拒绝被链接到别处的受管理目录（其中的内容会被自动创建或删除）。
_PREPARE = r'''w=$1
mkdir -p "$w" || exit 1
for p in "$w/.wandrun" "$w/.wandrun/bin" "$w/.wandrun/skills" "$w/.wandrun/builtin-skills" "$w/.wandrun/artifacts"; do
  if [ -L "$p" ]; then echo "$p 是符号链接，拒绝在其中自动创建或删除文件" >&2; exit 2; fi
done
mkdir -p "$w/.wandrun/bin"'''


def remote_script(script: str, *args: str) -> str:
    """把脚本和参数交给远端 sh；参数依次成为 $1、$2……（$0 占位），不拼进脚本。"""
    return "sh -c " + " ".join(shlex.quote(item) for item in (script, "sh", *args))


class ChannelClosed(Exception):
    """会话通道已断开：此后没有任何结果会到达。"""


@asynccontextmanager
async def sftp_client(connection: asyncssh.SSHClientConnection) -> AsyncIterator[asyncssh.SFTPClient]:
    """SFTP 客户端。创建过程不可被半途取消：AsyncSSH 2.24.0 不会补偿关闭，会泄漏会话通道；取消时让它在后台完成后关闭。"""
    opening = asyncio.ensure_future(connection.start_sftp_client())
    try:
        client = await asyncio.shield(opening)
    except asyncio.CancelledError:
        opening.add_done_callback(_close_sftp)
        raise
    try:
        yield client
    finally:
        client.exit()
        await client.wait_closed()


def _close_sftp(opening: asyncio.Future) -> None:
    if not opening.cancelled() and opening.exception() is None:
        opening.result().exit()


@dataclass
class _Call:
    """一条调用在通道里的记录：结论只依据它，不依据等待以哪种异常结束。"""

    id: str
    sent: bool = False  # run 已进入写缓冲：远端可能收到
    result: dict | None = None  # 收到的 result 消息
    arrived: asyncio.Event = field(default_factory=asyncio.Event)  # result 到达或通道断开

    @property
    def unresolved(self) -> bool:
        """已写出，却没有拿到确认清理的结果：远端可能仍在运行。"""
        return self.sent and (self.result is None or self.result["cleanup"] != "confirmed")


class SessionChannel:
    """宿主侧的协议通道：一个发送队列、一个持续读取并把结果写进调用记录的读取者。

    reader 需要 readline()，writer 需要 write()/drain()（asyncssh 进程的 stdout/stdin 与 asyncio 流都满足）。
    同一个 id 的 run 一定先于 cancel 写出（发送经同一把锁）。
    """

    def __init__(self, reader, writer):
        self._reader = reader
        self._writer = writer
        self._lock = asyncio.Lock()
        self.calls: dict[str, _Call] = {}
        self.closed: asyncio.Future = asyncio.get_running_loop().create_future()
        self.broken = False
        self._reading: asyncio.Task | None = None

    async def open(self, termination_grace: float) -> None:
        """读取 ready 并核对协议版本、脚本哈希、宽限期，然后开始持续读取。"""
        async with asyncio.timeout(_READY_TIMEOUT):
            line = await self._reader.readline()
        try:
            ready = json.loads(line)
        except ValueError:
            raise RuntimeError(f"远端会话服务没有就绪：{line[:200]!r}") from None
        expected = {
            "type": "ready", "protocol": remote_session.PROTOCOL, "hash": SESSION_HASH,
            "termination_grace": termination_grace,
        }
        if ready != expected:
            raise RuntimeError(f"远端会话服务握手不符：期望 {expected}，实际 {ready}")
        self._reading = asyncio.create_task(self._read())

    async def _read(self) -> None:
        failure = ChannelClosed("远端会话通道已断开")
        try:
            while line := await self._reader.readline():
                message = json.loads(line)
                if message["type"] == "result":
                    call = self.calls.get(message["id"])
                    if call is not None and call.result is None:
                        call.result = message
                        call.arrived.set()
                elif message["type"] == "closed" and not self.closed.done():
                    self.closed.set_result(message)
        except Exception as error:  # 协议损坏与断开同样处理：不再有结果会到达
            failure = ChannelClosed(f"远端会话通道异常：{type(error).__name__}: {error}")
        self._break(failure)

    def _break(self, failure: Exception) -> None:
        self.broken = True
        for call in self.calls.values():
            call.arrived.set()
        if not self.closed.done():
            self.closed.set_exception(failure)
            self.closed.exception()  # 标记已取回：没有等待者时不报警告

    def register(self) -> _Call:
        call = _Call(uuid4().hex)
        if self.broken:
            call.arrived.set()
        self.calls[call.id] = call
        return call

    async def send(self, message: dict, call: _Call | None = None) -> None:
        """写出一条消息；传输异常统一为 ChannelClosed。写入缓冲之后（远端可能收到）才把 run 记为已写出。"""
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        async with self._lock:
            if self.broken:
                raise ChannelClosed("远端会话通道已断开")
            try:
                self._writer.write(data)
            except Exception as error:  # 没有进入缓冲，远端不会收到
                raise ChannelClosed(f"写入会话通道失败：{type(error).__name__}: {error}") from error
            if call is not None:
                call.sent = True
            try:
                await self._writer.drain()
            except Exception as error:
                raise ChannelClosed(f"会话通道发送失败：{type(error).__name__}: {error}") from error

    async def wait(self, call: _Call) -> None:
        """等到结果到达或通道断开。"""
        await call.arrived.wait()

    async def stop_reading(self) -> None:
        if self._reading is not None:
            self._reading.cancel()
            await asyncio.gather(self._reading, return_exceptions=True)
        self._break(ChannelClosed("远端会话已关闭"))


# BaseSandbox 的文件操作（ls、read、grep……）也经 execute 运行远端命令，但它的解析器会忽略非预期输出、
# 不看退出码：任何非正常结果（没发出、无法确认、远端未完成）都会被解析成成功的空结果。
# 文件操作期间置位，这些情况改为抛 _FileOperationFailed，由适配层放进结果的 error。
_FILE_OPERATION: ContextVar[bool] = ContextVar("wandrun_ssh_file_operation", default=False)


class _FileOperationFailed(Exception):
    pass


@contextmanager
def _file_operation():
    token = _FILE_OPERATION.set(True)
    try:
        yield
    finally:
        _FILE_OPERATION.reset(token)


class SSHBackend(BaseSandbox):
    """一个远端会话服务上的工作目录。连接由打开它的环境持有并关闭。"""

    def __init__(
        self,
        channel: SessionChannel,
        *,
        connection: asyncssh.SSHClientConnection | None,
        label: str,
        workdir: str,
        timeout: int = 120,
        termination_grace: float = 2.0,
        max_output_bytes: int = 100_000,
    ):
        self._channel = channel
        self._connection = connection
        self._label = label
        self._workdir = workdir
        self._default_timeout = timeout
        self._termination_grace = termination_grace
        self._max_output_bytes = max_output_bytes
        self._loop = asyncio.get_running_loop()
        self._unconfirmed: dict[str, str] = {}  # 调用 id → 无法确认的原因；运行时退出时汇总报告
        self._closed = False

    @classmethod
    async def start(
        cls,
        connection: asyncssh.SSHClientConnection,
        *,
        label: str,
        workdir: str,
        timeout: int,
        termination_grace: float,
    ) -> SSHBackend:
        """准备目录、上传会话服务（按内容哈希命名，原子发布）、启动并握手。"""
        result = await connection.run(remote_script(_PREPARE, workdir), check=False)
        if result.exit_status != 0:
            raise RuntimeError(f"无法准备远端工作目录 {workdir}: {result.stderr}")
        script = posixpath.join(workdir, ".wandrun", "bin", f"wandrun-session-{SESSION_HASH[:16]}.py")
        async with sftp_client(connection) as sftp:
            if not await sftp.exists(script):
                temporary = f"{script}.{uuid4().hex}.tmp"
                await sftp.put(str(SESSION_SOURCE), temporary)
                await sftp.posix_rename(temporary, script)
        process = await connection.create_process(
            f"cd {shlex.quote(workdir)} && exec python3 "
            + " ".join(shlex.quote(item) for item in (script, workdir, repr(termination_grace))),
            encoding=None,
        )
        channel = SessionChannel(process.stdout, process.stdin)
        try:
            await channel.open(termination_grace)
        except BaseException:
            process.close()
            raise
        return cls(
            channel, connection=connection, label=label, workdir=workdir,
            timeout=timeout, termination_grace=termination_grace,
        )

    @property
    def id(self) -> str:
        return f"ssh:{self._label}"

    def _path(self, path: str) -> str:
        # 只补工作目录前缀，不在宿主做词法规范化：`link/../x` 必须由远端按符号链接解析。
        return path if path.startswith("/") else f"{self._workdir}/{path}"

    def _timeout(self, timeout: int | None) -> int:
        effective = timeout if timeout is not None else self._default_timeout
        if effective <= 0:
            raise ValueError(f"timeout must be positive, got {effective}")
        return effective

    @property
    def _stop_limit(self) -> float:
        """取消后等待结果的上限：远端宽限期 + SIGKILL 后的收尾上限 + 网络余量。"""
        return self._termination_grace + remote_session.SETTLE + NETWORK_SLACK

    def _record(self, call: _Call, why: str) -> None:
        """无法确认时记账。有结果就按结果写原因；没有结果才用等待结束的原因（超时、传输故障）。"""
        if call.unresolved:
            if call.result is not None:
                why = f"远端报告 {call.result['reason']} 后仍有进程未结束"
            self._unconfirmed.setdefault(call.id, why)

    async def aexecute(
        self, command: str, *, timeout: int | None = None  # noqa: ASYNC109
    ) -> ExecuteResponse:
        return await self._execute(command, timeout, _FILE_OPERATION.get())

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        # 协程会在事件循环线程的上下文中运行，文件操作标记要在调用线程里读出后显式传入。
        return self._blocking(self._execute(command, timeout, _FILE_OPERATION.get()))

    async def _execute(self, command: str, timeout: int | None, file_operation: bool) -> ExecuteResponse:
        if not command or not isinstance(command, str):
            return invalid_command_response()
        if self._closed:
            raise RuntimeError("SSH backend is closed")
        effective = self._timeout(timeout)
        call = self._channel.register()
        why = "通道断开"
        try:
            try:
                # 计时从写出之前开始：发送阶段卡住也计入上限。
                async with asyncio.timeout(effective + self._stop_limit):
                    try:
                        await self._channel.send(
                            {"type": "run", "id": call.id, "command": command, "timeout": effective,
                             "max_output": self._max_output_bytes},
                            call,
                        )
                    except ChannelClosed as error:
                        why = str(error)
                        if not call.sent:
                            raise
                        # 已写出：发送失败不决定结论，结果可能仍在路上；等记录落定（结果到达或通道断开）。
                    await self._channel.wait(call)
            except TimeoutError:
                why = "等待结果超时"
            except ChannelClosed as error:  # 没有写出
                why = str(error)
            except asyncio.CancelledError:
                if call.sent and call.result is None:
                    await self._cancel(call)
                self._record(call, "取消后没有得到确认清理的结果")
                raise
            if self._channel.broken and why == "通道断开":
                why = "远端会话通道已断开"
            self._record(call, why)  # 先记账，再从通道里移除，关闭汇总不会漏掉
        finally:
            self._channel.calls.pop(call.id, None)
        return self._conclude(call, effective, why, file_operation)

    def _conclude(self, call: _Call, timeout: int, why: str, file_operation: bool) -> ExecuteResponse:
        """按调用记录得出结果；文件操作的非正常结果交给适配层转成 error。"""
        result = call.result
        if result is not None and result["cleanup"] == "confirmed":
            if result["reason"] == "exited":
                return execute_response(
                    result["stdout"], result["stderr"], result["exit_code"], self._max_output_bytes,
                    dropped=result["truncated"],
                )
            if result["reason"] == "timeout":
                if not file_operation:
                    return timed_out_response(timeout)
                # 清理已确认只说明进程已收尾，不说明文件操作成功：不能交给解析器当成空结果。
                message = f"命令超过 {timeout} 秒，已终止。"
            else:
                message = f"远端没有完成该命令（{result['reason']}）。{result['stderr']}".rstrip()
        elif not call.sent:
            message = f"命令没有发出（{why}）。"
        else:
            reason = f"远端报告 {result['reason']} 后仍有进程未结束" if result is not None else why
            message = (
                f"无法确认远端命令已经结束（{reason}），它可能仍在 {self._label} 上运行。"
                "继续之前请先检查实际状态（例如用 ps 查看相关进程、确认相关文件），再决定是否重试。"
            )
        if file_operation:
            raise _FileOperationFailed(message)
        return ExecuteResponse(output=f"Error: {message}", exit_code=None, truncated=False)

    async def _cancel(self, call: _Call) -> None:
        """请求远端取消，在上限内等结果写进记录。再次取消不截断等待（与本机 backend 相同：先收尾、再传播）。

        续聊时已有的中断提示会告诉 Agent 外部操作可能已经发生、先检查实际状态。
        """

        async def stop() -> None:
            try:
                async with asyncio.timeout(self._stop_limit):
                    try:
                        await self._channel.send({"type": "cancel", "id": call.id})
                    except ChannelClosed:
                        pass  # 发送失败不决定结论：结果可能已在路上，等记录落定
                    await self._channel.wait(call)
            except TimeoutError:
                pass  # 结论按记录

        stopping = asyncio.create_task(stop())
        while not stopping.done():
            try:
                await asyncio.shield(stopping)
            except asyncio.CancelledError:
                pass

    async def adelete(self, file_path: str) -> DeleteResult:
        """与 BaseSandbox.delete 相同的两步（存在性预检、`rm -rf`），但原生异步。

        协议默认的 adelete 经线程运行同步 delete：取消等待者停不下线程，打断之后它仍会推进并新发出 `rm`。
        """
        quoted = shlex.quote(file_path)
        exists = await self.aexecute(f"test -e {quoted} || test -L {quoted}")
        if exists.exit_code is not None and exists.exit_code != 0:
            return DeleteResult(error=f"Error: '{file_path}' not found")
        result = await self.aexecute(f"rm -rf {quoted}")
        if result.exit_code == 0:
            return DeleteResult(path=file_path)
        return DeleteResult(error=f"Error deleting file '{file_path}': {result.output.strip() or 'unknown error'}")

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        responses = []
        async with sftp_client(self._connection) as sftp:
            for path, content in files:
                target = self._path(path)
                try:
                    await sftp.makedirs(posixpath.dirname(target), exist_ok=True)
                    async with sftp.open(target, "wb") as handle:
                        await handle.write(content)
                    responses.append(FileUploadResponse(path=path))
                except asyncssh.SFTPError as error:
                    responses.append(FileUploadResponse(path=path, error=_sftp_error(error)))
        return responses

    async def apublish_artifact(self, path: str, content: bytes) -> None:
        """Publish an immutable artifact without replacing an existing name.

        Reject symlinks in the checked directory chain and at the target.
        SFTP has no directory-handle-relative operations: a hostile remote
        writer can replace a checked parent between requests and redirect
        a subsequent request, or replace the target after verification.
        """
        target = self._path(path)
        parts = target.split("/")
        if not target.startswith("/") or any(part in (".", "..") for part in parts):
            raise ValueError(f"压缩档案路径必须是绝对路径且不含 . 或 ..：{target}")
        temporary = f"{target}.{uuid4().hex}.stage"
        missing = (asyncssh.SFTPNoSuchFile, asyncssh.SFTPNoSuchPath)

        async with sftp_client(self._connection) as sftp:
            directory = "/"
            for part in parts[1:-1]:
                if not part:
                    continue
                directory = posixpath.join(directory, part)
                try:
                    attrs = await sftp.lstat(directory)
                except missing:
                    try:
                        await sftp.mkdir(directory)
                    except (asyncssh.SFTPFailure, asyncssh.SFTPFileAlreadyExists):
                        pass  # 另一个发布者可能刚创建；必须再用 lstat 核实类型。
                    attrs = await sftp.lstat(directory)
                if attrs.type != FILEXFER_TYPE_DIRECTORY:
                    raise OSError(f"压缩档案目录不是普通目录（禁止符号链接）：{directory}")

            async def existing_matches() -> bool:
                try:
                    attrs = await sftp.lstat(target)
                except missing:
                    return False
                if attrs.type != FILEXFER_TYPE_REGULAR:
                    raise OSError(f"压缩档案目标不是普通文件（禁止符号链接）：{target}")
                async with sftp.open(target, "rb") as existing:
                    if await existing.read() != content:
                        raise OSError(f"压缩档案同名内容不一致：{target}")
                return True

            if await existing_matches():
                return

            created = False
            try:
                async with sftp.open(temporary, "xb") as output:
                    created = True
                    await output.write(content)
                async with sftp.open(temporary, "rb") as staged:
                    if await staged.read() != content:
                        raise OSError(f"远端压缩档案上传后校验失败：{target}")
                try:
                    # AsyncSSH and OpenSSH negotiate hardlink@openssh.com on
                    # SFTPv3. Unlike posix_rename, link fails if target exists.
                    await sftp.link(temporary, target)
                except asyncssh.SFTPError:
                    if not await existing_matches():
                        raise  # 无 no-clobber 扩展等故障不得回退到覆盖式 rename。
            finally:
                if created:
                    await sftp.remove(temporary)

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        responses = []
        async with sftp_client(self._connection) as sftp:
            for path in paths:
                target = self._path(path)
                try:
                    if await sftp.isdir(target):
                        responses.append(FileDownloadResponse(path=path, error=IS_DIRECTORY))
                        continue
                    async with sftp.open(target, "rb") as handle:
                        content = await handle.read()
                    responses.append(FileDownloadResponse(path=path, content=content))
                except asyncssh.SFTPError as error:
                    responses.append(FileDownloadResponse(path=path, error=_sftp_error(error)))
        return responses

    def _blocking(self, coroutine):
        """同步接口只能从其他线程调用：在连接所属的事件循环上执行并等待。"""
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            coroutine.close()
            raise RuntimeError("在事件循环线程中请使用 SSHBackend 的异步方法")
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result()

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return self._blocking(self.aupload_files(files))

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        return self._blocking(self.adownload_files(paths))

    async def aclose(self) -> None:
        """停止接收；请会话服务取消全部调用并收尾。事后汇总报告，只报告一次。

        汇总在收尾完成之后、直接扫描调用记录：已记账的、仍在通道里的（含 Future 已断开但消费者尚未记账的），
        以及会话服务报告的，都计入。没有写出的调用不计入。
        """
        if self._closed:
            return
        self._closed = True
        problems = []
        try:
            async with asyncio.timeout(self._stop_limit):
                await self._channel.send({"type": "shutdown"})
                closed = await asyncio.shield(self._channel.closed)
            problems += [f"{item}（会话服务报告）" for item in closed["unconfirmed"]]
        except (TimeoutError, ChannelClosed, OSError, asyncssh.Error) as error:
            problems.append(f"关闭会话：{type(error).__name__}: {error}")
        finally:
            await self._channel.stop_reading()
        unconfirmed = {
            **{call.id: "关闭时仍没有确认清理的结果" for call in self._channel.calls.values() if call.unresolved},
            **self._unconfirmed,
        }
        reported = [f"{call_id}（{why}）" for call_id, why in unconfirmed.items()] + problems
        if reported:
            raise CleanupUnconfirmedError(f"{self._label} 上清理未确认：{reported}")

    def close(self) -> None:
        """运行时在工作线程中收拢各环境时调用（与本机 backend 的 close 相同的位置）。"""
        self._blocking(self.aclose())


def _adapt_file_operation(name: str, result_type: type) -> None:
    """为 BaseSandbox 的一个文件操作（同步与异步两个入口）加上标记，并把非正常结果放进 error。"""
    sync_method = getattr(BaseSandbox, name)
    # 本类自己实现的异步入口（如 adelete）优先，其余沿用 BaseSandbox。
    async_method = SSHBackend.__dict__.get(f"a{name}") or getattr(BaseSandbox, f"a{name}")

    @functools.wraps(sync_method)
    def sync(self, *args, **kwargs):
        try:
            with _file_operation():
                return sync_method(self, *args, **kwargs)
        except _FileOperationFailed as error:
            return result_type(error=str(error))

    @functools.wraps(async_method)
    async def asynchronous(self, *args, **kwargs):
        try:
            with _file_operation():
                return await async_method(self, *args, **kwargs)
        except _FileOperationFailed as error:
            return result_type(error=str(error))

    setattr(SSHBackend, name, sync)
    setattr(SSHBackend, f"a{name}", asynchronous)


for _name, _result_type in (
    ("ls", LsResult), ("read", ReadResult), ("write", WriteResult), ("edit", EditResult),
    ("grep", GrepResult), ("glob", GlobResult), ("delete", DeleteResult),
):
    _adapt_file_operation(_name, _result_type)


def _sftp_error(error: asyncssh.SFTPError) -> str:
    """只映射能可靠识别的情况；OpenSSH 的 SFTPv3 常用通用失败码，按消息区分两种目录错误。"""
    message = str(error).lower()
    if isinstance(error, (asyncssh.SFTPNoSuchFile, asyncssh.SFTPNoSuchPath)):
        return FILE_NOT_FOUND
    if isinstance(error, asyncssh.SFTPPermissionDenied):
        return PERMISSION_DENIED
    if isinstance(error, asyncssh.SFTPNotADirectory) or "not a directory" in message:
        return INVALID_PATH
    if isinstance(error, asyncssh.SFTPFileIsADirectory) or "is a directory" in message:
        return IS_DIRECTORY
    return str(error)
