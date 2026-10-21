"""Chrome-backed behavioral regressions for task-scoped CDP and lease lifecycle.

Chrome/Xvfb absent => these integration cases skip; no existing profile or port is used.
Run serially because ChromeDev owns one disposable Xvfb + Chrome pair.
"""

import asyncio
import base64
import json
import shutil
import tempfile
import time
from unittest.mock import patch
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.request import urlopen

import httpx
from websockets.asyncio.client import connect

from wandrun.config import AgentCatalog, AgentDefinition, BrowserDefinition
from wandrun.integrations.browser_dev import ChromeDev
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.runtime.browser import BrowserLeases, BrowserRejected
from wandrun.runtime.browser_cdp import CDPError, CDPSocket
from wandrun.runtime.workers import WorkerManager


async def until(predicate, timeout=3):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError("timed out waiting for browser state")
        await asyncio.sleep(.025)

async def discovery(env):
    def fetch():
        with urlopen(env["WANDRUN_BROWSER_CDP"] + "/json/version", timeout=3) as response:
            return json.load(response)["webSocketDebuggerUrl"]
    return await asyncio.to_thread(fetch)


class Client:
    def __init__(self, ws):
        self.ws = ws
        self.ident = 0

    async def call(self, method, params=None, *, session=None):
        self.ident += 1
        message = {"id": self.ident, "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        await self.ws.send(json.dumps(message))
        while True:
            reply = json.loads(await asyncio.wait_for(self.ws.recv(), 10))
            if reply.get("id") == self.ident:
                return reply

    async def close(self):
        await self.ws.close()


class BrowserLeaseTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        if not (shutil.which("google-chrome") or Path("/opt/google/chrome/chrome").is_file()):
            raise unittest.SkipTest("Google Chrome is required for browser lease integration tests")
        if shutil.which("Xvfb") is None:
            raise unittest.SkipTest("Xvfb is required for browser lease integration tests")
        cls.chrome = ChromeDev()
        cls.chrome.__enter__()

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, "chrome"):
            cls.chrome.__exit__(None, None, None)

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "browser-leases.json"
        self.tick = [0.0]
        self.notices = []
        self.events = []
        self.config = BrowserDefinition(self.chrome.cdp_url, slots=2, max_pages=3,
                                        idle_timeout=100, queue_timeout=.25)
        await self.open_browser()
        self.clients = []

    async def open_browser(self):
        async def notify(task, text, interrupt):
            self.notices.append((task, text, interrupt))
        self.browser = BrowserLeases(self.config, state_path=self.state,
                                     clock=lambda: self.tick[0], notify=notify,
                                     on_event=lambda name, data: self.events.append((name, data)))
        await self.browser.start()

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        await self.browser.aclose()
        self.temp.cleanup()

    async def client(self, task, root=None):
        self.browser.register(task, root or task + "-root", task + "-agent", "entry")
        env = await self.browser.command_environment(task)
        ws_url = await discovery(env)
        client = Client(await connect(ws_url, max_size=None))
        self.clients.append(client)
        reply = await client.call("Browser.getVersion")
        self.assertIn("result", reply, reply)
        await until(lambda: self.browser.lease_for_task(task) is not None)
        return client, self.browser.lease_for_task(task), env

    async def test_scoped_discovery_rejects_foreign_targets_and_global_mutation(self):
        a, aid, aenv = await self.client("alpha")
        b, bid, benv = await self.client("beta")
        atarget = self.browser.detail(aid)["current"]
        btarget = self.browser.detail(bid)["current"]
        self.assertNotEqual(atarget, btarget)
        for client, own, foreign in ((a, atarget, btarget), (b, btarget, atarget)):
            targets = (await client.call("Target.getTargets"))["result"]["targetInfos"]
            self.assertIn(own, {t["targetId"] for t in targets})
            self.assertNotIn(foreign, {t["targetId"] for t in targets})
            denied = await client.call("Target.attachToTarget", {"targetId": foreign, "flatten": True})
            self.assertIn("页面不属于本租约", denied["error"]["message"])
            denied = await client.call("Target.closeTarget", {"targetId": foreign})
            self.assertIn("error", denied)
            denied = await client.call("Browser.close")
            self.assertIn("error", denied)
            denied = await client.call("Network.clearBrowserCookies")
            self.assertIn("error", denied)
            attached = await client.call("Target.attachToTarget", {"targetId": own, "flatten": True})
            session = attached["result"]["sessionId"]
            for method in ("Storage.clearDataForStorageKey", "ServiceWorker.stopAllWorkers",
                           "Tracing.end", "Network.deleteCookies"):
                denied = await client.call(method, session=session)
                self.assertIn("error", denied, method)
            nested = await client.call("Target.sendMessageToTarget", {
                "sessionId": session,
                "message": json.dumps({"id": 17, "method": "Target.createTarget",
                                       "params": {"url": "about:blank"}}),
            })
            self.assertIn("error", nested)
        self.assertEqual(self.browser.detail(bid)["current"], btarget)
        self.assertNotEqual(aenv["AGENT_BROWSER_SESSION"], benv["AGENT_BROWSER_SESSION"])

    async def test_autoattach_cannot_pause_new_pages_in_another_lease(self):
        a, aid, _ = await self.client("autoattach")
        denied = await a.call("Target.setAutoAttach", {
            "autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True})
        self.assertIn("error", denied)
        b, bid, _ = await self.client("not-paused")
        target = self.browser.detail(bid)["current"]
        session = (await b.call("Target.attachToTarget", {
            "targetId": target, "flatten": True}))["result"]["sessionId"]
        self.assertIn("result", await asyncio.wait_for(
            b.call("Page.navigate", {"url": "data:text/html,<h1>Other lease</h1>"}, session=session), 3))
        result = await asyncio.wait_for(
            b.call("Runtime.evaluate", {"expression": "6*7", "returnByValue": True}, session=session), 3)
        self.assertEqual(result["result"]["result"]["value"], 42)
        self.assertEqual(self.browser.detail(aid)["state"], "agent")

    async def test_same_request_id_across_sessions_keeps_target_list_scoped(self):
        a, aid, _ = await self.client("same-id")
        _, bid, _ = await self.client("foreign-id")
        own = self.browser.detail(aid)["current"]
        foreign = self.browser.detail(bid)["current"]
        session = (await a.call("Target.attachToTarget", {
            "targetId": own, "flatten": True}))["result"]["sessionId"]
        await a.ws.send(json.dumps({"id": 33, "method": "Target.getTargets"}))
        await a.ws.send(json.dumps({"id": 33, "sessionId": session, "method": "Runtime.evaluate",
                                   "params": {"expression": "42", "returnByValue": True}}))
        replies = {}
        async with asyncio.timeout(3):
            while len(replies) < 2:
                reply = json.loads(await a.ws.recv())
                if reply.get("id") == 33:
                    replies[reply.get("sessionId")] = reply
        self.assertEqual(replies[session]["result"]["result"]["value"], 42)
        targets = {info["targetId"] for info in replies[None]["result"]["targetInfos"]}
        self.assertEqual(targets, {own})
        self.assertNotIn(foreign, targets)

    async def test_discovery_exposes_only_lease_connection_addresses(self):
        _, ident, env = await self.client("discovery")
        async with httpx.AsyncClient() as http:
            targets = (await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/list")).json()
            version = (await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")).json()
        self.assertEqual({t["id"] for t in targets}, {self.browser.detail(ident)["current"]})
        for item in [version, *targets]:
            self.assertNotIn("devtoolsFrontendUrl", item)
            self.assertTrue(item["webSocketDebuggerUrl"].startswith(
                env["WANDRUN_BROWSER_CDP"].replace("http://", "ws://") + "/devtools/"))

    async def test_http_final_page_close_obeys_scope_and_epoch(self):
        _, aid, aenv = await self.client("http-owner")
        _, bid, _ = await self.client("http-other")
        target = self.browser.detail(aid)["current"]
        foreign = self.browser.detail(bid)["current"]
        async with httpx.AsyncClient(timeout=15) as http:
            base = aenv["WANDRUN_BROWSER_CDP"]
            denied = await http.get(f"{base}/json/close/{foreign}")
            self.assertEqual(denied.status_code, 409)
            self.assertEqual(self.browser.detail(bid)["current"], foreign)
            await self.browser.takeover(aid)
            denied = await http.get(f"{base}/json/close/{target}")
            self.assertEqual(denied.status_code, 409)
            self.assertEqual(self.browser.detail(aid)["state"], "human")
            await self.browser.handback(aid)
            fresh = await self.browser.command_environment("http-owner")
            closed = await http.get(f"{fresh['WANDRUN_BROWSER_CDP']}/json/close/{target}")
            self.assertEqual(closed.status_code, 200)
        self.assertIsNone(self.browser.lease_for_task("http-owner"))
        with self.assertRaises(BrowserRejected):
            await self.browser.new_page(aid, self.browser.detail(aid)["epoch"])
        self.assertEqual(self.browser.capacity()["slots_used"], 1)
        self.assertEqual(self.browser.detail(aid)["reason"], "Agent 关闭")
        self.assertEqual(self.browser.detail(bid)["state"], "agent")

    async def test_popup_claims_opener_and_enforces_page_limit(self):
        a, aid, _ = await self.client("alpha")
        b, bid, _ = await self.client("beta")
        page = self.browser.detail(aid)["current"]
        for script in ("window.open('about:blank','_blank')",
                       "window.open('about:blank','_blank','noopener')"):
            await self.browser.page_call(aid, page, "Runtime.evaluate",
                                         {"expression": script, "userGesture": True})
            expected = 2 if "noopener" not in script else 3
            await until(lambda: len(self.browser.detail(aid)["pages"]) == expected)
            self.assertEqual(len(self.browser.detail(bid)["pages"]), 1)
            visible = (await a.call("Target.getTargets"))["result"]["targetInfos"]
            self.assertEqual({p["id"] for p in self.browser.detail(aid)["pages"]},
                             {p["targetId"] for p in visible})
            self.assertEqual(len((await b.call("Target.getTargets"))["result"]["targetInfos"]), 1)
        rejected = await a.call("Target.createTarget", {"url": "about:blank"})
        self.assertIn("页面数已达上限", rejected["error"]["message"])
        second, third = [p["id"] for p in self.browser.detail(aid)["pages"] if p["id"] != page]
        self.assertIn("result", await a.call("Target.activateTarget", {"targetId": second}))
        await until(lambda: self.browser.detail(aid)["current"] == second)
        self.assertIn("result", await a.call("Target.activateTarget", {"targetId": third}))
        await until(lambda: self.browser.detail(aid)["current"] == third)
        await self.browser.close_page(aid, third)
        self.assertEqual(self.browser.detail(aid)["current"], second)

    async def test_document_revision_and_title_poll_track_actual_page(self):
        _, ident, _ = await self.client("titles")
        target = self.browser.detail(ident)["current"]
        initial = self.browser.detail(ident)["pages"][0]["revision"]
        await self.browser.page_call(ident, target, "Runtime.evaluate", {
            "expression": "document.title = 'Lease title changed in DOM'"})
        await until(lambda: self.browser.detail(ident)["pages"][0]["title"] == "Lease title changed in DOM")
        human = await self.browser.takeover(ident)
        await self.browser.human_call(ident, target, human["epoch"], "Page.navigate",
                                       {"url": "data:text/html,<title>Next document</title>"})
        await until(lambda: self.browser.detail(ident)["pages"][0]["revision"] > initial)
        self.assertIn("data:text/html", self.browser.detail(ident)["pages"][0]["url"])

    async def test_fifo_queue_timeout_cancellation_and_final_page_release(self):
        await self.browser.aclose()
        self.config = BrowserDefinition(self.chrome.cdp_url, slots=1, max_pages=3,
                                        idle_timeout=100, queue_timeout=.25)
        await self.open_browser()
        a, aid, _ = await self.client("occupant", "occupied-root")
        self.browser.register("waiting", "waiting-root", "waiting-agent", "entry")
        env = await self.browser.command_environment("waiting")
        url = await discovery(env)
        waiting = Client(await connect(url))
        self.clients.append(waiting)
        rejected = await waiting.call("Browser.getVersion")
        self.assertIn("occupied-root", rejected["error"]["message"])
        self.assertIn("浏览器槽位已满", rejected["error"]["message"])
        self.assertIsNone(self.browser.lease_for_task("waiting"))
        self.browser.register("cancelled", "cancel-root", "cancel-agent", "entry")
        env = await self.browser.command_environment("cancelled")
        url = await discovery(env)
        queued = Client(await connect(url))
        self.clients.append(queued)
        await until(lambda: bool(self.browser._waiters))
        await self.browser.close_task("cancelled", "任务结束")
        self.assertIsNone(self.browser.lease_for_task("cancelled"))
        await until(lambda: not self.browser._waiters)
        await asyncio.wait_for(queued.ws.wait_closed(), 3)
        async with httpx.AsyncClient() as http:
            with self.assertRaises(httpx.ConnectError):
                await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")
        page = self.browser.detail(aid)["current"]
        await a.call("Target.closeTarget", {"targetId": page})
        await until(lambda: self.browser.detail(aid)["state"] == "released")
        self.assertEqual(self.browser.detail(aid)["reason"], "最后一张页面已关闭")
        b, bid, _ = await self.client("new-owner")
        self.assertEqual(self.browser.detail(bid)["state"], "agent")

    async def test_human_last_page_close_preserves_slot_and_reopens(self):
        _, ident, _ = await self.client("human-last-page")
        target = self.browser.detail(ident)["current"]
        epoch = (await self.browser.takeover(ident))["epoch"]
        empty = await self.browser.close_page(ident, target)
        self.assertEqual((empty["state"], empty["pages"], empty["current"]),
                         ("human", [], None))
        self.assertIsNone(empty["reason"])
        self.assertEqual(self.browser.capacity()["slots_used"], 1)
        self.assertEqual([kind for kind, _ in self.events if kind == "takeover.ended"], [])
        created = await self.browser.new_page(ident, epoch)
        self.assertEqual(self.browser.detail(ident)["current"], created)
        self.assertEqual(self.browser.detail(ident)["state"], "human")
        self.assertEqual(self.browser.capacity()["slots_used"], 1)
        self.assertEqual((await self.browser.handback(ident))["state"], "agent")
        self.assertEqual(self.browser.detail(ident)["pages"][0]["id"], created)

    async def test_human_target_destroyed_keeps_empty_lease_until_handback(self):
        _, ident, _ = await self.client("target-destroyed")
        target = self.browser.detail(ident)["current"]
        epoch = (await self.browser.takeover(ident))["epoch"]
        await self.browser._chrome.call("Target.closeTarget", {"targetId": target})
        await until(lambda: self.browser.detail(ident)["pages"] == [])
        self.assertEqual(self.browser.detail(ident)["state"], "human")
        self.assertEqual(self.browser.capacity()["slots_used"], 1)
        replacement = await self.browser.new_page(ident, epoch)
        self.assertEqual(self.browser.detail(ident)["current"], replacement)
        await self.browser.close_page(ident, replacement)
        self.tick[0] = 60
        ended = await self.browser.handback(ident)
        self.assertEqual((ended["state"], ended["reason"], ended["pages"]),
                         ("released", "用户关闭", []))
        self.assertEqual(self.browser.capacity()["slots_used"], 0)
        self.assertIsNone(self.browser.lease_for_task("target-destroyed"))
        self.assertEqual(self.notices[-1],
                         ("target-destroyed", "接管结束，页面已关闭；如需继续请重新打开浏览器。", False))
        takeover_end = [data for kind, data in self.events if kind == "takeover.ended"]
        self.assertEqual(len(takeover_end), 1)
        self.assertEqual(takeover_end[0]["duration_seconds"], 60)
        with self.assertRaises(BrowserRejected):
            await self.browser.new_page(ident, epoch)
        next_env = await self.browser.command_environment("target-destroyed")
        stale = Client(await connect(await discovery(next_env)))
        self.clients.append(stale)
        self.assertIn("用户关闭", (await stale.call("Browser.getVersion"))["error"]["message"])

    async def test_empty_human_lease_still_expires_and_owner_disappearance_closes(self):
        _, ident, _ = await self.client("empty-idle")
        target = self.browser.detail(ident)["current"]
        await self.browser.takeover(ident)
        self.tick[0] = 101
        await self.browser.expire_idle()
        self.assertEqual(self.browser.detail(ident)["state"], "human")
        await self.browser.close_page(ident, target)
        self.assertEqual(self.browser.detail(ident)["state"], "human")
        self.tick[0] += self.config.idle_timeout
        await self.browser.expire_idle()
        self.assertEqual(self.browser.detail(ident)["reason"], "浏览器空闲超时")
        self.assertEqual(self.browser.capacity()["slots_used"], 0)
        _, other, _ = await self.client("empty-owner")
        page = self.browser.detail(other)["current"]
        await self.browser.takeover(other)
        await self.browser.close_page(other, page)
        await self.browser.close_task("empty-owner", "任务结束")
        self.assertEqual(self.browser.detail(other)["reason"], "任务结束")
        self.assertEqual(self.browser.capacity()["slots_used"], 0)

    async def test_fifo_admits_oldest_waiter_before_later_connection(self):
        await self.browser.aclose()
        self.config = BrowserDefinition(self.chrome.cdp_url, slots=1, max_pages=3,
                                        idle_timeout=100, queue_timeout=4)
        await self.open_browser()
        _, aid, _ = await self.client("first")
        self.browser.register("left-queue", "gone-root", "left-agent", "entry")
        abandoned = await self.browser.command_environment("left-queue")
        disconnected = Client(await connect(await discovery(abandoned)))
        await until(lambda: len(self.browser._waiters) == 1)
        await disconnected.close()
        await until(lambda: not self.browser._waiters)
        self.assertIsNone(self.browser.lease_for_task("left-queue"))
        pending = []
        for task in ("second", "third"):
            self.browser.register(task, task + "-root", task + "-agent", "entry")
            env = await self.browser.command_environment(task)
            client = Client(await connect(await discovery(env)))
            self.clients.append(client)
            pending.append(asyncio.create_task(client.call("Browser.getVersion")))
            await until(lambda: len(self.browser._waiters) == len(pending))
        await self.browser.close(aid)
        second = await pending[0]
        self.assertIn("result", second)
        self.assertIsNotNone(self.browser.lease_for_task("second"))
        self.assertIsNone(self.browser.lease_for_task("third"))
        await self.browser.close(self.browser.lease_for_task("second"))
        self.assertIn("result", await pending[1])
        self.assertIsNotNone(self.browser.lease_for_task("third"))

    async def test_request_takeover_keeps_agent_writes_and_close_reason_is_next_use(self):
        client, ident, old_env = await self.client("requesting")
        requested = await self.browser.request_takeover("requesting", "请确认登录")
        self.assertEqual(requested["state"], "requested")
        self.assertEqual(requested["requested_reason"], "请确认登录")
        self.assertIn("result", await client.call("Target.getTargets"))
        human = await self.browser.takeover(ident)
        self.assertEqual(human["state"], "human")
        ended = await self.browser.close(ident, "用户关闭")
        self.assertEqual(ended["reason"], "用户关闭")
        self.assertEqual(ended["pages"], [])
        self.assertTrue(any(name == "takeover.ended" for name, _ in self.events))
        next_env = await self.browser.command_environment("requesting")
        self.assertNotEqual(next_env["AGENT_BROWSER_SESSION"], old_env["AGENT_BROWSER_SESSION"])
        # Non-browser commands may ask for the environment repeatedly; they
        # must not consume the reason until a CDP client actually attempts use.
        self.assertEqual(next_env, await self.browser.command_environment("requesting"))
        stale = Client(await connect(await discovery(next_env)))
        self.clients.append(stale)
        rejected = await stale.call("Browser.getVersion")
        self.assertIn("用户关闭", rejected["error"]["message"])
        fresh, replacement, _ = await self.client("requesting")
        self.assertNotEqual(ident, replacement)
        self.assertIn("result", await fresh.call("Browser.getVersion"))

    async def test_unconfirmed_cleanup_keeps_slot_until_retry_confirms_pages_gone(self):
        from unittest.mock import patch

        _, ident, _ = await self.client("failed-close")
        with patch.object(self.browser, "_close_target", side_effect=CDPError("still open")):
            with self.assertRaisesRegex(BrowserRejected, "关闭未确认"):
                await self.browser.close(ident)
        self.assertEqual(self.browser.detail(ident)["state"], "stopping")
        self.assertEqual(self.browser._reserved, 1)
        result = await self.browser.close(ident)
        self.assertEqual(result["state"], "released")
        self.assertEqual(self.browser._reserved, 0)
    async def test_late_target_destroyed_completes_original_failed_close(self):
        _, ident, _ = await self.client("late-close")
        target = self.browser.detail(ident)["current"]
        await self.browser.takeover(ident)
        with patch.object(self.browser, "_close_target", side_effect=CDPError("still open")):
            with self.assertRaisesRegex(BrowserRejected, "关闭未确认"):
                await self.browser.close(ident, "用户关闭")
        self.assertEqual(self.browser._reserved, 1)
        await self.browser._chrome.call("Target.closeTarget", {"targetId": target})
        await until(lambda: self.browser.detail(ident)["state"] == "released")
        self.assertEqual(self.browser._reserved, 0)
        self.assertEqual(self.browser.detail(ident)["reason"], "用户关闭")
        self.assertIn("接管结束，页面已关闭", self.notices[-1][1])
        self.assertFalse(self.notices[-1][2])
        _, new_id, _ = await self.client("next-slot")
        self.assertEqual(self.browser.detail(new_id)["state"], "agent")

    async def test_next_agent_use_reconfirms_failed_close(self):
        _, ident, _ = await self.client("retry-close")
        with patch.object(self.browser, "_close_target", side_effect=CDPError("still open")):
            with self.assertRaises(BrowserRejected):
                await self.browser.close(ident, "用户关闭")
        env = await self.browser.command_environment("retry-close")
        self.assertEqual(self.browser.detail(ident)["state"], "released")
        self.assertEqual(self.browser._reserved, 0)
        notice = Client(await connect(await discovery(env)))
        self.clients.append(notice)
        self.assertIn("用户关闭", (await notice.call("Browser.getVersion"))["error"]["message"])
        _, replacement, _ = await self.client("retry-close")
        self.assertNotEqual(replacement, ident)

    async def test_initial_page_failure_is_reported_and_same_endpoint_retries(self):
        self.browser.register("initial-failure", "root", "agent", "entry")
        env = await self.browser.command_environment("initial-failure")
        endpoint = await discovery(env)
        with patch.object(self.browser, "_new_page", side_effect=CDPError("injected create failure")):
            failed = Client(await connect(endpoint))
            self.clients.append(failed)
            reply = await failed.call("Browser.getVersion")
            self.assertIn("injected create failure", reply["error"]["message"])
        await failed.close()
        self.assertEqual(self.browser._reserved, 0)
        recovered = Client(await connect(endpoint))
        self.clients.append(recovered)
        self.assertIn("result", await recovered.call("Browser.getVersion"))
        ident = self.browser.lease_for_task("initial-failure")
        self.assertEqual(self.browser.detail(ident)["state"], "agent")
        self.assertEqual(len(self.browser.detail(ident)["pages"]), 1)

    async def test_close_wins_over_takeover_waiting_for_drain(self):
        _, ident, _ = await self.client("interleave")
        lease = self.browser._get(ident)
        target = lease.current
        drain_entered, drain_continue = asyncio.Event(), asyncio.Event()
        close_entered, close_continue = asyncio.Event(), asyncio.Event()
        relay = next(iter(lease.relays))
        close_target = self.browser._close_target
        async def drain():
            drain_entered.set()
            await drain_continue.wait()
        async def closing(target):
            close_entered.set()
            await close_continue.wait()
            await close_target(target)
        with patch.object(relay, "drain", side_effect=drain), patch.object(
            self.browser, "_close_target", side_effect=closing,
        ):
            taking = asyncio.create_task(self.browser.takeover(ident))
            await asyncio.wait_for(drain_entered.wait(), 2)
            closing_task = asyncio.create_task(self.browser.close(ident))
            await asyncio.wait_for(close_entered.wait(), 3)
            try:
                drain_continue.set()
                with self.assertRaisesRegex(BrowserRejected, "已关闭"):
                    await taking
                self.assertEqual(lease.state, "stopping")
                with self.assertRaises(BrowserRejected):
                    await self.browser.human_call(ident, target, lease.epoch,
                                                  "Input.insertText", {"text": "forbidden"})
            finally:
                close_continue.set()
                await closing_task
        self.assertEqual(lease.state, "released")
        self.assertFalse(any(data.get("state") == "human" for _, data in self.events))

    async def test_close_task_unblocks_never_settling_chrome_evaluate(self):
        client, ident, _ = await self.client("never-settles")
        target = self.browser.detail(ident)["current"]
        session = (await client.call("Target.attachToTarget", {
            "targetId": target, "flatten": True}))["result"]["sessionId"]
        await client.ws.send(json.dumps({"id": 9191, "sessionId": session,
            "method": "Runtime.evaluate",
            "params": {"expression": "window.__leaseNeverSettles = true; new Promise(() => {})",
                       "awaitPromise": True}}))
        relay = next(iter(self.browser._get(ident).relays))
        await until(lambda: (session, 9191) in relay.pending)
        async with asyncio.timeout(4):
            while True:
                observed = await self.browser.page_call(ident, target, "Runtime.evaluate", {
                    "expression": "Boolean(window.__leaseNeverSettles)", "returnByValue": True})
                if observed["result"]["value"]:
                    break
                await asyncio.sleep(.01)
        await asyncio.wait_for(self.browser.close_task("never-settles"), 12)
        self.assertEqual(self.browser.detail(ident)["state"], "released")
        self.assertEqual(self.browser.capacity()["slots_used"], 0)
        targets = (await self.browser._chrome.call("Target.getTargets"))["targetInfos"]
        self.assertNotIn(target, {info["targetId"] for info in targets})

    async def test_cancelled_creation_stays_owned_during_user_and_task_close(self):
        for close_task in (False, True):
            with self.subTest(close_task=close_task):
                task = f"delayed-creation-{close_task}"
                _, ident, _ = await self.client(task)
                epoch = (await self.browser.takeover(ident))["epoch"]
                call = self.browser._chrome.call
                entered, release = asyncio.Event(), asyncio.Event()
                created = []
                async def delayed(method, *args, **kwargs):
                    result = await call(method, *args, **kwargs)
                    if method == "Target.createTarget":
                        created.append(result["targetId"])
                        entered.set()
                        await release.wait()
                    return result
                try:
                    with patch.object(self.browser._chrome, "call", side_effect=delayed):
                        requested = asyncio.create_task(self.browser.new_page(ident, epoch))
                        await asyncio.wait_for(entered.wait(), 3)
                        if close_task:
                            with self.assertRaises(TimeoutError):
                                await asyncio.wait_for(requested, .05)
                        else:
                            requested.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await requested
                        closing = self.browser.close_task(task) if close_task else self.browser.close(ident)
                        with self.assertRaisesRegex(BrowserRejected, "关闭未确认"):
                            await asyncio.wait_for(closing, 12)
                        self.assertEqual(self.browser.detail(ident)["state"], "stopping")
                        self.assertEqual(self.browser.capacity()["slots_used"], 1)
                        self.assertIn(created[0], {
                            info["targetId"] for info in
                            (await call("Target.getTargets"))["targetInfos"]})
                finally:
                    release.set()
                await until(lambda: not self.browser._get(ident).creating)
                if close_task:
                    await asyncio.wait_for(self.browser.close_task(task), 12)
                else:
                    await asyncio.wait_for(self.browser.close(ident), 12)
                self.assertEqual(self.browser.detail(ident)["state"], "released")
                self.assertEqual(self.browser.capacity()["slots_used"], 0)
                self.assertNotIn(created[0], {
                    info["targetId"] for info in
                    (await self.browser._chrome.call("Target.getTargets"))["targetInfos"]})

    async def test_agent_create_reply_after_disconnect_remains_lease_owned(self):
        client, ident, _ = await self.client("agent-delayed-create")
        call = self.browser._chrome.call
        entered, release = asyncio.Event(), asyncio.Event()
        created = []
        async def delayed(method, *args, **kwargs):
            result = await call(method, *args, **kwargs)
            if method == "Target.createTarget":
                created.append(result["targetId"])
                entered.set()
                await release.wait()
            return result
        try:
            with patch.object(self.browser._chrome, "call", side_effect=delayed):
                await client.ws.send(json.dumps({"id": 883, "method": "Target.createTarget",
                                                 "params": {"url": "about:blank"}}))
                await asyncio.wait_for(entered.wait(), 3)
                await client.close()
                with self.assertRaisesRegex(BrowserRejected, "关闭未确认"):
                    await asyncio.wait_for(self.browser.close(ident), 12)
                self.assertEqual(self.browser.capacity()["slots_used"], 1)
                self.assertEqual(self.browser.detail(ident)["state"], "stopping")
        finally:
            release.set()
        await until(lambda: not self.browser._get(ident).creating)
        await asyncio.wait_for(self.browser.close(ident), 12)
        self.assertEqual(self.browser.capacity()["slots_used"], 0)
        self.assertNotIn(created[0], {
            info["targetId"] for info in
            (await self.browser._chrome.call("Target.getTargets"))["targetInfos"]})

    async def test_idle_close_failure_isolated_from_other_leases_and_later_ticks(self):
        _, first, _ = await self.client("idle-failure")
        _, second, _ = await self.client("idle-other")
        target = self.browser.detail(first)["current"]
        self.tick[0] = 101
        close_target = self.browser._close_target
        failed = False
        async def fail_once(value):
            nonlocal failed
            if value == target and not failed:
                failed = True
                raise CDPError("injected unconfirmed target")
            await close_target(value)
        original_sleep = asyncio.sleep
        async def fast_idle(delay):
            if asyncio.current_task() is self.browser._idle_worker and delay == 1:
                return await original_sleep(.005)
            return await original_sleep(delay)
        with patch.object(self.browser, "_close_target", side_effect=fail_once), \
                patch("wandrun.runtime.browser.asyncio.sleep", side_effect=fast_idle), \
                self.assertLogs("wandrun.runtime.browser", level="WARNING") as reported:
            await until(lambda: self.browser.detail(second)["state"] == "released", timeout=8)
            self.assertEqual(self.browser.detail(first)["state"], "stopping")
            self.assertEqual(self.browser.capacity()["slots_used"], 1)
            self.assertFalse(self.browser._idle_worker.done())
            _, later, _ = await self.client("idle-later")
            self.tick[0] += 101
            await until(lambda: self.browser.detail(later)["state"] == "released", timeout=8)
        self.assertTrue(any(first in line for line in reported.output))
        self.assertFalse(self.browser._idle_worker.done())
        self.assertEqual(self.browser.capacity()["slots_used"], 1)
        await self.browser.close(first)

    async def test_idle_does_not_hide_cancellation_or_unexpected_errors(self):
        _, ident, _ = await self.client("idle-fatal")
        self.tick[0] = 101
        for failure in (asyncio.CancelledError(), RuntimeError("state write failed")):
            with self.subTest(failure=type(failure).__name__):
                with patch.object(self.browser, "close", side_effect=failure):
                    with self.assertRaises(type(failure)):
                        await self.browser.expire_idle()
        self.assertEqual(self.browser.detail(ident)["state"], "agent")

    async def test_cancelled_human_owner_is_not_notified_by_close(self):
        _, ident, _ = await self.client("cancel-human")
        await self.browser.takeover(ident)
        self.notices.clear()
        await self.browser.close_task("cancel-human", "任务结束")
        self.assertEqual(self.browser.detail(ident)["state"], "released")
        self.assertEqual(self.notices, [])
        self.assertTrue(any(name == "takeover.ended" for name, _ in self.events))

    async def _queued_input(self, milliseconds):
        client, ident, _ = await self.client("queued")
        target = self.browser.detail(ident)["current"]
        await self.browser.page_call(ident, target, "Runtime.evaluate", {
            "expression": "document.body.innerHTML='<input id=field>';"
                          "field.focus();field.oninput=()=>window.inputAt=Date.now()"})
        session = (await client.call("Target.attachToTarget",
                                    {"targetId": target, "flatten": True}))["result"]["sessionId"]
        lease = self.browser._get(ident)
        relay = next(iter(lease.relays))
        forwarded = asyncio.Event()
        send = relay.upstream.send
        async def observe(raw):
            await send(raw)
            if json.loads(raw).get("id") == 101:
                forwarded.set()
        with patch.object(relay.upstream, "send", side_effect=observe):
            await client.ws.send(json.dumps({"id": 100, "sessionId": session, "method": "Runtime.evaluate",
                "params": {"expression": f"{{let end=Date.now()+{milliseconds};while(Date.now()<end){{}}}}"}}))
            await client.ws.send(json.dumps({"id": 101, "sessionId": session,
                                            "method": "Input.insertText", "params": {"text": "OLD"}}))
            await asyncio.wait_for(forwarded.wait(), 3)
        return ident, target

    async def test_takeover_waits_for_agent_creation_queued_at_host_send_lock(self):
        client, ident, _ = await self.client("queued-create")
        lease = self.browser._get(ident)
        url = "data:text/html,<title>Queued Agent creation</title>"
        taking = None
        try:
            async with self.browser._chrome._send_lock:
                await client.ws.send(json.dumps({"id": 101, "method": "Target.createTarget",
                                                "params": {"url": url}}))
                await until(lambda: bool(lease.creating))
                self.assertTrue(all(not relay.pending for relay in lease.relays))
                taking = asyncio.create_task(self.browser.takeover(ident))
                # The host send is blocked, not Chrome's reply or relay traffic.
                with self.assertRaises(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(taking), .1)
                self.assertEqual(lease.state, "revoking")
        finally:
            if taking is not None:
                await asyncio.gather(taking, return_exceptions=True)
        human = await asyncio.wait_for(taking, 3)
        self.assertEqual(human["state"], "human")
        self.assertFalse(lease.creating)
        created = next(page["id"] for page in human["pages"] if page["url"] == url)
        targets = (await self.browser._chrome.call("Target.getTargets"))["targetInfos"]
        self.assertIn(created, {info["targetId"] for info in targets if info["url"] == url})

    async def test_takeover_creation_timeout_preserves_ledger_for_retry(self):
        client, ident, _ = await self.client("create-timeout")
        lease = self.browser._get(ident)
        url = "data:text/html,<title>Creation after unconfirmed takeover</title>"
        async with self.browser._chrome._send_lock:
            await client.ws.send(json.dumps({"id": 101, "method": "Target.createTarget",
                                            "params": {"url": url}}))
            await until(lambda: bool(lease.creating))
            creation, = lease.creating
            with self.assertRaisesRegex(BrowserRejected, "收回未确认"):
                await asyncio.wait_for(self.browser.takeover(ident), 4)
            self.assertEqual(lease.state, "agent")
            self.assertFalse(creation.done())
            self.assertIn(creation, lease.creating)
            self.assertFalse(any(data.get("state") == "human" for _, data in self.events))
        target = await asyncio.wait_for(asyncio.shield(creation), 3)
        human = await self.browser.takeover(ident)
        self.assertEqual(human["state"], "human")
        self.assertIn(target, {page["id"] for page in human["pages"] if page["url"] == url})

    async def test_takeover_rejects_settled_creation_with_unknown_result(self):
        client, ident, _ = await self.client("unknown-create")
        lease = self.browser._get(ident)
        call = self.browser._chrome.call
        created = []

        async def lost_reply(method, *args, **kwargs):
            result = await call(method, *args, **kwargs)
            if method == "Target.createTarget":
                created.append(result["targetId"])
                raise CDPError("injected lost createTarget reply")
            return result

        try:
            with patch.object(self.browser._chrome, "call", side_effect=lost_reply):
                reply = await client.call("Target.createTarget", {"url": "about:blank"})
            self.assertIn("lost createTarget reply", reply["error"]["message"])
            await until(lambda: not lease.creating)
            self.assertTrue(lease.create_uncertain)
            for _ in range(2):
                with self.assertRaisesRegex(BrowserRejected, "收回未确认.*建页结果尚未确认"):
                    await self.browser.takeover(ident)
                self.assertEqual(lease.state, "agent")
            self.assertFalse(any(data.get("state") == "human" for _, data in self.events))
        finally:
            # The injected loss hides this id from production. Only the test can
            # confirm its removal and clear uncertainty for normal teardown.
            for target in created:
                await self.browser._close_target(target)
            lease.create_uncertain = False

    async def test_takeover_settles_inflight_chrome_input_before_human(self):
        ident, target = await self._queued_input(1200)
        human = await self.browser.takeover(ident)
        confirmed_at = time.time() * 1000
        self.assertEqual(human["state"], "human")
        result = await self.browser.page_call(ident, target, "Runtime.evaluate", {
            "expression": "[field.value,window.inputAt]", "returnByValue": True})
        value, input_at = result["result"]["value"]
        self.assertEqual(value, "OLD")
        self.assertLessEqual(input_at, confirmed_at)
        await self.browser.human_call(ident, target, human["epoch"], "Input.insertText", {"text": "-HUMAN"})
        result = await self.browser.page_call(ident, target, "Runtime.evaluate", {
            "expression": "field.value", "returnByValue": True})
        self.assertEqual(result["result"]["value"], "OLD-HUMAN")

    async def test_takeover_timeout_reports_unconfirmed_and_can_retry(self):
        ident, target = await self._queued_input(3700)
        with self.assertRaisesRegex(BrowserRejected, "收回未确认"):
            await self.browser.takeover(ident)
        self.assertEqual(self.browser.detail(ident)["state"], "agent")
        self.assertFalse(any(data.get("state") == "human" for _, data in self.events))
        fresh = await self.browser.command_environment("queued")
        human = await self.browser.takeover(ident)
        self.assertEqual(human["state"], "human")
        result = await self.browser.page_call(ident, target, "Runtime.evaluate", {
            "expression": "field.value", "returnByValue": True})
        self.assertEqual(result["result"]["value"], "OLD")
        self.assertIn("WANDRUN_BROWSER_CDP", fresh)

    async def test_handback_key_release_failure_preserves_retry_state(self):
        _, ident, _ = await self.client("release-keys")
        human = await self.browser.takeover(ident)
        lease = self.browser._get(ident)
        page = lease.pages[lease.current]
        await self.browser.page_call(ident, page.id, "Runtime.evaluate", {
            "expression": "window.released=[];onkeyup=e=>released.push(e.code)"})
        call = page.cdp.call
        async def fail_shift_release(method, params=None, **kwargs):
            if method == "Input.dispatchKeyEvent" and params.get("type") == "keyUp" and params["code"] == "ShiftLeft":
                raise CDPError("key-up transport failure")
            return await call(method, params, **kwargs)
        keys = [{"key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17},
                {"key": "Shift", "code": "ShiftLeft", "windowsVirtualKeyCode": 16}]
        with patch.object(page.cdp, "call", side_effect=fail_shift_release):
            with self.assertRaisesRegex(CDPError, "key-up transport failure"):
                await self.browser.human_batch(ident, page.id, human["epoch"], [
                    ("Input.dispatchKeyEvent", {**params, "type": kind})
                    for kind in ("rawKeyDown", "keyUp") for params in keys
                ])
            expected = {"ShiftLeft": {"target": page.id, **keys[1], "type": "rawKeyDown"}}
            self.assertEqual(lease.keys, expected)
            with self.assertRaisesRegex(CDPError, "key-up transport failure"):
                await self.browser.handback(ident)
            self.assertEqual(lease.keys, expected)
            self.assertEqual(lease.state, "human")
        self.assertEqual((await self.browser.handback(ident))["state"], "agent")
        self.assertEqual(lease.keys, {})
        result = await self.browser.page_call(ident, page.id, "Runtime.evaluate", {
            "expression": "released", "returnByValue": True})
        self.assertEqual(result["result"]["value"], ["ControlLeft", "ShiftLeft"])

    async def test_last_viewer_stops_stream_during_failed_takeover_and_close(self):
        for operation in ("takeover", "close"):
            with self.subTest(operation=operation):
                _, ident, _ = await self.client("last-viewer-" + operation)
                lease = self.browser._get(ident)
                page = lease.pages[lease.current]
                frames = []
                stop = await self.browser.subscribe_frames(ident, page.id, frames.append)
                await until(lambda: bool(frames))
                entered, release = asyncio.Event(), asyncio.Event()
                async def fail(*args):
                    entered.set()
                    await release.wait()
                    raise CDPError("injected unconfirmed operation")
                owner = next(iter(lease.relays)) if operation == "takeover" else self.browser
                method = "drain" if operation == "takeover" else "_close_target"
                with patch.object(owner, method, side_effect=fail):
                    pending = asyncio.create_task(getattr(self.browser, operation)(ident))
                    await asyncio.wait_for(entered.wait(), 3)
                    try:
                        await stop()
                        self.assertFalse(page.streaming)
                        self.assertEqual(page.viewers, set())
                    finally:
                        release.set()
                    with self.assertRaises(BrowserRejected):
                        await pending
                self.assertEqual(lease.state, "agent" if operation == "takeover" else "stopping")
                self.assertFalse(page.streaming)
                received = []
                on_event = page.cdp.on_event
                async def observe(message):
                    if message.get("method") == "Page.screencastFrame":
                        received.append(message)
                    await on_event(message)
                with patch.object(page.cdp, "on_event", side_effect=observe):
                    for color in ("red", "green", "blue"):
                        await page.cdp.call("Runtime.evaluate", {
                            "expression": f"document.body.style.background='{color}';"
                                          "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
                            "awaitPromise": True})
                    self.assertEqual(received, [])
                await self.browser.close(ident)


    async def test_task_cancellation_closes_active_lease_and_next_use_reports_reason(self):
        _, ident, _ = await self.client("cancel-owner")
        await self.browser.close_task("cancel-owner", "任务结束")
        snapshot = self.browser.detail(ident)
        self.assertEqual(snapshot["state"], "released")
        self.assertEqual(snapshot["reason"], "任务结束")
        self.assertIsNone(self.browser.lease_for_task("cancel-owner"))
        self.browser.register("cancel-owner", snapshot["root_id"], snapshot["agent_id"],
                              snapshot["entry_agent_id"])
        env = await self.browser.command_environment("cancel-owner")
        stale = Client(await connect(await discovery(env)))
        self.clients.append(stale)
        error = await stale.call("Browser.getVersion")
        self.assertIn("任务结束", error["error"]["message"])

    async def test_takeover_barrier_other_lease_and_handback_owner_notice(self):
        a, aid, env = await self.client("owner-task")
        b, bid, _ = await self.client("other-task")
        apage = self.browser.detail(aid)["current"]
        bpage = self.browser.detail(bid)["current"]
        for ident, page in ((aid, apage), (bid, bpage)):
            await self.browser.page_call(ident, page, "Runtime.evaluate", {
                "expression": "document.body.innerHTML='<input id=field>';document.querySelector('#field').focus()"})
        page_url = env["WANDRUN_BROWSER_CDP"].replace("http://", "ws://") + f"/devtools/page/{apage}"
        writer = Client(await connect(page_url))
        self.clients.append(writer)
        async def type_slowly():
            accepted = 0
            for letter in "ABCDEFGHIJ":
                try:
                    answer = await writer.call("Input.insertText", {"text": letter})
                except Exception:
                    return accepted
                if "result" not in answer:
                    return accepted
                accepted += 1
                await asyncio.sleep(.04)
            return accepted
        typing = asyncio.create_task(type_slowly())
        async def value():
            result = await self.browser.page_call(aid, apage, "Runtime.evaluate", {
                "expression": "document.querySelector('#field').value", "returnByValue": True})
            return result["result"]["value"]
        deadline = asyncio.get_running_loop().time() + 3
        while not await value():
            if asyncio.get_running_loop().time() >= deadline:
                self.fail("Agent's first input never reached its page")
            await asyncio.sleep(.01)
        human = await self.browser.takeover(aid)
        accepted = await typing
        self.assertLess(accepted, 10)
        self.assertGreater(accepted, 0)
        self.assertEqual(human["state"], "human")
        before = await self.browser.page_call(aid, apage, "Runtime.evaluate", {
            "expression": "document.querySelector('#field').value", "returnByValue": True})
        self.assertEqual(before["result"]["value"], "ABCDEFGHIJ"[:accepted])
        await self.browser.human_batch(aid, apage, human["epoch"],
                                       [("Input.insertText", {"text": "H"})])
        with self.assertRaises(BrowserRejected):
            await self.browser.human_call(aid, apage, human["epoch"] - 1,
                                           "Input.insertText", {"text": "stale"})
        self.assertIn("result", await b.call("Target.getTargets"))
        self.assertEqual(self.browser.detail(bid)["current"], bpage)
        self.tick[0] = 90
        restored = await self.browser.handback(aid)
        self.assertEqual(restored["state"], "agent")
        self.assertEqual([task for task, _, _ in self.notices], ["owner-task", "owner-task"])
        self.assertEqual([interrupt for _, _, interrupt in self.notices], [True, False])
        ended = [data for name, data in self.events if name == "takeover.ended"]
        self.assertEqual([(data["task_id"], data["duration_seconds"]) for data in ended],
                         [("owner-task", 90)])
        new_env = await self.browser.command_environment("owner-task")
        self.assertNotEqual(new_env["AGENT_BROWSER_SESSION"], env["AGENT_BROWSER_SESSION"])
        old_url = await discovery(env)
        old = Client(await connect(old_url))
        self.clients.append(old)
        denied = await old.call("Browser.getVersion")
        self.assertIn("控制权已转交", denied["error"]["message"])

    async def test_watching_prevents_idle_and_last_viewer_stops_frames(self):
        _, ident, _ = await self.client("viewer-task")
        page = self.browser.detail(ident)["current"]
        frames = []
        stop_a = await self.browser.subscribe_frames(ident, page, frames.append)
        await until(lambda: bool(frames), timeout=5)
        # Joining an already streaming, static page must not wait for a repaint.
        await asyncio.sleep(.3)
        joined = asyncio.get_running_loop().create_future()
        def initial_frame(frame):
            if not joined.done():
                joined.set_result(frame)
        stop_b = await self.browser.subscribe_frames(ident, page, initial_frame)
        initial = await asyncio.wait_for(joined, 1)
        self.assertEqual(base64.b64decode(initial["data"])[:2], b"\xff\xd8")
        self.tick[0] = 1000
        await self.browser.expire_idle()
        self.assertEqual(self.browser.detail(ident)["state"], "agent")
        await stop_a()
        self.assertTrue(self.browser._get(ident).pages[page].streaming)
        await stop_b()
        self.assertFalse(self.browser._get(ident).pages[page].streaming)
        low_frame = asyncio.get_running_loop().create_future()
        def low_received(frame):
            if not low_frame.done():
                low_frame.set_result(frame)
        stop_low = await self.browser.subscribe_frames(ident, page, low_received, quality_tier="low")
        self.assertEqual((await asyncio.wait_for(low_frame, 5))["_quality_tier"], "low")
        self.tick[0] += self.config.idle_timeout
        await self.browser.expire_idle()
        self.assertEqual(self.browser.detail(ident)["state"], "agent", "a low-tier viewer is still watching")
        await stop_low()
        await self.browser.expire_idle()
        self.assertEqual(self.browser.detail(ident)["state"], "agent")
        self.tick[0] += self.config.idle_timeout
        await self.browser.expire_idle()
        self.assertEqual(self.browser.detail(ident)["state"], "released")
        self.assertIn("空闲超时", self.browser.detail(ident)["reason"])

    async def test_chrome_transport_restart_invalidates_lease_and_reaps_old_pages(self):
        _, ident, _ = await self.client("chrome-drop")
        target = self.browser.detail(ident)["current"]
        old = self.browser._chrome
        await old.ws.close()
        await until(lambda: self.browser._chrome is None)
        self.assertEqual(self.browser.detail(ident)["state"], "stopping")
        self.assertEqual(self.browser._reserved, 1)
        self.assertTrue(all(worker.done() for worker in
                            (old._reader, old._send_worker, old._event_worker)))
        # The process is still present: reconnect must clean its orphaned
        # targets before admission, not assume WebSocket loss killed Chrome.
        env = await self.browser.command_environment("chrome-drop")
        self.assertEqual(self.browser.detail(ident)["state"], "released")
        self.assertIsNone(self.browser.lease_for_task("chrome-drop"))
        targets = (await self.browser._chrome.call("Target.getTargets"))["targetInfos"]
        self.assertNotIn(target, {t["targetId"] for t in targets})
        stale = Client(await connect(await discovery(env)))
        self.clients.append(stale)
        error = await stale.call("Browser.getVersion")
        self.assertIn("Chrome 重启", error["error"]["message"])

    async def test_restart_closes_orphans_and_retains_previous_reason(self):
        _, ident, _ = await self.client("restart-task")
        prior = self.browser.detail(ident)
        orphan = (await self.browser._chrome.call("Target.createTarget", {"url": "about:blank"}))["targetId"]
        await self.browser.aclose()
        self.state.write_text(json.dumps([{**prior, "state": "agent"}]))
        await self.open_browser()
        targets = (await self.browser._chrome.call("Target.getTargets"))["targetInfos"]
        self.assertNotIn(orphan, {t["targetId"] for t in targets})
        self.assertNotIn(prior["current"], {t["targetId"] for t in targets})
        self.assertEqual(self.browser.detail(ident)["reason"], "重启")
        self.browser.register("restart-task", prior["root_id"], prior["agent_id"], prior["entry_agent_id"])
        env = await self.browser.command_environment("restart-task")
        url = await discovery(env)
        stale = Client(await connect(url))
        self.clients.append(stale)
        error = await stale.call("Browser.getVersion")
        self.assertIn("重启", error["error"]["message"])
        self.assertIsNone(self.browser.lease_for_task("restart-task"))
        _, replacement, _ = await self.client("restart-task", prior["root_id"])
        self.assertNotEqual(replacement, ident)

    async def test_command_environment_single_flight_and_cancelled_waiter(self):
        self.browser.register("single", "root", "agent", "entry")
        first, second = await asyncio.gather(
            self.browser.command_environment("single"), self.browser.command_environment("single"))
        self.assertEqual(first, second)
        client = Client(await connect(await discovery(first)))
        self.clients.append(client)
        self.assertIn("result", await client.call("Browser.getVersion"))
        servers = [endpoint.server for endpoint in self.browser._tasks["single"].endpoints]
        self.assertEqual(len(servers), 1)
        await self.browser.aclose()
        self.assertTrue(all(not server.is_serving() for server in servers))

        await self.open_browser()
        self.browser.register("cancel-create", "root", "agent", "entry")
        entered, release = asyncio.Event(), asyncio.Event()
        serve = self.browser._serve
        created = []
        async def delayed(*args):
            endpoint = await serve(*args)
            created.append(endpoint.server)
            entered.set()
            await release.wait()
            return endpoint
        with patch.object(self.browser, "_serve", delayed):
            command = asyncio.create_task(self.browser.command_environment("cancel-create"))
            await asyncio.wait_for(entered.wait(), 3)
            command.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await command
            closing = asyncio.create_task(self.browser.close_task("cancel-create"))
            release.set()
            await closing
        self.assertTrue(all(not server.is_serving() for server in created))
        with self.assertRaises(BrowserRejected):
            await self.browser.command_environment("cancel-create")

    async def test_shutdown_retries_revoked_lease_and_reports_unconfirmed_resources(self):
        _, ident, _ = await self.client("revoked")
        _, other, _ = await self.client("other")
        target = self.browser.detail(ident)["current"]
        page = self.browser._get(ident).pages[target]
        close_target = self.browser._close_target
        async def fail_one(value):
            if value == target:
                raise CDPError("injected unconfirmed target")
            await close_target(value)
        with patch.object(self.browser, "_close_target", fail_one):
            with self.assertRaises(BrowserRejected):
                await self.browser.close_task("revoked")
            with self.assertRaises(ExceptionGroup):
                await self.browser.aclose()
        self.assertEqual(self.browser.detail(ident)["state"], "stopping")
        self.assertEqual(self.browser.detail(other)["state"], "released")
        self.assertEqual(self.browser._reserved, 1)
        self.assertFalse(self.browser._tasks["revoked"].registered)
        listed = await self.browser._fetch("/json/list")
        self.assertIn(target, {item["id"] for item in listed})
        await self.browser.aclose()
        self.assertEqual(self.browser.detail(ident)["state"], "released")
        self.assertEqual(self.browser._reserved, 0)
        self.assertNotIn(target, {item["id"] for item in await self.browser._fetch("/json/list")})
        self.assertTrue(all(task.done() for task in
                            (page.cdp._reader, page.cdp._send_worker, page.cdp._event_worker)))

    async def test_reconnect_cleanup_is_shared_before_any_new_allocation(self):
        _, ident, _ = await self.client("lost")
        inherited = self.browser.detail(ident)["current"]
        await self.browser._chrome.ws.close()
        await until(lambda: self.browser._chrome is None)
        self.browser.register("new-a", "root-a", "agent", "entry")
        self.browser.register("new-b", "root-b", "agent", "entry")
        entered, release = asyncio.Event(), asyncio.Event()
        call = CDPSocket.call
        async def delayed(socket, method, *args, **kwargs):
            if method == "Target.getTargets" and not entered.is_set():
                entered.set()
                await release.wait()
            return await call(socket, method, *args, **kwargs)
        with patch.object(CDPSocket, "call", delayed):
            first = asyncio.create_task(self.browser.command_environment("new-a"))
            await asyncio.wait_for(entered.wait(), 3)
            second = asyncio.create_task(self.browser.command_environment("new-b"))
            await asyncio.sleep(.05)
            self.assertFalse(second.done())
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            env = await second
        client = Client(await connect(await discovery(env)))
        self.clients.append(client)
        self.assertIn("result", await client.call("Browser.getVersion"))
        new_id = self.browser.lease_for_task("new-b")
        listed = {item["id"] for item in await self.browser._fetch("/json/list")}
        self.assertNotIn(inherited, listed)
        self.assertIn(self.browser.detail(new_id)["current"], listed)
        self.assertEqual(self.browser.detail(new_id)["state"], "agent")

    async def test_agent_delete_revokes_pageless_completed_child_in_retained_conversation(self):
        from test_gateway_browser import Checkpointer
        store = GatewayStore(Path(self.temp.name) / "gateway.sqlite")
        self.addCleanup(store.close)
        agent = AgentDefinition("测试", "完成", "offline", environment="local")
        store.import_agents(AgentCatalog("entry", {"entry": agent, "worker": agent}))
        gateway = Gateway(store)
        async def run(prompts, task_id):
            return "done"
        manager = WorkerManager(run, default_agent="entry",
                                agent_workers={"entry": ("worker",), "worker": ()},
                                on_task=gateway.on_task, notify_human_of_roots=False)
        self.addAsyncCleanup(manager.close)
        runtime = SimpleNamespace(browser=self.browser, memory=None, files=None, mcp=None)
        gateway.attach(manager, Checkpointer(), runtime=runtime)
        root = gateway.create_conversation("保留", "entry")["id"]
        manager.start("root", root)
        await manager.wait(root)
        child = manager.start("child", sender_id=root, agent_name="worker")["task_id"]
        await manager.wait(child)
        await manager.wait(root)
        manager.replace_agent_workers({"entry": (), "worker": ()}, "entry")
        self.browser.register(child, root, "worker", "entry")
        env = await self.browser.command_environment(child)
        self.assertEqual(self.browser.list_tasks(agent_id="worker"), [])
        async def prepare(catalog):
            return lambda: manager.replace_agent_workers(
                {name: definition.workers for name, definition in catalog.agents.items()}, "entry")
        with patch.object(gateway, "_prepare_agents", prepare):
            await gateway.delete_agent("worker")
        self.assertIsNone(store.agent("worker"))
        self.assertIsNotNone(store.conversation(root))
        with self.assertRaises(BrowserRejected):
            await self.browser.command_environment(child)
        async with httpx.AsyncClient() as http:
            with self.assertRaises(httpx.ConnectError):
                await http.get(env["WANDRUN_BROWSER_CDP"] + "/json/version")

    async def test_close_agent_cancels_queue_without_touching_other_owner(self):
        await self.browser.aclose()
        self.config = BrowserDefinition(self.chrome.cdp_url, slots=1, queue_timeout=5)
        await self.open_browser()
        _, ident, _ = await self.client("occupant")
        self.browser.register("queued-worker", "root", "worker", "entry")
        env = await self.browser.command_environment("queued-worker")
        client = Client(await connect(await discovery(env)))
        self.clients.append(client)
        await until(lambda: bool(self.browser._waiters))
        await self.browser.close_agent("worker")
        await asyncio.wait_for(client.ws.wait_closed(), 3)
        self.assertEqual(self.browser.detail(ident)["state"], "agent")
        self.assertEqual(self.browser._reserved, 1)
        self.assertIsNone(self.browser.lease_for_task("queued-worker"))
        self.assertEqual(list(self.browser._waiters), [])

    async def test_cancelled_or_unconfirmed_stream_start_stops_actual_chrome_source(self):
        _, ident, _ = await self.client("stream-start")
        page = self.browser._get(ident).pages[self.browser.detail(ident)["current"]]
        call = page.cdp.call
        for cancelled in (True, False):
            with self.subTest(cancelled=cancelled):
                entered, release = asyncio.Event(), asyncio.Event()
                async def delayed(method, *args, **kwargs):
                    result = await call(method, *args, **kwargs)
                    if method == "Page.startScreencast":
                        entered.set()
                        await release.wait()
                        if not cancelled:
                            raise CDPError("start reply lost")
                    return result
                with patch.object(page.cdp, "call", delayed):
                    subscribing = asyncio.create_task(self.browser.subscribe_frames(ident, page.id, lambda _: None))
                    await asyncio.wait_for(entered.wait(), 3)
                    if cancelled:
                        subscribing.cancel()
                    release.set()
                    with self.assertRaises(asyncio.CancelledError if cancelled else CDPError):
                        await subscribing
                self.assertFalse(page.streaming)
                self.assertEqual(page.viewers, set())
                received = []
                on_event = page.cdp.on_event
                async def observe(message):
                    if message.get("method") == "Page.screencastFrame":
                        received.append(message)
                    await on_event(message)
                await asyncio.sleep(.15)
                with patch.object(page.cdp, "on_event", observe):
                    for color in ("red", "blue", "green"):
                        await call("Runtime.evaluate", {
                            "expression": f"document.body.style.background='{color}'"})
                        await asyncio.sleep(.1)
                self.assertEqual(received, [])

    async def test_close_censuses_unclaimed_popup_and_retains_failed_popup_cleanup(self):
        for fail_popup in (False, True):
            with self.subTest(fail_popup=fail_popup):
                _, ident, _ = await self.client(f"popup-close-{fail_popup}")
                lease = self.browser._get(ident)
                target = lease.current
                entered, release = asyncio.Event(), asyncio.Event()
                claim = self.browser._claim_popup
                popup = []
                async def delayed(info):
                    if info.get("openerId") == target:
                        popup.append(info["targetId"])
                        entered.set()
                        await release.wait()
                    await claim(info)
                try:
                    with patch.object(self.browser, "_claim_popup", delayed):
                        await self.browser.page_call(ident, target, "Runtime.evaluate", {
                            "expression": "window.open('about:blank','_blank')", "userGesture": True})
                        await asyncio.wait_for(entered.wait(), 3)
                        self.assertNotIn(popup[0], lease.pages)
                        if fail_popup:
                            close_target = self.browser._close_target
                            async def fail(value):
                                if value == popup[0]:
                                    raise CDPError("popup close unconfirmed")
                                await close_target(value)
                            with patch.object(self.browser, "_close_target", fail):
                                with self.assertRaises(BrowserRejected):
                                    await self.browser.close(ident)
                            self.assertEqual(lease.state, "stopping")
                            self.assertEqual(self.browser._reserved, 1)
                        await self.browser.close(ident)
                        listed = {item["id"] for item in await self.browser._fetch("/json/list")}
                        self.assertNotIn(target, listed)
                        self.assertNotIn(popup[0], listed)
                        self.assertEqual(lease.state, "released")
                        self.assertEqual(self.browser._reserved, 0)
                finally:
                    release.set()
