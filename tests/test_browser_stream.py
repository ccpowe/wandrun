"""Production stream teardown under controlled scheduling and real Chrome (serial only)."""

import asyncio
import base64
from contextlib import asynccontextmanager
import json
import math
from pathlib import Path
import shutil
import socket
import struct
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from starlette.applications import Starlette
from starlette.datastructures import QueryParams
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocketDisconnect
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus
from websockets.protocol import State

from wandrun.config import BrowserDefinition
from wandrun.gateway.browser_stream import (
    BrowserStream, StreamRejected, _FrameWindow, browser_stream,
    FRAME_OVERHEAD, MAX_IN_FLIGHT_BYTES,
)
from wandrun.gateway.pairing import DeviceAuth
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.browser_dev import ChromeDev
from wandrun.runtime.browser import BrowserLeases
from wandrun.runtime.browser_cdp import CDPSocket


@asynccontextmanager
async def stream_server(browser):
    app = Starlette(routes=[WebSocketRoute("/browser-tasks/{browser_task_id}/stream", browser_stream)])
    app.state.gateway = SimpleNamespace(runtime=SimpleNamespace(browser=browser))
    directory = tempfile.TemporaryDirectory(prefix="browser-stream-auth-")
    store = GatewayStore(Path(directory.name) / "gateway.sqlite")
    app.state.device_auth = DeviceAuth(store, "stream-test-token")
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", log_config=None, lifespan="off", ws="wsproto"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    task.result()
                await asyncio.sleep(.01)
        yield f"ws://127.0.0.1:{sock.getsockname()[1]}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        sock.close()
        store.close()
        directory.cleanup()


class Viewer:
    def __init__(self, ws):
        self.ws = ws
        self.next_id = 0
        self.frames = {}

    async def receive(self):
        raw = await asyncio.wait_for(self.ws.recv(), 10)
        if isinstance(raw, bytes):
            size = struct.unpack("!I", raw[:4])[0]
            header = json.loads(raw[4:4 + size])
            jpeg = raw[4 + size:]
            if jpeg[:2] != b"\xff\xd8" or jpeg[-2:] != b"\xff\xd9":
                raise AssertionError("not a complete JPEG")
            if self.ws.state is State.OPEN:
                await self.ws.send(json.dumps({"t": "ack", "seq": header["seq"], "displayed": True}))
            header["jpeg"] = jpeg
            self.frames[header["page"]] = header
            return header
        return json.loads(raw)

    async def until(self, predicate):
        async with asyncio.timeout(15):
            while True:
                item = await self.receive()
                if predicate(item):
                    return item

    async def frame(self, epoch=None):
        return await self.until(lambda m: m["t"] == "frame" and (epoch is None or m["epoch"] == epoch))

    async def current_frame(self, page, epoch):
        # A command can consume the first (and only) frame of a static page
        # while waiting for its reply. Do not require a second screencast swap.
        frame = self.frames.get(page)
        if frame is not None and frame["epoch"] == epoch:
            return frame
        return await self.until(lambda m: m["t"] == "frame" and m["page"] == page and m["epoch"] == epoch)

    async def command(self, kind, frame=None, **fields):
        self.next_id += 1
        message = {"t": kind, "id": self.next_id, **fields}
        if frame:
            message.update(epoch=frame["epoch"], vp=frame["vp"], frame=frame["seq"])
        await self.ws.send(json.dumps(message))
        return await self.until(lambda m: m.get("id") == self.next_id)


class StreamMeasurementTests(unittest.IsolatedAsyncioTestCase):
    """Deterministic socket/CDP ordering without a graphical Chrome dependency."""

    async def asyncSetUp(self):
        class Socket:
            def __init__(self):
                self.sent_at = []
                self.incoming = asyncio.Queue()
                self.outgoing = asyncio.Queue()

            async def receive_text(self):
                return await self.incoming.get()

            async def send_json(self, value):
                await self.outgoing.put(value)

            async def send_bytes(self, value):
                self.sent_at.append(time.perf_counter())
                size = struct.unpack("!I", value[:4])[0]
                await self.outgoing.put(json.loads(value[4:4 + size]))

        class Browser:
            def __init__(self):
                self.snapshot = {
                    "epoch": 1, "state": "human", "current": "first",
                    "pages": [{"id": "first", "revision": 0, "url": "about:blank"},
                              {"id": "second", "revision": 0, "url": "about:blank"}],
                    "max_pages": 2,
                }
                self.batch = None
                self.subscriptions = {}
                self.capture_calls = []

            def detail(self, lease_id):
                return self.snapshot

            def subscribe(self, lease_id, callback):
                return lambda: None

            async def page_call(self, lease_id, target, method, params=None):
                if method == "Page.captureScreenshot":
                    self.capture_calls.append((target, params))
                    return {"data": base64.b64encode(b"\xff\xd8\xff\xd9").decode()}
                return {"result": {"value": [800, 600, 1]}}

            async def subscribe_frames(self, lease_id, target, callback, *, quality_tier="high"):
                self.subscriptions[callback] = (target, quality_tier)
                async def unsubscribe():
                    self.subscriptions.pop(callback, None)
                return unsubscribe

            async def human_batch(self, lease_id, target, epoch, commands, *, validate, on_dispatch):
                validate()
                if self.batch is not None:
                    return await self.batch(on_dispatch)
                on_dispatch()
                return [{} for _ in commands]

        self.socket = Socket()
        self.browser = Browser()
        self.stream = BrowserStream(self.socket, self.browser, "lease", control=True, max_in_flight=2)
        await self.stream._sync_pages()
        await self.socket.outgoing.get()  # Initial pages.

    async def test_programming_error_rejects_command_but_keeps_receiver_and_cancellation(self):
        receiver = asyncio.create_task(self.stream._receive())
        async def broken_input(message):
            raise NameError("missing implementation symbol")
        try:
            with patch.object(self.stream, "_input", side_effect=broken_input):
                with self.assertLogs("wandrun.gateway.browser_stream", level="ERROR"):
                    await self.socket.incoming.put(json.dumps({"t": "navigate", "id": 1}))
                    reply = await asyncio.wait_for(self.socket.outgoing.get(), 2)
                    self.assertEqual(reply, {"t": "reject", "id": 1, "why": "internal-error"})
            await self.socket.incoming.put(json.dumps({"t": "ping", "id": 2}))
            self.assertEqual(await self.socket.outgoing.get(), {"t": "pong", "id": 2})
            async def cancelled_input(message):
                raise asyncio.CancelledError
            with patch.object(self.stream, "_input", side_effect=cancelled_input):
                await self.socket.incoming.put(json.dumps({"t": "navigate", "id": 3}))
                with self.assertRaises(asyncio.CancelledError):
                    await receiver
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            await self.stream._cleanup()

    async def test_pipeline_programming_error_closes_socket_and_reaps_stream_tasks(self):
        closed = []
        async def close(**fields):
            closed.append(fields)
        async def broken_frames():
            raise AttributeError("defective frame encoder")
        self.socket.close = close
        self.stream._frames = broken_frames
        with self.assertLogs("wandrun.gateway.browser_stream", level="ERROR"):
            await asyncio.wait_for(self.stream.run(), 2)
        self.assertEqual(closed, [{"code": 1011, "reason": "internal-error"}])
        self.assertTrue(all(task.done() for task in self.stream._tasks))
        self.assertEqual(self.browser.subscriptions, {})

    def offer(self, timestamp, *, target="first", tier="high", size=4, epoch=None, revision=None):
        self.stream._offer(target, {
            "metadata": {"deviceWidth": 800, "deviceHeight": 600, "timestamp": timestamp,
                         "scrollOffsetX": timestamp if timestamp is not None else 0},
            "data": base64.b64encode(b"\xff\xd8" + b"\x00" * (size - 4) + b"\xff\xd9").decode(),
            "_quality_tier": tier,
            **({"_epoch": epoch} if epoch is not None else {}),
            **({"_revision": revision} if revision is not None else {}),
        })

    def credential(self, seq=1):
        self.stream.sent[seq] = (self.browser.snapshot["epoch"], self.stream.vp, self.stream.page)
        return {"epoch": self.browser.snapshot["epoch"], "vp": self.stream.vp, "frame": seq}

    async def ack(self, seq, displayed=True):
        await self.socket.incoming.put(json.dumps({"t": "ack", "seq": seq, "displayed": displayed}))

    async def credits(self, count):
        async with asyncio.timeout(2):
            while len(self.stream.outstanding) != count:
                await asyncio.sleep(0)

    async def test_pipelined_out_of_order_ack_latest_only_and_input_credentials(self):
        self.stream.control = False
        receiver = asyncio.create_task(self.stream._receive())
        frames = asyncio.create_task(self.stream._frames())
        try:
            self.offer(1)
            first = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual((first["seq"], first["dropped_frames"], first["ack_wait_ms"]), (1, 0, None))
            self.offer(2)
            second = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual(second["seq"], 2)
            self.assertGreaterEqual(self.socket.sent_at[1] - self.socket.sent_at[0], 1 / 24 - .01)
            self.assertEqual(len(self.stream.outstanding), 2)
            await self.socket.incoming.put(json.dumps({"t": "ping", "id": 71}))
            self.assertEqual(await asyncio.wait_for(self.socket.outgoing.get(), 2), {"t": "pong", "id": 71})
            self.offer(3)
            self.offer(4)
            self.offer(5)
            self.assertEqual(self.stream.dropped_frames, 2)
            await self.ack(2, False)  # A later skipped frame returns credit first.
            third = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual((third["seq"], third["dropped_frames"], third["scroll"][0]), (3, 2, 5))
            self.assertGreaterEqual(third["ack_wait_ms"], 0)
            self.assertNotIn(2, self.stream.sent)
            with self.assertRaisesRegex(StreamRejected, "stale-frame"):
                self.stream._validate_input({"epoch": second["epoch"], "vp": second["vp"], "frame": 2})
            await self.ack(1)
            await self.credits(1)
            self.assertIn(1, self.stream.sent)  # A still-valid older frame remains eligible.
            self.stream._validate_input({"epoch": first["epoch"], "vp": first["vp"], "frame": 1})
            self.offer(6)
            fourth = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual(fourth["seq"], 4)
            measured = self.stream.ack_wait_ms
            for invalid in (
                {"seq": 2, "displayed": True},  # Duplicate skipped ACK.
                {"seq": 0, "displayed": True},
                {"seq": 3},
                {"seq": True, "displayed": True},
                {"seq": 3, "displayed": 1},
            ):
                await self.socket.incoming.put(json.dumps({"t": "ack", **invalid}))
            self.offer(7)
            self.offer(8)
            await asyncio.sleep(.15)
            self.assertEqual(set(self.stream.outstanding), {3, 4})
            self.assertEqual(self.stream.ack_wait_ms, measured)
            self.assertTrue(self.socket.outgoing.empty())
            await self.ack(3)
            fifth = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual(fifth["seq"], 5)
            self.assertEqual((fifth["dropped_frames"], fifth["scroll"][0]), (3, 8))
            self.assertEqual(set(self.stream.outstanding), {4, 5})
        finally:
            receiver.cancel()
            frames.cancel()
            await asyncio.gather(receiver, frames, return_exceptions=True)

    async def test_send_start_pacing_and_no_ack_timeout_bypass(self):
        self.stream.window = _FrameWindow(self.stream.fps, 1)
        receiver = asyncio.create_task(self.stream._receive())
        frames = asyncio.create_task(self.stream._frames())
        try:
            self.offer(1)
            await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.offer(2)
            await asyncio.sleep(2.1)  # Previously a two-second timeout bypassed credit.
            self.assertTrue(self.socket.outgoing.empty())
            self.assertEqual(set(self.stream.outstanding), {1})
            started = time.perf_counter()
            await self.ack(1)
            second = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual(second["seq"], 2)
            self.assertLess(time.perf_counter() - started, 1 / 12)
            self.assertGreaterEqual(second["ack_wait_ms"], 2000)
        finally:
            receiver.cancel()
            frames.cancel()
            await asyncio.gather(receiver, frames, return_exceptions=True)

    async def test_old_generation_ack_cannot_release_new_credit(self):
        self.stream.window = _FrameWindow(self.stream.fps, 1)
        receiver = asyncio.create_task(self.stream._receive())
        frames = asyncio.create_task(self.stream._frames())
        try:
            self.offer(1)
            first = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            old_vp = first["vp"]
            self.browser.snapshot["epoch"] += 1
            self.stream._changed(self.browser.snapshot)
            self.offer(2)
            second = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertGreater(second["vp"], old_vp)
            self.assertEqual(second["seq"], first["seq"] + 1)
            self.offer(3)
            await self.ack(first["seq"])
            await asyncio.sleep(.15)
            self.assertEqual(set(self.stream.outstanding), {second["seq"]})
            self.assertTrue(self.socket.outgoing.empty())
            with self.assertRaisesRegex(StreamRejected, "stale-frame"):
                self.stream._validate_input({"epoch": second["epoch"], "vp": second["vp"], "frame": first["seq"]})
            await self.ack(second["seq"], False)
            third = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual(third["seq"], second["seq"] + 1)
            self.assertNotIn(second["seq"], self.stream.sent)
        finally:
            receiver.cancel()
            frames.cancel()
            await asyncio.gather(receiver, frames, return_exceptions=True)

    async def test_dispatch_timestamp_rejects_older_frames_and_pending_inputs(self):
        self.credential()
        self.offer(99)
        self.assertEqual(self.stream.pending[3], 0)
        self.assertEqual((await self.stream._input({
            "t": "down", "id": 1, "x": 20, "y": 20, **self.credential(),
        }))["t"], "input_pending")
        self.offer(101)
        self.assertEqual(self.stream.pending[3], 0)
        with self.assertRaisesRegex(StreamRejected, "out-of-bounds"):
            await self.stream._input({"t": "click", "id": 2, "x": -1, "y": 20, **self.credential()})
        self.assertEqual(self.stream.pending[3], 0)

        async def staged(on_dispatch):
            self.offer(99)  # Delivered late by CDP, but produced before the write.
            on_dispatch()
            self.offer(101)  # Produced after dispatch, before Chrome's reply.
            return [{}, {}]

        self.browser.batch = staged
        with patch("wandrun.gateway.browser_stream.time.time", return_value=100):
            reply = await self.stream._input({
                "t": "up", "id": 3, "x": 20, "y": 20, **self.credential(),
            })
        self.assertEqual(reply["t"], "input_done")
        self.assertEqual(self.stream.pending[3], 3)  # Final phase ID, not the down ID.
        self.offer(99)
        self.assertEqual(self.stream.pending[3], 0)
        self.offer(101)
        self.assertEqual(self.stream.pending[3], 3)

        async def failed(on_dispatch):
            on_dispatch()
            self.offer(102)
            raise RuntimeError("CDP command failed")

        self.browser.batch = failed
        with patch("wandrun.gateway.browser_stream.time.time", return_value=101.5):
            with self.assertRaisesRegex(RuntimeError, "CDP command failed"):
                await self.stream._input({
                    "t": "click", "id": 4, "x": 20, "y": 20, **self.credential(),
                })
        self.assertEqual(self.stream.pending[3], 3)
        self.offer(103)
        self.assertEqual(self.stream.pending[3], 3)
        self.assertEqual(len(self.stream._applied_dispatches), 1)
        self.browser.batch = None
        with patch("wandrun.gateway.browser_stream.time.time", return_value=104):
            await self.stream._input({
                "t": "text", "id": 6, "text": "new", **self.credential(),
            })
        self.offer(103)
        self.assertEqual(self.stream.pending[3], 3)  # Late older frame, not latest global id.
        self.offer(105)
        self.assertEqual(self.stream.pending[3], 6)
        self.offer(None)
        self.assertEqual(self.stream.pending[3], 0)
        touch = {"x": 20, "y": 20, **self.credential()}
        self.assertEqual((await self.stream._input({
            "t": "touch", "id": 7, "phase": "start", **touch,
        }))["t"], "input_pending")
        self.assertEqual((await self.stream._input({
            "t": "touch", "id": 8, "phase": "move", **touch,
        }))["t"], "input_pending")
        self.assertEqual(self.stream.pending[3], 0)
        with patch("wandrun.gateway.browser_stream.time.time", return_value=106):
            self.assertEqual((await self.stream._input({
                "t": "touch", "id": 9, "phase": "end", **touch,
            }))["t"], "input_done")
        self.offer(107)
        self.assertEqual(self.stream.pending[3], 9)
        with self.assertRaisesRegex(StreamRejected, "incomplete-gesture"):
            await self.stream._input({"t": "touch", "id": 10, "phase": "end", **touch})
        self.offer(108)
        self.assertEqual(self.stream.pending[3], 9)

    async def test_cdp_dispatch_boundary_is_after_transport_write_before_reply(self):
        cdp = CDPSocket("unused")
        trace = []

        class Transport:
            async def send(self, raw):
                trace.append(("write", json.loads(raw)["method"]))

        cdp.ws = Transport()
        request = asyncio.create_task(cdp.call(
            "Input.insertText", {"text": "x"},
            before_send=lambda: trace.append(("validate", None)),
            on_sent=lambda: trace.append(("sent", None)),
        ))
        async with asyncio.timeout(2):
            while len(trace) < 3:
                await asyncio.sleep(0)
        self.assertEqual(trace, [("validate", None), ("write", "Input.insertText"), ("sent", None)])
        self.assertFalse(request.done())
        next(iter(cdp._pending.values())).set_result({"result": {}})
        self.assertEqual(await request, {})

        def denied():
            raise StreamRejected("stale-frame")

        with self.assertRaisesRegex(StreamRejected, "stale-frame"):
            await cdp.call("Input.insertText", {"text": "x"}, before_send=denied,
                           on_sent=lambda: trace.append(("unexpected", None)))
        self.assertNotIn(("unexpected", None), trace)

    async def test_view_changes_clear_markers_and_drop_old_page_frames(self):
        self.credential()
        with patch("wandrun.gateway.browser_stream.time.time", return_value=100):
            self.assertEqual((await self.stream._input({
                "t": "text", "id": 5, "text": "a", **self.credential(),
            }))["t"], "input_done")
        self.offer(101)
        self.assertEqual(self.stream.pending[3], 5)
        self.offer(102)
        dropped_before_switch = self.stream.dropped_frames
        self.assertEqual(dropped_before_switch, 1)
        await self.stream._sync_pages("second")
        self.offer(110, target="first")
        self.assertIsNone(self.stream.pending)
        self.offer(110, target="second")
        self.assertEqual(self.stream.pending[3], 0)
        self.assertEqual(self.stream.dropped_frames, dropped_before_switch)
        await self.stream._sync_pages("first")
        self.offer(111)
        self.assertEqual(self.stream.pending[3], 0)
        self.browser.snapshot["epoch"] += 1
        self.stream._changed(self.browser.snapshot)
        self.offer(112)
        self.assertEqual(self.stream.pending[3], 0)

    @asynccontextmanager
    async def clocked_stream(self, *, fixed=None):
        """Drive real send/receive loops with a clock that never sleeps in wall time."""
        now = SimpleNamespace(value=100.0)
        sleepers = []

        async def sleep(delay):
            future = asyncio.get_running_loop().create_future()
            sleepers.append((now.value + delay, future))
            await future

        async def advance(seconds):
            now.value += seconds
            for deadline, future in tuple(sleepers):
                if deadline <= now.value:
                    sleepers.remove((deadline, future))
                    if not future.done():
                        future.set_result(None)
            for _ in range(3):
                await asyncio.sleep(0)

        self.stream.window = _FrameWindow(24, fixed)
        with (patch("wandrun.gateway.browser_stream.time.perf_counter", side_effect=lambda: now.value),
              patch("wandrun.gateway.browser_stream.time.time", side_effect=lambda: 1000 + now.value),
              patch("wandrun.gateway.browser_stream.asyncio", SimpleNamespace(**{
                  **vars(asyncio), "sleep": sleep,
              }))):
            receiver = asyncio.create_task(self.stream._receive())
            frames = asyncio.create_task(self.stream._frames())
            try:
                yield now, advance
            finally:
                receiver.cancel()
                frames.cancel()
                await asyncio.gather(receiver, frames, return_exceptions=True)
                await self.stream._cleanup()

    async def test_high_rtt_growth_and_bandwidth_drop_drain_without_credit_forgery(self):
        # Research §8 FIFO model, but actual BrowserStream loops/ACKs and quality
        # changes. Only transport serialization and the display clock are fake.
        async with self.clocked_stream() as (clock, advance):
            deliveries, samples, wire_free = [], [], clock.value
            first_lowered = first_cut = None
            peak_window = 2
            for tick in range(6000):
                elapsed = tick / 100
                for due, seq in tuple(deliveries):
                    if due <= clock.value:
                        deliveries.remove((due, seq))
                        await self.ack(seq)
                if tick % 2 == 0:
                    size = {"high": 68_000, "medium": 38_000, "low": 21_000}[self.stream.quality_tier]
                    self.offer(1000 + clock.value, tier=self.stream.quality_tier, size=size)
                await advance(.01)
                while not self.socket.outgoing.empty():
                    frame = self.socket.outgoing.get_nowait()
                    if frame["t"] != "frame":
                        continue
                    bandwidth = 50_000_000 if elapsed < 15 else 800_000
                    size = {"high": 68_000, "medium": 38_000, "low": 21_000}[frame["quality_tier"]]
                    wire_free = max(clock.value, wire_free) + (size + FRAME_OVERHEAD) * 8 / bandwidth
                    self.assertLessEqual(frame["in_flight_bytes"], MAX_IN_FLIGHT_BYTES)
                    deliveries.append((wire_free + .7 + .03, frame["seq"]))
                    samples.append((elapsed, frame["max_in_flight"], frame["queue_delay_ms"] or 0,
                                    len(self.stream.outstanding)))
                if elapsed < 15:
                    peak_window = max(peak_window, self.stream.max_in_flight)
                elif self.stream.quality_tier != "high" and first_lowered is None:
                    first_lowered = elapsed
                if elapsed >= 15 and self.stream.max_in_flight < peak_window and first_cut is None:
                    first_cut = elapsed
            broadband = [row for row in samples if 10 <= row[0] < 15]
            self.assertGreaterEqual(len(broadband) / 5, 10)
            self.assertLessEqual(peak_window, 32)
            self.assertIsNotNone(first_lowered)
            self.assertIsNotNone(first_cut)
            self.assertLess(first_cut, 30, "cut within 15s of the bandwidth drop")
            narrow = [row for row in samples if row[0] > 35]
            self.assertLess(max(row[2] for row in narrow), 1000)
            self.assertLess(min(row[1] for row in narrow), peak_window)
            self.assertGreater(len([row for row in samples if row[0] > 55]) / 5, 1)
            # Stop production: ACKs release actual in-flight entries, not timeouts.
            self.stream.pending = None
            if self.stream._idle_task is not None:
                self.stream._idle_task.cancel()
            for due, seq in sorted(deliveries):
                await advance(max(0, due - clock.value))
                await self.ack(seq)
                await advance(0)
            self.assertEqual(self.stream.outstanding, {})

    async def test_lost_acks_stop_at_learned_cap_and_fixed_override_never_adapts(self):
        for fixed in (None, 2):
            with self.subTest(fixed=fixed):
                self.stream._invalidate()
                self.stream._last_send_started = None
                async with self.clocked_stream(fixed=fixed) as (clock, advance):
                    # A 1s uncongested path needs more than the maximum allowance.
                    for _ in range(30):
                        self.offer(1000 + clock.value)
                        await advance(.05)
                        frame = await self.socket.outgoing.get()
                        await advance(1)
                        await self.ack(frame["seq"])
                        await advance(0)
                    cap = self.stream.max_in_flight
                    if fixed is None:
                        self.assertTrue(2 < cap <= 32)
                    else:
                        self.assertEqual(cap, fixed)
                    for _ in range(cap + 3):
                        self.offer(1000 + clock.value)
                        await advance(.05)
                    stopped = len(self.stream.outstanding)
                    self.assertGreaterEqual(stopped, 2)
                    self.assertLessEqual(stopped, cap)
                    self.assertEqual(self.socket.outgoing.qsize(), stopped)
                    await advance(120)
                    self.assertEqual(len(self.stream.outstanding), stopped)
                    self.assertEqual(self.socket.outgoing.qsize(), stopped)
                    while not self.socket.outgoing.empty():
                        self.socket.outgoing.get_nowait()

    async def test_page_and_viewport_switch_drop_old_credits_and_ack_samples(self):
        async with self.clocked_stream() as (clock, advance):
            for change in ("page", "viewport"):
                self.offer(1000 + clock.value, target=self.stream.page)
                await advance(.05)
                old = await self.socket.outgoing.get()
                if change == "page":
                    await self.stream._sync_pages("second")
                    await self.socket.outgoing.get()
                else:
                    self.stream._offer("second", {
                        "metadata": {"deviceWidth": 900, "deviceHeight": 600},
                        "data": base64.b64encode(b"\xff\xd8\xff\xd9").decode(),
                    })
                self.assertEqual(self.stream.outstanding, {})
                await self.ack(old["seq"])
                await advance(0)
                self.assertIsNone(self.stream.window.baseline_ms)
                self.offer(1000 + clock.value, target=self.stream.page)
                await advance(.05)
                new = await self.socket.outgoing.get()
                self.assertGreater(new["vp"], old["vp"])
                self.assertEqual(set(self.stream.outstanding), {new["seq"]})
                self.stream._invalidate()

    async def test_segment_timings_separate_credit_send_and_input_lock_wait(self):
        async with self.clocked_stream(fixed=1) as (clock, advance):
            original_send = self.socket.send_bytes

            async def slow_send(packet):
                await original_send(packet)
                await advance(.04)

            self.socket.send_bytes = slow_send
            self.offer(1000 + clock.value - .02)
            await advance(0)
            first = await self.socket.outgoing.get()
            self.assertAlmostEqual(first["frame_age_ms"], 20)
            self.offer(1000 + clock.value)
            await advance(0)
            await advance(.7)
            await self.ack(first["seq"])
            await advance(0)
            second = await self.socket.outgoing.get()
            self.assertAlmostEqual(second["credit_wait_ms"], 700)
            self.assertAlmostEqual(second["send_lock_ms"], 40)
            await self.stream._view_lock.acquire()
            await self.socket.incoming.put(json.dumps({
                "t": "click", "id": 9, "x": 10, "y": 10, **self.credential(second["seq"]),
            }))
            await advance(0)
            await advance(.2)

            async def dispatch(mark):
                await advance(.03)
                mark()

            self.browser.batch = dispatch
            self.stream._view_lock.release()
            await advance(0)
            reply = await self.socket.outgoing.get()
            self.assertEqual(reply["t"], "input_done")
            self.assertAlmostEqual(reply["input_lock_wait_ms"], 200)
            self.assertAlmostEqual(reply["input_cdp_ms"], 30)
            self.assertAlmostEqual(reply["input_dispatch_ms"], 230)
            with self.assertLogs("wandrun.gateway.browser_stream", level="INFO") as logs:
                self.stream._log_stats()
            record = json.loads(logs.output[0].split("[stream-stats] ", 1)[1])
            self.assertEqual(record["segments"]["input_lock_wait_ms"]["n"], 1)
            self.assertAlmostEqual(record["segments"]["input_lock_wait_ms"]["mean_ms"], 200)

    async def test_interval_logs_ack_bytes_turnaround_pause_and_connection(self):
        async with self.clocked_stream(fixed=1) as (clock, advance):
            self.stream._interval_mono_start = clock.value
            self.stream._interval_wall_start = 1000 + clock.value
            self.offer(1000 + clock.value, size=10_000)
            await advance(0)
            first = await self.socket.outgoing.get()
            packet_bytes = self.stream._packet_sizes[first["seq"]]
            self.offer(1000 + clock.value + .01, size=12_000)
            await advance(.1)
            await advance(.3)
            await self.ack(first["seq"])
            await advance(0)
            second = await self.socket.outgoing.get()
            with self.assertLogs("wandrun.gateway.browser_stream", level="INFO") as logs:
                self.stream._log_stats()
            record = json.loads(logs.output[0].split("[stream-stats] ", 1)[1])
            self.assertEqual(first["connection_id"], record["connection_id"])
            self.assertEqual(record["seq_first"], first["seq"])
            self.assertEqual(record["seq_last"], second["seq"])
            self.assertEqual((record["ack_seq_first"], record["ack_seq_last"]),
                             (first["seq"], first["seq"]))
            self.assertEqual((record["acked_jpeg_bytes"], record["acked_reserved_bytes"],
                              record["acked_packet_bytes_pre_compression"]),
                             (10_000, 10_000 + FRAME_OVERHEAD, packet_bytes))
            self.assertAlmostEqual(record["ack_turnaround_ms"]["p50"], 400)
            self.assertAlmostEqual(record["ack_turnaround_ms"]["p90"], 400)
            self.assertAlmostEqual(record["ack_turnaround_ms"]["max"], 400)
            self.assertAlmostEqual(record["pause_ms_by_reason"]["frame-credit"], 300)
            self.assertGreater(record["elapsed_s"], 0)
            self.assertLess(record["wall_start_s"], record["wall_end_s"])
            self.assertLess(record["monotonic_start_s"], record["monotonic_end_s"])


    async def test_encoder_await_cannot_make_credit_wait_negative(self):
        async with self.clocked_stream() as (clock, advance):
            self.stream.window.sample(clock.value, 730)
            self.stream.quality_tier = "medium"
            self.stream.window.quality_changed(clock.value - 1, "medium")
            self.stream.window.observe("medium", 30_000)
            self.stream.window._rates.append((clock.value, self.stream.fps * 32_048))
            self.stream.window.delivery_rate = self.stream.fps * 32_048
            self.stream.window._last_qualified_at = clock.value
            self.stream._quality_candidate, self.stream._quality_samples = "high", 5
            self.stream.outstanding[1] = (clock.value - .73, 30_000, "recovered", "medium")
            original_switch = self.stream._switch_quality

            async def replace_source(tier, reason):
                await original_switch(tier, reason)
                await advance(.03)
                # The producer starts a new credit wait during source replacement,
                # after the receiver timestamped this ACK.
                self.stream._credit_wait_started = clock.value
                await advance(.01)

            self.stream._switch_quality = replace_source
            await self.ack(1)
            await self.socket.incoming.put(json.dumps({"t": "ping", "id": 9}))
            self.assertEqual(await self.socket.outgoing.get(), {"t": "pong", "id": 9})
            self.assertAlmostEqual(self.stream._credit_wait_ms, 10)

    async def test_pong_lock_then_ack_cut_rechecks_credit_before_send(self):
        async with self.clocked_stream() as (clock, advance):
            self.offer(1000 + clock.value)
            await advance(0)
            first = await self.socket.outgoing.get()
            self.stream.window.sample(clock.value, 700)
            self.stream.window.limit = 4
            self.stream.window.delivery_rate = 25_000
            self.stream.outstanding = {
                first["seq"]: (clock.value - .7, 30_000, "initial", "high"),
                2: (clock.value - .5, 30_000, "initial", "high"),
                3: (clock.value - .4, 30_000, "initial", "high"),
            }
            self.stream.seq = 3
            entered, release = asyncio.Event(), asyncio.Event()
            original = self.socket.send_json

            async def pong(value):
                if value["t"] == "pong":
                    entered.set()
                    await release.wait()
                await original(value)

            self.socket.send_json = pong
            await self.socket.incoming.put(json.dumps({"t": "ping", "id": 90}))
            await entered.wait()
            # Let the frame pass its first credit check and wait on pong.
            self.stream.window.delivery_rate = None
            self.offer(1000 + clock.value, size=30_000)
            await advance(.05)
            self.assertTrue(self.stream._view_lock.locked())
            await advance(.3)
            self.stream.window.delivery_rate = 25_000
            await self.ack(first["seq"])
            release.set()
            await advance(0)
            self.assertEqual((await self.socket.outgoing.get())["t"], "pong")
            self.assertEqual(self.stream.max_in_flight, 2)
            self.assertEqual(set(self.stream.outstanding), {2, 3})
            self.assertTrue(self.socket.outgoing.empty())
            await self.ack(2)
            await self.ack(3)
            await advance(0)
            await advance(self.stream.window.interval(30_000 + FRAME_OVERHEAD))
            resumed = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual(resumed["seq"], 4)
            self.assertLessEqual(resumed["in_flight"], resumed["max_in_flight"])

    async def test_credit_wait_ends_before_slow_encoder_replacement(self):
        async with self.clocked_stream(fixed=1) as (clock, advance):
            self.stream.quality_tier = "medium"
            self.stream.window.quality_changed(clock.value - 1, "medium")
            self.stream.window.observe("medium", 30_000)
            self.stream.window._rates.append((clock.value, self.stream.fps * 32_048))
            self.stream.window.delivery_rate = self.stream.fps * 32_048
            self.stream.window._last_qualified_at = clock.value
            self.offer(1000 + clock.value, tier="medium", size=30_000)
            await advance(0)
            first = await self.socket.outgoing.get()
            self.stream._quality_candidate, self.stream._quality_samples = "high", 5
            self.offer(1000 + clock.value + .01, tier="medium")
            await advance(0)
            await advance(.1)
            original = self.stream._switch_quality

            async def slow_switch(tier, reason):
                await advance(.2)
                await original(tier, reason)

            self.stream._switch_quality = slow_switch
            await self.ack(first["seq"])
            await self.socket.incoming.put(json.dumps({"t": "ping", "id": 1}))
            await advance(0)
            self.assertEqual((await self.socket.outgoing.get())["t"], "pong")
            self.assertAlmostEqual(self.stream._credit_wait_ms, 100)
            self.assertEqual(self.stream.quality_tier, "high")

    async def test_final_stats_include_cancelled_send_even_if_cleanup_fails(self):
        entered = asyncio.Event()

        async def blocked_send(packet):
            entered.set()
            await asyncio.Future()

        self.socket.send_bytes = blocked_send
        stream_task = asyncio.create_task(self.stream.run())
        await self.socket.outgoing.get()  # hello
        self.offer(time.time())
        await asyncio.wait_for(entered.wait(), 2)

        async def broken_stop():
            raise RuntimeError("source cleanup failed")

        self.stream._stop_frames = broken_stop
        with self.assertLogs("wandrun.gateway.browser_stream", level="INFO") as logs:
            stream_task.cancel()
            result = await asyncio.gather(stream_task, return_exceptions=True)
        self.assertIsInstance(result[0], RuntimeError)
        record = json.loads(logs.output[-1].split("[stream-stats] ", 1)[1])
        self.assertEqual(record["segments"]["send_lock_ms"]["n"], 1)
        self.assertGreater(record["segments"]["send_lock_ms"]["max_ms"], 0)
        self.assertEqual(self.stream._segments, {})

    def test_jitter_does_not_starve_window_and_sparse_pairs_do_not_poison_rate(self):
        window = _FrameWindow(24, None)
        window.observe("high", 30_000)
        previous_ack = 0.0
        for index in range(500):
            sent = index * .04
            turnaround = .7 + (.2 if index % 11 == 0 else -.2 if index % 13 == 0 else 0)
            received = max(previous_ack + .001, sent + turnaround)
            previous_ack = received
            window.sample(received, (received - sent) * 1000)
            window.delivered(received, sent, 30_000, "high")
            window.adjust(received)
        self.assertGreater(window.limit, 2, "isolated high turnaround must not cut credits")
        self.assertLessEqual(window.limit, 32)
        self.assertGreater(window._sample_counts["qualified"], 0)
        rate = window.delivery_rate
        window.sample(25, 700)
        window.delivered(25, 23, 30_000, "high")
        self.assertEqual(window._sample_counts["not-busy"], 1)
        self.assertEqual(window.delivery_rate, rate)

    async def test_previous_encoder_ack_pair_measures_link_without_changing_current_quality(self):
        async with self.clocked_stream() as (clock, advance):
            self.stream.quality_tier = "medium"
            self.stream.window.quality_changed(clock.value, "medium")
            self.stream.window.observe("medium", 62_147)
            self.stream.outstanding = {
                1: (99.3, 77_309, "initial", "high"),
                2: (99.34, 77_309, "initial", "high"),
            }
            await self.ack(1)
            await advance(0)
            await advance(.8)
            await self.ack(2)
            await advance(0)
            self.assertAlmostEqual(self.stream.window.delivery_rate, (77_309 + FRAME_OVERHEAD) / .8)
            self.assertLess(self.stream.window.byte_budget(62_147 + FRAME_OVERHEAD), 200_000)
            self.assertEqual(self.stream.quality_tier, "medium")
            self.assertEqual(self.stream.outstanding, {})

    def test_adjustment_diagnostics_identify_rate_and_window_changes(self):
        window = _FrameWindow(24, None)
        window.observe("high", 25_000)
        window.sample(1, 700)
        window.delivered(1, .3, 25_000, "high")
        window.adjust(1)
        initial = window._adjustments[-1]
        self.assertEqual((initial["rate_reason"], initial["window_reason"]),
                         ("initial-demand", "bdp-growth"))
        window.sample(2, 1660)
        window.delivered(2, .34, 25_000, "high")
        window.adjust(2)
        decrease = window._adjustments[-1]
        self.assertEqual((decrease["rate_reason"], decrease["window_reason"]),
                         ("max-filter-update", "bdp-decrease"))
        self.assertGreater(decrease["old_rate_bps"], decrease["new_rate_bps"])
        self.assertGreater(decrease["old_window"], decrease["new_window"])
        self.assertAlmostEqual(decrease["send_gap_ms"], 40)
        self.assertAlmostEqual(decrease["ack_gap_ms"], 1000)

    def test_three_hour_rate_remains_finite_and_demand_bounded(self):
        window = _FrameWindow(24, None)
        window.observe("high", 25_000)
        window.sample(1, 730)
        window.delivered(1, .27, 25_000, "high")
        window.sample(1.5, 1190)
        window.delivered(1.5, .31, 25_000, "high")
        for second in range(2, 10_803):
            for offset in (0, .05):
                sent = second + offset
                now = sent + .73
                window.sample(now, 730)
                window.delivered(now, sent, 25_000, "high")
                window.adjust(now)
                self.assertLessEqual(window.delivery_rate, 24 * (25_000 + FRAME_OVERHEAD))
        self.assertTrue(math.isfinite(window.delivery_rate))
        self.assertTrue(math.isfinite(window.interval(27_048)))
        self.assertLessEqual(window.byte_budget(27_048), MAX_IN_FLIGHT_BYTES)
        self.assertLessEqual(window.limit, 32)

    async def test_view_invalidation_cannot_refund_unacknowledged_reserved_bytes(self):
        async with self.clocked_stream(fixed=2) as (clock, advance):
            self.offer(1000 + clock.value, size=600_000)
            await advance(0)
            old = await self.socket.outgoing.get()
            self.stream._invalidate()
            self.assertEqual(self.stream.outstanding, {})
            self.assertEqual(self.stream.in_flight_bytes, 600_000 + FRAME_OVERHEAD)
            self.offer(1000 + clock.value, size=600_000)
            await advance(.1)
            self.assertTrue(self.socket.outgoing.empty(), "old reliable-stream bytes still own budget")
            self.assertEqual(self.stream.stop_reason, "byte-credit")
            await self.ack(old["seq"], False)
            await advance(0)
            fresh = await self.socket.outgoing.get()
            self.assertGreater(fresh["vp"], old["vp"])
            self.assertIsNone(self.stream.window.baseline_ms, "old generation ACK must not train new view")
            self.assertEqual(fresh["in_flight_bytes"], 600_000 + FRAME_OVERHEAD)
            await self.ack(old["seq"], False)
            await advance(0)
            self.assertEqual(set(self.stream.outstanding), {fresh["seq"]})
            self.assertEqual(self.stream.in_flight_bytes, 600_000 + FRAME_OVERHEAD)

    def test_byte_ceiling_oldest_gate_and_high_rtt_keep_high_quality(self):
        window = _FrameWindow(24, None)
        window.observe("high", 68_000)
        window.sample(1, 730)
        window.limit = 24
        flight = {n: (.9, 68_000, "initial", "high") for n in range(14)}
        self.assertEqual(window.blocked(1, flight, 70_048), "byte-credit")
        fixed = _FrameWindow(24, 24)
        self.assertEqual(fixed.blocked(1, flight, 70_048), "byte-credit")
        self.assertEqual(window.blocked(2.5, {1: (.9, 1000, "initial", "high")}, 2000), "oldest-frame")
        self.assertEqual(window.quality("high", 200_000), ("high", "steady"))
        drain = _FrameWindow(24, None)
        drain.observe("high", 70_000)
        for index in range(100):
            sent = index / 18
            now = sent + .7
            drain.sample(now, 700)
            drain.delivered(now, sent, 70_000, "high")
        self.assertLess(drain.delivery_rate, .98 * 24 * 72_048)
        self.assertEqual(drain.quality("high", 70_000),
                         ("high", "steady"), "self-paced drain is not path capacity evidence")

    def test_baseline_rise_requires_drift_probe_and_post_drain_ack(self):
        window = _FrameWindow(24, None)
        window.observe("high", 25_000)
        window.sample(0, 700)
        for second in range(1, 12):
            window.sample(second, 1400, outstanding=8, started=second - 1.4)
            window.adjust(second)
        self.assertEqual(window.baseline_ms, 700)
        self.assertEqual(window.limit, 2)
        window.sample(12, 1400, outstanding=1, started=10.6)
        window.sample(12.5, 1400, outstanding=1, started=11.1)
        self.assertEqual(window.baseline_ms, 700, "old queued frames cannot raise baseline")
        window.sample(13.4, 900, outstanding=1, started=12.5)
        self.assertEqual(window.baseline_ms, 900)
        for second in range(14, 40):
            window.sample(second, 900, outstanding=8, started=second - .9)
            window.adjust(second)
        self.assertGreater(window.limit, 2, "stable paths must not be periodically drained")

    def test_sparse_growth_downgrades_but_stationary_jitter_does_not(self):
        window = _FrameWindow(24, None)
        window.observe("high", 70_000)
        for at, turnaround in ((0, 700), (1.5, 1300), (3, 1900)):
            window.sample(at, turnaround)
        window.delivery_rate = 100_000
        self.assertEqual(window.quality("high", 70_000), ("medium", "bandwidth"))
        jitter = _FrameWindow(24, None)
        jitter.observe("high", 70_000)
        jitter.delivery_rate = 1_000_000
        for index in range(300):
            jitter.sample(index / 10, 700 + (200 if index % 2 else -200))
            self.assertEqual(jitter.quality("high", 70_000), ("high", "steady"))
        startup = _FrameWindow(24, None)
        startup.observe("high", 70_000)
        startup.delivery_rate = 100_000
        for at, turnaround in ((0, 600), (.8, 800), (1.6, 1000),
                               (2.4, 700), (3.2, 900), (4, 1100)):
            startup.sample(at, turnaround)
            self.assertEqual(startup.quality("high", 70_000), ("high", "steady"),
                             "a short jitter ramp is not sustained path congestion")

    def test_settled_narrow_delivery_still_downgrades_without_queue_growth(self):
        window = _FrameWindow(24, None)
        window.observe("high", 70_000)
        for index in range(20):
            now = .7 + index * .5
            sent = 0 if index == 0 else .04 + (index - 1) * .5
            window.sample(now, (now - sent) * 1000)
            window.delivered(now, sent, 70_000, "high")
            candidate = window.quality("high", 70_000)
            if index < 5:
                self.assertEqual(candidate, ("high", "steady"))
        self.assertEqual(candidate, ("medium", "bandwidth"))

    def test_bandwidth_only_quality_and_demand_capped_recovery_trial(self):
        window = _FrameWindow(24, None)
        window.observe("high", 150_000)
        window.sample(1, 730)
        self.assertEqual(window.quality("high", 150_000), ("high", "steady"))
        window.quality_changed(2, "low")
        window.observe("low", 21_000)
        for index in range(40):
            sent = 2.5 + index / 24
            received = sent + .73
            window.sample(received, 730)
            window.delivered(received, sent, 21_000, "low")
        self.assertLessEqual(window.delivery_rate, 24 * (21_000 + FRAME_OVERHEAD))
        self.assertEqual(window.quality("low", 21_000),
                         ("medium", "recovered"))

    async def test_quality_filters_spikes_and_ignores_ineligible_recovery(self):
        receiver = asyncio.create_task(self.stream._receive())
        now, seq = 100.0, 0

        async def sample(wait_ms, *, tier=None, displayed=True, reason="initial", gap=.1):
            nonlocal now, seq
            seq += 1
            now += gap
            self.stream.outstanding[seq] = (
                now - wait_ms / 1000, 30_000, reason, tier or self.stream.quality_tier,
            )
            await self.ack(seq, displayed)
            await self.socket.incoming.put(json.dumps({"t": "ping", "id": seq}))
            self.assertEqual(await self.socket.outgoing.get(), {"t": "pong", "id": seq})

        try:
            with patch("wandrun.gateway.browser_stream.time.perf_counter", side_effect=lambda: now):
                for _ in range(20):
                    await sample(730)
                self.assertEqual(self.stream.quality_tier, "high", "high RTT alone is not a queue")
                await sample(1930)
                await sample(730)
                self.assertEqual(self.stream.quality_tier, "high", "isolated spike cannot switch encoder")
                # A sustained sparse growth period, not another isolated spike,
                # supplies congestion evidence to the displayed-ACK confirmation.
                for index in range(20):
                    # Send gaps stay busy (40ms); increasing serialization
                    # stretches ACK gaps to 500ms.
                    await sample(730 + index * 460, gap=.5)
                    if self.stream.quality_tier == "medium":
                        break
                self.assertEqual(self.stream.quality_tier, "medium")
                # Skips/old encoders still measure the path but cannot promote quality.
                for _ in range(30):
                    await sample(730, displayed=False)
                    await sample(730, tier="high")
                    await sample(730, reason="idle-refresh")
                self.assertEqual(self.stream.quality_tier, "medium")
                for _ in range(5):
                    await sample(730)
                self.assertEqual(self.stream.quality_tier, "medium",
                                 "an idle or slow source must not imply bandwidth recovery")
                for _ in range(5):
                    await sample(730, gap=.04)
                self.assertEqual(self.stream.quality_tier, "medium")
                await sample(730, gap=.04)
                self.assertEqual((self.stream.quality_tier, self.stream.quality_reason),
                                 ("high", "recovered"))
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            await self.stream._cleanup()

    async def test_hello_advertises_requested_fps_and_window(self):
        stream = BrowserStream(self.socket, self.browser, "lease", fps=30, max_in_flight=3)
        task = asyncio.create_task(stream.run())
        try:
            hello = await asyncio.wait_for(self.socket.outgoing.get(), 2)
            self.assertEqual((hello["fps_limit"], hello["max_in_flight"]), (30, 3))
            self.assertEqual(hello["connection_id"], stream.connection_id)
            self.assertEqual(hello["max_in_flight_limit"], 32)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_two_viewers_change_sources_independently_without_relabeling(self):
        other_socket = type(self.socket)()
        other = BrowserStream(other_socket, self.browser, "lease", fps=30)
        await other._sync_pages()
        await other_socket.outgoing.get()
        receiver = asyncio.create_task(self.stream._receive())
        self.stream.window.sample(time.perf_counter(), 50)
        frames = asyncio.create_task(self.stream._frames())
        other_frames = asyncio.create_task(other._frames())

        scroll = 0
        async def emit(tier):
            nonlocal scroll
            scroll += 1
            for callback, (target, source_tier) in tuple(self.browser.subscriptions.items()):
                if source_tier == tier:
                    callback({"metadata": {"deviceWidth": 800, "deviceHeight": 600, "scrollOffsetY": scroll},
                              "data": base64.b64encode(b"\xff\xd8\xff\xd9").decode(),
                              "_epoch": self.browser.snapshot["epoch"], "_revision": 0,
                              "_quality_tier": tier})
            return await asyncio.wait_for(self.socket.outgoing.get(), 2)


        try:
            high1 = await emit("high")
            self.assertEqual((high1["quality_tier"], high1["quality_reason"]), ("high", "initial"))
            fast = await asyncio.wait_for(other_socket.outgoing.get(), 2)
            self.assertEqual((fast["quality_tier"], fast["css"]), ("high", [800, 600]))
            high2 = await emit("high")
            await self.stream._switch_quality("medium", "bandwidth")
            await self.ack(high1["seq"])
            await self.ack(high2["seq"])
            self.assertEqual(other.quality_tier, "high")
            medium1 = await emit("medium")
            self.assertEqual((medium1["quality_tier"], medium1["quality_reason"]),
                             ("medium", "bandwidth"))
            medium2 = await emit("medium")
            await self.stream._switch_quality("low", "bandwidth")
            await self.ack(medium1["seq"])
            await self.ack(medium2["seq"])
            low = await emit("low")
            self.assertEqual((low["quality_tier"], low["css"], low["vp"]),
                             ("low", [800, 600], high1["vp"]))
            self.assertEqual(other.quality_tier, "high")
            with self.assertRaisesRegex(StreamRejected, "out-of-bounds"):
                await self.stream._input({"t": "click", "id": 9, "x": 800, "y": 599,
                                          "epoch": low["epoch"], "vp": low["vp"],
                                          "frame": low["seq"]})
            self.assertEqual((await self.stream._input({
                "t": "click", "id": 10, "x": 799, "y": 599,
                "epoch": low["epoch"], "vp": low["vp"], "frame": low["seq"],
            }))["t"], "input_done")
            self.browser.snapshot["pages"][0]["revision"] += 1
            self.stream._changed(self.browser.snapshot)
            self.offer(1, tier="low", revision=0)
            self.assertIsNone(self.stream.pending)
            with self.assertRaisesRegex(StreamRejected, "stale-viewport"):
                self.stream._validate_input({"epoch": low["epoch"], "vp": low["vp"],
                                             "frame": low["seq"]})
            self.browser.snapshot["epoch"] += 1
            self.stream._changed(self.browser.snapshot)
            self.offer(1, tier="low", epoch=self.browser.snapshot["epoch"] - 1)
            self.assertIsNone(self.stream.pending)
            with self.assertRaisesRegex(StreamRejected, "stale-epoch"):
                self.stream._validate_input({"epoch": high1["epoch"], "vp": high1["vp"],
                                             "frame": high1["seq"]})
        finally:
            receiver.cancel()
            frames.cancel()
            other_frames.cancel()
            self.stream._invalidate()
            await asyncio.gather(receiver, frames, other_frames, return_exceptions=True)
            await self.stream._stop_frames()
            await other._stop_frames()

    async def test_idle_sharp_frame_is_once_and_navigation_discards_late_screenshot(self):
        self.stream.quality_tier = "low"
        capture_page_call = self.browser.page_call
        async def echo_during_capture(*args, **kwargs):
            if args[2] == "Page.captureScreenshot" and not self.browser.capture_calls:
                self.offer(1, tier="low")
            return await capture_page_call(*args, **kwargs)
        self.browser.page_call = echo_during_capture
        receiver = asyncio.create_task(self.stream._receive())
        frames = asyncio.create_task(self.stream._frames())
        try:
            with patch("wandrun.gateway.browser_stream.IDLE_REFRESH_SECONDS", .01):
                self.offer(1, tier="low")
                low = await asyncio.wait_for(self.socket.outgoing.get(), 2)
                high = await asyncio.wait_for(self.socket.outgoing.get(), 2)
                self.assertEqual((low["quality_tier"], high["quality_tier"],
                                  high["quality_reason"]), ("low", "high", "idle-refresh"))
                self.assertEqual(low["vp"], high["vp"])
                self.assertEqual(high["css"], [800, 600])
                self.assertEqual(len(self.browser.capture_calls), 1)
                await self.ack(low["seq"])
                await self.ack(high["seq"])
                await self.credits(0)
                self.offer(1, tier="low")  # A late screenshot-induced duplicate cannot replace the sharp frame.
                await asyncio.sleep(.04)
                self.assertTrue(self.socket.outgoing.empty())
                self.offer(2, tier="low")
                await asyncio.wait_for(self.socket.outgoing.get(), 2)
                captured = asyncio.Event()
                release = asyncio.Event()
                page_call = self.browser.page_call

                async def delayed(*args, **kwargs):
                    if args[2] == "Page.captureScreenshot":
                        captured.set()
                        await release.wait()
                    return await page_call(*args, **kwargs)

                self.browser.page_call = delayed
                await asyncio.wait_for(captured.wait(), 2)
                self.browser.snapshot["pages"][0]["revision"] += 1
                self.stream._changed(self.browser.snapshot)
                release.set()
                await asyncio.sleep(.04)
                self.assertTrue(self.socket.outgoing.empty())
                self.assertIsNone(self.stream.pending)
        finally:
            self.stream._invalidate()
            receiver.cancel()
            frames.cancel()
            await asyncio.gather(receiver, frames, return_exceptions=True)


@unittest.skipUnless(shutil.which("Xvfb") and shutil.which("google-chrome"), "需要 Xvfb 与 Google Chrome")
class BrowserStreamTests(unittest.TestCase):
    def test_address_bar_valid_url_navigates_real_chrome(self):
        with ChromeDev() as chrome:
            asyncio.run(self.address_bar_navigation(chrome.cdp_url))

    async def address_bar_navigation(self, cdp_url):
        async def serve(reader, writer):
            try:
                await reader.readuntil(b"\r\n\r\n")
                body = b"<title>Address bar regression</title><h1>Navigated</h1>"
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: "
                             + str(len(body)).encode() + b"\r\nConnection: close\r\n\r\n" + body)
                await writer.drain()
            except asyncio.IncompleteReadError:
                pass  # Chrome may close a speculative HTTP connection unused.
            finally:
                writer.close()
                await writer.wait_closed()
        http_server = await asyncio.start_server(serve, "127.0.0.1", 0)
        url = f"http://127.0.0.1:{http_server.sockets[0].getsockname()[1]}/address"
        leases = BrowserLeases(BrowserDefinition(cdp_url=cdp_url, idle_timeout=0))
        await leases.start()
        try:
            leases.register("address-bar", "root", "worker", "entry")
            env = await leases.command_environment("address-bar")
            async with httpx.AsyncClient() as http:
                endpoint = (await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")).json()["webSocketDebuggerUrl"]
            async with connect(endpoint) as agent:
                await agent.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                await agent.recv()
                ident = leases.lease_for_task("address-bar")
                human = await leases.takeover(ident)
                async with stream_server(leases) as origin, connect(
                    f"{origin}/browser-tasks/{ident}/stream?mode=control",
                    additional_headers={"Authorization": "Bearer stream-test-token"},
                ) as ws:
                    viewer = Viewer(ws)
                    shown = await viewer.frame(human["epoch"])
                    reply = await viewer.command("navigate", shown, url=url)
                    self.assertEqual(reply["t"], "input_done")
                    async with asyncio.timeout(5):
                        while True:
                            page = leases.detail(ident)["current"]
                            result = await leases.page_call(ident, page, "Runtime.evaluate", {
                                "expression": "document.title", "returnByValue": True})
                            if result["result"].get("value") == "Address bar regression":
                                break
                            await asyncio.sleep(.01)
                    self.assertEqual((await viewer.command("ping"))["t"], "pong")
        finally:
            await leases.aclose()
            http_server.close()
            await http_server.wait_closed()

    def test_known_navigation_rejects_whole_gesture_with_ack_backlog(self):
        with ChromeDev() as chrome:
            asyncio.run(self.known_navigation(chrome.cdp_url))

    async def known_navigation(self, cdp_url):
        leases = BrowserLeases(BrowserDefinition(cdp_url=cdp_url, idle_timeout=0))
        await leases.start()
        try:
            leases.register("queued-frame", "root", "worker", "entry")
            env = await leases.command_environment("queued-frame")
            async with httpx.AsyncClient() as http:
                endpoint = (await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")).json()["webSocketDebuggerUrl"]
            async with connect(endpoint) as agent:
                await agent.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                self.assertIn("result", json.loads(await agent.recv()))
                ident = leases.lease_for_task("queued-frame")
                target = leases.detail(ident)["current"]
                human = await leases.takeover(ident)
                navigation = CDPSocket(leases._page_ws(target))
                await navigation.open()
                try:
                    html = '<input id="field" autofocus><script>window.presses=0;onmousedown=()=>presses++;setInterval(()=>document.body.style.background=`rgb(${Date.now()%255},200,200)`,80)</script>'
                    url = "data:text/html;base64," + base64.b64encode(html.encode()).decode()
                    await navigation.call("Page.navigate", {"url": url})
                    async with stream_server(leases) as origin, connect(
                        f"{origin}/browser-tasks/{ident}/stream?mode=control",
                        additional_headers={"Authorization": "Bearer stream-test-token"},
                    ) as ws:
                        viewer = Viewer(ws)
                        for barrier in ("lease", "transport"):
                            with self.subTest(barrier=barrier):
                                shown = await viewer.frame(human["epoch"])
                                entered = asyncio.Event()
                                original = leases.human_batch
                                async def queued(*args, **kwargs):
                                    entered.set()
                                    return await original(*args, **kwargs)
                                lease = leases._get(ident)
                                page = lease.pages[target]
                                lock = lease.lock if barrier == "lease" else page.cdp._send_lock
                                ack_queued = asyncio.Event()
                                notify = page.cdp.notify
                                def acknowledge(method, params):
                                    notify(method, params)
                                    if method == "Page.screencastFrameAck":
                                        ack_queued.set()
                                with patch.object(leases, "human_batch", side_effect=queued), patch.object(
                                    page.cdp, "notify", side_effect=acknowledge,
                                ):
                                    async with lock:
                                        command = asyncio.create_task(viewer.command("click", shown, x=20, y=20))
                                        await asyncio.wait_for(entered.wait(), 3)
                                        await asyncio.wait_for(ack_queued.wait(), 3)
                                        revision = lease.pages[target].revision
                                        await navigation.call("Page.navigate", {"url": url + "#" + barrier})
                                        # A new document, not merely a fragment change.
                                        await navigation.call("Page.reload")
                                        async with asyncio.timeout(3):
                                            while lease.pages[target].revision == revision:
                                                await asyncio.sleep(.01)
                                    rejected = await command
                                self.assertEqual(rejected["t"], "reject")
                                self.assertIn(rejected["why"], ("stale-viewport", "stale-frame"))
                                result = await navigation.call("Runtime.evaluate", {
                                    "expression": "[field.value, presses]", "returnByValue": True})
                                self.assertEqual(result["result"]["value"], ["", 0])
                                self.assertEqual(lease.mouse, {})
                                fresh = await viewer.frame(human["epoch"])
                                accepted = await viewer.command("text", fresh, text="FRESH")
                                self.assertEqual(accepted["t"], "input_done")
                                result = await navigation.call("Runtime.evaluate", {
                                    "expression": "field.value", "returnByValue": True})
                                self.assertEqual(result["result"]["value"], "FRESH")
                finally:
                    await navigation.close()
        finally:
            await leases.aclose()

    def test_navigation_during_gesture_does_not_split_release(self):
        with ChromeDev() as chrome:
            asyncio.run(self.gesture_navigation(chrome.cdp_url))

    async def gesture_navigation(self, cdp_url):
        leases = BrowserLeases(BrowserDefinition(cdp_url=cdp_url, idle_timeout=0))
        await leases.start()
        try:
            leases.register("gesture", "root", "worker", "entry")
            env = await leases.command_environment("gesture")
            async with httpx.AsyncClient() as http:
                endpoint = (await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")).json()["webSocketDebuggerUrl"]
            async with connect(endpoint) as agent:
                await agent.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                self.assertIn("result", json.loads(await agent.recv()))
                ident = leases.lease_for_task("gesture")
                human = await leases.takeover(ident)
                lease = leases._get(ident)
                page = lease.pages[lease.current]
                navigation = CDPSocket(leases._page_ws(page.id))
                await navigation.open()
                try:
                    url = "data:text/html,<input id=field autofocus>"
                    await navigation.call("Page.navigate", {"url": url})
                    async with stream_server(leases) as origin, connect(
                        f"{origin}/browser-tasks/{ident}/stream?mode=control",
                        additional_headers={"Authorization": "Bearer stream-test-token"},
                    ) as ws:
                        viewer = Viewer(ws)
                        call = page.cdp.call
                        for gesture in ("click", "key", "mouse", "touch"):
                            with self.subTest(gesture=gesture):
                                shown = await viewer.frame(human["epoch"])
                                async def navigate_after_press(method, params=None, **kwargs):
                                    result = await call(method, params, **kwargs)
                                    if (params or {}).get("type") in ("mousePressed", "rawKeyDown", "touchStart"):
                                        revision = page.revision
                                        await navigation.call("Page.reload")
                                        async with asyncio.timeout(3):
                                            while page.revision == revision:
                                                await asyncio.sleep(.01)
                                        await navigation.call("Runtime.evaluate", {
                                            "expression": "window.releases=0;onmouseup=onkeyup=ontouchend=()=>releases++;field.focus()"})
                                    return result
                                with patch.object(page.cdp, "call", side_effect=navigate_after_press):
                                    if gesture == "key":
                                        reply = await viewer.command("key", shown, key="Shift", code="ShiftLeft", vk=16)
                                    elif gesture in ("mouse", "touch"):
                                        down = {"x": 20, "y": 20}
                                        if gesture == "touch":
                                            down["phase"] = "start"
                                        pending = await viewer.command("down" if gesture == "mouse" else "touch", shown, **down)
                                        self.assertEqual(pending["t"], "input_pending")
                                        self.assertEqual(lease.mouse, {})
                                        self.assertIsNone(lease.touching)
                                        if gesture == "touch":
                                            down["phase"] = "end"
                                        reply = await viewer.command("up" if gesture == "mouse" else "touch", shown, **down)
                                    else:
                                        reply = await viewer.command("click", shown, x=20, y=20)
                                self.assertEqual(reply["t"], "input_done", reply)
                                self.assertEqual(lease.mouse, {})
                                self.assertEqual(lease.keys, {})
                                self.assertIsNone(lease.touching)
                                result = await navigation.call("Runtime.evaluate", {
                                    "expression": "releases", "returnByValue": True})
                                # Chrome cancels active touch points on navigation;
                                # mouse/key release still reaches the new document.
                                if gesture != "touch":
                                    self.assertEqual(result["result"]["value"], 1)
                        released_before_handback = result["result"]["value"]
                        await leases.handback(ident)
                        result = await navigation.call("Runtime.evaluate", {
                            "expression": "releases", "returnByValue": True})
                        self.assertEqual(result["result"]["value"], released_before_handback)
                finally:
                    await navigation.close()
        finally:
            await leases.aclose()

    def test_staged_gesture_credentials_and_assembly(self):
        with ChromeDev() as chrome:
            asyncio.run(self.staged_gestures(chrome.cdp_url))

    async def staged_gestures(self, cdp_url):
        leases = BrowserLeases(BrowserDefinition(cdp_url=cdp_url, idle_timeout=0))
        await leases.start()
        try:
            leases.register("staged", "root", "worker", "entry")
            env = await leases.command_environment("staged")
            async with httpx.AsyncClient() as http:
                endpoint = (await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")).json()["webSocketDebuggerUrl"]
            async with connect(endpoint) as agent:
                await agent.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                self.assertIn("result", json.loads(await agent.recv()))
                ident = leases.lease_for_task("staged")
                lease = leases._get(ident)
                page = lease.pages[lease.current]
                await agent.send(json.dumps({"id": 2, "method": "Target.createTarget",
                                                 "params": {"url": "about:blank"}}))
                async with asyncio.timeout(10):
                    while True:
                        created = json.loads(await agent.recv())
                        if created.get("id") == 2:
                            other_page = created["result"]["targetId"]
                            break
                human = await leases.takeover(ident)
                navigation = CDPSocket(leases._page_ws(page.id))
                await navigation.open()
                try:
                    html = ("""<div id="tick"></div><script>
                        window.events=[];
                        for(const type of ['mousedown','mouseup','touchstart','touchend','mousemove'])
                          document.addEventListener(type,e=>events.push([type,e.button]));
                        setInterval(()=>tick.textContent=Date.now(),40);
                        </script>""")
                    url = "data:text/html;base64," + base64.b64encode(html.encode()).decode()
                    await navigation.call("Page.navigate", {"url": url})
                    async with stream_server(leases) as origin, connect(
                        f"{origin}/browser-tasks/{ident}/stream?mode=control",
                        additional_headers={"Authorization": "Bearer stream-test-token"},
                    ) as ws:
                        viewer = Viewer(ws)
                        async def events():
                            result = await navigation.call("Runtime.evaluate", {
                                "expression": "window.events", "returnByValue": True})
                            return result["result"]["value"]
                        async def clear_events():
                            await navigation.call("Runtime.evaluate", {"expression": "events=[]"})
                        for family in ("mouse", "touch"):
                            with self.subTest(evicted_start=family):
                                await clear_events()
                                shown = await viewer.frame(human["epoch"])
                                start = "down" if family == "mouse" else "touch"
                                end = "up" if family == "mouse" else "touch"
                                phase = {} if family == "mouse" else {"phase": "start"}
                                reply = await viewer.command(start, shown, x=20, y=20, **phase)
                                self.assertEqual(reply["t"], "input_pending")
                                self.assertEqual(await events(), [])
                                self.assertEqual(lease.mouse, {})
                                self.assertIsNone(lease.touching)
                                latest = shown
                                for _ in range(35):
                                    newer = await viewer.frame(human["epoch"])
                                    self.assertGreater(newer["seq"], latest["seq"])
                                    latest = newer
                                self.assertGreaterEqual(latest["seq"] - shown["seq"], 35)
                                phase = {} if family == "mouse" else {"phase": "end"}
                                reply = await viewer.command(end, shown, x=20, y=20, **phase)
                                self.assertEqual(reply["t"], "input_done", reply)
                                names = [event[0] for event in await events()]
                                self.assertIn("mousedown" if family == "mouse" else "touchstart", names)
                                self.assertIn("mouseup" if family == "mouse" else "touchend", names)
                                self.assertEqual(lease.mouse, {})
                                self.assertIsNone(lease.touching)
                                self.assertEqual((await viewer.command(
                                    start, shown, x=20, y=20,
                                    **({} if family == "mouse" else {"phase": "start"})))["why"], "stale-frame")

                        await clear_events()
                        shown = await viewer.frame(human["epoch"])
                        self.assertEqual((await viewer.command("down", shown, x=20, y=20))["t"], "input_pending")
                        self.assertEqual((await viewer.command(
                            "down", shown, x=30, y=30, button="right"))["t"], "input_pending")
                        self.assertEqual(await events(), [])
                        self.assertEqual((await viewer.command(
                            "up", shown, x=30, y=30, button="right"))["t"], "input_done")
                        self.assertEqual(await events(), [["mousedown", 2], ["mouseup", 2]])

                        await clear_events()
                        shown = await viewer.frame(human["epoch"])
                        self.assertEqual((await viewer.command("down", shown, x=20, y=20))["t"], "input_pending")
                        for _ in range(255):
                            self.assertEqual((await viewer.command(
                                "move", shown, x=21, y=21, buttons=1))["t"], "input_pending")
                        self.assertEqual((await viewer.command(
                            "up", shown, x=21, y=21))["why"], "invalid-gesture")
                        self.assertEqual(await events(), [])
                        self.assertEqual(lease.mouse, {})

                        for change in ("document", "viewport", "page", "epoch"):
                            with self.subTest(invalidated_start=change):
                                await clear_events()
                                shown = await viewer.frame(human["epoch"])
                                self.assertEqual((await viewer.command(
                                    "down", shown, x=20, y=20))["t"], "input_pending")
                                if change == "document":
                                    revision = page.revision
                                    await navigation.call("Page.reload")
                                    async with asyncio.timeout(5):
                                        while page.revision == revision:
                                            await asyncio.sleep(.01)
                                    await viewer.until(
                                        lambda m: m["t"] == "frame" and m["vp"] != shown["vp"])
                                elif change == "viewport":
                                    await navigation.call("Emulation.setDeviceMetricsOverride", {
                                        "width": shown["css"][0] - 100, "height": shown["css"][1],
                                        "deviceScaleFactor": 1, "mobile": False})
                                    await viewer.until(lambda m: m["t"] == "frame" and m["vp"] != shown["vp"])
                                elif change == "page":
                                    self.assertEqual((await viewer.command(
                                        "switch_page", target=other_page))["t"], "page_done")
                                else:
                                    await leases.handback(ident)
                                    human = await leases.takeover(ident)
                                reply = await viewer.command("up", shown, x=20, y=20)
                                self.assertEqual(reply["t"], "reject", reply)
                                self.assertEqual(reply["why"], "stale-epoch" if change == "epoch" else "stale-viewport")
                                self.assertEqual(await events(), [])
                                self.assertEqual(lease.mouse, {})
                                if change == "page":
                                    self.assertEqual((await viewer.command(
                                        "switch_page", target=page.id))["t"], "page_done")
                finally:
                    await navigation.close()
        finally:
            await leases.aclose()

    def test_binary_view_control_generations_and_disconnect(self):
        with self.assertNoLogs("uvicorn.error", level="ERROR"), ChromeDev() as chrome:
            asyncio.run(self.exercise(chrome.cdp_url))

    async def exercise(self, cdp_url):
        leases = BrowserLeases(BrowserDefinition(cdp_url=cdp_url, max_pages=3, idle_timeout=0))
        await leases.start()
        try:
            leases.register("owner", "root", "worker", "entry")
            environment = await leases.command_environment("owner")
            endpoint = environment["WANDRUN_BROWSER_CDP"]
            if endpoint.startswith("http"):
                async with httpx.AsyncClient() as http:
                    endpoint = (await http.get(endpoint.rstrip("/") + "/json/version")).json()["webSocketDebuggerUrl"]
            async with connect(endpoint) as agent:
                await agent.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                async with asyncio.timeout(10):
                    while True:
                        allocated = json.loads(await agent.recv())
                        if allocated.get("id") == 1:
                            self.assertIn("result", allocated)
                            break
                lease_id = leases.lease_for_task("owner")
                page = leases.detail(lease_id)["pages"][0]["id"]
                command_id = 1
                async def agent_call(method, params, **extra):
                    nonlocal command_id
                    command_id += 1
                    await agent.send(json.dumps({"id": command_id, "method": method, "params": params, **extra}))
                    async with asyncio.timeout(10):
                        while True:
                            reply = json.loads(await agent.recv())
                            if reply.get("id") == command_id:
                                self.assertIn("result", reply)
                                return reply["result"]
                # Animated page gives frames even when input is rejected or a viewer stops ACKing.
                html = '<input id="field" autofocus><div id="tick"></div><script>setInterval(()=>tick.textContent=Date.now(),80)</script>'
                url = "data:text/html;base64," + base64.b64encode(html.encode()).decode()
                attached = await agent_call("Target.attachToTarget", {"targetId": page, "flatten": True})
                await agent_call("Page.navigate", {"url": url}, sessionId=attached["sessionId"])
                async def value():
                    reply = await leases.page_call(lease_id, page, "Runtime.evaluate", {
                        "expression": "document.querySelector('#field')?.value", "returnByValue": True})
                    return reply["result"].get("value")
                async with asyncio.timeout(10):
                    while await value() is None:
                        await asyncio.sleep(.01)
                second_page = (await agent_call("Target.createTarget", {"url": url}))["targetId"]
                async with stream_server(leases) as origin:
                    path = f"{origin}/browser-tasks/{lease_id}/stream"
                    with self.assertRaises(InvalidStatus):
                        async with connect(path):
                            self.fail("unauthenticated viewer was accepted")
                    headers = {"Authorization": "Bearer stream-test-token"}
                    async with connect(path, additional_headers=headers) as view_ws:
                        viewer = Viewer(view_ws)
                        page_list = await viewer.until(lambda message: message["t"] == "pages")
                        self.assertEqual(page_list["max_pages"], 3)
                        before = await viewer.frame()
                        self.assertEqual(before["page"], page)
                        self.assertGreater(before["css"][0], 100)
                        self.assertEqual((await viewer.command("text", before, text="forbidden"))["why"], "read-only")
                        self.assertEqual((await viewer.command("new_page", epoch=leases.detail(lease_id)["epoch"]))["why"],
                                         "read-only")
                        takeover = await leases.takeover(lease_id)
                        epoch = takeover["epoch"]
                        view_frame = await viewer.frame(epoch)
                        self.assertEqual((await viewer.command("text", view_frame, text="forbidden"))["why"], "read-only")
                        self.assertEqual((await viewer.command("new_page", epoch=epoch))["why"], "read-only")
                        async with connect(path + "?mode=control", additional_headers=headers) as human_ws:
                            human = Viewer(human_ws)
                            shown = await human.frame(epoch)
                            self.assertEqual((await human.command("text", shown, text="human"))["t"], "input_done")
                            self.assertEqual(await value(), "human")
                            reply = await human.command("click", shown, x=-1, y=4, button="left")
                            self.assertEqual(reply["why"], "out-of-bounds")
                            self.assertEqual((await human.command("new_page", epoch=epoch - 1))["why"],
                                             "stale-epoch")
                            self.assertEqual(len(leases.detail(lease_id)["pages"]), 2)
                            created = await human.command("new_page", epoch=epoch)
                            self.assertEqual((created["t"], created["epoch"]), ("page_done", epoch))
                            new_page = created["target"]
                            self.assertEqual(len(leases.detail(lease_id)["pages"]), 3)
                            self.assertEqual(leases.detail(lease_id)["current"], page)
                            self.assertEqual((await human.command("new_page", epoch=epoch))["t"], "reject")
                            self.assertEqual(len(leases.detail(lease_id)["pages"]), 3)
                            self.assertEqual((await human.current_frame(new_page, epoch))["page"], new_page)
                            self.assertEqual((await viewer.frame(epoch))["page"], page)
                            self.assertEqual((await human.command("switch_page", target=second_page))["t"], "page_done")
                            switched = await human.until(lambda m: m["t"] == "frame" and m["page"] == second_page)
                            self.assertEqual((await human.command("text", shown, text="wrong-page"))["why"], "stale-viewport")
                            self.assertEqual((await human.command("text", switched, text="second"))["t"], "input_done")
                            self.assertEqual(await value(), "human")
                            second_value = await leases.page_call(lease_id, second_page, "Runtime.evaluate", {
                                "expression": "document.querySelector('#field').value", "returnByValue": True,
                            })
                            self.assertEqual(second_value["result"]["value"], "second")
                            # A viewer's page selection does not switch another viewer.
                            self.assertEqual((await viewer.frame(epoch))["page"], page)
                            await human.command("switch_page", target=page)
                            shown = await human.until(lambda m: m["t"] == "frame" and m["page"] == page)
                            await leases.handback(lease_id)
                            self.assertEqual((await human.command("new_page", epoch=epoch))["why"],
                                             "stale-epoch")
                            self.assertEqual(len(leases.detail(lease_id)["pages"]), 3)
                            self.assertEqual((await human.command("text", shown, text="old"))["why"], "not-human")
                            again = await leases.takeover(lease_id)
                            self.assertEqual((await human.command("text", shown, text="old"))["why"], "stale-epoch")
                            fresh = await human.frame(again["epoch"])
                            await human.command("reload", fresh)
                            reply = await human.command("text", fresh, text="old-document")
                            self.assertIn(reply["why"], ("stale-viewport", "stale-frame"))
                            async with asyncio.timeout(10):
                                while await value() is None:
                                    await asyncio.sleep(.01)
                            self.assertEqual(await value(), "")
                            recovered = await human.frame(again["epoch"])
                            self.assertEqual((await human.command("text", recovered, text="new-document"))["t"], "input_done")
                            self.assertEqual(await value(), "new-document")
                            async with connect(path, additional_headers=headers) as slow:
                                async def raw_frame():
                                    async with asyncio.timeout(10):
                                        while True:
                                            raw = await slow.recv()
                                            if isinstance(raw, bytes):
                                                size = struct.unpack("!I", raw[:4])[0]
                                                return json.loads(raw[4:4 + size]), raw[4 + size:]
                                first_slow, _ = await raw_frame()
                                await raw_frame()  # Fill the two-credit window without ACKs.
                                for color in ("blue", "lime"):
                                    await leases.page_call(lease_id, page, "Runtime.evaluate", {
                                        "expression": f"document.body.style.background={json.dumps(color)};"
                                                      "new Promise(r=>setTimeout(r,150))",
                                        "awaitPromise": True,
                                    })
                                await slow.send(json.dumps({
                                    "t": "ack", "seq": first_slow["seq"], "displayed": False,
                                }))
                                _, newest = await raw_frame()
                                jpeg = base64.b64encode(newest).decode()
                                decoded = await leases.page_call(lease_id, page, "Runtime.evaluate", {
                                    "expression": "(async()=>{let i=new Image();i.src='data:image/jpeg;base64,"
                                                  + jpeg + "';await i.decode();let c=document.createElement('canvas');"
                                                  "c.width=c.height=1;let g=c.getContext('2d');"
                                                  "g.drawImage(i,2,2,1,1,0,0,1,1);"
                                                  "return [...g.getImageData(0,0,1,1).data]})()",
                                    "returnByValue": True, "awaitPromise": True,
                                })
                                red, green, blue, _ = decoded["result"]["value"]
                                self.assertLess(red, 20)
                                self.assertGreater(green, 235)
                                self.assertLess(blue, 20)
                            await leases.close(lease_id, "用户关闭")
                            ended = await human.until(lambda m: m["t"] == "ended")
                            self.assertEqual(ended["reason"], "用户关闭")
                self.assertEqual(leases.detail(lease_id)["state"], "released")
                self.assertEqual(leases.detail(lease_id)["pages"], [])
        finally:
            await leases.aclose()

    def test_empty_human_stream_keeps_control_and_can_create_page(self):
        with ChromeDev() as chrome:
            asyncio.run(self.empty_human_stream(chrome.cdp_url))

    async def empty_human_stream(self, cdp_url):
        leases = BrowserLeases(BrowserDefinition(cdp_url=cdp_url, idle_timeout=0))
        await leases.start()
        try:
            leases.register("empty-stream", "root", "worker", "entry")
            env = await leases.command_environment("empty-stream")
            async with httpx.AsyncClient() as http:
                endpoint = (await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")).json()[
                    "webSocketDebuggerUrl"]
            async with connect(endpoint) as agent:
                await agent.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                self.assertIn("result", json.loads(await agent.recv()))
                ident = leases.lease_for_task("empty-stream")
                original = leases.detail(ident)["current"]
                epoch = (await leases.takeover(ident))["epoch"]
                async with stream_server(leases) as origin:
                    path = f"{origin}/browser-tasks/{ident}/stream"
                    headers = {"Authorization": "Bearer stream-test-token"}
                    async with (connect(path, additional_headers=headers) as view_ws,
                                connect(path + "?mode=control", additional_headers=headers) as control_ws):
                        viewer, human = Viewer(view_ws), Viewer(control_ws)
                        before = await human.frame(epoch)
                        await viewer.frame(epoch)
                        await leases.close_page(ident, original)
                        for stream in (viewer, human):
                            empty = await stream.until(lambda m: m["t"] == "pages" and not m["pages"])
                            self.assertEqual((empty["state"], empty["current"], empty["css"]),
                                             ("human", None, [0, 0]))
                        self.assertEqual((await human.command("text", before, text="stale"))["why"],
                                         "no-page")
                        self.assertEqual((await viewer.command("new_page", epoch=epoch))["why"],
                                         "read-only")
                        created = await human.command("new_page", epoch=epoch)
                        self.assertEqual((created["t"], created["epoch"]), ("page_done", epoch))
                        self.assertNotEqual(created["target"], original)
                        self.assertEqual(leases.detail(ident)["state"], "human")
                        self.assertEqual((await human.frame(epoch))["page"], created["target"])
                        self.assertEqual((await viewer.frame(epoch))["page"], created["target"])
                        await leases.close_page(ident, created["target"])
                        await human.until(lambda m: m["t"] == "pages" and not m["pages"])
                        ended = await leases.handback(ident)
                        self.assertEqual((ended["state"], ended["reason"]), ("released", "用户关闭"))
                        self.assertEqual((await human.until(lambda m: m["t"] == "ended"))["reason"], "用户关闭")
        finally:
            await leases.aclose()


class StreamRevocationCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_reject_invalid_stream_parameters_before_accept(self):
        class Socket:
            app = SimpleNamespace(state=SimpleNamespace(
                device_auth=SimpleNamespace(identify=lambda token: {"device_id": "viewer"}),
                gateway=SimpleNamespace(runtime=SimpleNamespace(browser=None)),
            ))
            headers = {"authorization": "Bearer token"}
            close_code = None
            accepted = False

            async def accept(self):
                self.accepted = True

            async def close(self, code):
                self.close_code = code

        for value in ("0", "33", "-1", "1.5", "", "01", " 2 ", "true"):
            with self.subTest(value=value):
                ws = Socket()
                ws.query_params = {"max_in_flight": value}
                await browser_stream(ws)
                self.assertEqual(ws.close_code, 4400)
                self.assertFalse(ws.accepted)
        for value in ("11", "31", "0", "24.0", "", "024", " 24 ", "true"):
            with self.subTest(fps=value):
                ws = Socket()
                ws.query_params = {"fps": value}
                await browser_stream(ws)
                self.assertEqual(ws.close_code, 4400)
                self.assertFalse(ws.accepted)
        for value in ("12", "24", "30"):
            ws = Socket()
            ws.query_params = {"fps": value}
            await browser_stream(ws)
            self.assertEqual(ws.close_code, 4404)  # Valid FPS reaches the browser lookup.
        ws = Socket()
        ws.query_params = QueryParams("fps=24&fps=30")
        await browser_stream(ws)
        self.assertEqual(ws.close_code, 4400)
        self.assertFalse(ws.accepted)
        ws = Socket()
        ws.query_params = QueryParams("max_in_flight=2&max_in_flight=3")
        await browser_stream(ws)
        self.assertEqual(ws.close_code, 4400)
        for value in ("1", "2", "32"):
            ws = Socket()
            ws.query_params = {"max_in_flight": value}
            await browser_stream(ws)
            self.assertEqual(ws.close_code, 4404)


        for value in (0, 33, True, 1.5):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "max_in_flight"):
                    BrowserStream(None, None, "lease", max_in_flight=value)
        for value in (11, 31, True, 24.5):
            with self.subTest(fps=value):
                with self.assertRaisesRegex(ValueError, "fps"):
                    BrowserStream(None, None, "lease", fps=value)
        for value in (12, 24, 30):
            self.assertEqual(BrowserStream(None, None, "lease", fps=value).fps, value)

    async def exercise_revocation(self, *, disconnect_first):
        directory = tempfile.TemporaryDirectory(prefix="stream-cancel-")
        self.addCleanup(directory.cleanup)
        store = GatewayStore(Path(directory.name) / "gateway.sqlite")
        self.addCleanup(store.close)
        paired, error = store.exchange_pairing_code(
            store.issue_pairing_code()["code"], "viewer", "manual",
        )
        self.assertIsNone(error)
        auth = DeviceAuth(store)
        receive_started = asyncio.Event()
        receive_cleanup = asyncio.Event()
        release_receive = asyncio.Event()
        disconnect = asyncio.Event()
        frame_cleanup = asyncio.Event()
        release_frames = asyncio.Event()
        closed = asyncio.Event()
        frame_sent = asyncio.Event()

        class FrameSource:
            def __init__(self):
                self.listeners = set()
                self.viewers = set()

            def detail(self, identity):
                return {"state": "agent", "epoch": 1, "current": "page", "max_pages": 3,
                        "pages": [{"id": "page", "url": "about:blank", "revision": 0}]}

            def subscribe(self, identity, callback):
                self.listeners.add(callback)
                return lambda: self.listeners.discard(callback)

            async def page_call(self, *args):
                return {"result": {"value": [800, 600, 1]}}

            async def subscribe_frames(self, identity, page, callback):
                self.viewers.add(callback)

                async def unsubscribe():
                    frame_cleanup.set()
                    await release_frames.wait()
                    self.viewers.remove(callback)

                return unsubscribe

        browser = FrameSource()

        class Socket:
            app = SimpleNamespace(state=SimpleNamespace(
                device_auth=auth, gateway=SimpleNamespace(runtime=SimpleNamespace(browser=browser)),
            ))
            headers = {"authorization": f"Bearer {paired['token']}"}
            query_params = {"max_in_flight": "4"}
            path_params = {"browser_task_id": "lease"}
            close_code = None

            async def accept(self):
                pass

            async def send_json(self, message):
                if message["t"] == "hello":
                    self.hello = message

            async def send_bytes(self, packet):
                frame_sent.set()

            async def receive_text(self):
                receive_started.set()
                try:
                    await disconnect.wait()
                    raise WebSocketDisconnect()
                finally:
                    receive_cleanup.set()
                    await release_receive.wait()

            async def close(self, code):
                self.close_code = code
                # Hold the outer scope until run() is in asynchronous teardown.
                # Its finally must not cancel that teardown a second time.
                await receive_cleanup.wait()
                closed.set()

        ws = Socket()
        task = asyncio.create_task(browser_stream(ws))
        try:
            async with asyncio.timeout(3):
                await receive_started.wait()
                self.assertEqual(len(browser.viewers), 1)
                self.assertEqual(ws.hello["max_in_flight"], 4)
                for offer in browser.viewers:
                    offer({"metadata": {"deviceWidth": 800, "deviceHeight": 600},
                           "data": base64.b64encode(b"\xff\xd8\xff\xd9").decode()})
                await frame_sent.wait()  # Disconnect with an occupied credit.
                if disconnect_first:
                    release_receive.set()
                    disconnect.set()
                    await frame_cleanup.wait()
                self.assertTrue(auth.revoke(paired["device_id"]))
                await closed.wait()
                # The endpoint has closed the socket, but cannot finish until its
                # receiver and frame source have released their resources.
                release_receive.set()
                await frame_cleanup.wait()
                self.assertFalse(task.done())
                release_frames.set()
                await task
            self.assertEqual(ws.close_code, 4401)
            self.assertEqual(len(browser.viewers), 0)
            self.assertEqual(len(browser.listeners), 0)
            self.assertIsNone(auth.identify(ws.headers["authorization"]))
        finally:
            release_receive.set()
            release_frames.set()
            disconnect.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_revoke_waits_for_receiver_and_unsubscribes_frames(self):
        await self.exercise_revocation(disconnect_first=False)

    async def test_revoke_during_disconnect_frame_cleanup_does_not_interrupt_unsubscribe(self):
        await self.exercise_revocation(disconnect_first=True)


if __name__ == "__main__":
    unittest.main()
