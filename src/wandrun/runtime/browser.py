"""Task-owned Chrome leases, task-scoped CDP endpoints and human control.

A lease is allocated at the first WebSocket connection, not at command setup.
The per-generation discovery endpoint survives revocation to explain stale use;
only a newly issued command environment can select the next generation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.request import urlopen

import websockets
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from wandrun.runtime.browser_cdp import BrowserRelay, CDPError, CDPRejected, CDPSocket

_log = logging.getLogger(__name__)
_STREAM_PROFILES = {"high": (75, 1600, 1000), "medium": (55, 1600, 1000),
                    "low": (40, 960, 600)}
_STREAM_FRAMES_IN_FLIGHT = 2  # Match the gateway's default displayed-ACK window.


class UnknownBrowserTask(LookupError):
    """The lease id has never been allocated in this runtime."""


class BrowserRejected(ValueError):
    """The requested page, epoch or lifecycle operation is unavailable."""


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
    # Includes pending popup attachments and destroyed opener identities until
    # the whole lease closes. Only a Chrome target census confirms release.
    targets: set[str] = field(default_factory=set)
    # A creation owns its Chrome result even if the requesting socket disappears.
    # Until every result settles, a target census cannot release this slot.
    creating: set[asyncio.Task[str]] = field(default_factory=set)
    creating_targets: set[str] = field(default_factory=set)
    create_uncertain: bool = False
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
    close_future: asyncio.Task | None = None
    page_close_reason: str | None = None
    close_reason: str | None = None


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
    ticket: asyncio.Future | None = None
    admitting: bool = False


class BrowserLeases:
    """One configured Chrome, FIFO admission and a single owner per task.

    The lease lock is the write barrier for Agent forwarding, human input and
    state changes. A stopping lease retains its slot if Chrome can't confirm
    page removal; the slot is never optimistically returned after I/O failure.
    """

    def __init__(self, config: Any, *, on_event: Callable[[str, dict], None] | None = None,
                 notify: Callable[[str, str, bool], Awaitable[None]] | None = None,
                 clock: Callable[[], float] = time.monotonic, state_path: Path | None = None):
        self.config = config
        self.on_event = on_event
        self.notify = notify
        self.clock = clock
        self.state_path = Path(state_path) if state_path is not None else None
        self._tasks: dict[str, _TaskResources] = {}
        # Lookup/history index, not the cleanup inventory. Live resources are
        # reachable through their task record even after registration is revoked.
        self._leases: dict[str, _Lease] = {}
        self._waiters: deque[_TaskResources] = deque()
        self._admission = asyncio.Lock()
        self._reserved = 0
        self._closed = False
        self._chrome: CDPSocket | None = None
        self._initialization: asyncio.Task | None = None
        self._browser_ws = ""
        self._base = ""
        self._idle_worker: asyncio.Task | None = None
        self._restart_reasons: dict[str, str] = {}

    async def _ensure_chrome(self) -> None:
        if self._closed:
            raise BrowserRejected("浏览器管理器已关闭")
        if self._initialization is None:
            self._initialization = asyncio.create_task(self._connect_chrome())
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
        self._base = self.config.cdp_url.rstrip("/")
        version = await self._fetch("/json/version")
        self._browser_ws = version["webSocketDebuggerUrl"]
        chrome = CDPSocket(self._browser_ws, self._chrome_event, self._chrome_disconnected)
        self._chrome = chrome
        try:
            await chrome.open()
            await chrome.call("Target.setDiscoverTargets", {"discover": True})
            existing = (await chrome.call("Target.getTargets")).get("targetInfos", [])
            for info in existing:
                if info.get("type") == "page":
                    await self._close_target(info["targetId"])
            for owner in self._tasks.values():
                if owner.lease is not None and owner.lease.state == "stopping":
                    await self.close(owner.lease.id, owner.lease.close_reason or "Chrome 重启")
        except BaseException:
            await chrome.close()
            if self._chrome is chrome:
                self._chrome = None
            raise

    async def start(self) -> None:
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
            await self._chrome.close()
            self._chrome = None
            raise

    async def aclose(self) -> None:
        self._closed = True
        if self._idle_worker is not None:
            self._idle_worker.cancel()
            await asyncio.gather(self._idle_worker, return_exceptions=True)
        if self._chrome is None and any(
                owner.lease is not None and owner.lease.state != "released"
                for owner in self._tasks.values()):
            self._initialization = asyncio.create_task(self._connect_chrome())
        if self._initialization is not None:
            await asyncio.gather(self._initialization, return_exceptions=True)
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
        try:
            await self._ensure_chrome()
        except (CDPError, OSError) as exc:
            raise BrowserRejected(f"Chrome 尚未恢复：{exc}") from exc
        if not owner.registered or self._closed:
            raise BrowserRejected("任务没有可用的浏览器")
        active = owner.lease
        if active is not None and active.close_reason is not None and active.state != "released":
            await self.close(active.id, active.close_reason)
        endpoint = owner.endpoint
        lease = self._leases.get(endpoint.lease_id) if endpoint else None
        if endpoint is None or (lease is not None and (
                lease.state == "released" or lease.state in ("agent", "requested")
                and endpoint.epoch != lease.epoch)):
            if endpoint is not None:
                self._retire(endpoint)
            active = owner.lease
            active = active if active is not None and active.state != "released" else None
            endpoint = await self._serve(owner.task_id, active.id if active else uuid.uuid4().hex,
                                         active.epoch if active else 1)
            owner.endpoint = endpoint
            reason = self._restart_reasons.get(owner.task_id)
            if reason:
                endpoint.error = f"上次浏览器租约已结束（{reason}），请重新确认页面状态"
        elif endpoint.error and endpoint.notice_seen:
            self._restart_reasons.pop(owner.task_id, None)
            self._retire(endpoint)
            endpoint = await self._serve(owner.task_id, uuid.uuid4().hex, 1)
            owner.endpoint = endpoint
        return {"WANDRUN_BROWSER_CDP": f"http://127.0.0.1:{endpoint.port}",
                "AGENT_BROWSER_SESSION": f"wandrun-{endpoint.lease_id}-{endpoint.epoch}",
                "AGENT_BROWSER_IDLE_TIMEOUT_MS": "120000"}

    def _retire(self, endpoint: _Endpoint) -> None:
        # Stale discovery stays alive while an attached daemon can report the
        # epoch error. Explicit daemon idle timeout is two minutes.
        if endpoint.reaper is None:
            endpoint.reaper = asyncio.create_task(self._reap_endpoint(endpoint))

    async def _reap_endpoint(self, endpoint: _Endpoint) -> None:
        await asyncio.sleep(180)
        await self._close_endpoint(endpoint)

    async def _close_endpoint(self, endpoint: _Endpoint) -> None:
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
            if request.headers.get("Upgrade", "").lower() == "websocket":
                return None
            lease = self._leases.get(lease_id)
            reason = endpoint.error or self._stale_reason(endpoint, lease)
            path = request.path.split("?", 1)[0].rstrip("/")
            if reason and path != "/json/version":
                return self._http(409, {"error": reason})
            if path == "/json/version":
                version = await self._fetch("/json/version")
                version.pop("devtoolsFrontendUrl", None)
                version["webSocketDebuggerUrl"] = f"ws://127.0.0.1:{endpoint.port}/devtools/browser/{lease_id}"
                return self._http(200, version)
            if path in ("/json", "/json/list"):
                targets = await self._fetch("/json/list")
                return self._http(200, [{**{k: v for k, v in t.items()
                                           if k != "devtoolsFrontendUrl"}, "webSocketDebuggerUrl":
                    f"ws://127.0.0.1:{endpoint.port}/devtools/page/{t['id']}"}
                    for t in targets if lease is not None and t["id"] in lease.pages])
            if path.startswith("/json/close/") and lease is not None:
                target = path.removeprefix("/json/close/")
                try:
                    await self.close_page(lease.id, target, reason="Agent 关闭",
                                          expected_epoch=endpoint.epoch)
                except BrowserRejected as exc:
                    return self._http(409, {"error": str(exc)})
                return self._http(200, {"closed": target})
            return self._http(404, {"error": "没有该 CDP 路径"})

        async def handle(client):
            lease = self._leases.get(lease_id)
            reason = endpoint.error or self._stale_reason(endpoint, lease)
            if reason:
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
                    owner = self._tasks[task_id]
                    if (endpoint.waiting == 1 and owner.ticket is not None
                            and not owner.ticket.done()):
                        endpoint.error = "浏览器排队连接已取消"
                        endpoint.notice_seen = True
                        owner.ticket.cancel()
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
                if method == "Target.createTarget" and len(lease.pages) >= self.config.max_pages:
                    return "浏览器页面数已达上限"
                return None
            def create(params: dict) -> asyncio.Task[str]:
                return self._start_page(lease, params.get("url", "about:blank"))
            relay = BrowserRelay(client, upstream, epoch=endpoint.epoch, page=page,
                                 owns=lambda target: target in lease.pages, guard=lease.lock,
                                 authorize=authorize, create=create, claim=self._claim_popup,
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
        return endpoint

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
        await self._ensure_chrome()
        owner = self._tasks[endpoint.task_id]
        if not owner.registered or self._closed:
            raise BrowserRejected("任务结束，浏览器排队已取消")
        lease = self._leases.get(endpoint.lease_id)
        if lease is not None:
            if lease.state not in ("agent", "requested") or endpoint.epoch != lease.epoch:
                raise BrowserRejected(self._stale_reason(endpoint, lease) or "旧代际已失效")
            return lease
        ticket = owner.ticket = asyncio.get_running_loop().create_future()
        async with self._admission:
            self._waiters.append(owner)
            self._wake_waiters()
        try:
            await asyncio.wait_for(ticket, self.config.queue_timeout)
        except (TimeoutError, asyncio.CancelledError) as exc:
            async with self._admission:
                self._waiters = deque(item for item in self._waiters if item is not owner)
                if owner.admitting:
                    owner.admitting = False
                    self._reserved -= 1
                self._wake_waiters()
            if isinstance(exc, asyncio.CancelledError):
                raise BrowserRejected("任务结束，浏览器排队已取消") from exc
            occupants = {item.identity[0] for item in self._tasks.values()
                         if item.admitting or item.lease is not None and item.lease.state != "released"}
            holders = ", ".join(sorted(occupants)) or "其他正在分配的对话"
            raise BrowserRejected(f"浏览器槽位已满，当前被这些对话占用：{holders}") from exc
        try:
            if not owner.registered or self._closed:
                raise BrowserRejected("任务结束，浏览器排队已取消")
            root, agent, entry = owner.identity
            lease = _Lease(endpoint.lease_id, endpoint.task_id, root, agent, entry,
                           last_activity=self.clock())
            self._leases[lease.id] = lease
            owner.lease = lease
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
            if owner.lease is not None:
                await self.close(owner.lease.id, f"浏览器分配失败：{exc}")
                if owner.registered:
                    # A failed initial allocation can retry this endpoint.
                    # Revoked tasks retain their released history and reason.
                    self._leases.pop(endpoint.lease_id, None)
                    owner.lease = None
            else:
                async with self._admission:
                    self._reserved -= 1
                    self._wake_waiters()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise BrowserRejected(f"浏览器分配失败：{exc}") from exc

    def _wake_waiters(self) -> None:
        while self._waiters and self._reserved < self.config.slots:
            owner = self._waiters.popleft()
            if owner.ticket.done() or not owner.registered or self._closed:
                owner.ticket.cancel()
                continue
            self._reserved += 1
            owner.admitting = True
            owner.ticket.set_result(None)

    def _start_page(self, lease: _Lease, url: str, *, info: dict | None = None) -> asyncio.Task[str]:
        """Reserve a creation under the lease lock; the ledger owns its result."""
        if lease.close_reason is not None or lease.state in ("stopping", "released"):
            raise BrowserRejected("浏览器正在关闭或已结束，无法新建页面")
        if len(lease.pages) + len(lease.creating) >= self.config.max_pages:
            raise BrowserRejected("浏览器页面数已达上限")
        if info is not None:
            lease.creating_targets.add(info["targetId"])
        operation = asyncio.create_task(self._new_page(lease, url, info=info))
        lease.creating.add(operation)
        def settled(task: asyncio.Task[str]) -> None:
            lease.creating.discard(task)
            if info is not None:
                lease.creating_targets.discard(info["targetId"])
            if not task.cancelled():
                task.exception()
        operation.add_done_callback(settled)
        return operation

    async def _new_page(self, lease: _Lease, url: str, *, info: dict | None = None) -> str:
        """Settle one reserved creation, including page identity and init cleanup."""
        try:
            target = info["targetId"] if info else (
                await self._chrome.call("Target.createTarget", {"url": url}, timeout=None)
            )["targetId"]
        except CDPRejected:
            raise
        except BaseException:
            # A lost reply is not proof that Chrome did not create a page.
            lease.create_uncertain = True
            raise
        async with lease.lock:
            lease.targets.add(target)

        async def on_event(message: dict):
            await self._page_event(lease.id, target, message)

        cdp = CDPSocket(self._page_ws(target), on_event)
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
            lease.pages[target] = _Page(target, cdp, info.get("title", "") if info else "",
                                         info.get("url", url) if info else url)
            if lease.current is None:
                lease.current = target
                lease.history.append(target)
            self._emit(lease)
        return target

    def _page_ws(self, target: str) -> str:
        parsed = urlsplit(self._browser_ws)
        return f"{parsed.scheme}://{parsed.netloc}/devtools/page/{target}"

    async def _fetch(self, path: str) -> Any:
        def fetch():
            with urlopen(self._base + path, timeout=5) as response:
                return json.load(response)
        return await asyncio.to_thread(fetch)

    async def _chrome_event(self, message: dict) -> None:
        method, params = message.get("method"), message.get("params", {})
        if method in ("Target.targetCreated", "Target.targetInfoChanged"):
            info = params["targetInfo"]
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
        lease.targets.add(target)
        async with lease.lock:
            if lease.state == "released":
                return  # Closure's target census has already confirmed absence.
            if target in lease.pages or target in lease.creating_targets:
                return
            if lease.close_reason is not None or len(lease.pages) + len(lease.creating) >= self.config.max_pages:
                await self._close_target(target)
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
        lease = next((item for item in self._leases.values() if target in item.pages), None)
        if lease is None:
            return
        async with lease.lock:
            reason = await self._remove_page_locked(lease, target)
        if reason is not None and (lease.close_future is None or lease.close_future.done()):
            await self.close(lease.id, reason=reason)

    def _snapshot(self, lease: _Lease) -> dict:
        return {"id": lease.id, "task_id": lease.task_id, "root_id": lease.root_id,
                "agent_id": lease.agent_id, "entry_agent_id": lease.entry_agent_id,
                "state": lease.state, "epoch": lease.epoch,
                "pages": [{"id": p.id, "title": p.title, "url": p.url, "revision": p.revision}
                          for p in lease.pages.values()], "current": lease.current,
                "max_pages": self.config.max_pages, "reason": lease.reason,
                "requested_reason": lease.requested_reason}

    def _emit(self, lease: _Lease) -> None:
        snapshot = self._snapshot(lease)
        self._save()
        for callback in tuple(lease.listeners):
            callback(snapshot)
        if self.on_event is not None:
            self.on_event("browser_task.updated", snapshot)

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
        """Configured browser capacity and currently reserved slots, including admission/teardown."""
        return {"pages_used": sum(len(lease.pages) for lease in self._leases.values()
                                  if lease.state != "released"),
                "pages_limit": self.config.slots * self.config.max_pages,
                "slots_used": self._reserved, "slots_limit": self.config.slots}

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
            if self._reserved and self._chrome is not None:
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
                    # The stopping lease still owns its slot; other leases and
                    # subsequent ticks must not depend on this close succeeding.
                    _log.warning("Idle browser lease %s closure unconfirmed", lease.id, exc_info=True)

    async def _close_target(self, target: str) -> None:
        failure = None
        try:
            result = await self._chrome.call("Target.closeTarget", {"targetId": target}, timeout=3)
            if result.get("success") is False:
                failure = CDPError(f"无法关闭页面 {target}")
        except CDPError as exc:
            failure = exc
        deadline = asyncio.get_running_loop().time() + 3
        while True:
            remaining = (await self._chrome.call("Target.getTargets", timeout=3)).get("targetInfos", [])
            if target not in {t["targetId"] for t in remaining}:
                return
            if failure is not None or asyncio.get_running_loop().time() >= deadline:
                raise CDPError(f"页面 {target} 关闭尚未确认") from failure
            await asyncio.sleep(0.05)

    async def close_page(
        self, lease_id: str, target_id: str, reason: str = "用户关闭", *,
        expected_epoch: int | None = None,
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
            last_page = len(lease.pages) == 1
            if last_page and lease.state != "human":
                lease.close_reason = reason  # Fence queued operations before releasing the lock.
            else:
                lease.page_close_reason = reason
                try:
                    await self._close_target(target_id)
                except Exception as exc:
                    lease.page_close_reason = None
                    raise BrowserRejected(f"页面关闭未确认：{exc}") from exc
                # Complete bookkeeping under this lock: handback must not see
                # a target already gone in Chrome as a still-open page.
                close_reason = await self._remove_page_locked(lease, target_id)
                if lease.state == "human":
                    self._activity(lease)
                lease.page_close_reason = None
        if last_page and lease.state != "human":
            return await self.close(lease_id, reason)
        if close_reason is not None:
            return await self.close(lease_id, close_reason)
        return self.detail(lease_id)

    async def close(self, lease_id: str, reason: str = "用户关闭") -> dict:
        lease = self._get(lease_id)
        # Publish terminal intent before yielding. Takeover/handback and input
        # cannot reopen a lease while the close worker waits for its lock.
        if lease.close_reason is None:
            lease.close_reason = reason
        if lease.close_future is None or lease.close_future.done() and lease.state != "released":
            lease.close_future = asyncio.create_task(self._close(lease, lease.close_reason))
        return await asyncio.shield(lease.close_future)

    async def _remaining_targets(self, lease: _Lease) -> set[str]:
        """Reconcile opener descendants before trusting attachment callbacks.

        Keep destroyed opener identities until lease release: event delivery and
        attachment may lag behind Chrome, including chains of unopened popups.
        """
        infos = (await self._chrome.call("Target.getTargets")).get("targetInfos", [])
        while True:
            descendants = {info["targetId"] for info in infos
                           if info.get("type") == "page" and info.get("openerId") in lease.targets}
            if descendants <= lease.targets:
                break
            lease.targets.update(descendants)
        return lease.targets & {info["targetId"] for info in infos}

    async def _close(self, lease: _Lease, reason: str) -> dict:
        async with lease.lock:
            if lease.state == "released":
                return self._snapshot(lease)
            if lease.state != "stopping":
                lease.state = "stopping"
                lease.epoch += 1
            self._emit(lease)
            clients = tuple(lease.clients)
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
            if any(not operation.done() for operation in lease.creating) or lease.create_uncertain:
                raise CDPError("建页结果尚未确认")
        except Exception as exc:
            await asyncio.gather(*(client.close(1008, "浏览器租约已关闭") for client in clients),
                                 return_exceptions=True)
            lease.reason = f"关闭未确认：{exc}"
            self._emit(lease)
            raise BrowserRejected(lease.reason) from exc
        await asyncio.gather(*(client.close(1008, "浏览器租约已关闭") for client in clients),
                             return_exceptions=True)
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
            lease.relays.clear()
            lease.current = None
            was_human = lease.human_since is not None
            duration = max(0.0, self.clock() - lease.human_since) if was_human else 0.0
            lease.human_since = None
            lease.state = "released"
            lease.reason = reason
            self._restart_reasons[lease.task_id] = reason
            self._emit(lease)
        async with self._admission:
            self._reserved -= 1
            self._wake_waiters()
        if was_human:
            if self.on_event:
                self.on_event("takeover.ended", {"id": lease.id, "task_id": lease.task_id,
                    "root_id": lease.root_id, "duration_seconds": duration,
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
        if owner.ticket is not None and not owner.ticket.done():
            owner.ticket.cancel()
        endpoints = tuple(owner.endpoints)
        for endpoint in endpoints:
            endpoint.error = reason
            if endpoint.reaper is not None:
                endpoint.reaper.cancel()
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
            if lease.create_uncertain:
                raise CDPError("建页结果尚未确认")
            await asyncio.gather(*(client.close(1008, "用户正在接管浏览器") for client in clients),
                                 return_exceptions=True)
            async with lease.lock:
                if (lease.close_reason is not None or lease.state != "revoking"
                        or lease.epoch != operation_epoch):
                    raise BrowserRejected("接管期间租约已关闭")
                await self._refresh_frames(lease)
                # Refresh yields; close() publishes intent without taking lock.
                if lease.close_reason is not None:
                    raise BrowserRejected("接管期间租约已关闭")
                lease.state = "human"
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
        async with lease.lock:
            if lease.close_reason is not None or lease.state != "human":
                raise BrowserRejected("浏览器未处于接管状态")
            if not lease.pages:
                lease.close_reason = "用户关闭"
            else:
                await self._release_human_input(lease)
                if lease.close_reason is not None:
                    raise BrowserRejected("浏览器租约正在关闭")
                duration = max(0.0, self.clock() - lease.human_since) if lease.human_since is not None else 0.0
                lease.epoch += 1
                await self._refresh_frames(lease)
                if lease.close_reason is not None:
                    raise BrowserRejected("浏览器租约正在关闭")
                lease.human_since = None
                lease.state = "agent"
                self._emit(lease)
        if not lease.pages:
            return await self.close(lease_id, "用户关闭")
        text = f"你接管了浏览器 {duration / 60:.1f} 分钟，已交还"
        if self.on_event:
            self.on_event("takeover.ended", {"id": lease.id, "task_id": lease.task_id,
                                              "root_id": lease.root_id, "duration_seconds": duration,
                                              "text": text})
        if self.notify:
            await self.notify(lease.task_id, "浏览器已交还；请先重新确认页面状态再继续。", False)
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

    async def human_batch(self, lease_id: str, target_id: str, epoch: int,
                          commands: list[tuple[str, dict]], *,
                          validate: Callable[[], None] | None = None,
                          on_dispatch: Callable[[], None] | None = None) -> list[dict]:
        """Validate once before the gesture's first send, then finish the group.

        ``on_dispatch`` marks when the last command's WebSocket send returns,
        not Chrome's reply. Concurrent navigation is best-effort; it must not
        split a down/up pair. The control lock keeps handback behind the gesture.
        """
        lease = self._get(lease_id)
        async with lease.lock:
            allowed = {"Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchTouchEvent",
                       "Input.insertText", "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"}
            if any(method not in allowed for method, _ in commands):
                raise BrowserRejected("人的输入方法不允许")
            page = lease.pages.get(target_id)
            def before_send():
                if validate is not None:
                    validate()
                if (lease.close_reason is not None or lease.state != "human"
                        or epoch != lease.epoch or lease.pages.get(target_id) is not page):
                    raise BrowserRejected("旧控制代际或浏览器不在接管中")
            if page is None:
                raise BrowserRejected("页面不属于本租约")
            results = []
            for index, (method, params) in enumerate(commands):
                results.append(await page.cdp.call(
                    method, params, before_send=before_send if not results else None,
                    on_sent=on_dispatch if index == len(commands) - 1 else None,
                ))
                self._track_input(lease, target_id, method, params)
                self._activity(lease)
            return results

    @staticmethod
    def _track_input(lease: _Lease, target: str, method: str, params: dict) -> None:
        kind = params.get("type")
        if method == "Input.dispatchMouseEvent":
            button = params.get("button", "none")
            if kind == "mousePressed":
                lease.mouse[button] = (target, params.get("x", 0), params.get("y", 0))
            elif kind == "mouseReleased":
                lease.mouse.pop(button, None)
            elif kind == "mouseMoved":
                for held, (page, _, _) in tuple(lease.mouse.items()):
                    if page == target:
                        lease.mouse[held] = (page, params.get("x", 0), params.get("y", 0))
        elif method == "Input.dispatchKeyEvent":
            key = params.get("code") or params.get("key") or str(params.get("windowsVirtualKeyCode", ""))
            if kind in ("keyDown", "rawKeyDown"):
                lease.keys[key] = {"target": target, **params}
            elif kind == "keyUp":
                lease.keys.pop(key, None)
        elif method == "Input.dispatchTouchEvent":
            lease.touching = None if kind in ("touchEnd", "touchCancel") else target

    async def _release_human_input(self, lease: _Lease) -> None:
        for button, (target, x, y) in tuple(lease.mouse.items()):
            if target in lease.pages:
                await lease.pages[target].cdp.call("Input.dispatchMouseEvent",
                    {"type": "mouseReleased", "button": button, "x": x, "y": y, "clickCount": 1})
            lease.mouse.pop(button)
        for key, params in tuple(lease.keys.items()):
            target = params["target"]
            if target in lease.pages:
                await lease.pages[target].cdp.call("Input.dispatchKeyEvent",
                    {**{name: value for name, value in params.items() if name != "target"}, "type": "keyUp"})
            lease.keys.pop(key)
        if lease.touching in lease.pages:
            await lease.pages[lease.touching].cdp.call("Input.dispatchTouchEvent",
                                                       {"type": "touchCancel", "touchPoints": []})
        lease.touching = None

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
                        await self._set_streaming(page, False)
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
        page.streaming = False
        page.latest_frame = None

    async def _refresh_frames(self, lease: _Lease) -> None:
        for page in lease.pages.values():
            page.latest_frame = None
            if page.streaming:
                await self._set_streaming(page, bool(page.viewers))
            await self._restart_personal_streams(lease, page)

    async def _chrome_disconnected(self) -> None:
        # Lost transport does not prove Chrome exited. Reconnection closes all
        # inherited targets before admission; revoke every old client now.
        affected = [lease for lease in self._leases.values() if lease.state != "released"]
        for lease in affected:
            async with lease.lock:
                lease.epoch += 1
                lease.state = "stopping"
                lease.reason = "Chrome 重启"
                self._restart_reasons[lease.task_id] = lease.reason
                for client in tuple(lease.clients):
                    await client.close(1012, "Chrome 重启")
                for page in lease.pages.values():
                    await self._dispose_page(page)
                lease.pages.clear()
                await asyncio.gather(*(relay.close() for relay in tuple(lease.relays)))
                lease.relays.clear()
                lease.current = None
        async with self._admission:
            for owner in self._tasks.values():
                if owner.ticket is not None and not owner.ticket.done():
                    owner.ticket.cancel()
            self._waiters.clear()
            self._chrome = None
            self._initialization = None
            # Transport loss isn't target removal. Retain each lease and its
            # slot until shared reconnection (or shutdown) confirms the census.
            for lease in affected:
                lease.close_reason = "Chrome 重启"
                self._emit(lease)
