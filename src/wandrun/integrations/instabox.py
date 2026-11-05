"""Lazy access to one existing Instabox, with no cloud lifecycle management policy.

Only real I/O prepares the machine. Preparation is owned by the backend, not by an
individual waiter; cancellation cannot abandon an accepted resume. A new session
never replays old commands or claims their processes survived (or were rebooted).
Credentials and provider response bodies are deliberately absent from errors.
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import re
import shlex
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

import asyncssh
import httpx
from deepagents.backends.protocol import (
    DeleteResult, EditResult, ExecuteResponse, FileDownloadResponse, FileUploadResponse,
    GlobResult, GrepResult, LsResult, ReadResult, WriteResult,
)
from deepagents.backends.sandbox import BaseSandbox

from wandrun.integrations.browser_relay import InstaboxBrowserTransport
from wandrun.integrations.instabox_identity import validate_machine_id
from wandrun.integrations.remote_processes import RemoteProcessTable
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.integrations.ssh_backend import SSHBackend
from wandrun.runtime.browser.leases import BrowserEnvironmentError

API_URL = "https://api.instabox.sh"
PREPARE_LIMIT = 180.0
CLOSE_LIMIT = 25.0
RECOVERY_CAUTION = (
    "这不代表已经重启，此前执行和服务状态尚未核验。"
    "请先检查实际状态，不要直接重复有副作用的操作。"
)
RECOVERY_NOTICE = "执行环境刚恢复或连接已重建；" + RECOVERY_CAUTION


class InstaboxError(RuntimeError):
    """A controlled provider failure; category is safe for tools and logs."""

    def __init__(self, category: str, message: str, *, request_rejected: bool = False):
        self.category = category
        self.request_rejected = request_rejected
        super().__init__(f"Instabox [{category}]：{message}")


class InstaboxRecoveryRequired(InstaboxError):
    def __init__(self, note: str = RECOVERY_NOTICE):
        super().__init__("recovery", note + "本次环境操作未提交。")


class InstaboxBackend(BaseSandbox):
    """One shared environment owner. Construct on the runtime's event-loop thread.

    ``prepare_skills`` receives the ready, underlying SSH backend, never this lazy
    facade. ``aclose`` owns the process table, sessions and connections: callers
    must not close those resources concurrently with it.
    """

    def __init__(
        self, machine_id: str, api_key_env: str = "INSTABOX_API_KEY", *, workdir: str,
        timeout: int = 120, termination_grace: float = 2.0,
        prepare_skills: Callable[[SSHBackend], Awaitable[None]] | None = None,
    ):
        validate_machine_id(machine_id)
        if not workdir.startswith("/") or "\0" in workdir:
            raise ValueError("Instabox workdir 必须是绝对 POSIX 路径")
        if not api_key_env or timeout <= 0 or not 0 < termination_grace < float("inf"):
            raise ValueError("Instabox 凭据变量、timeout 或 termination_grace 无效")
        self._machine_id = machine_id
        self._api_key_env = api_key_env
        self._workdir = workdir
        self._timeout = timeout
        self._termination_grace = termination_grace
        self._prepare_skills = prepare_skills
        self._loop = asyncio.get_running_loop()
        self._preparing = None
        self._closing = None
        self._closed = False
        self._backend = None
        self._connection = None
        self._sessions = []
        self._connections = []
        self._ever_connected = False
        self._resume_pending = False
        self._operation_id = None
        self._recovery_pending = False
        self._recovery_revision = 0
        self._recovery_note = RECOVERY_NOTICE
        self._recovery_delivery_lock = asyncio.Lock()
        self._preparation_problem = False
        self._active: dict[asyncio.Task, int] = {}
        self._recovery_feedback: Callable[[str], Awaitable[bool]] | None = None
        self._browser: InstaboxBrowserTransport | None = None
        self._browser_path: tuple[SSHBackend, str] | None = None
        self._browser_path_lock = asyncio.Lock()
        self.processes = RemoteProcessTable(self._ready, workdir=workdir)

    @property
    def id(self):
        return f"instabox:{self._machine_id}"

    def bind_recovery_feedback(self, callback: Callable[[str], Awaitable[bool]]) -> None:
        """Bind an async sink; True acknowledges durable enqueueing, not model delivery."""
        self._recovery_feedback = callback

    def configure_browser(self, config, on_disconnect, *, start_script: str) -> None:
        """Bind browser transport without preparing or waking the machine."""
        if self._browser is not None:
            raise RuntimeError("Instabox 浏览器传输已经配置")
        self._browser = InstaboxBrowserTransport(
            config, on_disconnect, start_script=start_script, connect=self._connect_browser,
        )

    async def _connect_browser(self):
        # The command readiness barrier has already run. Issue a fresh short-lived
        # certificate, without replaying readiness or lifecycle operations.
        key = os.environ.get(self._api_key_env)
        if not key:
            raise InstaboxError("credentials", "宿主未设置配置的 API key 环境变量。")
        async with httpx.AsyncClient(
            base_url=API_URL, headers={"X-API-Key": key}, timeout=35,
            follow_redirects=False, trust_env=False,
        ) as api:
            return await self._connect_ssh(api)

    async def _connect_ssh(self, api):
        """Issue one certificate and validate its machine identity and Host CA."""
        private_key = asyncssh.generate_private_key("ssh-ed25519")
        certificate = await self._request(
            api, "POST", f"/v1/machines/{self._machine_id}/connections",
            headers={"Idempotency-Key": os.urandom(16).hex()},
            json={"publicKey": private_key.export_public_key().decode().strip(), "ttlSeconds": 3600},
        )
        if self._closed:
            raise InstaboxError("closed", "执行环境已关闭，本次业务操作未提交。")
        try:
            host = certificate["host"]
            port = certificate["port"]
            trust = certificate["hostTrust"]
            if (not isinstance(host, str) or not re.fullmatch(r"[A-Za-z0-9.-]+", host)
                    or type(port) is not int or not 1 <= port <= 65535
                    or certificate["machineId"] != self._machine_id
                    or certificate["username"] != self._machine_id
                    or trust["type"] != "ca" or host not in trust["principals"]):
                raise ValueError
            authority = asyncssh.import_public_key(trust["publicKey"]).export_public_key().decode().strip()
            client_certificate = asyncssh.import_certificate(certificate["certificate"])
            known_hosts = f"@cert-authority [{host}]:{port} {authority}\n".encode()
            return await asyncssh.connect(
                host, port=port, username=self._machine_id,
                client_keys=[(private_key, client_certificate)], known_hosts=known_hosts,
                config=None, agent_path=None, keepalive_interval=0, login_timeout=30,
            )
        except (KeyError, ValueError, TypeError, asyncssh.Error, OSError):
            raise InstaboxError("ssh", "证书、Host CA 校验或 SSH 连接失败。") from None

    @asynccontextmanager
    async def _browser_operation(self):
        """Expose controlled environment failures through the browser error contract.

        Readiness keeps ownership of recovery delivery; never retry a blocked
        operation here, including discovery requested outside a command tool.
        """
        try:
            async with self._activity():
                await self._ready()
                if self._browser is None:
                    raise InstaboxError("browser", "执行环境未配置浏览器。")
                yield self._browser
        except InstaboxError as error:
            raise BrowserEnvironmentError(str(error)) from error
        except CleanupUnconfirmedError as error:
            raise BrowserEnvironmentError(self._unconfirmed_preparation_error()) from error

    async def browser_cdp_url(self) -> str:
        """Prepare only the independent SSH forward, not Chrome itself."""
        async with self._browser_operation() as browser:
            return await browser.cdp_url(self._connection)

    async def open_browser_video_exec(self, command: str):
        """Open a separate publisher exec on the prepared command connection.

        The gateway retains the opening task and any late process handle; this
        method does not install software or start another SSH connection.
        """
        async with self._browser_operation():
            return await self._connection.create_process(command, encoding="utf-8")


    async def browser_command_environment(self, env: dict[str, str]) -> dict[str, str]:
        """Map the lease endpoint; read PATH once per ready SSH session."""
        async with self._browser_operation() as browser:
            backend, connection = self._backend, self._connection
            mapped = await browser.command_environment(env, connection)
            # Browser commands can prepare concurrently. Key by the session,
            # including its connection, so recovery cannot reuse the old PATH.
            async with self._browser_path_lock:
                if self._browser_path is None or self._browser_path[0] is not backend:
                    path = await backend.aexecute('printf %s "$PATH"')
                    if path.exit_code != 0 or path.truncated:
                        raise BrowserEnvironmentError("读取 Instabox 命令 PATH 失败")
                    self._browser_path = backend, path.output
                remote_path = self._browser_path[1]
            directory = "/data/home/wandrun-browser/agent-browser"
            return {**mapped, "WANDRUN_BROWSER_CLI_DIR": directory,
                    "PATH": directory + "/bin:" + remote_path}

    async def drain_browser_endpoint(self, url: str) -> None:
        """Drain accepted responses without preparing or waking the machine."""
        if self._browser is not None:
            await self._browser.drain_endpoint(url)

    async def close_browser_endpoint(self, url: str) -> None:
        """Close the exec for the original host URL, without preparing the machine."""
        if self._browser is not None:
            await self._browser.close_endpoint(url)

    async def _request(self, api, method, path, **kwargs):
        try:
            response = await api.request(method, path, **kwargs)
        except httpx.HTTPError:
            raise InstaboxError("transport", "平台请求未确认；不会自动重发已提交的生命周期操作。") from None
        if not 200 <= response.status_code < 300:
            category = ("authentication" if response.status_code in (401, 403) else
                        "not_found" if response.status_code == 404 else "provider")
            raise InstaboxError(
                category, f"平台返回 HTTP {response.status_code}。",
                request_rejected=response.status_code in (
                    400, 401, 402, 403, 404, 405, 406, 409, 410, 411, 412, 413, 415, 422, 429,
                ),
            )
        try:
            value = response.json()
            if not isinstance(value, dict):
                raise ValueError
            return value
        except (ValueError, TypeError):
            raise InstaboxError("protocol", "平台响应格式无效。") from None

    async def _operation(self, api, operation_id):
        if not isinstance(operation_id, str) or not re.fullmatch(r"op_[a-z0-9]+", operation_id):
            raise InstaboxError("protocol", "平台 operation 身份无效；不会重发恢复。")
        while True:
            operation = await self._request(api, "GET", f"/v1/operations/{operation_id}", params={"wait": "25s"})
            if operation.get("machineId") != self._machine_id:
                raise InstaboxError("protocol", "operation 不属于配置的实例。")
            state = operation.get("state")
            if state == "succeeded":
                return
            if state == "failed":
                if operation_id == self._operation_id:
                    self._resume_pending = False
                    self._operation_id = None
                raise InstaboxError("operation_failed", "平台恢复操作失败；未提交业务操作。")
            if state not in ("queued", "running"):
                raise InstaboxError("protocol", "平台 operation 状态无效。")

    async def _prepare(self):
        connection = None
        published = False
        resumed = self._resume_pending
        try:
            async with asyncio.timeout(PREPARE_LIMIT):
                key = os.environ.get(self._api_key_env)
                if not key:
                    raise InstaboxError("credentials", "宿主未设置配置的 API key 环境变量。")
                async with httpx.AsyncClient(
                    base_url=API_URL, headers={"X-API-Key": key}, timeout=35,
                    follow_redirects=False, trust_env=False,
                ) as api:
                    path = f"/v1/machines/{self._machine_id}"
                    if self._operation_id is not None:
                        await self._operation(api, self._operation_id)
                    while True:
                        machine = await self._request(api, "GET", path)
                        if machine.get("id") != self._machine_id:
                            raise InstaboxError("protocol", "平台返回了不同的实例。")
                        state = machine.get("state")
                        operation_id = machine.get("operationId")
                        if operation_id:
                            resumed = resumed or state in ("resuming", "suspending")
                            await self._operation(api, operation_id)
                            continue
                        if state == "suspended":
                            if self._resume_pending:
                                raise InstaboxError("lifecycle_unknown", "此前恢复请求的结果未知，不会再次提交恢复。")
                            if self._closed:
                                raise InstaboxError("closed", "执行环境已关闭，恢复与业务操作均未提交。")
                            # Set before the write: even a lost HTTP acknowledgement must not cause a second POST.
                            self._resume_pending = True
                            resumed = True
                            try:
                                operation = await self._request(
                                    api, "POST", path + "/resume", headers={"Idempotency-Key": os.urandom(16).hex()},
                                )
                            except InstaboxError as error:
                                if error.request_rejected:
                                    self._resume_pending = False
                                raise
                            self._operation_id = operation.get("id")
                            if self._operation_id is None:
                                raise InstaboxError("protocol", "恢复请求缺少 operation 身份；不会重发。")
                            await self._operation(api, self._operation_id)
                            continue
                        if state == "running" and machine.get("runtime", {}).get("ready") is True:
                            break
                        if state not in ("running", "resuming", "starting", "suspending"):
                            raise InstaboxError("machine_state", "实例未运行或暂停；本接入不会 start、创建或改变其生命周期策略。")
                        resumed = resumed or state in ("resuming", "suspending")
                        await asyncio.sleep(0.2)
                    if resumed:
                        self._recovery_pending = True
                        self._recovery_revision += 1
                        self._recovery_note = "执行环境已从暂停状态恢复；" + RECOVERY_CAUTION
                    self._resume_pending = False
                    self._operation_id = None
                    if self._closed:
                        raise InstaboxError("closed", "执行环境已关闭，本次业务操作未提交。")
                    connection = await self._connect_ssh(api)
                self._connections.append(connection)
                self._connection = connection
                if self._closed:
                    raise InstaboxError("closed", "执行环境已关闭，本次业务操作未提交。")
                backend = await SSHBackend.start(
                    connection, label=self.id, workdir=self._workdir, timeout=self._timeout,
                    termination_grace=self._termination_grace,
                )
                if self._closed:
                    backend._channel.seal()
                self._sessions.append(backend)
                self._backend = backend
                recovery = resumed or self._ever_connected
                self._ever_connected = True
                if recovery and not resumed:
                    self._recovery_pending = True
                    self._recovery_revision += 1
                    self._recovery_note = "执行环境的 SSH 连接或执行通道已重建；" + RECOVERY_CAUTION
                if recovery and self._browser is not None:
                    await self._browser.connection_lost("平台恢复" if resumed else "浏览器连接中断")
                published = True
                return backend, recovery
        except TimeoutError:
            raise InstaboxError("prepare_timeout", "等待环境准备超时；本次业务操作未提交，已受理恢复不会自动重发。") from None
        except (InstaboxError, asyncio.CancelledError):
            raise
        except CleanupUnconfirmedError:
            self._preparation_problem = True
            raise
        except Exception:
            raise InstaboxError("prepare", "环境或远端会话准备失败；本次业务操作未提交。") from None
        finally:
            # Failed session startup must not accumulate live SSH connections.
            if connection is not None and not published:
                connection.close()
                try:
                    async with asyncio.timeout(CLOSE_LIMIT):
                        await connection.wait_closed()
                except (TimeoutError, OSError, asyncssh.Error):
                    connection.abort()

    @staticmethod
    def _consume(task):
        if not task.cancelled():
            task.exception()  # Owner responsibility exists even if every waiter was cancelled.

    @asynccontextmanager
    async def _activity(self):
        """Track the entire I/O call, including cancellation cleanup on the ready SSH connection."""
        if self._closed:
            raise InstaboxError("closed", "执行环境已关闭，不再接受操作。")
        task = asyncio.current_task()
        self._active[task] = self._active.get(task, 0) + 1
        try:
            yield
        finally:
            depth = self._active[task] - 1
            if depth:
                self._active[task] = depth
            else:
                del self._active[task]

    async def _ready(self):
        async with self._activity():
            return await self._get_ready()

    async def _get_ready(self):
        if self._closed:
            raise InstaboxError("closed", "执行环境已关闭，不再接受操作。")
        # Every call that began behind the recovery barrier must stop, even if
        # another waiter durably delivers feedback while this call prepares skills.
        recovery = self._recovery_pending
        if (self._backend is None or self._backend._channel.broken
                or self._connection.is_closed()):
            if self._preparing is None or self._preparing.done():
                self._preparing = asyncio.create_task(self._prepare(), name="instabox-prepare")
                self._preparing.add_done_callback(self._consume)
            backend, prepared_recovery = await asyncio.shield(self._preparing)
            recovery = recovery or prepared_recovery
        else:
            backend = self._backend
        if self._closed:
            raise InstaboxError("closed", "执行环境已关闭，本次操作未提交。")
        if self._prepare_skills is not None:
            try:
                await self._prepare_skills(backend)
            except (asyncio.CancelledError, CleanupUnconfirmedError):
                raise
            except Exception:
                raise InstaboxError("skills", "技能包准备失败，本次操作未提交。") from None
        if self._closed:
            raise InstaboxError("closed", "执行环境已关闭，本次操作未提交。")
        if recovery or self._recovery_pending:
            async with self._recovery_delivery_lock:
                note = self._recovery_note
                if self._recovery_pending:
                    revision = self._recovery_revision
                    delivered = self._recovery_feedback is None
                    if self._recovery_feedback is not None:
                        try:
                            delivered = await self._recovery_feedback(note) is True
                        except Exception:
                            delivered = False
                    # A newer recovery may finish while the async sink reads checkpoints.
                    if delivered and revision == self._recovery_revision:
                        self._recovery_pending = False
            raise InstaboxRecoveryRequired(note)
        return backend

    @staticmethod
    def _unconfirmed_preparation_error() -> str:
        """Render safely; retain debt at its source, not in a duplicate sticky flag.

        SSH startup failures are recorded by _prepare. Recoverable skill staging
        belongs to the injected preparer's ledger and its environment owner.
        """
        return (
            "Instabox [cleanup_unconfirmed]：环境准备清理未确认，本次环境操作未提交。"
            "环境持有者仍保留未确认资源的清理责任，关闭时核验并汇总。"
        )

    async def aexecute(self, command, *, timeout=None, env=None):
        try:
            async with self._activity():
                backend = await self._ready()
                if env is None:
                    return await backend.aexecute(command, timeout=timeout)
                return await backend.aexecute(command, timeout=timeout, env=env)
        except InstaboxError as error:
            return ExecuteResponse(output=str(error), exit_code=None, truncated=False)
        except CleanupUnconfirmedError:
            return ExecuteResponse(output=self._unconfirmed_preparation_error(), exit_code=None, truncated=False)

    def _blocking(self, coroutine):
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self._loop:
            coroutine.close()
            raise RuntimeError("在事件循环线程中请使用 InstaboxBackend 的异步方法")
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result()

    def execute(self, command, *, timeout=None, env=None):
        return self._blocking(self.aexecute(command, timeout=timeout, env=env))

    async def aupload_files(self, files):
        try:
            async with self._activity():
                return await (await self._ready()).aupload_files(files)
        except InstaboxError as error:
            return [FileUploadResponse(path=path, error=str(error)) for path, _ in files]
        except CleanupUnconfirmedError:
            message = self._unconfirmed_preparation_error()
            return [FileUploadResponse(path=path, error=message) for path, _ in files]

    async def adownload_files(self, paths):
        try:
            async with self._activity():
                return await (await self._ready()).adownload_files(paths)
        except InstaboxError as error:
            return [FileDownloadResponse(path=path, error=str(error)) for path in paths]
        except CleanupUnconfirmedError:
            message = self._unconfirmed_preparation_error()
            return [FileDownloadResponse(path=path, error=message) for path in paths]


    async def aretrieve_attachment(self, path, root, destination, *, owner: str | None = None):
        async with self._activity():
            return await (await self._ready()).aretrieve_attachment(path, root, destination, owner=owner)

    async def aimport_file(self, source_fd, directory, identity, name, *, owner: str | None = None):
        async with self._activity():
            return await (await self._ready()).aimport_file(source_fd, directory, identity, name, owner=owner)

    async def aprepare_file_output(self, directory, *, owner: str | None = None):
        async with self._activity():
            await (await self._ready()).aprepare_file_output(directory, owner=owner)

    async def aread_task_file(self, path, directory, *, max_bytes: int, owner: str | None = None):
        async with self._activity():
            return await (await self._ready()).aread_task_file(
                path, directory, max_bytes=max_bytes, owner=owner,
            )

    async def asave_task_file(self, directory, filename, content, *, owner: str | None = None):
        async with self._activity():
            return await (await self._ready()).asave_task_file(
                directory, filename, content, owner=owner,
            )

    def pending_transfer_owners(self) -> set[str | None]:
        """Include old SSH sessions: reconnecting cannot release their unresolved transfers."""
        owners = set()
        for backend in self._sessions:
            owners.update(backend.pending_transfer_owners())
        if (self._preparation_problem or self._resume_pending
                or (self._preparing is not None and not self._preparing.done())):
            owners.add(None)
        if self._browser is not None and self._browser.cleanup_pending:
            owners.add(None)
        return owners

    async def apublish_artifact(self, path, content):
        async with self._activity():
            await (await self._ready()).apublish_artifact(path, content)

    def upload_files(self, files):
        return self._blocking(self.aupload_files(files))

    def download_files(self, paths):
        return self._blocking(self.adownload_files(paths))

    async def _close(self):
        problems = []
        # Commands own their stop protocol. Do not tear down SSH while their
        # preparation waiters or other I/O calls are cleaning up a cancelled SFTP stage.
        try:
            await self.processes.aclose()
        except CleanupUnconfirmedError as error:
            problems.append(str(error))
        active = {task for task in self._active if task is not asyncio.current_task() and not task.done()}
        for task in active:
            if not task.cancelling():
                task.cancel()
        if active:
            done, pending = await asyncio.wait(active, timeout=CLOSE_LIMIT)
            if pending:
                problems.append("真实 I/O 调用的取消清理未确认")
            if any(not task.cancelled() and isinstance(task.exception(), CleanupUnconfirmedError) for task in done):
                problems.append("真实 I/O 调用报告清理未确认")
        preparing = self._preparing
        if preparing is not None and not preparing.done():
            done, _ = await asyncio.wait({preparing}, timeout=CLOSE_LIMIT)
            if not done:
                preparing.cancel()
                done, _ = await asyncio.wait({preparing}, timeout=CLOSE_LIMIT)
                if not done:
                    problems.append("环境 owner 准备任务未结束")
        if self._preparation_problem:
            problems.append("环境准备资源清理未确认")
        if self._resume_pending:
            problems.append("已提交恢复的结果未确认；不会再次提交或主动暂停实例")
        if self._browser is not None:
            try:
                await self._browser.aclose()
            except CleanupUnconfirmedError as error:
                problems.append(str(error))
        for backend in self._sessions:
            try:
                await backend.aclose()
            except CleanupUnconfirmedError as error:
                problems.append(str(error))
        for connection in self._connections:
            connection.close()
            try:
                async with asyncio.timeout(CLOSE_LIMIT):
                    await connection.wait_closed()
            except (TimeoutError, OSError, asyncssh.Error):
                connection.abort()
                problems.append("SSH 连接关闭未确认")
        if problems:
            raise CleanupUnconfirmedError("Instabox 收尾未确认：" + "；".join(problems))

    async def aclose(self):
        if self._closing is None:
            self._closed = True
            self.processes._closed = True
            for backend in self._sessions:
                backend._channel.seal()
            self._closing = asyncio.create_task(self._close(), name="instabox-close")
            self._closing.add_done_callback(self._consume)
        if asyncio.current_task() in self._active and not self._closing.done():
            raise InstaboxError("close_from_io", "关闭已由 owner 接管；不能在自身 I/O 回调内等待自己收尾。")
        # A caller cancellation cannot abandon close or accepted preparation.
        await asyncio.shield(self._closing)

    def close(self):
        self._blocking(self.aclose())


def _file_entry(name, result_type):
    async def asynchronous(self, *args, **kwargs):
        try:
            async with self._activity():
                backend = await self._ready()
                return await getattr(backend, "a" + name)(*args, **kwargs)
        except InstaboxError as error:
            return result_type(error=str(error))
        except CleanupUnconfirmedError:
            return result_type(error=self._unconfirmed_preparation_error())

    @functools.wraps(getattr(BaseSandbox, name))
    def synchronous(self, *args, **kwargs):
        return self._blocking(asynchronous(self, *args, **kwargs))

    setattr(InstaboxBackend, name, synchronous)
    setattr(InstaboxBackend, "a" + name, asynchronous)


for _name, _result in (
    ("ls", LsResult), ("read", ReadResult), ("write", WriteResult), ("edit", EditResult),
    ("grep", GrepResult), ("glob", GlobResult), ("delete", DeleteResult),
):
    _file_entry(_name, _result)
