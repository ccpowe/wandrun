"""Stream cancellation with real lease state input and controlled CDP I/O."""

import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from starlette.websockets import WebSocket, WebSocketDisconnect

from wandrun.config import BrowserDefinition
from wandrun.gateway.browser_stream import BrowserStream, browser_stream
from wandrun.gateway.pairing import DeviceAuth
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.stream_config import InputConfig, StreamConfig
from wandrun.gateway.video_stream import VideoStreams
from wandrun.runtime.browser.cdp import CDPSocket
from wandrun.runtime.browser.leases import BrowserLeases, _Lease, _Page


class Socket:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()
        self.disconnected = asyncio.Event()
        self.closed = asyncio.Event()
        self.close_code = None

    async def receive_text(self):
        value = await self.incoming.get()
        if isinstance(value, BaseException):
            self.disconnected.set()
            raise value
        return value

    async def send_json(self, value):
        await self.outgoing.put(value)

    async def send_bytes(self, value):
        await self.outgoing.put(value)

    async def accept(self):
        pass

    async def close(self, code, **kwargs):
        self.close_code = code
        self.closed.set()


class ControlledWire:
    """Run real CDPSocket.call with separately controlled sends and replies."""

    def __init__(self, cdp):
        self.cdp = cdp
        self.hold_types = set()
        self.inputs = []
        self.sent_input = asyncio.Queue()
        self.held = []
        self.closed = False
        self.blocked_types = set()
        self.send_blocked = asyncio.Event()
        self.allow_send = asyncio.Event()
        self.send_cancelled = asyncio.Event()

    async def send(self, raw):
        message = json.loads(raw)
        if message["params"].get("type") in self.blocked_types:
            self.send_blocked.set()
            try:
                await self.allow_send.wait()
            except asyncio.CancelledError:
                self.send_cancelled.set()
                raise
        if message["method"].startswith("Input."):
            self.inputs.append(message)
            self.sent_input.put_nowait(message)
        if message["params"].get("type") in self.hold_types:
            self.held.append(message)
        else:
            self.reply(message)

    def reply(self, message):
        future = self.cdp._pending.get(message["id"])
        if future is not None and not future.done():
            result = {"result": {"value": [800, 600, 1]}} if message["method"] == "Runtime.evaluate" else {}
            future.set_result({"id": message["id"], "result": result})

    def release(self):
        self.hold_types.clear()
        self.allow_send.set()
        for message in self.held:
            self.reply(message)
        self.held.clear()

    async def close(self):
        self.closed = True


class StreamOwnedCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.browser = BrowserLeases(BrowserDefinition("http://127.0.0.1:1", idle_timeout=0))
        self.lease = _Lease("lease", "task", "root", "agent", "entry", state="human", current="page")
        self.cdp = CDPSocket("unused")
        self.wire = ControlledWire(self.cdp)
        self.cdp.ws = self.wire
        self.page = _Page("page", self.cdp)
        self.lease.pages[self.page.id] = self.page
        self.browser._leases[self.lease.id] = self.lease
        self.socket = Socket()
        self.stream = BrowserStream(self.socket, self.browser, self.lease.id, control=True,
            video_streams=VideoStreams(StreamConfig(input=InputConfig(reply_timeout_s=.15))))
        self.addAsyncCleanup(self.cdp.close)

    async def until(self, predicate):
        async with asyncio.timeout(2):
            while not predicate():
                await asyncio.sleep(0)

    async def reply(self, kind):
        async with asyncio.timeout(2):
            while True:
                reply = await self.socket.outgoing.get()
                if isinstance(reply, dict) and reply["t"] == kind:
                    return reply

    async def start(self, *, endpoint=False):
        task = asyncio.create_task(browser_stream(self.socket) if endpoint else self.stream.run())
        await self.reply("pages")
        self.stream.sent[1] = (self.lease.epoch, self.stream.vp, self.page.id)
        for kind, fields in (("pointer", {"x": 10, "y": 10, "buttons": 0}), ("touch", {"touches": []})):
            await self.stream._input({"t": kind, "id": 0, "epoch": self.lease.epoch,
                "vp": self.stream.vp, "page": self.page.id, "frame": 1, "ts": 0, **fields})
        self.wire.inputs.clear()
        while not self.wire.sent_input.empty():
            self.wire.sent_input.get_nowait()
        return task

    async def send(self, kind, identity, **fields):
        await self.socket.incoming.put(json.dumps({
            "t": kind, "id": identity, "epoch": self.lease.epoch, "vp": self.stream.vp,
            "frame": 1, "page": self.stream.page, "ts": 1000 + identity, **fields,
        }))

    def pair_device(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = GatewayStore(Path(directory.name) / "gateway.sqlite")
        self.addCleanup(store.close)
        paired, error = store.exchange_pairing_code(store.issue_pairing_code()["code"], "viewer", "manual")
        self.assertIsNone(error)
        auth = DeviceAuth(store)
        self.socket.app = SimpleNamespace(state=SimpleNamespace(
            device_auth=auth, gateway=SimpleNamespace(runtime=SimpleNamespace(
                browser_for_lease=lambda identity: self.browser,
            )),
        ))
        self.socket.headers = {"authorization": f"Bearer {paired['token']}"}
        self.socket.query_params = {"mode": "control"}
        self.socket.path_params = {"browser_task_id": self.lease.id}
        return auth, paired["device_id"]

    async def exercise_reader_send_disconnect(self, raw, reply_kind, *, queued=False):
        connected = False
        failed_send = asyncio.Event()

        async def receive():
            nonlocal connected
            if not connected:
                connected = True
                return {"type": "websocket.connect"}
            return {"type": "websocket.receive", "text": await self.socket.incoming.get()}

        async def send(message):
            if message["type"] != "websocket.send":
                return
            if "text" in message:
                reply = json.loads(message["text"])
                if reply["t"] == reply_kind:
                    failed_send.set()
                    # Exercise Starlette's actual send-side OSError conversion.
                    raise OSError("controlled websocket send failure")
                await self.socket.outgoing.put(reply)
            else:
                await self.socket.outgoing.put(message["bytes"])

        websocket = WebSocket({"type": "websocket"}, receive, send)
        await websocket.accept()
        self.stream.ws = websocket
        task = await self.start()
        try:
            if queued:
                self.wire.hold_types.add("mousePressed")
                await self.send("pointer", 1, x=10, y=10, buttons=1)
                first = await asyncio.wait_for(self.wire.sent_input.get(), 2)
                await self.send("wheel", 2, x=10, y=10, dx=0, dy=100)
            await self.socket.incoming.put(json.dumps(raw) if isinstance(raw, dict) else raw)
            await asyncio.wait_for(failed_send.wait(), 2)
            await self.until(lambda: self.stream._reader_disconnected)
            self.assertEqual(list(self.stream._commands_pending), [])
            if queued:
                self.assertFalse(task.done())
                self.wire.reply(first)
            with self.assertRaises(WebSocketDisconnect) as error:
                await asyncio.wait_for(task, 2)
            self.assertEqual(error.exception.code, 1006)
            expected = ["mousePressed", "mouseReleased"] if queued else []
            self.assertEqual([item["params"]["type"] for item in self.wire.inputs
                              if "type" in item["params"]], expected)
            self.assertEqual(sum(item["method"] == "Input.cancelDragging" for item in self.wire.inputs),
                             int(queued))
            self.assertEqual(self.page.viewers, set())
            self.assertFalse(self.page.streaming)
            self.assertEqual(self.lease.listeners, set())
            self.assertFalse(self.lease.lock.locked())
            self.assertTrue(all(worker.done() for worker in self.stream._tasks))
            self.assertTrue(self.socket.outgoing.empty())
        finally:
            self.wire.release()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_idle_pong_send_disconnect_reclaims_static_page_stream(self):
        await self.exercise_reader_send_disconnect({"t": "ping", "id": 3}, "pong")

    async def test_idle_invalid_json_reject_send_disconnect_reclaims_stream(self):
        with self.assertLogs("wandrun.gateway.browser_stream", level="WARNING"):
            await self.exercise_reader_send_disconnect("{", "reject")

    async def test_idle_invalid_ping_reject_send_disconnect_reclaims_stream(self):
        with self.assertLogs("wandrun.gateway.browser_stream", level="WARNING"):
            await self.exercise_reader_send_disconnect({"t": "ping", "id": "invalid"}, "reject")

    async def test_pong_send_disconnect_drops_queue_but_finishes_current_command(self):
        await self.exercise_reader_send_disconnect({"t": "ping", "id": 3}, "pong", queued=True)

    async def exercise_dispatched_group(self, kind):
        first_type, last_type = {
            "mouse": ("mousePressed", "mouseReleased"),
            "key": ("rawKeyDown", "keyUp"),
            "touch": ("touchStart", "touchCancel"),
        }[kind]
        self.wire.hold_types.add(first_type)
        task = await self.start()
        lock_held = False
        try:
            if kind == "mouse":
                await self.send("pointer", 1, x=10, y=10, buttons=1)
            elif kind == "key":
                await self.send("key", 1, key="Shift", code="ShiftLeft", vk=16)
            else:
                await self.send("touch", 1, touches=[{"id": 0, "x": 10, "y": 10}])
            first = await asyncio.wait_for(self.wire.sent_input.get(), 2)
            self.assertEqual(first["params"]["type"], first_type)
            # Let Chrome confirm the press, but hold the transport before release.
            await self.cdp._send_lock.acquire()
            lock_held = True
            self.wire.reply(first)
            await self.until(lambda: bool(self.lease.mouse or self.lease.keys or self.lease.touching))
            await self.send("wheel", 99, x=10, y=10, dx=0, dy=100)
            await self.send("ping", 100)
            await self.reply("pong")  # The queued wheel has reached the reader.
            await self.socket.incoming.put(WebSocketDisconnect())
            await self.socket.disconnected.wait()
            await self.until(lambda: self.stream._reader_disconnected)
            self.assertFalse(task.done())
            self.assertTrue(self.lease.lock.locked())
            self.cdp._send_lock.release()
            lock_held = False
            with self.assertRaises(WebSocketDisconnect):
                await asyncio.wait_for(task, 2)
            self.assertEqual([m["params"]["type"] for m in self.wire.inputs
                              if "type" in m["params"]], [first_type, last_type])
            self.assertEqual(sum(m["method"] == "Input.cancelDragging" for m in self.wire.inputs),
                             int(kind == "mouse"))
            self.assertEqual(self.lease.mouse, {})
            self.assertEqual(self.lease.keys, {})
            self.assertIsNone(self.lease.touching)
            self.assertEqual(list(self.stream._commands_pending), [])
            self.assertEqual(self.page.viewers, set())
            self.assertFalse(self.page.streaming)
            self.assertFalse(self.lease.lock.locked())
        finally:
            if lock_held:
                self.cdp._send_lock.release()
            self.wire.release()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_disconnect_settles_mouse_group_and_drops_queued_wheel(self):
        await self.exercise_dispatched_group("mouse")

    async def test_disconnect_settles_and_releases_key_group(self):
        await self.exercise_dispatched_group("key")

    async def test_disconnect_settles_and_cancels_touch_group(self):
        await self.exercise_dispatched_group("touch")

    async def test_cancel_before_first_send_drops_group_without_chrome_side_effects(self):
        await self.cdp._send_lock.acquire()
        task = asyncio.create_task(self.browser.human_batch(self.lease.id, self.page.id, 1, [
            ("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left", "x": 10, "y": 10}),
            ("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left", "x": 10, "y": 10}),
        ]))
        try:
            await self.until(self.lease.lock.locked)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 2)
            self.assertEqual(self.wire.inputs, [])
            self.assertEqual(self.lease.mouse, {})
            self.assertFalse(self.lease.lock.locked())
        finally:
            self.cdp._send_lock.release()
            self.wire.release()
            await asyncio.gather(task, return_exceptions=True)


    async def test_disconnect_drops_command_still_waiting_for_view_lock(self):
        task = await self.start()
        await self.stream._view_lock.acquire()
        try:
            await self.send("pointer", 1, x=10, y=10, buttons=1)
            await self.send("ping", 2)
            await self.reply("pong")
            await self.socket.incoming.put(WebSocketDisconnect())
            await self.until(lambda: self.stream._reader_disconnected)
            self.stream._view_lock.release()
            with self.assertRaises(WebSocketDisconnect):
                await asyncio.wait_for(task, 2)
            self.assertEqual(self.wire.inputs, [])
            self.assertEqual(list(self.stream._commands_pending), [])
        finally:
            if self.stream._view_lock.locked():
                self.stream._view_lock.release()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def exercise_blocked_input_stop(self, *, revoke):
        if revoke:
            auth, device_id = self.pair_device()
        self.wire.blocked_types.add("mouseReleased")
        with patch("wandrun.gateway.browser_stream.BrowserStream", return_value=self.stream):
            task = await self.start(endpoint=revoke)
            try:
                await self.send("pointer", 1, x=10, y=10, buttons=1)
                await self.reply("input_done")
                await self.send("pointer", 2, x=10, y=10, buttons=0)
                await asyncio.wait_for(self.wire.send_blocked.wait(), 2)
                self.assertTrue(self.lease.lock.locked())
                await self.send("wheel", 99, x=10, y=10, dx=0, dy=100)
                await self.send("ping", 100)
                await self.reply("pong")
                await self.socket.incoming.put(WebSocketDisconnect())
                await self.until(lambda: self.stream._reader_disconnected)
                self.assertFalse(task.done())  # Disconnect alone preserves the current send.
                self.assertFalse(self.wire.send_cancelled.is_set())
                if revoke:
                    self.assertTrue(auth.revoke(device_id))
                    await asyncio.wait_for(task, 2)
                    self.assertEqual(self.socket.close_code, 4401)
                    self.assertEqual(auth._connections, {})
                else:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(task, 2)
                # Never release the send gate: cancellation itself must release
                # the command's locks so source teardown can run.
                self.assertTrue(self.wire.send_cancelled.is_set())
                self.assertFalse(self.wire.allow_send.is_set())
                self.assertFalse(self.lease.lock.locked())
                self.assertEqual(self.cdp._pending, {})
                self.assertEqual(self.page.viewers, set())
                self.assertFalse(self.page.streaming)
                self.assertEqual(self.lease.listeners, set())
                self.assertEqual(list(self.stream._commands_pending), [])
            finally:
                self.wire.release()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_outer_cancel_interrupts_blocked_send_after_disconnect(self):
        await self.exercise_blocked_input_stop(revoke=False)

    async def test_device_revoke_interrupts_blocked_send_after_disconnect(self):
        await self.exercise_blocked_input_stop(revoke=True)

    async def exercise_encoder_cleanup(self, *, revoke):
        entered, release, reaping = asyncio.Event(), asyncio.Event(), asyncio.Event()
        sources = []

        class Source:
            def __init__(self, *args):
                self.start_task = None
                self.closed = False
                sources.append(self)

            async def open(self):
                pass

            async def call(self, method, params=None):
                if method == "Page.startScreencast":
                    self.start_task = asyncio.current_task()
                    entered.set()
                    await release.wait()
                return {}

            async def close(self):
                self.closed = True

        def gather(*tasks, **kwargs):
            if sources and sources[0].start_task in tasks:
                reaping.set()
            return asyncio.gather(*tasks, **kwargs)

        if revoke:
            auth, device_id = self.pair_device()

        with (patch("wandrun.runtime.browser.leases.CDPSocket", Source),
              patch("wandrun.runtime.browser.leases.asyncio", SimpleNamespace(**{
                  **vars(asyncio), "gather": gather,
              })), patch("wandrun.gateway.browser_stream.BrowserStream", return_value=self.stream)):
            task = await self.start(endpoint=revoke)
            try:
                self.stream._quality_request = ("medium", "bandwidth")
                self.stream._quality_wake.set()
                await asyncio.wait_for(entered.wait(), 2)
                self.assertEqual(len(self.page.personal_streams), 1)
                await self.socket.incoming.put(WebSocketDisconnect())
                await asyncio.wait_for(reaping.wait(), 2)
                if revoke:
                    self.assertTrue(auth.revoke(device_id))
                    await asyncio.wait_for(self.socket.closed.wait(), 2)
                else:
                    task.cancel()
                    await asyncio.sleep(0)
                    task.cancel()  # Repeat while the same teardown owner is pending.
                release.set()
                if revoke:
                    await asyncio.wait_for(task, 2)
                    self.assertEqual(self.socket.close_code, 4401)
                    self.assertEqual(auth._connections, {})
                else:
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(task, 2)
                self.assertEqual(len(sources), 1)
                self.assertTrue(sources[0].closed)
                self.assertEqual(self.page.personal_streams, {})
                self.assertEqual(self.page.viewers, set())
                self.assertEqual(self.lease.listeners, set())
                self.assertTrue(all(worker.done() for worker in self.stream._tasks))
                self.assertFalse(self.lease.lock.locked())
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def test_disconnect_then_repeated_outer_cancel_closes_encoder_source(self):
        await self.exercise_encoder_cleanup(revoke=False)

    async def test_disconnect_then_device_revoke_closes_encoder_source_and_unregisters(self):
        await self.exercise_encoder_cleanup(revoke=True)
