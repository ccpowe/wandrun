"""Preview snapshots are ephemeral; only delivery or user interruption is durable."""

import asyncio
import unittest
from unittest.mock import patch

import httpx

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphInterrupt
from test_gateway import gateway_manager, open_store, temp_dir
from test_ui_submissions import FORM, ui
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway, UIBlockNotFound
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.ui_blocks import frozen_preview_text
from wandrun.runtime.preview import PreviewExecution, PreviewPersistenceError
from wandrun.runtime.messages import AgentOutput


class GatewayPreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.path = temp_dir(self) / "gateway.sqlite"
        self.store = open_store(self, self.path)
        self.gateway = Gateway(self.store)
        self.addCleanup(self.gateway.end_streams)

        async def run(prompts, task_id):
            await asyncio.Event().wait()

        self.manager = gateway_manager(self.gateway, run)
        self.addAsyncCleanup(self.manager.close)
        self.root = self.gateway.create_conversation("stream", "c")["id"]
        self.manager.start("root", self.root, agent_name="c")
        self.member = self.manager.start("member", sender_id=self.root, agent_name="a")["task_id"]
        self.executions = {
            sender: self.manager._previews[self.manager._tasks[sender]].execution_id
            for sender in (self.root, self.member)
        }
        self.store.mark_read(self.root, self.store.last_seq())

    def update(self, identity, text, *, sender=None, phase="final_answer"):
        sender = sender or self.root
        self.gateway.on_preview(sender, {
            "kind": "update", "draft_id": identity, "execution_id": self.executions[sender],
            "attempt_id": "attempt", "phase": phase, "text": text,
        })

    def preview(self, kind, identities, *, sender=None):
        sender = sender or self.root
        return self.gateway.on_preview(sender, {
            "kind": kind, "execution_id": self.executions[sender], "draft_ids": identities,
        })

    def publish(self):
        # Deterministic clock boundary; streaming production uses the 100ms timer.
        self.gateway._flush_drafts()

    async def stream(self, cursor=None):
        stream = self.gateway.stream(self.store.last_seq() if cursor is None else cursor)
        async def close():
            await stream.aclose()
        self.addAsyncCleanup(close)
        return stream

    async def test_preview_has_no_timeline_unread_or_search_and_reconnect_restores_members(self):
        before = self.store.last_seq()
        self.update("root/commentary/0", "进展", phase="commentary")
        self.update("member/final/0", "成员草稿", sender=self.member)
        self.publish()
        self.assertEqual(self.store.last_seq(), before)
        self.assertFalse(self.store.conversation(self.root)["unread"])
        self.assertFalse(self.store.search("成员草稿", None, 20, 0)["results"])
        stream = await self.stream()
        kind, snapshot = await anext(stream)
        self.assertEqual((kind, snapshot["type"]), ("transient", "draft.snapshot"))
        self.assertNotIn("seq", snapshot)
        self.assertEqual(snapshot["data"]["as_of_seq"], before)
        drafts = snapshot["data"]["drafts"]
        self.assertEqual([(d["draft_id"], d["agent"], d["phase"]) for d in drafts], [
            ("root/commentary/0", "c", "commentary"), ("member/final/0", "a", "final_answer"),
        ])
        self.assertTrue(all(d["conversation_id"] == self.root for d in drafts))
        self.assertEqual([draft["task_id"] for draft in drafts], [self.root, self.member])

    async def test_slow_reader_gets_latest_set_then_terminal_wins_and_replay_is_once(self):
        stream = await self.stream()
        initial = (await anext(stream))[1]
        for i in range(100):
            self.update("d", f"prefix {i}")
            self.publish()
        kind, latest = await anext(stream)
        self.assertEqual(kind, "transient")
        self.assertGreater(latest["data"]["revision"], initial["data"]["revision"])
        self.assertEqual(latest["data"]["base_revision"], initial["data"]["revision"])
        self.assertEqual(latest["data"]["updates"][0]["text"], "prefix 99")
        self.assertEqual(latest["data"]["updates"][0]["offset"], 0)
        self.update("d", "pending old snapshot")
        self.publish()
        self.gateway.on_human(self.root, "finished", [], "d")
        self.gateway.on_human(self.root, "finished", [], "d")
        kind, terminal = await anext(stream)
        self.assertEqual((kind, terminal["type"]), ("event", "message.agent"))
        self.assertEqual(terminal["data"]["draft_id"], "d")
        self.assertEqual(terminal["data"]["status"], "completed")
        kind, empty = await anext(stream)
        self.assertEqual((kind, empty["type"], empty["data"]["active_ids"]), ("transient", "draft.delta", []))
        self.assertGreaterEqual(empty["data"]["as_of_seq"], terminal["seq"])
        self.update("d", "late old attempt")
        self.publish()
        reconnect = await self.stream(terminal["seq"] - 1)
        self.assertEqual((await anext(reconnect))[1]["data"]["drafts"], [])
        self.assertEqual((await anext(reconnect))[1], terminal)
        messages = [e for e in self.store.history(self.root) if e.type == "message.agent"]
        self.assertEqual([e.data["text"] for e in messages], ["finished"])

    async def test_interruption_freezes_published_prefix_not_buffer_and_preserves_other_worker(self):
        self.update("root", "用户曾收到")
        self.update("member", "成员仍在工作", sender=self.member)
        self.publish()
        self.update("root", "用户曾收到但这部分尚未发布")
        frozen = self.preview("interrupt", ["root"])
        self.assertEqual([(r["draft_id"], r["text"]) for r in frozen], [("root", "用户曾收到")])
        message = self.store.message_at(self.root, frozen[0]["seq"])
        self.assertEqual(message.data["status"], "interrupted")
        self.assertEqual(message.data["attachments"], [])
        self.assertNotIn("ui", message.data)
        self.update("root", "late")
        self.publish()
        stream = await self.stream()
        self.assertEqual([d["draft_id"] for d in (await anext(stream))[1]["data"]["drafts"]], ["member"])
        restarted = GatewayStore(self.path)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.message_at(self.root, message.seq).data, message.data)
        self.assertEqual(self.preview("interrupt", ["root"]), [])

    async def test_ended_attempt_does_not_reappear_and_next_attempt_starts_empty(self):
        self.update("old", "old prefix")
        self.publish()
        self.preview("end", ["old"])
        self.update("old", "late")
        self.update("new", "new")
        self.publish()
        stream = await self.stream()
        drafts = (await anext(stream))[1]["data"]["drafts"]
        self.assertEqual([(d["draft_id"], d["text"]) for d in drafts], [("new", "new")])
        self.assertFalse(any(e.type == "message.agent" for e in self.store.history(self.root)))

    async def test_interrupted_complete_form_is_never_submittable(self):
        source, _ = self.store.append_agent_message(
            self.root, self.root, ui(FORM), "c", [],
            draft_id="form", status="interrupted",
        )
        with self.assertRaises(UIBlockNotFound):
            self.gateway.submit_ui(self.root, "submit", source.seq, 0, {"plan": "A", "note": ""})
        self.assertIsNone(self.store.by_client_id("submit"))

    async def test_interrupted_ui_source_does_not_leak_through_search_or_home(self):
        self.update("ui", '引言\n```wandrun-ui\n{"root":"hidden-source","elements":')
        self.publish()
        frozen = self.preview("interrupt", ["ui"])
        self.assertEqual(frozen[0]["text"], "引言\n[界面未完成]\n")
        self.assertEqual(self.store.conversation(self.root)["last_text"], frozen[0]["text"])
        self.assertFalse(self.store.search("hidden-source", None, 20, 0)["results"])
        self.assertEqual(self.store.search("引言", None, 20, 0)["results"][0]["text"], frozen[0]["text"])

    async def test_unpublished_prefix_is_not_frozen_or_recovered(self):
        self.update("unseen", "buffer only")
        self.assertEqual(self.preview("interrupt", ["unseen"]), [])
        self.assertFalse(any(e.type == "message.agent" for e in self.store.history(self.root)))
        stream = await self.stream()
        self.assertEqual((await anext(stream))[1]["data"]["drafts"], [])

    async def test_retirement_does_not_publish_another_workers_buffer(self):
        self.update("root", "published root")
        self.update("member", "published member", sender=self.member)
        self.publish()
        self.update("member", "published member plus buffered suffix", sender=self.member)
        self.preview("end", ["root"])
        frozen = self.preview("interrupt", ["member"], sender=self.member)
        self.assertEqual([record["text"] for record in frozen], ["published member"])

    async def test_deletion_releases_retired_drafts_and_late_updates_stay_invisible(self):
        self.gateway.checkpointer = InMemorySaver()
        self.update("retired", "temporary")
        self.publish()
        self.preview("end", ["retired"])
        await self.gateway.delete_conversation(self.root)
        self.assertEqual(self.gateway._ended_drafts, {})
        self.assertEqual(self.gateway._preview_owners, {})
        self.update("retired", "late deleted conversation")
        self.publish()
        stream = await self.stream()
        self.assertEqual((await anext(stream))[1]["data"]["drafts"], [])

    async def test_unpublished_terminal_advances_snapshot_reclamation_barrier(self):
        stream = await self.stream()
        initial = (await anext(stream))[1]["data"]
        self.update("quick", "buffered")
        self.gateway.on_human(self.root, "quick complete", [], "quick")
        kind, terminal = await anext(stream)
        self.assertEqual((kind, terminal["data"]["status"]), ("event", "completed"))
        kind, snapshot = await anext(stream)
        self.assertEqual(kind, "transient")
        self.assertEqual(snapshot["data"]["active_ids"], [])
        self.assertGreater(snapshot["data"]["revision"], initial["revision"])
        self.assertGreaterEqual(snapshot["data"]["as_of_seq"], terminal["seq"])

    async def test_connection_relative_append_uses_utf16_offsets_and_coalesces_slow_readers(self):
        self.update("root", "中😀")
        self.update("member", "unchanged", sender=self.member)
        self.publish()
        fast = await self.stream()
        slow = await self.stream()
        initial = (await anext(fast))[1]["data"]
        await anext(slow)
        self.update("root", "中😀甲")
        self.publish()
        first = (await anext(fast))[1]
        self.assertEqual(first["type"], "draft.delta")
        self.assertEqual(first["data"]["active_ids"], ["root", "member"])
        self.assertEqual([(d["draft_id"], d["offset"], d["text"]) for d in first["data"]["updates"]],
                         [("root", 3, "甲")])
        self.update("root", "中😀甲乙😀")
        self.publish()
        second = (await anext(fast))[1]["data"]
        latest = (await anext(slow))[1]["data"]
        self.assertEqual(second["base_revision"], first["data"]["revision"])
        self.assertEqual([(d["offset"], d["text"]) for d in second["updates"]], [(4, "乙😀")])
        self.assertEqual(latest["base_revision"], initial["revision"])
        self.assertEqual([(d["offset"], d["text"]) for d in latest["updates"]], [(3, "甲乙😀")])
        self.assertEqual(latest["revision"], second["revision"])
        reconnect = await self.stream()
        recovered = (await anext(reconnect))[1]
        self.assertEqual(recovered["type"], "draft.snapshot")
        self.assertEqual([d["text"] for d in recovered["data"]["drafts"]], ["中😀甲乙😀", "unchanged"])

    async def test_non_append_projection_recovers_with_snapshot_then_resumes_delta(self):
        self.update("d", "old text")
        self.publish()
        stream = await self.stream()
        await anext(stream)
        self.update("d", "new😀")
        self.publish()
        reset = (await anext(stream))[1]
        self.assertEqual(reset["type"], "draft.snapshot")
        self.assertEqual(reset["data"]["drafts"][0]["text"], "new😀")
        self.update("d", "new😀 suffix")
        self.publish()
        update = (await anext(stream))[1]
        self.assertEqual(update["type"], "draft.delta")
        self.assertEqual(update["data"]["updates"][0]["offset"], 5)
        self.assertEqual(update["data"]["updates"][0]["text"], " suffix")

    async def test_observer_failure_disables_only_its_execution_without_fatal(self):
        self.update("root", "root prefix")
        self.update("member", "member prefix", sender=self.member)
        self.publish()
        with self.assertLogs("wandrun.gateway.service", level="ERROR"):
            with patch.object(self.gateway, "_on_preview", side_effect=RuntimeError("observer")):
                self.update("root", "failed update")
        self.update("root", "late update after disable")
        self.publish()
        self.assertIsNone(self.gateway.failure)
        self.assertFalse(self.gateway._closing)
        self.assertEqual([d["draft_id"] for d in self.gateway._draft_snapshot()["data"]["drafts"]], ["member"])
        self.gateway.on_human(self.root, "authoritative response", [], "root")
        self.assertEqual([e.data["text"] for e in self.store.history(self.root) if e.type == "message.agent"],
                         ["authoritative response"])

    async def test_graph_interrupt_escapes_gateway_and_scope_without_becoming_a_preview_fault(self):
        for boundary in ("_on_preview", "_end_drafts", "_publish_drafts"):
            with self.subTest(boundary=boundary):
                scope = PreviewExecution(self.root, self.gateway.on_preview)
                attempt = scope.begin()
                identity = scope.update(attempt, 0, 0, "draft", "final_answer")
                error = GraphInterrupt()
                try:
                    with patch.object(self.gateway, boundary, side_effect=error):
                        with self.assertRaises(GraphInterrupt) as raised:
                            if boundary == "_on_preview":
                                scope.update(attempt, 0, 0, "next", "final_answer")
                            elif boundary == "_end_drafts":
                                scope.end([identity])
                            else:
                                self.publish()
                    self.assertIs(raised.exception, error)
                    self.assertIsNone(self.gateway.failure)
                    self.assertTrue(scope.enabled)
                finally:
                    scope.close()

    async def test_retirement_or_publication_failure_does_not_truncate_formal_batch(self):
        output = AgentOutput(messages=[
            {"to": "human", "task_id": None, "message": "first"},
            {"to": "human", "task_id": None, "message": "second"},
        ], next="done")
        for failure in ("_end_drafts", "_publish_drafts"):
            with self.subTest(failure=failure):
                scope = PreviewExecution(self.root, self.gateway.on_preview)
                attempt = scope.begin()
                ids = [scope.update(attempt, 0, i, text, "final_answer")
                       for i, text in enumerate(("first prefix", "second prefix"))]
                self.publish()
                with self.assertLogs("wandrun.gateway.service", level="ERROR"):
                    with patch.object(self.gateway, failure, side_effect=RuntimeError(failure)):
                        receipts = self.manager.dispatch(output, self.root, draft_ids=ids)
                self.assertEqual([r["accepted"] for r in receipts], [True, True])
                self.assertIsNone(self.gateway.failure)
                self.assertEqual(self.gateway._draft_snapshot()["data"]["drafts"], [])
                scope.close()
        self.assertEqual([e.data["text"] for e in self.store.history(self.root) if e.type == "message.agent"],
                         ["first", "second", "first", "second"])

    async def test_timer_publication_failure_disables_previews_not_formal_channel(self):
        self.update("member", "published sibling", sender=self.member)
        self.publish()
        self.update("root", "pending prefix")
        with self.assertLogs("wandrun.gateway.service", level="ERROR"):
            with patch.object(self.gateway, "_publish_drafts", side_effect=RuntimeError("publisher")):
                self.publish()
        self.update("root", "late prefix")
        self.assertEqual([d["draft_id"] for d in self.gateway._draft_snapshot()["data"]["drafts"]], ["member"])
        self.assertEqual(set(self.gateway._drafts), {"member"})
        self.update("member", "sibling continues", sender=self.member)
        self.publish()
        self.assertEqual(self.gateway._draft_snapshot()["data"]["drafts"][0]["text"], "sibling continues")
        self.assertIsNone(self.gateway.failure)
        self.gateway.on_human(self.root, "still delivered", [], "root")
        self.assertEqual(self.store.conversation(self.root)["last_text"], "still delivered")

    async def test_successful_freeze_feedback_survives_retirement_observer_failure(self):
        self.update("root", "published prefix")
        self.publish()
        with self.assertLogs("wandrun.gateway.service", level="ERROR"):
            with patch.object(self.gateway, "_end_drafts", side_effect=RuntimeError("retirement")):
                frozen = self.preview("interrupt", ["root"])
        self.assertEqual([record["text"] for record in frozen], ["published prefix"])
        self.assertEqual(self.store.message_at(self.root, frozen[0]["seq"]).data["status"], "interrupted")
        self.assertIsNone(self.gateway.failure)
        self.assertEqual(self.gateway._draft_snapshot()["data"]["drafts"], [])

    async def test_freeze_storage_failure_returns_unavailable_without_accepting_input(self):
        await asyncio.sleep(0)
        scope = self.manager._previews[self.manager._tasks[self.root]]
        scope.update(scope.begin(), 0, 0, "published prefix", "final_answer")
        self.publish()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(self.gateway, "test")),
                                     base_url="http://gateway", headers={"Authorization": "Bearer test"}) as client:
            with patch.object(self.store, "append_agent_message", side_effect=OSError("disk failed")):
                response = await client.post(f"/conversations/{self.root}/messages",
                                             json={"client_id": "rejected", "text": "new input"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "unavailable")
        self.assertIsNone(self.store.by_client_id("rejected"))
        self.assertFalse(any(e.type == "message.agent" for e in self.store.history(self.root)))
        self.assertIsNotNone(self.gateway.failure)

    async def test_freeze_commit_then_failure_aborts_new_command_without_retry(self):
        await asyncio.sleep(0)
        task = self.manager._tasks[self.root]
        scope = self.manager._previews[task]
        attempt = scope.begin()
        identity = scope.update(attempt, 0, 0, "published prefix", "final_answer")
        self.publish()
        append = self.store.append_agent_message

        def commit_then_fail(*args, **kwargs):
            append(*args, **kwargs)
            raise OSError("commit acknowledgement lost")

        with patch.object(self.store, "append_agent_message", side_effect=commit_then_fail) as write:
            with self.assertRaises(PreviewPersistenceError):
                self.gateway.send_message(self.root, "not-accepted", "new input")
            self.assertEqual(write.call_count, 1)
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(task.cancelled())
        self.assertIsNotNone(self.gateway.failure)
        self.assertIsNone(self.store.by_client_id("not-accepted"))
        messages = [e for e in self.store.history(self.root) if e.type == "message.agent"]
        self.assertEqual([(e.data["draft_id"], e.data["status"]) for e in messages], [(identity, "interrupted")])
        self.assertEqual(self.gateway._draft_snapshot()["data"]["drafts"], [])

    async def test_normal_execution_settlement_reclaims_identities_without_late_revival(self):
        owners_before = self.gateway._preview_owners.copy()
        for i in range(1000):
            scope = PreviewExecution(self.root, self.gateway.on_preview)
            attempt = scope.begin()
            identity = scope.update(attempt, 0, 0, f"prefix {i}", "final_answer")
            self.publish()
            scope.end([identity])
            self.assertEqual(self.gateway._ended_drafts[scope.execution_id], {identity})
            scope.close()
            self.gateway.on_preview(self.root, {
                "kind": "update", "execution_id": scope.execution_id, "attempt_id": attempt,
                "draft_id": identity, "phase": "final_answer", "text": "late",
            })
            self.assertEqual(self.gateway._ended_drafts, {})
            self.assertEqual(self.gateway._draft_owners, {})
            self.assertEqual(self.gateway._drafts, {})
            self.assertEqual(self.gateway._published_drafts, {})
        self.assertEqual(self.gateway._preview_owners, owners_before)
        await self.manager.close()
        self.assertEqual(self.gateway._preview_owners, {})


class FrozenPreviewTextTests(unittest.TestCase):
    def test_every_ui_opener_prefix_stays_a_placeholder_when_frozen(self):
        for marker in ("```wandrun-ui", "~~~wandrun-ui"):
            for position in range(1, len(marker) + 1):
                with self.subTest(prefix=marker[:position]):
                    self.assertEqual(frozen_preview_text("intro\n" + marker[:position]), "intro\n[界面未完成]\n")

    def test_closed_ui_diagram_and_ordinary_fence_shielding(self):
        text = 'before\n```wandrun-ui\n{"secret":1}\n```\nbetween\n~~~mermaid\nA --> B\n~~~\nafter'
        self.assertEqual(frozen_preview_text(text), "before\n[界面未完成]\nbetween\n[流程图未完成]\nafter")
        ordinary = '```text\n```wandrun-ui\nliteral example\n```\n'
        self.assertEqual(frozen_preview_text(ordinary), ordinary)
