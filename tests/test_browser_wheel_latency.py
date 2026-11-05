"""Wheel FIFO/coalescing through the real v3 reader, lease and CDP transport."""

import asyncio
import json
import time
import unittest

from wandrun.config import BrowserDefinition
from wandrun.gateway.browser_stream import BrowserStream
from wandrun.gateway.stream_config import InputConfig, StreamConfig
from wandrun.gateway.video_stream import VideoStreams
from wandrun.runtime.browser.cdp import CDPSocket
from wandrun.runtime.browser.leases import BrowserLeases, _Lease, _Page
from test_browser_stream_cleanup import ControlledWire, Socket


class _Harness:
    async def __aenter__(self):
        self.socket = Socket()
        self.browser = BrowserLeases(BrowserDefinition("http://127.0.0.1:1", idle_timeout=0))
        self.cdp = CDPSocket("unused")
        self.wire = ControlledWire(self.cdp)
        self.cdp.ws = self.wire
        self.lease = _Lease("lease", "task", "root", "agent", "entry", state="human", current="page")
        self.lease.pages["page"] = _Page("page", self.cdp)
        self.browser._leases["lease"] = self.lease
        self.stream = BrowserStream(self.socket, self.browser, "lease", control=True,
            video_streams=VideoStreams(StreamConfig(input=InputConfig(window=1, reply_timeout_s=.5))))
        await self.stream._sync_pages()
        await self.socket.outgoing.get()
        initial = self.frame(1)
        await self.stream._input({"t": "pointer", "id": 0, "x": 100, "y": 120, "buttons": 0, **initial})
        self.wire.inputs.clear()
        while not self.wire.sent_input.empty():
            self.wire.sent_input.get_nowait()
        self.worker = asyncio.create_task(self.stream._receive())
        return self

    async def __aexit__(self, *args):
        self.wire.release()
        self.worker.cancel()
        await asyncio.gather(self.worker, return_exceptions=True)
        await self.stream._cleanup()
        inputs = self.browser.human_inputs("lease")
        if inputs.idle_task is not None:
            inputs.idle_task.cancel()
            await asyncio.gather(inputs.idle_task, return_exceptions=True)
        await self.cdp.close()

    def frame(self, seq):
        self.stream.sent[seq] = (1, self.stream.vp, "page")
        return {"epoch": 1, "vp": self.stream.vp, "page": "page", "frame": seq,
                "ts": time.monotonic() * 1000}

    async def enqueue(self, messages):
        # Hold only the public connection view barrier, so the reader can accept
        # the entire workload before the first dispatch considers coalescing.
        async with self.stream._view_lock:
            for message in messages:
                await self.socket.incoming.put(json.dumps(message))
            await self.socket.incoming.put(json.dumps({"t": "ping", "id": 9999}))
            while (await self.socket.outgoing.get()).get("id") != 9999:
                pass

    async def replies(self, count):
        async with asyncio.timeout(3):
            replies = []
            while len(replies) < count:
                message = await self.socket.outgoing.get()
                if message.get("t") in ("input_done", "reject"):
                    replies.append(message)
            return replies


def _wheel(identity, credential, *, x=100, y=120, dx=0, dy=20, **changes):
    return {"t": "wheel", "id": identity, **credential, "x": x, "y": y,
            "dx": dx, "dy": dy, **changes}


class WheelQueueLatencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_cross_frame_backlog_merges_without_crossing_pointer_change(self):
        async with _Harness() as harness:
            credentials = [harness.frame(seq) for seq in range(1, 7)]
            messages = [_wheel(1, credentials[0], dy=20), _wheel(2, credentials[1], dy=40),
                        _wheel(3, credentials[2], dy=120),
                        {"t": "pointer", "id": 4, **credentials[3], "x": 200, "y": 120, "buttons": 0},
                        _wheel(5, credentials[4], dy=-20), _wheel(6, credentials[5], dy=-30)]
            await harness.enqueue(messages)
            replies = await harness.replies(6)
            self.assertEqual({reply["id"] for reply in replies}, set(range(1, 7)))
            self.assertTrue(all(reply.get("outcome") == "sent" for reply in replies))
            events = [message["params"] for message in harness.wire.inputs]
            self.assertEqual([(event["type"], event.get("deltaY")) for event in events],
                             [("mouseWheel", 180), ("mouseMoved", None), ("mouseWheel", -50)])

    async def test_invalid_frame_anchor_and_axis_reversal_are_boundaries(self):
        async with _Harness() as harness:
            credential = harness.frame(1)
            await harness.enqueue([
                _wheel(1, credential, dy=10), _wheel(2, credential, frame=99),
                _wheel(3, credential, dy=20), _wheel(4, credential, x=300, dy=30),
                _wheel(5, credential, x=300, dx=-5, dy=0),
                _wheel(6, credential, x=300, dx=5, dy=40)])
            replies = {reply["id"]: reply for reply in await harness.replies(6)}
            self.assertEqual((replies[2]["t"], replies[2]["why"]), ("reject", "stale-frame"))
            events = [message["params"] for message in harness.wire.inputs]
            self.assertEqual([(event["x"], event["deltaX"], event["deltaY"]) for event in events],
                             [(100, 0, 10), (100, 0, 20), (300, -5, 30), (300, 5, 40)])

    async def test_frame_expiring_while_waiting_for_send_keeps_followers_independent(self):
        async with _Harness() as harness:
            first, second = harness.frame(1), harness.frame(2)
            await harness.cdp._send_lock.acquire()
            try:
                await harness.enqueue([_wheel(1, first, dy=10), _wheel(2, second, dy=20)])
                harness.stream.sent.pop(2)
            finally:
                harness.cdp._send_lock.release()
            replies = {reply["id"]: reply for reply in await harness.replies(2)}
            self.assertEqual(replies[1]["outcome"], "sent")
            self.assertEqual(replies[2]["why"], "stale-frame")
            self.assertEqual([m["params"]["deltaY"] for m in harness.wire.inputs], [10])
