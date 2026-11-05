"""Predictable Chrome/SSH publisher boundaries for the real v3 gateway contract.

The gateway parser, VideoStreams, token signer and websocket remain real.
This peer is deliberately not a decoder/SFU or native rendering test.
"""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from livekit import api
from starlette.responses import Response

from wandrun.gateway.stream_config import StreamConfig, VideoConfig
from wandrun.gateway.video_stream import VideoStreams
from wandrun.config import BrowserDefinition
from wandrun.runtime.browser.leases import BrowserLeases, UnknownBrowserTask, _Lease, _Page


class PublisherPeer:
    def __init__(self):
        self.lines = asyncio.Queue()
        self.closed = asyncio.Event()
        self.exit_status = None
        self.stdin = self
        self.stdout = self
        self.stderr = SimpleNamespace(read=self.read_stderr)
        self.emit(t="ready", version=1, pid=123)

    def emit(self, **message):
        self.lines.put_nowait(json.dumps(message) + "\n")

    async def readline(self):
        return await self.lines.get()

    async def read_stderr(self, size):
        await self.closed.wait()
        return ""

    def write(self, line):
        message = json.loads(line)
        if message["t"] == "watch":
            self.emit(t="view", track=message["track"], target=message["target"],
                      css=[800, 600], dpr=1, revision=1)
            self.emit(t="track", track=message["track"], target=message["target"], state="published")

    async def drain(self):
        pass

    def write_eof(self):
        self.exit_status = 0
        self.lines.put_nowait("")
        self.closed.set()

    def terminate(self):
        self.write_eof()

    def close(self):
        self.write_eof()

    async def wait_closed(self):
        await self.closed.wait()


class ChromePeer:
    """Only CDP I/O is deterministic; real lease admission owns every write."""

    async def call(self, method, params=None, *, before_send=None, on_sent=None, timeout=None):
        if before_send is not None:
            before_send()
        if on_sent is not None:
            on_sent()
        if method == "Runtime.evaluate":
            return {"result": {"value": [800, 600, 1]}}
        return {}


class BrowserPeer(BrowserLeases):
    def __init__(self):
        super().__init__(BrowserDefinition(cdp_port=9223, max_pages=6),
                         environment_id="instabox:protocol", environment_name="Protocol",
                         transport=self)
        lease = _Lease("video-contract", "protocol", "root", "agent", "entry",
                       epoch=3, state="human", current="page")
        lease.pages["page"] = _Page("page", ChromePeer(), url="https://example.test/")
        self._leases[lease.id] = lease

    async def subscribe_frames(self, identity, page, callback, **kwargs):
        async def stop():
            pass
        return stop
    async def open_browser_video_exec(self, command):
        return PublisherPeer()



def install(gateway, app, root: Path, origin: str):
    browser = BrowserPeer()
    keys = root / "video-contract-keys.yaml"
    keys.write_text("protocol-api: protocol-secret-at-least-thirty-two-characters\n")
    keys.chmod(0o600)
    streams = VideoStreams(StreamConfig(video=VideoConfig(
        "wss://sfu.test", origin, keys, publisher_idle_s=0,
    )))
    gateway.video_streams = streams
    gateway.runtime.browser_for_lease = lambda identity: browser if identity == "video-contract" else missing(identity)

    async def remove(request):
        api.RoomParticipantIdentity.FromString(await request.body())
        return Response(api.RemoveParticipantResponse().SerializeToString(), media_type="application/protobuf")

    app.add_route("/twirp/livekit.RoomService/RemoveParticipant", remove, methods=["POST"])
    return streams


def missing(identity):
    raise UnknownBrowserTask(identity)
