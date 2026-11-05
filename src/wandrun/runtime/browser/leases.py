"""Task-owned Chrome leases, task-scoped CDP endpoints and human control.

A lease is allocated at the first WebSocket connection, not at command setup.
The per-generation discovery endpoint survives revocation to explain stale use;
only a newly issued command environment can select the next generation.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit
from urllib.request import urlopen

import websockets
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from wandrun.runtime.browser.cdp import BrowserRelay, CDPError, CDPRejected, CDPSocket
from wandrun.runtime.browser.human_input import HumanInputs, HumanInputUnknown

_log = logging.getLogger(__name__)
_STREAM_PROFILES = {"high": (75, 1600, 1000), "medium": (55, 1600, 1000),
                    "low": (40, 960, 600)}
_STREAM_FRAMES_IN_FLIGHT = 2  # Match the gateway's default displayed-ACK window.
_DISCOVERY_LIMIT = 0.8  # Leave headroom inside agent-browser's 2 s discovery deadline.


class _BrowserTransport(Protocol):
    """Own preparation and relays; never start Chrome or replay CDP.

    Controlled environment failures raise BrowserEnvironmentError so command
    setup stops instead of treating them as an absent Chrome.
    """

    async def browser_cdp_url(self) -> str: ...
    async def browser_command_environment(self, env: dict[str, str]) -> dict[str, str]: ...
    async def drain_browser_endpoint(self, url: str) -> None: ...
    async def close_browser_endpoint(self, url: str) -> None: ...


class UnknownBrowserTask(LookupError):
    """The lease id has never been allocated in this runtime."""


class BrowserRejected(ValueError):
    """The requested page, epoch or lifecycle operation is unavailable."""


class BrowserEnvironmentError(BrowserRejected):
    """Environment I/O was blocked; unlike Chrome absence, command setup must stop."""


@dataclass
class _Page:
    id: str
    cdp: CDPSocket
    title: str = ""
    url: str = ""
    revision: int = 0
    viewers: set[Callable[[dict], None]] = field(default_factory=set)
    # The high-quality source is shared. Lower tiers use independent CDP
    # sessions: screencast settings belong to a session, not a WebSocket frame.
    personal_streams: dict[Callable[[dict], None], tuple[str, CDPSocket]] = field(default_factory=dict)
    streaming: bool = False
    stream_operation: asyncio.Task | None = None
    latest_frame: dict | None = None
    initial_navigation: asyncio.Task | None = None


@dataclass
class _Lease:
    id: str
    task_id: str
    root_id: str
    agent_id: str
    entry_agent_id: str
    epoch: int = 1
    state: str = "agent"
    pages: dict[str, _Page] = field(default_factory=dict)
    # Includes pending popup attachments and retired target identities until
    # the whole lease closes. Discovery must not initialize those identities again.
    targets: set[str] = field(default_factory=set)
    # Rejected popups stay owned and cannot initialize, but discovery must still
    # close them until Chrome confirms their absence.
    rejected_popups: set[str] = field(default_factory=set)
    # The manager owns results after a requesting socket disappears.
    creating: set[asyncio.Task[str]] = field(default_factory=set)
    uncertain_creations: set[str] = field(default_factory=set)
    capacity_rejection: dict | None = None
    current: str | None = None
    history: list[str] = field(default_factory=list)
    reason: str | None = None
    requested_reason: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    clients: set[Any] = field(default_factory=set)
    relays: set[BrowserRelay] = field(default_factory=set)
    listeners: set[Callable[[dict], None]] = field(default_factory=set)
    last_activity: float = 0
    human_since: float | None = None
    mouse: dict[str, tuple[str, float, float]] = field(default_factory=dict)
    keys: dict[str, dict] = field(default_factory=dict)
    touching: str | None = None
    inputs: HumanInputs | None = None
    close_future: asyncio.Task | None = None
    # HTTP close replies may complete at target confirmation, before relay exit.
    close_responses: set[asyncio.Future] = field(default_factory=set)
    page_close_reason: str | None = None
    close_reason: str | None = None


@dataclass
class _Creation:
    """A reserved page becomes a target, never an additional unit of capacity."""

    lease: _Lease
    marker: str
    target: str | None = None
    settled: bool = False
    removed: bool = False
    ready: asyncio.Future[str] | None = None


@dataclass
class _Endpoint:
    task_id: str
    lease_id: str
    epoch: int
    server: Any
    port: int
    error: str | None = None
    notice_seen: bool = False
    acquiring: asyncio.Task | None = None
    waiting: int = 0
    reaper: asyncio.Task | None = None
    url: str = ""
    remote_closing: asyncio.Task | None = None
    closing: asyncio.Task | None = None
    responses: set[asyncio.Task] = field(default_factory=set)
    requests: set[asyncio.Task] = field(default_factory=set)
    drain_responses: bool = False


@dataclass
class _TaskResources:
    """Ownership survives revocation; registration only authorizes new work."""

    task_id: str
    identity: tuple[str, str, str]
    registered: bool = True
    endpoint: _Endpoint | None = None
    endpoints: list[_Endpoint] = field(default_factory=list)
    preparing: asyncio.Task | None = None
    closing: asyncio.Task | None = None
    lease: _Lease | None = None
    # Initial allocation is work in flight, not a task-count capacity reservation.
    admitting: bool = False


class BrowserLeases:
    """One environment's Chrome, one page budget and a single owner per task.

    All budget mutations are synchronous on this event loop, before Chrome I/O.
    Lease locks remain the write/revocation barrier; no global lock holds I/O.
    Uncertain creation and unconfirmed removal retain their budget entries.
    """

    def __init__(self, config: Any, *, on_event: Callable[[str, dict], None] | None = None,
                 notify: Callable[[str, str, bool], Awaitable[None]] | None = None,
                 clock: Callable[[], float] = time.monotonic, state_path: Path | None = None,
                 environment_id: str = "local", environment_name: str = "Local",
                 transport: _BrowserTransport | None = None):
        self.config = config
        self.environment_id = environment_id
        self.environment_name = environment_name
        self.transport = transport
        self.on_event = on_event
        self.notify = notify
        self.clock = clock
        self.state_path = Path(state_path) if state_path is not None else None
        self._tasks: dict[str, _TaskResources] = {}
        # Lookup/history index, not the cleanup inventory. Live resources are
        # reachable through their task record even after registration is revoked.
        self._leases: dict[str, _Lease] = {}
        self._live_targets: set[str] = set()
        self._retired_targets: set[str] = set()
        self._pending_removals: set[str] = set()
        self._creations: dict[str, _Creation] = {}
        self._last_capacity: dict | None = None
        self._closed = False
        self._chrome: CDPSocket | None = None
        self._initialization: asyncio.Task | None = None
        self._initialization_revision = 0
        self._browser_ws = ""
        self._base = ""
        self._idle_worker: asyncio.Task | None = None
        self._restart_reasons: dict[str, str] = {}
        self._version: dict | None = None
        self._discovery: asyncio.Task | None = None
        self._connection_revision = 0
        self._disconnecting: asyncio.Task | None = None

    async def _ensure_chrome(self) -> None:
        if self._closed:
            raise BrowserRejected("浏览器管理器已关闭")
        if self._disconnecting is not None:
            await asyncio.shield(self._disconnecting)
        previous = self._initialization
        if previous is not None and self._initialization_revision != self._connection_revision:
            # The old first-connect cleanup still owns its I/O. A new caller may
            # prepare a new connection only after that invalidated attempt settles.
            await asyncio.shield(asyncio.gather(previous, return_exceptions=True))
            if self._initialization is previous:
                self._initialization = None
        previous = self._initialization
        if previous is not None and previous.done() and (
                previous.cancelled() or previous.exception() is not None):
            # A vanished handshake can leave a failed owner-held attempt with
            # no waiter to retire it. A new explicit use must not replay its error.
            self._initialization = None
        if self._initialization is None:
            self._initialization = asyncio.create_task(self._connect_chrome())
            self._initialization_revision = self._connection_revision
            self._initialization.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)
        operation = self._initialization
        try:
            await asyncio.shield(operation)
        except BaseException:
            if operation.done() and self._initialization is operation:
                self._initialization = None
            raise

    async def _connect_chrome(self) -> None:
        """One shared barrier covers transport open AND inherited-page cleanup."""
        revision = self._connection_revision
        await self._discover_chrome()
        self._check_connection_revision(revision)
        chrome = CDPSocket(self._browser_ws, self._chrome_event)

        async def disconnected():
            if self._chrome is chrome:
                await self._chrome_disconnected()

        chrome.on_disconnect = disconnected
        self._chrome = chrome
        try:
            await chrome.open()
            self._check_connection_revision(revision)
            await chrome.call("Target.setDiscoverTargets", {"discover": True})
            before_census = set(self._live_targets)
            existing = (await chrome.call("Target.getTargets")).get("targetInfos", [])
            self._check_connection_revision(revision)
            alive = {info["targetId"] for info in existing if info.get("type") == "page"}
            for target in before_census - alive:
                self._forget_target(target)
            for info in existing:
                if info.get("type") == "page":
                    self._observe_target(info)
                    await self._close_target(info["targetId"])
                    self._check_connection_revision(revision)
            # A fresh transport's census and inherited-target cleanup are the
            # only way to settle unidentified creations after connection loss.
            for creation in tuple(self._creations.values()):
                if creation.settled:
                    creation.lease.uncertain_creations.discard(creation.marker)
                    self._creations.pop(creation.marker, None)
            self._capacity_changed()
            for owner in self._tasks.values():
                if owner.lease is not None and owner.lease.state == "stopping":
                    await self.close(owner.lease.id, owner.lease.close_reason or "Chrome 连接中断")
            self._check_connection_revision(revision)
        except BaseException:
            await chrome.close()
            if self._chrome is chrome:
                self._chrome = None
            if revision == self._connection_revision:
                self._version = None
                self._discovery = None
            raise

    def _check_connection_revision(self, revision: int) -> None:
        if revision != self._connection_revision:
            raise BrowserRejected("浏览器连接已中断，本次连接初始化未完成；请重新确认页面状态")

    def _unreachable(self, detail: str = "") -> BrowserRejected:
        action = ('请运行 python3 "$WANDRUN_BROWSER_START" 准备 agent-browser 与 Chrome 后再使用浏览器。'
                  if self.transport is not None else
                  "Local 外部 Chrome 不可达；请检查已启动的外部 Chrome 与 CDP 地址，不要运行启动脚本。")
        return BrowserRejected(f"Chrome 不可达；{action}" + (f"（{detail}）" if detail else ""))

    async def _discover_chrome(self) -> None:
        """Cache metadata per connection, with a bounded first HTTP reachability check."""
        if self._version is not None:
            return
        if self._discovery is None or self._discovery.done():
            self._discovery = asyncio.create_task(self._load_version())
            self._discovery.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)
        try:
            await asyncio.wait_for(asyncio.shield(self._discovery), _DISCOVERY_LIMIT)
        except BrowserRejected:
            raise
        except Exception as exc:
            raise self._unreachable(str(exc)) from exc

    async def _load_version(self) -> None:
        revision = self._connection_revision
        base = (await self.transport.browser_cdp_url() if self.transport is not None
                else self.config.cdp_url).rstrip("/")
        self._check_connection_revision(revision)
        self._base = base
        version = await self._fetch("/json/version", timeout=_DISCOVERY_LIMIT)
        self._check_connection_revision(revision)
        upstream = urlsplit(version["webSocketDebuggerUrl"])
        # Chrome advertises its sandbox port; the host must use its own SSH forward.
        authority = urlsplit(base).netloc if self.transport is not None else upstream.netloc
        self._browser_ws = upstream._replace(netloc=authority).geturl()
        self._version = {key: value for key, value in version.items()
                         if key not in ("devtoolsFrontendUrl", "webSocketDebuggerUrl")}

    async def start(self) -> None:
        if self.transport is None:
            await self._ensure_chrome()
        try:
            if self.state_path is not None and self.state_path.exists():
                saved = json.loads(self.state_path.read_text())
                for item in saved:
                    if item["state"] != "released":
                        item["epoch"] += 1
                        item["state"] = "released"
                        item["reason"] = "重启"
                    self._restart_reasons[item["task_id"]] = item["reason"]
                    self._leases[item["id"]] = _Lease(
                        item["id"], item["task_id"], item["root_id"], item["agent_id"],
                        item["entry_agent_id"], epoch=item["epoch"], state="released",
                        reason=item["reason"],
                    )
                self._save()
            self._idle_worker = asyncio.create_task(self._idle_loop())
        except BaseException:
            if self._chrome is not None:
                await self._chrome.close()
                self._chrome = None
            raise

    async def aclose(self) -> None:
        self._closed = True
        if self._idle_worker is not None:
            self._idle_worker.cancel()
            await asyncio.gather(self._idle_worker, return_exceptions=True)
        if self._disconnecting is not None:
            await asyncio.shield(self._disconnecting)
        if self._chrome is None and any(
                owner.lease is not None and owner.lease.state != "released"
                for owner in self._tasks.values()):
            self._initialization = asyncio.create_task(self._connect_chrome())
            self._initialization_revision = self._connection_revision
        if self._initialization is not None:
            await asyncio.gather(self._initialization, return_exceptions=True)
        if self._discovery is not None and not self._discovery.done():
            self._discovery.cancel()
            await asyncio.gather(self._discovery, return_exceptions=True)
        failures = []
        for owner in self._tasks.values():
            try:
                await self.close_task(owner.task_id, reason="重启")
            except Exception as exc:
                failures.append(exc)
        # Keep the confirmation transport available after a failed shutdown:
        # unconfirmed owners remain in the ledger and aclose can retry.
        if failures:
            raise ExceptionGroup("浏览器资源关闭未确认", failures)
        if self._chrome is not None:
            await self._chrome.close()

    def register(self, task_id: str, root_id: str, agent_id: str, entry_agent_id: str) -> None:
        if self._closed:
            raise BrowserRejected("浏览器管理器已关闭")
        identity = (root_id, agent_id, entry_agent_id)
        owner = self._tasks.get(task_id)
        if owner is None:
            self._tasks[task_id] = _TaskResources(task_id, identity)
        else:
            if owner.identity != identity:
                raise BrowserRejected("任务的浏览器所有者不能改变")
            if owner.closing is not None and not owner.closing.done():
                raise BrowserRejected("任务浏览器仍在关闭")
            owner.registered = True

    def pending_tasks(self, agent_id: str) -> list[str]:
        """Return tasks whose browser resources still prevent a Backend switch.

        This is an in-memory ownership query, not a Chrome health check. Merely
        registering a task owns nothing. Endpoints remain blockers even after
        server.close(): only confirmed wait_closed removes them from inventory.
        Revoked registrations and stopping leases retain their cleanup debt.
        """
        return [
            owner.task_id for owner in self._tasks.values()
            if owner.identity[1] == agent_id and (
                owner.lease is not None and owner.lease.state != "released"
                or owner.admitting
                or any(operation is not None and not operation.done()
                       for operation in (owner.preparing, owner.closing))
                or owner.endpoint is not None or bool(owner.endpoints)
            )
        ]

    async def revoke_idle_endpoints(self, agent_id: str) -> None:
        """Locally retire page-less CLI access before considering a Backend switch.

        An allocated lease or in-flight preparation/admission is never cancelled.
        All eligible listeners are fenced before yielding; a concurrent command
        can obtain a fresh endpoint, which the caller's final inventory must catch.
        Failed close confirmation keeps the endpoint in the ownership inventory.
        """
        endpoints = []
        for owner in self._tasks.values():
            if (owner.identity[1] != agent_id
                    or owner.lease is not None and owner.lease.state != "released"
                    or owner.admitting
                    or any(operation is not None and not operation.done()
                           for operation in (owner.preparing, owner.closing))
                    or any(endpoint.waiting or endpoint.acquiring is not None
                           and not endpoint.acquiring.done() for endpoint in owner.endpoints)):
                continue
            for endpoint in owner.endpoints:
                endpoint.error = "Backend 切换，空闲浏览器接入已撤销"
                endpoint.server.close()
                if endpoint.reaper is not None:
                    endpoint.reaper.cancel()
                endpoints.append(endpoint)
        failures = []
        for endpoint in endpoints:
            try:
                if endpoint.reaper is not None:
                    await asyncio.gather(endpoint.reaper, return_exceptions=True)
                await self._close_endpoint(endpoint)
            except Exception as error:
                failures.append(error)
        if failures:
            raise BrowserRejected("空闲浏览器接入关闭未确认，不能切换 Backend") from failures[0]

    async def command_environment(self, task_id: str) -> dict[str, str]:
        owner = self._tasks.get(task_id)
        if owner is None or not owner.registered or self._closed:
            raise BrowserRejected("任务没有可用的浏览器")
        # The manager, not a cancelled shell invocation, owns endpoint creation.
        if owner.preparing is None or owner.preparing.done():
            owner.preparing = asyncio.create_task(self._command_environment(owner))
            owner.preparing.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)
        return await asyncio.shield(owner.preparing)

    async def _command_environment(self, owner: _TaskResources) -> dict[str, str]:
        if (self.transport is None or owner.lease is not None
                and owner.lease.close_reason is not None and owner.lease.state != "released"):
            try:
                await self._ensure_chrome()
            except BrowserEnvironmentError:
                # A recovery barrier must not become permission to run the shell.
                raise
            except (BrowserRejected, CDPError, OSError, websockets.WebSocketException):
                # A shell must still be able to diagnose an external Chrome failure.
                pass
        if not owner.registered or self._closed:
            raise BrowserRejected("任务没有可用的浏览器")
        active = owner.lease
        if (self._chrome is not None and active is not None
                and active.close_reason is not None and active.state != "released"):
            await self.close(active.id, active.close_reason)
        endpoint = owner.endpoint
        lease = self._leases.get(endpoint.lease_id) if endpoint else None
        acknowledged = endpoint is not None and endpoint.error and endpoint.notice_seen
        if acknowledged:
            self._restart_reasons.pop(owner.task_id, None)
        if (acknowledged or endpoint is None or not endpoint.server.is_serving()
                or endpoint.remote_closing is not None or (lease is not None and (
                    lease.state == "released" or lease.state in ("agent", "requested")
                    and endpoint.epoch != lease.epoch))):
            if endpoint is not None:
                self._retire(endpoint)
            active = owner.lease
            active = active if active is not None and active.state != "released" and not acknowledged else None
            endpoint = await self._serve(owner.task_id, active.id if active else uuid.uuid4().hex,
                                         active.epoch if active else 1)
            owner.endpoint = endpoint
            reason = self._restart_reasons.get(owner.task_id)
            if reason:
                endpoint.error = f"上次浏览器租约已结束（{reason}），请重新确认页面状态"
        env = {"WANDRUN_BROWSER_CDP": endpoint.url,
               "AGENT_BROWSER_SESSION": f"wandrun-{endpoint.lease_id}-{endpoint.epoch}",
               "AGENT_BROWSER_IDLE_TIMEOUT_MS": "120000"}
        if self.transport is not None:
            revision = self._connection_revision
            try:
                env = await self.transport.browser_command_environment(env)
            except BaseException:
                if revision != self._connection_revision:
                    endpoint.remote_closing = None
                    await self._close_endpoint(endpoint)
                raise
            if not owner.registered or self._closed or revision != self._connection_revision:
                # Disconnection can settle an old relay before preparation publishes
                # its replacement. Close that late result; never restore its address.
                endpoint.remote_closing = None
                await self._close_endpoint(endpoint)
                raise BrowserRejected("任务浏览器接入已撤销，请重新取得命令环境")
        return env

    def _retire(self, endpoint: _Endpoint) -> None:
        # Local stale discovery keeps its existing daemon grace. Remote entries
        # stop immediately; their cleanup record survives the same grace so an
        # unconfirmed exec can still be settled without owning the next lease.
        if endpoint.reaper is None:
            endpoint.reaper = asyncio.create_task(self._reap_endpoint(endpoint))
            endpoint.reaper.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)

    async def _reap_endpoint(self, endpoint: _Endpoint) -> None:
        try:
            await self._close_remote_endpoint(endpoint)
        except Exception:
            _log.warning("Retired browser relay cleanup unconfirmed: %s", endpoint.url, exc_info=True)
            if self.notify and self._tasks[endpoint.task_id].registered:
                try:
                    await self.notify(endpoint.task_id,
                        "旧浏览器入口的转发清理尚未确认，后台仍保留清理责任；"
                        "这不代表页面关闭失败。如需继续，可重新取得命令环境并显式打开页面。", False)
                except Exception:
                    _log.warning("Cannot report browser relay cleanup to task %s",
                                 endpoint.task_id, exc_info=True)
        await asyncio.sleep(180)
        try:
            await self._close_endpoint(endpoint)
        except Exception:
            _log.warning("Retired browser endpoint cleanup still unconfirmed: %s",
                         endpoint.url, exc_info=True)

    async def _close_remote_endpoint(self, endpoint: _Endpoint) -> None:
        if self.transport is None:
            return
        if (endpoint.remote_closing is None or endpoint.remote_closing.done()
                and endpoint.remote_closing.exception() is not None):
            endpoint.remote_closing = asyncio.create_task(self._finish_remote_endpoint(endpoint))
            endpoint.remote_closing.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)
        await asyncio.shield(endpoint.remote_closing)

    async def _finish_remote_endpoint(self, endpoint: _Endpoint) -> None:
        try:
            # Revoke admission before touching accepted sockets. connections only
            # contains OPEN WebSockets, not idle TCP or incomplete handshakes.
            endpoint.server.close(close_connections=False)
            await asyncio.gather(*(client.close(1008, "浏览器租约已关闭")
                                   for client in tuple(endpoint.server.connections)))
            if endpoint.drain_responses:
                # Let the final HTTP response leave its host socket first.
                async with asyncio.timeout(3):
                    await asyncio.gather(*(asyncio.shield(task) for task in tuple(endpoint.responses)))
            endpoint.server.server.close_clients()
            if endpoint.drain_responses:
                await self.transport.drain_browser_endpoint(endpoint.url)
        finally:
            # A failed drain must still use independent TERM + real exit status.
            await self.transport.close_browser_endpoint(endpoint.url)

    async def _close_endpoint(self, endpoint: _Endpoint) -> None:
        if (endpoint.closing is None or endpoint.closing.done()
                and endpoint.closing.exception() is not None):
            endpoint.closing = asyncio.create_task(self._finish_endpoint(endpoint))
            endpoint.closing.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)
        await asyncio.shield(endpoint.closing)

    async def _finish_endpoint(self, endpoint: _Endpoint) -> None:
        try:
            await self._close_remote_endpoint(endpoint)
        finally:
            endpoint.server.close()
            await asyncio.wait_for(endpoint.server.wait_closed(), 3)
        owner = self._tasks[endpoint.task_id]
        if endpoint in owner.endpoints:
            owner.endpoints.remove(endpoint)
        if owner.endpoint is endpoint:
            owner.endpoint = None

    async def _serve(self, task_id: str, lease_id: str, epoch: int) -> _Endpoint:
        endpoint = _Endpoint(task_id, lease_id, epoch, None, 0)

        async def process(connection, request):
            try:
                authority = self._loopback_authority(request.headers["Host"])
            except (KeyError, ValueError):
                return self._http(400, {"error": "浏览器发现 Host 必须是回环 authority"})
            websocket = request.headers.get("Upgrade", "").lower() == "websocket"
            lease = self._leases.get(lease_id)
            reason = endpoint.error or self._stale_reason(endpoint, lease)
            path = request.path.split("?", 1)[0].rstrip("/")
            if websocket:
                if reason:
                    return None  # Existing daemons receive their epoch error as CDP.
                opening = asyncio.create_task(self._ensure_chrome())
                disconnected = asyncio.create_task(connection.wait_closed())
                try:
                    done, _ = await asyncio.wait((opening, disconnected),
                                                 return_when=asyncio.FIRST_COMPLETED)
                    if disconnected in done:
                        # Cancel only this handshake's waiter, never the shared
                        # initialization. A dead socket cannot receive HTTP errors.
                        raise asyncio.CancelledError
                    await opening
                except (BrowserRejected, CDPError, OSError, websockets.WebSocketException) as exc:
                    if endpoint.error:
                        return self._http(409, {"error": endpoint.error})
                    # Native CLI clients discard HTTP rejection bodies. Complete
                    # the handshake, then report the cause on their first CDP call.
                    connection._wandrun_browser_error = (
                        str(exc) if isinstance(exc, BrowserRejected) else str(self._unreachable(str(exc))))
                finally:
                    opening.cancel()
                    disconnected.cancel()
                    await asyncio.gather(opening, disconnected, return_exceptions=True)
                return None
            if path == "/json/wandrun/status":
                owner = self._tasks.get(task_id)
                if (self._closed or owner is None or not owner.registered
                        or owner.endpoint is not endpoint):
                    return self._http(409, {"error": "任务接入已撤销或旧浏览器会话已失效"})
                # Snapshot only: no Chrome I/O, admission, notice consumption or
                # activity refresh. A fenced generation still reports its own
                # human/stopping state, but keeps the normal 409 access verdict.
                status = {
                    "state": lease.state if lease is not None else "unallocated",
                    "pages_used": len(lease.pages) if lease is not None else 0,
                    "environment_id": self.environment_id,
                    "environment_name": self.environment_name,
                    "capacity": self.capacity(),
                    "reason": (lease.close_reason or lease.reason) if lease is not None
                    else self._restart_reasons.get(task_id),
                }
                if reason:
                    status["error"] = reason
                return self._http(409 if reason else 200, status)
            if reason and path != "/json/version":
                return self._http(409, {"error": reason})
            if path == "/json/version":
                error = None
                if not reason:
                    try:
                        await self._discover_chrome()
                    except BrowserRejected as exc:
                        error = str(exc)
                version = dict(self._version or {"Browser": "Wandrun", "Protocol-Version": "1.3"})
                version["webSocketDebuggerUrl"] = f"ws://{authority}/devtools/browser/{lease_id}"
                if error is not None:
                    version["error"] = error
                return self._http(503 if error is not None else 200, version)
            if path in ("/json", "/json/list"):
                try:
                    await self._discover_chrome()
                    targets = await self._fetch("/json/list")
                except (BrowserRejected, OSError) as exc:
                    return self._http(503, {"error": str(self._unreachable(str(exc)))})
                return self._http(200, [{**{k: v for k, v in t.items()
                                           if k != "devtoolsFrontendUrl"}, "webSocketDebuggerUrl":
                    f"ws://{authority}/devtools/page/{t['id']}"}
                    for t in targets if lease is not None and t["id"] in lease.pages])
            if path.startswith("/json/close/") and lease is not None:
                target = path.removeprefix("/json/close/")
                ready = asyncio.get_running_loop().create_future()
                response = asyncio.create_task(connection.wait_closed())
                endpoint.responses.add(response)
                response.add_done_callback(endpoint.responses.discard)
                endpoint.drain_responses = True
                closing = asyncio.create_task(self.close_page(
                    lease.id, target, reason="Agent 关闭", expected_epoch=endpoint.epoch,
                    _response_ready=ready))
                endpoint.requests.add(closing)

                def settled(operation):
                    endpoint.requests.discard(operation)
                    if not operation.cancelled():
                        operation.exception()  # The lease retains and reports cleanup failures.

                closing.add_done_callback(settled)
                try:
                    await asyncio.wait((ready, closing), return_when=asyncio.FIRST_COMPLETED)
                    if not ready.done():
                        await asyncio.shield(closing)
                except BrowserRejected as exc:
                    return self._http(409, {"error": str(exc)})
                finally:
                    ready.cancel()  # Never cancel the owner-held close operation.
                return self._http(200, {"closed": target})
            return self._http(404, {"error": "没有该 CDP 路径"})

        async def handle(client):
            lease = self._leases.get(lease_id)
            startup_error = getattr(client, "_wandrun_browser_error", None)
            reason = startup_error or endpoint.error or self._stale_reason(endpoint, lease)
            if reason:
                if startup_error is None:
                    endpoint.notice_seen = True
                await self._explain(client, reason)
                return
            path = client.request.path.split("?", 1)[0]
            if path != f"/devtools/browser/{lease_id}" and not (
                lease is not None and path.startswith("/devtools/page/")
                and path.rsplit("/", 1)[-1] in lease.pages
            ):
                await client.close(1008, "页面不属于本租约或没有该 CDP 路径")
                return
            endpoint.waiting += 1
            disconnected = asyncio.create_task(client.wait_closed())
            try:
                if endpoint.acquiring is None:
                    endpoint.acquiring = asyncio.create_task(self._acquire(endpoint))
                    endpoint.acquiring.add_done_callback(
                        lambda task: task.exception() if not task.cancelled() else None)
                done, _ = await asyncio.wait((endpoint.acquiring, disconnected),
                                             return_when=asyncio.FIRST_COMPLETED)
                if disconnected in done:
                    return
                lease = await endpoint.acquiring
            except BrowserRejected as exc:
                endpoint.error = str(exc)
                endpoint.notice_seen = True
                await self._explain(client, str(exc))
                return
            finally:
                endpoint.waiting -= 1
                if (endpoint.waiting == 0 and endpoint.acquiring is not None
                        and endpoint.acquiring.done() and lease_id not in self._leases):
                    # Cleanup confirmed no resources remain. Failed allocation
                    # is not a permanent task identity; the next connect retries.
                    endpoint.acquiring = None
                    endpoint.error = None
                disconnected.cancel()
                await asyncio.gather(disconnected, return_exceptions=True)
            if path == f"/devtools/browser/{lease_id}":
                page = None
                upstream = self._browser_ws
            else:
                page = path.rsplit("/", 1)[-1]
                upstream = self._page_ws(page)
            lease.clients.add(client)
            def authorize(method: str, params: dict) -> str | None:
                if (lease.close_reason is not None or lease.state not in ("agent", "requested")
                        or endpoint.epoch != lease.epoch):
                    return f"浏览器控制权已收回（{lease.state}，{lease.reason or '用户接管'}）"
                return None
            def create(params: dict) -> asyncio.Future[str]:
                ready = asyncio.get_running_loop().create_future()
                ready.add_done_callback(lambda result: result.exception() if not result.cancelled() else None)
                self._start_page(lease, params.get("url", "about:blank"), ready=ready)
                return ready
            relay = BrowserRelay(client, upstream, epoch=endpoint.epoch, page=page,
                                 owns=lambda target: target in lease.pages, guard=lease.lock,
                                 authorize=authorize, create=create, close_target=self._close_target,
                                 claim=self._claim_popup,
                                 activated=lambda target: self._activate_page(lease, target),
                                 destroyed=lambda target: self._target_destroyed(target),
                                 activity=lambda: self._activity(lease))
            lease.relays.add(relay)
            try:
                await relay.run()
            finally:
                lease.clients.discard(client)
                if not relay.unsettled:
                    lease.relays.discard(relay)

        # An idle native CLI daemon may not acknowledge Close. Revocation already
        # fences writes; bound transport teardown so HTTP final-page close can reply.
        server = await serve(handle, "127.0.0.1", 0, process_request=process,
                             max_size=None, close_timeout=1)
        endpoint.server = server
        self._tasks[task_id].endpoints.append(endpoint)
        endpoint.port = server.sockets[0].getsockname()[1]
        endpoint.url = f"http://127.0.0.1:{endpoint.port}"
        return endpoint

    @staticmethod
    def _loopback_authority(authority: str) -> str:
        parsed = urlsplit("//" + authority)
        if (not authority or any(char.isspace() for char in authority)
                or parsed.path or parsed.query or parsed.fragment
                or parsed.username is not None or parsed.password is not None
                or parsed.hostname is None or authority.endswith(":")):
            raise ValueError("Host 不是 authority")
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError("Host 端口无效")
        if parsed.hostname.lower() != "localhost" and not ipaddress.ip_address(parsed.hostname).is_loopback:
            raise ValueError("Host 不是回环地址")
        return authority

    @staticmethod
    async def _explain(client: Any, reason: str) -> None:
        try:
            raw = await asyncio.wait_for(client.recv(), 3)
            request = json.loads(raw)
            if isinstance(request, dict) and "id" in request:
                await client.send(json.dumps({"id": request["id"],
                    "error": {"code": -32000, "message": reason}}, ensure_ascii=False))
        except (TimeoutError, ValueError, TypeError, websockets.ConnectionClosed):
            pass
        await client.close(1008)

    @staticmethod
    def _http(status: int, data: Any) -> Response:
        body = json.dumps(data, ensure_ascii=False).encode()
        return Response(status, "OK" if status == 200 else "Error",
                        Headers({"Content-Type": "application/json", "Content-Length": str(len(body))}), body)

    def _stale_reason(self, endpoint: _Endpoint, lease: _Lease | None) -> str | None:
        if lease is not None and (lease.state not in ("agent", "requested") or endpoint.epoch != lease.epoch):
            return f"浏览器租约已{lease.state}：{lease.reason or '控制权已转交'}"
        owner = self._tasks.get(endpoint.task_id)
        if owner is None or not owner.registered:
            return "任务结束，浏览器接入已撤销"
        if lease is None and owner.endpoint is not endpoint:
            return "旧浏览器会话已失效，请使用新的命令会话"
        return None

    async def _acquire(self, endpoint: _Endpoint) -> _Lease:
        try:
            await self._ensure_chrome()
        except (CDPError, OSError, websockets.WebSocketException) as exc:
            raise self._unreachable(str(exc)) from exc
        owner = self._tasks[endpoint.task_id]
        if not owner.registered or self._closed:
            raise BrowserRejected("任务结束，浏览器接入已撤销")
        lease = self._leases.get(endpoint.lease_id)
        if lease is not None:
            if lease.state not in ("agent", "requested") or endpoint.epoch != lease.epoch:
                raise BrowserRejected(self._stale_reason(endpoint, lease) or "旧代际已失效")
            return lease
        self._check_capacity()
        root, agent, entry = owner.identity
        lease = _Lease(endpoint.lease_id, endpoint.task_id, root, agent, entry,
                       last_activity=self.clock())
        self._leases[lease.id] = lease
        owner.lease = lease
        owner.admitting = True
        try:
            async with lease.lock:
                creation = self._start_page(lease, "about:blank")
            await asyncio.shield(creation)
            if not owner.registered or lease.close_reason is not None:
                raise BrowserRejected("任务结束，浏览器分配已取消")
            owner.admitting = False
            self._emit(lease)
            return lease
        except BaseException as exc:
            owner.admitting = False
            await self.close(lease.id, f"浏览器分配失败：{exc}")
            if owner.registered:
                self._leases.pop(endpoint.lease_id, None)
                owner.lease = None
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise BrowserRejected(f"浏览器分配失败：{exc}") from exc

    def _capacity_error(self) -> str:
        return f"环境 {self.environment_name} 的浏览器页面总数已达上限（{self.config.max_pages}），请先关闭页面"

    def _check_capacity(self, *, existing_target: str | None = None) -> None:
        # An observed popup already consumes one unit; claiming it is a transfer.
        used = self.capacity()["pages_used"] - int(existing_target in self._live_targets)
        if used >= self.config.max_pages:
            raise BrowserRejected(self._capacity_error())

    def _start_page(self, lease: _Lease, url: str, *, info: dict | None = None,
                    ready: asyncio.Future[str] | None = None) -> asyncio.Task[str]:
        """Reserve before I/O; ready publishes ownership, not website readiness.

        The returned worker still owns initial navigation through settlement, so
        takeover and closure cannot abandon it after a CDP createTarget reply.
        """
        if lease.close_reason is not None or lease.state in ("stopping", "released"):
            raise BrowserRejected("浏览器正在关闭或已结束，无法新建页面")
        self._check_capacity(existing_target=info["targetId"] if info else None)
        marker = "about:blank#wandrun-" + uuid.uuid4().hex
        creation = _Creation(lease, marker, info["targetId"] if info else None, ready=ready)
        self._creations[marker] = creation
        if info:
            self._live_targets.add(creation.target)
        operation = asyncio.create_task(self._new_page(lease, url, creation, info=info))
        lease.creating.add(operation)
        self._capacity_changed()

        def settled(task: asyncio.Task[str]) -> None:
            lease.creating.discard(task)
            creation.settled = True
            error = task.exception() if not task.cancelled() else None
            if ready is not None and not ready.done():
                if task.cancelled():
                    ready.cancel()
                elif error is not None:
                    ready.set_exception(error)
                else:
                    ready.set_result(task.result())
            if marker not in lease.uncertain_creations or creation.removed:
                lease.uncertain_creations.discard(marker)
                self._creations.pop(marker, None)
            self._capacity_changed()

        operation.add_done_callback(settled)
        return operation

    async def _new_page(self, lease: _Lease, url: str, creation: _Creation, *,
                        info: dict | None = None) -> str:
        """Create with an identifiable blank URL, then navigate the owned page.

        Discovery may precede the reply or the reply may be lost. The marker
        binds that target to its existing reservation without guessing by URL
        or stealing an unrelated external page. It is never sent to a website.
        """
        try:
            target = info["targetId"] if info else (
                await self._chrome.call("Target.createTarget", {"url": creation.marker}, timeout=None)
            )["targetId"]
        except CDPRejected:
            self._creations.pop(creation.marker, None)
            raise
        except BaseException:
            lease.uncertain_creations.add(creation.marker)
            raise
        if creation.removed:
            raise CDPRejected("新建页面在初始化前已关闭")
        creation.target = target
        self._live_targets.add(target)
        lease.targets.add(target)
        self._capacity_changed()

        navigation_events: asyncio.Queue[dict | None] = asyncio.Queue()
        initializing = info is None

        async def on_event(message: dict):
            if initializing and message.get("method") in (
                    "Page.frameNavigated", "Page.navigatedWithinDocument"):
                navigation_events.put_nowait(message)
            await self._page_event(lease.id, target, message)

        cdp = CDPSocket(self._page_ws(target), on_event)

        async def disconnected():
            if initializing:
                navigation_events.put_nowait(None)

        cdp.on_disconnect = disconnected
        try:
            await cdp.open()
            await cdp.call("Page.enable")
            await cdp.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
        except BaseException as exc:
            await cdp.close()
            try:
                await self._close_target(target)
            except Exception as cleanup_error:
                async with lease.lock:
                    lease.pages[target] = _Page(target, cdp)
                    lease.state = "stopping"
                    lease.reason = f"页面清理未确认：{cleanup_error}"
                    lease.close_reason = f"浏览器页面初始化失败：{exc}"
                    self._emit(lease)
                raise BrowserRejected(lease.reason) from exc
            raise
        async with lease.lock:
            page = _Page(target, cdp, info.get("title", "") if info else "",
                         info.get("url", url) if info else url)
            if info is None:
                page.initial_navigation = asyncio.current_task()
            lease.pages[target] = page
            if lease.current is None:
                lease.current = target
                lease.history.append(target)
            self._emit(lease)
            if creation.ready is not None and not creation.ready.done():
                creation.ready.set_result(target)
        if info is None:
            def stopped():
                return (creation.removed or target in self._pending_removals
                        or lease.close_reason is not None or lease.pages.get(target) is not page)

            def before_send():
                if stopped():
                    raise CDPRejected("页面正在关闭，初始导航未发送")

            error = None
            unknown = None
            try:
                navigation = await cdp.call("Page.navigate", {"url": url},
                                            timeout=None, before_send=before_send)
                error = navigation.get("errorText")
                if not error and not navigation.get("isDownload"):
                    # Creation was already published. This owner-held settlement,
                    # unlike that result, still observes document commitment.
                    while True:
                        event = await navigation_events.get()
                        if event is None:
                            raise CDPError("初始导航提交前 CDP 连接已断开")
                        params = event.get("params", {})
                        frame = params.get("frame", {})
                        if navigation.get("loaderId"):
                            committed = (not frame.get("parentId")
                                         and frame.get("loaderId") == navigation["loaderId"])
                        else:
                            committed = (
                                event["method"] == "Page.navigatedWithinDocument"
                                and params.get("url") == url
                            ) or not frame.get("parentId") and frame.get("url") == url
                        if committed:
                            break
                    # frameNavigated can precede Chrome's active-frame handoff.
                    # A renderer round trip settles that handoff before close
                    # can send Target.closeTarget; otherwise Chrome may lose its
                    # close IPC when the old RenderFrameHost is destroyed.
                    await cdp.call("Runtime.evaluate", {"expression": "void 0"}, timeout=None)
            except CDPRejected as exc:
                error = str(exc)
            except (CDPError, OSError, websockets.WebSocketException) as exc:
                error, unknown = str(exc), exc
            finally:
                initializing = False
            if error and not stopped():
                if unknown is not None:
                    lease.uncertain_creations.add(creation.marker)
                outcome = "导航结果未确认" if unknown is not None else "导航失败"
                text = f"浏览器页面已创建（{target}），但{outcome}：{error}"
                # Navigation failure does not undo page ownership.
                # Control notifications are reserved for takeover / handback.
                _log.warning("%s", text)
                if unknown is not None:
                    raise unknown
        return target

    def _page_ws(self, target: str) -> str:
        parsed = urlsplit(self._browser_ws)
        return f"{parsed.scheme}://{parsed.netloc}/devtools/page/{target}"

    async def _fetch(self, path: str, *, timeout: float = 5) -> Any:
        def fetch():
            with urlopen(self._base + path, timeout=timeout) as response:
                return json.load(response)
        return await asyncio.to_thread(fetch)

    def _observe_target(self, info: dict) -> bool:
        """Unify event/census discovery and reservation-to-target identity transfer."""
        if info.get("type") != "page" or info["targetId"] in self._retired_targets:
            return False
        target = info["targetId"]
        self._live_targets.add(target)
        creation = self._creations.get(info.get("url"))
        if creation is not None:
            creation.target = target
            creation.lease.targets.add(target)
        self._capacity_changed()
        return True

    async def _chrome_event(self, message: dict) -> None:
        method, params = message.get("method"), message.get("params", {})
        if method in ("Target.targetCreated", "Target.targetInfoChanged"):
            info = params["targetInfo"]
            if not self._observe_target(info):
                return
            await self._claim_popup(info)
            target = info["targetId"]
            lease = next((item for item in self._leases.values() if target in item.pages), None)
            if lease is not None:
                page = lease.pages[target]
                title, url = info.get("title", ""), info.get("url", "")
                if (page.title, page.url) != (title, url):
                    page.title, page.url = title, url
                    self._emit(lease)
        elif method == "Target.targetDestroyed":
            await self._target_destroyed(params["targetId"])

    async def _claim_popup(self, info: dict) -> None:
        if info.get("type") != "page" or not info.get("openerId"):
            return
        lease = next((item for item in self._leases.values()
                      if info["openerId"] in item.targets), None)
        if lease is None:
            return
        target = info["targetId"]
        if target in self._retired_targets:
            return
        async with lease.lock:
            if lease.state == "released":
                return  # Closure's target census has already confirmed absence.
            # Identity prevents repeat attachment, not outstanding cleanup.
            # Keep rejected popups eligible for closure even if capacity frees.
            if target in lease.targets and target not in lease.rejected_popups:
                return
            lease.targets.add(target)
            over_limit = self.capacity()["pages_used"] - int(target in self._live_targets) >= self.config.max_pages
            if (target in lease.rejected_popups or lease.close_reason is not None
                    or over_limit):
                lease.rejected_popups.add(target)
                self._live_targets.add(target)
                if over_limit:
                    # Target identity deduplicates cleanup retries, not later rejected popups.
                    lease.capacity_rejection = {"id": target, "reason": f"弹出页面已拒绝：{self._capacity_error()}"}
                self._emit(lease)
                await self._close_target(target)
                lease.rejected_popups.discard(target)
                self._emit(lease)
                return
            creation = self._start_page(lease, info.get("url", "about:blank"), info=info)
        await asyncio.shield(creation)

    async def _page_event(self, lease_id: str, target: str, message: dict) -> None:
        lease = self._leases.get(lease_id)
        page = lease.pages.get(target) if lease else None
        if page is None:
            return
        method, params = message.get("method"), message.get("params", {})
        if method == "Page.frameNavigated" and not params.get("frame", {}).get("parentId"):
            page.revision += 1
            page.latest_frame = None
            if lease.inputs is not None:
                lease.inputs.settle("vp", target=target)
            self._emit(lease)
            # Independently encoded viewers must not tag a pre-navigation JPEG
            # with the new revision. Replace their CDP sessions at the boundary.
            async with lease.lock:
                await self._restart_personal_streams(lease, page)
        elif method == "Page.screencastFrame":
            # Queue ACK independently: transport backpressure must not delay navigation.
            page.cdp.notify("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
            tagged = {**params, "_epoch": lease.epoch, "_revision": page.revision,
                      "_quality_tier": "high"}
            page.latest_frame = tagged
            for callback in tuple(page.viewers):
                try:
                    callback(tagged)
                except Exception:
                    page.viewers.discard(callback)

    async def _activate_page(self, lease: _Lease, target: str) -> None:
        async with lease.lock:
            if target in lease.pages and lease.current != target:
                lease.current = target
                lease.history = [t for t in lease.history if t != target] + [target]
                self._emit(lease)

    async def _remove_page_locked(self, lease: _Lease, target: str) -> str | None:
        """Retire a confirmed-gone target; only an empty non-human lease closes."""
        page = lease.pages.get(target)
        if page is None:
            return None
        await self._dispose_page(page)
        lease.pages.pop(target)
        lease.history = [t for t in lease.history if t != target]
        if lease.current == target:
            lease.current = lease.history[-1] if lease.history else next(reversed(lease.pages), None)
        should_close = (not lease.pages and lease.state not in ("human", "released")
                        and not self._tasks[lease.task_id].admitting)
        reason = lease.close_reason or lease.page_close_reason or "最后一张页面已关闭"
        if should_close:
            lease.close_reason = reason
        self._emit(lease)
        return reason if should_close else None

    async def _target_destroyed(self, target: str) -> None:
        self._forget_target(target)
        lease = next((item for item in self._leases.values() if target in item.targets), None)
        if lease is None:
            return
        if lease.inputs is not None:
            lease.inputs.stopped_pages.add(target)
            lease.inputs.settle("page", target=target).add_done_callback(
                lambda _: lease.inputs.stopped_pages.discard(target))
        async with lease.lock:
            lease.rejected_popups.discard(target)
            reason = await self._remove_page_locked(lease, target)
        if reason is not None and (lease.close_future is None or lease.close_future.done()):
            await self.close(lease.id, reason=reason)

    def _snapshot(self, lease: _Lease) -> dict:
        return {"id": lease.id, "task_id": lease.task_id, "root_id": lease.root_id,
                "agent_id": lease.agent_id, "entry_agent_id": lease.entry_agent_id,
                "state": lease.state, "epoch": lease.epoch,
                "pages": [{"id": p.id, "title": p.title, "url": p.url, "revision": p.revision}
                          for p in lease.pages.values()], "current": lease.current,
                "environment_id": self.environment_id, "environment_name": self.environment_name,
                "capacity": self.capacity(), "capacity_rejection": lease.capacity_rejection,
                "reason": lease.reason, "requested_reason": lease.requested_reason}

    def _emit(self, lease: _Lease) -> None:
        snapshot = self._snapshot(lease)
        self._save()
        for callback in tuple(lease.listeners):
            callback(snapshot)
        if self.on_event is not None:
            self.on_event("browser_task.updated", snapshot)
        self._capacity_changed(exclude=lease.id)

    def _capacity_changed(self, *, exclude: str | None = None) -> None:
        capacity = self.capacity()
        if capacity == self._last_capacity:
            return
        self._last_capacity = capacity
        for lease in tuple(self._leases.values()):
            if lease.id == exclude or lease.state == "released":
                continue
            snapshot = self._snapshot(lease)
            for callback in tuple(lease.listeners):
                callback(snapshot)
            if self.on_event is not None:
                self.on_event("browser_task.updated", snapshot)

    def _forget_target(self, target: str) -> None:
        """Only a destroyed event or authoritative census confirms removal."""
        self._live_targets.discard(target)
        self._retired_targets.add(target)
        for marker, creation in tuple(self._creations.items()):
            if creation.target == target:
                creation.removed = True
                if creation.settled:
                    creation.lease.uncertain_creations.discard(marker)
                    self._creations.pop(marker)
        self._pending_removals.discard(target)
        self._capacity_changed()

    def _save(self) -> None:
        if self.state_path is None:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        scratch = self.state_path.with_suffix(".tmp")
        scratch.write_text(json.dumps([self._snapshot(lease) for lease in self._leases.values()],
                                      ensure_ascii=False))
        scratch.replace(self.state_path)

    def list_tasks(self, agent_id: str | None = None) -> list[dict]:
        return [self._snapshot(lease) for lease in self._leases.values()
                if agent_id is None or lease.agent_id == agent_id]

    def detail(self, lease_id: str) -> dict:
        return self._snapshot(self._get(lease_id))

    def capacity(self) -> dict:
        """Disjoint environment budget: registered, creating, and cleanup debt."""
        registered = {
            page for lease in self._leases.values() if lease.state not in ("stopping", "released")
            for page in lease.pages
            if page not in self._pending_removals and page not in self._retired_targets
        }
        # Hand-built test pages and disconnected-page inventories also remain
        # accountable even when discovery has not (or no longer) supplied them.
        known = self._live_targets | {
            page for lease in self._leases.values() if lease.state != "released"
            for page in lease.pages if page not in self._retired_targets
        }
        creating_targets = {
            creation.target for creation in self._creations.values()
            if not creation.settled and creation.target is not None
            and creation.target in known and creation.target not in registered
        }
        unidentified = [
            creation for creation in self._creations.values()
            if creation.target is None or creation.removed and not creation.settled
        ]
        creating = len(creating_targets) + sum(not creation.settled for creation in unidentified)
        pending = len(known - registered - creating_targets) + sum(
            creation.settled for creation in unidentified
        )
        return {"pages_used": len(registered) + creating + pending,
                "pages_registered": len(registered), "pages_creating": creating,
                "pages_pending_cleanup": pending, "pages_limit": self.config.max_pages}

    def lease_for_task(self, task_id: str) -> str | None:
        owner = self._tasks.get(task_id)
        lease = owner.lease if owner else None
        return lease.id if lease is not None and lease.state != "released" else None

    def _get(self, lease_id: str) -> _Lease:
        try:
            return self._leases[lease_id]
        except KeyError as exc:
            raise UnknownBrowserTask(lease_id) from exc

    def subscribe(self, lease_id: str, callback: Callable[[dict], None]) -> Callable[[], None]:
        lease = self._get(lease_id)
        lease.listeners.add(callback)
        return lambda: lease.listeners.discard(callback)

    def _activity(self, lease: _Lease) -> None:
        lease.last_activity = self.clock()

    async def _idle_loop(self) -> None:
        ticks = 0
        while True:
            await asyncio.sleep(1)
            ticks += 1
            if any(lease.state != "released" for lease in self._leases.values()) and self._chrome is not None:
                try:
                    listed = {t["id"]: t for t in await self._fetch("/json/list")}
                    for owner in tuple(self._tasks.values()):
                        lease = owner.lease
                        if lease is None or lease.state == "released":
                            continue
                        changed = False
                        for page in tuple(lease.pages.values()):
                            info = listed.get(page.id)
                            if info and (page.title, page.url) != (info.get("title", ""), info.get("url", "")):
                                page.title, page.url = info.get("title", ""), info.get("url", "")
                                changed = True
                        if changed:
                            self._emit(lease)
                except (OSError, ValueError):
                    pass  # Chrome disconnect callback invalidates leases separately.
            if ticks % 30 == 0:
                await self.expire_idle()

    async def expire_idle(self) -> None:
        timeout = self.config.idle_timeout
        if timeout <= 0:
            return
        for lease in list(self._leases.values()):
            if (lease.state in ("released", "stopping", "revoking")
                    or (lease.state == "human" and lease.pages)
                    or any(p.viewers or p.personal_streams for p in lease.pages.values())):
                continue
            if self.clock() - lease.last_activity >= timeout:
                try:
                    await self.close(lease.id, reason="浏览器空闲超时")
                except BrowserRejected:
                    # Cleanup debt remains in the budget; other leases and
                    # subsequent ticks must not depend on this close succeeding.
                    _log.warning("Idle browser lease %s closure unconfirmed", lease.id, exc_info=True)

    async def _close_target(self, target: str) -> None:
        chrome = self._chrome
        if chrome is None:
            raise CDPError("Chrome 不可达，页面关闭尚未确认")
        failure = None
        self._pending_removals.add(target)
        self._capacity_changed()
        page = next((lease.pages[target] for lease in self._leases.values() if target in lease.pages), None)
        if page is not None:
            try:
                # Abort a pending navigation before closing; a createTarget reply
                # no longer waits for its response headers or document commitment.
                await page.cdp.call("Page.stopLoading", timeout=3)
            except (CDPError, OSError, websockets.ConnectionClosed):
                # Only the browser-level target census below confirms removal.
                pass
            navigation = page.initial_navigation
            if navigation is not None and navigation is not asyncio.current_task() and not navigation.done():
                done, _ = await asyncio.wait((navigation,), timeout=3)
                if not done:
                    raise CDPError("初始导航停止尚未确认，页面关闭尚未确认")
        try:
            result = await chrome.call("Target.closeTarget", {"targetId": target}, timeout=3)
            if result.get("success") is False:
                failure = CDPError(f"无法关闭页面 {target}")
        except CDPError as exc:
            failure = exc
        deadline = asyncio.get_running_loop().time() + 3
        while True:
            remaining = (await chrome.call("Target.getTargets", timeout=3)).get("targetInfos", [])
            if target not in {t["targetId"] for t in remaining}:
                self._forget_target(target)
                return
            if failure is not None or asyncio.get_running_loop().time() >= deadline:
                raise CDPError(f"页面 {target} 关闭尚未确认") from failure
            await asyncio.sleep(0.05)

    async def close_page(
        self, lease_id: str, target_id: str, reason: str = "用户关闭", *,
        expected_epoch: int | None = None, _response_ready: asyncio.Future | None = None,
    ) -> dict:
        """Close an owned page; human control retains an empty lease until handback."""
        lease = self._get(lease_id)
        async with lease.lock:
            if expected_epoch is not None and (
                expected_epoch != lease.epoch or lease.state not in ("agent", "requested")
            ):
                raise BrowserRejected("浏览器控制权已转交，旧代际不能关闭页面")
            if (lease.close_reason is not None or target_id not in lease.pages
                    or lease.state in ("released", "stopping", "revoking")):
                raise BrowserRejected("页面不可关闭或不属于本租约")
            self.human_inputs(lease_id).stopped_pages.add(target_id)
        try:
            await self._release_human_input(lease, "page", target=target_id)
            async with lease.lock:
                # Settlement yields: takeover may have confirmed a new epoch.
                if expected_epoch is not None and (
                    expected_epoch != lease.epoch or lease.state not in ("agent", "requested")
                ):
                    raise BrowserRejected("浏览器控制权已转交，旧代际不能关闭页面")
                if (lease.close_reason is not None
                        or lease.state in ("released", "stopping", "revoking")):
                    raise BrowserRejected("页面不可关闭或不属于本租约")
                if target_id not in lease.pages:
                    return self._snapshot(lease)
                last_page = len(lease.pages) == 1
                if last_page and lease.state != "human":
                    lease.close_reason = reason
                else:
                    lease.page_close_reason = reason
                    try:
                        await self._close_target(target_id)
                    except Exception as exc:
                        raise BrowserRejected(f"页面关闭未确认：{exc}") from exc
                    close_reason = await self._remove_page_locked(lease, target_id)
                    if lease.state == "human":
                        self._activity(lease)
            if last_page and lease.state != "human":
                return await self.close(lease_id, reason, _response_ready=_response_ready)
            if close_reason is not None:
                return await self.close(lease_id, close_reason, _response_ready=_response_ready)
            return self.detail(lease_id)
        finally:
            lease.page_close_reason = None
            lease.inputs.stopped_pages.discard(target_id)

    async def close(self, lease_id: str, reason: str = "用户关闭", *,
                    _response_ready: asyncio.Future | None = None) -> dict:
        """Confirm page / creation release; retired byte transports settle independently."""
        lease = self._get(lease_id)
        if _response_ready is not None:
            lease.close_responses.add(_response_ready)
            _response_ready.add_done_callback(lease.close_responses.discard)
        # Publish terminal intent before yielding. Takeover/handback and input
        # cannot reopen a lease while the close worker waits for its lock.
        if lease.close_reason is None:
            lease.close_reason = reason
        if lease.close_future is None or lease.close_future.done() and lease.state != "released":
            lease.close_future = asyncio.create_task(self._close(lease, lease.close_reason))
            lease.close_future.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)
        return await asyncio.shield(lease.close_future)

    async def _remaining_targets(self, lease: _Lease) -> set[str]:
        """Reconcile opener descendants before trusting attachment callbacks.

        Keep destroyed opener identities until lease release: event delivery and
        attachment may lag behind Chrome, including chains of unopened popups.
        """
        chrome = self._chrome
        if chrome is None:
            raise CDPError("Chrome 不可达，页面清理尚未确认")
        before_census = set(self._live_targets)
        infos = (await chrome.call("Target.getTargets")).get("targetInfos", [])
        for info in infos:
            self._observe_target(info)
        alive = {info["targetId"] for info in infos if info.get("type") == "page"}
        for target in before_census - alive:
            self._forget_target(target)
        while True:
            descendants = {info["targetId"] for info in infos
                           if info.get("type") == "page" and info.get("openerId") in lease.targets}
            if descendants <= lease.targets:
                break
            lease.targets.update(descendants)
        return lease.targets & {info["targetId"] for info in infos}

    async def _close(self, lease: _Lease, reason: str) -> dict:
        await self._release_human_input(lease, "handback")
        async with lease.lock:
            if lease.state == "released":
                return self._snapshot(lease)
            if lease.state != "stopping":
                lease.state = "stopping"
                lease.epoch += 1
                lease.reason = reason
            self._emit(lease)
            clients = tuple(lease.clients)
        # Finish the WebSocket close handshake before ending the byte relay.
        # BrowserRelay still owns upstream replies after its client disconnects.
        await asyncio.gather(*(client.close(1008, "浏览器租约已关闭") for client in clients),
                             return_exceptions=True)
        endpoints = [endpoint for endpoint in self._tasks[lease.task_id].endpoints
                     if endpoint.lease_id == lease.id]
        # A target can exist before its createTarget reply is delivered. Wait for
        # ledger-owned creations, not for downstream WebSocket handlers. Neither
        # a timed-out caller nor shutdown may cancel these operations.
        if lease.creating:
            await asyncio.wait(tuple(lease.creating), timeout=3)
        try:
            remaining = await self._remaining_targets(lease)
            while remaining:
                for target in remaining:
                    await self._close_target(target)
                remaining = await self._remaining_targets(lease)
            if any(not operation.done() for operation in lease.creating) or lease.uncertain_creations:
                raise CDPError("建页结果尚未确认")
            for response in tuple(lease.close_responses):
                if not response.done():
                    response.set_result(None)
            for endpoint in endpoints:
                self._retire(endpoint)
            # Page / creation confirmation releases the lease. Retired endpoints
            # retain independent cleanup ownership; a byte relay cannot lock the
            # next explicit browser use after the old targets are gone.
        except Exception as exc:
            lease.reason = f"关闭未确认：{exc}"
            self._emit(lease)
            raise BrowserRejected(lease.reason) from exc
        # Only authoritative target removal permits forced transport teardown;
        # a client disconnect alone cannot confirm previously forwarded writes.
        await asyncio.gather(*(relay.close() for relay in tuple(lease.relays)))
        async with lease.lock:
            if lease.state == "released":
                return self._snapshot(lease)
            for page in tuple(lease.pages.values()):
                page.viewers.clear()
                await self._dispose_page(page)
            lease.pages.clear()
            lease.rejected_popups.clear()
            lease.relays.clear()
            lease.current = None
            was_human = lease.human_since is not None
            duration = max(0.0, self.clock() - lease.human_since) if was_human else 0.0
            lease.human_since = None
            lease.state = "released"
            lease.reason = reason
            self._restart_reasons[lease.task_id] = reason
            self._emit(lease)
        if was_human:
            if self.on_event:
                self.on_event("takeover.ended", {"id": lease.id, "task_id": lease.task_id,
                    "root_id": lease.root_id, "duration_seconds": duration,
                    "environment_id": self.environment_id, "environment_name": self.environment_name,
                    "text": f"你接管了浏览器 {duration / 60:.1f} 分钟，接管结束，页面已关闭"})
            if self.notify and self._tasks[lease.task_id].registered:
                await self.notify(lease.task_id, "接管结束，页面已关闭；如需继续请重新打开浏览器。", False)
        return self._snapshot(lease)

    async def close_task(self, task_id: str, reason: str = "任务结束") -> None:
        """Revoke admission immediately; settle every resource, retaining failures."""
        owner = self._tasks.get(task_id)
        if owner is None:
            return
        owner.registered = False
        if owner.closing is None or owner.closing.done():
            owner.closing = asyncio.create_task(self._close_task(owner, reason))
            owner.closing.add_done_callback(
                lambda task: task.exception() if not task.cancelled() else None)
        await asyncio.shield(owner.closing)

    async def _close_task(self, owner: _TaskResources, reason: str) -> None:
        # Finish single-flight creation so no listener can appear after inventory.
        if owner.preparing is not None:
            await asyncio.gather(owner.preparing, return_exceptions=True)
        endpoints = tuple(owner.endpoints)
        for endpoint in endpoints:
            endpoint.error = reason
            endpoint.server.close()
        failures = []
        if owner.lease is not None:
            try:
                await self.close(owner.lease.id, reason)
            except Exception as exc:
                failures.append(exc)
        # server.wait_closed includes handlers. A Chrome command may never
        # reply, so this final wait is bounded even after target confirmation.
        for endpoint in endpoints:
            try:
                if endpoint.reaper is not None:
                    # Lease closure may just have created this daemon grace
                    # waiter. A finished task must close its entry immediately.
                    endpoint.reaper.cancel()
                    await asyncio.gather(endpoint.reaper, return_exceptions=True)
                await self._close_endpoint(endpoint)
            except Exception as exc:
                failures.append(exc)
        self._restart_reasons[owner.task_id] = reason
        if failures:
            raise BrowserRejected(f"任务浏览器资源关闭未确认：{failures}") from failures[0]

    async def close_agent(self, agent_id: str, reason: str = "Agent 删除") -> None:
        """Revoke all of an Agent's registrations, including page-less endpoints."""
        owners = [owner for owner in self._tasks.values() if owner.identity[1] == agent_id]
        for owner in owners:
            owner.registered = False
        failures = []
        for owner in owners:
            try:
                await self.close_task(owner.task_id, reason)
            except Exception as exc:
                failures.append(exc)
        if failures:
            raise ExceptionGroup("Agent 浏览器资源关闭未确认", failures)

    async def takeover(self, lease_id: str) -> dict:
        """Confirm human control only after relay writes and owned creations settle.

        Both share a bounded wait; timeout preserves creation ownership, and an
        unknown creation result prevents confirmation even after its task ends.
        """
        lease = self._get(lease_id)
        async with lease.lock:
            if lease.close_reason is not None:
                raise BrowserRejected("浏览器租约正在关闭")
            if lease.state == "human":
                return self._snapshot(lease)
            if lease.state not in ("agent", "requested"):
                raise BrowserRejected("该浏览器租约不可接管")
            previous = lease.state
            lease.state = "revoking"
            lease.epoch += 1
            operation_epoch = lease.epoch
            self._emit(lease)
            relays = tuple(lease.relays)
            creations = tuple(lease.creating)
            clients = tuple(lease.clients)
        try:
            # Revocation rejects new sends. Host-owned createTarget calls bypass
            # relay.pending, so include their ledger without cancelling on timeout.
            async with asyncio.timeout(3):
                await asyncio.gather(*(relay.drain() for relay in relays))
                await asyncio.gather(*(asyncio.shield(operation) for operation in creations),
                                     return_exceptions=True)
            if lease.uncertain_creations:
                raise CDPError("建页结果尚未确认")
            await asyncio.gather(*(client.close(1008, "用户正在接管浏览器") for client in clients),
                                 return_exceptions=True)
            for endpoint in tuple(self._tasks[lease.task_id].endpoints):
                if endpoint.lease_id == lease.id:
                    await self._close_remote_endpoint(endpoint)
            async with lease.lock:
                if (lease.close_reason is not None or lease.state != "revoking"
                        or lease.epoch != operation_epoch):
                    raise BrowserRejected("接管期间租约已关闭")
                await self._refresh_frames(lease)
                # Refresh yields; close() publishes intent without taking lock.
                if lease.close_reason is not None:
                    raise BrowserRejected("接管期间租约已关闭")
                lease.state = "human"
                if lease.inputs is not None:
                    lease.inputs.sealed = False
                    lease.inputs.unknown = 0
                lease.requested_reason = None
                lease.human_since = self.clock()
                self._emit(lease)
        except BaseException as exc:
            async with lease.lock:
                if (lease.close_reason is None and lease.state == "revoking"
                        and lease.epoch == operation_epoch):
                    lease.state = previous
                    self._emit(lease)
            if isinstance(exc, (TimeoutError, CDPError)):
                raise BrowserRejected(f"收回未确认：Chrome 在途命令尚未结算，请稍后重试接管（{exc}）") from exc
            raise
        if self.notify:
            await self.notify(lease.task_id, "用户正在接管浏览器，等交还后再继续。", True)
        return self._snapshot(lease)

    async def handback(self, lease_id: str) -> dict:
        """Return control, or close an empty human lease as a user closure."""
        lease = self._get(lease_id)
        if lease.close_reason is not None or lease.state != "human":
            raise BrowserRejected("浏览器未处于接管状态")
        operation_epoch = lease.epoch
        inputs = self.human_inputs(lease_id)
        inputs.sealed = True
        try:
            await self._release_human_input(lease)
            async with lease.lock:
                if (lease.close_reason is not None or lease.state != "human"
                        or lease.epoch != operation_epoch):
                    raise BrowserRejected("浏览器未处于接管状态")
                if not lease.pages:
                    lease.close_reason = "用户关闭"
                else:
                    duration = max(0.0, self.clock() - lease.human_since) if lease.human_since is not None else 0.0
                    lease.epoch += 1
                    operation_epoch = lease.epoch
                    await self._refresh_frames(lease)
                    if lease.close_reason is not None:
                        raise BrowserRejected("浏览器租约正在关闭")
                    lease.human_since = None
                    lease.state = "agent"
                    self._emit(lease)
        finally:
            if (lease.state == "human" and lease.close_reason is None
                    and lease.epoch == operation_epoch):
                inputs.sealed = False
        if not lease.pages:
            return await self.close(lease_id, "用户关闭")
        text = f"你接管了浏览器 {duration / 60:.1f} 分钟，已交还"
        if self.on_event:
            self.on_event("takeover.ended", {"id": lease.id, "task_id": lease.task_id,
                                              "root_id": lease.root_id, "duration_seconds": duration,
                                              "environment_id": self.environment_id,
                                              "environment_name": self.environment_name,
                                              "text": text})
        if self.notify:
            unknown = lease.inputs.unknown if lease.inputs is not None else 0
            suffix = f"人接管期间最后 {unknown} 条输入结果未确认；请自行核对页面。" if unknown else ""
            await self.notify(lease.task_id, "浏览器已交还；请先重新确认页面状态再继续。" + suffix, False)
        return self._snapshot(lease)

    async def request_takeover(self, task_id: str, reason: str) -> dict:
        lease_id = self.lease_for_task(task_id)
        if not lease_id:
            raise BrowserRejected("任务尚未使用浏览器")
        lease = self._get(lease_id)
        async with lease.lock:
            if lease.state not in ("agent", "requested"):
                raise BrowserRejected("当前控制状态不能请求接管")
            lease.state = "requested"
            lease.requested_reason = reason
            self._emit(lease)
        return self._snapshot(lease)

    async def new_page(self, lease_id: str, epoch: int) -> str:
        """Create an owned blank page while human control holds this epoch.

        A human may reopen an empty lease until handback or closure fences it.
        View selection stays with the requesting stream.
        """
        lease = self._get(lease_id)
        async with lease.lock:
            if (lease.close_reason is not None or lease.state != "human"
                    or epoch != lease.epoch):
                raise BrowserRejected("浏览器未处于当前接管代际")
            creation = self._start_page(lease, "about:blank")
        target = await asyncio.shield(creation)
        self._activity(lease)
        return target

    async def page_call(self, lease_id: str, target_id: str, method: str,
                        params: dict | None = None) -> dict:
        lease = self._get(lease_id)
        async with lease.lock:
            if lease.state in ("stopping", "released") or target_id not in lease.pages:
                raise BrowserRejected("页面不属于活动浏览器租约")
            if method not in {"Runtime.evaluate", "Page.captureScreenshot", "Page.getNavigationHistory"}:
                raise BrowserRejected("宿主页命令只允许只读操作")
            return await lease.pages[target_id].cdp.call(method, params)

    async def human_call(self, lease_id: str, target_id: str, epoch: int, method: str,
                         params: dict | None = None) -> dict:
        return (await self.human_batch(lease_id, target_id, epoch, [(method, params or {})]))[0]

    def human_inputs(self, lease_id: str) -> HumanInputs:
        """Return the lease-owned input ledger, including after a viewer exits."""
        lease = self._get(lease_id)
        if lease.inputs is None:
            lease.inputs = HumanInputs(lease)
        return lease.inputs

    async def human_send(self, lease_id: str, target_id: str, epoch: int, method: str,
                         params: dict, *, connection: str, validate=None, observer=None,
                         on_dispatch=None, sequence=None, check_admission=None):
        """Serialize sends against atomic runtime batches, never unrelated replies."""
        async with self.human_inputs(lease_id).group(connection, target_id, validate, check_admission):
            return await self._dispatch_human(
                lease_id, target_id, epoch, method, params, connection=connection,
                validate=validate, observer=observer, on_dispatch=on_dispatch, sequence=sequence,
                check_admission=check_admission)

    async def _dispatch_human(self, lease_id: str, target_id: str, epoch: int, method: str,
                              params: dict, *, connection: str, validate=None, observer=None,
                              on_dispatch=None, sequence=None, check_admission=None):
        """Send at the lease barrier; the returned handle owns bounded settlement."""
        lease = self._get(lease_id)
        allowed = {"Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchTouchEvent",
                   "Input.insertText", "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"}
        if method not in allowed:
            raise BrowserRejected("人的输入方法不允许")
        page = lease.pages.get(target_id)

        def before_send():
            if validate is not None:
                validate()
            if (lease.close_reason is not None or lease.state != "human"
                    or epoch != lease.epoch or lease.pages.get(target_id) is not page):
                raise BrowserRejected("旧控制代际或浏览器不在接管中")

        command = await self.human_inputs(lease_id).send(
            target_id, connection, method, params, validate=before_send,
            observer=observer, on_dispatch=on_dispatch, sequence=sequence, check_admission=check_admission)
        self._activity(lease)
        return command

    async def human_batch(self, lease_id: str, target_id: str, epoch: int,
                          commands: list[tuple[str, dict]], *,
                          validate: Callable[[], None] | None = None,
                          on_dispatch: Callable[[], None] | None = None,
                          connection: str = "", observer=None, check_admission=None) -> list[dict]:
        """Keep an atomic input batch serial; attempted writes retain bounded ownership."""
        results = []
        command = None
        inputs = self.human_inputs(lease_id)
        sequence = object()
        attempted = False
        try:
            async with inputs.group(connection, target_id, validate, check_admission):
                for index, (method, params) in enumerate(commands):
                    command = await self._dispatch_human(
                        lease_id, target_id, epoch, method, params, connection=connection,
                        validate=validate, observer=observer, sequence=sequence, check_admission=check_admission,
                        on_dispatch=on_dispatch if index == len(commands) - 1 else None)
                    attempted |= command.sent
                    results.append(await command.wait())
                    if command.outcome == "unknown":
                        raise HumanInputUnknown("人的输入结果未确认")
        except asyncio.CancelledError:
            inputs = self.human_inputs(lease_id)
            if command is not None:
                inputs.cancel(command)
            inputs.settle("disconnect", connection=connection)
            raise
        except BaseException as error:
            inputs.settle("input-error", connection=connection, sequence=sequence)
            if attempted:
                raise HumanInputUnknown("人的输入未完整执行，已发部分请核对页面") from error
            raise
        return results

    async def _release_human_input(self, lease: _Lease, trigger="handback", *, target=None) -> None:
        if lease.inputs is not None:
            await asyncio.shield(lease.inputs.settle(trigger, target=target))

    async def subscribe_frames(self, lease_id: str, target_id: str,
                               callback: Callable[[dict], None], *,
                               quality_tier: str = "high") -> Callable[[], Awaitable[None]]:
        """Subscribe one socket to a quality tier without changing other viewers.

        High viewers share the page's existing screencast. Medium/low viewers
        own CDP sessions; Chrome encodes at source rather than the gateway
        decoding and re-encoding every JPEG.
        """
        if quality_tier not in _STREAM_PROFILES:
            raise ValueError("invalid quality tier")
        lease = self._get(lease_id)
        async with lease.lock:
            if target_id not in lease.pages or lease.state in ("stopping", "released"):
                raise BrowserRejected("页面不可观看")
            page = lease.pages[target_id]
            if quality_tier == "high":
                page.viewers.add(callback)
                try:
                    if not page.streaming:
                        await self._set_streaming(page, True)
                    elif page.latest_frame is not None:
                        # A late viewer on a static page needs the latest image.
                        callback(page.latest_frame)
                except BaseException:
                    page.viewers.discard(callback)
                    if not page.viewers and page.streaming:
                        await self._set_streaming(page, False)
                    raise
            else:
                await self._start_personal_stream(lease, page, callback, quality_tier)
            self._activity(lease)
        async def unsubscribe():
            async with lease.lock:
                if quality_tier == "high":
                    page.viewers.discard(callback)
                    if not page.viewers and page.streaming:
                        try:
                            await self._set_streaming(page, False)
                        except CDPError:
                            # A concurrent close may remove the target before
                            # stopScreencast replies. Only census proves the
                            # source ended; stopping alone isn't confirmation.
                            if lease.state != "stopping" or page.id in await self._remaining_targets(lease):
                                raise
                            page.streaming = False
                            page.latest_frame = None
                else:
                    entry = page.personal_streams.pop(callback, None)
                    if entry is not None:
                        source = entry[1]
                        try:
                            await source.call("Page.stopScreencast")
                        finally:
                            await source.close()
                self._activity(lease)
        return unsubscribe

    async def _start_personal_stream(self, lease: _Lease, page: _Page,
                                     callback: Callable[[dict], None], tier: str) -> None:
        """Start a generation-tagged CDP session while the lease lock is held."""
        quality, width, height = _STREAM_PROFILES[tier]
        epoch, revision = lease.epoch, page.revision

        async def on_event(message: dict):
            if message.get("method") != "Page.screencastFrame":
                return
            params = message["params"]
            source.notify("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
            if page.personal_streams.get(callback) != (tier, source):
                return
            callback({**params, "_epoch": epoch, "_revision": revision,
                      "_quality_tier": tier})

        source = CDPSocket(self._page_ws(page.id), on_event)
        page.personal_streams[callback] = (tier, source)

        async def start():
            await source.open()
            await source.call("Page.enable")
            await source.call("Page.startScreencast", {
                "format": "jpeg", "quality": quality, "maxWidth": width,
                "maxHeight": height, "everyNthFrame": 1,
                "maxFramesInFlight": _STREAM_FRAMES_IN_FLIGHT})

        operation = asyncio.create_task(start())
        try:
            await asyncio.shield(operation)
        except BaseException:
            await asyncio.gather(operation, return_exceptions=True)
            page.personal_streams.pop(callback, None)
            # Closing this dedicated CDP session also tears down an uncertain
            # start; no other viewer's screencast is stopped.
            await source.close()
            raise

    async def _restart_personal_streams(self, lease: _Lease, page: _Page) -> None:
        for callback, (tier, source) in tuple(page.personal_streams.items()):
            page.personal_streams.pop(callback, None)
            await source.close()
            await self._start_personal_stream(lease, page, callback, tier)

    async def _set_streaming(self, page: _Page, enabled: bool) -> None:
        """Keep uncertain starts owned until stop or target removal confirms release."""
        async def change():
            if page.streaming:
                await page.cdp.call("Page.stopScreencast")
                page.streaming = False
                page.latest_frame = None
            if enabled:
                # True means potentially running, not merely a received reply.
                page.streaming = True
                try:
                    quality, width, height = _STREAM_PROFILES["high"]
                    await page.cdp.call("Page.startScreencast", {
                        "format": "jpeg", "quality": quality, "maxWidth": width,
                        "maxHeight": height, "everyNthFrame": 1,
                        "maxFramesInFlight": _STREAM_FRAMES_IN_FLIGHT})
                except BaseException:
                    await page.cdp.call("Page.stopScreencast")
                    page.streaming = False
                    page.latest_frame = None
                    raise

        page.stream_operation = asyncio.create_task(change())
        try:
            await asyncio.shield(page.stream_operation)
        except asyncio.CancelledError:
            # Retain the lease lock until the actual Chrome operation settles.
            # subscribe_frames then removes its viewer and stops the source.
            await asyncio.gather(page.stream_operation, return_exceptions=True)
            raise

    async def _dispose_page(self, page: _Page) -> None:
        """Called only after target removal or transport invalidation."""
        page.viewers.clear()
        for _, source in page.personal_streams.values():
            await source.close()
        page.personal_streams.clear()
        if page.stream_operation is not None:
            await asyncio.gather(page.stream_operation, return_exceptions=True)
        await page.cdp.close()
        navigation = page.initial_navigation
        if navigation is not None and navigation is not asyncio.current_task() and not navigation.done():
            # This page is already removed or its scene invalidated. Stop only
            # the local observer; the target ledger retains any cleanup debt.
            navigation.cancel()
            await asyncio.gather(navigation, return_exceptions=True)
        page.streaming = False
        page.latest_frame = None

    async def _refresh_frames(self, lease: _Lease) -> None:
        for page in lease.pages.values():
            page.latest_frame = None
            if page.streaming:
                await self._set_streaming(page, bool(page.viewers))
            await self._restart_personal_streams(lease, page)

    async def _chrome_disconnected(self) -> None:
        await self.connection_lost("Chrome 连接中断")

    async def connection_lost(self, reason: str) -> None:
        """Fence the old scene immediately; retain cleanup debt until a new census.

        Provider callbacks may run during first connection or relay preparation.
        Do not await either preparation here: their results are fenced by revision.
        Closing an old CDP reader must not cancel this owner-held cleanup worker.
        """
        if self._disconnecting is not None and not self._disconnecting.done():
            await asyncio.shield(self._disconnecting)
            return
        chrome = self._chrome
        self._connection_revision += 1
        self._version = None
        self._discovery = None
        affected = [lease for lease in self._leases.values() if lease.state != "released"]
        for lease in affected:
            if lease.state != "stopping":
                lease.epoch += 1
            lease.state = "stopping"
            lease.close_reason = lease.close_reason or reason
            lease.reason = lease.close_reason
            self._restart_reasons[lease.task_id] = lease.reason
        endpoints = [endpoint for owner in self._tasks.values() for endpoint in owner.endpoints]
        for endpoint in endpoints:
            endpoint.error = endpoint.error or f"浏览器连接已断开（{reason}），旧会话已结束"
        self._disconnecting = asyncio.create_task(
            self._finish_connection_loss(chrome, affected, endpoints, reason))
        self._disconnecting.add_done_callback(
            lambda task: task.exception() if not task.cancelled() else None)
        await asyncio.shield(self._disconnecting)

    async def _finish_connection_loss(self, chrome: CDPSocket | None, affected: list[_Lease],
                                      endpoints: list[_Endpoint], reason: str) -> None:
        for lease in affected:
            async with lease.lock:
                for client in tuple(lease.clients):
                    await client.close(1012, "浏览器连接已断开")
                for page in tuple(lease.pages.values()):
                    await self._dispose_page(page)
                lease.pages.clear()
                await asyncio.gather(*(relay.close() for relay in tuple(lease.relays)))
                lease.relays.clear()
                lease.current = None
                self._emit(lease)
        for endpoint in endpoints:
            try:
                await self._close_remote_endpoint(endpoint)
            except Exception:
                _log.warning("Browser endpoint cleanup unconfirmed after %s: %s",
                             reason, endpoint.url, exc_info=True)
        if chrome is not None:
            await chrome.close()
        if self._chrome is chrome:
            self._chrome = None
        if self._initialization is not None and self._initialization.done():
            self._initialization = None
        # Transport loss is not target removal. Inherited-page cleanup, including
        # unidentified creations, remains owned by the next connection barrier.
