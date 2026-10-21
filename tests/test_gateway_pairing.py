"""Device pairing boundaries: real SQLite/HTTP and real long-lived transports."""

import asyncio
from contextlib import asynccontextmanager, closing
import hashlib
import io
import json
import logging
from pathlib import Path
import shutil
import socket
import sqlite3
import stat
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
import uvicorn
from uvicorn.protocols.http.flow_control import FlowControl
from uvicorn.protocols.websockets.wsproto_impl import WSProtocol
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from wandrun.config import BrowserDefinition
from wandrun.gateway.app import _Server, _listening_sockets, write_management_credential
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.browser_dev import ChromeDev
from wandrun.runtime.browser import BrowserLeases


ADMIN = "management-test-secret-not-a-device-token"


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


@asynccontextmanager
async def live_gateway(app, *, log_level="warning", port=0):
    sock = socket.socket()
    sock.bind(("127.0.0.1", port))
    sock.listen()
    server = _Server(
        uvicorn.Config(app, log_level=log_level, lifespan="off", access_log=False),
        app.state.gateway,
    )
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    task.result()
                await asyncio.sleep(.01)
        yield f"http://127.0.0.1:{sock.getsockname()[1]}"
    finally:
        app.state.gateway.end_streams()
        server.should_exit = True
        await asyncio.wait_for(task, 10)
        sock.close()


class EmptyBrowser:
    """A human-controlled zero-page lease; transport and its lifecycle remain real."""

    def __init__(self):
        self.listeners = set()

    def detail(self, identity):
        if identity != "lease":
            raise LookupError(identity)
        return {"id": identity, "state": "human", "epoch": 1, "pages": [],
                "current": None, "max_pages": 3}

    def subscribe(self, identity, callback):
        self.detail(identity)
        self.listeners.add(callback)
        return lambda: self.listeners.discard(callback)


class PairingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="pairing-tests-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "gateway.sqlite"
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        self.gateway = Gateway(self.store)
        self.app = create_app(self.gateway, management_token=ADMIN)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://gateway")
        self.addAsyncCleanup(self.client.aclose)

    async def issue(self, name="Test tablet"):
        response = await self.client.post("/admin/pairing-codes", headers=bearer(ADMIN), json={"name": name})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def exchange(self, code, **kwargs):
        return await self.client.post("/pairing/exchange", json={"code": code, "method": "manual", **kwargs})

    async def paired(self):
        challenge = await self.issue()
        response = await self.exchange(challenge["code"])
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def devices(self):
        response = await self.client.get("/admin/devices", headers=bearer(ADMIN))
        self.assertEqual(response.status_code, 200)
        return response.json()["devices"]

    async def test_exchange_persists_only_hashes_and_never_emits_events(self):
        challenge = await self.issue()
        response = await self.exchange(challenge["code"], name="My phone")
        self.assertEqual(response.status_code, 200, response.text)
        paired = response.json()
        self.assertGreaterEqual(len(paired["token"]), 43)
        self.assertEqual(paired["pairing_method"], "manual")
        connection = await self.client.get("/connection", headers=bearer(paired["token"]))
        self.assertEqual(connection.status_code, 200)
        self.assertEqual(connection.json()["device_id"], paired["device_id"])
        self.assertNotIn("token", connection.json())
        device, = await self.devices()
        self.assertEqual(device["name"], "My phone")
        self.assertFalse(device["revoked"])
        self.assertEqual(device["id"], paired["device_id"])
        with closing(sqlite3.connect(self.path)) as db:
            dump = "\n".join(db.iterdump())
        for secret in (paired["token"], challenge["code"], ADMIN):
            self.assertNotIn(secret, dump)
            self.assertNotIn(secret, json.dumps(device))
        self.assertIn(hashlib.sha256(paired["token"].encode()).hexdigest(), dump)
        self.assertEqual(self.store.after(0), [])

    async def test_code_expiry_includes_exact_boundary(self):
        with patch("wandrun.gateway.store.time.time", return_value=2_000_000_000):
            challenge = await self.issue()
        with patch("wandrun.gateway.store.time.time", return_value=2_000_000_300):
            response = await self.exchange(challenge["code"])
        self.assertEqual(response.json()["error"]["code"], "pairing_expired")
        self.assertEqual(await self.devices(), [])

    async def test_single_use_and_simultaneous_exchange_only_issue_one_token(self):
        challenge = await self.issue()
        replies = await asyncio.gather(*(self.exchange(challenge["code"]) for _ in range(8)))
        self.assertEqual(sum(reply.status_code == 200 for reply in replies), 1)
        for reply in replies:
            if reply.status_code != 200:
                self.assertEqual(reply.json()["error"]["code"], "pairing_used")
        self.assertEqual(len(await self.devices()), 1)

    async def test_five_wrong_guesses_invalidate_correct_code(self):
        challenge = await self.issue()
        for _ in range(5):
            response = await self.exchange("NOT-A-CODE")
            self.assertNotEqual(response.status_code, 200)
            self.assertIn(response.json()["error"]["code"], ("pairing_invalid", "pairing_locked"))
        response = await self.exchange(challenge["code"])
        self.assertEqual(response.json()["error"]["code"], "pairing_locked")
        self.assertEqual(await self.devices(), [])
        fresh = await self.issue()
        response = await self.exchange(fresh["code"])
        self.assertEqual(response.status_code, 200, response.text)

    async def test_four_wrong_guesses_still_allow_correct_code(self):
        challenge = await self.issue()
        for _ in range(4):
            await self.exchange("NOT-A-CODE")
        self.assertEqual((await self.exchange(challenge["code"])).status_code, 200)

    async def test_issuing_replaces_previous_outstanding_challenge(self):
        first = await self.issue()
        second = await self.issue()
        rejected = await self.exchange(first["code"])
        self.assertNotEqual(rejected.status_code, 200)
        accepted = await self.exchange(second["code"])
        self.assertEqual(accepted.status_code, 200, accepted.text)

    async def test_admin_requires_management_secret_and_actual_loopback(self):
        paired = await self.paired()
        for headers in ({}, bearer(paired["token"]), bearer("wrong")):
            response = await self.client.get("/admin/devices", headers=headers)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json()["error"]["code"], "unauthorized")
        for host in ("198.51.100.10", "::ffff:198.51.100.10"):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=(host, 1234)), base_url="http://gateway",
            ) as remote:
                response = await remote.get("/admin/devices", headers={**bearer(ADMIN), "X-Forwarded-For": "127.0.0.1"})
                self.assertIn(response.status_code, (401, 403))
        self.assertEqual((await self.client.get("/connection", headers=bearer(ADMIN))).status_code, 401)
        for host in ("127.0.0.1", "::1"):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=(host, 1234)), base_url="http://gateway",
            ) as local:
                response = await local.get("/admin/devices", headers=bearer(ADMIN))
                self.assertEqual(response.status_code, 200)

    async def test_development_token_is_optional_and_cannot_administer(self):
        self.assertEqual((await self.client.get("/connection", headers=bearer("dev"))).status_code, 401)
        app = create_app(self.gateway, "dev", management_token=ADMIN)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
            response = await client.get("/connection", headers=bearer("dev"))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["pairing_method"], "development")
            self.assertIsNone(response.json()["device_id"])
            self.assertEqual((await client.get("/admin/devices", headers=bearer("dev"))).status_code, 401)
            self.assertEqual((await client.get("/connection", headers=bearer(""))).status_code, 401)
            for path in ("/connection", "/admin/devices"):
                response = await client.get(path, headers={b"Authorization": b"Bearer \xff"})
                self.assertEqual(response.status_code, 401)

    async def test_self_revoke_only_revokes_calling_device_and_persists(self):
        first, second = await self.paired(), await self.paired()
        response = await self.client.delete("/devices/current", headers=bearer(first["token"]))
        self.assertIn(response.status_code, (200, 204))
        self.assertEqual((await self.client.get("/connection", headers=bearer(first["token"]))).status_code, 401)
        self.assertEqual((await self.client.get("/connection", headers=bearer(second["token"]))).status_code, 200)
        revoked = {device["id"]: device["revoked"] for device in await self.devices()}
        self.assertEqual(revoked, {first["device_id"]: True, second["device_id"]: False})
        reopened = GatewayStore(self.path)
        try:
            app = create_app(Gateway(reopened))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
                self.assertEqual((await client.get("/connection", headers=bearer(first["token"]))).status_code, 401)
                self.assertEqual((await client.get("/connection", headers=bearer(second["token"]))).status_code, 200)
        finally:
            reopened.close()

    async def test_recent_usage_throttles_without_delaying_revocation(self):
        with patch("wandrun.gateway.store.time.time", return_value=2_000_000_000):
            paired = await self.paired()
            await self.client.get("/connection", headers=bearer(paired["token"]))
            initial = (await self.devices())[0]["last_used_at"]
        with patch("wandrun.gateway.store.time.time", return_value=2_000_000_001):
            await self.client.get("/connection", headers=bearer(paired["token"]))
            self.assertEqual((await self.devices())[0]["last_used_at"], initial)
        with patch("wandrun.gateway.store.time.time", return_value=2_000_000_120):
            await self.client.get("/connection", headers=bearer(paired["token"]))
            self.assertNotEqual((await self.devices())[0]["last_used_at"], initial)
            await self.client.delete(f"/admin/devices/{paired['device_id']}", headers=bearer(ADMIN))
            self.assertEqual((await self.client.get("/connection", headers=bearer(paired["token"]))).status_code, 401)

    async def test_secret_material_is_absent_from_logs_errors_and_events(self):
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        root = logging.getLogger()
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.INFO)
        try:
            challenge = await self.issue()
            paired = (await self.exchange(challenge["code"])).json()
            errors = []
            for secret in (paired["token"], ADMIN):
                response = await self.exchange(secret)
                errors.append(response.text)
            await self.client.get("/connection", headers=bearer(paired["token"]))
            await self.client.delete(f"/admin/devices/{paired['device_id']}", headers=bearer(ADMIN))
            errors.append((await self.client.get("/connection", headers=bearer(paired["token"]))).text)
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)
        visible = output.getvalue() + "".join(errors) + str(self.store.after(0))
        for secret in (challenge["code"], paired["token"], ADMIN):
            self.assertNotIn(secret, visible)

    async def test_websocket_request_urls_do_not_leak_secrets_to_server_logs(self):
        paired = await self.paired()
        challenge = await self.issue()
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        logger = logging.getLogger("uvicorn.error")
        async with live_gateway(self.app, log_level="info") as origin:
            logger.addHandler(handler)
            try:
                # Uvicorn logs websocket handshakes on its error logger, not access logger.
                url = origin.replace("http:", "ws:") + (
                    f"/browser-tasks/{ADMIN}/stream?token={paired['token']}&code={challenge['code']}"
                )
                with self.assertRaises(InvalidStatus):
                    async with connect(url):
                        self.fail("unauthenticated viewer was accepted")
                logger.warning("Diagnostic remains visible")
            finally:
                logger.removeHandler(handler)
        captured = output.getvalue()
        self.assertIn("Diagnostic remains visible", captured)
        for secret in (paired["token"], challenge["code"], ADMIN):
            self.assertNotIn(secret, captured)

    async def test_admin_revoke_closes_only_device_sse_and_browser_websocket(self):
        first, second = await self.paired(), await self.paired()
        browser = EmptyBrowser()
        self.gateway.runtime = SimpleNamespace(browser=browser)
        async with live_gateway(self.app) as origin:
            async with httpx.AsyncClient(base_url=origin, timeout=5) as client:
                async with client.stream("GET", "/events", headers=bearer(first["token"])) as first_sse, client.stream(
                    "GET", "/events", headers=bearer(second["token"]),
                ) as second_sse, connect(
                    origin.replace("http:", "ws:") + "/browser-tasks/lease/stream", additional_headers=bearer(first["token"]),
                ) as first_ws, connect(
                    origin.replace("http:", "ws:") + "/browser-tasks/lease/stream", additional_headers=bearer(second["token"]),
                ) as second_ws:
                    self.assertEqual(first_sse.status_code, 200)
                    self.assertEqual(second_sse.status_code, 200)
                    self.assertEqual(json.loads(await first_ws.recv())["t"], "hello")
                    self.assertEqual(json.loads(await second_ws.recv())["t"], "hello")
                    await first_ws.recv()  # pages
                    await second_ws.recv()
                    ended = asyncio.create_task(first_sse.aread())
                    response = await client.delete(f"/admin/devices/{first['device_id']}", headers=bearer(ADMIN))
                    self.assertIn(response.status_code, (200, 204))
                    await asyncio.wait_for(ended, 2)
                    with self.assertRaises(ConnectionClosed) as closed:
                        await asyncio.wait_for(first_ws.recv(), 2)
                    self.assertEqual(closed.exception.rcvd.code, 4401)
                    await asyncio.wait_for(await second_ws.ping(), 2)
                    self.assertEqual(len(browser.listeners), 1)
                    self.assertEqual((await client.get("/connection", headers=bearer(second["token"]))).status_code, 200)
                    self.assertEqual((await client.get("/events", headers=bearer(first["token"]))).status_code, 401)
                    with self.assertRaises(InvalidStatus) as denied:
                        async with connect(origin.replace("http:", "ws:") + "/browser-tasks/lease/stream", additional_headers=bearer(first["token"])):
                            self.fail("revoked websocket was accepted")
                    self.assertEqual(denied.exception.response.status_code, 401)
                    # A subsequent administrative revoke must close the remaining subscriber, too.
                    other_ended = asyncio.create_task(second_sse.aread())
                    await client.delete(f"/admin/devices/{second['device_id']}", headers=bearer(ADMIN))
                    await asyncio.wait_for(other_ended, 2)
        self.assertEqual(browser.listeners, set())

    async def test_revoke_unsubscribes_sse_blocked_sending_to_nonreading_tcp_peer(self):
        paired = await self.paired()
        draining = set()
        senders = set()
        interrupted = asyncio.Event()
        original_drain = FlowControl.drain

        async def observe_drain(flow):
            draining.add(flow)
            senders.add(asyncio.current_task())
            try:
                await original_drain(flow)
            except asyncio.CancelledError:
                interrupted.set()
                raise
            finally:
                draining.discard(flow)

        async with live_gateway(self.app, port=8785) as origin:
            # A raw socket has no background reader. Shrink its receive window so
            # real TCP backpressure arrives without an unbounded event backlog.
            with socket.socket() as peer:
                peer.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
                peer.setblocking(False)
                loop = asyncio.get_running_loop()
                async with asyncio.timeout(5):
                    await loop.sock_connect(peer, ("127.0.0.1", 8785))
                    await loop.sock_sendall(peer, (
                        "GET /events HTTP/1.1\r\nHost: localhost\r\n"
                        f"Authorization: Bearer {paired['token']}\r\n\r\n"
                    ).encode())
                    headers = bytearray()
                    while not headers.endswith(b"\r\n\r\n"):
                        chunk = await loop.sock_recv(peer, 1)
                        self.assertTrue(chunk, "SSE closed before response headers")
                        headers.extend(chunk)
                self.assertTrue(headers.startswith(b"HTTP/1.1 200"))
                # Never read peer again. Observe the real drain await, not merely
                # write_paused: a subsequent body send must actually be blocked.
                with patch.object(FlowControl, "drain", observe_drain):
                    async with asyncio.timeout(5):
                        while not draining:
                            self.gateway._publish_transient({"type": "activity", "text": "x" * 262144})
                            await asyncio.sleep(.01)
                    self.assertEqual(len(self.gateway._subscribers), 1)
                    async with httpx.AsyncClient(base_url=origin, timeout=5) as client:
                        response = await client.delete(
                            f"/admin/devices/{paired['device_id']}", headers=bearer(ADMIN),
                        )
                        self.assertEqual(response.status_code, 204)
                        async with asyncio.timeout(2):
                            await interrupted.wait()
                            while self.gateway._subscribers or self.app.state.device_auth._connections:
                                await asyncio.sleep(.01)
                        self.assertEqual(len(self.gateway._subscribers), 0)
                        self.assertEqual(self.app.state.device_auth._connections, {})
                        # Keep the peer open and unread until the response itself
                        # exits, including a blocked HTTP terminator.
                        async with asyncio.timeout(2):
                            while any(not task.done() for task in senders):
                                await asyncio.sleep(.01)
                        self.assertEqual(
                            (await client.get("/connection", headers=bearer(paired["token"]))).status_code,
                            401,
                        )


    async def test_revoke_aborts_websocket_blocked_sending_to_nonreading_tcp_peer(self):
        paired = await self.paired()
        browser = EmptyBrowser()
        self.gateway.runtime = SimpleNamespace(browser=browser)
        blocked = asyncio.Event()
        protocols = set()
        original_send = WSProtocol.send

        async def observe_send(protocol, message):
            if message["type"] == "websocket.send" and not protocol.writable.is_set():
                protocols.add(protocol)
                blocked.set()
            await original_send(protocol, message)

        async with live_gateway(self.app, port=8795) as origin:
            with socket.socket() as peer:
                peer.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
                peer.setblocking(False)
                loop = asyncio.get_running_loop()
                async with asyncio.timeout(5):
                    await loop.sock_connect(peer, ("127.0.0.1", 8795))
                    await loop.sock_sendall(peer, (
                        "GET /browser-tasks/lease/stream HTTP/1.1\r\nHost: localhost\r\n"
                        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                        "Sec-WebSocket-Version: 13\r\n"
                        f"Authorization: Bearer {paired['token']}\r\n\r\n"
                    ).encode())
                    headers = bytearray()
                    while not headers.endswith(b"\r\n\r\n"):
                        chunk = await loop.sock_recv(peer, 1)
                        self.assertTrue(chunk, "WebSocket closed before handshake")
                        headers.extend(chunk)
                self.assertTrue(headers.startswith(b"HTTP/1.1 101"))
                # Leave the TCP peer open and unread. Large page snapshots fill
                # the real send buffer without needing Chrome or frame ACKs.
                snapshot = browser.detail("lease")
                url = "x" * 262144
                with (
                    patch.object(browser, "detail", return_value=snapshot),
                    patch.object(WSProtocol, "send", observe_send),
                ):
                    async with asyncio.timeout(5):
                        while not blocked.is_set():
                            snapshot["pages"] = [{"id": "page", "url": url, "title": str(loop.time())}]
                            for callback in tuple(browser.listeners):
                                callback(snapshot)
                            await asyncio.sleep(.01)
                    async with httpx.AsyncClient(base_url=origin, timeout=5) as client:
                        response = await client.delete(
                            f"/admin/devices/{paired['device_id']}", headers=bearer(ADMIN),
                        )
                        self.assertEqual(response.status_code, 204)
                    async with asyncio.timeout(2):
                        while (
                            self.app.state.device_auth._connections or browser.listeners
                            or any(not protocol.disconnected for protocol in protocols)
                        ):
                            await asyncio.sleep(.01)
                    self.assertEqual(self.app.state.device_auth._connections, {})
                    self.assertEqual(browser.listeners, set())
                    self.assertTrue(all(protocol.transport.is_closing() for protocol in protocols))
                    self.assertEqual(snapshot["state"], "human")


    @unittest.skipUnless(shutil.which("Xvfb") and shutil.which("google-chrome"), "需要隔离 Chrome")
    async def test_revoke_stops_real_browser_frames_without_ending_agent_lease(self):
        paired = await self.paired()
        with ChromeDev() as chrome:
            leases = BrowserLeases(BrowserDefinition(cdp_url=chrome.cdp_url, idle_timeout=0))
            await leases.start()
            try:
                leases.register("pairing-owner", "root", "worker", "entry")
                environment = await leases.command_environment("pairing-owner")
                async with httpx.AsyncClient() as client:
                    endpoint = (await client.get(environment["WANDRUN_BROWSER_CDP"] + "/json/version")).json()["webSocketDebuggerUrl"]
                async with connect(endpoint) as agent:
                    await agent.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                    self.assertIn("result", json.loads(await agent.recv()))
                    identity = leases.lease_for_task("pairing-owner")
                    self.gateway.runtime = SimpleNamespace(browser=leases)
                    async with live_gateway(self.app) as origin, httpx.AsyncClient(base_url=origin) as client:
                        async with connect(
                            origin.replace("http:", "ws:") + f"/browser-tasks/{identity}/stream",
                            additional_headers=bearer(paired["token"]),
                        ) as viewer:
                            async with asyncio.timeout(10):
                                while True:
                                    frame = await viewer.recv()
                                    if isinstance(frame, bytes):
                                        header_size = struct.unpack("!I", frame[:4])[0]
                                        self.assertEqual(json.loads(frame[4:4 + header_size])["t"], "frame")
                                        self.assertEqual(frame[4 + header_size:6 + header_size], b"\xff\xd8")
                                        break
                            response = await client.delete(f"/admin/devices/{paired['device_id']}", headers=bearer(ADMIN))
                            self.assertEqual(response.status_code, 204)
                            with self.assertRaises(ConnectionClosed) as closed:
                                async with asyncio.timeout(2):
                                    while True:
                                        await viewer.recv()
                            self.assertEqual(closed.exception.rcvd.code, 4401)
                            self.assertEqual(leases.detail(identity)["state"], "agent")
            finally:
                await leases.aclose()

    async def test_self_disconnect_ends_open_event_stream(self):
        paired = await self.paired()
        async with live_gateway(self.app) as origin:
            async with httpx.AsyncClient(base_url=origin, timeout=5) as client:
                async with client.stream("GET", "/events", headers=bearer(paired["token"])) as stream:
                    self.assertEqual(stream.status_code, 200)
                    ended = asyncio.create_task(stream.aread())
                    response = await client.delete("/devices/current", headers=bearer(paired["token"]))
                    self.assertIn(response.status_code, (200, 204))
                    await asyncio.wait_for(ended, 2)
                    self.assertEqual((await client.get("/connection", headers=bearer(paired["token"]))).status_code, 401)


class ListeningSocketTests(unittest.TestCase):
    @unittest.skipUnless(socket.has_ipv6, "IPv6 unavailable")
    def test_ipv6_wildcard_accepts_ipv6_and_refuses_ipv4(self):
        with _listening_sockets("::", 8795) as listeners:
            with socket.create_connection(("::1", 8795), timeout=1):
                accepted, _ = listeners[0].accept()
                accepted.close()
            with self.assertRaises(ConnectionRefusedError):
                socket.create_connection(("127.0.0.1", 8795), timeout=1)


class ManagementCredentialTests(unittest.TestCase):
    def test_credential_is_owner_only_and_rotated_on_start(self):
        with tempfile.TemporaryDirectory(prefix="pairing-credential-") as directory:
            state = Path(directory) / "state"
            first = write_management_credential(state, "127.0.0.1", 8785)
            path = state / "management.json"
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text()), {"token": first, "host": "127.0.0.1", "port": 8785})
            self.assertGreaterEqual(len(first), 43)
            second = write_management_credential(state, "127.0.0.1", 8785)
            self.assertNotEqual(first, second)
            self.assertEqual(json.loads(path.read_text())["token"], second)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_existing_symlink_cannot_redirect_credential_write(self):
        with tempfile.TemporaryDirectory(prefix="pairing-credential-") as directory:
            state = Path(directory)
            target = state / "unrelated"
            target.write_text("keep me")
            (state / "management.json").symlink_to(target)
            try:
                write_management_credential(state, "127.0.0.1", 8785)
            except OSError:
                pass  # Refusing the link or atomically replacing it are both safe.
            self.assertEqual(target.read_text(), "keep me")


class PairCommandTests(unittest.TestCase):
    def render_pair_url(self, host, candidates, args=()):
        from urllib.parse import parse_qs, urlsplit
        from wandrun.gateway import pair_cli

        def challenge(request):
            loopback = "[::1]" if host == "::" else "127.0.0.1"
            self.assertEqual(str(request.url), f"http://{loopback}:8765/admin/pairing-codes")
            return httpx.Response(200, json={"code": "123456", "expires_at": "soon"})

        client_type = httpx.Client
        with (
            patch.object(pair_cli, "_credential", return_value={
                "host": host, "port": 8765, "token": "management-test",
            }),
            patch.object(pair_cli, "_network_addresses", return_value=candidates) as interfaces,
            patch.object(pair_cli.httpx, "Client", side_effect=lambda **kwargs: client_type(
                transport=httpx.MockTransport(challenge), **kwargs,
            )),
            patch.object(pair_cli.segno, "make") as qr,
            patch("sys.stdout", new_callable=io.StringIO) as output,
        ):
            pair_cli.pair_main(list(args))
        url = parse_qs(urlsplit(qr.call_args.args[0]).query)["url"][0]
        return url, output.getvalue(), interfaces.call_count

    def test_qr_and_printed_candidates_match_wildcard_listener_family(self):
        candidates = ["192.0.2.10", "2001:db8::10", "198.51.100.20", "2001:db8::20"]
        for host, expected, excluded in (
            ("::", "http://[2001:db8::10]:8765", "192.0.2.10"),
            ("0.0.0.0", "http://192.0.2.10:8765", "2001:db8::10"),
        ):
            with self.subTest(host=host):
                qr_url, printed, enumerations = self.render_pair_url(host, candidates)
                self.assertEqual(qr_url, expected)
                self.assertIn(expected, printed)
                self.assertNotIn(excluded, printed)
                self.assertEqual(enumerations, 1)

    def test_offline_candidate_uses_bound_family_loopback(self):
        for host, expected in (
            ("::", "http://[::1]:8765"),
            ("0.0.0.0", "http://127.0.0.1:8765"),
        ):
            with self.subTest(host=host):
                qr_url, printed, _ = self.render_pair_url(host, [])
                self.assertEqual(qr_url, expected)
                self.assertIn(expected, printed)

    def test_explicit_url_overrides_listener_family(self):
        qr_url, printed, enumerations = self.render_pair_url(
            "::", ["2001:db8::10"], ("--url", "https://gateway.example/"),
        )
        self.assertEqual(qr_url, "https://gateway.example")
        self.assertIn("https://gateway.example", printed)
        self.assertEqual(enumerations, 0)

    def test_option_values_named_pair_still_start_gateway(self):
        from wandrun.gateway import app

        with patch.object(app, "serve") as serve, patch.object(app, "pair_main") as pair_command:
            app.main(["--workspace", "pair"])
            self.assertEqual(serve.await_args.kwargs["workspace"], Path("pair"))
            serve.reset_mock()
            app.main(["--token", "pair"])
            self.assertEqual(serve.await_args.kwargs["token"], "pair")
            pair_command.assert_not_called()

    def test_pair_in_command_position_starts_pair_command(self):
        from wandrun.gateway import app

        with patch.object(app, "serve") as serve, patch.object(app, "pair_main") as pair_command:
            app.main(["pair", "--list"])
            pair_command.assert_called_once_with(["--list"])
            serve.assert_not_awaited()
