"""Read-only sandbox video publisher, shipped as python -c source over SSH.

stdin/stdout implement browser-stream-protocol.md §5. EOF cancels even an
in-progress connect; all CDP sockets and SFU rooms belong to this process.
No input injection, browser launch, software installation or inbound listener.
Only dependencies: livekit==1.2.0, pillow==13.0.0, websockets==17.4.
"""

import argparse
import asyncio
import base64
import contextlib
import io
import json
import logging
import math
import os
import signal
import sys
import time
from urllib.parse import urlsplit
from dataclasses import dataclass

MAX_LINE = 65536
IO_TIMEOUT = 10


class PublisherError(Exception):
    def __init__(self, code):
        self.code = code


def emit(t, **fields):
    print(json.dumps({"t": t, **fields}, separators=(",", ":")), flush=True)


def positive(value):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise ValueError("positive finite number required")
    return value


def text(message, key):
    value = message[key]
    if not isinstance(value, str) or not value:
        raise ValueError("nonempty string required")
    return value


@dataclass(frozen=True)
class Config:
    url: str
    codec: str
    max_kbps: float
    jpeg_quality: int
    idle_resend_fps: float

    @classmethod
    def parse(cls, message):
        url, codec = text(message, "url"), text(message, "codec")
        if not url.startswith("wss://") or codec not in ("h264", "vp8"):
            raise ValueError("invalid url or codec")
        quality = message["jpeg_quality"]
        if (
            isinstance(quality, bool)
            or not isinstance(quality, int)
            or not 0 <= quality <= 100
        ):
            raise ValueError("invalid jpeg_quality")
        return cls(
            url,
            codec,
            positive(message["max_kbps"]),
            quality,
            positive(message["idle_resend_fps"]),
        )


class CDP:
    """One page websocket; replies never block immediate screencast ACKs."""

    def __init__(self, ws, on_frame):
        self.ws, self.on_frame = ws, on_frame
        self.next_id = 0
        self.pending = {}
        self.reader = asyncio.create_task(self.read())

    async def send(self, method, params=None):
        self.next_id += 1
        identity = self.next_id
        await self.ws.send(
            json.dumps({"id": identity, "method": method, "params": params or {}})
        )
        return identity

    async def call(self, method, params=None):
        # Register before yielding to the socket: the read task may reply at once.
        identity = self.next_id + 1
        future = asyncio.get_running_loop().create_future()
        self.pending[identity] = future
        try:
            await self.send(method, params)
            async with asyncio.timeout(IO_TIMEOUT):
                result = await future
            if "error" in result:
                raise PublisherError("cdp-unreachable")
            return result.get("result", {})
        finally:
            self.pending.pop(identity, None)

    async def read(self):
        try:
            async for raw in self.ws:
                message = json.loads(raw)
                if message.get("method") == "Page.screencastFrame":
                    params = message["params"]
                    await self.send(
                        "Page.screencastFrameAck", {"sessionId": params["sessionId"]}
                    )
                    self.on_frame(params)
                elif (
                    future := self.pending.get(message.get("id"))
                ) is not None and not future.done():
                    future.set_result(message)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(PublisherError("cdp-unreachable"))

    async def close(self):
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)
        await self.ws.close()


class Capture:
    """Latest-frame slot; ACK all, drop before decode, retain one decoded idle frame."""

    def __init__(self, publisher, message, room):
        self.owner, self.room = publisher, room
        self.name, self.target = message["track"], message["target"]
        self.fps = message["capture_fps"]
        self.cdp = self.publication = self.source = self.local_track = None
        self.task = None
        self.latest = None
        self.fresh = asyncio.Event()
        self.frame = None
        self.last_sent = -math.inf
        self.received = self.sent = self.dropped = 0
        self.started_at = time.monotonic()
        self.view = None
        self.published = False
        self.last_bytes = None

    def state(self, state):
        self.published = state == "published"
        self.owner.emit("track", track=self.name, target=self.target, state=state)

    def receive(self, params):
        self.received += 1
        if self.latest is not None:
            self.dropped += 1
        self.latest = params
        self.fresh.set()

    async def open(self):
        import websockets

        try:
            # Use our fixed loopback destination, not a remotely supplied CDP URL.
            ws = await websockets.connect(
                f"ws://127.0.0.1:{self.owner.port}/devtools/page/{self.target}",
                proxy=None,
                max_size=32 << 20,
                open_timeout=IO_TIMEOUT,
                close_timeout=1,
            )
            self.cdp = CDP(ws, self.receive)
            await self.cdp.call(
                "Page.startScreencast",
                {
                    "format": "jpeg",
                    "quality": self.owner.config.jpeg_quality,
                    "everyNthFrame": 1,
                },
            )
        except PublisherError:
            raise
        except websockets.exceptions.InvalidStatus as error:
            code = (
                "target-not-found"
                if error.response.status_code == 404
                else "cdp-unreachable"
            )
            raise PublisherError(code) from None
        except Exception:
            raise PublisherError("cdp-unreachable") from None

    def decode(self, params):
        from livekit import rtc
        from PIL import Image

        with Image.open(io.BytesIO(base64.b64decode(params["data"]))) as image:
            rgba = image.convert("RGBA")
            return rtc.VideoFrame(
                image.width, image.height, rtc.VideoBufferType.RGBA, rgba.tobytes()
            )

    async def run(self):
        from livekit import rtc

        try:
            while True:
                # A page closing must not leave a frozen, apparently healthy track.
                if self.cdp.reader.done():
                    raise PublisherError("cdp-unreachable")
                if not self.room.sdk.isconnected():
                    raise PublisherError("sfu-unreachable")
                if self.latest is None and self.frame is None:
                    self.fresh.clear()
                    waiter = asyncio.create_task(self.fresh.wait())
                    try:
                        await asyncio.wait(
                            (waiter, self.cdp.reader),
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        waiter.cancel()
                        await asyncio.gather(waiter, return_exceptions=True)
                    continue
                if self.latest is None:
                    self.fresh.clear()
                    idle_delay = (
                        self.last_sent
                        + 1 / min(self.fps, self.owner.config.idle_resend_fps)
                        - time.monotonic()
                    )
                    if idle_delay > 0:
                        with contextlib.suppress(asyncio.TimeoutError):
                            await asyncio.wait_for(self.fresh.wait(), idle_delay)
                delay = self.last_sent + 1 / self.fps - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                if self.latest is not None:
                    params, self.latest = self.latest, None
                    self.frame = await asyncio.to_thread(self.decode, params)
                    meta = params["metadata"]
                    css = [round(meta["deviceWidth"]), round(meta["deviceHeight"])]
                    dpr = meta.get("deviceScaleFactor", self.frame.width / css[0])
                    view = (tuple(css), dpr)
                    if view != self.view:
                        self.view = view
                        self.owner.revision += 1
                        self.owner.emit(
                            "view",
                            track=self.name,
                            target=self.target,
                            css=css,
                            dpr=dpr,
                            revision=self.owner.revision,
                        )
                if self.source is None:
                    self.source = rtc.VideoSource(self.frame.width, self.frame.height)
                    self.local_track = rtc.LocalVideoTrack.create_video_track(
                        self.name, self.source
                    )
                    config = self.owner.config
                    options = rtc.TrackPublishOptions(
                        source=rtc.TrackSource.SOURCE_SCREENSHARE,
                        simulcast=False,
                        video_codec=rtc.VideoCodec.H264
                        if config.codec == "h264"
                        else rtc.VideoCodec.VP8,
                        video_encoding=rtc.VideoEncoding(
                            max_bitrate=int(config.max_kbps * 1000), max_framerate=30
                        ),
                    )
                    try:
                        self.publication = (
                            await self.room.sdk.local_participant.publish_track(
                                self.local_track, options
                            )
                        )
                    except Exception:
                        raise PublisherError("sfu-unreachable") from None
                    if not self.published:
                        self.state("published")
                self.source.capture_frame(self.frame)
                self.last_sent = time.monotonic()
                self.sent += 1
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Never echo SDK exceptions: connection diagnostics may contain JWTs.
            code = (
                error.code if isinstance(error, PublisherError) else "cdp-unreachable"
            )
            self.owner.emit("error", code=code, track=self.name)
            async with self.owner.lifecycle:
                await self.owner.remove(self.name, from_capture=True)

    async def close(self, from_capture=False):
        if self.task is not None and not from_capture:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.cdp is not None:
            # Closing the CDP session stops its screencast without affecting Chrome.
            await self.cdp.close()
        if self.publication is not None:
            with contextlib.suppress(Exception):
                async with asyncio.timeout(3):
                    await self.room.sdk.local_participant.unpublish_track(
                        self.publication.sid
                    )
        if self.source is not None:
            await self.source.aclose()
        self.state("stopped")


class Room:
    def __init__(self, owner, name, token):
        from livekit import rtc

        self.owner, self.name, self.token = owner, name, token
        self.sdk = rtc.Room()
        self.closing = False
        self.protocol = None
        for state in ("connected", "reconnecting", "reconnected", "disconnected"):
            self.sdk.on(state, lambda *args, state=state: self.event(state))
        self.sdk.on("local_track_unpublished", self.unpublished)
        self.sdk.on("local_track_published", self.published)
        self.sdk.on("local_track_republished", self.republished)

    def event(self, state):
        if not self.closing:
            self.owner.emit("conn", room=self.name, state=state, protocol=self.protocol)

    def unpublished(self, publication):
        for track in self.owner.tracks.values():
            if (
                track.room is self
                and track.publication is not None
                and track.publication.sid == publication.sid
            ):
                track.state("stopped")

    def published(self, publication, local_track):
        for track in self.owner.tracks.values():
            if (
                track.room is self
                and track.local_track is local_track
                and not track.published
            ):
                track.publication = publication
                track.state("published")

    def republished(self, publication, previous_sid):
        for track in self.owner.tracks.values():
            if track.room is self and track.publication is publication:
                track.state("published")

    async def connect(self):
        from livekit import rtc

        self.event("connecting")
        try:
            await self.sdk.connect(
                self.owner.config.url,
                self.token,
                options=rtc.RoomOptions(auto_subscribe=False),
            )
        except Exception:
            self.event("failed")
            raise PublisherError("sfu-unreachable") from None

    async def close(self):
        self.closing = True
        with contextlib.suppress(Exception):
            async with asyncio.timeout(3):
                await self.sdk.disconnect()
        self.owner.emit(
            "conn", room=self.name, state="disconnected", protocol=self.protocol
        )


class Publisher:
    def __init__(self, port, output=emit):
        self.port, self.emit = port, output
        self.config = None
        self.rooms, self.tracks = {}, {}
        self.revision = 0
        self.lifecycle = asyncio.Lock()

    async def remove(self, name, from_capture=False):
        track = self.tracks.pop(name, None)
        if track is None:
            return
        await track.close(from_capture)
        if not any(t.room is track.room for t in self.tracks.values()):
            self.rooms.pop(track.room.name, None)
            await track.room.close()

    async def dispatch(self, message):
        async with self.lifecycle:
            await self.handle(message)

    async def handle(self, message):
        kind = message["t"]
        if kind == "config":
            config = Config.parse(message)
            old = self.config
            self.config = config
            if old is not None and old != config:
                # Recreate tracks on changed capture/encoding config, preserving watch intent.
                watches = [
                    {
                        "t": "watch",
                        "track": t.name,
                        "target": t.target,
                        "room": t.room.name,
                        "token": t.room.token,
                        "capture_fps": t.fps,
                    }
                    for t in self.tracks.values()
                ]
                await self.close()
                for watch in watches:
                    await self.handle(watch)
            return
        if self.config is None:
            raise ValueError("config must be first")
        if kind == "watch":
            name, room_name, target, token = (
                text(message, k) for k in ("track", "room", "target", "token")
            )
            fps = positive(message["capture_fps"])
            await self.remove(name)
            room = self.rooms.get(room_name)
            if room is None:
                room = Room(self, room_name, token)
                self.rooms[room_name] = room
            capture = Capture(
                self, {"track": name, "target": target, "capture_fps": fps}, room
            )
            self.tracks[name] = capture
            try:
                await capture.open()
                if not room.sdk.isconnected():
                    await room.connect()
                capture.task = asyncio.create_task(capture.run())
            except BaseException:
                await self.remove(name)
                raise
        elif kind == "unwatch":
            await self.remove(text(message, "track"))
        elif kind == "fps":
            name, fps = text(message, "track"), positive(message["capture_fps"])
            if name in self.tracks:
                self.tracks[name].fps = fps
        elif kind == "token":
            name, token = text(message, "room"), text(message, "token")
            if name in self.rooms:
                room = self.rooms[name]
                # Existing SDK connections refresh credentials with the SFU themselves.
                # Keep this only for the next application-owned connect/config rebuild.
                room.token = token
        else:
            raise ValueError("unknown message")

    async def close(self):
        for name in list(self.tracks):
            await self.remove(name)
        for room in list(self.rooms.values()):
            await room.close()
        self.rooms.clear()

    async def stats(self):
        previous_cpu, previous_time = time.process_time(), time.monotonic()
        previous = {}
        while True:
            await asyncio.sleep(5)
            now, cpu = time.monotonic(), time.process_time()
            seconds = now - previous_time
            for room in list(self.rooms.values()):
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(1):
                        reports = (await room.sdk.get_rtc_stats()).publisher_stats
                    selected = {
                        r.transport.transport.selected_candidate_pair_id
                        for r in reports
                        if r.HasField("transport")
                    }
                    candidates = {
                        r.candidate_pair.candidate_pair.local_candidate_id
                        for r in reports
                        if r.HasField("candidate_pair")
                        and r.candidate_pair.rtc.id in selected
                    }
                    protocol = next(
                        (
                            r.local_candidate.candidate.protocol
                            for r in reports
                            if r.HasField("local_candidate")
                            and r.local_candidate.rtc.id in candidates
                        ),
                        None,
                    )
                    if protocol in ("udp", "tcp") and protocol != room.protocol:
                        room.protocol = protocol
                        room.event("connected")
            rows = []
            for name, track in list(self.tracks.items()):
                # A reused track name is not the same counter lifetime.
                # Snapshot before SDK awaits so elapsed time and counters agree.
                sampled_at = time.monotonic()
                counts = (track.received, track.sent, track.dropped)
                baseline_at, received, sent, dropped = previous.get(
                    track, (track.started_at, 0, 0, 0)
                )
                track_seconds = sampled_at - baseline_at
                kbps = None
                if track.local_track is not None:
                    with contextlib.suppress(Exception):
                        async with asyncio.timeout(1):
                            reports = await track.local_track.get_stats()
                        for report in reports:
                            if report.HasField("outbound_rtp"):
                                total = report.outbound_rtp.sent.bytes_sent
                                if (
                                    track.last_bytes is not None
                                    and total >= track.last_bytes
                                ):
                                    kbps = (
                                        (total - track.last_bytes)
                                        * 8
                                        / track_seconds
                                        / 1000
                                    )
                                track.last_bytes = total
                rows.append(
                    {
                        "track": name,
                        "capture_fps": (counts[0] - received) / track_seconds,
                        "sent_fps": (counts[1] - sent) / track_seconds,
                        "dropped": counts[2] - dropped,
                        "encode_kbps": kbps,
                        "protocol": track.room.protocol,
                    }
                )
                previous[track] = (sampled_at, *counts)
            previous = {
                track: value
                for track, value in previous.items()
                if self.tracks.get(track.name) is track
            }
            # Linux resident pages, not ru_maxrss (which is the historical peak).
            with open("/proc/self/statm") as stream:
                rss = int(stream.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 2**20
            self.emit(
                "stats", tracks=rows, cpu=(cpu - previous_cpu) / seconds, rss_mb=rss
            )
            previous_cpu, previous_time = cpu, now


async def run(reader, publisher):
    """Read independently of command execution so EOF interrupts slow SDK/CDP I/O."""
    queue = asyncio.Queue()
    ended = asyncio.Event()

    async def receive():
        try:
            while True:
                try:
                    raw = await reader.readuntil(b"\n")
                except asyncio.LimitOverrunError as error:
                    await reader.readexactly(error.consumed)
                    # Discard the remainder of this oversized line, not its suffix as a command.
                    while True:
                        try:
                            await reader.readuntil(b"\n")
                            break
                        except asyncio.LimitOverrunError as rest:
                            await reader.readexactly(rest.consumed)
                        except asyncio.IncompleteReadError:
                            return
                    publisher.emit("error", code="bad-message")
                    continue
                except asyncio.IncompleteReadError:
                    return
                try:
                    if len(raw) > MAX_LINE:
                        raise ValueError("line too long")
                    message = json.loads(raw)
                    if not isinstance(message, dict) or not isinstance(
                        message.get("t"), str
                    ):
                        raise ValueError("object required")
                    if message["t"] == "stop":
                        return
                except (ValueError, UnicodeError):
                    publisher.emit("error", code="bad-message")
                    continue
                queue.put_nowait(message)
        finally:
            ended.set()

    async def commands():
        while True:
            message = await queue.get()
            try:
                await publisher.dispatch(message)
            except (KeyError, ValueError, TypeError):
                publisher.emit("error", code="bad-message")
            except PublisherError as error:
                publisher.emit(
                    "error",
                    code=error.code,
                    **{k: message[k] for k in ("track", "room") if k in message},
                )

    receiving = asyncio.create_task(receive())
    executing = asyncio.create_task(commands())
    reporting = asyncio.create_task(publisher.stats())
    waiting = asyncio.create_task(ended.wait())
    try:
        await asyncio.wait(
            (waiting, receiving, executing, reporting),
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in (receiving, executing, reporting):
            if task.done():
                task.result()
    finally:
        for task in (receiving, executing, reporting, waiting):
            task.cancel()
        await asyncio.gather(
            receiving, executing, reporting, waiting, return_exceptions=True
        )
        await publisher.close()


async def main():
    # Dependency import is part of ready. Never leak SDK diagnostics/tokens to stdout/stderr.
    logging.disable(logging.CRITICAL)
    from livekit import rtc  # noqa: F401
    from PIL import Image  # noqa: F401
    import websockets  # noqa: F401

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cdp-url", required=True)
    args = parser.parse_args()
    address = urlsplit(args.cdp_url)
    if (
        address.scheme != "http"
        or address.hostname not in ("127.0.0.1", "localhost", "::1")
        or not address.port
        or address.username
        or address.password
        or address.path not in ("", "/")
        or address.query
        or address.fragment
    ):
        parser.error("--cdp-url requires loopback HTTP with an explicit port")
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LINE)
    transport, _ = await loop.connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer
    )
    task = asyncio.create_task(run(reader, Publisher(address.port)))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        loop.add_signal_handler(sig, task.cancel)
    emit("ready", version=2, pid=os.getpid())
    try:
        await task
    except asyncio.CancelledError:
        pass
    finally:
        transport.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BrokenPipeError:
        pass
    except Exception:
        # Exception text from third-party transports can include credentials.
        print("video publisher failed", file=sys.stderr)
        raise SystemExit(1) from None
