"""ADR-0026 gateway invariants: one accepted trigger, no catch-up, and durable history."""

import asyncio
import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfoNotFoundError

import httpx

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.http import create_app
from wandrun.gateway.schedules import InvalidSchedule, schedule_fields
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import ClientIdConflict, GatewayStore
from wandrun.runtime.messages import AgentOutput
from wandrun.runtime.workers import WorkerManager


def stamp(value: str) -> float:
    return datetime.fromisoformat(value).replace(tzinfo=UTC).timestamp()


class ScheduleCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "gateway.sqlite"
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        self.store.import_agents(AgentCatalog(None, {"a": AgentDefinition(
            description="A", system_prompt="Do work", model="offline", environment="local",
        )}))

    def create(self, *, identity="s1", kind="daily", client_id="create"):
        rule = {"kind": kind, "time": "00:00"} if kind == "daily" else {
            "kind": "once", "local_at": "2099-01-01T00:00",
        }
        fields = schedule_fields({
            "name": "晨报", "content": "独立说明", "rule": rule, "timezone": "Etc/UTC",
        }, now=stamp("2023-01-01T00:00:00"))
        return self.store.create_schedule(identity, "a", fields, client_id)

    def test_create_replay_snapshot_noop_and_delete_tombstone(self):
        detail, event, created = self.create(kind="once")
        self.assertTrue(created)
        self.assertEqual(self.store.replay_create_schedule("create"), (detail, event))
        changed = schedule_fields({"name": "新名字"}, self.store.schedule("s1", internal=True), now=stamp("2025-01-01T00:00:00"))
        updated, update_event = self.store.update_schedule("s1", changed)
        self.assertEqual(updated["name"], "新名字")
        self.assertEqual(updated["next_run_at"], detail["next_run_at"])
        self.assertEqual(self.store.update_schedule("s1", changed)[1], None)
        self.assertEqual(self.store.replay_create_schedule("create"), (detail, event))
        deleted = self.store.delete_schedule("s1")
        self.assertEqual(self.store.delete_schedule("s1"), deleted)
        self.assertEqual(deleted.data, {"kind": "schedule", "id": "s1", "op": "deleted"})
        self.assertEqual(self.store.replay_create_schedule("create"), (detail, event))
        conversation, _ = self.store.create_conversation("x", "a")
        self.store.append_user_message(conversation["id"], "text", "other-command")
        with self.assertRaises(ClientIdConflict):
            self.store.replay_create_schedule("other-command")
        self.assertLess(event.seq, update_event.seq)

    def test_trigger_is_atomic_and_source_survives_schedule_deletion(self):
        detail, _, _ = self.create()
        due = detail["next_run_at"]
        before_seq = self.store.last_seq()
        original_insert = self.store._insert

        def fail_message(conversation_id, type, data, client_id, at):
            if type == "message.user":
                raise sqlite3.OperationalError("forced failure")
            return original_insert(conversation_id, type, data, client_id, at)

        with patch.object(self.store, "_insert", side_effect=fail_message):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.consume_schedule("s1", due, now=due + 1)
        self.assertEqual(self.store.last_seq(), before_seq)
        self.assertEqual(self.store.schedule_runs("s1"), [])
        self.assertEqual(self.store.conversations(), [])
        self.assertEqual(self.store.schedule("s1")["next_run_at"], due)

        conversation, run_id = self.store.consume_schedule("s1", due, now=due + 1)
        self.assertEqual(conversation["source"], "schedule")
        self.assertEqual(conversation["schedule_origin"], {
            "schedule_id": "s1", "run_id": run_id, "name": "晨报", "scheduled_at": due,
        })
        history = self.store.history(conversation["id"])
        self.assertEqual([event.type for event in history], [
            "conversation.created", "schedule.triggered", "message.user",
        ])
        self.assertEqual(history[-1].data["text"], "独立说明")
        self.assertEqual(history[0].data["schedule_origin"], conversation["schedule_origin"])
        self.assertEqual(self.store.consume_schedule("s1", due + 86400, now=due + 86460), (None, None))
        self.assertEqual(self.store.consume_schedule("s1", due, now=due + 1), (None, None))
        self.assertEqual(len(self.store.conversations()), 1)
        self.store.delete_schedule("s1")
        self.assertEqual(self.store.conversation(conversation["id"])["schedule_origin"], conversation["schedule_origin"])

    def test_once_is_exhausted_but_can_be_renamed_without_reenabling(self):
        detail, _, _ = self.create(kind="once")
        due = detail["next_run_at"]
        self.store.consume_schedule("s1", due, now=due + 1)
        current = self.store.schedule("s1", internal=True)
        self.assertFalse(current["enabled"])
        self.assertIsNone(current["next_run_at"])
        edited = schedule_fields({"name": "已完成"}, current, now=due + 100)
        self.assertEqual(self.store.update_schedule("s1", edited)[0]["name"], "已完成")
        with self.assertRaises(InvalidSchedule):
            schedule_fields({"enabled": True}, self.store.schedule("s1", internal=True), now=due + 100)

    def test_missed_range_bounded_recovery_and_current_boundary(self):
        detail, _, _ = self.create()
        first = detail["next_run_at"]
        cutoff = stamp("2034-01-01T00:00:00")
        self.assertIsNone(self.store.consume_schedule("s1", first + 60, now=cutoff, missed_before=cutoff)[0])
        _, run_id = self.store.consume_schedule("s1", first, now=cutoff, missed_before=cutoff,
                                                missed_reason="gateway_offline")
        runs = self.store.schedule_runs("s1")
        self.assertEqual(len(runs), 1)
        self.assertEqual((runs[0]["id"], runs[0]["scheduled_at"], runs[0]["missed_before"]),
                         (run_id, first, cutoff))
        self.assertEqual(runs[0]["reason"], "gateway_offline")
        self.assertEqual(self.store.schedule("s1")["next_run_at"], cutoff)
        self.assertEqual(self.store.conversations(), [])
        conversation, _ = self.store.consume_schedule("s1", cutoff, now=cutoff + 59)
        self.assertIsNotNone(conversation)
        self.assertEqual(self.store.schedule_runs("s1")[0]["status"], "running")

    def test_live_poll_merges_past_minute_but_runs_current_one(self):
        fields = schedule_fields({
            "name": "频繁", "content": "执行", "timezone": "Etc/UTC",
            "rule": {"kind": "cron", "expression": "* * * * *"},
        }, now=stamp("2023-01-01T00:00:00"))
        detail, _, _ = self.store.create_schedule("minute", "a", fields, "minute-create")
        delivered = []
        gateway = Gateway(self.store)
        gateway.manager = type("Manager", (), {
            "interrupt": lambda self, prompt, task_id, *, agent_name: delivered.append(
                (prompt, task_id, agent_name)
            ),
        })()
        due = detail["next_run_at"]
        with patch("wandrun.gateway.service.time.time", return_value=due + 60):
            gateway._consume_due(due + 60, recovery=False)
        runs = self.store.schedule_runs("minute")
        self.assertEqual([(run["status"], run["scheduled_at"]) for run in runs],
                         [("running", due + 60), ("missed", due)])
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0][0::2], ("执行", "a"))
        with patch("wandrun.gateway.service.time.time", return_value=due + 60):
            gateway._consume_due(due + 60, recovery=False)
        self.assertEqual(len(delivered), 1)

    def test_recovery_fails_unsettled_run_without_replaying_it(self):
        detail, _, _ = self.create()
        due = detail["next_run_at"]
        self.store.consume_schedule("s1", due, now=due + 1)
        self.store.recover_schedule_runs(now=due + 120)
        self.assertEqual(self.store.schedule_runs("s1")[0]["reason"], "gateway_restarted")
        self.assertEqual(self.store.consume_schedule("s1", due, now=due + 120), (None, None))

    def test_clock_advancing_during_batch_does_not_execute_late_schedule(self):
        first, _, _ = self.create(identity="first", client_id="first")
        self.create(identity="second", client_id="second")
        due = first["next_run_at"]
        clock = [due + 59]
        gateway = Gateway(self.store)

        class Manager:
            def interrupt(self, prompt, task_id, *, agent_name):
                clock[0] = due + 61

        gateway.manager = Manager()
        with patch("wandrun.gateway.service.time.time", side_effect=lambda: clock[0]):
            gateway._consume_due(due + 59, recovery=False)
        self.assertEqual(self.store.schedule_runs("first")[0]["status"], "running")
        missed = self.store.schedule_runs("second")[0]
        self.assertEqual((missed["status"], missed["reason"], missed["conversation_id"]),
                         ("missed", "late", None))
        self.assertEqual(len(self.store.conversations()), 1)

    def test_consumed_once_stays_ended_across_dst_and_clock_rollback(self):
        fields = schedule_fields({
            "name": "重复小时", "content": "执行", "timezone": "Europe/Berlin",
            "rule": {"kind": "once", "local_at": "2026-10-25T02:30"},
        }, now=stamp("2026-10-24T00:00:00"))
        detail, _, _ = self.store.create_schedule("fold", "a", fields, "fold")
        due = detail["next_run_at"]
        self.store.consume_schedule("fold", due, now=due + 1)
        for now in (stamp("2026-10-25T01:15:00"), due - 3600):
            with self.subTest(now=now), patch("wandrun.gateway.store.time.time", return_value=now):
                self.assertTrue(self.store.schedule("fold")["ended"])
        changed = schedule_fields({"rule": {"kind": "once", "local_at": "2026-10-26T02:30"}},
                                  self.store.schedule("fold", internal=True), now=due + 1)
        with patch("wandrun.gateway.store.time.time", return_value=due + 1):
            self.assertFalse(self.store.update_schedule("fold", changed)[0]["ended"])

    def test_retention_does_not_reset_processed_boundary_and_deletion_unlinks(self):
        detail, _, _ = self.create()
        due = detail["next_run_at"]
        for _ in range(110):
            self.store.consume_schedule("s1", due, now=due + 120,
                                        missed_before=due + 60, missed_reason="late")
            due = self.store.schedule("s1")["next_run_at"]
        runs = self.store.schedule_runs("s1", limit=200)
        self.assertEqual(len(runs), 100)
        self.assertEqual(runs[-1]["scheduled_at"], detail["next_run_at"] + 10 * 86400)
        self.assertGreaterEqual(self.store.schedule("s1", internal=True)["processed_through"], runs[0]["scheduled_at"])
        changed = schedule_fields({"rule": {"kind": "daily", "time": "00:01"}},
                                  self.store.schedule("s1", internal=True), now=detail["next_run_at"])
        self.assertGreater(changed["next_run_at"], runs[0]["scheduled_at"])
        conversation, _ = self.store.consume_schedule("s1", due, now=due + 1)
        self.store.begin_delete(conversation["id"], {conversation["id"]})
        self.store.finish_delete(conversation["id"])
        self.assertIsNone(self.store.schedule_runs("s1")[0]["conversation_id"])
        self.store.begin_delete_agent("a")
        self.store.finish_delete_agent("a")
        self.assertIsNone(self.store.schedule("s1"))
        self.assertEqual(self.store.deleted_schedule_event("s1").data["op"], "deleted")


class ScheduleHttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = GatewayStore(Path(directory.name) / "gateway.sqlite")
        self.addCleanup(store.close)
        store.import_agents(AgentCatalog(None, {"a": AgentDefinition(
            description="A", system_prompt="Do work", model="offline", environment="local",
        )}))
        self.gateway = Gateway(store)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
                                        base_url="http://test", headers={"Authorization": "Bearer secret"})
        self.addAsyncCleanup(self.client.aclose)

    def start_scheduled(self, identity, run):
        fields = schedule_fields({
            "name": identity, "content": "执行", "timezone": "Etc/UTC",
            "rule": {"kind": "daily", "time": "00:00"},
        }, now=stamp("2023-01-01T00:00:00"))
        detail, _, _ = self.gateway.store.create_schedule(identity, "a", fields, identity)
        conversation, _ = self.gateway.store.consume_schedule(
            identity, detail["next_run_at"], now=detail["next_run_at"] + 1,
        )
        manager = WorkerManager(run, agent_workers={"a": ()}, default_agent="a",
                                on_task=self.gateway.on_task, notify_human_of_roots=False)
        self.gateway.manager = manager
        self.addAsyncCleanup(manager.close)
        manager.interrupt("执行", conversation["id"], agent_name="a")
        return manager, conversation["id"]

    async def test_waiting_root_stop_and_shutdown_settle_once(self):
        for action in ("cancel", "close"):
            with self.subTest(action=action):
                next_step = ["wait"]

                async def run(prompts, identity):
                    return AgentOutput(messages=[], next=next_step[0])

                manager, root = self.start_scheduled(action, run)
                await manager.wait(root)
                self.assertEqual(self.gateway.store.schedule_runs(action)[0]["status"], "running")
                if action == "cancel":
                    await manager.cancel(root)
                else:
                    await manager.close()
                self.assertEqual(self.gateway.store.schedule_runs(action)[0]["status"], "cancelled")
                if action == "cancel":
                    next_step[0] = "done"
                    manager.start("人工继续", root)
                    await manager.wait(root)
                    self.assertEqual(self.gateway.store.schedule_runs(action)[0]["status"], "cancelled")
                self.gateway.store.recover_schedule_runs(now=stamp("2026-10-10T00:00:00"))
                self.assertEqual(self.gateway.store.schedule_runs(action)[0]["status"], "cancelled")

    async def test_followup_before_done_callback_preserves_initial_terminal_result(self):
        gate = asyncio.Event()
        calls = 0

        async def run(prompts, identity):
            nonlocal calls
            calls += 1
            if calls > 1:
                await gate.wait()
                raise RuntimeError("later user turn failed")
            return AgentOutput(messages=[], next="done")

        manager, root = self.start_scheduled("race", run)
        await asyncio.sleep(0)  # Task 已返回；其排队的 done 回调尚未执行。
        self.assertEqual(manager.get(root)["status"], "completed")
        manager.start("人工继续", root)
        self.assertEqual(self.gateway.store.schedule_runs("race")[0]["status"], "completed")
        self.assertEqual(self.gateway.store.conversation(root)["status"], "working")
        gate.set()
        await manager.wait(root)
        self.assertEqual(manager.get(root)["status"], "failed")
        self.assertEqual(self.gateway.store.schedule_runs("race")[0]["status"], "completed")

    async def test_failed_run_reason_and_turn_event_do_not_expose_manager_diagnostic(self):
        async def run(prompts, identity):
            raise TimeoutError("private upstream trace")

        manager, root = self.start_scheduled("failed", run)
        await manager.wait(root)
        self.assertEqual(manager.get(root)["status"], "failed")
        self.assertIn("private upstream trace", manager.get(root)["error"])
        record = self.gateway.store.schedule_runs("failed")[0]
        self.assertEqual(record["status"], "failed")
        self.assertIn("超时", record["reason"])
        self.assertNotIn("private upstream trace", record["reason"])
        events = self.gateway.store.history(root)
        failed = next(event for event in events if event.type == "turn.failed")
        self.assertIn("超时", failed.data["error"])
        self.assertNotIn("private upstream trace", str([event.to_dict() for event in events]))

    async def test_unknown_computer_timezone_keeps_listing_and_explicit_creation_available(self):
        payload = {"client_id": "zone", "name": "任务", "content": "执行",
                   "rule": {"kind": "daily", "time": "08:00"}}
        with patch("wandrun.gateway.schedules.get_localzone_name",
                   side_effect=ZoneInfoNotFoundError("conflicting local zone")):
            listed = await self.client.get("/agents/a/schedules")
            self.assertEqual(listed.status_code, 200)
            self.assertIsNone(listed.json()["default_timezone"])
            self.assertEqual((await self.client.post("/agents/a/schedules", json=payload)).status_code, 400)
            payload["timezone"] = "Etc/UTC"
            self.assertEqual((await self.client.post("/agents/a/schedules", json=payload)).status_code, 201)

    async def test_startup_boundary_and_stop_before_next_poll(self):
        fields = schedule_fields({
            "name": "每分钟", "content": "执行", "timezone": "Etc/UTC",
            "rule": {"kind": "cron", "expression": "* * * * *"},
        }, now=stamp("2023-01-01T00:00:00"))
        detail, _, _ = self.gateway.store.create_schedule("minute", "a", fields, "minute-create")
        delivered = []
        self.gateway.manager = type("Manager", (), {
            "interrupt": lambda self, prompt, task_id, *, agent_name: delivered.append(task_id),
        })()
        with patch("wandrun.gateway.service.time.time", return_value=detail["next_run_at"]):
            self.gateway.start_schedules()
            await asyncio.sleep(0)
            await self.gateway.stop_schedules()
        self.assertEqual(len(delivered), 1)
        self.assertEqual(self.gateway.store.schedule_runs("minute")[0]["status"], "running")

    async def test_loop_failure_fails_gateway_instead_of_dying_silently(self):
        self.gateway.manager = object()
        self.gateway.start_schedules()
        with patch.object(self.gateway.store, "due_schedules", side_effect=sqlite3.OperationalError("disk")):
            failure = await asyncio.wait_for(self.gateway.wait_failure(), 2)
            self.assertIn("disk", str(failure.__cause__))
            with self.assertRaises(type(failure)):
                await self.gateway.stop_schedules()

    async def test_deleting_conversation_cancels_unsettled_schedule_run_and_unlinks_it(self):
        fields = schedule_fields({
            "name": "任务", "content": "执行", "timezone": "Etc/UTC",
            "rule": {"kind": "daily", "time": "00:00"},
        }, now=stamp("2023-01-01T00:00:00"))
        detail, _, _ = self.gateway.store.create_schedule("daily", "a", fields, "daily-create")
        due = detail["next_run_at"]
        conversation, _ = self.gateway.store.consume_schedule("daily", due, now=due + 1)

        class Manager:
            def snapshot(self):
                return {"closed": False}

            def branch_threads(self, root):
                return {root}

            async def cancel(self, root):
                return {"stopped": [root]}

            def forget_stopped_root(self, root):
                pass

        class Checkpointer:
            async def aget_tuple(self, config):
                return None

            async def adelete_thread(self, identity):
                pass

        self.gateway.manager = Manager()
        self.gateway.checkpointer = Checkpointer()
        await self.gateway.delete_conversation(conversation["id"])
        run = self.gateway.store.schedule_runs("daily")[0]
        self.assertEqual((run["status"], run["reason"], run["conversation_id"]),
                         ("cancelled", "conversation_deleted", None))

    async def test_crud_replay_validation_and_page_contract(self):
        payload = {"client_id": "one", "name": "名字", "content": "指令", "timezone": "Etc/UTC",
                   "rule": {"kind": "once", "local_at": "2099-01-01T00:00"}}
        created = await self.client.post("/agents/a/schedules", json=payload)
        self.assertEqual(created.status_code, 201)
        detail = created.json()["schedule"]
        schedule_id = detail["id"]
        self.assertNotIn("processed_through", detail)
        self.assertEqual((await self.client.post("/agents/a/schedules", json=payload)).json()["replayed"], True)
        self.assertEqual((await self.client.get("/schedules/" + schedule_id)).json(), detail)
        listing = (await self.client.get("/agents/a/schedules")).json()
        self.assertEqual(listing["schedules"], [detail])
        self.assertIn("default_timezone", listing)
        self.assertIn("as_of_seq", listing)
        no_op = await self.client.patch("/schedules/" + schedule_id, json={"name": "名字"})
        self.assertIsNone(no_op.json()["event"])
        self.assertEqual((await self.client.get("/schedules/" + schedule_id + "/runs?limit=0")).status_code, 400)
        self.assertEqual((await self.client.get("/schedules/" + schedule_id + "/runs")).json()["runs"], [])
        invalid = await self.client.patch("/schedules/" + schedule_id, json={"next_run_at": 1})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual((await self.client.get("/schedules/" + schedule_id)).json(), detail)
        deleted = await self.client.delete("/schedules/" + schedule_id)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual((await self.client.delete("/schedules/" + schedule_id)).json(), deleted.json())
        self.assertEqual((await self.client.get("/schedules/" + schedule_id)).status_code, 404)
        self.assertEqual((await self.client.post("/agents/a/schedules", json=payload)).json()["schedule"], detail)
