"""富交互消息的交付、HTTP 提交与事件持久化行为。"""

from copy import deepcopy
import asyncio
import json
import unittest

import httpx

from test_gateway import gateway_manager, open_store, temp_dir
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.runtime.files import TaskFiles
from wandrun.runtime.messages import AgentOutput, SendMessage


FORM = {
    "root": "root",
    "elements": {
        "root": {"type": "Stack", "props": {}, "children": ["choice", "note", "submit"]},
        "choice": {"type": "ChoiceGroup", "props": {
            "stateKey": "plan", "label": "选择方案", "options": [
                {"value": "A", "label": "方案甲"}, {"value": "B", "label": "方案乙"},
            ],
        }, "children": []},
        "note": {"type": "TextInput", "props": {"stateKey": "note", "label": "备注"}, "children": []},
        "submit": {"type": "Submit", "props": {"label": "提交"}, "children": []},
    },
    "state": {"plan": "", "note": ""},
}
DISPLAY = {
    "root": "root", "elements": {"root": {"type": "Text", "props": {"text": "仅展示"}, "children": []}},
    "state": {},
}


def ui(spec: dict) -> str:
    return "说明\n```wandrun-ui\n" + json.dumps(spec, ensure_ascii=False) + "\n```\n结尾"


class UISubmissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.path = temp_dir(self) / "gateway.sqlite"
        self.store = open_store(self, self.path)
        self.gateway = Gateway(self.store)
        self.calls = []
        self.block = False
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.fail = False

        async def run(prompts, task_id):
            self.calls.append([message.content for message in prompts])
            if self.block:
                self.entered.set()
                await self.release.wait()
            if self.fail:
                raise RuntimeError("故意失败")
            return "done"

        self.manager = gateway_manager(
            self.gateway, run, validate_human=self.gateway.validate_human,
            agent_workers={"main": ("a",), "a": ()},
        )
        self.addAsyncCleanup(self.manager.close)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway", headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)
        self.conversation = self.gateway.create_conversation("测试", "main")["id"]
        self.url = f"/conversations/{self.conversation}/ui-submissions"

    def source(self, spec=FORM, *, conversation=None):
        identity = conversation or self.conversation
        self.gateway.on_human(identity, ui(spec), [])
        return next(event for event in reversed(self.store.history(identity)) if event.type == "message.agent")

    def payload(self, seq, **changes):
        return {"client_id": "submit-1", "message_seq": seq, "block": 0,
                "values": {"plan": "B", "note": "按期完成"}, **changes}

    async def test_submission_interrupts_active_turn(self):
        source = self.source()
        self.block = True
        self.gateway.send_message(self.conversation, "start-turn", "继续处理")
        await asyncio.wait_for(self.entered.wait(), 2)
        self.block = False
        submitted = await self.client.post(self.url, json=self.payload(source.seq))
        self.assertEqual(submitted.status_code, 200)
        await asyncio.wait_for(self.manager.wait(self.conversation), 2)
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(any(str(source.seq) in prompt and "方案乙" in prompt
                            for prompt in self.calls[1]))

    async def test_metadata_and_submit_replay_interrupt_and_restart(self):
        source = self.source()
        self.assertEqual(source.data["ui"], [{"block": 0, "valid": True}])
        self.assertEqual(self.store.message_at(self.conversation, source.seq), source)
        body = self.payload(source.seq)
        response = await self.client.post(self.url, json=body)
        self.assertEqual(response.status_code, 200)
        event = response.json()["event"]
        self.assertFalse(response.json()["replayed"])
        self.assertEqual(event["data"]["ui_submission"], {
            "message_seq": source.seq, "block": 0, "values": body["values"],
        })
        self.assertEqual(event["data"]["attachments"], [])
        self.assertIn("方案乙", event["data"]["text"])
        await self.manager.wait(self.conversation)
        self.assertIn(str(source.seq), self.calls[-1][0])
        self.assertIn("选择方案", self.calls[-1][0])
        self.assertIn("方案乙", self.calls[-1][0])
        self.assertIn("B", self.calls[-1][0])
        replay = await self.client.post(self.url, json={**body, "values": {"plan": "A", "note": "重试改变值"}})
        self.assertEqual((replay.status_code, replay.json()), (200, {"event": event, "replayed": True}))
        self.assertEqual(len(self.calls), 1)
        # 不加载可能已截断的对话历史；新 store 在同一个数据库中恢复提交占用与首次响应。
        restarted = GatewayStore(self.path)
        self.addCleanup(restarted.close)
        other = Gateway(restarted)
        self.assertEqual(other.store.ui_submission(self.conversation, source.seq, 0).seq, event["seq"])
        self.assertEqual(other.store.message_at(self.conversation, source.seq), source)
        self.assertEqual(other.store.by_client_id("submit-1").to_dict(), event)
        restarted_replay, created = other.submit_ui(
            self.conversation, "submit-1", source.seq, 0, {"plan": "A", "note": ""},
        )
        self.assertFalse(created)
        self.assertEqual(restarted_replay.to_dict(), event)
        old = await self.client.post(self.url, json=self.payload(source.seq, client_id="submit-2"))
        self.assertEqual((old.status_code, old.json()["error"]["code"]), (409, "ui_already_submitted"))
        self.assertEqual(old.json()["error"]["details"], {"event": event})

    async def test_submission_validation_provenance_and_conflicts(self):
        source = self.source()
        extra = self.gateway.create_conversation("别的", "main")["id"]
        other_source = self.source(conversation=extra)
        invalid = self.source({**FORM, "elements": {"root": {"type": "Unknown", "props": {}, "children": []}}, "state": {}})
        display = self.source(DISPLAY)
        self.gateway.send_message(self.conversation, "ordinary", "普通用户消息")
        user_seq = self.store.by_client_id("ordinary").seq
        for seq, block in ((source.seq, 1), (user_seq, 0), (other_source.seq, 0),
                           (invalid.seq, 0), (display.seq, 0)):
            result = await self.client.post(self.url, json=self.payload(seq, block=block))
            self.assertEqual((result.status_code, result.json()["error"]["code"]), (404, "ui_block_not_found"))
        self.assertEqual(invalid.data["ui"][0]["valid"], False)
        for values, expected_key in (({"plan": "A"}, "note"),
                                     ({"plan": "A", "note": "", "unexpected": 1}, "unexpected"),
                                     ({"plan": 42, "note": ""}, "plan"),
                                     ({"plan": "C", "note": ""}, "plan"),
                                     ({"plan": "A", "note": "x" * 2001}, "note")):
            result = await self.client.post(self.url, json=self.payload(source.seq, values=values))
            self.assertEqual((result.status_code, result.json()["error"]["code"]), (400, "ui_invalid_values"))
            self.assertIn(expected_key, result.json()["error"]["details"])
        malformed_values = await self.client.post(self.url, json=self.payload(source.seq, values=[]))
        self.assertEqual((malformed_values.status_code, malformed_values.json()["error"]["code"]),
                         (400, "ui_invalid_values"))
        self.assertIn("$", malformed_values.json()["error"]["details"])
        submitted = await self.client.post(self.url, json=self.payload(source.seq))
        self.assertEqual(submitted.status_code, 200)
        for body, url in ((self.payload(source.seq, client_id="submit-1", block=1), self.url),
                          (self.payload(source.seq, client_id="ordinary"), self.url),
                          (self.payload(source.seq), f"/conversations/{extra}/ui-submissions")):
            conflict = await self.client.post(url, json=body)
            self.assertEqual((conflict.status_code, conflict.json()["error"]["code"]), (409, "client_id_reused"))
        send_conflict = await self.client.post(
            f"/conversations/{self.conversation}/messages", json={"client_id": "submit-1", "text": "覆写"},
        )
        self.assertEqual((send_conflict.status_code, send_conflict.json()["error"]["code"]),
                         (409, "client_id_reused"))
        other = await self.client.post(
            self.url, json=self.payload(source.seq, client_id="other-client", values={"plan": "C"}),
        )
        self.assertEqual((other.status_code, other.json()["error"]["code"]), (409, "ui_already_submitted"))
        self.assertEqual(other.json()["error"]["details"], {"event": submitted.json()["event"]})
        self.assertEqual(len([e for e in self.store.history(self.conversation, limit=100)
                              if e.type == "message.user" and "ui_submission" in e.data]), 1)

    async def test_two_blocks_submit_independently(self):
        self.gateway.on_human(self.conversation, ui(FORM) + "\n" + ui(FORM), [])
        source = next(event for event in reversed(self.store.history(self.conversation))
                      if event.type == "message.agent")
        self.assertEqual(source.data["ui"], [{"block": 0, "valid": True}, {"block": 1, "valid": True}])
        second = await self.client.post(self.url, json=self.payload(source.seq, block=1))
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["event"]["data"]["ui_submission"]["block"], 1)
        first = await self.client.post(self.url, json=self.payload(source.seq, client_id="first-block"))
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["event"]["data"]["ui_submission"]["block"], 0)
        self.assertNotEqual(first.json()["event"]["seq"], second.json()["event"]["seq"])

    async def test_old_card_beyond_history_window_remains_submittable(self):
        source = self.source()
        for index in range(230):
            self.store.append(self.conversation, "conversation.status", {"status": "idle", "n": index})
        self.assertNotIn(source, self.store.history(self.conversation, limit=200))
        submitted = await self.client.post(self.url, json=self.payload(source.seq))
        self.assertEqual(submitted.status_code, 200)
        self.assertEqual(submitted.json()["event"]["data"]["ui_submission"]["message_seq"], source.seq)
        for index in range(230, 290):
            self.store.append(self.conversation, "conversation.status", {"status": "idle", "n": index})
        conflict = await self.client.post(self.url, json=self.payload(source.seq, client_id="rival"))
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["error"]["details"],
                         {"event": submitted.json()["event"]})

    async def test_disabled_choice_retention_and_new_selection(self):
        spec = deepcopy(FORM)
        spec["elements"]["choice"]["props"]["options"][0]["disabled"] = True
        spec["state"]["plan"] = "A"
        source = self.source(spec)
        accepted = await self.client.post(
            self.url, json=self.payload(source.seq, values={"plan": "A", "note": ""}),
        )
        self.assertEqual(accepted.status_code, 200)
        fresh = deepcopy(spec)
        fresh["state"]["plan"] = "B"
        next_source = self.source(fresh)
        invalid = await self.client.post(
            self.url, json=self.payload(
                next_source.seq, client_id="fresh-choice", values={"plan": "A", "note": ""},
            ),
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("plan", invalid.json()["error"]["details"])

    async def test_concurrent_submission_reports_persisted_winner(self):
        source = self.source()
        attempts = await asyncio.gather(
            self.client.post(self.url, json=self.payload(source.seq, client_id="first")),
            self.client.post(self.url, json=self.payload(source.seq, client_id="second")),
        )
        winner, conflict = sorted(attempts, key=lambda response: response.status_code)
        self.assertEqual((winner.status_code, conflict.status_code), (200, 409))
        winning_event = winner.json()["event"]
        self.assertEqual(conflict.json()["error"]["details"], {"event": winning_event})
        self.assertEqual(self.store.ui_submission(self.conversation, source.seq, 0).to_dict(), winning_event)
        replay = await self.client.post(
            self.url, json=self.payload(source.seq, client_id=winning_event["client_id"]),
        )
        self.assertEqual(replay.json(), {"event": winning_event, "replayed": True})

    async def test_invalid_ui_count_survives_failed_turn_and_same_task_resume(self):
        bad = AgentOutput(messages=[SendMessage(
            to="human", task_id=None, message="```wandrun-ui\n{invalid}\n```",
        )], next="wait")
        self.assertFalse(self.manager.dispatch(bad, self.conversation)[0]["accepted"])
        self.fail = True
        self.gateway.send_message(self.conversation, "fail-turn", "开始")
        await asyncio.wait_for(self.manager.wait(self.conversation), 2)
        await asyncio.sleep(0)
        self.assertEqual(self.store.conversation(self.conversation)["status"], "failed")
        self.assertFalse(self.manager.dispatch(bad, self.conversation)[0]["accepted"])
        self.fail = False
        self.gateway.send_message(self.conversation, "resume-turn", "继续")
        await asyncio.wait_for(self.manager.wait(self.conversation), 2)
        await asyncio.sleep(0)
        self.assertEqual(self.store.conversation(self.conversation)["status"], "idle")
        self.assertTrue(self.manager.dispatch(bad, self.conversation)[0]["accepted"])
        delivered = [event for event in self.store.history(self.conversation) if event.type == "message.agent"]
        self.assertEqual(len(delivered), 1)
        self.assertFalse(delivered[0].data["ui"][0]["valid"])

    async def test_image_refs_require_this_message_accepted_image_and_persist_registered_ids(self):
        self.manager.start("开始", self.conversation, agent_name="main")
        await self.manager.wait(self.conversation)
        root = self.path.parent
        (root / "capture.png").write_bytes(b"image")
        (root / "unused.png").write_bytes(b"other")
        (root / "memo.txt").write_bytes(b"text")
        self.manager._attachment_resolver = TaskFiles(
            root, self.manager, {"main": ("local", str(root)), "a": ("local", str(root))},
            conversation_workdirs=False,
        ).resolve_attachments
        image = {
            "root": "img", "elements": {
                "img": {"type": "Image", "props": {"attachment": "capture.png", "alt": "截图"}, "children": []},
            }, "state": {},
        }

        def deliver(text, paths=()):
            output = AgentOutput(messages=[SendMessage(
                to="human", task_id=None, message=text, attachments=list(paths),
            )], next="wait")
            return self.manager.dispatch(output, self.conversation)[0]

        missing = deliver(ui(image))
        self.assertFalse(missing["accepted"])
        self.assertIn("$.elements.img.props.attachment", missing["error"])
        self.assertFalse(deliver(ui(image), ["memo.txt"])["accepted"])
        fallback = deliver(ui(image), ["memo.txt"])
        self.assertTrue(fallback["accepted"])
        rejected_block = self.store.history(self.conversation, limit=2)[0]
        self.assertEqual(rejected_block.data["ui"][0]["valid"], False)
        self.assertNotIn("files", rejected_block.data["ui"][0])
        self.assertEqual(rejected_block.data["attachments"][0]["name"], "memo.txt")

        wrong_spelling = deepcopy(image)
        wrong_spelling["elements"]["img"]["props"]["attachment"] = str(root / "capture.png")
        self.assertFalse(deliver(ui(wrong_spelling), ["capture.png"])["accepted"])
        mixed = ui(image) + "\n" + ui({**image, "elements": {
            "img": {"type": "Image", "props": {"attachment": "memo.txt", "alt": "文本"}, "children": []},
        }})
        self.assertFalse(deliver(mixed, ["capture.png", "unused.png", "memo.txt"])["accepted"])
        result = deliver(mixed, ["capture.png", "unused.png", "memo.txt"])
        self.assertTrue(result["accepted"])
        event = self.store.history(self.conversation, limit=4)[0]
        files = {record["name"]: record["id"] for record in event.data["attachments"]}
        self.assertEqual(event.data["ui"][0], {"block": 0, "valid": True,
                                               "files": {"capture.png": files["capture.png"]}})
        self.assertFalse(event.data["ui"][1]["valid"])
        self.assertNotIn("files", event.data["ui"][1])
        self.assertNotIn(files["unused.png"], event.data["ui"][0]["files"].values())
        restarted = GatewayStore(self.path)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.message_at(self.conversation, event.seq).data, event.data)
        self.assertEqual(restarted.after(event.seq - 1)[0].data, event.data)

    async def test_member_to_human_uses_task_timeline_and_same_validation(self):
        self.manager.start("启动根任务", self.conversation, agent_name="main")
        self.manager.start("分派子任务", "member-task", sender_id=self.conversation, agent_name="a")
        bad = AgentOutput(messages=[SendMessage(
            to="human", task_id=None, message="```wandrun-ui\n{invalid}\n```",
        )], next="wait")
        self.assertFalse(self.manager.dispatch(bad, "member-task")[0]["accepted"])
        self.assertFalse(self.manager.dispatch(bad, "member-task")[0]["accepted"])
        self.assertTrue(self.manager.dispatch(bad, "member-task")[0]["accepted"])
        delivered = [event for event in self.store.task_history("member-task") if event.type == "message.agent"]
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0].data["agent"], "a")
        self.assertFalse(delivered[0].data["ui"][0]["valid"])

    async def test_delivery_rejects_first_two_then_persists_invalid_third_and_resets_sender(self):
        bad = "说明\n```wandrun-ui\n{not-json}\n```"

        def deliver(sender, to="human", task_id=None, text=bad):
            batch = AgentOutput(messages=[SendMessage(to=to, task_id=task_id, message=text)], next="wait")
            return self.manager.dispatch(batch, sender)[0]

        second = self.gateway.create_conversation("第二任务", "main")["id"]
        multiple = self.gateway.create_conversation("多块任务", "main")["id"]
        errors = deliver(multiple, text=bad + "\n" + bad)
        self.assertFalse(errors["accepted"])
        self.assertIn("界面块 0", errors["error"])
        self.assertIn("界面块 1", errors["error"])
        for sender in (self.conversation, second):
            for _ in range(2):
                receipt = deliver(sender)
                self.assertFalse(receipt["accepted"])
                self.assertIn("界面块 0", receipt["error"])
        self.assertFalse(any(event.type == "message.agent" for event in self.store.history(second)))
        self.assertTrue(deliver(second)["accepted"])
        self.assertEqual(self.store.history(second)[-1].data["ui"][0]["valid"], False)
        self.assertTrue(deliver(self.conversation)["accepted"])
        self.assertFalse(deliver(self.conversation)["accepted"])
        self.assertFalse(deliver(self.conversation)["accepted"])
        self.assertTrue(deliver(self.conversation, text="普通消息")["accepted"])
        self.assertNotIn("ui", self.store.history(self.conversation)[-1].data)
        self.assertFalse(deliver(self.conversation)["accepted"])
        # Agent-to-Agent 不是 human，不经此校验，也不耗用这个 sender 的拒绝次数。
        self.manager.start("启动任务", self.conversation, agent_name="main")
        receipt = deliver(self.conversation, to="a")
        self.assertTrue(receipt["accepted"])
        self.assertFalse(deliver(self.conversation)["accepted"])
        self.assertTrue(deliver(self.conversation, text=ui(FORM))["accepted"])
        self.assertEqual(self.store.history(self.conversation)[-1].data["ui"], [{"block": 0, "valid": True}])
        self.assertFalse(deliver(self.conversation)["accepted"])
        self.assertFalse(deliver(self.conversation)["accepted"])
        self.assertTrue(deliver(self.conversation)["accepted"])


if __name__ == "__main__":
    unittest.main()
