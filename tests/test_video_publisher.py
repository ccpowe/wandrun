"""Protocol and CDP pipeline behavior; real websockets, JPEG decode and RTC sources.

Only the SFU boundary is substituted; formal-SFU proof lives in step2.py.
"""

import asyncio
import base64
import contextlib
import io
import json
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from livekit import rtc
from PIL import Image
from websockets.asyncio.server import serve

from wandrun.integrations import video_publisher as video


CONFIG = {
    "t": "config",
    "url": "wss://sfu.invalid",
    "codec": "h264",
    "max_kbps": 1500,
    "jpeg_quality": 95,
    "idle_resend_fps": 10,
}


class SFURoom:
    instances = []
    stalled = False

    def __init__(self, owner, name, token):
        self.owner, self.name, self.token = owner, name, token
        self.protocol = None
        self.connected = self.closed = False
        self.started = asyncio.Event()
        self.sdk = SimpleNamespace(
            isconnected=lambda: self.connected, local_participant=self
        )
        self.instances.append(self)

    async def publish_track(self, track, options):
        return SimpleNamespace(sid=track.name)

    async def unpublish_track(self, sid):
        pass

    async def connect(self):
        self.started.set()
        if self.stalled:
            await asyncio.Future()
        self.connected = True

    async def close(self):
        self.closed = True
        self.connected = False


class PublisherTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.rows = []
        self.stats_times = []
        self.submissions = []
        submit_frame = rtc.VideoSource.capture_frame

        def observe_submission(source, frame, *args, **kwargs):
            result = submit_frame(source, frame, *args, **kwargs)
            self.submissions.append((time.monotonic(), source, frame))
            return result

        submit_patch = patch.object(
            rtc.VideoSource, "capture_frame", observe_submission
        )
        submit_patch.start()
        self.addCleanup(submit_patch.stop)

        def observe_output(kind, **fields):
            self.rows.append({"t": kind, **fields})
            if kind == "stats":
                self.stats_times.append(time.monotonic())

        self.publisher = video.Publisher(0, observe_output)
        self.reader = asyncio.StreamReader(limit=video.MAX_LINE)
        self.sockets = set()
        self.closed_targets = []
        self.acks = 0
        self.animate = True
        self.patch = patch.object(video, "Room", SFURoom)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        SFURoom.instances = []
        SFURoom.stalled = False
        with io.BytesIO() as buffer:
            Image.new("RGB", (64, 48), "red").save(buffer, "JPEG")
            self.jpeg = base64.b64encode(buffer.getvalue()).decode()

        async def cdp(socket):
            self.sockets.add(socket)
            target = socket.request.path.rsplit("/", 1)[-1]
            sender = None

            async def frames():
                identity = 0
                while True:
                    if self.animate or identity == 0:
                        identity += 1
                        await socket.send(
                            json.dumps(
                                {
                                    "method": "Page.screencastFrame",
                                    "params": {
                                        "sessionId": identity,
                                        "data": self.jpeg,
                                        "metadata": {
                                            "deviceWidth": 64,
                                            "deviceHeight": 48,
                                        },
                                    },
                                }
                            )
                        )
                    await asyncio.sleep(1 / 60)

            try:
                async for raw in socket:
                    message = json.loads(raw)
                    if message["method"] == "Page.startScreencast":
                        await socket.send(
                            json.dumps({"id": message["id"], "result": {}})
                        )
                        sender = asyncio.create_task(frames())
                    elif message["method"] == "Page.screencastFrameAck":
                        self.acks += 1
                    else:
                        raise AssertionError(
                            "publisher attempted non-capture CDP method"
                        )
            finally:
                if sender:
                    sender.cancel()
                    await asyncio.gather(sender, return_exceptions=True)
                self.sockets.discard(socket)
                self.closed_targets.append(target)

        self.server = await serve(cdp, "127.0.0.1", 0)
        self.publisher.port = self.server.sockets[0].getsockname()[1]
        self.running = asyncio.create_task(video.run(self.reader, self.publisher))

    async def asyncTearDown(self):
        self.reader.feed_eof()
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait_for(self.running, 3)
        self.server.close()
        await self.server.wait_closed()

    def send(self, message):
        self.reader.feed_data(json.dumps(message).encode() + b"\n")

    async def until(self, predicate, timeout=3):
        async with asyncio.timeout(timeout):
            while not predicate():
                await asyncio.sleep(0.005)

    def published(self, name):
        return any(
            r.get("track") == name and r.get("state") == "published" for r in self.rows
        )

    async def watch(self, name="page", target="a", fps=24):
        self.send(
            {
                "t": "watch",
                "track": name,
                "room": "lease",
                "token": "never-log-this",
                "target": target,
                "capture_fps": fps,
            }
        )
        await self.until(lambda: self.published(name))

    async def test_invalid_lines_recover_and_never_echo_token(self):
        for raw in (
            b"not json\n",
            b"[]\n",
            b'{"t":"unknown"}\n',
            b"\xff\n",
            b"x" * (video.MAX_LINE + 100) + b"\n",
        ):
            self.reader.feed_data(raw)
        self.send(CONFIG)
        self.send(
            {
                "t": "watch",
                "track": "invalid",
                "room": "lease",
                "target": "a",
                "token": "never-log-this",
                "capture_fps": float("nan"),
            }
        )
        await self.watch()
        self.assertEqual(sum(r.get("code") == "bad-message" for r in self.rows), 6)
        self.assertNotIn("never-log-this", json.dumps(self.rows))
        self.assertEqual(
            next(r["css"] for r in self.rows if r["t"] == "view"), [64, 48]
        )

    async def test_eof_cleans_published_track_and_room(self):
        self.send(CONFIG)
        await self.watch()
        self.reader.feed_eof()
        await asyncio.wait_for(self.running, 1)
        await self.until(lambda: not self.sockets)
        self.assertFalse(self.publisher.tracks)
        self.assertFalse(self.publisher.rooms)
        self.assertTrue(SFURoom.instances[0].closed)
        self.assertEqual(
            [r["state"] for r in self.rows if r["t"] == "track"],
            ["published", "stopped"],
        )

    async def test_eof_interrupts_pending_sfu_connect(self):
        SFURoom.stalled = True
        self.send(CONFIG)
        self.send(
            {
                "t": "watch",
                "track": "page",
                "room": "lease",
                "token": "secret",
                "target": "a",
                "capture_fps": 24,
            }
        )
        await self.until(
            lambda: SFURoom.instances and SFURoom.instances[0].started.is_set()
        )
        self.reader.feed_eof()
        await asyncio.wait_for(self.running, 1)
        await self.until(lambda: not self.sockets)
        self.assertTrue(SFURoom.instances[0].closed)
        self.assertFalse(self.published("page"))

    async def test_stop_cleans_without_waiting_for_stdin_eof(self):
        self.send(CONFIG)
        await self.watch()
        self.send({"t": "stop"})
        await asyncio.wait_for(self.running, 1)
        self.assertTrue(SFURoom.instances[0].closed)

    async def test_switch_stops_old_capture_before_new_track(self):
        self.send(CONFIG)
        await self.watch("old", "a")
        await self.until(lambda: self.submissions)
        old_source = self.submissions[-1][1]
        self.send({"t": "unwatch", "track": "old"})
        await self.watch("new", "b")
        await self.until(
            lambda: any(source is not old_source for _, source, _ in self.submissions)
        )
        await self.until(lambda: "a" in self.closed_targets)
        old_stop = next(
            i
            for i, r in enumerate(self.rows)
            if r.get("track") == "old" and r.get("state") == "stopped"
        )
        new_start = next(
            i
            for i, r in enumerate(self.rows)
            if r.get("track") == "new" and r.get("state") == "published"
        )
        self.assertLess(old_stop, new_start)
        first_new = next(
            at for at, source, _ in self.submissions if source is not old_source
        )
        self.assertLess(
            max(at for at, source, _ in self.submissions if source is old_source),
            first_new,
        )
        old_frames = sum(source is old_source for _, source, _ in self.submissions)
        await asyncio.sleep(0.15)
        self.assertEqual(
            sum(source is old_source for _, source, _ in self.submissions), old_frames
        )

    async def test_sdk_submissions_follow_fps_limit_and_reuse_idle_frame(self):
        self.send(CONFIG)
        await self.watch()
        await self.until(lambda: len(self.submissions) >= 3)
        start = time.monotonic()
        await asyncio.sleep(1)
        active = [row for row in self.submissions if row[0] >= start]
        self.assertGreater(len(active), 15)
        self.assertLessEqual(len(active), 25)
        self.assertTrue(
            all(b[0] - a[0] >= 1 / 24 - 0.001 for a, b in zip(active, active[1:]))
        )
        self.assertGreater(self.acks, len(self.submissions))

        self.send({"t": "fps", "track": "page", "capture_fps": 10})
        # fps has no protocol ACK; observe the actual SDK submission cadence.
        await self.until(
            lambda: (
                len(self.submissions) >= 3
                and all(
                    b[0] - a[0] >= 0.09
                    for a, b in zip(self.submissions[-3:], self.submissions[-2:])
                )
            )
        )
        start = time.monotonic()
        await asyncio.sleep(0.8)
        limited = [row for row in self.submissions if row[0] >= start]
        self.assertGreaterEqual(len(limited), 5)
        self.assertLessEqual(len(limited), 9)
        self.assertTrue(all(b[0] - a[0] >= 0.099 for a, b in zip(limited, limited[1:])))

        self.animate = False
        await asyncio.sleep(0.15)  # Drain the final pending screencast frame.
        start = time.monotonic()
        await asyncio.sleep(0.8)
        idle = [row for row in self.submissions if row[0] >= start]
        self.assertGreaterEqual(len(idle), 5)
        self.assertLessEqual(len(idle), 9)
        self.assertTrue(all(frame is idle[0][2] for _, _, frame in idle))

    async def test_stats_reset_to_new_capture_lifetime_after_config_rebuild(self):
        self.send(CONFIG)
        await self.watch()
        await self.until(lambda: self.stats_times, timeout=7)
        old_source = self.submissions[-1][1]
        await asyncio.sleep(3.5)
        rebuild_at = time.monotonic()
        self.send(dict(CONFIG, jpeg_quality=94))
        await self.until(lambda: len(self.stats_times) == 2, timeout=7)
        row = [message for message in self.rows if message["t"] == "stats"][-1][
            "tracks"
        ][0]
        for key in ("capture_fps", "sent_fps", "dropped"):
            self.assertGreaterEqual(row[key], 0, row)
        new_frames = sum(source is not old_source for _, source, _ in self.submissions)
        measured_fps = new_frames / (self.stats_times[-1] - rebuild_at)
        self.assertGreater(measured_fps, 10)
        self.assertAlmostEqual(
            row["sent_fps"], measured_fps, delta=max(2, measured_fps * 0.2)
        )

    async def test_token_renewal_does_not_republish(self):
        self.send(CONFIG)
        await self.watch()
        room = SFURoom.instances[0]
        self.send({"t": "token", "room": "lease", "token": "renewed-secret"})
        await self.until(lambda: room.token == "renewed-secret")
        self.assertEqual(sum(r.get("state") == "published" for r in self.rows), 1)
        self.assertFalse(room.closed)
        self.assertNotIn("renewed-secret", json.dumps(self.rows))

    async def test_cdp_loss_removes_track_instead_of_resending_frozen_frame(self):
        self.send(CONFIG)
        await self.watch()
        await next(iter(self.sockets)).close()
        await self.until(lambda: SFURoom.instances[0].closed)
        self.assertFalse(self.publisher.tracks)
        self.assertTrue(any(r.get("code") == "cdp-unreachable" for r in self.rows))

    async def test_terminal_sfu_loss_stops_capture(self):
        self.send(CONFIG)
        await self.watch()
        room = SFURoom.instances[0]
        room.connected = False
        await self.until(lambda: room.closed)
        self.assertFalse(self.publisher.tracks)
        self.assertTrue(any(r.get("code") == "sfu-unreachable" for r in self.rows))
