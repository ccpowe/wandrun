"""Agent 定义的持久编辑、命令重放与跨库删除恢复。"""

import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.store import ClientIdConflict, GatewayStore, UnknownAgent
from wandrun.runtime.memory import MemoryStore


def definition(**changes) -> AgentDefinition:
    return replace(
        AgentDefinition(
            description="说明", system_prompt="提示", model="offline", environment="local",
        ),
        **changes,
    )


class AgentPersistenceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "gateway.sqlite"

    def test_empty_import_is_persistent_and_cannot_be_repeated(self):
        with closing(GatewayStore(self.path)) as store:
            self.assertFalse(store.has_imported_agents())
            store.import_agents(AgentCatalog(None, {}))
            self.assertTrue(store.has_imported_agents())
            self.assertFalse(store.has_agents())
            self.assertEqual(store.agent_catalog(), AgentCatalog(None, {}))
        with closing(GatewayStore(self.path)) as store:
            self.assertTrue(store.has_imported_agents())
            with self.assertRaises(RuntimeError):
                store.import_agents(AgentCatalog("new", {"new": definition()}))
            self.assertFalse(store.has_agents())

    def test_failed_import_rolls_back_marker_and_definitions(self):
        with closing(GatewayStore(self.path)) as store:
            broken = AgentCatalog("bad", {"bad": definition(workers=("missing",))})
            with self.assertRaises(sqlite3.IntegrityError):
                store.import_agents(broken)
            self.assertFalse(store.has_imported_agents())
            self.assertFalse(store.has_agents())
            store.import_agents(AgentCatalog("good", {"good": definition(name="显示")}))
            self.assertEqual(store.agent_catalog().agents["good"].name, "显示")

    def test_default_avatar_starts_at_zero_in_empty_catalog(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog(None, {}))
            created, _, _ = store.create_agent("first", definition(), "首个", None, "first")
            self.assertEqual(created["avatar"], 0)

    def test_import_rotates_avatars_in_catalog_order_and_keeps_them_after_restart(self):
        identities = [f"a{i}" for i in range(11)]
        catalog = AgentCatalog(identities[0], {identity: definition() for identity in identities})
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(catalog)
            self.assertEqual([store.agent(identity)["avatar"] for identity in identities],
                             [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2])
        with closing(GatewayStore(self.path)) as store:
            self.assertEqual([agent["avatar"] for agent in store.agents()],
                             [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2])

    def test_default_avatar_balances_current_usage_and_explicit_choice_stays_explicit(self):
        identities = [f"a{i}" for i in range(10)]
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("a0", {identity: definition() for identity in identities}))
            first, _, _ = store.create_agent("first", definition(), "首个", None, "first")
            second, _, _ = store.create_agent("second", definition(), "次个", None, "second")
            self.assertEqual((first["avatar"], second["avatar"]), (2, 3))
            explicit, _, _ = store.create_agent("explicit", definition(), "指定", 7, "explicit")
            self.assertEqual(explicit["avatar"], 7)
        with closing(GatewayStore(self.path)) as store:
            continued, _, _ = store.create_agent("continued", definition(), "继续", None, "continued")
            self.assertEqual(continued["avatar"], 4)
            store.begin_delete_agent("a5")
            store.finish_delete_agent("a5")
            reused, _, _ = store.create_agent("reused", definition(), "复用", None, "reused")
            self.assertEqual(reused["avatar"], 5)
            self.assertEqual(store.replay_create_agent("first")[0]["avatar"], 2)

    def test_avatar_values_outside_eight_choices_do_not_change_store(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            for index, avatar in enumerate((-1, 8, True, 1.5, "2")):
                with self.subTest(avatar=avatar), self.assertRaisesRegex(ValueError, "avatar"):
                    store.create_agent(f"bad{index}", definition(), "坏头像", avatar, f"bad{index}")
                self.assertIsNone(store.replay_create_agent(f"bad{index}"))
                with self.subTest(avatar=avatar, method="update"), self.assertRaisesRegex(ValueError, "avatar"):
                    store.update_agent("root", definition(), "改名", avatar)
            self.assertEqual(store.agent("root")["avatar"], 0)
            self.assertEqual(store.last_seq(), 0)

    def test_create_replay_retains_original_result_after_edit_and_delete_across_restart(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            first, created, is_new = store.create_agent(
                "custom", definition(workers=("root",), skills=("检索",)), "小助手", 3, "create-1"
            )
            self.assertTrue(is_new)
            self.assertEqual((first["name"], first["avatar"], first["workers"]), ("小助手", 3, ["root"]))
            self.assertEqual(created.data, {"kind": "agent", "id": "custom", "op": "created"})
            self.assertEqual(store.agent_catalog().agents["custom"].name, "小助手")
            self.assertEqual(store.replay_create_agent("create-1"), (first, created))
            changed, event = store.update_agent(
                "custom", definition(skills=("改过",)), "新名字", 4
            )
            self.assertEqual((changed["name"], changed["workers"]), ("新名字", []))
            self.assertEqual(event.data["op"], "updated")
            store.begin_delete_agent("custom")
            deleted = store.finish_delete_agent("custom")
            self.assertEqual(deleted.data, {"kind": "agent", "id": "custom", "op": "deleted"})
            self.assertIsNone(store.agent("custom"))
            self.assertEqual(store.replay_create_agent("create-1"), (first, created))
        with closing(GatewayStore(self.path)) as store:
            self.assertEqual(store.replay_create_agent("create-1"), (first, created))
            self.assertEqual(store.create_agent("another", definition(), "其他", 0, "create-1"), (first, created, False))
            self.assertEqual(store.deleted_agent_event("custom"), deleted)
            self.assertEqual(store.finish_delete_agent("custom"), deleted)
            self.assertEqual([e.seq for e in store.after(0)], [created.seq, event.seq, deleted.seq])
            with self.assertRaises(ValueError):
                store.create_agent("custom", definition(), "再次", 0, "create-2")
            self.assertIsNone(store.replay_create_agent("create-2"))

    def test_create_client_id_conflict_with_other_commands(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            conversation, _ = store.create_conversation("标题", "root")
            store.append(conversation["id"], "message.user", {"text": "你好"}, client_id="message-1")
            with self.assertRaises(ClientIdConflict):
                store.replay_create_agent("message-1")
            with self.assertRaises(ClientIdConflict):
                store.create_agent("new", definition(), "新人", 0, "message-1")
            self.assertIsNone(store.agent("new"))

    def test_update_changes_worker_order_and_same_values_do_not_emit_event(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("a", {
                "a": definition(workers=("b", "c")), "b": definition(), "c": definition(),
            }))
            before = store.last_seq()
            same, event = store.update_agent("a", definition(workers=("b", "c")), "a", 0)
            self.assertIsNone(event)
            self.assertEqual(same, store.agent("a"))
            self.assertEqual(store.last_seq(), before)
            edited, event = store.update_agent(
                "a", definition(workers=("c", "b"), name="新名字", skills=("新技能",)), "新名字", 2
            )
            self.assertEqual(edited["workers"], ["c", "b"])
            self.assertEqual(store.agent("c")["member_of"], ["a"])
            self.assertEqual(store.agent_catalog().agents["a"].workers, ("c", "b"))
            self.assertEqual(store.agent_catalog().agents["a"].name, "新名字")
            self.assertEqual(event.data["op"], "updated")
            _, same_event = store.update_agent(
                "a", definition(workers=("c", "b"), name="新名字", skills=("新技能",)), "新名字", 2
            )
            self.assertIsNone(same_event)
            self.assertEqual(store.after(before), [event])
            with self.assertRaises(ValueError):
                store.update_agent("a", definition(environment="other", workers=("c", "b")), "a", 2)
            self.assertEqual(store.agent("a"), edited)

    def test_invalid_worker_rolls_back_update_and_create(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            with self.assertRaises(sqlite3.IntegrityError):
                store.create_agent("bad", definition(workers=("missing",)), "bad", 0, "c1")
            self.assertIsNone(store.agent("bad"))
            self.assertIsNone(store.replay_create_agent("c1"))
            with self.assertRaises(sqlite3.IntegrityError):
                store.update_agent("root", definition(description="变化", workers=("missing",)), "改名", 1)
            self.assertEqual(store.agent("root")["name"], "root")
            self.assertEqual(store.agent("root")["description"], "说明")
            self.assertEqual(store.last_seq(), 0)

    def test_memory_authorship_persists_per_scope_and_work_cascades_on_delete(self):
        memory = MemoryStore(self.path.parent / "memory")
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            work = memory.save("root", "工作", memory.read("root").version)
            profile = memory.save(None, "画像", memory.read(None).version)
            store.record_memory_change("root", work.version, "user", None)
            store.record_memory_change(None, profile.version, "agent", None, writer_agent_id="root")
            self.assertEqual(store.memory_author("root", work.version), "user")
            self.assertEqual(store.memory_author(None, profile.version), "agent")
        with closing(GatewayStore(self.path)) as store:
            self.assertEqual(store.memory_author(None, profile.version), "agent")
            changed = memory.save("root", "新的工作", work.version)
            self.assertIsNone(store.memory_author("root", changed.version))
            store.begin_delete_agent("root")
            memory.delete("root")
            store.finish_delete_agent("root")
            self.assertEqual(store._connection.execute(
                "SELECT COUNT(*) FROM memory_metadata WHERE scope = 'work'"
            ).fetchone()[0], 0)
            self.assertEqual(store.memory_author(None, profile.version), "agent")
            self.assertEqual(memory.read(None).content, "画像")

    def test_memory_metadata_and_both_events_roll_back_together(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            root, _ = store.create_conversation("记忆", "root")
            before = store.last_seq()
            original = store._insert

            def fail_second_event(conversation_id, event_type, data, client_id, at):
                if event_type == "memory.updated":
                    raise sqlite3.OperationalError("disk full")
                return original(conversation_id, event_type, data, client_id, at)

            with patch.object(store, "_insert", side_effect=fail_second_event):
                with self.assertRaises(sqlite3.OperationalError):
                    store.record_memory_change(None, "v", "agent", root["id"], writer_agent_id="root")
            self.assertIsNone(store.memory_author(None, "v"))
            self.assertEqual(store.last_seq(), before)
            self.assertEqual([e.type for e in store.history(root["id"])], ["conversation.created"])

    def test_profile_event_keeps_actual_writer_and_never_invents_resource_id(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            root, _ = store.create_conversation("记忆", "root")
            cursor = store.last_seq()
            store.record_memory_change(None, "v", "agent", root["id"], writer_agent_id="root")
            self.assertEqual([(e.type, e.data) for e in store.after(cursor)], [
                ("resource.changed", {"kind": "memory", "scope": "profile", "op": "updated"}),
                ("memory.updated", {
                    "scope": "profile", "agent_id": "root", "version": "v", "summary": "已记住",
                }),
            ])

    def test_delete_intent_survives_restart_and_finishes_only_without_references(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {
                "root": definition(workers=("member",)), "member": definition(workers=("leaf",)),
                "leaf": definition(),
            }))
            store.begin_delete_agent("member")
            store.begin_delete_agent("member")
            with self.assertRaises(sqlite3.IntegrityError):
                store.finish_delete_agent("member")
            self.assertTrue(store.agent_deleting("member"))
            self.assertEqual(store.agent("member")["workers"], ["leaf"])
            self.assertEqual(store.pending_agent_deletions(), ["member"])
        with closing(GatewayStore(self.path)) as store:
            store.update_agent("root", definition(workers=()), "root", 0)
            conversation, _ = store.create_conversation("旧对话", "member")
            with self.assertRaises(RuntimeError):
                store.finish_delete_agent("member")
            store.begin_delete(conversation["id"], {conversation["id"]})
            store.finish_delete(conversation["id"])
            deleted = store.finish_delete_agent("member")
            self.assertEqual(deleted.data["op"], "deleted")
            self.assertEqual(store.agent("leaf")["member_of"], [])
            self.assertEqual(store.pending_agent_deletions(), [])
            self.assertFalse(store.agent_deleting("member"))
            with self.assertRaises(UnknownAgent):
                store.begin_delete_agent("member")
        with closing(GatewayStore(self.path)) as store:
            self.assertEqual(store.deleted_agent_event("member"), deleted)
            self.assertEqual(store.finish_delete_agent("member"), deleted)

    def test_delete_main_clears_setting_and_empty_catalog_does_not_reimport(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("only", {"only": definition()}))
            store.begin_delete_agent("only")
            store.finish_delete_agent("only")
            self.assertEqual(store.agent_catalog(), AgentCatalog(None, {}))
        with closing(GatewayStore(self.path)) as store:
            self.assertTrue(store.has_imported_agents())
            with self.assertRaises(RuntimeError):
                store.import_agents(AgentCatalog("other", {"other": definition()}))
            self.assertEqual(store.agent_catalog(), AgentCatalog(None, {}))

    def test_event_failure_rolls_back_create_update_and_finish_delete(self):
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("root", {"root": definition()}))
            with patch.object(store, "_resource_changed", side_effect=sqlite3.OperationalError("disk full")):
                with self.assertRaises(sqlite3.OperationalError):
                    store.create_agent("new", definition(), "名字", 1, "c1")
            self.assertIsNone(store.agent("new"))
            self.assertIsNone(store.replay_create_agent("c1"))
            with patch.object(store, "_resource_changed", side_effect=sqlite3.OperationalError("disk full")):
                with self.assertRaises(sqlite3.OperationalError):
                    store.update_agent("root", definition(description="变化"), "名字", 1)
            self.assertEqual(store.agent("root")["name"], "root")
            store.begin_delete_agent("root")
            with patch.object(store, "_resource_changed", side_effect=sqlite3.OperationalError("disk full")):
                with self.assertRaises(sqlite3.OperationalError):
                    store.finish_delete_agent("root")
            self.assertTrue(store.agent_deleting("root"))
            self.assertIsNotNone(store.agent("root"))
            self.assertEqual(store.agent_catalog().main_agent, "root")
            self.assertIsNone(store.deleted_agent_event("root"))
            self.assertEqual(store.last_seq(), 0)
