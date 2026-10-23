"""Own MCP connections by service, independently of agent graph revisions."""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
from collections.abc import Callable, Mapping
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from functools import partial
from urllib.parse import parse_qsl, quote, quote_plus, unquote, urlsplit

import httpx2

from fastmcp import Client as FastMCPClient
from fastmcp.client.transports.http import StreamableHttpTransport
from fastmcp.client.transports.sse import SSETransport
from fastmcp.client.transports.stdio import StdioTransport
from langchain.mcp import MCPAdapter
from langchain.tools import BaseTool
from langchain_core.tools import ToolException
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.errors import GraphBubbleUp
from mcp.shared.exceptions import MCPError
from mcp_types import CONNECTION_CLOSED, REQUEST_TIMEOUT

from wandrun.config import AgentDefinition
from wandrun.integrations.mcp_oauth import (
    ConnectorOAuth, OAuthIssue, _secret_source, oauth_secrets,
)


class MCPCallError(ToolException):
    """MCP 调用的传输或协议失败；作为失败的工具结果交给模型，而不是结束整个任务。"""


_secrets: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar("mcp_secrets", default=())
_log_factory = logging.getLogRecordFactory()
_logging_owners = 0


def _redact(text: str, secrets: tuple[str, ...]) -> str:
    """Strip configured credentials even after SDK/HTTP formatting has escaped them."""
    variants = set()
    for secret in secrets:
        encoded = repr(secret.encode("utf-8"))[2:-1]
        base = {
            secret, quote(secret, safe=""), quote_plus(secret, safe=""),
            json.dumps(secret)[1:-1], json.dumps(secret, ensure_ascii=False)[1:-1],
            repr(secret)[1:-1], encoded,
            secret.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r"),
            secret.replace("'", "\\'"), secret.replace('"', '\\"'),
        }
        variants.update(base)
        # SDK exception tuples and structured log args can quote an already
        # escaped value once more. Redact before any truncation/normalization.
        for value in base:
            variants.update((value.replace("\\", "\\\\"),
                             json.dumps(value)[1:-1], repr(value)[1:-1]))
    for value in sorted((item for item in variants if item), key=len, reverse=True):
        text = text.replace(value, "[redacted]")
    return text


def _safe_record(*args, **kwargs):
    record = _log_factory(*args, **kwargs)
    secrets = _secrets.get() + oauth_secrets()
    if secrets:
        # The context also propagates to FastMCP's background transport task. Do not
        # silence unrelated loggers globally; only redact records made in this context.
        record.msg = _redact(record.getMessage(), secrets)
        record.args = ()
        record.exc_info = None  # Exception formatting happens after the record factory.
        record.stack_info = None
    return record


def _connection_secrets(connection: Mapping) -> tuple[str, ...]:
    values = [
        value for field in ("headers", "env")
        for value in connection.get(field, {}).values() if isinstance(value, str) and value
    ]
    if "url" in connection:
        url = urlsplit(connection["url"])
        values.extend(value for _, value in parse_qsl(url.query) if value)
        values.extend(unquote(value) for value in (url.username, url.password) if value)
    return tuple(sorted(set(values), key=len, reverse=True))


def _safe_reason(error: Exception) -> str:
    """Public errors classify SDK failures; exception text is not a trusted channel."""
    if isinstance(error, (TimeoutError, httpx2.TimeoutException)) or (
        isinstance(error, MCPError) and error.code == REQUEST_TIMEOUT
    ):
        return "请求超时"
    if isinstance(error, (ConnectionError, OSError, httpx2.HTTPError)) or (
        isinstance(error, MCPError) and error.code == CONNECTION_CLOSED
    ):
        return "连接请求失败"
    return "远端请求失败"


def _transport_failed(error: Exception, client: object) -> bool:
    if isinstance(error, MCPError):
        return error.code == CONNECTION_CLOSED
    if isinstance(error, httpx2.HTTPStatusError):
        return False
    if isinstance(error, (ConnectionError, httpx2.HTTPError)):
        return True
    if isinstance(error, OSError) and not isinstance(error, TimeoutError):
        return True
    # FastMCP 4.0.3 keeps its owning asyncio task at Client._session_state.session_task.
    task = getattr(getattr(client, "_session_state", None), "session_task", None)
    return isinstance(error, RuntimeError) and task is not None and task.done()


class MCPConnectionError(ValueError):
    """Safe-to-display connection/discovery failure; credentials and SDK errors stay private."""



class MCPCleanupError(RuntimeError):
    """The SDK owner did not finish release by the deadline; resources are unconfirmed."""


@dataclass(eq=False)
class _Service:
    connection: dict
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    client: object | None = None
    tools: list[BaseTool] = field(default_factory=list)
    raw_tools: dict[str, BaseTool] = field(default_factory=dict)
    error: MCPConnectionError | None = None
    status: str = "disconnected"
    suspect: bool = False
    released: bool = False
    generation: int | None = None
    oauth_issue: OAuthIssue | None = None


class MCPConnectionPool:
    """Own MCP sessions by service, replacing them only when next used.

    Each owner enters and exits its adapter in the same task. Shared confirmation
    and recovery outlive cancelled waiters; unconfirmed owners remain for aclose.

    FastMCP 4.0.3 exposes owner liveness through private _session_state.session_task
    and one-server transport through MCPConfigTransport.transport. MCP 2.1.1
    supplies HTTP hooks and bounded, shielded courtesy-cancel writes; session
    404s are recorded before the SDK reduces them to ordinary JSON-RPC errors;
    revisit these boundaries when upgrading either SDK.
    """

    def __init__(self, *, open_timeout: float = 30.0, cleanup_timeout: float = 20.0,
                 call_timeout: float = 600.0, oauth: ConnectorOAuth | None = None):
        self._services: dict[str, _Service] = {}
        self._connections: dict[str, dict] = {}
        self._recoveries: dict[str, asyncio.Task] = {}
        self._catalogs: dict[str, list[BaseTool]] = {}
        self._first_definitions: dict[str, tuple[str, ...]] = {}
        self._orphans: dict[str, list[_Service]] = {}
        self._closed = False
        self.on_change: Callable[[str], None] | None = None
        self._logging = False
        self._open_timeout = open_timeout
        self._cleanup_timeout = cleanup_timeout
        self._call_timeout = call_timeout
        self.oauth = oauth
        self.oauth_connectors: set[str] = set()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.aclose()

    @staticmethod
    def _snapshot(connection: Mapping) -> dict:
        return {
            key: list(value) if isinstance(value, list) else dict(value) if isinstance(value, dict)
            else value for key, value in connection.items()
        }

    def _connection(self, server: str, fallback: dict | None) -> dict:
        if server in self._connections:
            return self._connections[server]
        if fallback is None:
            raise MCPConnectionError(f"MCP 服务 {self._safe_server(server)} 不存在")
        return fallback

    async def open(self, server: str, connection: dict) -> list[BaseTool]:
        """Return first-discovered definitions, recovering only their underlying session."""
        if self._closed:
            raise RuntimeError("MCP 连接池已关闭")
        desired = self._connection(server, connection)
        if (self.oauth is not None and server in self.oauth_connectors
                and not self.oauth.authorized(server, self.oauth.generation(server), desired["url"])):
            return []  # Discovery must not start interactive authorization.
        return (await self._ensure(server, desired)).tools

    def status(self, server: str, connection: dict) -> dict:
        """Report health and whether edited parameters require a process restart."""
        state = self._services.get(server)
        connected = state is not None and state.status == "connected"
        return {
            "status": state.status if state is not None else "disconnected",
            "error": str(state.error) if state is not None and state.error is not None else None,
            "tool_count": len(state.tools) if connected else 0,
            "pending_restart": server in self._connections and self._connections[server] != connection,
        }

    async def probe(self, server: str, connection: dict) -> list[BaseTool]:
        """Probe the original connection, bypassing discovery cache without publishing it."""
        if self._closed:
            raise RuntimeError("MCP 连接池已关闭")
        if server not in self._services:
            return await self.open(server, connection)
        state = await self._ensure(server, self._connection(server, connection))
        token = _secrets.set(_connection_secrets(state.connection))
        oauth_scope = _secret_source.set(
            lambda: self.oauth.secret_values(server),
        ) if state.generation is not None else None
        try:
            await self._authorize(server, state)
            try:
                async with asyncio.timeout(self._open_timeout):
                    await state.client.list_tools(cache_mode="bypass")
            except Exception as error:
                if state.generation is not None and (issue := self._take_oauth_issue(state)):
                    raise MCPConnectionError(str(issue)) from None
                if _transport_failed(error, state.client):
                    state.suspect = True
                raise MCPConnectionError(
                    f"MCP 服务 {_redact(server, _connection_secrets(state.connection))} "
                    f"工具发现失败：{_safe_reason(error)}"
                ) from None
            return state.tools
        finally:
            _secrets.reset(token)
            if oauth_scope is not None:
                _secret_source.reset(oauth_scope)

    async def _ensure(self, server: str, connection: dict) -> _Service:
        """Coalesce one service's recovery; never wait for another service or graph."""
        while True:
            if self._closed:
                raise RuntimeError("MCP 连接池已关闭")
            desired = self._connection(server, connection)
            task = self._recoveries.get(server)
            if task is None:
                state = self._services.get(server)
                session_task = getattr(getattr(state.client, "_session_state", None),
                                       "session_task", None) if state is not None else None
                generation = (self.oauth.generation(server) if self.oauth is not None
                              and server in self.oauth_connectors else None)
                if (state is not None and state.status == "connected" and not state.suspect
                        and state.generation == generation
                        and (state.task is None or not state.task.done())
                        and (session_task is None or not session_task.done())):
                    return state
                task = asyncio.create_task(self._recover(server, self._snapshot(desired)))
                self._recoveries[server] = task
                task.add_done_callback(lambda done: self._recovery_done(server, done))
            try:
                state = await asyncio.shield(task)
            except asyncio.CancelledError:
                if self._closed or not asyncio.current_task().cancelling():
                    raise MCPConnectionError(
                        f"MCP 服务 {self._safe_server(server)} 已关闭"
                    ) from None
                raise
            finally:
                if task.done():
                    self._recovery_done(server, task)
            generation = (self.oauth.generation(server) if self.oauth is not None
                          and server in self.oauth_connectors else None)
            session_task = getattr(getattr(state.client, "_session_state", None),
                                   "session_task", None)
            if (state is self._services.get(server) and state.status == "connected"
                    and not state.suspect and state.generation == generation
                    and (state.task is None or not state.task.done())
                    and (session_task is None or not session_task.done())):
                return state
            if (state.error is not None and state.generation is not None
                    and server not in self._catalogs):
                return state  # First OAuth discovery need not block startup.

    def _recovery_done(self, server: str, task: asyncio.Task) -> None:
        if self._recoveries.get(server) is not task:
            return
        del self._recoveries[server]
        if not task.cancelled():
            task.exception()  # Consume failures even after every waiter cancelled.

    def _safe_server(self, server: str) -> str:
        state = self._services.get(server)
        secrets = _secrets.get() + (_connection_secrets(state.connection) if state else ())
        return _redact(server, secrets)

    async def _recover(self, server: str, desired: dict) -> _Service:
        """Scope both credentials across recovery, including SDK ping senders."""
        previous = self._services.get(server)
        secrets = _connection_secrets(desired)
        if previous is not None:
            secrets += _connection_secrets(previous.connection)
        token = _secrets.set(_secrets.get() + secrets)
        oauth_scope = _secret_source.set(
            lambda: self.oauth.secret_values(server),
        ) if self.oauth is not None and server in self.oauth_connectors else None
        try:
            return await self._recover_owner(server, desired)
        finally:
            _secrets.reset(token)
            if oauth_scope is not None:
                _secret_source.reset(oauth_scope)

    async def _recover_owner(self, server: str, desired: dict) -> _Service:
        state = self._services.get(server)
        current_generation = (self.oauth.generation(server) if self.oauth is not None
                              and server in self.oauth_connectors else None)
        if state is not None and state.generation != current_generation:
            # Explicit OAuth generation changes keep their original refresh path.
            self._catalogs.pop(server, None)
            self._first_definitions.pop(server, None)
        if (state is not None and state.status == "connected"
                and state.connection == desired and state.generation == current_generation):
            session_task = getattr(getattr(state.client, "_session_state", None),
                                   "session_task", None)
            if state.task is not None and state.task.done():
                self._invalidate(server, state, "连接 owner 已结束")
            elif session_task is not None and session_task.done():
                self._invalidate(server, state, "会话任务结束")
            elif state.suspect:
                await self._authorize(server, state)
                try:
                    async with asyncio.timeout(5):
                        if not await state.client.ping():
                            raise ConnectionError("ping failed")
                except Exception:
                    self._invalidate(server, state, "ping 失败")
                else:
                    state.suspect = False
                    return state
            else:
                return state
        if state is not None:
            await self._retire(server, state)
        if self._closed:
            raise RuntimeError("MCP 连接池已关闭")
        self._enable_logging()
        new = _Service(self._snapshot(desired))
        if self.oauth is not None and server in self.oauth_connectors:
            new.generation = self.oauth.generation(server)
            if not self.oauth.authorized(server, new.generation, desired["url"]):
                raise MCPConnectionError(f"MCP 服务 {self._safe_server(server)} 需要重新授权")
        self._services[server] = new
        new.task = asyncio.create_task(self._serve(server, new))
        try:
            await asyncio.wait_for(new.ready.wait(), self._open_timeout + self._cleanup_timeout)
        except TimeoutError:
            if not new.ready.is_set():
                new.status = "failed"
                new.error = MCPConnectionError(
                    f"MCP 服务 {self._safe_server(server)} 打开与清理超时，资源释放未确认"
                )
                new.ready.set()
                new.task.cancel()
                self._remember_orphan(server, new)
                if self.on_change is not None:
                    self.on_change(server)
        if new.error is not None:
            if new.generation is not None and new.released and server not in self._catalogs:
                return new  # First OAuth discovery need not block gateway startup.
            raise new.error
        definitions = tuple(sorted(
            json.dumps(convert_to_openai_tool(tool)["function"], sort_keys=True, ensure_ascii=False)
            for tool in new.raw_tools.values()
        ))
        if server not in self._catalogs:
            # Failed initial opens may still be corrected; freeze only after discovery.
            self._connections[server] = new.connection
            self._catalogs[server] = new.tools
            self._first_definitions[server] = definitions
        elif definitions != self._first_definitions[server]:
            logging.getLogger(__name__).warning(
                "MCP 服务 %s 工具目录已变化，沿用首次发现的定义", self._safe_server(server),
            )
        new.tools = self._catalogs[server]
        return new

    def _invalidate(self, server: str, state: _Service, reason: str) -> None:
        if state.status != "connected" or self._services.get(server) is not state:
            return
        state.status = "failed"
        state.suspect = False
        state.error = MCPConnectionError(
            f"MCP 服务 {_redact(server, _connection_secrets(state.connection))} 连接已失效：{reason}"
        )
        logging.getLogger(__name__).warning(
            "MCP 服务 %s 连接失效：%s", _redact(server, _connection_secrets(state.connection)), reason,
        )
        if self.on_change is not None:
            self.on_change(server)

    def _session_ended(self, server: str, state: _Service) -> None:
        if self._closed or state.stop.is_set():
            return
        try:
            self._invalidate(server, state, "会话任务结束")
        except Exception:
            logging.getLogger(__name__).error("MCP 会话失效状态发布失败")

    def _http_client(self, *, state: _Service, **kwargs) -> httpx2.AsyncClient:
        """Preserve session rejection and tool read clocks; never replay requests."""
        kwargs.setdefault("follow_redirects", True)  # MCP SDK's default, including SSE.
        kwargs.setdefault("timeout", httpx2.Timeout(30.0, read=300.0))

        async def tool_read_timeout(request: httpx2.Request) -> None:
            if request.method == "POST" and json.loads(request.content).get("method") == "tools/call":
                request.extensions["timeout"]["read"] = self._call_timeout

        async def session_rejected(response: httpx2.Response) -> None:
            if (response.status_code == 404 and response.request.method in {"GET", "POST"}
                    and response.request.headers.get("mcp-session-id")):
                # MCP 2.1.1 can return INVALID_REQUEST while keeping its owner alive.
                # Bind the signal to this owner, never a replacement connection.
                state.suspect = True

        client = httpx2.AsyncClient(**kwargs)
        client.event_hooks.setdefault("request", []).append(tool_read_timeout)
        client.event_hooks.setdefault("response", []).append(session_rejected)
        return client

    async def _serve(self, server: str, state: _Service) -> None:
        secrets = _connection_secrets(state.connection)
        safe_server = _redact(server, secrets)
        token = _secrets.set(secrets)
        oauth_scope = _secret_source.set(
            lambda: self.oauth.secret_values(server),
        ) if state.generation is not None else None
        callback_failed = False
        http_client = partial(self._http_client, state=state)
        try:
            try:
                if state.generation is None:
                    client = FastMCPClient({"mcpServers": {server: state.connection}})
                    # FastMCP 4.0.3's one-server MCPConfigTransport exposes
                    # its selected transport at .transport. SSE has a separate
                    # stream read clock beyond the HTTP client's request timeout.
                    underlying = getattr(client.transport, "transport", None)
                    if isinstance(underlying, (StreamableHttpTransport, SSETransport)):
                        underlying.httpx_client_factory = http_client
                    if isinstance(underlying, SSETransport):
                        underlying.sse_read_timeout = timedelta(seconds=self._call_timeout)
                    adapter = MCPAdapter(client)
                else:
                    pool = self

                    class BearerAuth(httpx2.Auth):
                        async def async_auth_flow(self, request):
                            url = state.connection["url"]
                            bearer = await pool.oauth.token(server, state.generation, url)
                            request.headers["Authorization"] = "Bearer " + bearer
                            response = yield request
                            if response.status_code == 401:
                                try:
                                    await pool.oauth.token(
                                        server, state.generation, url, rejected_access=bearer,
                                    )
                                except OAuthIssue as error:
                                    state.oauth_issue = error
                                else:
                                    state.oauth_issue = OAuthIssue(
                                        "oauth_unavailable", "授权凭据已更新；工具未自动重放，请重新调用", 503,
                                    )
                                # The original 401 reaches the SDK; never replay tools/call.

                    adapter = MCPAdapter(FastMCPClient(
                        StreamableHttpTransport(
                            state.connection["url"], auth=BearerAuth(),
                            httpx_client_factory=http_client,
                        ),
                    ))
                state.client = adapter.client
                transport = getattr(getattr(adapter.client, "transport", None), "transport", None)
                if isinstance(transport, StdioTransport):
                    transport.log_file = Path(os.devnull)
                async with AsyncExitStack() as stack:
                    # A failed __aenter__ can allocate a transport. Only this
                    # owner task exits the adapter and force-closes the client.
                    async def close_client():
                        try:
                            await adapter.client.close()
                        except Exception:
                            # FastMCP 4.0.3 close() calls _disconnect(force=True)
                            # before transport.close(); _disconnect clears the private
                            # session_task even if its ended task raises. Complete
                            # the skipped transport stage, never a remote request.
                            client = adapter.client
                            if (isinstance(client, FastMCPClient)
                                    and client._session_state.session_task is None):
                                await client.transport.close()
                                state.released = True
                            raise
                        state.released = True

                    stack.push_async_callback(close_client)
                    async with asyncio.timeout(self._open_timeout):
                        await stack.enter_async_context(adapter)
                        raw = await adapter.list_tools()
                        state.raw_tools = {tool.name: tool for tool in raw}
                        state.tools = self._catalogs.get(server)
                        if state.tools is None:
                            state.tools = [
                                _report_call_failures(
                                    tool, server, self, state.generation, state.connection.get("url"), secrets,
                                )
                                for tool in raw
                            ]
                    if state.error is not None:
                        raise state.error
                    state.status = "connected"
                    if self.on_change is not None:
                        try:
                            self.on_change(server)
                        except Exception:
                            callback_failed = True
                            state.status = "failed"
                            state.error = MCPConnectionError(f"MCP 服务 {safe_server} 状态发布失败")
                            raise
                    state.ready.set()
                    # FastMCP 4.0.3 exposes the live session task privately;
                    # detect unsolicited termination even without a tool call.
                    session_task = getattr(getattr(state.client, "_session_state", None),
                                           "session_task", None)
                    if isinstance(session_task, asyncio.Task):
                        session_task.add_done_callback(
                            lambda _: self._session_ended(server, state)
                        )
                    await state.stop.wait()
            except asyncio.CancelledError:
                if state.error is None or state.released:
                    state.error = MCPConnectionError(
                        f"MCP 服务 {safe_server} 已关闭" if state.released or state.client is None else
                        f"MCP 服务 {safe_server} 关闭中断，资源释放未确认"
                    )
                state.status = "failed"
                raise
            except Exception as error:
                if state.status == "failed" and state.ready.is_set():
                    pass  # A failed session can reject __aexit__; forced close confirmed release.
                elif state.status != "connected":
                    if state.error is None:
                        state.error = MCPConnectionError(
                            f"MCP 服务 {safe_server} 连接或工具发现失败：{_safe_reason(error)}"
                            if state.released or state.client is None else
                            f"MCP 服务 {safe_server} 连接或工具发现失败，资源释放未确认"
                        )
                    state.status = "failed"
                    if self.on_change is not None and not callback_failed:
                        try:
                            self.on_change(server)
                        except Exception:
                            state.error = MCPConnectionError(
                                f"MCP 服务 {safe_server} 状态发布失败"
                            )
                elif not state.released:
                    state.status = "failed"
                    state.error = MCPConnectionError(
                        f"MCP 服务 {safe_server} 关闭失败：{_safe_reason(error)}"
                    )
                    raise state.error from None
            finally:
                state.ready.set()
        finally:
            _secrets.reset(token)
            if oauth_scope is not None:
                _secret_source.reset(oauth_scope)

    def _enable_logging(self) -> None:
        if not self._logging:
            global _logging_owners
            if _logging_owners == 0:
                logging.setLogRecordFactory(_safe_record)
            _logging_owners += 1
            self._logging = True

    def _release_logging(self) -> None:
        if self._logging:
            global _logging_owners
            _logging_owners -= 1
            if _logging_owners == 0 and logging.getLogRecordFactory() is _safe_record:
                logging.setLogRecordFactory(_log_factory)
            self._logging = False

    def _remember_orphan(self, server: str, state: _Service) -> None:
        owners = self._orphans.setdefault(server, [])
        if state not in owners:
            owners.append(state)
            logging.getLogger(__name__).warning(
                "MCP 服务 %s 旧连接释放未确认", _redact(server, _connection_secrets(state.connection)),
            )

    async def _retire(self, server: str, state: _Service) -> bool:
        state.stop.set()
        if state.task is not None and not state.ready.is_set():
            state.task.cancel()
        try:
            if state.task is not None:
                await asyncio.wait_for(asyncio.shield(state.task), self._cleanup_timeout)
        except TimeoutError:
            if state.task is not None and not state.task.done():
                state.task.cancel()
            self._remember_orphan(server, state)
        except asyncio.CancelledError:
            if asyncio.current_task().cancelling():
                raise
            # A cancelled owner has already settled; cancellation of this
            # retirement waiter must still propagate.
        except Exception as error:
            logging.getLogger(__name__).warning(
                "MCP 服务 %s 旧连接关闭异常：%s",
                _redact(server, _connection_secrets(state.connection)), _safe_reason(error),
            )
        confirmed = state.released or (state.client is None and state.task is not None
                                       and state.task.done())
        if not confirmed:
            self._remember_orphan(server, state)
        if self._services.get(server) is state:
            del self._services[server]
        return confirmed

    def release_confirmed(self, server: str) -> bool:
        state = self._services.get(server)
        return ((state is None or state.released or
                 (state.client is None and state.task is not None and state.task.done()))
                and all(owner.released or (owner.client is None and owner.task is not None
                                           and owner.task.done()) for owner in
                        self._orphans.get(server, ())))

    @staticmethod
    def _take_oauth_issue(state: _Service) -> OAuthIssue | None:
        issue, state.oauth_issue = state.oauth_issue, None
        return issue

    async def _authorize(self, server: str, state: _Service) -> None:
        """Refresh credentials before SDK entry so token failures cannot poison its task."""
        if state.generation is None:
            return
        try:
            await self.oauth.token(server, state.generation, state.connection["url"])
        except OAuthIssue as error:
            raise MCPConnectionError(str(error)) from None
        if (self._services.get(server) is not state or state.stop.is_set()
                or not self.oauth.authorized(server, state.generation, state.connection["url"])):
            raise MCPConnectionError(f"MCP 服务 {self._safe_server(server)} 需要重新授权")

    async def _invoke(self, server: str, name: str, generation: int | None,
                      original_url: str | None, arguments: dict) -> object:
        if generation is None and server in self.oauth_connectors:
            raise MCPCallError(f"MCP 服务 {self._safe_server(server)} 的旧工具已失效")
        if generation is not None and not self.oauth.authorized(server, generation, original_url):
            raise MCPCallError(f"MCP 服务 {self._safe_server(server)} 需要重新授权")
        try:
            active = self._services.get(server)
            desired = self._connection(server, active.connection if active is not None else None)
            state = await self._ensure(server, desired)
        except MCPConnectionError as error:
            raise MCPCallError(str(error)) from None
        except RuntimeError:
            raise MCPCallError(f"MCP 服务 {self._safe_server(server)} 当前不可用") from None
        secrets = _connection_secrets(state.connection)
        safe_server, safe_name = _redact(server, secrets), _redact(name, secrets)
        if state.generation != generation:
            raise MCPCallError(f"MCP 服务 {safe_server} 的旧工具已失效")
        try:
            await self._authorize(server, state)
        except MCPConnectionError as error:
            raise MCPCallError(str(error)) from None
        raw = state.raw_tools.get(name)
        if raw is None:
            raise MCPCallError(f"MCP 服务 {safe_server} 的工具 {safe_name} 已不再提供")
        token = _secrets.set(_secrets.get() + secrets)
        oauth_scope = _secret_source.set(
            lambda: self.oauth.secret_values(server),
        ) if generation is not None else None
        try:
            try:
                # MCP 2.1.1 shields courtesy cancellation on a blocked transport
                # write for up to five seconds before CancelledError propagates.
                # A request deadline can likewise settle up to call_timeout + 5s;
                # this bounds SDK cancellation, not the runtime's full resource cleanup.
                # The pool never replays this possibly executed tools/call.
                async with asyncio.timeout(self._call_timeout):
                    result = await raw.coroutine(**arguments)
                return _redact_content(
                    result, secrets + (oauth_secrets() if generation is not None else ()),
                )
            except ToolException as error:
                if generation is not None and (issue := self._take_oauth_issue(state)):
                    raise MCPCallError(str(issue)) from None
                # Convert while still holding the invoked owner's credentials:
                # another replacement may already be current by the time
                # LangChain handles this exception outside the coroutine.
                if not callable(raw.handle_tool_error):
                    raise MCPCallError(f"MCP 服务 {safe_server} 的工具 {safe_name} 返回错误") from None
                try:
                    content = raw.handle_tool_error(error)
                except GraphBubbleUp:
                    raise
                except Exception:
                    raise MCPCallError(
                        f"MCP 服务 {safe_server} 的工具 {safe_name} 错误处理失败"
                    ) from None
                raise ToolException(_redact_content(
                    content, secrets + (oauth_secrets() if generation is not None else ()),
                )) from None
            except GraphBubbleUp:
                raise
            except OAuthIssue as error:
                self._take_oauth_issue(state)
                raise MCPCallError(str(error)) from None
            except Exception as error:
                if generation is not None and (issue := self._take_oauth_issue(state)):
                    raise MCPCallError(str(issue)) from None
                if _transport_failed(error, state.client):
                    state.suspect = True
                raise MCPCallError(
                    f"MCP 服务 {safe_server} 的工具 {safe_name} 调用失败：{_safe_reason(error)}；"
                    "服务端可能已执行，结果未知；请先用查询类工具确认再决定是否重试"
                ) from None
        finally:
            _secrets.reset(token)
            if oauth_scope is not None:
                _secret_source.reset(oauth_scope)

    async def close_service(self, server: str) -> None:
        """Stop the current owner and confirm all retained owners for OAuth callers."""
        recovery = self._recoveries.get(server)
        if recovery is not None:
            recovery.cancel()
            await asyncio.gather(recovery, return_exceptions=True)
        state = self._services.get(server)
        if state is not None:
            await self._retire(server, state)
        if not self.release_confirmed(server):
            raise MCPCleanupError("MCP 连接释放未确认")
        # Only explicit closure (OAuth cutover), not recovery, forgets this snapshot.
        self._connections.pop(server, None)
        self._catalogs.pop(server, None)
        self._first_definitions.pop(server, None)
        if state is not None and self.on_change is not None:
            self.on_change(server)

    async def aclose(self) -> None:
        """Stop all owners, including retired unconfirmed owners, within a deadline."""
        if not self._closed:
            self._closed = True
            for recovery in self._recoveries.values():
                recovery.cancel()
            for state in self._services.values():
                state.stop.set()
                if not state.ready.is_set() and state.task is not None:
                    state.task.cancel()
        owners = list(self._services.values())
        for retired in self._orphans.values():
            owners.extend(retired)
        tasks = list(dict.fromkeys(
            [state.task for state in owners if state.task is not None]
            + list(self._recoveries.values())
        ))
        closing = asyncio.gather(*tasks, return_exceptions=True)
        cancelled = False
        deadline = asyncio.get_running_loop().time() + self._cleanup_timeout
        while not closing.done():
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                await asyncio.wait_for(asyncio.shield(closing), remaining)
            except asyncio.CancelledError:
                cancelled = True
            except TimeoutError:
                break
        if not closing.done():
            for task in tasks:
                if not task.done():
                    task.cancel()
            closing.add_done_callback(lambda _: self._release_logging())
            raise MCPCleanupError("MCP 连接清理超时，资源释放未确认")
        self._release_logging()
        if any(state.client is not None and not state.released for state in owners):
            raise MCPCleanupError("MCP 连接释放未确认")
        for result in closing.result():
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                raise MCPCleanupError(f"MCP 连接关闭失败：{_safe_reason(result)}") from None
        if cancelled:
            raise asyncio.CancelledError

def select_mcp_tools(
    role: AgentDefinition, by_server: Mapping[str, list[BaseTool]],
) -> tuple[list[BaseTool], dict[str, list[BaseTool]]]:
    """Expose direct tools as <service>_<tool>; searchable tools retain remote names."""
    direct = [
        tool.model_copy(update={"name": f"{server}_{tool.name}"})
        for server in role.mcp_servers for tool in by_server[server]
    ]
    names = [tool.name for tool in direct]
    if len(names) != len(set(names)):
        raise ValueError("所选连接器的工具名称冲突，请调整连接器选择")
    return direct, {server: by_server[server] for server in role.searchable_mcp_servers}


def _redact_content(value, secrets: tuple[str, ...]):
    """Preserve MCP content shape while stripping configured and OAuth credentials."""
    if isinstance(value, str):
        return _redact(value, secrets)
    if isinstance(value, bytes):
        return _redact(value.decode("utf-8", errors="backslashreplace"), secrets).encode()
    if isinstance(value, list):
        items = [_redact_content(item, secrets) for item in value]
        return value if all(a is b for a, b in zip(items, value)) else items
    if isinstance(value, tuple):
        items = tuple(_redact_content(item, secrets) for item in value)
        return value if all(a is b for a, b in zip(items, value)) else items
    if isinstance(value, dict):
        items = {_redact_content(key, secrets): _redact_content(item, secrets)
                 for key, item in value.items()}
        return value if all(key in value and value[key] is item for key, item in items.items()) else items
    return value


def _report_call_failures(
    tool: BaseTool, server: str, pool: MCPConnectionPool,
    generation: int | None, original_url: str | None, original_secrets: tuple[str, ...],
) -> BaseTool:
    """Keep a graph tool bound to its name and authorization generation, not a session."""

    async def coroutine(**arguments):
        token = _secrets.set(original_secrets)
        oauth_scope = _secret_source.set(
            lambda: pool.oauth.secret_values(server),
        ) if generation is not None else None
        try:
            return await pool._invoke(server, tool.name, generation, original_url, arguments)
        finally:
            _secrets.reset(token)
            if oauth_scope is not None:
                _secret_source.reset(oauth_scope)

    def handle_error(error: ToolException):
        # Ordinary remote errors have already been converted and redacted by
        # the invocation, preserving structured MCP error content.
        return str(error) if isinstance(error, MCPCallError) else error.args[0]

    return tool.model_copy(update={"coroutine": coroutine, "handle_tool_error": handle_error})
