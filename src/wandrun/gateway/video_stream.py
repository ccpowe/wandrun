"""Environment-scoped video publisher ownership (protocol: browser-stream-protocol.md).

An accepted SSH exec always has an owner, including after startup timeout or caller
cancellation. Closing stdin stops the remote publisher; uncertain SSH exits are
logged, never used as a barrier to lease termination. No automatic restart.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
import shlex
import time
from uuid import uuid4

import asyncssh

from livekit import api

from wandrun.gateway.stream_config import read_keys

logger = logging.getLogger(__name__)
LINE_LIMIT = 65536


class VideoFailure(Exception):
    """A video attempt failed; args[0] is the public protocol reason."""


class Publisher:
    """One exec; start is single-flight, close fences all late output and execs.

    open_process establishes an independent SSH exec on the command connection.
    on_message is synchronous: it must enqueue work rather than block stdout.
    The startup deadline includes both exec establishment and the ready line.
    """

    def __init__(
        self, open_process, config, on_message, *, timeout=15, close_timeout=5
    ):
        self._open_process = open_process
        self._config = config
        self._on_message = on_message
        self.timeout = timeout
        self.close_timeout = close_timeout
        self.process = None
        self.confirmed = False
        self._opening = None
        self._starting = None
        self._closing = None
        self._reader = None
        self._stderr = None
        self._closed = False
        self._ready = asyncio.get_running_loop().create_future()
        self._ready.add_done_callback(self._consume)
        self._write_lock = asyncio.Lock()

    @staticmethod
    def _consume(task):
        if not task.cancelled():
            task.exception()

    async def _open(self):
        process = await self._open_process()
        self.process = process
        if self._closed:
            await self._stop_process(process)
            raise VideoFailure("publisher-exited")
        self._reader = asyncio.create_task(self._read())
        self._stderr = asyncio.create_task(self._drain_stderr())
        await self.send({"t": "config", **self._config})

    async def _start(self):
        if self._closed:
            raise VideoFailure("publisher-exited")
        try:
            async with asyncio.timeout(self.timeout):
                self._opening = asyncio.create_task(self._open())
                self._opening.add_done_callback(self._consume)
                await asyncio.shield(self._opening)
                await asyncio.shield(self._ready)
        except TimeoutError:
            await self.aclose()
            raise VideoFailure("publisher-start-timeout") from None
        except BaseException:
            await self.aclose()
            raise

    async def start(self):
        if self._closed:
            raise VideoFailure("publisher-exited")
        if self._starting is None:
            self._starting = asyncio.create_task(self._start())
            self._starting.add_done_callback(self._consume)
        # A cancelled viewer must not cancel another viewer's shared startup.
        await asyncio.shield(self._starting)

    async def send(self, message):
        try:
            async with asyncio.timeout(self.close_timeout):
                async with self._write_lock:
                    if self._closed or self.process is None:
                        raise VideoFailure("publisher-exited")
                    self.process.stdin.write(
                        json.dumps(message, separators=(",", ":")) + "\n"
                    )
                    await self.process.stdin.drain()
        except (TimeoutError, OSError, asyncssh.Error):
            raise VideoFailure("publisher-exited") from None

    async def _read(self):
        reason = "publisher-exited"
        try:
            while not self._closed:
                line = await self.process.stdout.readline()
                if self._closed or not line:
                    break
                if len(line.encode()) > LINE_LIMIT:
                    logger.warning("Oversized publisher line ignored")
                    continue
                try:
                    message = json.loads(line)
                    if not isinstance(message, dict):
                        raise ValueError
                except (ValueError, TypeError):
                    logger.warning("Malformed publisher line ignored")
                    continue
                kind = message.get("t")
                if kind == "ready":
                    if not self._ready.done():
                        self._ready.set_result(None)
                elif (
                    kind == "error" and message.get("code") == "publisher-not-installed"
                ):
                    reason = "publisher-not-installed"
                    break
                elif kind in ("track", "view", "conn", "stats", "error"):
                    self._on_message(message)
                else:
                    logger.warning("Unknown publisher line ignored")
        except (OSError, ConnectionError, ValueError, asyncssh.Error):
            pass
        finally:
            if not self._ready.done():
                self._ready.set_exception(VideoFailure(reason))
            if not self._closed:
                self._on_message(
                    {"t": "exit", "reason": reason, "code": self.process.exit_status}
                )

    async def _drain_stderr(self):
        # Never log remote content: upstream diagnostics can include credentials.
        while await self.process.stderr.read(4096):
            logger.debug("Publisher stderr received (content suppressed)")

    async def _stop_process(self, process):
        try:
            with contextlib.suppress(OSError, ConnectionError, asyncssh.Error):
                process.stdin.write_eof()
            async with asyncio.timeout(self.close_timeout):
                await process.wait_closed()
            self.confirmed = (
                process.exit_status is not None
                and process.exit_status >= 0
                or getattr(process, "exit_signal", None) is not None
            )
            if not self.confirmed:
                logger.warning("Publisher exit unconfirmed after SSH close")
        except (TimeoutError, OSError, ConnectionError, asyncssh.Error):
            logger.warning("Publisher exit unconfirmed; closing exec channel")
            with contextlib.suppress(OSError, ConnectionError, asyncssh.Error):
                process.terminate()
        finally:
            process.close()

    async def _close(self):
        self._closed = True
        if not self._ready.done():
            self._ready.set_exception(VideoFailure("publisher-exited"))
        try:
            if self.process is not None:
                await self._stop_process(self.process)
        finally:
            # Local close errors must not skip reader cleanup or abandon the
            # opening task, whose late handle still belongs to this Publisher.
            for task in (self._reader, self._stderr):
                if task is not None:
                    task.cancel()
            await asyncio.gather(
                *(t for t in (self._reader, self._stderr) if t is not None),
                return_exceptions=True,
            )

    async def aclose(self):
        if (
            self._closing is None
            or self._closing.done()
            and self.process is not None
            and not self.confirmed
        ):
            self._closing = asyncio.create_task(self._close())
        await asyncio.shield(self._closing)

    @property
    def closed(self):
        return self._closed

    async def finish_close(self):
        """Retirement barrier: local close plus settlement of any accepted exec.

        Unlike aclose, this may wait for a late SSH acknowledgement. Only the
        environment's background retirement chain waits here, never a viewer or
        lease shutdown. The opening task keeps ownership while waiters cancel.
        """
        failure = None
        try:
            await self.aclose()
        except Exception as error:
            failure = error
        if self._opening is not None:
            with contextlib.suppress(Exception):
                await asyncio.shield(self._opening)
        try:
            await self.aclose()
        except Exception as error:
            failure = failure or error
        if failure is not None:
            raise failure


class VideoTokens:
    """Official LiveKit grants and bounded participant removal; keys stay local."""

    def __init__(self, config):
        self.config = config

    def issue(self, room, identity, *, publish=False):
        try:
            key, secret = read_keys(self.config.key_file)
            return (
                api.AccessToken(key, secret)
                .with_identity(identity)
                .with_ttl(timedelta(seconds=self.config.token_ttl_s))
                .with_grants(
                    api.VideoGrants(
                        room_join=True,
                        room=room,
                        can_publish=publish,
                        can_subscribe=not publish,
                        can_publish_data=False,
                        can_update_own_metadata=False,
                    )
                )
                .to_jwt()
            )
        except Exception:
            raise VideoFailure("token-failed") from None

    async def remove(self, room, identity):
        try:
            async with asyncio.timeout(self.config.api_timeout_s):
                key, secret = read_keys(self.config.key_file)
                async with api.LiveKitAPI(self.config.api_url, key, secret) as client:
                    await client.room.remove_participant(
                        api.RoomParticipantIdentity(
                            room=room,
                            identity=identity,
                        )
                    )
        except Exception:
            # Neither API diagnostics nor token/key values may enter logs.
            logger.warning("Video participant removal unconfirmed")


@dataclass(eq=False)
class _Track:
    lease: str
    page: str
    id: str = field(default_factory=lambda: uuid4().hex)
    viewers: set = field(default_factory=set)
    published: bool = False
    view: dict | None = None
    revision: int = -1
    starting: asyncio.Task | None = None
    last_input: float = field(default_factory=time.monotonic)
    fps: int = 24
    ready: asyncio.Event = field(default_factory=asyncio.Event)


class VideoStreams:
    """Gateway owner for environment publishers and issued viewer identities."""

    def __init__(self, config, *, tokens=None):
        self.config = config
        self.tokens = tokens or (VideoTokens(config.video) if config.video else None)
        self.environments = {}
        self.rooms = {}
        self._removals = set()

    def support(self, browser):
        if getattr(browser, "transport", None) is None:
            return {"available": False, "reason": "environment-unsupported"}
        return {
            "available": self.config.video is not None,
            "reason": None if self.config.video else "video-not-configured",
        }

    def watch(self, stream):
        environment = self.environments.get(stream.browser)
        if environment is None:
            environment = _VideoEnvironment(self, stream.browser)
            self.environments[stream.browser] = environment
        return environment.watch(stream)

    def retry(self, stream):
        """Reissue an existing ready watch; return false if it must be reacquired."""
        environment = self.environments.get(stream.browser)
        track = (
            environment.tracks.get((stream.lease_id, stream.page))
            if environment
            else None
        )
        if track is None or stream not in track.viewers:
            return False
        if track.published:
            environment._ready(track, stream)
        return True

    def input(self, stream):
        environment = self.environments.get(stream.browser)
        if environment:
            environment.input(stream.lease_id, stream.page)

    def issued(self, stream, room):
        self.rooms.setdefault(stream.connection_id, set()).add(room)

    def disconnect(self, connection_id):
        for room in self.rooms.pop(connection_id, ()):
            task = asyncio.create_task(
                self.tokens.remove(room, "viewer:" + connection_id)
            )
            self._removals.add(task)
            task.add_done_callback(self._removals.discard)

    async def aclose(self):
        await asyncio.gather(*(e.aclose() for e in self.environments.values()))
        await asyncio.gather(*self._removals, return_exceptions=True)


class _VideoEnvironment:
    """Synchronous reservations + async I/O: no lock is held through SSH startup."""

    def __init__(self, owner, browser):
        self.owner, self.browser = owner, browser
        self.config = owner.config.video
        self.tracks = {}
        self.publisher = None
        self._publishers = set()
        self._idle = None
        self._retirement = None
        self._closed = False
        self._messages = asyncio.Queue()
        self._reader = asyncio.create_task(self._read_messages())
        self._ticker = asyncio.create_task(self._tick())
        self._next_renew = time.monotonic() + self.config.token_ttl_s * 2 / 3

    async def _open(self):
        # The publisher is supplied by the independent publisher implementation.
        # Read lazily so importing the gateway does not import RTC/native code.
        source = Path(__file__).parents[1] / "integrations" / "video_publisher.py"
        python = "/data/home/wandrun-browser/video-publisher/venv/bin/python"
        command = (
            "test -x "
            + python
            + " || { printf '%s\\n' "
            + shlex.quote('{"t":"error","code":"publisher-not-installed"}')
            + "; exit 3; }; exec "
            + python
            + " -c "
            + shlex.quote("# wandrun-video-publisher\n" + source.read_text())
            + " --cdp-url "
            + shlex.quote(f"http://127.0.0.1:{self.browser.config.cdp_port}")
        )
        return await self.browser.transport.open_browser_video_exec(command)

    def _get_publisher(self):
        if self.publisher is None:
            predecessor = self._retirement

            async def open_after_close():
                if predecessor:
                    await asyncio.shield(predecessor)
                if publisher.closed:
                    raise VideoFailure("publisher-exited")
                return await self._open()

            publisher = Publisher(
                open_after_close,
                {
                    name: getattr(self.config, name)
                    for name in (
                        "url",
                        "codec",
                        "max_kbps",
                        "jpeg_quality",
                        "idle_resend_fps",
                    )
                },
                lambda message: self._messages.put_nowait((publisher, message)),
                timeout=self.config.start_timeout_s,
                close_timeout=self.config.api_timeout_s,
            )
            self.publisher = publisher
            self._publishers.add(publisher)
        return self.publisher

    def watch(self, stream):
        if self._closed:
            raise VideoFailure("publisher-exited")
        key = stream.lease_id, stream.page
        track = self.tracks.get(key)
        if track is None:
            if len(self.tracks) >= self.config.watch_limit:
                raise VideoFailure("watch-limit")
            track = _Track(*key, fps=self.config.capture_fps)
            self.tracks[key] = track
        track.viewers.add(stream)
        if self._idle:
            self._idle.cancel()
            self._idle = None
        if track.published:
            self._ready(track, stream)
        elif track.starting is None:
            track.starting = asyncio.create_task(self._start_track(track))

        async def stop():
            if stream not in track.viewers:
                return
            track.viewers.remove(stream)
            if not track.viewers and self.tracks.get(key) is track:
                self.tracks.pop(key)
                if track.starting:
                    track.starting.cancel()
                    await asyncio.gather(track.starting, return_exceptions=True)
                if self.publisher and self.publisher.process:
                    with contextlib.suppress(
                        VideoFailure, OSError, ConnectionError, asyncssh.Error
                    ):
                        await self.publisher.send({"t": "unwatch", "track": track.id})
                self._schedule_idle()

        return stop

    async def _start_track(self, track):
        publisher = self._get_publisher()
        started = False
        try:
            # One total budget covers SSH open, ready and first publication.
            async with asyncio.timeout(self.config.start_timeout_s):
                await publisher.start()
                started = True
                if self.tracks.get((track.lease, track.page)) is not track:
                    return
                token = self.owner.tokens.issue(
                    track.lease, "publisher:" + track.lease, publish=True
                )
                await publisher.send(
                    {
                        "t": "watch",
                        "track": track.id,
                        "room": track.lease,
                        "token": token,
                        "target": track.page,
                        "capture_fps": track.fps,
                    }
                )
                await track.ready.wait()
        except TimeoutError:
            if started:
                self._fail_track(track, "page-publish-timeout")
                if not self.tracks:
                    await self._fail_publisher(publisher, "page-publish-timeout")
            else:
                await self._fail_publisher(publisher, "publisher-start-timeout")
        except asyncio.CancelledError:
            raise
        except (
            VideoFailure,
            OSError,
            ConnectionError,
            asyncssh.Error,
            ValueError,
        ) as error:
            reason = (
                str(error) if isinstance(error, VideoFailure) else "publisher-exited"
            )
            if reason in ("publisher-start-timeout", "publisher-exited"):
                await self._fail_publisher(publisher, reason)
            else:
                self._fail_track(track, reason)
        except Exception as error:
            # Do not log upstream text: diagnostics can contain tokens or content.
            logger.error("Publisher startup failed (%s)", type(error).__name__)
            await self._fail_publisher(publisher, "publisher-exited")

    def _ready(self, track, stream, *, renew=False):
        if stream._closed:
            return
        try:
            token = self.owner.tokens.issue(
                track.lease, "viewer:" + stream.connection_id
            )
        except VideoFailure:
            stream._video_event(
                track.page,
                {"t": "video_failed", "reason": "token-failed", "retryable": True},
            )
            return
        self.owner.issued(stream, track.lease)
        if track.view:
            stream._video_event(track.page, track.view)
        stream._video_event(
            track.page,
            {
                "t": "video",
                "state": "ready",
                "url": self.config.url,
                "room": track.lease,
                "token": token,
                "track": track.id,
                "page": track.page,
                "expires_in_s": self.config.token_ttl_s,
                "renew": renew,
            },
        )

    def _fail_track(self, track, reason):
        key = track.lease, track.page
        if self.tracks.get(key) is not track:
            return
        self.tracks.pop(key)
        for stream in track.viewers:
            stream._video_event(
                track.page, {"t": "video_failed", "reason": reason, "retryable": True}
            )
        if track.starting and track.starting is not asyncio.current_task():
            track.starting.cancel()
        if self.publisher and self.publisher.process:
            self._messages.put_nowait(
                (self.publisher, {"t": "_unwatch", "track": track.id})
            )
        self._schedule_idle()

    async def _fail_publisher(self, publisher, reason):
        if publisher is not self.publisher:
            return
        self.publisher = None
        for track in tuple(self.tracks.values()):
            self._fail_track(track, reason)
        self._retire(publisher)
        await self._close_publisher_locally(publisher)

    def _schedule_idle(self):
        if self.tracks or self._closed:
            return
        if self._idle:
            self._idle.cancel()
        self._idle = asyncio.create_task(self._idle_close())

    async def _idle_close(self):
        await asyncio.sleep(self.config.publisher_idle_s)
        # No await between rechecking the reservation and detaching the owner.
        if self.tracks:
            return
        publisher, self.publisher = self.publisher, None
        if publisher:
            self._retire(publisher)
            await self._close_publisher_locally(publisher)

    async def _close_publisher_locally(self, publisher):
        try:
            await publisher.aclose()
        except Exception as error:
            logger.warning("Publisher local close failed (%s)", type(error).__name__)

    def _retire(self, publisher):
        predecessor = self._retirement

        async def settle():
            if predecessor:
                try:
                    await asyncio.shield(predecessor)
                except Exception as error:
                    logger.warning(
                        "Publisher predecessor failed (%s)", type(error).__name__
                    )
            try:
                # finish_close reports errors only after all three settlement
                # stages, so error isolation cannot release a pending opening.
                await publisher.finish_close()
            except Exception as error:
                logger.warning("Publisher retirement failed (%s)", type(error).__name__)
            if publisher.confirmed:
                self._publishers.discard(publisher)

        # This immutable captured predecessor cannot be replaced by an empty
        # intermediate owner's local close. Pending opening remains shielded.
        self._retirement = asyncio.create_task(settle())
        self._retirement.add_done_callback(Publisher._consume)

    async def _read_messages(self):
        while True:
            publisher, message = await self._messages.get()
            if publisher is not self.publisher:
                continue
            kind = message["t"]
            if kind == "_unwatch":
                with contextlib.suppress(
                    VideoFailure, OSError, ConnectionError, asyncssh.Error
                ):
                    await publisher.send({"t": "unwatch", "track": message["track"]})
            elif kind == "_fps":
                with contextlib.suppress(
                    VideoFailure, OSError, ConnectionError, asyncssh.Error
                ):
                    await publisher.send({**message, "t": "fps"})
            elif kind == "exit":
                await self._fail_publisher(publisher, message["reason"])
            elif kind == "stats":
                logger.debug("Browser publisher stats: %s", message)
            else:
                for track in tuple(self.tracks.values()):
                    if message.get("track") not in (None, track.id) or message.get(
                        "room"
                    ) not in (None, track.lease):
                        continue
                    if kind == "track":
                        if message.get("target") != track.page:
                            continue
                        track.published = message.get("state") == "published"
                        if track.published:
                            track.ready.set()
                        for stream in track.viewers:
                            if track.published:
                                self._ready(track, stream)
                            else:
                                stream._video_event(
                                    track.page, {"t": "video", "state": "reconnecting"}
                                )
                    elif kind == "view" and message.get("target") == track.page:
                        revision = message.get("revision")
                        css, dpr = message.get("css"), message.get("dpr")
                        if (
                            type(revision) is not int
                            or revision <= track.revision
                            or not isinstance(css, list)
                            or len(css) != 2
                            or any(
                                type(n) not in (int, float) or not 0 < n < 1e6
                                for n in css
                            )
                            or type(dpr) not in (int, float)
                            or not 0 < dpr < 100
                        ):
                            continue
                        track.revision, track.view = revision, message
                        for stream in track.viewers:
                            stream._video_event(track.page, message)
                    elif kind == "conn":
                        state = message.get("state")
                        if state == "failed":
                            self._fail_track(track, "sfu-unreachable")
                        elif state in ("reconnecting", "disconnected"):
                            for stream in track.viewers:
                                stream._video_event(
                                    track.page, {"t": "video", "state": "reconnecting"}
                                )
                        elif state in ("reconnected", "connected") and track.published:
                            for stream in track.viewers:
                                self._ready(track, stream)
                    elif kind == "error":
                        code = message.get("code")
                        reason = {
                            "target-not-found": "page-unavailable",
                            "cdp-unreachable": "cdp-unreachable",
                            "sfu-unreachable": "sfu-unreachable",
                        }.get(code)
                        if reason:
                            self._fail_track(track, reason)

    def input(self, lease, page):
        track = self.tracks.get((lease, page))
        if track:
            track.last_input = time.monotonic()
            if track.fps != self.config.capture_fps and self.publisher:
                track.fps = self.config.capture_fps
                self._messages.put_nowait(
                    (
                        self.publisher,
                        {
                            "t": "_fps",
                            "track": track.id,
                            "capture_fps": track.fps,
                        },
                    )
                )

    async def _tick(self):
        while True:
            await asyncio.sleep(1)
            now = time.monotonic()
            publisher = self.publisher
            if not publisher or not publisher.process or not self.tracks:
                continue
            try:
                for track in tuple(self.tracks.values()):
                    fps = (
                        self.config.idle_capture_fps
                        if now - track.last_input >= self.config.idle_after_s
                        else self.config.capture_fps
                    )
                    if fps != track.fps:
                        track.fps = fps
                        await publisher.send(
                            {"t": "fps", "track": track.id, "capture_fps": fps}
                        )
                if now >= self._next_renew:
                    self._next_renew = now + self.config.token_ttl_s * 2 / 3
                    for room in {track.lease for track in self.tracks.values()}:
                        await publisher.send(
                            {
                                "t": "token",
                                "room": room,
                                "token": self.owner.tokens.issue(
                                    room, "publisher:" + room, publish=True
                                ),
                            }
                        )
                    for track in self.tracks.values():
                        if track.published:
                            for stream in track.viewers:
                                self._ready(track, stream, renew=True)
            except (VideoFailure, OSError, ConnectionError, asyncssh.Error) as error:
                await self._fail_publisher(
                    publisher,
                    str(error)
                    if isinstance(error, VideoFailure)
                    else "publisher-exited",
                )

    async def aclose(self):
        self._closed = True
        tasks = [
            self._reader,
            self._ticker,
            *(t.starting for t in self.tracks.values() if t.starting),
        ]
        if self._idle:
            tasks.append(self._idle)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tracks.clear()
        await asyncio.gather(
            *(self._close_publisher_locally(p) for p in self._publishers)
        )
