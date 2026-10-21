"""Gateway browser snapshots, durable events and HTTP control boundaries."""

import asyncio
import base64
import io
import socket
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway, GatewayFailure
from wandrun.gateway.store import ClientIdConflict, GatewayStore, SCHEMA_VERSION
from wandrun.runtime.browser import BrowserRejected, UnknownBrowserTask
from wandrun.runtime.workers import WorkerManager


def snapshot(root, *, identity="lease-a", state="agent", agent_id="worker"):
    return {
        "id": identity, "task_id": "task-" + identity, "root_id": root,
        "agent_id": agent_id, "entry_agent_id": "entry", "state": state,
        "epoch": 1, "pages": [{"id": "page-a", "title": "测试", "url": "https://example.test/"}],
        "current": "page-a", "max_pages": 3, "reason": None, "requested_reason": None,
    }


class FakeBrowser:
    """Only the Chrome boundary is replaced; HTTP, events and SQLite remain real."""

    def __init__(self, lease):
        self.lease = lease
        self.on_event = None
        self.takeovers = 0
        self.page_calls = []
        self.closed_tasks = []

    def list_tasks(self, agent_id=None):
        if agent_id is not None and self.lease["agent_id"] != agent_id:
            return []
        return [dict(self.lease)]
    def capacity(self):
        active = self.lease["state"] != "released"
        return {"pages_used": len(self.lease["pages"]) if active else 0,
                "pages_limit": 6, "slots_used": int(active), "slots_limit": 2}

    def _changed(self):
        self.on_event("browser_task.updated", dict(self.lease))
        return dict(self.lease)

    async def takeover(self, identity):
        if identity != self.lease["id"]:
            raise UnknownBrowserTask(identity)
        self.takeovers += 1
        self.lease.update(state="human", epoch=self.lease["epoch"] + 1)
        return self._changed()

    async def handback(self, identity):
        if identity != self.lease["id"]:
            raise UnknownBrowserTask(identity)
        self.lease.update(state="agent", epoch=self.lease["epoch"] + 1)
        result = self._changed()
        self.on_event("takeover.ended", {
            "id": identity, "task_id": self.lease["task_id"], "root_id": self.lease["root_id"],
            "duration_seconds": 65, "text": "你接管了浏览器 1 分钟，已交还",
        })
        return result

    async def close_page(self, identity, page, reason="用户关闭"):
        if page != "page-a":
            raise BrowserRejected("页面不属于该租约")
        return await self.close(identity, reason)

    async def close(self, identity, reason="用户关闭"):
        self.lease.update(state="released", pages=[], current=None, reason=reason,
                          epoch=self.lease["epoch"] + 1)
        return self._changed()

    async def close_task(self, task_id, reason="任务结束"):
        self.closed_tasks.append((task_id, reason))
        if task_id == self.lease["task_id"] and self.lease["state"] != "released":
            await self.close(self.lease["id"], reason)

    async def page_call(self, identity, page, method, params):
        self.page_calls.append((identity, page, method, params))
        if page != "page-a":
            raise BrowserRejected("页面不属于该租约")
        return {"data": base64.b64encode(b"\xff\xd8jpeg\xff\xd9").decode()}


class Checkpointer:
    async def aget_tuple(self, config):
        return None

    async def adelete_thread(self, identity):
        return None


class GatewayBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "gateway.sqlite"
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        agent = AgentDefinition("测试角色说明", "做事", "offline", environment="local", name="测试")
        self.store.import_agents(AgentCatalog("entry", {"entry": agent, "worker": agent}))
        self.gateway = Gateway(self.store)

        async def run(prompts, task_id):
            return "完成"

        self.manager = WorkerManager(run, on_task=self.gateway.on_task,
                                     default_agent="entry", notify_human_of_roots=False)
        self.addAsyncCleanup(self.manager.close)
        self.root = self.gateway.create_conversation("对话", "entry")["id"]
        self.lease = snapshot(self.root)
        self.browser = FakeBrowser(self.lease)
        self.runtime = SimpleNamespace(browser=self.browser, files=None, mcp=None, memory=None)
        self.gateway.attach(self.manager, Checkpointer(), runtime=self.runtime)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway", headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_head_preserves_browser_lease_and_events(self):
        for path in ("/browser-tasks", "/browser-tasks/lease-a"):
            with self.subTest(path=path):
                before = (await self.client.get(path)).json()
                seq = self.store.last_seq()
                response = await self.client.head(path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, b"")
                self.assertEqual(self.store.last_seq(), seq)
                self.assertEqual((await self.client.get(path)).json(), before)
                self.assertEqual(self.lease["state"], "agent")
                self.assertEqual(self.lease["pages"][0]["id"], "page-a")

    async def test_browser_task_labels_entry_filter_and_live_title(self):
        listed = (await self.client.get("/browser-tasks?entry_agent_id=entry")).json()
        task, = listed["browser_tasks"]
        self.assertEqual((task["agent_id"], task["entry_agent_id"]), ("worker", "entry"))
        self.assertEqual((task["conversation_title"], task["entry_agent_name"], task["max_pages"]),
                         ("对话", "测试", 3))
        self.assertEqual((task["pages"][0]["title"], task["pages"][0]["url"]),
                         ("测试", "https://example.test/"))
        self.assertEqual(listed["as_of_seq"], self.store.last_seq())
        self.assertEqual((await self.client.get("/browser-tasks?entry_agent_id=worker")).json()["browser_tasks"], [])
        self.assertEqual((await self.client.get(
            "/browser-tasks?entry_agent_id=entry&agent_id=entry")).json()["browser_tasks"], [])
        self.assertEqual((await self.client.get(
            "/browser-tasks?entry_agent_id=entry&agent_id=worker")).json()["browser_tasks"][0]["id"], task["id"])
        self.assertEqual((await self.client.get("/browser-tasks?entry_agent_id=missing")).status_code, 404)
        cursor = self.store.last_seq()
        self.browser.lease["pages"][0].update(title="新标题", url="https://example.test/new")
        self.browser._changed()
        update, = self.store.after(cursor)
        self.assertEqual((update.data["conversation_title"], update.data["entry_agent_name"]),
                         ("对话", "测试"))
        self.assertEqual((update.data["pages"][0]["title"], update.data["pages"][0]["url"]),
                         ("新标题", "https://example.test/new"))
        self.gateway.rename_conversation(self.root, "新对话")
        self.assertEqual((await self.client.get("/browser-tasks/lease-a")).json()["conversation_title"], "新对话")

    async def test_requested_transition_restores_entry_home_without_title_activity(self):
        self.store.hide_agent("entry")
        self.store.hide_agent("worker")
        self.browser.lease["state"] = "requested"
        self.browser._changed()
        requested_seq = self.store.last_seq()
        entry = self.store.agent_item("entry")
        self.assertTrue(entry["home"])
        self.assertFalse(self.store.agent_item("worker")["home"])
        self.assertEqual(entry["latest_conversation"]["last_activity_seq"], requested_seq)
        self.assertTrue(self.store.after(requested_seq - 1)[0].data["entered_requested"])

        self.store.hide_agent("entry")
        self.browser.lease["pages"][0].update(title="另一个标题", url="https://example.test/next")
        self.browser._changed()
        entry = self.store.agent_item("entry")
        self.assertFalse(entry["home"])
        self.assertEqual(entry["latest_conversation"]["last_activity_seq"], requested_seq)
        self.assertFalse(self.store.after(self.store.last_seq() - 1)[0].data["entered_requested"])
        self.assertNotIn("entered_requested", self.store.browser_task(self.lease["id"]))

        self.browser.lease["state"] = "human"
        self.browser._changed()
        self.assertFalse(self.store.agent_item("entry")["home"])
        self.browser.lease["state"] = "requested"
        self.browser._changed()
        self.assertTrue(self.store.agent_item("entry")["home"])
        self.assertEqual(self.store.agent_item("entry")["latest_conversation"]["last_activity_seq"],
                         self.store.last_seq())

    async def test_computer_auth_live_capacity_and_host_usage(self):
        unauthorized = await self.client.get("/computer", headers={"Authorization": "wrong"})
        self.assertEqual((unauthorized.status_code, unauthorized.json()["error"]["code"]),
                         (401, "unauthorized"))
        before = time.time()
        first = (await self.client.get("/computer")).json()
        second = (await self.client.get("/computer")).json()
        self.assertEqual(first["name"], socket.gethostname())
        self.assertLessEqual(first["online_since"], before)
        self.assertGreaterEqual(second["uptime_seconds"], first["uptime_seconds"])
        self.assertEqual(first["cpu_percent"], None)
        self.assertTrue(second["cpu_percent"] is None or 0 <= second["cpu_percent"] <= 100)
        self.assertEqual(first["browser"], {
            "pages_used": 1, "pages_limit": 6, "slots_used": 1, "slots_limit": 2,
        })
        mem = first["memory"]
        self.assertGreater(mem["total_bytes"], mem["used_bytes"])
        self.assertGreaterEqual(mem["used_bytes"], 0)
        self.assertAlmostEqual(mem["percent"], mem["used_bytes"] * 100 / mem["total_bytes"])
        await self.client.delete("/browser-tasks/lease-a/pages/page-a")
        self.assertEqual((await self.client.get("/computer")).json()["browser"]["slots_used"], 0)

    async def test_computer_cpu_excludes_guest_time_already_in_user_counter(self):
        samples = iter(("cpu 100 0 0 100 0 0 0 0 50 0\n",
                        "cpu 150 0 0 150 0 0 0 0 100 0\n"))
        original_open = Path.open

        def open_stats(path, *args, **kwargs):
            if str(path) == "/proc/stat":
                return io.StringIO(next(samples))
            return original_open(path, *args, **kwargs)

        with patch.object(Path, "open", open_stats):
            await self.client.get("/computer")
            response = await self.client.get("/computer")
        self.assertEqual(response.json()["cpu_percent"], 50)

    async def test_filter_history_and_control_replay_across_store_reopen(self):
        listed = (await self.client.get("/browser-tasks?agent_id=worker")).json()
        self.assertEqual(listed["browser_tasks"][0]["root_id"], self.root)
        self.assertEqual(listed["browser_tasks"][0]["entry_agent_id"], "entry")
        self.assertEqual(listed["as_of_seq"], self.store.last_seq())
        self.assertEqual((await self.client.get("/browser-tasks?agent_id=entry")).json()["browser_tasks"], [])
        first = await self.client.post("/browser-tasks/lease-a/takeover", json={"client_id": "c1"})
        self.assertEqual((first.status_code, first.json()["browser_task"]["state"]), (200, "human"))
        self.assertEqual((first.json()["browser_task"]["conversation_title"],
                          first.json()["browser_task"]["entry_agent_name"]), ("对话", "测试"))
        again = await self.client.post("/browser-tasks/lease-a/takeover", json={"client_id": "c1"})
        self.assertTrue(again.json()["replayed"])
        self.assertEqual(self.browser.takeovers, 1)
        with self.assertRaises(ClientIdConflict):
            self.store.append(self.root, "message.user", {"text": "重复键"}, client_id="c1")
        wrong = await self.client.post("/browser-tasks/lease-a/handback", json={"client_id": "c1"})
        self.assertEqual(wrong.json()["error"]["code"], "client_id_reused")
        self.store.append(self.root, "message.user", {"text": "普通消息"}, client_id="chat-id")
        collision = await self.client.post("/browser-tasks/lease-a/handback", json={"client_id": "chat-id"})
        self.assertEqual(collision.json()["error"]["code"], "client_id_reused")
        ended = await self.client.post("/browser-tasks/lease-a/handback", json={"client_id": "c2"})
        self.assertEqual(ended.json()["browser_task"]["state"], "agent")
        events = [e for e in self.store.history(self.root) if e.type.startswith(("browser_task", "takeover"))]
        self.assertEqual([e.type for e in events], ["browser_task.updated"] * 3 + ["takeover.ended"])
        self.assertEqual({e.conversation_id for e in events}, {self.root})
        self.assertEqual(events[-1].data["duration_seconds"], 65)
        with closing(GatewayStore(self.path)) as reopened:
            self.assertEqual(reopened.browser_task("lease-a")["state"], "agent")
            self.assertEqual(reopened.replay_browser_command("c1", "lease-a", "takeover")["browser_task"]["state"], "human")

    async def test_pending_takeover_reserves_id_against_message_stop_and_creates(self):
        entered, release = asyncio.Event(), asyncio.Event()
        takeover = self.browser.takeover

        async def paused(identity):
            entered.set()
            await release.wait()
            return await takeover(identity)

        with patch.object(self.browser, "takeover", side_effect=paused):
            first = asyncio.create_task(self.gateway.browser_control("lease-a", "takeover", "shared"))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                with self.assertRaises(ClientIdConflict):
                    self.gateway.send_message(self.root, "shared", "不能抢占")
                rejected = await self.client.post(
                    f"/conversations/{self.root}/messages",
                    json={"client_id": "shared", "text": "仍在接管"},
                )
                self.assertEqual((rejected.status_code, rejected.json()["error"]["code"]),
                                 (409, "client_id_reused"))
                with self.assertRaises(ClientIdConflict):
                    await self.gateway.stop(self.root, "shared")
                with self.assertRaises(ClientIdConflict):
                    self.gateway.create_schedule("entry", "shared", {})
                with self.assertRaises(ClientIdConflict):
                    await self.gateway.create_connector("shared", {})
                with patch.object(self.gateway.subscription, "models", new_callable=AsyncMock) as models:
                    with self.assertRaises(ClientIdConflict):
                        await self.gateway.create_agent("shared", {"model": "offline"})
                    models.assert_not_awaited()
                with self.assertRaises(ClientIdConflict):
                    await self.gateway.browser_control("lease-a", "handback", "shared")
                with self.assertRaises(ClientIdConflict):
                    await self.gateway.browser_control("other-lease", "takeover", "shared")
                self.assertFalse(any(e.client_id == "shared" for e in self.store.history(self.root)))
            finally:
                release.set()
                await first
        self.assertEqual(self.browser.takeovers, 1)
        with self.assertRaises(ClientIdConflict):
            self.gateway.send_message(self.root, "shared", "完成后不能复用")

    async def test_pending_browser_retry_survives_cancelled_waiter_and_replays_once(self):
        entered, release = asyncio.Event(), asyncio.Event()
        takeover = self.browser.takeover

        async def paused(identity):
            entered.set()
            await release.wait()
            return await takeover(identity)

        with patch.object(self.browser, "takeover", side_effect=paused):
            first = asyncio.create_task(self.gateway.browser_control("lease-a", "takeover", "retry"))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                retry = asyncio.create_task(self.gateway.browser_control("lease-a", "takeover", "retry"))
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                self.assertFalse(retry.done())
            finally:
                release.set()
            response = await retry
        self.assertEqual(response["browser_task"]["state"], "human")
        self.assertTrue(response["replayed"])
        self.assertTrue((await self.gateway.browser_control("lease-a", "takeover", "retry"))["replayed"])
        self.assertEqual(self.browser.takeovers, 1)

    async def test_shutdown_drains_browser_command_after_cancelled_http_request(self):
        entered, release = asyncio.Event(), asyncio.Event()
        takeover = self.browser.takeover

        async def paused(identity):
            entered.set()
            await release.wait()
            return await takeover(identity)

        with patch.object(self.browser, "takeover", side_effect=paused):
            request = asyncio.create_task(self.client.post(
                "/browser-tasks/lease-a/takeover", json={"client_id": "shutdown-id"},
            ))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                request.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await request
                await self.gateway.stop_schedules()
                draining = asyncio.create_task(self.gateway.drain_deletions())
                await asyncio.sleep(0)
                self.assertFalse(draining.done())
            finally:
                release.set()
            await asyncio.wait_for(draining, 2)
        self.assertEqual(self.store.replay_browser_command(
            "shutdown-id", "lease-a", "takeover",
        )["browser_task"]["state"], "human")
        self.assertEqual(self.browser.takeovers, 1)
        with self.assertRaises(RuntimeError):
            await self.gateway.browser_control("lease-a", "handback", "new-after-shutdown")

    async def test_browser_control_after_body_read_started_during_shutdown_is_unavailable(self):
        body_started, release_body = asyncio.Event(), asyncio.Event()

        async def body():
            yield b'{"client_id":'
            body_started.set()
            await release_body.wait()
            yield b'"late-control"}'

        request = asyncio.create_task(self.client.post(
            "/browser-tasks/lease-a/takeover",
            content=body(), headers={"Content-Type": "application/json"},
        ))
        try:
            await asyncio.wait_for(body_started.wait(), 2)
            await self.gateway.stop_schedules()
        finally:
            release_body.set()
        response = await asyncio.wait_for(request, 2)
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "unavailable"))
        self.assertEqual(self.browser.takeovers, 0)
        self.assertIsNone(self.store.replay_browser_command("late-control", "lease-a", "takeover"))
        handback = await self.client.post(
            "/browser-tasks/lease-a/handback", json={"client_id": "late-handback"},
        )
        self.assertEqual((handback.status_code, handback.json()["error"]["code"]), (503, "unavailable"))
        self.assertEqual((await self.client.get("/browser-tasks/lease-a")).status_code, 200)

    async def test_failed_browser_command_releases_id_for_message(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def fail(identity):
            entered.set()
            await release.wait()
            raise BrowserRejected("接管失败")

        with patch.object(self.browser, "takeover", side_effect=fail):
            first = asyncio.create_task(self.gateway.browser_control("lease-a", "takeover", "failed"))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                with self.assertRaises(ClientIdConflict):
                    self.gateway.send_message(self.root, "failed", "等待失败")
            finally:
                release.set()
            with self.assertRaises(BrowserRejected):
                await first
        event, created = self.gateway.send_message(self.root, "failed", "失败后可发送")
        self.assertTrue(created)
        self.assertEqual(event.data["text"], "失败后可发送")

    async def test_pending_stop_and_persisted_creates_prevent_browser_claiming_id(self):
        stop_entered, stop_release = asyncio.Event(), asyncio.Event()

        async def paused_cancel(identity):
            stop_entered.set()
            await stop_release.wait()
            return {}

        with patch.object(self.manager, "cancel", side_effect=paused_cancel):
            stopping = asyncio.create_task(self.gateway.stop(self.root, "stop-id"))
            try:
                await asyncio.wait_for(stop_entered.wait(), 2)
                with self.assertRaises(ClientIdConflict):
                    await self.gateway.browser_control("lease-a", "takeover", "stop-id")
            finally:
                stop_release.set()
                await stopping
        with self.assertRaises(ClientIdConflict):
            await self.gateway.browser_control("lease-a", "takeover", "stop-id")

        self.store.append(self.root, "message.user", {"text": "已有消息"}, client_id="message-id")
        with self.assertRaises(ClientIdConflict):
            await self.gateway.browser_control("lease-a", "takeover", "message-id")
        detail, _, created = self.gateway.create_schedule("entry", "schedule-id", {
            "name": "日报", "content": "独立说明", "timezone": "Etc/UTC",
            "rule": {"kind": "daily", "time": "00:00"},
        })
        self.assertTrue(created)
        self.assertEqual(detail["name"], "日报")
        with self.assertRaises(ClientIdConflict):
            await self.gateway.browser_control("lease-a", "takeover", "schedule-id")

    async def test_auth_thumbnail_only_on_request_and_page_close(self):
        self.assertEqual((await self.client.get("/browser-tasks", headers={"Authorization": "wrong"})).status_code, 401)
        self.assertEqual(self.browser.page_calls, [])
        jpeg = await self.client.get("/browser-tasks/lease-a/thumbnail")
        self.assertEqual((jpeg.status_code, jpeg.headers["content-type"], jpeg.content),
                         (200, "image/jpeg", b"\xff\xd8jpeg\xff\xd9"))
        foreign = await self.client.get("/browser-tasks/lease-a/thumbnail?page=foreign")
        self.assertEqual((foreign.status_code, foreign.json()["error"]["code"]), (409, "rejected"))
        self.assertEqual((await self.client.delete("/browser-tasks/lease-a/pages/foreign")).status_code, 409)
        closed = await self.client.delete("/browser-tasks/lease-a/pages/page-a")
        self.assertEqual(closed.json()["browser_task"]["reason"], "用户关闭")
        self.assertEqual((await self.client.get("/browser-tasks/lease-a")).json()["state"], "released")
        repeated = await self.client.delete("/browser-tasks/lease-a")
        self.assertEqual(repeated.json()["browser_task"]["reason"], "用户关闭")
        self.assertEqual((await self.client.get("/browser-tasks/lease-a/thumbnail")).status_code, 409)
        self.assertEqual((await self.client.post("/browser-tasks/lease-a/takeover", json={"client_id": "c3"})).status_code, 409)
        self.assertEqual((await self.client.get("/browser-tasks/missing")).status_code, 404)
        self.assertEqual((await self.client.get("/browser-tasks?agent_id=unknown")).status_code, 404)

    async def test_request_takeover_persists_reason_in_list_and_event_stream(self):
        cursor = self.store.last_seq()
        self.browser.lease.update(state="requested", requested_reason="需要登录")
        self.browser._changed()
        task = (await self.client.get("/browser-tasks/lease-a")).json()
        self.assertEqual((task["state"], task["requested_reason"]), ("requested", "需要登录"))
        event, = self.store.after(cursor)
        self.assertEqual((event.type, event.conversation_id, event.data["state"]),
                         ("browser_task.updated", self.root, "requested"))

    async def test_delete_closes_held_child_lease_and_removes_its_history(self):
        event = await self.gateway.delete_conversation(self.root)
        self.assertEqual(event.type, "conversation.deleted")
        self.assertEqual(self.browser.closed_tasks, [("task-lease-a", "对话删除")])
        self.assertIsNone(self.store.browser_task("lease-a"))
        self.assertEqual((await self.client.get("/browser-tasks/lease-a")).status_code, 404)
        self.assertEqual([e.type for e in self.store.after(0) if e.conversation_id == self.root], [])

    async def test_persistence_failure_is_fatal_not_silently_dropped(self):
        with patch.object(self.store, "record_browser_task", side_effect=sqlite3.OperationalError("disk full")):
            with self.assertRaises(GatewayFailure):
                self.browser.lease["state"] = "requested"
                self.browser._changed()
        self.assertEqual((await self.client.get("/browser-tasks")).status_code, 503)

    async def test_schema_13_and_restart_invalidates_only_active(self):
        self.assertEqual(self.store._connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
        released = snapshot(self.root, identity="already-ended", state="released")
        released.update(reason="用户关闭", pages=[], current=None)
        self.store.record_browser_task(released)
        old_seq = self.store.last_seq()
        self.assertEqual(self.store.invalidate_browser_tasks(), 1)
        stale = self.store.browser_task("lease-a")
        self.assertEqual((stale["state"], stale["reason"], stale["epoch"], stale["pages"]),
                         ("released", "网关重启，浏览器任务已结束", 2, []))
        self.assertEqual(self.store.browser_task("already-ended")["reason"], "用户关闭")
        self.assertEqual([e.type for e in self.store.after(old_seq)], ["browser_task.updated"])
        active = snapshot(self.root, identity="another-active")
        self.store.record_browser_task(active)
        old_seq = self.store.last_seq()
        with patch.object(self.store, "_insert", side_effect=sqlite3.OperationalError("disk full")):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.invalidate_browser_tasks()
        self.assertEqual(self.store.browser_task("another-active")["state"], "agent")
        self.assertEqual(self.store.last_seq(), old_seq)
        self.assertEqual(self.store.invalidate_browser_tasks(), 1)
        self.assertEqual(self.store.invalidate_browser_tasks(), 0)


if __name__ == "__main__":
    unittest.main()
