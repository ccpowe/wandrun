"""ADR-0043: task identity survives turns; gateway histories never become model input."""

import asyncio
import json
import sqlite3
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from langgraph.checkpoint.memory import InMemorySaver

from test_gateway import gateway_manager, open_store, temp_dir
from test_ui_submissions import FORM, ui
from wandrun.gateway.http import create_app
from wandrun.gateway.service import CollaborationUnavailable, Gateway, UnknownConversation
from wandrun.gateway.store import ClientIdConflict, GatewayStore
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.runtime.files import ResolvedAttachment, TaskFiles
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.scheduler_store import SchedulerStore
from wandrun.runtime.workers import CollaborationStopped, CommunicationMiddleware, SchedulerFailure, WorkerManager


class CollaborationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = temp_dir(self)
        self.store = open_store(self, self.directory / "gateway.sqlite")
        self.gateway = Gateway(self.store)
        self.addCleanup(self.gateway.end_streams)
        self.inputs = {}
        self.started = asyncio.Queue()

        async def run(prompts, task_id):
            self.inputs.setdefault(task_id, []).append(prompts)
            await self.started.put(task_id)
            await asyncio.Event().wait()

        self.manager = gateway_manager(
            self.gateway, run, attachment_resolver=lambda *args: self.files.resolve_attachments(*args),
            attachment_preflight=lambda *args: self.files.prepare_attachments(*args),
        )
        self.files = TaskFiles(
            self.directory, self.manager,
            {role: ("local", str(self.directory)) for role in ("c", "a", "b", "d")},
            conversation_workdirs=False,
        )
        self.gateway.workspace_root = self.directory
        self.addAsyncCleanup(self.manager.close)
        self.gateway.checkpointer = InMemorySaver()
        self.root = self.gateway.create_conversation("根", "c")["id"]
        self.gateway.send_message(self.root, "root-message", "开始")
        self.child = self.delegate(self.root, "a", "查找第一项\n第二行")
        await asyncio.sleep(0)

    def delegate(self, sender, agent, text):
        receipts = self.manager.dispatch(AgentOutput(messages=[
            SendMessage(to=agent, task_id=None, message=text),
        ], next="wait"), sender)
        self.assertTrue(receipts[0]["accepted"])
        return receipts[0]["task_id"]

    def send(self, sender, recipient, agent, text):
        return self.manager.dispatch(AgentOutput(messages=[
            SendMessage(to=agent, task_id=recipient, message=text),
        ], next="done"), sender)[0]

    async def test_creation_delivery_status_and_nested_timelines(self):
        grandchild = self.delegate(self.child, "b", "嵌套检索")
        self.assertTrue(self.send(grandchild, self.child, "a", "嵌套结果")["accepted"])
        self.assertTrue(self.send(self.child, self.root, "c", "交给上级")["accepted"])
        detail = self.store.task_conversation(grandchild)
        self.assertEqual((detail["root_id"], detail["creator_task_id"], detail["creator_agent_id"], detail["agent_id"]),
                         (self.root, self.child, "a", "b"))
        child_events = self.store.task_history(self.child)
        nested = next(e for e in child_events if e.type == "task.created" and e.data["task_id"] == grandchild)
        self.assertEqual(nested.data["timeline_ids"], [self.child, grandchild])
        self.assertEqual([e.data["text"] for e in child_events if e.type == "message.task"],
                         ["查找第一项\n第二行", "嵌套检索", "嵌套结果", "交给上级"])
        root_events = self.store.history(self.root)
        self.assertFalse(any(e.type == "message.task" for e in root_events))
        self.assertNotIn(nested.seq, [e.seq for e in root_events])
        await self.gateway.stop(grandchild, "stop-nested", task=True)
        status = [e for e in self.store.task_history(grandchild) if e.type == "task.status"][-1]
        self.assertEqual(status.data["status"], "cancelled")
        self.assertIn(status.seq, [e.seq for e in self.store.task_history(self.child)])
        self.assertEqual(self.store.task_conversation(grandchild)["status"], self.manager.get(grandchild)["status"])
        self.assertEqual(self.store.task_conversation(self.child)["title"], "查找第一项 第二行")

    async def test_task_failure_exposes_only_gateway_reason_in_detail_and_events(self):
        raw = "APIConnectionError: private service endpoint"
        self.gateway.on_task(self.child, "failed", raw)
        detail = self.store.task_conversation(self.child)
        self.assertEqual(detail["status"], "failed")
        self.assertIn("网络", detail["error"])
        events = self.store.task_history(self.child)
        failure = next(event for event in reversed(events) if event.type == "task.status")
        self.assertIn("网络", failure.data["error"])
        self.assertNotIn("private service endpoint", str(detail))
        self.assertNotIn("private service endpoint", str([event.to_dict() for event in events]))

    async def test_received_and_created_lists_sort_and_keep_independent_read_positions(self):
        with patch("wandrun.gateway.store.time.time", return_value=2000000000):
            direct = self.gateway.create_conversation("直接", "a")["id"]
        with patch("wandrun.gateway.store.time.time", return_value=2000000010):
            newer = self.delegate(self.root, "a", "较新委派")
        received = self.store.received_conversations("a")
        self.assertEqual([item["id"] for item in received], [newer, direct, self.child])
        self.assertEqual([item["initiator"] for item in received], ["c", "human", "c"])
        created = self.store.task_conversations(creator_agent_id="c")
        self.assertEqual([item["id"] for item in created], [newer, self.child])
        self.assertEqual([item["recipient"] for item in created], ["a", "a"])
        self.assertTrue(self.store.task_conversation(self.child)["unread"])
        before = self.store.task_conversation(self.child)["updated_at"]
        self.gateway.mark_task_read(self.child, self.store.last_seq())
        self.assertFalse(self.store.task_conversation(self.child)["unread"])
        self.assertEqual(self.store.task_conversation(self.child)["updated_at"], before)
        self.assertTrue(self.store.task_conversation(newer)["unread"])
        self.store.set_task_status(self.child, "failed", "test failure")
        self.assertTrue(self.store.task_conversation(self.child)["unread"])
        self.assertFalse(self.store.conversation(self.root)["unread"])

    async def test_branch_activity_covers_settled_ancestors_and_uncached_deep_descendants(self):
        self.manager.replace_agent_workers(
            {"main": (), "c": ("a", "d"), "a": ("b",), "b": ("d",), "d": ("b",)}, "main",
        )
        middle = self.delegate(self.child, "b", "中间任务")
        deep = self.delegate(middle, "d", "深层执行")
        unrelated = self.delegate(self.root, "a", "旁支执行")
        self.store.set_task_status(self.child, "completed")
        self.store.set_task_status(middle, "completed")
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, token="test")),
            base_url="http://gateway", headers={"Authorization": "Bearer test"},
        )
        self.addAsyncCleanup(client.aclose)
        detail = (await client.get(f"/tasks/{self.child}")).json()
        self.assertEqual(detail["status"], "completed")
        self.assertTrue(detail.get("branch_working"), "completed parent must still offer cascading Stop")
        for path in ("/agents/a/conversations", "/agents/c/collaborations"):
            rows = (await client.get(path)).json()["conversations"]
            self.assertTrue(next(row for row in rows if row["id"] == self.child)["branch_working"])
        waiting = self.store.set_task_status(deep, "waiting")
        self.assertTrue(waiting.data["branch_activity"][self.child])
        settled = self.store.set_task_status(deep, "completed")
        self.assertEqual(settled.data["branch_activity"], {self.child: False, middle: False, deep: False})
        self.assertEqual(settled.data["timeline_ids"], [middle, deep], "branch updates do not widen message/unread routing")
        self.assertFalse(self.store.task_conversation(self.child)["branch_working"])
        self.assertTrue(self.store.task_conversation(unrelated)["branch_working"])
        resumed = self.store.set_task_status(deep, "running")
        self.assertTrue(resumed.data["branch_activity"][self.child])
        newly_created = self.delegate(deep, "b", "新后代")
        created = next(e for e in self.store.task_history(deep)
                       if e.type == "task.created" and e.data["task_id"] == newly_created)
        self.assertTrue(created.data["branch_activity"][self.child])

    async def test_interjection_interrupts_only_target_notifies_creator_and_replays_once(self):
        grandchild = self.delegate(self.child, "b", "继续工作")
        old_child = self.manager._tasks[self.child]
        old_root = self.manager._tasks[self.root]
        old_grandchild = self.manager._tasks[grandchild]
        event, created = self.gateway.send_task_message(self.child, "interject", "改为蓝色")
        self.assertTrue(created)
        self.assertEqual(event.data["timeline_ids"], [self.child])
        replay, created = self.gateway.send_task_message(self.child, "interject", "不会重复发送")
        self.assertFalse(created)
        self.assertEqual(replay.seq, event.seq)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertTrue(old_child.cancelled())
        self.assertIs(self.manager._tasks[self.root], old_root)
        self.assertIs(self.manager._tasks[grandchild], old_grandchild)
        self.assertIn("改为蓝色", [message.content for message in self.inputs[self.child][-1]])
        notices = [json.loads(message.content.split("\n", 1)[1]) for message in self.manager.take_messages(self.root)
                   if "user_interjection" in message.content]
        self.assertEqual(len(notices), 1)
        self.assertEqual(notices[0]["message"], "用户直接对 a 说：改为蓝色")
        self.assertFalse(any(e.type == "message.user" and e.data.get("text") == "改为蓝色"
                             for e in self.store.history(self.root)))
        with self.assertRaises(ClientIdConflict):
            self.gateway.send_task_message(grandchild, "interject", "其他任务")

    async def test_stopping_task_cascades_and_user_can_resume_after_cleanup(self):
        grandchild = self.delegate(self.child, "b", "孙任务")
        await asyncio.sleep(0)
        event, created = await self.gateway.stop(self.child, "single-stop", task=True)
        self.assertTrue(created)
        self.assertTrue(event.data["was_working"])
        self.assertEqual(self.manager.get(self.child)["status"], "cancelled")
        self.assertEqual(self.manager.get(grandchild)["status"], "cancelled")
        self.assertEqual((await self.gateway.stop(self.child, "single-stop", task=True))[0], event)
        self.gateway.send_task_message(self.child, "resume", "继续原任务")
        await asyncio.sleep(0)
        self.assertEqual(self.manager.get(self.child)["status"], "running")
        self.assertEqual(self.store.task_conversation(self.child)["status"], "running")
        self.assertTrue(self.manager.is_stopped(grandchild))
        with self.assertRaises(asyncio.CancelledError):
            self.send(grandchild, self.child, "a", "已停止的后代不能回报")

    async def test_human_delivery_and_frozen_draft_belong_to_child_not_home(self):
        self.store.hide_agent("c")
        self.store.hide_agent("a")
        scope = self.manager._previews[self.manager._tasks[self.child]]
        draft_id = scope.update(scope.begin(), 0, 0, "未完成的消息", "final_answer")
        self.gateway._flush_drafts()
        draft = self.gateway._draft_snapshot()["data"]["drafts"][0]
        self.assertEqual((draft["conversation_id"], draft["task_id"]), (self.root, self.child))
        self.gateway.send_task_message(self.child, "freeze", "打断")
        frozen = next(e for e in self.store.task_history(self.child) if e.type == "message.agent")
        self.assertEqual((frozen.data["draft_id"], frozen.data["status"]), (draft_id, "interrupted"))
        self.gateway.on_human(self.child, "第一行\n第二行", [])
        messages = [e for e in self.store.task_history(self.child) if e.type == "message.agent"]
        self.assertEqual(messages[-1].data["text"], "第一行\n第二行")
        root = self.store.history(self.root)
        self.assertFalse(any(e.type == "message.agent" for e in root))
        preview = [e for e in root if e.type == "message.task_preview"][-1]
        self.assertEqual((preview.data["agent_id"], preview.data["task_id"], preview.data["text"]),
                         ("a", self.child, "第一行"))
        self.assertEqual(preview.data["message_seq"], messages[-1].seq)
        self.assertFalse(self.store.conversation(self.root)["unread"])
        self.assertFalse(self.store.agent_item("c")["home"])
        self.assertFalse(self.store.agent_item("a")["home"])
        result = self.store.search("第一行", "a", 10, 0)["results"][0]
        self.assertEqual((result["task_id"], result["seq"]), (self.child, messages[-1].seq))

    async def test_member_form_submission_targets_member_and_notifies_creator(self):
        self.gateway.on_human(self.child, ui(FORM), [])
        source = next(e for e in self.store.task_history(self.child) if e.type == "message.agent")
        old_root = self.manager._tasks[self.root]
        old_child = self.manager._tasks[self.child]
        event, created = self.gateway.submit_ui(
            self.root, "member-form", source.seq, 0, {"plan": "B", "note": "按期完成"},
        )
        self.assertTrue(created)
        self.assertEqual(event.data["task_id"], self.child)
        self.assertEqual(event.data["ui_submission"]["message_seq"], source.seq)
        self.assertTrue(old_child.cancelling())
        self.assertFalse(old_root.cancelling())
        self.assertTrue(any("user_interjection" in message.content for message in self.manager.take_messages(self.root)))
        self.assertEqual(self.gateway.submit_ui(
            self.root, "member-form", source.seq, 0, {"plan": "B", "note": "按期完成"},
        ), (event, False))
        with self.assertRaises(ClientIdConflict):
            self.gateway.send_message(self.root, "member-form", "不能混用")

    async def test_collaboration_events_replay_in_global_stream(self):
        stream = self.gateway.stream(0)
        try:
            self.assertEqual((await anext(stream))[0], "transient")
            durable = []
            last = self.store.last_seq()
            while not durable or durable[-1]["seq"] < last:
                kind, event = await asyncio.wait_for(anext(stream), 2)
                self.assertEqual(kind, "event")
                durable.append(event)
            messages = [event for event in durable if event["type"] == "message.task"]
            self.assertEqual([event["data"]["text"] for event in messages], ["查找第一项\n第二行"])
            self.assertEqual(messages[0]["conversation_id"], self.root)
            self.assertEqual(messages[0]["data"]["task_id"], self.child)
        finally:
            await stream.aclose()

    async def test_http_auth_pagination_lists_read_and_send(self):
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(self.gateway, token="test")), base_url="http://gateway")
        self.addAsyncCleanup(client.aclose)
        self.assertEqual((await client.get(f"/tasks/{self.child}")).status_code, 401)
        client.headers["Authorization"] = "Bearer test"
        received = (await client.get("/agents/a/conversations")).json()
        self.assertEqual(received["conversations"][0]["id"], self.child)
        sent = (await client.get("/agents/c/collaborations")).json()
        self.assertEqual(sent["conversations"][0]["recipient"], "a")
        page = (await client.get(f"/tasks/{self.child}/events?limit=1")).json()
        self.assertEqual(page["events"][0]["type"], "message.task")
        older = (await client.get(f"/tasks/{self.child}/events?before={page['events'][0]['seq']}")).json()
        self.assertEqual(older["events"][0]["type"], "task.created")
        self.assertEqual((await client.post(f"/tasks/{self.child}/read", json={"seq": page["as_of_seq"]})).status_code, 204)
        self.assertEqual((await client.post(f"/tasks/{self.child}/messages", json={"text": "纠正", "client_id": "http-send"})).status_code, 202)
        self.assertEqual((await client.post(f"/tasks/{self.child}/messages", json={"text": "纠正", "client_id": "http-send"})).status_code, 200)
        self.assertEqual((await client.post(f"/tasks/{self.child}/read", json={"seq": 99999999})).status_code, 400)
        self.assertEqual((await client.get("/tasks/unknown/events")).status_code, 404)
        self.assertEqual((await client.delete(f"/tasks/{self.child}")).status_code, 405)
        self.assertEqual((await client.patch(f"/tasks/{self.child}", json={"title": "不能改"})).status_code, 405)
        self.assertEqual((await client.post(f"/tasks/{self.child}/stop", json={"client_id": "http-stop"})).status_code, 202)

    async def test_deletion_cascades_nested_records_history_and_search(self):
        grandchild = self.delegate(self.child, "b", "嵌套")
        self.gateway.on_human(grandchild, "删除的消息", [])
        await self.gateway.delete_conversation(self.root)
        self.assertEqual(self.store.task_conversations(), [])
        self.assertEqual(self.store.history(self.root), [])
        self.assertEqual(self.store.search("删除的消息", None, 10, 0)["results"], [])
        self.assertFalse(self.manager.has_task(self.child))
        with self.assertRaises(UnknownConversation):
            self.gateway.send_task_message(self.child, "after-delete", "不能复活")

    async def test_agent_attachment_download_provenance_search_and_root_deletion(self):
        nested = self.delegate(self.child, "b", "产出文件")
        path = self.directory / "collaboration-report.txt"
        path.write_bytes(b"accepted result")
        output = AgentOutput(messages=[SendMessage(
            to="a", task_id=self.child, message="结果附件", attachments=[str(path), "/missing.txt"],
        )], next="done")
        receipt = self.manager.dispatch(output, nested)[0]
        self.assertTrue(receipt["accepted"])
        self.assertEqual([item["accepted"] for item in receipt["attachments"]], [True, False])
        history = self.store.task_history(nested)
        message = next(e for e in history if e.type == "message.task" and e.data["text"] == "结果附件")
        record, = message.data["attachments"]
        self.assertEqual((record["task_id"], record["agent_id"], record["conversation_id"]),
                         (nested, "b", self.root))
        produced = next(e for e in history if e.type == "file.produced")
        self.assertEqual(produced.data["file"], record)
        self.assertEqual(produced.data["message_id"], str(message.seq))
        self.assertIn(produced.seq, [e.seq for e in self.store.task_history(self.child)])
        self.assertNotIn(produced.seq, [e.seq for e in self.store.history(self.root)])
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, token="test")),
            base_url="http://gateway", headers={"Authorization": "Bearer test"},
        )
        self.addAsyncCleanup(client.aclose)
        url = f"/files/{record['id']}/content"
        response = await client.get(url)
        self.assertEqual((response.status_code, response.content), (200, b"accepted result"))
        search = self.store.search(path.name, "b", 10, 0)["results"]
        self.assertEqual([item["file"] for item in search], [record])
        self.assertEqual(self.store.search(path.name, "c", 10, 0)["results"], [])
        await self.gateway.delete_conversation(self.root)
        self.assertEqual(self.store.task_conversations(), [])
        self.assertEqual(self.store.history(self.root), [])
        # 与 human 交付相同：删除来源只断开关联，原文件和独立文件记录仍可访问。
        self.assertIsNone(self.store.file(record["id"])[0]["conversation_id"])
        self.assertEqual((await client.get(url)).content, b"accepted result")
        path.unlink()
        self.assertEqual((await client.get(url)).status_code, 410)

    async def test_same_ssh_attachment_retains_origin_and_explicitly_rejects_host_download(self):
        remote = temp_dir(self)
        backend = ManagedShellBackend(root_dir=remote, virtual_mode=False)
        self.addCleanup(backend.close)
        self.files.update_environments(
            {"c": ("local", str(self.directory)), "a": ("shared-ssh", str(remote)),
             "b": ("shared-ssh", str(remote))},
            {"a": backend, "b": backend},
        )
        nested = self.delegate(self.child, "b", "远端文件")
        path = remote / "ssh-report.txt"
        path.write_bytes(b"remote result")
        output = AgentOutput(messages=[SendMessage(
            to="a", task_id=self.child, message="同环境附件", attachments=[str(path)],
        )], next="done")
        # 运行真正的远端预检协议，但执行器是隔离本机 shell；不依赖 SSH 服务。
        prepared = await self.manager.prepare_attachments(output, nested)
        receipt = self.manager.dispatch(output, nested, prepared=prepared)[0]
        self.assertTrue(receipt["accepted"])
        self.assertTrue(receipt["attachments"][0]["accepted"])
        events = self.store.task_history(nested)
        message = next(e for e in events if e.type == "message.task" and e.data["text"] == "同环境附件")
        record, = message.data["attachments"]
        self.assertEqual((record["remote_environment"], record["agent_id"], record["task_id"]),
                         ("shared-ssh", "b", nested))
        produced = next(e for e in events if e.type == "file.produced")
        self.assertEqual(produced.data["file"], record)
        self.assertEqual(self.store.search(path.name, "b", 10, 0)["results"][0]["file"], record)

        # SSH → human 仍只投递文字，附件跨环境拒绝，不借这次修复引入远端复制。
        human = AgentOutput(messages=[SendMessage(
            to="human", task_id=None, message="远端结果", attachments=[str(path)],
        )], next="done")
        prepared = await self.manager.prepare_attachments(human, nested)
        receipt = self.manager.dispatch(human, nested, prepared=prepared)[0]
        self.assertTrue(receipt["accepted"])
        self.assertFalse(receipt["attachments"][0]["accepted"])
        self.assertEqual(len([e for e in self.store.task_history(nested) if e.type == "file.produced"]), 1)

        # 重新打开登记库，不依赖当前 Agent 配置、Manager 或活动 SSH 连接来判定文件来源。
        reopened = GatewayStore(self.directory / "gateway.sqlite")
        self.addCleanup(reopened.close)
        gateway = Gateway(reopened)
        self.addCleanup(gateway.end_streams)
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(gateway, token="test")),
            base_url="http://gateway", headers={"Authorization": "Bearer test"},
        )
        self.addAsyncCleanup(client.aclose)
        for host_root in (self.directory, remote):
            with self.subTest(host_path_also_valid=host_root == remote):
                # 第二种情况连同名本机路径都合法，仍绝不能误读成本机文件。
                gateway.workspace_root = host_root
                metadata = (await client.get(f"/files/{record['id']}")).json()
                self.assertEqual(metadata["remote_environment"], "shared-ssh")
                self.assertFalse(metadata["available"])
                self.assertEqual(metadata["error"], "remote_file_unsupported")
                response = await client.get(f"/files/{record['id']}/content", headers={"Range": "bytes=0-3"})
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["error"], {
                    "code": metadata["error"], "message": metadata["error_message"],
                })
                self.assertEqual((await client.head(f"/files/{record['id']}/content")).status_code, 409)

    async def test_task_message_and_files_roll_back_together(self):
        self.store._connection.execute("""
            CREATE TRIGGER reject_task_message BEFORE INSERT ON events
            WHEN NEW.type = 'message.task' BEGIN SELECT RAISE(FAIL, 'blocked'); END
        """)
        before = self.store.last_seq()
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.append_task_message(self.child, {
                "sender_task_id": self.child, "sender_agent_id": "a",
                "recipient_task_id": self.root, "recipient_agent_id": "c", "text": "未提交",
            }, [ResolvedAttachment(str(self.directory / "report.txt"), "report.txt", 1, "text/plain")],
                timeline_ids=[self.child])
        self.assertEqual(self.store.last_seq(), before)
        self.assertEqual(self.store.search("report.txt", None, 10, 0)["results"], [])


class CollaborationResumeTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_child_continues_same_identity_and_result_wakes_creator(self):
        directory = temp_dir(self)
        store = open_store(self, directory / "gateway.sqlite")
        gateway = Gateway(store)
        self.addCleanup(gateway.end_streams)
        root_inputs = []
        child_inputs = []
        root = gateway.create_conversation("完成后续聊", "c")["id"]

        async def run(prompts, task_id):
            if task_id == root:
                root_inputs.extend(prompts)
                return AgentOutput(messages=[], next="done")
            child_inputs.extend(prompts)
            manager.dispatch(AgentOutput(messages=[SendMessage(to="c", task_id=root, message="新结果为蓝色")], next="done"), task_id)
            return AgentOutput(messages=[], next="done")

        manager = gateway_manager(gateway, run)
        self.addAsyncCleanup(manager.close)
        manager.start("原要求", root, agent_name="c")
        child = manager.start("第一次", sender_id=root, agent_name="a")["task_id"]
        await manager.wait(child)
        await manager.wait(root)
        self.assertEqual(manager.get(child)["status"], "completed")
        root_inputs.clear()
        gateway.send_task_message(child, "continue-ended", "改为蓝色")
        await manager.wait(child)
        await manager.wait(root)
        self.assertIn("改为蓝色", [m.content for m in child_inputs])
        self.assertTrue(any("user_interjection" in m.content for m in root_inputs))
        self.assertTrue(any("新结果为蓝色" in m.content for m in root_inputs))
        self.assertEqual([item["task_id"] for item in store.task_conversations()], [child])
        statuses = [e.data["status"] for e in store.task_history(child) if e.type == "task.status"]
        self.assertEqual(statuses, ["completed", "running", "completed"])

    async def test_restart_reconciles_scheduler_and_gateway_without_replaying_messages(self):
        directory = temp_dir(self)
        store = open_store(self, directory / "gateway.sqlite")
        scheduler = SchedulerStore(directory / "scheduler.sqlite")
        self.addCleanup(scheduler.close)
        gateway = Gateway(store)
        self.addCleanup(gateway.end_streams)

        async def run(prompts, task_id):
            await asyncio.Event().wait()

        manager = gateway_manager(gateway, run, store=scheduler)
        root = gateway.create_conversation("恢复", "c")["id"]
        manager.start("根", root, agent_name="c")
        child = manager.start("成员", sender_id=root, agent_name="a")["task_id"]
        nested = manager.start("孙任务", sender_id=child, agent_name="b")["task_id"]
        await manager.close()
        reopened = GatewayStore(directory / "gateway.sqlite")
        self.addCleanup(reopened.close)
        recovered = Gateway(reopened)
        self.addCleanup(recovered.end_streams)
        replacement = gateway_manager(recovered, run, store=scheduler)
        self.addAsyncCleanup(replacement.close)
        for task in (child, nested):
            self.assertEqual(reopened.task_conversation(task)["status"], "cancelled")
            self.assertEqual(replacement.get(task)["status"], "cancelled")
        self.assertEqual([e.data["text"] for e in reopened.task_history(nested) if e.type == "message.task"], ["孙任务"])
        recovered.send_task_message(child, "restart-input", "只恢复成员")
        self.assertEqual(replacement.get(child)["status"], "running")
        self.assertEqual(replacement.get(nested)["status"], "cancelled")
        self.assertEqual(reopened.task_conversation(child)["creator_task_id"], root)


class CollaborationRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = temp_dir(self)
        self.store = open_store(self, self.directory / "gateway.sqlite")
        self.scheduler = SchedulerStore(self.directory / "scheduler.sqlite")
        self.addCleanup(lambda: self.scheduler.close())
        self.gateway = Gateway(self.store)
        self.addCleanup(self.gateway.end_streams)
        self.root = self.gateway.create_conversation("恢复链", "c")["id"]
        self.inputs = {}
        self.root_next = "wait"
        self.root_gate = None
        self.forward = {}
        self.manager = gateway_manager(self.gateway, self.run_agent, store=self.scheduler)
        self.addAsyncCleanup(self.close_manager)
        self.manager.start("开始", self.root, agent_name="c")
        await self.manager.wait(self.root)
        self.child = self.manager.start("成员任务", sender_id=self.root, agent_name="a")["task_id"]
        await self.manager.wait(self.child)

    async def close_manager(self):
        await self.manager.close()

    async def run_agent(self, prompts, task_id):
        self.inputs.setdefault(task_id, []).append(prompts)
        if task_id == self.root:
            if self.root_gate is not None:
                await self.root_gate.wait()
                self.model_update = await CommunicationMiddleware(self.manager).abefore_model(
                    {}, SimpleNamespace(context={"task_id": task_id}),
                )
            return AgentOutput(messages=[], next=self.root_next)
        if task_id in self.forward:
            agent, parent = self.forward[task_id]
            receipt = self.manager.dispatch(AgentOutput(messages=[
                SendMessage(to=agent, task_id=parent, message="最终结果"),
            ], next="done"), task_id)[0]
            self.assertTrue(receipt["accepted"])
        return AgentOutput(messages=[], next="done")

    def reopen(self):
        """调用方已等待旧 Manager 关闭；真正重开 SQLite，验证屏障原因与反馈的磁盘状态。"""
        self.scheduler.close()
        self.scheduler = SchedulerStore(self.directory / "scheduler.sqlite")
        self.gateway = Gateway(self.store)
        self.addCleanup(self.gateway.end_streams)
        self.manager = gateway_manager(self.gateway, self.run_agent, store=self.scheduler)

    def interjections(self, messages):
        return [json.loads(m.content.split("\n", 1)[1])["message"]
                for m in messages if "user_interjection" in m.content]

    async def test_multiple_interjections_persist_without_waking_idle_or_waiting_creator(self):
        for state in ("done", "wait"):
            with self.subTest(state=state):
                self.root_next = state
                self.manager.interrupt("准备接收", self.root)
                await self.manager.wait(self.root)
                self.inputs[self.root].clear()
                for index, text in enumerate(("先改颜色", "再改尺寸")):
                    self.gateway.send_task_message(self.child, f"{state}-{index}", text)
                    await self.manager.wait(self.child)
                self.assertEqual(self.inputs[self.root], [])
                saved = next(s for s in self.scheduler.load() if s.task_id == self.root)
                self.assertEqual(self.interjections(saved.queues["feedback"]),
                                 ["用户直接对 a 说：先改颜色", "用户直接对 a 说：再改尺寸"])
                receipt = self.manager.dispatch(AgentOutput(messages=[
                    SendMessage(to="c", task_id=self.root, message="最终结果"),
                ], next="done"), self.child)[0]
                self.assertTrue(receipt["accepted"])
                await self.manager.wait(self.root)
                self.assertEqual(len(self.inputs[self.root]), 1)
                messages = self.inputs[self.root][0]
                self.assertEqual(self.interjections(messages),
                                 ["用户直接对 a 说：先改颜色", "用户直接对 a 说：再改尺寸"])
                relevant = [m for m in messages if "user_interjection" in m.content or "最终结果" in m.content]
                self.assertEqual([m.additional_kwargs.get("source") for m in relevant], ["runtime", "runtime", "worker"])
                self.assertTrue(relevant[-1].content.endswith("最终结果"))

    async def test_running_creator_sees_interjection_before_next_model_without_new_execution(self):
        self.root_gate = asyncio.Event()
        self.inputs[self.root].clear()
        self.manager.interrupt("执行工具中", self.root)
        await asyncio.sleep(0)
        running = self.manager._tasks[self.root]
        self.gateway.send_task_message(self.child, "running-notice", "更正约束")
        await self.manager.wait(self.child)
        self.assertEqual(len(self.inputs[self.root]), 1)
        self.assertFalse(running.cancelling())
        self.root_gate.set()
        await self.manager.wait(self.root)
        self.assertEqual(self.interjections(self.model_update["messages"]), ["用户直接对 a 说：更正约束"])
        self.assertEqual(len(self.inputs[self.root]), 1)

    async def test_restart_continuation_opens_return_chain_without_waking_ancestors_or_siblings(self):
        nested = self.manager.start("已结束的孙任务", sender_id=self.child, agent_name="b")["task_id"]
        sibling = self.manager.start("其他分支", sender_id=self.root, agent_name="d")["task_id"]
        await self.manager.wait(nested)
        await self.manager.wait(sibling)
        for _ in range(2):
            await self.manager.close()
            self.reopen()
        self.inputs.clear()
        for index in range(2):
            self.gateway.send_task_message(nested, f"restart-{index}", f"约束 {index}")
            await self.manager.wait(nested)
        self.assertNotIn(self.root, self.inputs)
        self.assertNotIn(self.child, self.inputs)
        self.assertTrue(self.manager.is_stopped(sibling))
        # 通知先持久化，再经历一次重启；第三次插话开放回报链而不直接运行上级。
        await self.manager.close()
        self.reopen()
        self.gateway.send_task_message(nested, "restart-open", "交回结果")
        await self.manager.wait(nested)
        self.forward[self.child] = ("c", self.root)
        receipt = self.manager.dispatch(AgentOutput(messages=[
            SendMessage(to="a", task_id=self.child, message="最终结果"),
        ], next="done"), nested)[0]
        self.assertTrue(receipt["accepted"])
        await self.manager.wait(self.child)
        await self.manager.wait(self.root)
        self.assertEqual(len(self.inputs[self.child]), 1)
        self.assertEqual(len(self.inputs[self.root]), 1)
        messages = self.inputs[self.child][0]
        self.assertEqual(self.interjections(messages),
                         ["用户直接对 b 说：约束 0", "用户直接对 b 说：约束 1", "用户直接对 b 说：交回结果"])
        self.assertTrue(messages[-1].content.endswith("最终结果"))
        self.assertTrue(self.manager.is_stopped(sibling))

    async def test_explicit_stop_survives_repeated_restart_and_rejects_child_continuation(self):
        await self.gateway.stop(self.root, "explicit-stop")
        for _ in range(2):
            await self.manager.close()
            self.reopen()
            with self.assertRaises(CollaborationStopped):
                self.gateway.send_task_message(self.child, "must-not-resume", "不能暗中恢复上级")
            self.assertTrue(self.manager.is_stopped(self.root))
            self.assertTrue(self.manager.is_stopped(self.child))
            self.assertIsNone(self.store.by_client_id("must-not-resume"))
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, token="test")),
            base_url="http://gateway", headers={"Authorization": "Bearer test"},
        )
        self.addAsyncCleanup(client.aclose)
        response = await client.post(f"/tasks/{self.child}/messages", json={"client_id": "http-stopped", "text": "继续"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "collaboration_stopped"))
        self.gateway.send_message(self.root, "resume-root", "恢复上级")
        await self.manager.wait(self.root)
        self.gateway.send_task_message(self.child, "resume-child", "现在可以继续")
        await self.manager.wait(self.child)
        self.assertEqual(self.manager.task_identity(self.child), ("a", self.root))

    async def test_failed_scheduler_commit_leaves_readable_but_unusable_collaboration(self):
        with patch.object(self.scheduler, "save", side_effect=OSError("disk full")):
            with self.assertRaises(SchedulerFailure):
                self.manager.start("没有调度身份的协作", sender_id=self.root, agent_name="a")
        orphan = next(t["task_id"] for t in self.store.task_conversations() if t["task_id"] != self.child)
        with self.assertRaises(SchedulerFailure):
            await self.manager.close()
        self.reopen()
        self.assertEqual(self.store.task_conversation(orphan)["status"], "unavailable")
        self.assertIsNone(self.manager.task_identity(orphan))
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, token="test")),
            base_url="http://gateway", headers={"Authorization": "Bearer test"},
        )
        self.addAsyncCleanup(client.aclose)
        self.assertEqual((await client.get(f"/tasks/{orphan}/events")).status_code, 200)
        before = self.manager.snapshot()
        for action in ("messages", "stop"):
            response = await client.post(f"/tasks/{orphan}/{action}", json={"client_id": action, "text": "不能变成新根"})
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "collaboration_unavailable"))
            self.assertIn("协作无法继续", response.json()["error"]["message"])
        self.assertEqual(self.manager.snapshot(), before)
        self.assertIsNone(self.manager.task_identity(orphan))

    async def test_mismatched_target_or_ancestor_identity_rejects_send_and_stop(self):
        nested = self.manager.start("孙任务", sender_id=self.child, agent_name="b")["task_id"]
        await self.manager.wait(nested)
        await self.manager.close()
        original = self.scheduler.load()
        for identity, changes in (
            (nested, {"agent": "d"}),
            (nested, {"caller": self.root}),
            (self.child, {"agent": "d"}),
            (self.root, {"agent": "main"}),
        ):
            with self.subTest(identity=identity, changes=changes):
                self.scheduler.save([replace(s, **changes) if s.task_id == identity else s for s in original])
                self.reopen()
                self.assertEqual(self.store.task_conversation(nested)["status"], "unavailable")
                with self.assertRaises(CollaborationUnavailable):
                    self.gateway.send_task_message(nested, "mismatch-send", "不接收")
                with self.assertRaises(CollaborationUnavailable):
                    await self.gateway.stop(nested, "mismatch-stop", task=True)
                self.assertIsNone(self.store.by_client_id("mismatch-send"))
                self.assertIsNone(self.store.by_client_id("mismatch-stop"))
                await self.manager.close()


class CollaborationObservationTests(unittest.IsolatedAsyncioTestCase):
    async def test_observer_failure_does_not_reject_delivery_or_change_scheduler(self):
        observed = []
        errors = []
        loop = asyncio.get_running_loop()
        prior = loop.get_exception_handler()
        loop.set_exception_handler(lambda _, context: errors.append(context["exception"]))
        self.addCleanup(loop.set_exception_handler, prior)

        def fail(*args):
            observed.append(args)
            raise OSError("host unavailable")

        async def run(prompts, task_id):
            return AgentOutput(messages=[], next="done")

        manager = WorkerManager(
            run, agent_workers={"a": ("b",), "b": ()}, default_agent="a",
            on_task_created=fail, on_task_message=fail,
        )
        self.addAsyncCleanup(manager.close)
        root = manager.start("root")["task_id"]
        receipt = manager.dispatch(AgentOutput(messages=[
            SendMessage(to="b", task_id=None, message="accepted"),
        ], next="done"), root)[0]
        self.assertTrue(receipt["accepted"])
        child = receipt["task_id"]
        await manager.wait(child)
        self.assertEqual(manager.get(child)["status"], "completed")
        self.assertEqual(observed[0], (child, root, "b", "accepted"))
        self.assertEqual(observed[1], (root, child, "accepted", []))
        self.assertEqual([str(error) for error in errors], ["host unavailable", "host unavailable"])
        rejected = manager.dispatch(AgentOutput(messages=[
            SendMessage(to="missing", task_id=None, message="rejected"),
        ], next="done"), root)[0]
        self.assertFalse(rejected["accepted"])
        self.assertEqual(len(observed), 2)
