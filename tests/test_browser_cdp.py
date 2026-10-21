"""Lease-scoped CDP routing and in-flight settlement regressions.

These exercise the real WebSocket relay against a controlled CDP peer; they do
not start Chrome, so Chrome-backed lease tests can run separately and serially.
"""

import asyncio
import json
import unittest

from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from wandrun.runtime.browser_cdp import BrowserRelay, CDPError, CDPSocket


def url(server):
    return f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"


async def noop(*args):
    pass


def relay(client, upstream, page=None, owns=lambda target: target == "A", claim=noop):
    def create(_params):
        async def complete():
            return "A"
        return asyncio.create_task(complete())
    return BrowserRelay(client, upstream, epoch=1, page=page, owns=owns,
                        guard=asyncio.Lock(), authorize=lambda method, params: None,
                        create=create, claim=claim, activated=noop, destroyed=noop,
                        activity=lambda: None)


class RoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_browser_autoattach_is_rejected_without_stalling_another_lease(self):
        forwarded = []

        async def chrome(ws):
            async for raw in ws:
                command = json.loads(raw)
                forwarded.append(command)
                await ws.send(json.dumps({"id": command["id"], "result": {"product": "Chrome"}}))

        async with serve(chrome, "127.0.0.1", 0) as upstream:
            async def handle_a(ws):
                await relay(ws, url(upstream)).run()

            async def handle_b(ws):
                await relay(ws, url(upstream), owns=lambda target: target == "B").run()

            async with serve(handle_a, "127.0.0.1", 0) as a_server, \
                    serve(handle_b, "127.0.0.1", 0) as b_server:
                async with connect(url(a_server)) as a, connect(url(b_server)) as b:
                    await a.send(json.dumps({"id": 1, "method": "Target.setAutoAttach",
                                             "params": {"autoAttach": True,
                                                        "waitForDebuggerOnStart": True,
                                                        "flatten": True}}))
                    denied = json.loads(await asyncio.wait_for(a.recv(), 2))
                    self.assertIn("error", denied)
                    await b.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
                    accepted = json.loads(await asyncio.wait_for(b.recv(), 2))
                    self.assertEqual(accepted["result"]["product"], "Chrome")
                    self.assertEqual([command["method"] for command in forwarded],
                                     ["Browser.getVersion"])

    async def test_flatten_and_method_allowlist(self):
        r = relay(None, "")
        self.assertIn("扁平", r.check({"method": "Target.attachToTarget",
                                      "params": {"targetId": "A"}}))
        self.assertIn("扁平", r.check({"method": "Target.attachToTarget",
                                      "params": {"targetId": "A", "flatten": False}}))
        self.assertIsNone(r.check({"method": "Target.attachToTarget",
                                   "params": {"targetId": "A", "flatten": True}}))
        self.assertIn("扁平", r.check({"method": "Target.sendMessageToTarget",
                                      "params": {"sessionId": "anything", "message": "{}"}}))
        r.sessions["own-session"] = "A"
        self.assertIn("自动附加", r.check({"method": "Target.setAutoAttach",
                                          "sessionId": "own-session",
                                          "params": {"autoAttach": True}}))
        self.assertIn("自动附加", r.check({"method": "Target.setAutoAttach",
                                          "sessionId": "own-session",
                                          "params": {"autoAttach": True, "flatten": True}}))
        self.assertIsNone(r.check({"method": "WebMCP.enable", "sessionId": "own-session"}))
        self.assertIsNotNone(r.check({"method": "customClientMethod", "sessionId": "own-session"}))
        self.assertFalse(await r._visible({"id": 999, "result": {"product": "unknown"}}))
        self.assertIn("CDP", r.check({"method": "Security.setIgnoreCertificateErrors",
                                      "sessionId": "own-session"}))

    async def test_client_disconnect_keeps_reader_until_chrome_reply_and_drain(self):
        received = asyncio.Event()
        release = asyncio.Event()
        active = []

        async def chrome(ws):
            async for raw in ws:
                command = json.loads(raw)
                received.set()
                await release.wait()
                await ws.send(json.dumps({"id": command["id"], "result": {}}))

        async with serve(chrome, "127.0.0.1", 0) as upstream:
            async def handle(ws):
                r = relay(ws, url(upstream), page="A")
                active.append(r)
                await r.run()

            async with serve(handle, "127.0.0.1", 0) as frontend:
                async with connect(url(frontend)) as client:
                    await client.send(json.dumps({"id": 42, "method": "Input.insertText",
                                                  "params": {"text": "old"}}))
                    await asyncio.wait_for(received.wait(), 2)
                    draining = asyncio.create_task(active[0].drain())
                    await client.close()
                    await asyncio.sleep(0)
                    self.assertFalse(draining.done())
                    self.assertIn((None, 42), active[0].pending)
                    release.set()
                    await asyncio.wait_for(draining, 2)
                    self.assertFalse(active[0].pending)

    async def test_lost_chrome_reply_does_not_confirm_takeover(self):
        received = asyncio.Event()
        disconnect = asyncio.Event()
        active = []

        async def chrome(ws):
            async for _ in ws:
                received.set()
                await disconnect.wait()
                await ws.close()

        async with serve(chrome, "127.0.0.1", 0) as upstream:
            async def handle(ws):
                r = relay(ws, url(upstream), page="A")
                active.append(r)
                try:
                    await r.run()
                except CDPError:
                    pass

            async with serve(handle, "127.0.0.1", 0) as frontend:
                async with connect(url(frontend)) as client:
                    await client.send(json.dumps({"id": 42, "method": "Input.insertText"}))
                    await asyncio.wait_for(received.wait(), 2)
                    draining = asyncio.create_task(active[0].drain())
                    disconnect.set()
                    with self.assertRaises(CDPError):
                        await asyncio.wait_for(draining, 2)

    async def test_duplicate_id_in_one_session_is_rejected_without_replacing_pending(self):
        received = asyncio.Event()
        release = asyncio.Event()
        forwarded = []

        async def chrome(ws):
            async for raw in ws:
                command = json.loads(raw)
                forwarded.append(command)
                received.set()
                await release.wait()
                await ws.send(json.dumps({"id": command["id"], "result": {}}))

        async with serve(chrome, "127.0.0.1", 0) as upstream:
            async def handle(ws):
                await relay(ws, url(upstream), page="A").run()

            async with serve(handle, "127.0.0.1", 0) as frontend:
                async with connect(url(frontend)) as client:
                    command = json.dumps({"id": 5, "method": "Runtime.evaluate",
                                          "params": {"expression": "1"}})
                    await client.send(command)
                    await asyncio.wait_for(received.wait(), 2)
                    await client.send(command)
                    rejected = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertIn("正在使用", rejected["error"]["message"])
                    self.assertEqual(len(forwarded), 1)
                    release.set()
                    reply = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertEqual(reply, {"id": 5, "result": {}})
                    high = 1_000_000_000
                    await client.send(json.dumps({"id": high, "method": "Runtime.evaluate",
                                                  "params": {"expression": "42"}}))
                    reply = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertEqual(reply, {"id": high, "result": {}})
                    self.assertEqual([entry["id"] for entry in forwarded], [5, high])

    async def test_destroyed_target_keeps_delivered_identity_without_command_authority(self):
        owned = {"A"}
        release = asyncio.Event()
        destroyed = []

        async def chrome(ws):
            await ws.send(json.dumps({"method": "Target.targetCreated",
                                      "params": {"targetInfo": {"targetId": "A", "type": "page"}}}))
            await release.wait()
            await ws.send(json.dumps({"method": "Target.targetDestroyed",
                                      "params": {"targetId": "A"}}))
            async for raw in ws:
                command = json.loads(raw)
                await ws.send(json.dumps({"id": command["id"], "result": {"product": "Chrome"}}))

        async with serve(chrome, "127.0.0.1", 0) as upstream:
            async def handle(ws):
                r = relay(ws, url(upstream), owns=lambda target: target in owned)
                r.destroyed = lambda target: destroyed_target(target)
                await r.run()

            async def destroyed_target(target):
                destroyed.append(target)

            async with serve(handle, "127.0.0.1", 0) as frontend:
                async with connect(url(frontend)) as client:
                    first = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertEqual(first["params"]["targetInfo"]["targetId"], "A")
                    owned.remove("A")
                    release.set()
                    gone = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertEqual(gone, {"method": "Target.targetDestroyed",
                                            "params": {"targetId": "A"}})
                    self.assertEqual(destroyed, ["A"])
                    await client.send(json.dumps({"id": 1, "method": "Target.attachToTarget",
                                                  "params": {"targetId": "A", "flatten": True}}))
                    rejected = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertIn("页面不属于本租约", rejected["error"]["message"])
                    await client.send(json.dumps({"id": 2, "method": "Browser.getVersion"}))
                    reply = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertEqual(reply["result"]["product"], "Chrome")


    async def test_attach_reply_preserves_target_identity_after_host_removal(self):
        owned = {"A"}
        received = asyncio.Event()
        reply_ready = asyncio.Event()

        async def chrome(ws):
            command = json.loads(await ws.recv())
            received.set()
            await reply_ready.wait()
            await ws.send(json.dumps({"id": command["id"],
                                      "result": {"sessionId": "attached"}}))
            await ws.send(json.dumps({"method": "Target.targetDestroyed",
                                      "params": {"targetId": "A"}}))
            await ws.wait_closed()

        async with serve(chrome, "127.0.0.1", 0) as upstream:
            async def handle(ws):
                await relay(ws, url(upstream), owns=lambda target: target in owned).run()

            async with serve(handle, "127.0.0.1", 0) as frontend:
                async with connect(url(frontend)) as client:
                    await client.send(json.dumps({"id": 1, "method": "Target.attachToTarget",
                                                  "params": {"targetId": "A", "flatten": True}}))
                    await asyncio.wait_for(received.wait(), 2)
                    owned.remove("A")
                    reply_ready.set()
                    reply = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertEqual(reply["result"]["sessionId"], "attached")
                    gone = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertEqual(gone["method"], "Target.targetDestroyed")
                    self.assertEqual(gone["params"]["targetId"], "A")
                    await client.send(json.dumps({"id": 2, "method": "Runtime.evaluate",
                                                  "sessionId": "attached",
                                                  "params": {"expression": "1"}}))
                    rejected = json.loads(await asyncio.wait_for(client.recv(), 2))
                    self.assertIn("会话不属于本租约", rejected["error"]["message"])


class SocketLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_notification_waiting_for_send_lock_does_not_block_navigation(self):
        navigation = asyncio.Event()
        acknowledged = asyncio.Event()
        socket = None

        async def chrome(ws):
            await ws.send(json.dumps({"method": "Page.screencastFrame",
                                      "params": {"sessionId": 7}}))
            await ws.send(json.dumps({"method": "Page.frameNavigated", "params": {}}))
            async for raw in ws:
                if json.loads(raw)["method"] == "Page.screencastFrameAck":
                    acknowledged.set()

        async def on_event(message):
            if message["method"] == "Page.screencastFrame":
                socket.notify("Page.screencastFrameAck", {"sessionId": 7})
            elif message["method"] == "Page.frameNavigated":
                navigation.set()

        async with serve(chrome, "127.0.0.1", 0) as server:
            socket = CDPSocket(url(server), on_event)
            await socket.open()
            try:
                await socket._send_lock.acquire()
                try:
                    await asyncio.wait_for(navigation.wait(), 2)
                    self.assertFalse(acknowledged.is_set())
                finally:
                    socket._send_lock.release()
                await asyncio.wait_for(acknowledged.wait(), 2)
            finally:
                await socket.close()
            self.assertTrue(socket._send_worker.done())
            self.assertTrue(socket._event_worker.done())

    async def test_notification_send_error_does_not_stop_later_notifications(self):
        sent = asyncio.Event()
        attempts = []

        class FlakyConnection:
            async def send(self, raw):
                attempts.append(json.loads(raw)["method"])
                if len(attempts) == 1:
                    raise RuntimeError("transient send error")
                sent.set()

        socket = CDPSocket("")
        socket.ws = FlakyConnection()
        socket._send_worker = asyncio.create_task(socket._send_notifications())
        try:
            with self.assertLogs("wandrun.runtime.browser_cdp", level="ERROR"):
                socket.notify("Page.screencastFrameAck", {"sessionId": 1})
                socket.notify("Page.screencastFrameAck", {"sessionId": 2})
                await asyncio.wait_for(sent.wait(), 2)
            self.assertEqual(attempts, ["Page.screencastFrameAck", "Page.screencastFrameAck"])
            self.assertFalse(socket._send_worker.done())
        finally:
            socket._send_worker.cancel()
            await asyncio.gather(socket._send_worker, return_exceptions=True)

    async def test_natural_disconnect_stops_workers(self):
        disconnected = asyncio.Event()
        socket = None

        async def chrome(ws):
            await ws.close()

        async def on_disconnect():
            self.assertTrue(socket._send_worker.done())
            self.assertTrue(socket._event_worker.done())
            disconnected.set()

        async with serve(chrome, "127.0.0.1", 0) as server:
            socket = CDPSocket(url(server), noop, on_disconnect)
            await socket.open()
            await asyncio.wait_for(disconnected.wait(), 2)
            await asyncio.wait_for(socket._reader, 2)
            self.assertTrue(socket._send_worker.done())
            self.assertTrue(socket._event_worker.done())
            with self.assertRaises(CDPError):
                socket.notify("Page.screencastFrameAck", {"sessionId": 7})
            await socket.close()

    async def test_reader_disconnect_callback_can_close_without_self_wait(self):
        disconnected = asyncio.Event()
        socket = None

        async def chrome(ws):
            await ws.close()

        async def on_disconnect():
            await socket.close()
            disconnected.set()

        async with serve(chrome, "127.0.0.1", 0) as server:
            socket = CDPSocket(url(server), noop, on_disconnect)
            await socket.open()
            await asyncio.wait_for(disconnected.wait(), 2)
            await asyncio.wait_for(socket._reader, 2)

    async def test_event_callback_can_close_without_self_wait(self):
        closed = asyncio.Event()
        socket = None

        async def chrome(ws):
            await ws.send(json.dumps({"method": "Page.frameNavigated"}))
            await ws.wait_closed()

        async def on_event(_message):
            await socket.close()
            closed.set()

        async with serve(chrome, "127.0.0.1", 0) as server:
            socket = CDPSocket(url(server), on_event)
            await socket.open()
            await asyncio.wait_for(closed.wait(), 2)
            await asyncio.wait_for(socket._event_worker, 2)
            self.assertTrue(socket._send_worker.done())

    async def test_natural_disconnect_allows_event_callback_finally_to_close(self):
        entered, closed = asyncio.Event(), asyncio.Event()
        socket = None

        async def chrome(ws):
            await ws.send(json.dumps({"method": "Page.frameNavigated"}))
            await entered.wait()
            await ws.close()

        async def on_event(_message):
            try:
                entered.set()
                await asyncio.Future()
            finally:
                await socket.close()
                closed.set()

        async with serve(chrome, "127.0.0.1", 0) as server:
            socket = CDPSocket(url(server), on_event)
            await socket.open()
            try:
                await asyncio.wait_for(closed.wait(), 2)
                await asyncio.wait_for(socket._reader, 2)
                self.assertTrue(socket._event_worker.done())
                self.assertTrue(socket._send_worker.done())
            finally:
                await socket.close()


