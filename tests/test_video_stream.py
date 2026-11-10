"""Video ownership and externally visible failure transitions, without an SFU."""

import asyncio
import json
import unittest
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
import socket
import tempfile
from unittest.mock import patch

import httpx
from livekit import api
from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Route
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from starlette.websockets import WebSocketDisconnect
from wandrun.gateway.browser_stream import BrowserStream
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.stream_config import StreamConfig, VideoConfig, load_stream_config
from wandrun.gateway.video_stream import VideoStreams, VideoTokens, _VideoEnvironment
from test_gateway_pairing import live_gateway, bearer
from types import SimpleNamespace

from wandrun.gateway.video_stream import Publisher, VideoFailure


class Reader:
    def __init__(self):
        self.lines = asyncio.Queue()

    async def readline(self):
        return await self.lines.get()

    async def read(self, size):
        return await self.lines.get()


class Process:
    def __init__(self):
        self.stdout, self.stderr = Reader(), Reader()
        self.messages = []
        self.eof = False
        self.closed = False
        self.exit_status = None
        self.exited = asyncio.Event()
        self.stdin = SimpleNamespace(
            write=self.write, drain=self.drain, write_eof=self.write_eof
        )

    def write(self, value):
        self.messages.append(json.loads(value))

    async def drain(self):
        pass

    def write_eof(self):
        self.eof = True
        self.exit_status = 0
        self.exited.set()

    def terminate(self):
        self.exited.set()

    def close(self):
        self.closed = True

    async def wait_closed(self):
        await self.exited.wait()

    def emit(self, **message):
        self.stdout.lines.put_nowait(json.dumps(message) + "\n")


class PublisherTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.process = Process()
        self.events = []
        self.opens = 0

        async def open_process():
            self.opens += 1
            return self.process

        self.publisher = Publisher(
            open_process,
            {"url": "wss://sfu.test"},
            self.events.append,
            timeout=0.05,
            close_timeout=0.05,
        )
        self.addAsyncCleanup(self.publisher.aclose)

    async def test_duplicate_start_shares_exec_and_ready(self):
        self.process.emit(t="ready", version=1, pid=42)
        await asyncio.gather(self.publisher.start(), self.publisher.start())
        self.assertEqual(self.opens, 1)
        self.assertEqual(
            self.process.messages, [{"t": "config", "url": "wss://sfu.test"}]
        )
        await asyncio.gather(self.publisher.aclose(), self.publisher.aclose())
        self.assertTrue(self.process.eof and self.process.closed)

    async def test_ready_timeout_closes_accepted_exec(self):
        with self.assertRaisesRegex(VideoFailure, "publisher-start-timeout"):
            await self.publisher.start()
        self.assertTrue(self.process.eof and self.process.closed)
        self.process.emit(t="ready", pid=42)
        self.assertEqual(self.events, [])

    async def test_exec_timeout_retains_and_stops_late_handle(self):
        accepted = asyncio.Event()

        async def late_open():
            await accepted.wait()
            return self.process

        self.publisher._open_process = late_open
        with self.assertRaisesRegex(VideoFailure, "publisher-start-timeout"):
            await self.publisher.start()
        accepted.set()
        await asyncio.gather(self.publisher._opening, return_exceptions=True)
        self.assertTrue(self.process.eof and self.process.closed)
        self.assertEqual(self.process.messages, [])

    async def test_cancelled_waiter_does_not_cancel_other_start(self):
        first = asyncio.create_task(self.publisher.start())
        second = asyncio.create_task(self.publisher.start())
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        self.process.emit(t="ready", version=1, pid=42)
        await second
        self.assertEqual(self.opens, 1)
        self.assertFalse(self.process.closed)

    async def test_not_installed_is_not_generic_exit(self):
        self.process.emit(t="error", code="publisher-not-installed")
        with self.assertRaisesRegex(VideoFailure, "publisher-not-installed"):
            await self.publisher.start()
        self.assertTrue(self.process.closed)

    async def test_stdout_eof_notifies_once_and_close_fences_late_events(self):
        self.process.emit(t="ready", version=1, pid=42)
        await self.publisher.start()
        self.process.stdout.lines.put_nowait("")
        await self.publisher._reader
        self.assertEqual(
            self.events, [{"t": "exit", "reason": "publisher-exited", "code": None}]
        )
        await self.publisher.aclose()
        self.process.emit(t="track", track="late", state="published")
        self.assertEqual(len(self.events), 1)

    async def test_close_fences_stdout_before_remote_exit(self):
        consumed, eof, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        read = self.process.stdout.readline

        async def readline():
            line = await read()
            if '"stats"' in line:
                consumed.set()
            return line

        def write_eof():
            self.process.eof = True
            eof.set()

        async def wait_closed():
            await release.wait()
            self.process.exit_status = 0

        self.process.stdout.readline = readline
        self.process.stdin.write_eof = write_eof
        self.process.wait_closed = wait_closed
        self.process.emit(t="ready", pid=42)
        await self.publisher.start()
        closing = asyncio.create_task(self.publisher.aclose())
        try:
            await eof.wait()
            self.process.emit(t="stats", tracks=[], cpu=0.1, rss_mb=10)
            await consumed.wait()
            self.assertEqual(self.events, [])
        finally:
            release.set()
            await closing


class VideoBrowser:
    def __init__(self):
        self.environment_id = "instabox:test"
        self.config = SimpleNamespace(cdp_port=9223)
        self.transport = object()
        self.listeners = set()
        self.subscriptions = set()
        self.inputs = []
        self.snapshot = {
            "id": "lease",
            "state": "human",
            "epoch": 3,
            "current": "one",
            "pages": [
                {"id": p, "url": "https://example.test/private?q=secret"}
                for p in ("one", "two", "three")
            ],
            "environment_id": self.environment_id,
            "environment_name": "Test",
            "capacity_rejection": None,
            "capacity": {"pages_limit": 6},
        }
        from wandrun.runtime.browser.human_input import HumanInputs
        self._inputs = HumanInputs(SimpleNamespace(
            lock=asyncio.Lock(), pages={}, mouse={}, keys={}, touching=None))

    def human_inputs(self, lease_id):
        return self._inputs


    def detail(self, identity):
        return dict(self.snapshot)

    def subscribe(self, identity, callback):
        self.listeners.add(callback)
        return lambda: self.listeners.discard(callback)

    async def page_call(self, identity, target, method, params):
        return {"result": {"value": [800, 600, 1]}}

    async def subscribe_frames(self, identity, page, callback, **kwargs):
        self.subscriptions.add(callback)

        async def stop():
            self.subscriptions.discard(callback)

        return stop

    async def human_send(
        self, identity, page, epoch, method, params, *, validate, on_dispatch, connection="", observer=None,
        check_admission=None, sequence=None,
    ):
        if check_admission is not None:
            check_admission()
        validate()
        self.inputs.append((method, params))
        on_dispatch()
        async def wait():
            return {}
        return SimpleNamespace(wait=wait, outcome="sent")


class AutoProcess(Process):
    def __init__(self, *, publish=True, failure=None):
        super().__init__()
        self.publish = publish
        self.failure = failure
        self.commands = asyncio.Queue()
        self.emit(t="ready", version=1, pid=123)

    def write(self, value):
        super().write(value)
        message = self.messages[-1]
        self.commands.put_nowait(message)
        if message["t"] == "watch":
            if self.failure:
                self.emit(t="error", code=self.failure, track=message["track"])
            elif self.publish:
                self.emit(
                    t="view",
                    track=message["track"],
                    target=message["target"],
                    css=[800, 600],
                    dpr=1,
                    revision=1,
                )
                self.emit(
                    t="track",
                    track=message["track"],
                    target=message["target"],
                    state="published",
                )


@asynccontextmanager
async def fake_sfu():
    removals = asyncio.Queue()
    delay = asyncio.Event()
    delay.set()

    async def remove(request):
        identity = api.RoomParticipantIdentity.FromString(await request.body())
        await removals.put((identity.room, identity.identity))
        await delay.wait()
        return Response(
            api.RemoveParticipantResponse().SerializeToString(),
            media_type="application/protobuf",
        )

    app = Starlette(
        routes=[
            Route(
                "/twirp/livekit.RoomService/RemoveParticipant", remove, methods=["POST"]
            )
        ]
    )
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{sock.getsockname()[1]}", removals, delay
    finally:
        delay.set()
        server.should_exit = True
        await task
        sock.close()


async def until(ws, predicate):
    async with asyncio.timeout(3):
        while True:
            raw = await ws.recv()
            if isinstance(raw, bytes):
                raise AssertionError("video connection emitted a JPEG")
            message = json.loads(raw)
            if predicate(message):
                return message


class VideoGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.keys = self.root / "keys.yaml"
        self.keys.write_text("test-api: test-secret-at-least-thirty-two-characters\n")
        self.keys.chmod(0o600)
        self.config = VideoConfig(
            "wss://sfu.test",
            "http://127.0.0.1:7880",
            self.keys,
            start_timeout_s=0.15,
            publisher_idle_s=0.03,
            api_timeout_s=0.1,
        )
        self.browser = VideoBrowser()
        self.processes = []
        self.publish = True
        self.failure = None

        async def open_process(environment):
            process = AutoProcess(publish=self.publish, failure=self.failure)
            self.processes.append(process)
            return process

        self.patch = patch.object(_VideoEnvironment, "_open", open_process)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.streams = VideoStreams(StreamConfig(video=self.config))
        self.addAsyncCleanup(self.streams.aclose)

    def viewer(self, page="one"):
        socket = SimpleNamespace(send_json=self.send_json)
        stream = BrowserStream(
            socket,
            self.browser,
            "lease",
            control=True,
            video_player=True,
            video_streams=self.streams,
        )
        stream.page = page
        stream.events = asyncio.Queue()
        stream._video_event = lambda page, message: stream.events.put_nowait(message)
        return stream

    async def send_json(self, message):
        pass

    async def ready(self, stream):
        async with asyncio.timeout(2):
            while True:
                message = await stream.events.get()
                if message.get("state") == "ready" or message["t"] == "video_failed":
                    return message

    async def test_shared_track_limit_unwatch_and_reuse_during_grace(self):
        first, same, second, excess = (
            self.viewer(p) for p in ("one", "one", "two", "three")
        )
        stops = [self.streams.watch(stream) for stream in (first, same, second)]
        with self.assertRaisesRegex(VideoFailure, "watch-limit"):
            self.streams.watch(excess)
        a, b, c = await asyncio.gather(*(self.ready(s) for s in (first, same, second)))
        self.assertEqual(a["track"], b["track"])
        self.assertNotEqual(a["track"], c["track"])
        self.assertEqual(len(self.processes), 1)
        await stops[0]()
        self.assertFalse(any(m["t"] == "unwatch" for m in self.processes[0].messages))
        await stops[1]()
        await stops[2]()
        replacement = self.viewer()
        stop = self.streams.watch(replacement)
        await self.ready(replacement)
        self.assertEqual(len(self.processes), 1)
        await stop()
        environment = self.streams.environments[self.browser]
        await environment._idle
        self.assertTrue(self.processes[0].eof)
        again = self.viewer()
        stop_again = self.streams.watch(again)
        await self.ready(again)
        self.assertEqual(len(self.processes), 2)
        await stop_again()

    async def test_grace_expiry_detaches_before_close_allows_new_publisher(self):
        viewer = self.viewer()
        stop = self.streams.watch(viewer)
        await self.ready(viewer)
        environment = self.streams.environments[self.browser]
        entered, release = asyncio.Event(), asyncio.Event()
        original_close = environment.publisher.aclose

        async def paused_close():
            entered.set()
            await release.wait()
            await original_close()

        with patch.object(environment.publisher, "aclose", paused_close):
            await stop()
            await asyncio.wait_for(entered.wait(), 1)
            replacement = self.viewer()
            stop_new = self.streams.watch(replacement)
            await asyncio.sleep(0)
            self.assertEqual(len(self.processes), 1)
            release.set()
            await self.ready(replacement)
            self.assertEqual(len(self.processes), 2)
            await stop_new()
        self.assertFalse(self.processes[1].closed)

    async def test_last_page_publish_timeout_retires_before_immediate_retry(self):
        self.streams.config = replace(
            self.streams.config, video=replace(self.config, publisher_idle_s=5)
        )
        self.publish = False
        viewer = self.viewer()
        self.streams.watch(viewer)
        failure = await self.ready(viewer)
        self.assertEqual(
            failure,
            {
                "t": "video_failed",
                "reason": "page-publish-timeout",
                "retryable": True,
            },
        )
        # Only a genuinely new exec can publish; the old process stays stuck.
        self.publish = True
        replacement = self.viewer()
        stop = self.streams.watch(replacement)
        self.assertEqual((await self.ready(replacement)).get("state"), "ready")
        self.assertEqual(len(self.processes), 2)
        self.assertTrue(self.processes[0].eof)
        await stop()

    async def test_disconnect_during_start_cleans_late_published_track(self):
        self.publish = False
        viewer = self.viewer()
        stop = self.streams.watch(viewer)
        environment = self.streams.environments[self.browser]
        async with asyncio.timeout(1):
            while not self.processes:
                await asyncio.sleep(0)
        process = self.processes[0]
        async with asyncio.timeout(1):
            while not any(m["t"] == "watch" for m in process.messages):
                await asyncio.sleep(0)
        watch = next(m for m in process.messages if m["t"] == "watch")
        await stop()
        process.emit(t="track", track=watch["track"], target="one", state="published")
        await environment._idle
        self.assertTrue(viewer.events.empty())
        self.assertTrue(process.eof)

    async def test_sfu_failure_remains_video_and_explicit_retry_restarts_watch(self):
        self.failure = "sfu-unreachable"
        stream = BrowserStream(
            SimpleNamespace(send_json=self.send_json),
            self.browser,
            "lease",
            video_player=True,
            video_streams=self.streams,
        )
        await stream._sync_pages()
        pump = asyncio.create_task(stream._videos())
        self.addAsyncCleanup(stream._cleanup)
        self.addAsyncCleanup(self.cancel, pump)
        async with asyncio.timeout(1):
            while not stream._video_failed:
                await asyncio.sleep(0)
        self.assertEqual(stream.transport, "video")
        self.assertFalse(self.browser.subscriptions)
        self.assertFalse(self.streams.environments[self.browser].tracks)

    async def cancel(self, task):
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_real_http_ws_video_and_device_revoke(self):
        async with fake_sfu() as (api_url, removals, delay):
            self.streams.config = replace(
                self.streams.config, video=replace(self.config, api_url=api_url)
            )
            self.streams.tokens = VideoTokens(self.streams.config.video)
            store = GatewayStore(self.root / "gateway.sqlite")
            self.addCleanup(store.close)
            gateway = Gateway(store)
            gateway.video_streams = self.streams
            gateway.runtime = SimpleNamespace(
                browser_for_lease=lambda identity: self.browser
            )
            app = create_app(gateway, "dev", management_token="admin")
            async with (
                live_gateway(app) as origin,
                httpx.AsyncClient(base_url=origin) as http,
            ):
                challenge = (
                    await http.post(
                        "/admin/pairing-codes",
                        headers=bearer("admin"),
                        json={"name": "video test"},
                    )
                ).json()
                paired = (
                    await http.post(
                        "/pairing/exchange",
                        json={
                            "code": challenge["code"],
                            "method": "manual",
                        },
                    )
                ).json()
                headers = bearer(paired["token"])
                self.assertEqual(
                    (await http.get("/connection", headers=headers)).status_code, 200
                )
                async with connect(
                    origin.replace("http:", "ws:")
                    + "/browser-tasks/lease/stream?mode=control&video_player=1",
                    additional_headers=headers,
                ) as ws:
                    hello = await until(ws, lambda m: m["t"] == "hello")
                    self.assertEqual(
                        (hello["protocol"], hello["transport"]),
                        (3, "video"),
                    )
                    ready = await until(ws, lambda m: m.get("state") == "ready")
                    claims = api.TokenVerifier(*read_test_keys(self.keys)).verify(
                        ready["token"]
                    )
                    self.assertEqual(
                        claims.identity, "viewer:" + hello["connection_id"]
                    )
                    self.assertEqual(
                        (
                            claims.video.room,
                            claims.video.can_publish,
                            claims.video.can_subscribe,
                            claims.video.can_publish_data,
                        ),
                        ("lease", False, True, False),
                    )
                    await ws.send(
                        json.dumps(
                            {
                                "t": "text",
                                "id": 1,
                                "epoch": 3,
                                "vp": ready["vp"],
                                "page": "one",
                                "text": "private",
                            }
                        )
                    )
                    done = await until(ws, lambda m: m.get("id") == 1)
                    self.assertEqual(
                        (done["t"], done["outcome"]), ("input_done", "sent")
                    )
                    await ws.send(
                        json.dumps(
                            {
                                "t": "text",
                                "id": 2,
                                "epoch": 3,
                                "vp": ready["vp"] - 1,
                                "text": "old",
                            }
                        )
                    )
                    self.assertEqual(
                        (await until(ws, lambda m: m.get("id") == 2))["why"],
                        "stale-viewport",
                    )
                    process = self.processes[0]
                    watch = next(m for m in process.messages if m["t"] == "watch")
                    process.emit(
                        t="conn", room="lease", state="reconnecting", protocol=None
                    )
                    await until(ws, lambda m: m.get("state") == "reconnecting")
                    process.emit(
                        t="track", track=watch["track"], target="one", state="published"
                    )
                    self.assertEqual(
                        (await until(ws, lambda m: m.get("state") == "ready"))["vp"],
                        ready["vp"],
                    )
                    delay.clear()
                    response = await http.delete(
                        f"/admin/devices/{paired['device_id']}", headers=bearer("admin")
                    )
                    self.assertIn(response.status_code, (200, 204))
                    self.assertEqual(
                        await asyncio.wait_for(removals.get(), 2),
                        ("lease", "viewer:" + hello["connection_id"]),
                    )
                    with self.assertRaises(ConnectionClosed) as closed:
                        await ws.recv()
                    self.assertEqual(closed.exception.rcvd.code, 4401)
                self.assertFalse(self.browser.listeners)
                self.assertEqual(
                    (await http.get("/connection", headers=headers)).status_code, 401
                )

    async def test_real_ws_publisher_failure_and_retry(self):
        self.failure = "target-not-found"
        store = GatewayStore(self.root / "gateway.sqlite")
        self.addCleanup(store.close)
        gateway = Gateway(store)
        gateway.video_streams = self.streams
        gateway.runtime = SimpleNamespace(
            browser_for_lease=lambda identity: self.browser
        )
        app = create_app(gateway, "dev")
        async with live_gateway(app) as origin:
            async with connect(
                origin.replace("http:", "ws:")
                + "/browser-tasks/lease/stream?video_player=1",
                additional_headers=bearer("dev"),
            ) as ws:
                hello = await until(ws, lambda m: m["t"] == "hello")
                self.assertEqual(hello["transport"], "video")
                failed = await until(ws, lambda m: m["t"] == "video_failed")
                self.assertEqual(
                    (failed["reason"], failed["retryable"]), ("page-unavailable", True)
                )
                self.assertEqual(self.browser.subscriptions, set())
                self.failure = None
                self.processes[0].failure = None
                await ws.send(json.dumps({"t": "video_retry", "id": "retry"}))
                ready = await until(ws, lambda m: m.get("state") == "ready")
                watch_count = sum(m["t"] == "watch" for m in self.processes[0].messages)
                for retry_id in ("duplicate", "again"):
                    await ws.send(json.dumps({"t": "video_retry", "id": retry_id}))
                    renewed = await until(ws, lambda m: m.get("state") == "ready")
                    self.assertEqual(
                        (renewed["track"], renewed["vp"]), (ready["track"], ready["vp"])
                    )
                self.assertEqual(
                    sum(m["t"] == "watch" for m in self.processes[0].messages),
                    watch_count,
                )
                self.assertEqual(len(self.processes), 1)
                self.assertEqual(self.browser.subscriptions, set())

    async def test_support_rejects_video_without_starting_any_publisher(self):
        self.browser.transport = None
        stream = BrowserStream(
            SimpleNamespace(send_json=self.send_json),
            self.browser,
            "lease",
            video_player=True,
            video_streams=self.streams,
        )
        self.assertEqual(
            (stream.transport, stream.video_support["reason"]),
            ("jpeg", "environment-unsupported"),
        )
        self.browser.transport = object()
        unavailable = VideoStreams(StreamConfig())
        self.assertEqual(
            unavailable.support(self.browser),
            {"available": False, "reason": "video-not-configured"},
        )
        self.assertEqual(self.processes, [])

    async def test_token_failure_and_publisher_exit_notify_all_viewers(self):
        viewer = self.viewer()
        with patch.object(
            self.streams.tokens, "issue", side_effect=VideoFailure("token-failed")
        ):
            self.streams.watch(viewer)
            self.assertEqual((await self.ready(viewer))["reason"], "token-failed")
        one, two = self.viewer("one"), self.viewer("two")
        self.streams.watch(one)
        self.streams.watch(two)
        await asyncio.gather(self.ready(one), self.ready(two))
        self.processes[0].stdout.lines.put_nowait("")
        failures = await asyncio.gather(self.ready(one), self.ready(two))
        self.assertEqual(
            [m["reason"] for m in failures], ["publisher-exited", "publisher-exited"]
        )

    async def test_idle_capture_restores_on_input_and_renews_without_view_change(self):
        self.streams.config = replace(
            self.streams.config,
            video=replace(self.config, idle_after_s=0.01, token_ttl_s=0.1),
        )
        viewer = self.viewer()
        stop = self.streams.watch(viewer)
        await self.ready(viewer)
        process = self.processes[0]
        async with asyncio.timeout(2):
            while True:
                command = await process.commands.get()
                if (
                    command["t"] == "fps"
                    and command["capture_fps"] == self.config.idle_capture_fps
                ):
                    break
        self.streams.input(viewer)
        async with asyncio.timeout(1):
            while True:
                command = await process.commands.get()
                if command["t"] == "fps":
                    self.assertEqual(command["capture_fps"], self.config.capture_fps)
                    break
        renewed = await self.ready(viewer)
        self.assertTrue(renewed["renew"])
        self.assertEqual(viewer.vp, 0)
        await stop()
        self.streams.disconnect(viewer.connection_id)

    async def test_remove_participant_timeout_finishes_with_warning(self):
        async with fake_sfu() as (url, requests, delay):
            delay.clear()
            tokens = VideoTokens(replace(self.config, api_url=url, api_timeout_s=0.03))
            with self.assertLogs(
                "wandrun.gateway.video_stream", level="WARNING"
            ) as logs:
                operation = asyncio.create_task(tokens.remove("lease", "viewer:gone"))
                self.assertEqual(
                    await asyncio.wait_for(requests.get(), 1), ("lease", "viewer:gone")
                )
                await asyncio.wait_for(operation, 1)
            self.assertIn("removal unconfirmed", logs.output[0])

    async def test_video_state_input_keeps_epoch_and_view_barriers_without_frame(self):
        stream = self.viewer()
        stream.css = (800, 600)
        base = {"epoch": 3, "vp": 0, "page": "one", "x": 20, "y": 20, "ts": 1000}
        for buttons, x in ((0, 20), (1, 20), (1, 40), (0, 40)):
            await stream._input({"t": "pointer", **base, "buttons": buttons, "x": x})
        self.assertEqual(
            [params["type"] for method, params in self.browser.inputs],
            ["mouseMoved", "mousePressed", "mouseMoved", "mouseReleased"])
        with self.assertRaisesRegex(ValueError, "stale-epoch"):
            await stream._input({"t": "text", "text": "old", "epoch": 2, "vp": 0, "page": "one"})
        stream._invalidate()
        with self.assertRaisesRegex(ValueError, "stale-viewport"):
            await stream._input({"t": "pointer", **base, "buttons": 1})



    async def test_review_page_publish_timeout_preserves_other_lease(self):
        first = self.viewer()
        stop_first = self.streams.watch(first)
        await self.ready(first)
        self.processes[0].publish = False
        second = self.viewer("two")
        second.lease_id = "another-lease"
        stop_second = self.streams.watch(second)
        failure = await self.ready(second)
        self.assertEqual(failure["reason"], "page-publish-timeout")
        self.assertTrue(first.events.empty())
        self.assertFalse(self.processes[0].eof)
        self.assertTrue(self.streams.retry(first))
        self.assertEqual((await self.ready(first))["state"], "ready")
        await stop_first()
        await stop_second()

    async def test_page_timeout_preserves_another_starting_track(self):
        self.publish = False
        first = self.viewer()
        stop_first = self.streams.watch(first)
        async with asyncio.timeout(1):
            while not self.processes:
                await asyncio.sleep(0)
            process = self.processes[0]
            while (await process.commands.get())["t"] != "watch":
                pass
        environment = self.streams.environments[self.browser]
        # First track already owns its original timeout; keep the second pending.
        environment.config = replace(environment.config, start_timeout_s=0.5)
        second = self.viewer("two")
        stop_second = self.streams.watch(second)
        async with asyncio.timeout(1):
            while (watch := await process.commands.get())["t"] != "watch":
                pass
        self.assertEqual((await self.ready(first))["reason"], "page-publish-timeout")
        self.assertFalse(process.eof)
        process.emit(
            t="track", track=watch["track"], target=watch["target"], state="published"
        )
        self.assertEqual((await self.ready(second))["state"], "ready")
        self.assertEqual(len(self.processes), 1)
        await stop_first()
        await stop_second()

    async def test_review_late_exec_cannot_overlap_retry(self):
        accepted, acknowledge = asyncio.Event(), asyncio.Event()
        maximum = 0

        async def delayed_open(environment):
            nonlocal maximum
            process = AutoProcess()
            self.processes.append(process)
            maximum = max(maximum, sum(not p.eof for p in self.processes))
            if len(self.processes) == 1:
                accepted.set()
                await acknowledge.wait()
            return process

        with patch.object(_VideoEnvironment, "_open", delayed_open):
            try:
                first = self.viewer()
                self.streams.watch(first)
                await accepted.wait()
                self.assertEqual(
                    (await self.ready(first))["reason"], "publisher-start-timeout"
                )
                retry = self.viewer()
                self.streams.watch(retry)
                result = await self.ready(retry)
                self.assertEqual(result.get("reason"), "publisher-start-timeout")
                self.assertEqual(len(self.processes), 1)
            finally:
                acknowledge.set()
            final = self.viewer()
            stop = self.streams.watch(final)
            self.assertEqual((await self.ready(final))["state"], "ready")
            self.assertEqual(maximum, 1)
            await stop()

    async def test_review_low_grace_preserves_entire_predecessor_chain(self):
        self.streams.config = replace(
            self.streams.config,
            video=replace(
                self.config,
                publisher_idle_s=0.005,
                start_timeout_s=0.08,
                api_timeout_s=0.5,
            ),
        )
        first = self.viewer()
        stop = self.streams.watch(first)
        await self.ready(first)
        eof, release = asyncio.Event(), asyncio.Event()
        process = self.processes[0]

        def write_eof():
            process.eof = True
            eof.set()

        async def wait_closed():
            await release.wait()
            process.exit_status = 0

        process.stdin.write_eof = write_eof
        process.wait_closed = wait_closed
        try:
            await stop()
            await asyncio.wait_for(eof.wait(), 1)
            middle = self.viewer()
            stop_middle = self.streams.watch(middle)
            # Let B own a startup waiting on A before ending B's watch.
            environment = self.streams.environments[self.browser]
            async with asyncio.timeout(1):
                while environment.publisher is None:
                    await asyncio.sleep(0)
            await stop_middle()
            await environment._idle
            third = self.viewer()
            self.streams.watch(third)
            result = await self.ready(third)
            self.assertEqual(result.get("reason"), "publisher-start-timeout")
            self.assertEqual(len(self.processes), 1)
        finally:
            release.set()
        final = self.viewer()
        stop_final = self.streams.watch(final)
        self.assertEqual((await self.ready(final))["state"], "ready")
        self.assertEqual(len(self.processes), 2)
        await stop_final()

    async def test_review_jpeg_human_input_restores_same_page_video_fps(self):
        viewer = self.viewer()
        stop = self.streams.watch(viewer)
        await self.ready(viewer)
        environment = self.streams.environments[self.browser]
        track = environment.tracks[("lease", "one")]
        track.fps, track.last_input = self.config.idle_capture_fps, 0
        incoming = asyncio.Queue()

        async def receive_text():
            message = await incoming.get()
            if message is None:
                raise WebSocketDisconnect()
            return json.dumps(message)

        operator = BrowserStream(
            SimpleNamespace(receive_text=receive_text),
            self.browser,
            "lease",
            control=True,
            video_player=False,
            video_streams=self.streams,
        )
        operator.page = "one"
        incoming.put_nowait(
            {"t": "text", "id": 1, "epoch": 3, "vp": 0, "frame": 1, "text": "hello"}
        )
        incoming.put_nowait(None)
        with self.assertRaises(WebSocketDisconnect):
            await operator._read_messages_loop()
        self.assertEqual(track.fps, self.config.capture_fps)
        self.assertGreater(track.last_input, 0)
        async with asyncio.timeout(1):
            while (command := await self.processes[0].commands.get())["t"] != "fps":
                pass
        self.assertEqual(command["capture_fps"], self.config.capture_fps)
        await stop()

    async def test_readonly_input_does_not_wake_video_capture(self):
        viewer = self.viewer()
        stop = self.streams.watch(viewer)
        await self.ready(viewer)
        track = self.streams.environments[self.browser].tracks[("lease", "one")]
        track.fps, track.last_input = self.config.idle_capture_fps, 0
        incoming = iter((json.dumps({"t": "text", "id": 1, "text": "ignored"}),))

        async def receive_text():
            try:
                return next(incoming)
            except StopIteration:
                raise WebSocketDisconnect()

        readonly = BrowserStream(
            SimpleNamespace(receive_text=receive_text),
            self.browser,
            "lease",
            video_streams=self.streams,
        )
        readonly.page = "one"
        with self.assertRaises(WebSocketDisconnect):
            await readonly._read_messages_loop()
        self.assertEqual(
            (track.fps, track.last_input), (self.config.idle_capture_fps, 0)
        )
        await stop()

    async def test_unexpected_start_error_releases_budget_and_redacts_logs(self):
        # Recovery/redaction, not startup latency: tolerate CI scheduling jitter.
        self.streams.config = replace(
            self.streams.config, video=replace(self.config, start_timeout_s=1)
        )
        viewer = self.viewer()
        key, secret = read_test_keys(self.keys)
        token = self.streams.tokens.issue("lease", "publisher:lease", publish=True)
        with self.assertLogs("wandrun.gateway.video_stream", level="ERROR") as logs:
            with patch.object(
                _VideoEnvironment,
                "_open",
                side_effect=RuntimeError(key + secret + token),
            ):
                self.streams.watch(viewer)
                self.assertEqual(
                    (await self.ready(viewer))["reason"], "publisher-exited"
                )
        for value in (key, secret, token):
            self.assertNotIn(value, "\\n".join(logs.output))
        replacement = self.viewer()
        stop = self.streams.watch(replacement)
        self.assertEqual((await self.ready(replacement))["state"], "ready")
        await stop()

    async def test_retirement_close_exception_does_not_poison_next_watch(self):
        viewer = self.viewer()
        stop = self.streams.watch(viewer)
        await self.ready(viewer)
        environment = self.streams.environments[self.browser]
        publisher, process = environment.publisher, self.processes[0]
        original = process.close
        key, secret = read_test_keys(self.keys)

        def broken_close():
            raise RuntimeError(key + secret)

        process.close = broken_close
        try:
            with self.assertLogs(
                "wandrun.gateway.video_stream", level="WARNING"
            ) as logs:
                await stop()
                await asyncio.gather(environment._idle, return_exceptions=True)
                replacement = self.viewer()
                stop_next = self.streams.watch(replacement)
                self.assertEqual((await self.ready(replacement)).get("state"), "ready")
                self.assertEqual(len(self.processes), 2)
                await stop_next()
            for value in (key, secret):
                self.assertNotIn(value, "\n".join(logs.output))
        finally:
            process.close = original
            # Let baseline cleanup retry the deliberately failed local close.
            publisher.confirmed = False

    async def test_retirement_close_exception_still_waits_for_late_opening(self):
        acknowledge, accepted = asyncio.Event(), asyncio.Event()
        maximum = 0

        async def delayed_open(environment):
            nonlocal maximum
            process = AutoProcess()
            self.processes.append(process)
            maximum = max(maximum, sum(not p.eof for p in self.processes))
            if len(self.processes) == 1:
                accepted.set()
                await acknowledge.wait()
            return process

        close = Publisher._close

        async def broken_local_close(publisher):
            await close(publisher)
            if publisher is first_publisher:
                raise RuntimeError("synthetic local close failure")

        first_publisher = None
        with patch.object(_VideoEnvironment, "_open", delayed_open):
            try:
                with patch.object(Publisher, "_close", broken_local_close):
                    first = self.viewer()
                    self.streams.watch(first)
                    await accepted.wait()
                    first_publisher = self.streams.environments[self.browser].publisher
                    self.assertEqual(
                        (await self.ready(first))["reason"], "publisher-start-timeout"
                    )
                    retry = self.viewer()
                    self.streams.watch(retry)
                    self.assertEqual(
                        (await self.ready(retry)).get("reason"),
                        "publisher-start-timeout",
                    )
                    self.assertEqual(len(self.processes), 1)
                acknowledge.set()
                final = self.viewer()
                stop_final = self.streams.watch(final)
                self.assertEqual((await self.ready(final)).get("state"), "ready")
                self.assertEqual(maximum, 1)
                await stop_final()
            finally:
                acknowledge.set()
                if first_publisher:
                    if first_publisher._opening is not None:
                        await asyncio.gather(
                            first_publisher._opening, return_exceptions=True
                        )
                    first_publisher.confirmed = False




    async def control_after_current_page_closes(self, message):
        incoming, outgoing = asyncio.Queue(), asyncio.Queue()

        async def receive_text():
            return json.dumps(await incoming.get())

        stream = BrowserStream(
            SimpleNamespace(receive_text=receive_text, send_json=outgoing.put),
            self.browser, "lease", control=True, video_streams=self.streams,
        )
        await stream._sync_pages()
        # The frame is queued before the worker observes the closed current page.
        incoming.put_nowait(message)
        self.browser.snapshot["pages"] = [p for p in self.browser.snapshot["pages"] if p["id"] != "one"]
        self.browser.snapshot["current"] = "two"
        receiver = asyncio.create_task(stream._receive())
        pages = []
        try:
            async with asyncio.timeout(1):
                while True:
                    reply = await outgoing.get()
                    if reply["t"] == "pages":
                        pages.append(reply)
                    if reply.get("id") == message["id"]:
                        return reply, pages[-1]
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            await stream._cleanup()





    async def test_control_switch_page_survives_current_page_close(self):
        reply, pages = await self.control_after_current_page_closes(
            {"t": "switch_page", "id": "page", "target": "three"})
        self.assertEqual(reply["t"], "page_done")
        self.assertEqual(pages["current"], "three")

    async def test_control_switch_to_closed_page_uses_target_rule(self):
        reply, pages = await self.control_after_current_page_closes(
            {"t": "switch_page", "id": "page", "target": "one"})
        self.assertEqual((reply["t"], reply.get("why")), ("reject", "no-such-page"))
        self.assertEqual(pages["current"], "two")


def read_test_keys(path):
    from wandrun.gateway.stream_config import read_keys

    return read_keys(path)


class StreamConfigTests(unittest.TestCase):
    def test_unknown_invalid_limits_and_unsafe_key_permissions_fail_at_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            key = root / "keys.yaml"
            key.write_text("key: secret\n")
            key.chmod(0o600)
            config = root / "stream.toml"
            base = f'[stream.video]\nurl="wss://sfu.test"\napi_url="http://127.0.0.1:7880"\nkey_file="{key}"\n'
            for extra in (
                "watch_limit=0",
                "start_timeout_s=nan",
                "unknown=1",
                "jpeg_quality=101",
            ):
                config.write_text(base + extra)
                with self.subTest(extra=extra), self.assertRaises(ValueError):
                    load_stream_config(config)
            config.write_text(base)
            self.assertEqual(load_stream_config(config).video.watch_limit, 2)
            key.chmod(0o644)
            with self.assertRaises(ValueError):
                load_stream_config(config)


    def test_retired_defaults_and_mode_switch_budget_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "stream.toml"
            for text in ('[stream]\ndefault_transport="video"\n',
                         '[stream]\ndefault_input_mode="streaming"\n',
                         '[stream.input]\nmode_switch_timeout_s=2\n'):
                config.write_text(text)
                with self.subTest(text=text), self.assertRaises(ValueError):
                    load_stream_config(config)
