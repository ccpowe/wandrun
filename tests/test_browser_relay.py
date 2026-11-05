"""Real exec/TCP regressions; the final-page integration additionally needs Chrome."""

import asyncio
import contextlib
import json
import os
import shutil
import shlex
import signal
import socket
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlsplit

import asyncssh
import httpx
from websockets.asyncio.client import connect

from wandrun.config import BrowserDefinition
from wandrun.integrations.browser_dev import ChromeDev
from wandrun.runtime.browser.leases import BrowserLeases

from wandrun.integrations import remote_session
from wandrun.integrations.browser_relay import (
    RELAY_COMMAND,
    BrowserRelay,
    InstaboxBrowserTransport,
)
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.integrations.remote_browser_relay import HEADER, MAX_FRAME
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.integrations.ssh_backend import SSHBackend, SessionChannel


class LocalExec:
    """Expose actual child pipes and exit acknowledgement like an SSH exec."""

    def __init__(self, child):
        self.child = child
        self.stdin, self.stdout, self.stderr = child.stdin, child.stdout, child.stderr
        self.hide_status = False

    @property
    def exit_status(self):
        return None if self.hide_status else self.child.returncode

    @property
    def exit_signal(self):
        code = self.child.returncode
        if not self.hide_status and code is not None and code < 0:
            return (signal.Signals(-code).name.removeprefix("SIG"), False, "", "")
        return None

    async def wait_closed(self):
        await self.child.wait()

    def terminate(self):
        if self.child.returncode is None:
            self.child.terminate()

    def close(self):
        if self.child.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self.child.terminate()


class ExecConnection:
    def __init__(self):
        self.closed = asyncio.Event()
        self.processes = []
        self.gate = None
        self.started = asyncio.Event()

    async def create_process(self, command, *, encoding):
        child = await asyncio.create_subprocess_exec(
            "sh", "-c", command, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        process = LocalExec(child)
        self.processes.append(process)
        self.started.set()
        if self.gate is not None:
            await self.gate.wait()
        return process

    async def wait_closed(self):
        await self.closed.wait()

    async def cleanup(self):
        self.closed.set()
        for process in self.processes:
            process.close()
        await asyncio.gather(*(process.wait_closed() for process in self.processes))


async def roundtrip(url, data):
    parsed = urlsplit(url)
    reader, writer = await asyncio.open_connection(parsed.hostname, parsed.port)
    try:
        writer.write(data)
        await writer.drain()
        writer.write_eof()
        return await reader.read()
    finally:
        writer.close()
        with contextlib.suppress(OSError):
            await writer.wait_closed()


class RelayProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connections = ExecConnection()
        self.addAsyncCleanup(self.connections.cleanup)
        self.handlers = set()
        self.accepted = asyncio.Event()

        async def echo(reader, writer):
            task = asyncio.current_task()
            self.handlers.add(task)
            self.accepted.set()
            try:
                data = await reader.read()
                if data == b"RESET":
                    writer.transport.abort()
                else:
                    writer.write(b"reply:" + data)
                    await writer.drain()
            finally:
                writer.close()
                with contextlib.suppress(OSError):
                    await writer.wait_closed()
                self.handlers.discard(task)

        self.server = await asyncio.start_server(echo, "127.0.0.1", 0)
        self.addAsyncCleanup(self.close_server)
        self.destination = ("127.0.0.1", self.server.sockets[0].getsockname()[1])
        self.disconnected = asyncio.Event()
        process = await self.connections.create_process(RELAY_COMMAND, encoding=None)
        self.relay = BrowserRelay(process, self.destination, self.disconnected.set)
        self.addAsyncCleanup(self.close_relay)
        self.url = await self.relay.open()

    async def close_relay(self):
        with contextlib.suppress(CleanupUnconfirmedError):
            await self.relay.aclose()

    async def close_server(self):
        self.server.close()
        await self.server.wait_closed()
        if self.handlers:
            await asyncio.gather(*tuple(self.handlers))

    async def test_concurrent_large_streams_preserve_half_close_and_exact_bytes(self):
        payloads = [bytes([index]) * (2 * 1024 * 1024 + index) for index in range(3)]
        async with asyncio.timeout(20):
            responses = await asyncio.gather(*(roundtrip(self.url, data) for data in payloads))
        self.assertEqual(responses, [b"reply:" + data for data in payloads])
        self.assertFalse(self.disconnected.is_set())
        await self.relay.aclose()
        self.assertTrue(self.relay.confirmed)
        with self.assertRaises(OSError):
            await asyncio.open_connection("127.0.0.1", urlsplit(self.url).port)

    async def test_clean_exec_eof_flushes_a_half_closed_large_response_before_exit(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", urlsplit(self.url).port)
        payload = b"graceful response" * 200000
        try:
            writer.write(payload)
            await writer.drain()
            writer.write_eof()
            draining = asyncio.create_task(self.relay.drain())
            try:
                response = await asyncio.wait_for(reader.read(), 10)
                self.assertEqual(response, b"reply:" + payload)
                await asyncio.wait_for(draining, 5)
                await self.relay.aclose()
                self.assertEqual(self.relay.process.exit_status, 0)
                self.assertIsNone(self.relay.process.exit_signal)
                self.assertFalse(self.disconnected.is_set())
            finally:
                await asyncio.gather(draining, return_exceptions=True)
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_socket_failure_does_not_end_other_connections_or_listener(self):
        broken, healthy = await asyncio.gather(
            roundtrip(self.url, b"RESET"), roundtrip(self.url, b"healthy" * 20000),
            return_exceptions=True,
        )
        self.assertTrue(isinstance(broken, OSError) or broken == b"")
        self.assertEqual(healthy, b"reply:" + b"healthy" * 20000)
        self.assertEqual(await roundtrip(self.url, b"after reset"), b"reply:after reset")
        self.assertFalse(self.disconnected.is_set())

    async def test_invalid_frame_ends_exec_and_listener_instead_of_allocating_payload(self):
        self.relay.process.stdin.write(HEADER.pack(b"D", 1, MAX_FRAME + 1))
        await self.relay.process.stdin.drain()
        async with asyncio.timeout(5):
            await self.disconnected.wait()
            await self.relay.process.wait_closed()
        self.assertNotEqual(self.relay.process.child.returncode, 0)
        with self.assertRaises(OSError):
            await asyncio.open_connection("127.0.0.1", urlsplit(self.url).port)

    async def test_unexpected_exec_eof_notifies_and_does_not_claim_remote_exit(self):
        self.relay.process.hide_status = True
        self.relay.process.stdin.write_eof()
        async with asyncio.timeout(5):
            await self.disconnected.wait()
        with self.assertRaises(CleanupUnconfirmedError):
            await self.relay.aclose()
        self.assertFalse(self.relay.confirmed)
        self.relay.process.hide_status = False
        await self.relay.aclose()
        self.assertTrue(self.relay.confirmed)

    async def test_lost_host_eof_resets_an_incomplete_live_stream_and_exits(self):
        reader, writer = await asyncio.open_connection("127.0.0.1", urlsplit(self.url).port)
        try:
            await asyncio.wait_for(self.accepted.wait(), 3)
            self.relay.process.stdin.write_eof()
            await asyncio.wait_for(self.relay.process.wait_closed(), 3)
            await asyncio.wait_for(self.disconnected.wait(), 3)
            self.assertEqual(await asyncio.wait_for(reader.read(), 3), b"")
            self.assertEqual(self.relay.process.exit_status, 0)
            with self.assertRaises(OSError):
                await asyncio.open_connection("127.0.0.1", urlsplit(self.url).port)
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_exec_eof_settles_reset_stream_waiting_to_flush_its_close(self):
        from wandrun.integrations.remote_browser_relay import ByteRelay, PORT

        class BackpressuredPipe:
            def __init__(self):
                self.kind = None
                self.reset_started = asyncio.Event()
                self.port = None
                self.ready = asyncio.Event()

            def write(self, data):
                self.kind = data[:1]
                if self.kind == b"R":
                    self.port = PORT.unpack(data[HEADER.size:])[0]
                    self.ready.set()

            async def drain(self):
                if self.kind == b"C":
                    self.reset_started.set()
                    await asyncio.Event().wait()

        reader, writer = asyncio.StreamReader(), BackpressuredPipe()
        relay = ByteRelay(reader, writer)
        running = asyncio.create_task(relay.run())
        try:
            await asyncio.wait_for(writer.ready.wait(), 3)
            _, client = await asyncio.open_connection("127.0.0.1", writer.port)
            client.get_extra_info("socket").setsockopt(
                socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0),
            )
            client.transport.abort()
            await asyncio.wait_for(writer.reset_started.wait(), 3)
            reader.feed_eof()
            await asyncio.wait_for(running, 3)
            with self.assertRaises(OSError):
                await asyncio.open_connection("127.0.0.1", writer.port)
        finally:
            if not running.done():
                running.cancel()
            await asyncio.gather(running, return_exceptions=True)


class BrowserTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connection = ExecConnection()
        self.addAsyncCleanup(self.connection.cleanup)
        self.config = SimpleNamespace(cdp_port=19222, profile_dir="/data/home/wb/p")
        self.lost = []
        self.notified = asyncio.Event()

        async def lost(reason):
            self.lost.append(reason)
            self.notified.set()

        self.connect = AsyncMock(side_effect=AssertionError("command environment must not contact Chrome"))
        self.transport = InstaboxBrowserTransport(
            self.config, lost, start_script="/work/.wandrun/skills/browser/scripts/start_browser.py",
            connect=self.connect,
        )
        self.addAsyncCleanup(self.close_transport)
        self.servers = []
        self.addAsyncCleanup(self.close_servers)

    async def close_transport(self):
        with contextlib.suppress(CleanupUnconfirmedError):
            await self.transport.aclose()

    async def close_servers(self):
        for server in self.servers:
            server.close()
            await server.wait_closed()

    async def endpoint(self, marker):
        async def respond(reader, writer):
            try:
                request = await reader.read()
                writer.write(marker + request)
                await writer.drain()
            finally:
                writer.close()
                with contextlib.suppress(OSError):
                    await writer.wait_closed()
        server = await asyncio.start_server(respond, "127.0.0.1", 0)
        self.servers.append(server)
        return f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"

    async def test_endpoints_have_fixed_destinations_without_starting_or_probing_chrome(self):
        first, second = await self.endpoint(b"one:"), await self.endpoint(b"two:")
        original = {"WANDRUN_BROWSER_CDP": first, "AGENT_BROWSER_SESSION": "generation-1"}
        env1, duplicate = await asyncio.gather(*(
            self.transport.command_environment(original, self.connection) for _ in range(2)
        ))
        env2 = await self.transport.command_environment({"WANDRUN_BROWSER_CDP": second}, self.connection)
        self.assertEqual(await roundtrip(env1["WANDRUN_BROWSER_CDP"], b"a"), b"one:a")
        self.assertEqual(await roundtrip(env2["WANDRUN_BROWSER_CDP"], b"b"), b"two:b")
        self.assertEqual(duplicate["WANDRUN_BROWSER_CDP"], env1["WANDRUN_BROWSER_CDP"])
        self.assertEqual(original["WANDRUN_BROWSER_CDP"], first)
        self.assertEqual(env1["WANDRUN_BROWSER_START"], self.transport.start_script)
        self.assertEqual(env1["WANDRUN_BROWSER_PORT"], "19222")
        self.assertEqual(env1["WANDRUN_BROWSER_PROFILE"], self.config.profile_dir)
        self.connect.assert_not_awaited()
        await self.transport.close_endpoint(first)
        with self.assertRaises(OSError):
            await roundtrip(env1["WANDRUN_BROWSER_CDP"], b"old")
        self.assertEqual(await roundtrip(env2["WANDRUN_BROWSER_CDP"], b"live"), b"two:live")
        self.assertEqual(self.lost, [])
        with self.assertRaises(ConnectionError):
            await self.transport.command_environment(original, self.connection)

    async def test_cancelled_waiter_does_not_abandon_exec_and_revocation_wins_open(self):
        host = await self.endpoint(b"never:")
        self.connection.gate = asyncio.Event()
        first = asyncio.create_task(self.transport.command_environment(
            {"WANDRUN_BROWSER_CDP": host}, self.connection,
        ))
        await self.connection.started.wait()
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        closing = asyncio.create_task(self.transport.close_endpoint(host))
        await asyncio.sleep(0)
        self.connection.gate.set()
        await closing
        self.assertFalse(self.transport.cleanup_pending)
        with self.assertRaises(ConnectionError):
            await self.transport.command_environment({"WANDRUN_BROWSER_CDP": host}, self.connection)

    async def test_late_old_exec_exit_cannot_revoke_a_new_scene_after_recovery(self):
        old_host = await self.endpoint(b"old:")
        gate = self.connection.gate = asyncio.Event()
        old = asyncio.create_task(self.transport.command_environment(
            {"WANDRUN_BROWSER_CDP": old_host}, self.connection,
        ))
        await self.connection.started.wait()
        await self.transport.connection_lost("平台恢复")
        self.connection.gate = None
        new_host = await self.endpoint(b"fresh:")
        env = await self.transport.command_environment(
            {"WANDRUN_BROWSER_CDP": new_host}, self.connection,
        )
        self.connection.processes[0].stdin.write_eof()
        await self.connection.processes[0].wait_closed()
        gate.set()
        with self.assertRaises(ConnectionError):
            await old
        self.assertEqual(await roundtrip(env["WANDRUN_BROWSER_CDP"], b"still live"), b"fresh:still live")
        self.assertEqual(self.lost, ["平台恢复"])

    async def test_relay_loss_revokes_old_endpoint_and_new_explicit_endpoint_can_work(self):
        host = await self.endpoint(b"new:")
        env = await self.transport.command_environment({"WANDRUN_BROWSER_CDP": host}, self.connection)
        self.connection.processes[0].stdin.write_eof()
        await self.notified.wait()
        await self.transport._loss
        self.assertEqual(self.lost, ["浏览器连接中断"])
        with self.assertRaises(ConnectionError):
            await self.transport.command_environment({"WANDRUN_BROWSER_CDP": host}, self.connection)
        new_host = await self.endpoint(b"fresh:")
        new_env = await self.transport.command_environment({"WANDRUN_BROWSER_CDP": new_host}, self.connection)
        self.assertEqual(await roundtrip(new_env["WANDRUN_BROWSER_CDP"], b"scene"), b"fresh:scene")
        with self.assertRaises(OSError):
            await roundtrip(env["WANDRUN_BROWSER_CDP"], b"old")

    async def test_unconfirmed_exit_remains_responsibility_after_endpoint_and_owner_close(self):
        host = await self.endpoint(b"debt:")
        await self.transport.command_environment({"WANDRUN_BROWSER_CDP": host}, self.connection)
        self.connection.processes[0].hide_status = True
        with self.assertRaises(CleanupUnconfirmedError):
            await self.transport.close_endpoint(host)
        self.assertTrue(self.transport.cleanup_pending)
        with self.assertRaises(CleanupUnconfirmedError):
            await self.transport.close_endpoint(host)
        with self.assertRaises(CleanupUnconfirmedError):
            await self.transport.aclose()
        self.assertTrue(self.transport.cleanup_pending)

    async def test_platform_recovery_revokes_even_a_not_yet_used_persisted_scene(self):
        await self.transport.connection_lost("平台恢复")
        self.assertEqual(self.lost, ["平台恢复"])
        self.assertEqual(self.connection.processes, [])
        self.connect.assert_not_awaited()

    async def test_non_loopback_destination_is_rejected_before_exec(self):
        with self.assertRaises(ValueError):
            await self.transport.command_environment(
                {"WANDRUN_BROWSER_CDP": "http://example.org:12345"}, self.connection,
            )
        self.assertEqual(self.connection.processes, [])

    async def test_explicit_exec_rejection_can_be_prepared_on_next_explicit_use(self):
        host = await self.endpoint(b"resumed:")
        create_process = self.connection.create_process
        self.connection.create_process = AsyncMock(side_effect=asyncssh.ChannelOpenError(1, "rejected"))
        with self.assertRaises(asyncssh.ChannelOpenError):
            await self.transport.command_environment({"WANDRUN_BROWSER_CDP": host}, self.connection)
        self.assertFalse(self.transport.cleanup_pending)
        self.connection.create_process = create_process
        environment = await self.transport.command_environment({"WANDRUN_BROWSER_CDP": host}, self.connection)
        self.assertEqual(await roundtrip(environment["WANDRUN_BROWSER_CDP"], b"fresh"), b"resumed:fresh")
        await self.transport.aclose()
        self.assertFalse(self.transport.cleanup_pending)

    async def test_lost_exec_ack_retains_unknown_submission_through_owner_shutdown(self):
        self.connection.create_process = AsyncMock(side_effect=ConnectionError("exec acknowledgement lost"))
        url = "http://127.0.0.1:12345"
        with self.assertRaises(ConnectionError):
            await self.transport.command_environment({"WANDRUN_BROWSER_CDP": url}, self.connection)
        with self.assertRaises(CleanupUnconfirmedError):
            await self.transport.close_endpoint(url)
        with self.assertRaises(CleanupUnconfirmedError):
            await self.transport.aclose()


@unittest.skipUnless(
    shutil.which("curl") and shutil.which("Xvfb")
    and (shutil.which("google-chrome") or Path("/opt/google/chrome/chrome").is_file()),
    "需要 curl、Xvfb 与 Google Chrome",
)
class FinalPageRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_curl_final_page_close_replies_before_remote_exec_exit(self):
        await self._close_via_relay(hide_exit=False)

    async def test_persistent_daemon_connection_cannot_block_final_close_and_reopen(self):
        await self._close_via_relay(hide_exit=False, persistent=True)

    async def test_close_response_survives_unconfirmed_exit_without_releasing_responsibility(self):
        with self.assertLogs("wandrun.runtime.browser.leases", level="WARNING") as logs:
            await self._close_via_relay(hide_exit=True)
        self.assertTrue(any("relay cleanup unconfirmed" in line for line in logs.output))

    async def _close_via_relay(self, *, hide_exit, persistent=False):
        with ChromeDev() as chrome:
            connection = ExecConnection()
            transport = InstaboxBrowserTransport(
                SimpleNamespace(cdp_port=19222, profile_dir="/data/home/wb/p"),
                AsyncMock(side_effect=AssertionError("intentional drain must not report disconnect")),
                start_script="/work/start_browser.py",
                connect=AsyncMock(side_effect=AssertionError("local CDP needs no SSH forward")),
            )

            class HostTransport:
                async def browser_cdp_url(self):
                    return chrome.cdp_url

                async def browser_command_environment(self, env):
                    return await transport.command_environment(env, connection)

                async def drain_browser_endpoint(self, url):
                    await transport.drain_endpoint(url)

                async def close_browser_endpoint(self, url):
                    await transport.close_endpoint(url)

            notify = AsyncMock()
            browser = BrowserLeases(BrowserDefinition(chrome.cdp_url, max_pages=1),
                                    transport=HostTransport(), notify=notify)
            curl = None
            idle_writer = None
            try:
                await browser.start()
                browser.register("curl-close", "root", "agent", "entry")
                environment = await browser.command_environment("curl-close")
                connection.processes[0].hide_status = hide_exit
                relay = next(iter(transport._retained))
                async with httpx.AsyncClient(trust_env=False) as http:
                    version = (await http.get(environment["WANDRUN_BROWSER_CDP"] + "/json/version")).json()
                async with connect(version["webSocketDebuggerUrl"], proxy=None) as client:
                    await client.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                    reply = json.loads(await client.recv())
                    self.assertIn("result", reply)
                    ident = browser.lease_for_task("curl-close")
                    target = browser.detail(ident)["current"]
                    endpoint = browser._tasks["curl-close"].endpoint
                    if persistent:
                        idle_reader, idle_writer = await asyncio.open_connection(
                            "127.0.0.1", urlsplit(environment["WANDRUN_BROWSER_CDP"]).port)
                        # A daemon may leave TCP connected without finishing an
                        # HTTP / WebSocket handshake. It isn't server.connections.
                        idle_writer.write(b"GET /json/version HTTP/1.1\r\n")
                        await idle_writer.drain()
                        async with asyncio.timeout(3):
                            while len(relay.mux.streams) < 2:
                                await asyncio.sleep(.01)
                    reached, release = asyncio.Event(), asyncio.Event()
                    census = browser._remaining_targets

                    async def held_census(lease):
                        reached.set()
                        await release.wait()
                        return await census(lease)

                    with patch.object(browser, "_remaining_targets", held_census):
                        try:
                            curl = await asyncio.create_subprocess_exec(
                                "curl", "--fail-with-body", "--silent", "--show-error", "--max-time", "10",
                                f"{environment['WANDRUN_BROWSER_CDP']}/json/close/{target}",
                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                            )
                            await asyncio.wait_for(reached.wait(), 3)
                            # This revoked-generation socket sends no CDP command:
                            # it isn't in lease.clients, but mustn't block drain.
                            async with connect(version["webSocketDebuggerUrl"], proxy=None) as diagnostic:
                                release.set()
                                output, error = await asyncio.wait_for(curl.communicate(), 15)
                                self.assertEqual(curl.returncode, 0, error.decode())
                                self.assertEqual(json.loads(output), {"closed": target})
                                await asyncio.wait_for(diagnostic.wait_closed(), 3)
                        finally:
                            release.set()
                await asyncio.wait_for(asyncio.shield(browser._get(ident).close_future), 5)
                self.assertEqual(browser.detail(ident)["state"], "released")
                self.assertEqual(browser.detail(ident)["pages"], [])
                await asyncio.sleep(0)  # Let the independently owned reaper start.
                if hide_exit:
                    with self.assertRaises(CleanupUnconfirmedError):
                        await asyncio.wait_for(asyncio.shield(endpoint.remote_closing), 5)
                else:
                    await asyncio.wait_for(asyncio.shield(endpoint.remote_closing), 5)
                if hide_exit:
                    self.assertIn(relay, transport._retained)
                    self.assertTrue(transport.cleanup_pending)
                    self.assertFalse(relay.confirmed)
                    async with asyncio.timeout(3):
                        while not notify.await_count:
                            await asyncio.sleep(.01)
                    self.assertIn("转发清理尚未确认", notify.await_args.args[1])
                else:
                    self.assertFalse(transport.cleanup_pending)
                    self.assertEqual(transport._retained, set())
                self.assertEqual(browser.capacity()["pages_used"], 0)
                remaining = (await browser._chrome.call("Target.getTargets"))["targetInfos"]
                self.assertNotIn(target, {item["targetId"] for item in remaining})
                self.assertEqual(connection.processes[0].child.returncode, 0)
                if persistent:
                    self.assertEqual(await asyncio.wait_for(idle_reader.read(), 3), b"")
                # A fresh explicit environment consumes the old-scene notice,
                # then another explicit use allocates a new entry and target.
                notice = await browser.command_environment("curl-close")
                async with httpx.AsyncClient(trust_env=False) as http:
                    version = (await http.get(notice["WANDRUN_BROWSER_CDP"] + "/json/version")).json()
                async with connect(version["webSocketDebuggerUrl"], proxy=None) as stale:
                    await stale.send(json.dumps({"id": 2, "method": "Browser.getVersion"}))
                    self.assertIn("error", json.loads(await stale.recv()))
                fresh = await browser.command_environment("curl-close")
                self.assertNotEqual(fresh["WANDRUN_BROWSER_CDP"], environment["WANDRUN_BROWSER_CDP"])
                async with httpx.AsyncClient(trust_env=False) as http:
                    version = (await http.get(fresh["WANDRUN_BROWSER_CDP"] + "/json/version")).json()
                async with connect(version["webSocketDebuggerUrl"], proxy=None) as reopened:
                    await reopened.send(json.dumps({"id": 3, "method": "Browser.getVersion"}))
                    self.assertIn("result", json.loads(await reopened.recv()))
                    new_id = browser.lease_for_task("curl-close")
                    self.assertNotEqual(new_id, ident)
                    self.assertNotEqual(browser.detail(new_id)["current"], target)
            finally:
                if idle_writer is not None:
                    idle_writer.close()
                    await idle_writer.wait_closed()
                if curl is not None and curl.returncode is None:
                    curl.kill()
                    await curl.wait()
                try:
                    if hide_exit:
                        with self.assertRaises(ExceptionGroup):
                            await browser.aclose()
                    else:
                        await browser.aclose()
                finally:
                    if hide_exit and browser._chrome is not None:
                        await browser._chrome.close()
                    try:
                        if hide_exit:
                            with self.assertRaises(CleanupUnconfirmedError):
                                await transport.aclose()
                        else:
                            await transport.aclose()
                    finally:
                        await connection.cleanup()


class CommandEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_call_environment_is_literal_isolated_and_available_through_instabox(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            child = await asyncio.create_subprocess_exec(
                sys.executable, remote_session.__file__, directory, "0.1",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            channel = SessionChannel(child.stdout, child.stdin)
            await channel.open(0.1)
            ssh = SSHBackend(channel, connection=None, label="local-exec", workdir=directory,
                             termination_grace=0.1)
            owner = InstaboxBackend("m_" + "a" * 26, workdir=directory)
            connection = SimpleNamespace(is_closed=lambda: False, close=lambda: None,
                                         wait_closed=AsyncMock())
            owner._backend, owner._connection = ssh, connection
            owner._sessions.append(ssh)
            owner._connections.append(connection)
            marker = "literal ' quote \" newline\n$(touch should-not-exist); 雪"
            script = "import json, os; print(json.dumps([os.environ.get('WANDRUN_ENV_PROBE'), bool(os.environ.get('PATH'))]))"
            command = shlex.quote(sys.executable) + " -c " + shlex.quote(script)
            try:
                first, second = await asyncio.gather(
                    owner.aexecute(command, env={"WANDRUN_ENV_PROBE": marker}),
                    owner.aexecute(command, env={"WANDRUN_ENV_PROBE": "other call"}),
                )
                self.assertEqual(json.loads(first.output), [marker, True])
                self.assertEqual(json.loads(second.output), ["other call", True])
                plain = await owner.aexecute(command)
                self.assertEqual(json.loads(plain.output), [None, True])
                sync = await asyncio.to_thread(owner.execute, command, env={"WANDRUN_ENV_PROBE": "sync"})
                self.assertEqual(json.loads(sync.output), ["sync", True])
                self.assertFalse((Path(directory) / "should-not-exist").exists())
                owner.configure_browser(
                    SimpleNamespace(cdp_port=9222, profile_dir="/data/home/wandrun-browser/profile"),
                    AsyncMock(), start_script="/work/start_browser.py",
                )
                owner._browser.command_environment = AsyncMock(
                    side_effect=lambda env, connection: env)
                environment = await owner.browser_command_environment(
                    {"WANDRUN_BROWSER_CDP": "http://127.0.0.1:12345"})
                probe = await owner.aexecute(
                    shlex.quote(sys.executable) + " -c " + shlex.quote(
                        "import json,os; print(json.dumps(os.environ['PATH']))"),
                    env=environment,
                )
                remote_path = json.loads(probe.output)
                self.assertEqual(remote_path.split(":")[0],
                                 "/data/home/wandrun-browser/agent-browser/bin")
                original = await owner.aexecute('printf %s "$PATH"')
                self.assertEqual(remote_path.split(":", 1)[1], original.output)
            finally:
                await owner.aclose()
                await child.wait()
                await child.stderr.read()


class _ForwardServer(asyncssh.SSHServer):
    def begin_auth(self, username):
        return False

    def connection_requested(self, dest_host, dest_port, orig_host, orig_port):
        return dest_host == "127.0.0.1"


class IndependentForwardTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = await asyncssh.listen(
            "127.0.0.1", 0, server_factory=_ForwardServer,
            server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
        )
        self.connections = []
        self.addAsyncCleanup(self.close_ssh)
        self.received = []

        async def respond(reader, writer):
            try:
                data = await reader.read()
                self.received.append(data)
                writer.write(b"CDP:" + data)
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        self.chrome = await asyncio.start_server(respond, "127.0.0.1", 0)
        self.addAsyncCleanup(self.close_chrome)
        self.notified = asyncio.Event()
        self.reasons = []

        async def disconnected(reason):
            self.reasons.append(reason)
            self.notified.set()

        self.transport = InstaboxBrowserTransport(
            SimpleNamespace(cdp_port=self.chrome.sockets[0].getsockname()[1], profile_dir="/private/p"),
            disconnected, start_script="/work/start_browser.py", connect=self.connect,
        )
        self.addAsyncCleanup(self.transport.aclose)
        self.command = await self.connect()

    async def connect(self):
        # Test-only loopback SSH server. Provider CA verification is covered by
        # InstaboxTests; no external host is accepted by this fixture.
        connection = await asyncssh.connect(
            "127.0.0.1", port=self.server.get_port(), username="test",
            known_hosts=None, config=None, agent_path=None,
        )
        self.connections.append(connection)
        return connection

    async def close_ssh(self):
        for connection in self.connections:
            connection.close()
        await asyncio.gather(*(connection.wait_closed() for connection in self.connections))
        self.server.close()
        await self.server.wait_closed()

    async def close_chrome(self):
        self.chrome.close()
        await self.chrome.wait_closed()

    async def test_real_forward_is_independent_and_disconnect_requires_a_fresh_explicit_call(self):
        url = await self.transport.cdp_url(self.command)
        self.assertEqual(await roundtrip(url, b"first scene"), b"CDP:first scene")
        self.assertEqual(len(self.connections), 2)
        self.assertIsNot(self.transport._connection, self.command)
        self.transport._forward.close()
        await self.notified.wait()
        await self.transport._loss
        self.assertFalse(self.command.is_closed())
        self.assertEqual(self.reasons, ["浏览器连接中断"])
        with self.assertRaises(OSError):
            await roundtrip(url, b"must not be replayed")
        fresh = await self.transport.cdp_url(self.command)
        self.assertEqual(await roundtrip(fresh, b"new scene"), b"CDP:new scene")
        self.assertEqual(self.received, [b"first scene", b"new scene"])
        self.assertEqual(len(self.connections), 3)
        await self.transport.aclose()
        self.assertEqual(self.reasons, ["浏览器连接中断"])
        with self.assertRaises(OSError):
            await roundtrip(fresh, b"closed owner")

    async def test_command_ssh_loss_also_revokes_scene_once_and_does_not_replay(self):
        old = await self.transport.cdp_url(self.command)
        self.assertEqual(await roundtrip(old, b"before"), b"CDP:before")
        self.command.close()
        await self.notified.wait()
        await self.transport._loss
        self.assertEqual(self.reasons, ["浏览器连接中断"])
        command = await self.connect()
        new = await self.transport.cdp_url(command)
        self.assertEqual(await roundtrip(new, b"after"), b"CDP:after")
        self.assertEqual(self.received, [b"before", b"after"])
