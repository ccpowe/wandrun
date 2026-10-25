"""CDP transport and task-scoped forwarding for browser leases.

The relay is a routing boundary, not a sandbox against an Agent with shell access.
Only flattened sessions are forwarded; browser-wide mutation stays outside leases.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import websockets
from websockets.asyncio.client import connect

_log = logging.getLogger(__name__)


class CDPError(RuntimeError):
    pass

class CDPRejected(CDPError):
    """Chrome returned an explicit error, so the command has settled."""


class CDPSocket:
    """One CDP connection with paired replies and independent event delivery."""

    def __init__(self, url: str, on_event: Callable[[dict], Awaitable[None]] | None = None,
                 on_disconnect: Callable[[], Awaitable[None]] | None = None):
        self.url = url
        self.on_event = on_event
        self.on_disconnect = on_disconnect
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict]] = {}
        self._send_lock = asyncio.Lock()
        self._events: asyncio.Queue[dict] = asyncio.Queue()
        self._event_worker: asyncio.Task | None = None
        self._notifications: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()
        self._send_worker: asyncio.Task | None = None
        self._disconnected = False
        self.ws: Any = None
        self._reader: asyncio.Task | None = None
        self._closing = False

    async def open(self, *, proxy: bool = True) -> None:
        """Connect; isolated local renderers disable environment proxy discovery."""
        self.ws = await connect(
            self.url, max_size=None, compression=None, open_timeout=10,
            proxy=True if proxy else None,
        )
        self._disconnected = False
        self._send_worker = asyncio.create_task(self._send_notifications())
        self._reader = asyncio.create_task(self._receive())
        if self.on_event is not None:
            self._event_worker = asyncio.create_task(self._dispatch_events())

    async def close(self) -> None:
        self._closing = True
        current = asyncio.current_task()
        workers = (self._send_worker, self._event_worker, self._reader)
        for worker in workers:
            if (worker is not None and worker is not current
                    and not (current is self._event_worker and worker is self._reader)):
                worker.cancel()
        if self.ws is not None:
            await self.ws.close()
        # The reader may already await this event callback during disconnect.
        # Neither cancel it (which propagates back here) nor wait for it.
        await asyncio.gather(*(worker for worker in workers
                               if worker is not None and worker is not current
                               and not (current is self._event_worker and worker is self._reader)),
                             return_exceptions=True)

    async def call(self, method: str, params: dict | None = None, *, timeout: float | None = 10,
                   before_send: Callable[[], None] | None = None,
                   on_sent: Callable[[], None] | None = None) -> dict:
        """Send a CDP command; validate under the send lock and report its send.

        ``before_send`` may raise to abort without sending. ``on_sent`` runs
        when the WebSocket send returns, before Chrome's reply; it does not
        confirm Chrome applied the command. Callers coordinating lease state
        must hold their lifecycle lock across this call's send.
        """
        if self.ws is None:
            raise CDPError("Chrome CDP 未连接")
        ident = next(self._ids)
        future = asyncio.get_running_loop().create_future()
        self._pending[ident] = future
        try:
            async with self._send_lock:
                if before_send is not None:
                    before_send()
                await self.ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
                if on_sent is not None:
                    on_sent()
            reply = await asyncio.wait_for(future, timeout)
        except (websockets.ConnectionClosed, ConnectionError, asyncio.TimeoutError) as exc:
            raise CDPError(f"Chrome CDP {method} 失败: {exc}") from exc
        finally:
            self._pending.pop(ident, None)
        if "error" in reply:
            raise CDPRejected(f"{method}: {reply['error'].get('message', reply['error'])}")
        return reply.get("result", {})

    def notify(self, method: str, params: dict | None = None) -> None:
        """Queue a fire-and-forget command without blocking the event callback."""
        if self.ws is None or self._closing or self._disconnected:
            raise CDPError("Chrome CDP 未连接")
        self._notifications.put_nowait((method, params or {}))

    async def _send_notifications(self) -> None:
        while True:
            method, params = await self._notifications.get()
            try:
                async with self._send_lock:
                    await self.ws.send(json.dumps({"id": next(self._ids), "method": method, "params": params}))
            except (websockets.ConnectionClosed, ConnectionError):
                _log.warning("CDP notification send failed: %s", method, exc_info=True)
                return
            except Exception:
                _log.exception("CDP notification send failed: %s", method)

    async def _receive(self) -> None:
        try:
            async for raw in self.ws:
                message = json.loads(raw)
                if "id" in message:
                    future = self._pending.get(message["id"])
                    if future is not None and not future.done():
                        future.set_result(message)
                elif self.on_event is not None:
                    self._events.put_nowait(message)
        except (websockets.ConnectionClosed, ConnectionError):
            pass
        finally:
            self._disconnected = True
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CDPError("Chrome CDP 连接已断开"))
            if not self._closing:
                workers = tuple(worker for worker in (self._send_worker, self._event_worker)
                                if worker is not None)
                for worker in workers:
                    worker.cancel()
                await asyncio.gather(*workers, return_exceptions=True)
                if not self._closing and self.on_disconnect is not None:
                    await self.on_disconnect()

    async def _dispatch_events(self) -> None:
        while not self._closing:
            message = await self._events.get()
            try:
                await self.on_event(message)
            except Exception:
                _log.exception("CDP event processing failed: %s", message.get("method"))


# Explicit CDP methods used by installed agent-browser 0.38.1 (tagged Rust
# native sources), plus the small Target discovery/cleanup surface needed by
# other CDP clients. Browser.setDownloadBehavior/grantPermissions/setContentsSize
# have global or unscoped side effects; browser-level Target.setAutoAttach can
# pause another lease with waitForDebuggerOnStart and is always rejected.
BROWSER_METHODS = {
    "Browser.getVersion", "Browser.getWindowForTarget", "Target.getTargets",
    "Target.getTargetInfo", "Target.setDiscoverTargets", "Target.attachToTarget",
    "Target.detachFromTarget", "Target.activateTarget", "Target.closeTarget",
    "Target.createTarget",
}
# Page-session calls in the same installed release. A domain name alone is
# never enough: later CDP methods may mutate browser-wide state even if Chrome
# accepts them on a page session. Unlisted methods are rejected, including
# extension methods without a domain prefix.
PAGE_METHODS = {
    "Accessibility.enable", "Accessibility.getFullAXTree",
    "DOM.describeNode", "DOM.enable", "DOM.getBoxModel", "DOM.getDocument",
    "DOM.getFrameOwner", "DOM.querySelectorAll", "DOM.resolveNode",
    "DOM.scrollIntoViewIfNeeded", "DOM.setFileInputFiles",
    "Emulation.setDeviceMetricsOverride", "Emulation.setEmulatedMedia",
    "Emulation.setGeolocationOverride", "Emulation.setLocaleOverride",
    "Emulation.setTimezoneOverride", "Emulation.setUserAgentOverride",
    "Fetch.continueRequest", "Fetch.continueWithAuth", "Fetch.disable",
    "Fetch.enable", "Fetch.failRequest", "Fetch.fulfillRequest",
    "IO.close", "IO.read", "Input.dispatchKeyEvent", "Input.dispatchMouseEvent",
    "Input.dispatchTouchEvent", "Input.insertText",
    "Network.emulateNetworkConditions", "Network.enable", "Network.getCookies",
    "Network.getResponseBody", "Network.setExtraHTTPHeaders",
    "Page.addScriptToEvaluateOnNewDocument", "Page.bringToFront",
    "Page.captureScreenshot", "Page.createIsolatedWorld", "Page.enable",
    "Page.getFrameTree", "Page.getLayoutMetrics", "Page.handleJavaScriptDialog",
    "Page.navigate", "Page.printToPDF", "Page.reload",
    "Page.removeScriptToEvaluateOnNewDocument", "Page.screencastFrameAck",
    "Page.setDocumentContent", "Page.startScreencast", "Page.stopScreencast",
    "Runtime.addBinding", "Runtime.callFunctionOn", "Runtime.enable",
    "Runtime.evaluate", "Runtime.releaseObject", "Runtime.runIfWaitingForDebugger",
    "WebMCP.cancelInvocation", "WebMCP.enable", "WebMCP.invokeTool",
    # Scoped reads used by non-CLI CDP consumers.
    "Storage.getCookies", "Storage.getStorageKeyForFrame",
}
DENIED_METHODS = {
    "Network.clearBrowserCookies", "Network.clearBrowserCache", "Network.setCookie",
    "Network.setCookies", "Network.deleteCookies", "Page.setDownloadBehavior",
    "Target.disposeBrowserContext", "Target.createBrowserContext", "Target.setRemoteLocations",
    "Target.exposeDevToolsProtocol", "Target.setAutoAttachRelated", "Target.setDiscoverTargetsRelated",
}
TARGET_METHODS = {
    "Target.attachToTarget", "Target.activateTarget", "Target.closeTarget",
    "Target.getTargetInfo", "Browser.getWindowForTarget",
}


class BrowserRelay:
    """A client socket belongs to exactly one lease epoch and one optional page.

    The shared lifecycle lock covers policy validation and physical relay sends.
    Creation is admitted under that lock, then its lease-owned operation settles
    independently of the client. ``drain`` waits for forwarded Chrome replies,
    not client socket teardown; lost replies remain unconfirmed.
    """

    def __init__(self, client: Any, upstream_url: str, *, epoch: int, page: str | None,
                 owns: Callable[[str | None], bool],
                 guard: asyncio.Lock,
                 authorize: Callable[[str, dict], str | None],
                 create: Callable[[dict], asyncio.Task[str]],
                 claim: Callable[[dict], Awaitable[None]],
                 activated: Callable[[str], Awaitable[None]],
                 destroyed: Callable[[str], Awaitable[None]],
                 activity: Callable[[], None]):
        self.client, self.upstream_url = client, upstream_url
        self.epoch, self.page = epoch, page
        self.owns, self.guard, self.authorize = owns, guard, authorize
        self.create, self.claim, self.activated = create, claim, activated
        self.destroyed, self.activity = destroyed, activity
        self.sessions: dict[str, str] = {}
        # Targets already shown to this client retain lifecycle identity even
        # if the host removes them from the lease before its relay sees destroy.
        # Command authorization still consults owns(), never this set.
        self._delivered_targets: set[str] = set()
        if page is not None and owns(page):
            self._delivered_targets.add(page)
        # Flattened CDP ids are scoped to their session, not the whole socket.
        self.pending: dict[tuple[str | None, int], str] = {}
        self.pending_targets: dict[tuple[str | None, int], str] = {}
        self._internal_ids: set[tuple[str | None, int]] = set()
        self._own_ids = itertools.count(1_000_000_000)
        self._drained = asyncio.Event()
        self._drained.set()
        self._upstream_disconnected = False
        self._reader_failed = False
        self._upstream_send = asyncio.Lock()
        self._client_send = asyncio.Lock()
        self.upstream: Any = None

    @property
    def unsettled(self) -> bool:
        """Whether any client or relay-generated Chrome command lacks a reply."""
        return bool(self.pending or self._internal_ids)

    async def close(self) -> None:
        """Terminate the upstream transport; this does not confirm pending writes."""
        if self.upstream is not None:
            await self.upstream.close()

    async def drain(self) -> None:
        """Wait for forwarded Chrome replies; a lost reply is not confirmation.

        The Chrome reader stays alive after the client disconnects while requests
        remain. A natural upstream disconnect wakes waiters, but unresolved
        requests raise CDPError rather than being counted as settled.
        """
        while self.pending or self._internal_ids:
            await self._drained.wait()
            if (self.pending or self._internal_ids) and (self._upstream_disconnected or self._reader_failed):
                raise CDPError("Chrome CDP 已断开或读流失败，在途命令未确认；请关闭租约后重新打开")

    async def run(self) -> None:
        async with connect(self.upstream_url, max_size=None, compression=None, open_timeout=10) as upstream:
            self.upstream = upstream
            client_task = asyncio.create_task(self._from_client())
            chrome_task = asyncio.create_task(self._from_chrome())
            tasks = (client_task, chrome_task)
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                # Client shutdown must not cancel observation of already-sent
                # commands. This also prevents the owner from dropping a relay
                # with outstanding requests after an ordinary disconnect.
                if client_task in done or chrome_task in done:
                    await self.drain()
                for task in done:
                    if not task.cancelled() and task.exception():
                        raise task.exception()
            except websockets.ConnectionClosed as error:
                if self.client.close_code not in (1000, 1001, 1008, 1012) and (
                    error.sent is None or error.sent.code not in (1008, 1012)
                ):
                    raise
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    def check(self, message: dict) -> str | None:
        method = message.get("method", "")
        params = message.get("params") or {}
        session = message.get("sessionId")
        if not isinstance(params, dict) or not isinstance(method, str) or not method:
            return "无效 CDP 命令"
        if session is not None and not isinstance(session, str):
            return "无效 CDP 会话"
        if method == "Target.sendMessageToTarget":
            return "仅支持扁平会话，不接受 Target.sendMessageToTarget"
        if method == "Target.attachToTarget" and params.get("flatten") is not True:
            return "附加目标必须使用扁平会话"
        if method == "Target.setAutoAttach":
            return "不允许自动附加目标；请显式使用扁平会话附加本租约页面"
        if (method in DENIED_METHODS or
                method.startswith("Browser.") and method not in BROWSER_METHODS):
            return "不允许浏览器级全局操作"
        if ("targetId" not in params and (
            method == "Browser.getWindowForTarget"
            or method == "Target.getTargetInfo" and self.page is None and session is None
        )):
            return "必须指定本租约页面"
        if method in {"Target.attachToTarget", "Target.activateTarget", "Target.closeTarget"} and (
            "targetId" not in params
        ):
            return "必须指定本租约页面"
        if method in TARGET_METHODS and "targetId" in params and not self.owns(params["targetId"]):
            return "页面不属于本租约"
        if method == "Target.detachFromTarget" and not self.owns(self.sessions.get(params.get("sessionId"))):
            return "会话不属于本租约"
        if method == "Target.createTarget" and params.get("browserContextId"):
            return "不允许指定浏览器上下文"
        if method.startswith("Target.") and method not in BROWSER_METHODS:
            return "不允许该目标操作"
        if session is not None and not self.owns(self.sessions.get(session)):
            return "会话不属于本租约"
        if self.page is None:
            if session is None and method not in BROWSER_METHODS:
                return "浏览器连接只接受已认领页面的命令"
        elif not self.owns(self.page):
            return "页面不属于本租约"
        if method not in BROWSER_METHODS | PAGE_METHODS:
            return "不允许该 CDP 方法"
        return None

    async def _reject(self, message: dict, reason: str) -> None:
        if "id" in message:
            reply = {"id": message["id"], "error": {"code": -32000, "message": reason}}
            if "sessionId" in message:
                reply["sessionId"] = message["sessionId"]
            async with self._client_send:
                await self.client.send(json.dumps(reply))

    async def _from_client(self) -> None:
        async for raw in self.client:
            try:
                message = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(message, dict) or "id" not in message:
                continue
            if type(message["id"]) is not int:
                await self._reject(message, "无效 CDP 请求编号")
                continue
            session = message.get("sessionId")
            key = (session, message["id"])
            creation = None
            async with self.guard:
                reason = self.check(message)
                if reason is None:
                    reason = self.authorize(message.get("method", ""), message.get("params") or {})
                if reason is None and (key in self.pending or key in self._internal_ids):
                    reason = "同一会话的 CDP 请求编号正在使用"
                if reason:
                    await self._reject(message, reason)
                    continue
                if message["method"] == "Target.createTarget":
                    try:
                        creation = self.create(message.get("params") or {})
                    except Exception as exc:
                        await self._reject(message, str(exc))
                        continue
                else:
                    self.pending[key] = message["method"]
                    self._drained.clear()
                    if message["method"] in ("Target.attachToTarget", "Target.activateTarget"):
                        self.pending_targets[key] = message["params"]["targetId"]
                    try:
                        async with self._upstream_send:
                            await self.upstream.send(raw)
                    except BaseException:
                        self.pending.pop(key, None)
                        self.pending_targets.pop(key, None)
                        if not self.pending and not self._internal_ids:
                            self._drained.set()
                        raise
                    self.activity()
            if creation is not None:
                try:
                    target = await asyncio.shield(creation)
                except Exception as exc:
                    await self._reject(message, str(exc))
                else:
                    async with self._client_send:
                        reply = {"id": message["id"], "result": {"targetId": target}}
                        if session is not None:
                            reply["sessionId"] = session
                        await self.client.send(json.dumps(reply))
                        self._delivered_targets.add(target)

    async def _from_chrome(self) -> None:
        try:
            async for raw in self.upstream:
                message = json.loads(raw)
                if not await self._visible(message):
                    continue
                try:
                    async with self._client_send:
                        await self.client.send(json.dumps(message))
                except websockets.ConnectionClosed:
                    # Delivery failure must not stop observation of other
                    # requests already sent to Chrome.
                    pass
            self._upstream_disconnected = True
        except websockets.ConnectionClosed:
            self._upstream_disconnected = True
            raise
        except BaseException:
            self._reader_failed = True
            raise
        finally:
            self._drained.set()

    async def _visible(self, message: dict) -> bool:
        if "id" in message:
            key = (message.get("sessionId"), message["id"])
            if key in self._internal_ids:
                self._internal_ids.remove(key)
                if not self.pending and not self._internal_ids:
                    self._drained.set()
                return False
            method = self.pending.pop(key, None)
            if method is None:
                return False
            target = self.pending_targets.pop(key, None)
            # Settle before callbacks: they may await the lease lifecycle lock
            # while takeover concurrently waits for drain outside that lock.
            if not self.pending and not self._internal_ids:
                self._drained.set()
            result = message.get("result") or {}
            if target is not None and "sessionId" in result and "error" not in message:
                self.sessions[result["sessionId"]] = target
                # Authorization happened before the upstream send. The host
                # may remove a target before this successful reply arrives.
                self._delivered_targets.add(target)
            if method == "Target.activateTarget" and target is not None and "error" not in message:
                await self.activated(target)
            if method == "Target.getTargets":
                for info in result.get("targetInfos", []):
                    await self.claim(info)
                result["targetInfos"] = [info for info in result.get("targetInfos", []) if self._visible_info(info)]
            elif method == "Target.getTargetInfo" and "targetInfo" in result:
                if not self._visible_info(result["targetInfo"]):
                    return False
            return True
        method = message.get("method", "")
        params = message.get("params") or {}
        if method in {"Target.targetCreated", "Target.targetInfoChanged"}:
            await self.claim(params.get("targetInfo", {}))
            return self._visible_info(params.get("targetInfo", {}))
        if method == "Target.targetDestroyed":
            target = params.get("targetId")
            visible = self.owns(target) or target in self._delivered_targets
            self._delivered_targets.discard(target)
            if visible:
                await self.destroyed(target)
            return visible
        if method == "Target.attachedToTarget":
            info = params.get("targetInfo", {})
            await self.claim(info)
            if not self._visible_info(info):
                return False
            self.sessions[params["sessionId"]] = info["targetId"]
            # Focus emulation is a write too: it obeys revocation and participates
            # in drain, even though its reply is not forwarded to the client.
            async with self.guard:
                if self.authorize("Emulation.setFocusEmulationEnabled", {"enabled": True}):
                    return True
                async with self._upstream_send:
                    while True:
                        key = (params["sessionId"], next(self._own_ids))
                        if key not in self.pending and key not in self._internal_ids:
                            break
                    self._internal_ids.add(key)
                    self._drained.clear()
                    await self.upstream.send(json.dumps({"id": key[1],
                        "method": "Emulation.setFocusEmulationEnabled", "sessionId": key[0],
                        "params": {"enabled": True}}))
            return True
        if method == "Target.detachedFromTarget":
            return self.sessions.pop(params.get("sessionId"), None) is not None
        if method == "Target.receivedMessageFromTarget":
            return False  # Non-flattened attachment is rejected at the request boundary.
        if "sessionId" in message:
            return self.owns(self.sessions.get(message["sessionId"]))
        if self.page is not None:
            return self.owns(self.page)
        return method in {"Target.targetInfoChanged", "Target.targetCreated", "Target.targetDestroyed",
                          "Target.attachedToTarget", "Target.detachedFromTarget"}

    def _visible_info(self, info: dict) -> bool:
        visible = info.get("type") == "page" and self.owns(info.get("targetId"))
        if visible:
            self._delivered_targets.add(info["targetId"])
        return visible
