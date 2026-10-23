"""Gateway entry: runtime, authenticated HTTP/SSE and local pairing management.

Run: python -m wandrun.gateway --workspace <directory>
Pair: python -m wandrun.gateway pair --workspace <directory>
"""

import argparse
import asyncio
import contextlib
import ipaddress
import logging
import os
import socket
import signal
import threading
from collections.abc import Awaitable
from concurrent.futures import Future
from pathlib import Path

from urllib.parse import urlsplit
import uvicorn
from uvicorn.protocols.websockets.wsproto_impl import WSProtocol

from wandrun.config import load_config
from wandrun.gateway.http import create_app
from wandrun.gateway.pairing import write_management_credential
from wandrun.gateway.pair_cli import pair_main
from wandrun.gateway.connectors import mcp_config
from wandrun.gateway.service import Gateway, GatewayFailure
from wandrun.gateway.capabilities import gateway_capabilities
from wandrun.integrations.image_generation import DEFAULT_IMAGE_MODEL
from wandrun.integrations.codex_credentials import CodexCredentials, CredentialError
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.subscription import SubscriptionData, SubscriptionUnavailable
from wandrun.gateway.attachment_previews import AttachmentPreviewService
from wandrun.gateway.rich_media import ImageProxy, MediaCache
from wandrun.metrics import RunMetrics
from wandrun.runtime.session import open_runtime
from wandrun.runtime.workers import SchedulerFailure
from wandrun.runtime.workspace import Workspace


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class _NoWebSocketAccess(logging.Filter):
    """Hide uvicorn's handshake URI records without suppressing diagnostics.

    Uvicorn 0.52 logs the full WebSocket path and query through uvicorn.error
    (even with access_log=False). This is the three protocol implementations'
    INFO access template, not a warning or an exception.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return not (
            record.name == "uvicorn.error"
            and record.levelno == logging.INFO
            and isinstance(record.msg, str)
            and '"WebSocket %s"' in record.msg
        )

@contextlib.contextmanager
def _listening_sockets(host: str, port: int):
    """Hold every required listener before publishing this instance's admin credential."""
    addresses = (host,)
    if host not in ("0.0.0.0", "::") and not _is_loopback(host):
        addresses += ("::1" if ":" in host else "127.0.0.1",)
    bound = []
    try:
        for address in addresses:
            sock = socket.socket(socket.AF_INET6 if ":" in address else socket.AF_INET)
            bound.append(sock)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if sock.family == socket.AF_INET6:
                sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            sock.bind((address, port))
            sock.listen(socket.SOMAXCONN)
            sock.setblocking(False)
        yield bound
    finally:
        for sock in bound:
            sock.close()


class _WebSocketProtocol(WSProtocol):
    """Bound device-revocation close delivery and handshake to one second."""

    async def send(self, message):
        if message["type"] != "websocket.close" or message.get("code") != 4401:
            return await super().send(message)
        deadline = self.loop.time() + 1
        try:
            async with asyncio.timeout_at(deadline):
                await super().send(message)
        except TimeoutError:
            # transport.close() would keep flushing buffered frames to a peer
            # that may never read. Aborting discards them and releases the socket.
            self.transport.abort()
        else:
            if self.close_timer is not None:
                self.close_timer.cancel()
                self.close_timer = self.loop.call_at(deadline, self.transport.abort)


class _Server(uvicorn.Server):
    """调整 uvicorn 的两处关闭行为，让运行时能按顺序收尾。"""

    def __init__(
        self, config: uvicorn.Config, gateway: Gateway, sockets: list[socket.socket] | None = None,
    ):
        # Uvicorn 0.52.4's auto-selected SansIO backend does not mark an HTTP
        # denial handshake complete. wsproto correctly completes the ASGI denial
        # extension (401) without relying on websockets' deprecated legacy stack.
        config.ws = _WebSocketProtocol
        super().__init__(config)
        self._gateway = gateway
        self._loop: asyncio.AbstractEventLoop | None = None
        self._prebound_sockets = sockets

    async def serve(self, sockets=None) -> None:
        self._loop = asyncio.get_running_loop()
        if sockets is None:
            sockets = self._prebound_sockets
        host = self.config.host
        # A specific LAN bind does not accept loopback connections; retain a
        # second listener for CLI management even when _Server is used directly.
        bind_locally = sockets is None and host not in ("0.0.0.0", "::") and not _is_loopback(host)
        with (
            _listening_sockets(host, self.config.port)
            if bind_locally else contextlib.nullcontext(sockets)
        ) as listeners:
            logger = logging.getLogger("uvicorn.error")
            access_filter = _NoWebSocketAccess()
            logger.addFilter(access_filter)
            try:
                with self.capture_signals():
                    await self._serve(listeners)
            finally:
                logger.removeFilter(access_filter)

    @contextlib.contextmanager
    def capture_signals(self):
        # uvicorn 原实现在 serve 返回后用 raise_signal 重放 Ctrl+C；asyncio 会因此取消主任务，
        # 正在进行的运行时收尾（停止 Worker、关闭 MCP 与执行环境）被打断。这里只捕获、不重放。
        original = {sig: signal.signal(sig, self.handle_exit) for sig in (signal.SIGINT, signal.SIGTERM)}
        try:
            yield
        finally:
            for sig, handler in original.items():
                signal.signal(sig, handler)

    def handle_exit(self, sig, frame) -> None:
        super().handle_exit(sig, frame)
        if self._loop is not None:
            # 信号处理函数不在事件循环的回调里执行，交给循环去结束事件流。
            self._loop.call_soon_threadsafe(self._gateway.end_streams)


async def run_server(server: uvicorn.Server, gateway: Gateway, *failures: Awaitable):
    """运行 HTTP 服务直到它退出或任一失败监视结束，返回先出现的失败（没有则 None）。

    正常退出与外层第一次取消共用同一段收尾：结束事件流、请求 HTTP 关闭并等服务任务退出、
    取消并等待监视任务；完成后调用方才能释放运行时与数据库，否则服务会在已关闭的存储上继续响应。
    收尾期间再次取消会打断它，不再保证收尾完整；第二次 Task.cancel() 也不等于进程已退出，
    嵌入式调用方仍要自己负责最终中止。
    """
    serving = asyncio.create_task(server.serve())
    watchers = [asyncio.ensure_future(failure) for failure in failures]
    try:
        await asyncio.wait({serving, *watchers}, return_when=asyncio.FIRST_COMPLETED)
        failure = next((w.result() for w in watchers if w.done() and not w.cancelled()), None)
    finally:
        try:
            await gateway.stop_schedules()
        finally:
            gateway.end_streams()
            server.should_exit = True
            for watcher in watchers:
                watcher.cancel()
            await asyncio.gather(serving, *watchers, return_exceptions=True)
    if serving.done() and not serving.cancelled() and serving.exception() is not None:
        raise serving.exception()
    return failure


@contextlib.contextmanager
def reporting_failure(gateway: Gateway):
    """把网关致命失败报告出去，包括运行时收尾期间才发生的：run_server 返回后，open_runtime
    仍要停止 Worker，它们的结算还会回调网关。收尾正常结束就抛出这个失败；已有别的异常
    （或取消）在传播时不覆盖它，把迟到的失败附在上面。"""
    try:
        yield
    except BaseException as error:
        late = gateway.failure
        if late is not None and late is not error:
            error.add_note(f"网关也已停止：{late}：{late.__cause__}")
        raise
    if gateway.failure is not None:
        raise gateway.failure


def ensure_agents(
    store: GatewayStore, agents_config: Path, mcps_config: Path, environments_config: Path,
) -> None:
    """首次启动校验并原子导入 Agent 与连接器；之后不再读取这两个 TOML。

    环境仍来自指定文件。校验或事务失败不留导入标记，修好文件后可重新启动。
    """
    if store.has_imported_agents():
        return
    config = load_config(agents_config, mcps_config, environments_config)
    # 文件给出的是完整且已校验的参数，不是 API 密钥补丁；空值必须原样导入。
    connectors = {
        identity: {
            "id": identity, "name": identity,
            "description": config.mcp_descriptions.get(identity, ""), **connection,
        }
        for identity, connection in config.mcp_servers.items()
    }
    store.import_agents(config.catalog, connectors)


async def serve(
    *,
    workspace: Path,
    token: str | None = None,
    host: str,
    port: int,
    agents_config: Path | None = None,
    mcps_config: Path | None = None,
    environments_config: Path | None = None,
    codex_client_version: str = "0.163.0",
    codex_home: Path | None = None,
    allow_shared_codex_home: bool = False,
    max_upload_size: int = 1024 ** 3,
    image_generation_model: str = DEFAULT_IMAGE_MODEL,
    public_url: str | None = None,
) -> None:
    if public_url is not None:
        parsed = urlsplit(public_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or public_url.endswith("/oauth/callback")):
            raise ValueError("--public-url 必须是无查询、片段或凭据的 HTTPS 网关地址")
    workspace = Workspace(workspace)
    if not _is_loopback(host):
        print("提示：非回环监听；公网访问必须通过 HTTPS 反向代理或加密隧道。")
    if workspace.ensure_config():
        print(f"已生成默认配置：{workspace.runtime_dir}")
    credentials = CodexCredentials.gateway(codex_home, allow_shared=allow_shared_codex_home)
    store = None
    subscription = None
    gateway = None
    try:
        store = GatewayStore(workspace.state_dir / "gateway.sqlite")
        subscription = SubscriptionData(store, client_version=codex_client_version, credentials=credentials)
        gateway = Gateway(store, subscription, oauth_port=port, public_url=public_url)
        gateway.skills_dir = workspace.skills_dir
        gateway.workspace_root = workspace.root
        loop = asyncio.get_running_loop()
        loop_thread = threading.get_ident()

        def on_record(record: dict) -> None:
            # 同步模型调用也可能在线程中完成；记账必须回到 SQLite 所属线程，且在执行结算前完成，
            # 否则删除 Agent 与迟到的用量回调会竞态。运行时先收拢执行，再关闭数据库。
            if threading.get_ident() == loop_thread:
                gateway.on_usage(record)
                return
            result = Future()

            def record_on_loop():
                try:
                    gateway.on_usage(record)
                except Exception as error:
                    result.set_exception(error)
                else:
                    result.set_result(None)

            loop.call_soon_threadsafe(record_on_loop)
            result.result()

        metrics = RunMetrics(workspace.runs_dir, on_record=on_record)
        # Disposable display copies only; never mixed with original file delivery.
        media_cache = MediaCache(workspace.state_dir / "rich-media")
        gateway.image_proxy = ImageProxy(media_cache)
        preview_service = AttachmentPreviewService(workspace.state_dir / "previews")
        preview_service.start()
        gateway.attachment_previews = preview_service
        # Agent 与 MCP 文件仅作首次导入来源，环境文件每次启动仍读取。
        mcps_config = mcps_config or workspace.mcps_config
        environments_config = environments_config or workspace.environments_config
        ensure_agents(
            store, agents_config or workspace.agents_config, mcps_config, environments_config
        )
        # 旧进程的租约不可恢复；在运行时建立新接入点之前写入结束快照和可续传事件。
        gateway._persist(store.invalidate_browser_tasks)
        servers, descriptions = mcp_config(store.connector_definitions())
        try:
            model_snapshot = await subscription.models()
        except SubscriptionUnavailable:
            logging.getLogger(__name__).warning(
                "模型目录暂不可用；未显式配置 context_window 的角色将禁用自动压缩"
            )
            model_snapshot = {"models": []}
        model_context_windows = {
            model["id"]: model["context_window"] for model in model_snapshot["models"]
            if model["context_window"] is not None
        }
        with reporting_failure(gateway):
            async with open_runtime(
                workspace,
                metrics=metrics,
                on_human=gateway.on_human,
                on_preview=gateway.on_preview,
                entry_capabilities=gateway_capabilities(
                    gateway, image_generation_model=image_generation_model,
                ),
                on_update=gateway.on_update,
                model_context_windows=model_context_windows,
                credentials=credentials,
                on_compaction=gateway.on_compaction,
                on_task=gateway.on_task,
                on_task_created=gateway.on_task_created,
                on_task_message=gateway.on_task_message,
                notify_human_of_roots=False,
                conversation_workdirs=True,
                agent_catalog=store.agent_catalog(),  # 库是 Agent 的唯一来源，agents.toml 不再读取
                mcp_servers=servers,
                mcp_descriptions=descriptions,
                mcp_oauth=gateway.oauth,
                oauth_connectors={
                    identity for identity, definition in store.connector_definitions().items()
                    if definition.get("auth_type") == "oauth"
                },
                environments_config=environments_config,
            ) as runtime:
                gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                gateway.enable_uploads(max_upload_size)
                try:
                    with _listening_sockets(host, port) as sockets:
                        await gateway.resume_deletions()
                        await gateway.reconcile_compactions()
                        gateway.start_schedules()
                        management_token = write_management_credential(workspace.state_dir, host, port)
                        server = _Server(
                            uvicorn.Config(
                                create_app(gateway, token, management_token=management_token),
                                host=host,
                                port=port,
                                log_level="info",
                                log_config={
                                    **uvicorn.config.LOGGING_CONFIG,
                                    "loggers": {
                                        **uvicorn.config.LOGGING_CONFIG["loggers"],
                                        "wandrun.gateway.browser_stream": {
                                            "handlers": ["default"], "level": "INFO", "propagate": False,
                                        },
                                    },
                                },
                                access_log=False,  # URL/query 可能含凭据，不能交给 uvicorn access logger
                                proxy_headers=False,  # 管理接口只判断实际 TCP peer
                                timeout_graceful_shutdown=10,  # 兜底：仍有连接未结束时最多再等 10 秒
                            ),
                            gateway,
                            sockets=sockets,
                        )
                        # Ctrl+C、调度存储失败或网关致命失败都结束服务：停止接收请求、结束事件流，
                        # 之后由运行时收拢任务与资源；调度存储失败由 open_runtime 退出时抛出（manager.close 报告），
                        # 运行时收尾期间才发生的网关失败由 reporting_failure 报告。
                        failure = await run_server(
                            server, gateway, runtime.workers.wait_failure(), gateway.wait_failure(),
                        )
                        if isinstance(failure, GatewayFailure):
                            raise failure  # 在运行时内抛出：收尾问题作为 notes 附在它上面
                        if failure is not None:
                            print(f"调度存储失败，停止网关：{failure}：{failure.__cause__}")
                finally:
                    try:
                        await gateway.stop_schedules()
                    finally:
                        try:
                            await gateway.drain_deletions()
                        finally:
                            await gateway.oauth.aclose()
    finally:
        try:
            if gateway is not None and gateway.image_proxy is not None:
                await gateway.image_proxy.aclose()
        finally:
            try:
                if gateway is not None and gateway.attachment_previews is not None:
                    await gateway.attachment_previews.aclose()
            finally:
                try:
                    if subscription is not None:
                        await subscription.aclose()
                finally:
                    try:
                        if store is not None:
                            store.close()
                    finally:
                        await credentials.aclose()


def main(argv: list[str] | None = None) -> None:
    """Dispatch a leading subcommand; later 'pair' values belong to server options."""
    if argv is None:
        import sys
        argv = sys.argv[1:]
    if argv[:1] == ["pair"]:
        pair_main(argv[1:])
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", type=Path, default=Path("."))
    parser.add_argument("--host", default="127.0.0.1", help="默认只监听本机；手机在局域网调试时可设为 0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", default=os.environ.get("WANDRUN_GATEWAY_TOKEN"),
                        help="开发令牌；也可用环境变量 WANDRUN_GATEWAY_TOKEN")
    parser.add_argument(
        "--public-url", default=os.environ.get("WANDRUN_PUBLIC_URL"),
        help="手机可访问的网关 HTTPS 地址（可含部署前缀），用于 OAuth 自动回调",
    )
    parser.add_argument("--agents-config", type=Path, help="仅库里还没有 Agent 的首次启动时导入；之后以数据库为准")
    parser.add_argument("--mcps-config", type=Path)
    parser.add_argument("--environments-config", type=Path)
    parser.add_argument(
        "--codex-home", type=Path, default=os.environ.get("WANDRUN_CODEX_HOME"),
        help="网关专属 Codex 凭据目录，默认 ~/.local/share/wandrun/codex-home；不读取 CODEX_HOME",
    )
    parser.add_argument(
        "--allow-shared-codex-home", action="store_true",
        help="仅供开发过渡：允许共享目录，只读凭据且永不刷新",
    )
    parser.add_argument(
        "--codex-client-version", default=os.environ.get("WANDRUN_CODEX_CLIENT_VERSION", "0.163.0"),
        help="Codex 目录兼容版本；不使用 Wandrun 自身版本",
    )
    parser.add_argument(
        "--max-upload-size", type=int, default=1024 ** 3,
        help="单文件上传大小上限（字节，默认 1 GiB）",
    )
    parser.add_argument(
        "--image-generation-model",
        default=os.environ.get("WANDRUN_IMAGE_GENERATION_MODEL", DEFAULT_IMAGE_MODEL),
        help="订阅 Responses 生图请求模型（默认 gpt-6-astra）",
    )
    args = parser.parse_args(argv)
    if args.token == "":
        parser.error("开发令牌不能为空")
    try:
        asyncio.run(serve(
            workspace=args.workspace,
            token=args.token,
            host=args.host,
            port=args.port,
            agents_config=args.agents_config,
            mcps_config=args.mcps_config,
            environments_config=args.environments_config,
            codex_client_version=args.codex_client_version,
            codex_home=args.codex_home,
            allow_shared_codex_home=args.allow_shared_codex_home,
            max_upload_size=args.max_upload_size,
            public_url=args.public_url,
            image_generation_model=args.image_generation_model,
        ))
    except GatewayFailure as error:
        raise SystemExit(exit_message("网关已停止", error)) from error
    except SchedulerFailure as error:
        raise SystemExit(exit_message("运行已停止", error)) from error
    except CredentialError as error:
        raise SystemExit(str(error)) from None


def exit_message(title: str, error: BaseException) -> str:
    # 保留 notes：同时发生的问题（如远端清理未确认、迟到的网关失败）附在正在传播的异常上，必须报告给用户。
    notes = "".join(f"\n{note}" for note in getattr(error, "__notes__", ()))
    return f"{title}：{error}：{error.__cause__}{notes}"
