import asyncio
import sqlite3
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch
from pathlib import Path
from typing import TypedDict
from types import SimpleNamespace

import httpx
from langchain.messages import AIMessage
from langgraph.checkpoint.base import empty_checkpoint
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import StateGraph, START

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.app import ensure_agents, exit_message, reporting_failure, run_server, serve
from wandrun.gateway.http import create_app, stream_cursor
from wandrun.gateway.service import Gateway, GatewayFailure
from wandrun.gateway.store import ClientIdConflict, GatewayStore, InvalidReadPosition, UnknownAgent
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.scheduler_store import SchedulerStore
from wandrun.runtime.session import Runtime
from wandrun.runtime.workers import WorkerManager
from wandrun.runtime.workspace import Workspace

from test_gateway_models import subscription_fixture
from codex_test_home import isolate_codex_home


def temp_dir(case: unittest.TestCase) -> Path:
    directory = tempfile.TemporaryDirectory()
    case.addCleanup(directory.cleanup)
    return Path(directory.name)


def agent(description: str = "测试 Agent", **kwargs) -> AgentDefinition:
    return AgentDefinition(
        description=description, system_prompt="完成任务。", model="offline", environment="local", **kwargs
    )


def sample_catalog() -> AgentCatalog:
    """c 委派 a、d；a 委派 b；main 不委派任何人，也不被委派。b 从 main 出发不可达。"""
    return AgentCatalog(
        main_agent="main",
        agents={
            "main": agent("入口"),
            "a": agent("A", workers=("b",)),
            "b": agent("B"),
            "c": agent("C", workers=("a", "d")),
            "d": agent("D"),
        },
    )


def open_store(case: unittest.TestCase, path: Path, *, seeded: bool = True) -> GatewayStore:
    store = GatewayStore(path)
    case.addCleanup(store.close)
    if seeded:
        store.import_agents(sample_catalog())
    return store


def gateway_manager(gateway: Gateway, run, **kwargs) -> WorkerManager:
    """与网关入口相同的接法：生命周期观察者 + 关闭根任务的运行时通知。"""
    catalog = sample_catalog()
    kwargs.setdefault("agent_workers", {name: agent.workers for name, agent in catalog.agents.items()})
    kwargs.setdefault("default_agent", catalog.main_agent)
    kwargs.setdefault("on_preview", gateway.on_preview)
    kwargs.setdefault("on_task_created", gateway.on_task_created)
    kwargs.setdefault("on_task_message", gateway.on_task_message)
    manager = WorkerManager(
        run, on_human=gateway.on_human, on_task=gateway.on_task, notify_human_of_roots=False, **kwargs
    )
    gateway.attach(manager)
    return manager


class GatewayStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = open_store(self, temp_dir(self) / "gateway.sqlite")

    def test_seq_is_global_and_history_pages_backwards(self):
        first, _ = self.store.create_conversation("一", "main")
        second, _ = self.store.create_conversation("二", "main")
        for index in range(3):
            self.store.append(first["id"], "message.user", {"text": f"a{index}"})
        self.store.append(second["id"], "message.user", {"text": "b"})
        seqs = [event.seq for event in self.store.after(0)]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), 6)  # 2 个 conversation.created + 4 条消息
        newest = self.store.history(first["id"], limit=2)
        self.assertEqual([e.data["text"] for e in newest], ["a1", "a2"])
        older = self.store.history(first["id"], before=newest[0].seq, limit=2)
        self.assertEqual([e.data.get("text") for e in older], [None, "a0"])

    def test_client_id_replays_and_rejects_reuse(self):
        conversation, _ = self.store.create_conversation("新对话", "main")
        event, created = self.store.append(conversation["id"], "message.user", {"text": "hi"}, client_id="c1")
        again, created_again = self.store.append(conversation["id"], "message.user", {"text": "x"}, client_id="c1")
        self.assertTrue(created)
        self.assertFalse(created_again)
        self.assertEqual(again, event)
        with self.assertRaises(ClientIdConflict):
            self.store.append(conversation["id"], "turn.stopped", {}, client_id="c1")

    def test_read_position_moves_forward_within_existing_events(self):
        conversation, _ = self.store.create_conversation("新对话", "main")
        reply, _ = self.store.append(conversation["id"], "message.agent", {"text": "完成了"})
        self.assertTrue(self.store.conversation(conversation["id"])["unread"])
        with self.assertRaises(InvalidReadPosition):
            self.store.mark_read(conversation["id"], reply.seq + 1000)
        self.assertIsNotNone(self.store.mark_read(conversation["id"], reply.seq))
        self.assertIsNone(self.store.mark_read(conversation["id"], reply.seq - 1))
        self.assertFalse(self.store.conversation(conversation["id"])["unread"])
        self.store.append(conversation["id"], "message.agent", {"text": "又一条"})
        self.assertTrue(self.store.conversation(conversation["id"])["unread"])

    def test_status_column_and_event_change_together(self):
        conversation, _ = self.store.create_conversation("新对话", "main")
        self.assertEqual(conversation["status"], "idle")
        self.assertIsNone(self.store.set_status(conversation["id"], "idle"))
        event = self.store.set_status(conversation["id"], "working")
        self.assertEqual((event.type, event.data), ("conversation.status", {"status": "working"}))
        self.assertEqual(self.store.conversation(conversation["id"])["status"], "working")


class AgentStoreTests(unittest.TestCase):
    def test_import_keeps_every_definition_field_and_workers_order(self):
        store = open_store(self, temp_dir(self) / "gateway.sqlite", seeded=False)
        self.assertFalse(store.has_agents())
        full = AgentDefinition(
            description="全字段", system_prompt="提示", model="m", reasoning_effort="high",
            context_window=128000, compaction_keep_tokens=10000, compaction_model="summary",
            mcp_servers=("x", "y"), searchable_mcp_servers=("z",), workers=("w2", "w1"),
            skills=("s",), code_mode=True, environment="remote",
        )
        catalog = AgentCatalog(
            "boss", {"boss": full, "w1": agent("一"), "w2": agent("二")}
        )
        store.import_agents(catalog)
        self.assertEqual(store.agent_catalog(), catalog)  # 含 workers 的顺序
        detail = store.agent("boss")
        self.assertEqual(
            (detail["context_window"], detail["compaction_keep_tokens"], detail["compaction_model"]),
            (128000, 10000, "summary"),
        )
        listed = store.agents()
        self.assertEqual([item["id"] for item in listed], ["boss", "w1", "w2"])
        self.assertEqual(listed[0]["name"], "boss")  # 名字初始等于 id
        self.assertEqual(listed[0]["workers"], ["w2", "w1"])

    def test_import_into_non_empty_library_is_refused_and_changes_nothing(self):
        store = open_store(self, temp_dir(self) / "gateway.sqlite")
        with self.assertRaises(RuntimeError):
            store.import_agents(AgentCatalog("other", {"other": agent()}))
        self.assertEqual(store.agent_catalog(), sample_catalog())

    def test_failed_import_leaves_no_partial_data(self):
        store = open_store(self, temp_dir(self) / "gateway.sqlite", seeded=False)
        # 委派关系指向不存在的 Agent：Agent 行已写入后才在外键处失败，整个事务必须回滚。
        broken = AgentCatalog("a", {"a": agent(workers=("ghost",)), "b": agent()})
        with self.assertRaises(sqlite3.IntegrityError):
            store.import_agents(broken)
        self.assertFalse(store.has_agents())
        store.import_agents(sample_catalog())  # 回滚后库仍是空的，可以重新导入
        self.assertEqual(store.agent_catalog(), sample_catalog())

    def test_detail_reports_members_by_reverse_lookup_of_workers(self):
        store = open_store(self, temp_dir(self) / "gateway.sqlite")
        self.assertEqual(store.agent("a")["member_of"], ["c"])
        self.assertEqual(store.agent("a")["workers"], ["b"])
        self.assertEqual(store.agent("b")["member_of"], ["a"])  # 只看直接关系，不展开 c 的下属树
        self.assertEqual(store.agent("c")["member_of"], [])
        self.assertIsNone(store.agent("nobody"))

    def test_conversation_needs_an_existing_entry_agent_and_filters_by_it(self):
        store = open_store(self, temp_dir(self) / "gateway.sqlite")
        with self.assertRaises(UnknownAgent):
            store.create_conversation("x", "nobody")
        self.assertEqual(store.after(0), [])  # 拒绝时不留事件
        in_a, created = store.create_conversation("甲", "a")
        in_c, _ = store.create_conversation("乙", "c")
        self.assertEqual(in_a["agent_id"], "a")
        self.assertEqual(created.data["agent_id"], "a")
        self.assertEqual([c["id"] for c in store.conversations("c")], [in_c["id"]])
        self.assertEqual(store.conversations("main"), [])
        self.assertEqual(len(store.conversations()), 2)

    def test_old_schema_version_is_refused(self):
        path = temp_dir(self) / "gateway.sqlite"
        connection = sqlite3.connect(path)
        connection.execute("PRAGMA user_version = 2")
        connection.close()
        with self.assertRaises(RuntimeError):
            GatewayStore(path)


class EnsureAgentsTests(unittest.TestCase):
    def setUp(self):
        self.root = temp_dir(self)
        self.workspace = Workspace(self.root)
        self.workspace.runtime_dir.mkdir()
        self.workspace.environments_config.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
        )
        self.workspace.mcps_config.write_text("[mcp_servers]\n", encoding="utf-8")
        self.store = open_store(self, self.root / "gateway.sqlite", seeded=False)
        self.paths = (
            self.workspace.agents_config, self.workspace.mcps_config, self.workspace.environments_config
        )

    def write_agents(self, extra: str = "") -> None:
        body = 'main_agent = "main"\n'
        for name, workers in (("main", []), ("c", ["a", "d"]), ("a", ["b"]), ("b", []), ("d", [])):
            body += (
                f'[agents.{name}]\ndescription = "{name}"\nsystem_prompt = "p"\nmodel = "offline"\n'
                f"workers = {workers!r}\n".replace("'", '"')
            )
        self.workspace.agents_config.write_text(body + extra, encoding="utf-8")

    def test_first_start_imports_every_agent_including_unreachable_ones(self):
        self.write_agents()
        ensure_agents(self.store, *self.paths)
        catalog = self.store.agent_catalog()
        self.assertEqual(list(catalog.agents), ["main", "c", "a", "b", "d"])  # b 从 main 不可达
        self.assertEqual(catalog.agents["c"].workers, ("a", "d"))
        self.assertEqual(catalog.agents["c"].environment, "local")  # 默认环境在导入时解析
        self.assertEqual(catalog.main_agent, "main")

    def test_later_starts_use_the_database_and_never_read_agents_toml(self):
        self.write_agents()
        ensure_agents(self.store, *self.paths)
        self.workspace.agents_config.write_text("这不是合法的 toml [[[", encoding="utf-8")
        ensure_agents(self.store, *self.paths)  # 读了就会抛错
        self.workspace.agents_config.unlink()
        ensure_agents(self.store, *self.paths)
        self.assertEqual(len(self.store.agents()), 5)

    def test_invalid_config_fails_startup_and_leaves_library_empty(self):
        self.write_agents('[agents.d2]\ndescription = "x"\nsystem_prompt = "p"\nmodel = "m"\nworkers = ["ghost"]\n')
        with self.assertRaisesRegex(ValueError, "ghost"):
            ensure_agents(self.store, *self.paths)
        self.assertFalse(self.store.has_agents())
        self.write_agents()  # 改好后重启即可导入
        ensure_agents(self.store, *self.paths)
        self.assertTrue(self.store.has_agents())


class ServeStartupTests(unittest.IsolatedAsyncioTestCase):
    """网关入口：导入校验与运行时装配用同一组 MCP / 环境文件，外部 --agents-config 也不例外。"""

    def setUp(self):
        isolate_codex_home(self)
        self.root = temp_dir(self)
        self.codex_home = temp_dir(self)
        self.workspace = Workspace(self.root)
        self.workspace.runtime_dir.mkdir()
        self.workspace.environments_config.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
        )
        self.workspace.mcps_config.write_text("[mcp_servers]\n", encoding="utf-8")
        self.external = temp_dir(self)
        (self.external / "agents.toml").write_text(
            'main_agent = "m"\n[agents.m]\ndescription = "d"\nsystem_prompt = "p"\n'
            'model = "offline"\nenvironment = "external"\n', encoding="utf-8"
        )
        # 外部目录里的环境文件，只有显式指定才会被使用。
        (self.external / "environments.toml").write_text(
            'default = "external"\n[environments.external]\ntype = "local"\n', encoding="utf-8"
        )
        (self.external / "mcps.toml").write_text("[mcp_servers]\n", encoding="utf-8")

    async def serve(self, **kwargs):
        class ExitingServer(FakeServer):
            def __init__(self, config, gateway, sockets=None):
                super().__init__()
                self.should_exit = True  # 装配完成后立刻结束

        def subscription(store, **options):
            data, _ = subscription_fixture(self, store)
            return data

        with patch("wandrun.gateway.app._Server", ExitingServer), patch(
            "wandrun.gateway.app.SubscriptionData", subscription
        ):
            await serve(workspace=self.root, token="t", host="127.0.0.1", port=0, codex_home=self.codex_home, **kwargs)

    def stored_agents(self) -> bool:
        store = GatewayStore(self.workspace.state_dir / "gateway.sqlite")
        try:
            return store.has_agents()
        finally:
            store.close()

    async def test_external_agents_config_is_checked_against_the_workspace_environments(self):
        # 外部 agents.toml 引用了只存在于它旁边 environments.toml 的环境：
        # 导入校验不能因为“同目录”而放行，否则装配时才失败并留下坏定义。
        with self.assertRaisesRegex(ValueError, "external"):
            await self.serve(agents_config=self.external / "agents.toml")
        self.assertFalse(self.stored_agents())

    async def test_external_files_given_explicitly_are_used_by_import_and_runtime(self):
        await self.serve(
            agents_config=self.external / "agents.toml",
            mcps_config=self.external / "mcps.toml",
            environments_config=self.external / "environments.toml",
        )
        self.assertTrue(self.stored_agents())
        # 第二次启动不再给 agents.toml，运行时仍用同一组环境文件装配成功。
        await self.serve(
            mcps_config=self.external / "mcps.toml",
            environments_config=self.external / "environments.toml",
        )

    async def test_imported_definitions_stay_when_assembly_later_fails(self):
        await self.serve(
            agents_config=self.external / "agents.toml",
            mcps_config=self.external / "mcps.toml",
            environments_config=self.external / "environments.toml",
        )
        # 之后环境文件被改坏：装配失败，但库是 Agent 的唯一来源，已导入的定义不回滚。
        with self.assertRaisesRegex(ValueError, "external"):
            await self.serve()
        self.assertTrue(self.stored_agents())

    async def test_cancelled_startup_waits_for_deletion_before_closing_runtime(self):
        await self.cancel_during_resumed_deletion(fail=False)

    async def test_cancelled_startup_reports_deletion_failure_during_drain(self):
        await self.cancel_during_resumed_deletion(fail=True)

    async def cancel_during_resumed_deletion(self, *, fail):
        path = self.workspace.state_dir / "gateway.sqlite"
        with closing(GatewayStore(path)) as store:
            store.import_agents(sample_catalog())
            identity = store.create_conversation("待续删", "main")[0]["id"]
            store.begin_delete(identity, {identity})

        entered, release, draining = asyncio.Event(), asyncio.Event(), asyncio.Event()
        instances = []
        original = AsyncSqliteSaver.aget_tuple
        checkpoint_error = OSError("injected startup checkpoint failure")

        class CapturedGateway(Gateway):
            def __init__(self, store, subscription=None, *, oauth_port=8765, public_url=None):
                super().__init__(store, subscription, oauth_port=oauth_port, public_url=public_url)
                instances.append(self)

            async def drain_deletions(self):
                draining.set()
                await super().drain_deletions()

        async def paused_read(checkpointer, *args, **kwargs):
            entered.set()
            await release.wait()
            if fail:
                raise checkpoint_error
            return await original(checkpointer, *args, **kwargs)

        with (
            patch("wandrun.gateway.app.Gateway", CapturedGateway),
            patch.object(AsyncSqliteSaver, "aget_tuple", paused_read),
        ):
            serving = asyncio.create_task(self.serve())
            try:
                await asyncio.wait_for(entered.wait(), 2)
                gateway = instances[0]
                deleting = gateway._deleting[identity]
                serving.cancel()
                await asyncio.wait_for(draining.wait(), 2)
                self.assertFalse(serving.done())
                self.assertFalse(deleting.done())
                self.assertFalse(gateway.manager.snapshot()["closed"])
                self.assertIsNotNone(gateway.store.conversation(identity))
                release.set()
                with self.assertRaises(asyncio.CancelledError) as caught:
                    await asyncio.wait_for(serving, 2)
                self.assertTrue(deleting.done())
                self.assertTrue(gateway.manager.snapshot()["closed"])
                if fail:
                    self.assertIs(gateway.failure.__cause__, checkpoint_error)
                    self.assertIn(
                        str(checkpoint_error), "\n".join(getattr(caught.exception, "__notes__", ()))
                    )
                else:
                    self.assertIsNone(gateway.failure)
                    self.assertEqual(deleting.result().type, "conversation.deleted")
            finally:
                release.set()
                if not serving.done():
                    serving.cancel()
                await asyncio.gather(serving, return_exceptions=True)
                if instances:
                    await instances[0].drain_deletions()

        with closing(GatewayStore(path)) as store:
            if fail:
                self.assertIsNotNone(store.conversation(identity))
                self.assertEqual(store.deletion_threads(identity), [identity])
            else:
                self.assertIsNone(store.conversation(identity))
                self.assertEqual(store.pending_deletions(), [])
                self.assertEqual(store.deleted_event(identity).type, "conversation.deleted")


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = temp_dir(self)
        self.store = open_store(self, self.directory / "gateway.sqlite")
        self.calls: list[list[str]] = []
        self.release = asyncio.Event()
        self.entered = asyncio.Event()
        self.block = False
        self.failing = False

        async def run(prompts, task_id):
            self.calls.append([m.content for m in prompts])
            if self.block:
                self.entered.set()
                await self.release.wait()
            if self.failing:
                raise RuntimeError("模型超时")
            return "done"

        self.run = run
        self.gateway = Gateway(self.store)
        self.manager = gateway_manager(self.gateway, run)
        self.addAsyncCleanup(self.manager.close)
        self.addCleanup(self.gateway.end_streams)
        self.conversation = self.gateway.create_conversation("测试", "main")["id"]

    def statuses(self) -> list[str]:
        return [e.data["status"] for e in self.store.history(self.conversation, limit=100) if e.type == "conversation.status"]

    async def idle(self):
        await asyncio.wait_for(self.manager.wait(self.conversation), 2)
        await asyncio.sleep(0)

    async def test_message_runs_and_conversation_returns_to_idle(self):
        event, created = self.gateway.send_message(self.conversation, "m1", "你好")
        await self.idle()
        self.assertTrue(created)
        self.assertEqual(event.data, {"text": "你好", "attachments": []})
        self.assertEqual(self.calls, [["你好"]])
        self.assertEqual(self.statuses(), ["working", "idle"])
        self.assertEqual(self.store.conversation(self.conversation)["status"], "idle")

    async def test_retried_message_is_executed_once(self):
        first, _ = self.gateway.send_message(self.conversation, "m1", "你好")
        await self.idle()
        again, created = self.gateway.send_message(self.conversation, "m1", "你好")
        self.assertFalse(created)
        self.assertEqual(again.seq, first.seq)
        self.assertEqual(len(self.calls), 1)

    async def test_message_while_working_interrupts_without_leaving_working(self):
        self.block = True
        self.gateway.send_message(self.conversation, "m1", "写一篇文章")
        await asyncio.wait_for(self.entered.wait(), 2)
        self.block = False
        self.gateway.send_message(self.conversation, "m2", "标题短一点")
        await self.idle()
        self.assertEqual(len(self.calls), 2)
        self.assertIn("标题短一点", self.calls[1])
        self.assertEqual(self.statuses(), ["working", "idle"])

    async def test_stop_cancels_and_a_new_message_resumes(self):
        self.block = True
        self.gateway.send_message(self.conversation, "m1", "长任务")
        await asyncio.wait_for(self.entered.wait(), 2)
        stopped, created = await self.gateway.stop(self.conversation, "s1")
        _, replayed = await self.gateway.stop(self.conversation, "s1")
        self.assertTrue(created)
        self.assertFalse(replayed)
        self.assertEqual(stopped.data, {"was_working": True})
        self.assertEqual(self.statuses(), ["working", "idle"])
        self.block = False
        self.gateway.send_message(self.conversation, "m2", "继续")
        await self.idle()
        self.assertEqual(self.manager.get(self.conversation)["status"], "completed")

    async def test_concurrent_stop_with_same_client_id_shares_one_operation(self):
        # 审查：清理期间的重试不能重新读取 was_working（此时已经没有在运行）。
        self.block = True
        self.gateway.send_message(self.conversation, "m1", "长任务")
        await asyncio.wait_for(self.entered.wait(), 2)
        cleanup_started, cleanup_release = asyncio.Event(), asyncio.Event()
        cancel = self.manager.cancel

        async def slow_cancel(task_id):
            result = await cancel(task_id)
            cleanup_started.set()
            await cleanup_release.wait()  # Worker 已结算，清理仍在进行
            return result

        self.manager.cancel = slow_cancel
        first = asyncio.ensure_future(self.gateway.stop(self.conversation, "s1"))
        await asyncio.wait_for(cleanup_started.wait(), 2)
        self.assertFalse(self.gateway._running.get(self.conversation))
        retry = asyncio.ensure_future(self.gateway.stop(self.conversation, "s1"))
        cancelled_retry = asyncio.ensure_future(self.gateway.stop(self.conversation, "s1"))
        await asyncio.sleep(0)
        cancelled_retry.cancel()  # 取消等待者不能取消共享的操作
        await asyncio.sleep(0)
        self.assertFalse(first.done() or retry.done())
        cleanup_release.set()
        (first_event, first_created), (retry_event, retry_created) = await asyncio.wait_for(
            asyncio.gather(first, retry), 2
        )
        self.assertEqual((first_created, retry_created), (True, False))
        self.assertEqual(first_event, retry_event)
        self.assertEqual(first_event.data, {"was_working": True})
        self.assertEqual(sum(e.type == "turn.stopped" for e in self.store.history(self.conversation)), 1)
        self.assertEqual(self.gateway._stopping, {})

    async def test_message_cannot_take_the_client_id_of_a_stop_in_flight(self):
        # 审查 4：停止在清理时还没落盘，另一个对话用同一 ID 发消息必须被拒绝，不能抢走这个 ID。
        cancel = self.manager.cancel
        cleanup = asyncio.Event()

        async def slow_cancel(task_id):
            await cleanup.wait()
            return await cancel(task_id)

        self.manager.cancel = slow_cancel
        other = self.gateway.create_conversation("另一个", "main")["id"]
        self.block = True
        self.gateway.send_message(self.conversation, "m1", "长任务")
        await asyncio.wait_for(self.entered.wait(), 2)
        stopping = asyncio.ensure_future(self.gateway.stop(self.conversation, "shared"))
        await asyncio.sleep(0)
        with self.assertRaises(ClientIdConflict):
            self.gateway.send_message(other, "shared", "抢占")
        cleanup.set()
        stopped, created = await asyncio.wait_for(stopping, 2)
        self.assertTrue(created)
        self.assertEqual(stopped.data, {"was_working": True})
        self.assertEqual(len(self.calls), 1)

    async def test_failure_is_recorded(self):
        self.failing = True
        self.gateway.send_message(self.conversation, "m1", "x")
        await self.idle()
        failed = [e for e in self.store.history(self.conversation) if e.type == "turn.failed"]
        self.assertIn("重试", failed[0].data["error"])
        self.assertNotIn("模型超时", failed[0].data["error"])
        self.assertEqual(self.store.conversation(self.conversation)["status"], "failed")

    async def test_runtime_notification_wakeup_is_tracked_even_if_it_fails_at_once(self):
        # 审查第 2 条：后台命令完成等运行时通知唤醒根任务，没有用户消息也没有工具更新。
        self.gateway.send_message(self.conversation, "m1", "开始")
        await self.idle()
        self.failing = True
        self.manager.notify(self.conversation, {"process_id": "p1", "status": "exited"})
        self.assertEqual(self.store.conversation(self.conversation)["status"], "working")
        await self.idle()
        self.assertEqual(self.statuses(), ["working", "idle", "working", "failed"])
        self.assertEqual(sum(e.type == "turn.failed" for e in self.store.history(self.conversation)), 1)

    async def test_conversation_stays_working_while_members_run(self):
        member_started, member_release = asyncio.Event(), asyncio.Event()

        async def run(prompts, task_id):
            if task_id == "member":
                member_started.set()
                await member_release.wait()
            return "done"

        manager = gateway_manager(self.gateway, run, agent_workers={"lead": ("worker",), "worker": ()}, default_agent="lead")
        self.addAsyncCleanup(manager.close)
        manager.start("任务", self.conversation)
        manager.start("子任务", "member", sender_id=self.conversation, agent_name="worker")
        await asyncio.wait_for(member_started.wait(), 2)
        await manager.wait(self.conversation)
        self.assertEqual(self.store.conversation(self.conversation)["status"], "working")
        member_release.set()
        await manager.wait("member")
        await manager.wait(self.conversation)  # 成员的结束通知把根任务唤起
        await asyncio.sleep(0)
        self.assertEqual(self.store.conversation(self.conversation)["status"], "idle")

    async def test_restart_reconciles_working_conversations(self):
        # 审查第 1 条：重启后对话不能一直显示“工作中”。正常关闭时被取消的任务会报告结算、记为空闲；
        # 进程崩溃则来不及记录，这里关掉观察者来模拟崩溃。
        scheduler = SchedulerStore(self.directory / "scheduler.sqlite")
        self.addCleanup(scheduler.close)
        alive = True
        manager = WorkerManager(
            self.run,
            on_task=lambda *args: alive and self.gateway.on_task(*args),
            notify_human_of_roots=False,
            store=scheduler,
            agent_workers={name: agent.workers for name, agent in sample_catalog().agents.items()},
            default_agent="main",
        )
        self.gateway.attach(manager)
        self.block = True
        self.gateway.send_message(self.conversation, "m1", "长任务")
        await asyncio.wait_for(self.entered.wait(), 2)
        alive = False
        await manager.close()
        self.assertEqual(self.store.conversation(self.conversation)["status"], "working")

        restarted_gateway = Gateway(self.store)
        restored = SchedulerStore(self.directory / "scheduler.sqlite")
        self.addCleanup(restored.close)
        restarted = gateway_manager(restarted_gateway, self.run, store=restored)
        self.addAsyncCleanup(restarted.close)
        self.assertEqual(restarted.get(self.conversation)["status"], "cancelled")
        self.assertEqual(self.store.conversation(self.conversation)["status"], "idle")
        stopped, _ = await restarted_gateway.stop(self.conversation, "s1")
        self.assertEqual(stopped.data, {"was_working": False})

    async def test_on_human_keeps_agent_text_that_looks_like_a_runtime_notice(self):
        # 审查第 5 条：来源由回调边界区分，不再按正文前缀丢弃。
        self.gateway.on_human(self.conversation, '[运行时反馈]\n这是 Agent 在解释格式', [])
        self.gateway.on_human("not-a-gateway-conversation", "终端对话", [])
        agent = [e.data for e in self.store.after(0) if e.type == "message.agent"]
        self.assertEqual(agent[0]["text"], "[运行时反馈]\n这是 Agent 在解释格式")
        self.assertEqual(len(agent), 1)

    async def test_agent_message_that_failed_to_record_is_not_reported_as_delivered(self):
        # 审查 3-1：对 dispatch 来说 on_human 正常返回就是“投递成功”，会写进回执。
        def failing(*args, **kwargs):
            raise OSError("disk I/O error")

        self.store.append_agent_message = failing
        batch = AgentOutput(messages=[SendMessage(to="human", task_id=None, message=t) for t in ("一", "二")], next="wait")
        receipts = self.manager.dispatch(batch, self.conversation)
        self.assertEqual([r["accepted"] for r in receipts], [None, None])  # 第二条：网关已停止，同样不确定
        self.assertIsInstance(self.gateway.failure.__cause__, OSError)

    async def test_command_write_failure_is_fatal_so_a_retry_is_not_resubmitted(self):
        # 审查 3 的判断 2：消息已交给 Manager、事件没写进去；继续服务的话重试会再提交一次。
        with self.assertRaises(InvalidReadPosition):  # 预期的拒绝仍是普通错误，不停服
            self.gateway.mark_read(self.conversation, 10_000)
        self.assertIsNone(self.gateway.failure)
        def failing(*args, **kwargs):
            raise OSError("disk I/O error")

        self.store.append_user_message = failing
        for _ in range(2):
            with self.assertRaises(GatewayFailure):
                self.gateway.send_message(self.conversation, "m1", "你好")
        await self.idle()
        self.assertEqual(len(self.calls), 1)
        self.assertIsInstance(self.gateway.failure.__cause__, OSError)

    async def test_root_completion_does_not_reach_on_human(self):
        self.failing = True
        self.gateway.send_message(self.conversation, "m1", "x")
        await self.idle()
        self.assertFalse(any(e.type == "message.agent" for e in self.store.after(0)))

    async def test_stream_replays_after_cursor_then_pushes_live_and_transient(self):
        self.block = True
        self.gateway.send_message(self.conversation, "m1", "开始")
        await asyncio.wait_for(self.entered.wait(), 2)
        cursor = self.store.last_seq()
        self.gateway.on_human(self.conversation, "旧消息", [])
        stream = self.gateway.stream(cursor, heartbeat=5)
        kind, snapshot = await anext(stream)
        self.assertEqual((kind, snapshot["type"], snapshot["data"]["drafts"]),
                         ("transient", "draft.snapshot", []))
        kind, event = await anext(stream)
        self.assertEqual((kind, event["data"]["text"], event["data"]["status"]),
                         ("event", "旧消息", "completed"))
        pending = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0)
        self.gateway.on_update(self.conversation, {
            "type": "updates",
            "data": {"model": {"messages": [AIMessage("", tool_calls=[{"name": "exec_command", "args": {}, "id": "1"}])]}},
        })
        kind, event = await asyncio.wait_for(pending, 2)
        self.assertEqual((kind, event["data"]["label"]), ("transient", "正在运行命令"))
        self.assertNotIn("seq", event)
        self.gateway.on_human(self.conversation, "新消息", [])
        kind, event = await asyncio.wait_for(anext(stream), 2)
        self.assertEqual((kind, event["data"]["text"]), ("event", "新消息"))
        await stream.aclose()
        self.release.set()

    async def test_end_streams_finishes_open_streams(self):
        stream = self.gateway.stream(self.store.last_seq(), heartbeat=60)
        await anext(stream)  # Initial authoritative draft set.
        pending = asyncio.ensure_future(anext(stream))
        await asyncio.sleep(0)
        self.gateway.end_streams()
        with self.assertRaises(StopAsyncIteration):
            await asyncio.wait_for(pending, 2)

    async def test_stream_asks_for_resync_when_cursor_is_from_elsewhere(self):
        stream = self.gateway.stream(self.store.last_seq() + 100, heartbeat=5)
        self.assertEqual(await anext(stream), ("resync", None))
        await stream.aclose()


class EntryAgentTests(unittest.IsolatedAsyncioTestCase):
    """对话的入口 Agent 决定根任务的 Agent 与可委派范围；不同对话的执行上下文互相隔离。"""

    async def asyncSetUp(self):
        self.store = open_store(self, temp_dir(self) / "gateway.sqlite")
        self.runs: list[tuple[str, str, list[str]]] = []

        async def run(prompts, task_id):
            self.runs.append((task_id, self.manager.agent_name(task_id), [m.content for m in prompts]))
            return "done"

        self.gateway = Gateway(self.store)
        self.manager = gateway_manager(self.gateway, run)
        self.addAsyncCleanup(self.manager.close)
        self.addCleanup(self.gateway.end_streams)

    async def converse(self, agent_id: str, text: str, client_id: str) -> str:
        identity = self.gateway.create_conversation("t", agent_id)["id"]
        self.gateway.send_message(identity, client_id, text)
        await self.manager.wait(identity)
        return identity

    async def test_root_task_starts_as_the_entry_agent_on_every_message(self):
        identity = await self.converse("c", "一", "m1")
        self.assertEqual(self.manager.agent_name(identity), "c")
        self.gateway.send_message(identity, "m2", "二")  # 续聊沿用绑定
        await self.manager.wait(identity)
        self.assertEqual([agent for _, agent, _ in self.runs], ["c", "c"])

    async def test_entry_agent_delegates_to_its_workers_but_not_to_theirs(self):
        entry_c = await self.converse("c", "你好", "m1")
        self.manager.start("给 a", sender_id=entry_c, agent_name="a")
        self.manager.start("给 d", sender_id=entry_c, agent_name="d")
        with self.assertRaisesRegex(ValueError, "c 不能创建 b"):
            self.manager.start("给 b", sender_id=entry_c, agent_name="b")
        entry_a = await self.converse("a", "你好", "m2")
        self.manager.start("给 b", sender_id=entry_a, agent_name="b")  # a 的直接成员是 b

    async def test_conversations_have_separate_execution_contexts(self):
        c1 = await self.converse("c", "甲", "m1")
        c2 = await self.converse("c", "乙", "m2")
        a1 = await self.converse("a", "丙", "m3")
        self.assertEqual(len({c1, c2, a1}), 3)  # 检查点 thread_id 就是对话 id
        by_task = {task: (agent, prompts) for task, agent, prompts in self.runs}
        self.assertEqual(by_task[c1], ("c", ["甲"]))
        self.assertEqual(by_task[c2], ("c", ["乙"]))  # 同一入口的另一个对话看不到 c1 的输入
        self.assertEqual(by_task[a1], ("a", ["丙"]))

    async def test_unknown_entry_agent_is_rejected_without_a_failure(self):
        with self.assertRaises(UnknownAgent):
            self.gateway.create_conversation("t", "nobody")
        self.assertIsNone(self.gateway.failure)  # 预期的拒绝不是网关致命失败
        self.assertEqual(self.store.conversations(), [])


class LifecycleObserverTests(unittest.IsolatedAsyncioTestCase):
    async def test_interrupt_reports_one_running_span_and_observer_errors_do_not_break_scheduling(self):
        reports, entered, release = [], asyncio.Event(), asyncio.Event()

        async def run(prompts, task_id):
            if not entered.is_set():
                entered.set()
                await release.wait()
            return "done"

        def observer(task_id, status, error):
            reports.append(status)
            raise RuntimeError("观察者自身的问题")

        loop = asyncio.get_running_loop()
        handled = []
        loop.set_exception_handler(lambda loop, context: handled.append(context["message"]))
        self.addCleanup(loop.set_exception_handler, None)
        manager = WorkerManager(run, on_task=observer)
        self.addAsyncCleanup(manager.close)
        manager.start("一", "t")
        await entered.wait()
        manager.interrupt("二", "t")  # 打断后立即续轮：不报告中间的取消
        self.assertEqual((await manager.wait("t"))["status"], "completed")
        await asyncio.sleep(0)
        self.assertEqual(reports, ["running", "running", "completed"])
        self.assertEqual(len(handled), 3)


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        store = open_store(self, temp_dir(self) / "gateway.sqlite")

        async def run(prompts, task_id):
            return "done"

        self.gateway = Gateway(store)
        self.manager = gateway_manager(self.gateway, run)
        self.addAsyncCleanup(self.manager.close)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway",
            headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_requires_token(self):
        response = await self.client.get("/conversations", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "unauthorized")

    async def test_send_replay_history_and_listing_with_status(self):
        created = await self.client.post("/conversations", json={"title": "新对话", "agent_id": "main"})
        self.assertEqual(created.status_code, 201)
        identity = created.json()["id"]
        self.assertEqual(created.json()["status"], "idle")
        body = {"client_id": "m1", "text": "你好"}
        first = await self.client.post(f"/conversations/{identity}/messages", json=body)
        second = await self.client.post(f"/conversations/{identity}/messages", json=body)
        self.assertEqual((first.status_code, second.status_code), (202, 200))
        self.assertTrue(second.json()["replayed"])
        await self.manager.wait(identity)
        await asyncio.sleep(0)
        history = (await self.client.get(f"/conversations/{identity}/events")).json()
        self.assertEqual(
            [e["type"] for e in history["events"]],
            ["conversation.created", "conversation.status", "message.user", "conversation.updated", "conversation.status"],
        )
        listing = (await self.client.get("/conversations")).json()
        self.assertEqual(listing["conversations"][0]["status"], "idle")
        self.assertEqual(listing["conversations"][0]["last_text"], "你好")
        self.assertEqual(listing["as_of_seq"], history["events"][-1]["seq"])

    async def test_errors_use_one_envelope(self):
        missing = await self.client.post("/conversations/nope/messages", json={"client_id": "x", "text": "y"})
        self.assertEqual(missing.status_code, 404)
        invalid = await self.client.post("/conversations", content=b"[1]")
        self.assertEqual(invalid.json()["error"]["code"], "invalid_json")
        identity = (await self.client.post("/conversations", json={"agent_id": "main"})).json()["id"]
        empty = await self.client.post(f"/conversations/{identity}/messages", json={"client_id": "x", "text": " "})
        self.assertEqual(empty.status_code, 400)
        future = await self.client.post(f"/conversations/{identity}/read", json={"seq": 10**6})
        self.assertEqual((future.status_code, future.json()["error"]["code"]), (400, "invalid_request"))
        # 审查第 9 条：框架层的 404/405 也用统一格式，并保留 Allow。
        no_route = await self.client.get("/missing")
        self.assertEqual((no_route.status_code, no_route.json()["error"]["code"]), (404, "not_found"))
        self.assertIn("不存在", no_route.json()["error"]["message"])
        wrong_method = await self.client.delete("/conversations")
        self.assertEqual(wrong_method.status_code, 405)
        self.assertEqual(wrong_method.json()["error"]["code"], "method_not_allowed")
        self.assertIn("GET", wrong_method.headers["allow"])
        self.assertIn("POST", wrong_method.headers["allow"])
        self.assertIn("不支持", wrong_method.json()["error"]["message"])

    async def test_conversation_requires_an_existing_agent_and_reports_it(self):
        missing = await self.client.post("/conversations", json={"title": "x"})
        self.assertEqual((missing.status_code, missing.json()["error"]["code"]), (400, "invalid_request"))
        unknown = await self.client.post("/conversations", json={"agent_id": "nobody"})
        self.assertEqual((unknown.status_code, unknown.json()["error"]["code"]), (404, "not_found"))
        created = await self.client.post("/conversations", json={"agent_id": "c"})
        self.assertEqual((created.status_code, created.json()["agent_id"]), (201, "c"))
        self.assertEqual(len((await self.client.get("/conversations")).json()["conversations"]), 1)

    async def test_rename_validates_trims_emits_once_and_preserves_user_choice(self):
        identity = (await self.client.post("/conversations", json={"agent_id": "main"})).json()["id"]
        url = f"/conversations/{identity}"
        for title, status in (("  ", 400), ("a" * 201, 413), (42, 400)):
            self.assertEqual((await self.client.patch(url, json={"title": title})).status_code, status)
        initial = self.gateway.store.last_seq()
        renamed = await self.client.patch(url, json={"title": "  自己的名字  "})
        self.assertEqual(renamed.json()["conversation"]["title"], "自己的名字")
        self.assertEqual(renamed.json()["event"]["data"], {"title": "自己的名字"})
        same = await self.client.patch(url, json={"title": "自己的名字"})
        self.assertIsNone(same.json()["event"])
        self.assertEqual(self.gateway.store.last_seq(), initial + 1)
        await self.client.post(f"{url}/messages", json={"client_id": "first", "text": "这是第一句"})
        self.assertEqual(self.gateway.store.conversation(identity)["title"], "自己的名字")
        self.assertEqual((await self.client.patch("/conversations/missing", json={"title": "x"})).status_code, 404)

    async def test_auto_title_only_first_accepted_message_and_explicit_default_rename_blocks_it(self):
        auto = (await self.client.post("/conversations", json={"agent_id": "main"})).json()["id"]
        renamed_default = (await self.client.post("/conversations", json={"agent_id": "main"})).json()["id"]
        custom = (await self.client.post(
            "/conversations", json={"agent_id": "main", "title": "自定标题"}
        )).json()["id"]
        same = await self.client.patch(f"/conversations/{renamed_default}", json={"title": " 新对话 "})
        self.assertIsNone(same.json()["event"])
        text = " \n 你好\n第二行 " + "🍋" * 30
        first = await self.client.post(
            f"/conversations/{auto}/messages", json={"client_id": "first", "text": text}
        )
        self.assertEqual(first.status_code, 202)
        await self.client.post(
            f"/conversations/{auto}/messages", json={"client_id": "first", "text": text}
        )
        await self.client.post(
            f"/conversations/{auto}/messages", json={"client_id": "second", "text": "后来的长消息"}
        )
        for identity in (renamed_default, custom):
            await self.client.post(
                f"/conversations/{identity}/messages", json={"client_id": identity, "text": text}
            )
        expected = "你好 第二行 " + "🍋" * 13
        self.assertEqual(self.gateway.store.conversation(auto)["title"], expected)
        self.assertEqual(self.gateway.store.conversation(renamed_default)["title"], "新对话")
        self.assertEqual(self.gateway.store.conversation(custom)["title"], "自定标题")
        self.assertEqual(
            [event.data for event in self.gateway.store.history(auto) if event.type == "conversation.updated"],
            [{"title": expected}],
        )

    async def test_conversations_filter_by_agent(self):
        for agent_id in ("a", "c", "c"):
            await self.client.post("/conversations", json={"agent_id": agent_id})
        in_c = (await self.client.get("/conversations", params={"agent_id": "c"})).json()
        self.assertEqual([c["agent_id"] for c in in_c["conversations"]], ["c", "c"])
        self.assertEqual((await self.client.get("/conversations", params={"agent_id": "b"})).json()["conversations"], [])
        self.assertEqual(len((await self.client.get("/conversations")).json()["conversations"]), 3)
        unknown = await self.client.get("/conversations", params={"agent_id": "nobody"})
        self.assertEqual(unknown.status_code, 404)

    async def test_agent_list_and_detail(self):
        listing = (await self.client.get("/agents")).json()
        self.assertEqual(listing["as_of_seq"], self.gateway.store.last_seq())
        by_id = {item["id"]: item for item in listing["agents"]}
        self.assertEqual(set(by_id), {"main", "a", "b", "c", "d"})
        self.assertEqual(by_id["c"]["workers"], ["a", "d"])
        self.assertEqual(
            set(by_id["c"]),
            {"id", "name", "avatar", "description", "workers", "home", "latest_conversation", "unread"},
        )
        detail = (await self.client.get("/agents/a")).json()
        self.assertEqual((detail["workers"], detail["member_of"]), (["b"], ["c"]))
        self.assertEqual(detail["system_prompt"], "完成任务。")
        self.assertEqual(
            {"id", "name", "avatar", "description", "system_prompt", "model", "reasoning_effort",
             "mcp_servers", "searchable_mcp_servers", "skills", "code_mode", "environment",
             "context_window", "compaction_keep_tokens", "compaction_model",
             "workers", "member_of"},
            set(detail),
        )
        missing = await self.client.get("/agents/nobody")
        self.assertEqual((missing.status_code, missing.json()["error"]["code"]), (404, "not_found"))

    # ---- 首页：GET /agents 的派生视图与移出首页 ----

    async def agents_by_id(self) -> dict:
        return {item["id"]: item for item in (await self.client.get("/agents")).json()["agents"]}

    async def new_conversation(self, agent_id: str, title: str = "新对话") -> str:
        response = await self.client.post("/conversations", json={"agent_id": agent_id, "title": title})
        return response.json()["id"]

    async def say(self, conversation_id: str, text: str, client_id: str) -> None:
        response = await self.client.post(
            f"/conversations/{conversation_id}/messages", json={"client_id": client_id, "text": text}
        )
        self.assertEqual(response.status_code, 202)
        await self.manager.wait(conversation_id)
        await asyncio.sleep(0)

    async def on_home(self, agent_id: str) -> bool:
        return (await self.agents_by_id())[agent_id]["home"]

    async def test_home_item_summarizes_latest_conversation_and_sorts_by_activity(self):
        fresh = await self.agents_by_id()
        self.assertEqual(list(fresh), ["main", "a", "b", "c", "d"])  # 都没对话：保持导入顺序
        self.assertTrue(all(i["home"] and i["latest_conversation"] is None and not i["unread"] for i in fresh.values()))
        in_c = await self.new_conversation("c", "乙")
        in_a = await self.new_conversation("a", "甲")
        await self.say(in_a, "你好", "m1")
        self.gateway.on_human(in_a, "收到", [])
        listing = (await self.client.get("/agents")).json()["agents"]
        # 有活动的在前；c 只有还没发消息的空对话，和没对话的一起按导入顺序排在后面。
        self.assertEqual([i["id"] for i in listing], ["a", "main", "b", "c", "d"])
        self.assertEqual(next(i for i in listing if i["id"] == "c")["latest_conversation"]["id"], in_c)
        a = listing[0]
        self.assertEqual(a["latest_conversation"]["id"], in_a)
        self.assertEqual(
            (a["latest_conversation"]["title"], a["latest_conversation"]["last_text"], a["latest_conversation"]["status"]),
            ("甲", "收到", "idle"),
        )
        self.assertIsInstance(a["latest_conversation"]["last_activity_at"], float)
        self.assertTrue(a["unread"])
        self.assertFalse(next(i for i in listing if i["id"] == "c")["unread"])  # c 的对话还没有 Agent 消息
        await self.say(in_c, "轮到 c", "m2")
        self.assertEqual([i["id"] for i in (await self.client.get("/agents")).json()["agents"]][:2], ["c", "a"])
        # 已读后红点消失（沿用对话的未读口径）
        await self.client.post(f"/conversations/{in_a}/read", json={"seq": self.gateway.store.last_seq()})
        self.assertFalse((await self.agents_by_id())["a"]["unread"])

    async def test_activity_is_product_events_only_not_status_or_empty_conversations(self):
        store = self.gateway.store
        old_a = await self.new_conversation("a", "旧")
        new_a = await self.new_conversation("a", "新")
        await self.say(old_a, "旧消息", "m1")
        await self.say(new_a, "新消息", "m2")
        await self.say(await self.new_conversation("c", "乙"), "乙的消息", "m3")
        before = (await self.client.get("/agents")).json()["agents"]
        self.assertEqual([i["id"] for i in before[:2]], ["c", "a"])
        self.assertEqual(before[1]["latest_conversation"]["id"], new_a)
        # 仅旧对话的状态变化（以及已读）：顺序、摘要的对话、时间都不变，状态字段照实反映。
        store.set_status(old_a, "working")
        await self.client.post(f"/conversations/{old_a}/read", json={"seq": store.last_seq()})
        after = (await self.client.get("/agents")).json()["agents"]
        self.assertEqual([i["id"] for i in after], [i["id"] for i in before])
        self.assertEqual(after[1]["latest_conversation"], before[1]["latest_conversation"])
        self.assertEqual(store.agent_item("a"), after[1])  # 单个读取与列表同一口径
        store.set_status(new_a, "working")
        self.assertEqual((await self.agents_by_id())["a"]["latest_conversation"]["status"], "working")

    async def test_activity_seq_survives_clock_rollback_and_excludes_non_product_events(self):
        store = self.gateway.store
        old = await self.new_conversation("a", "旧")
        new = await self.new_conversation("a", "新")
        with patch("wandrun.gateway.store.time.time", return_value=200):
            first, _ = store.append(old, "message.user", {"text": "旧消息"})
        stale = (await self.agents_by_id())["a"]["latest_conversation"]
        self.assertEqual((stale["id"], stale["last_activity_seq"], stale["last_activity_at"]), (old, first.seq, 200))
        with patch("wandrun.gateway.store.time.time", return_value=199):
            later, _ = store.append(new, "message.agent", {"text": "新回复"})
        store.set_status(new, "working")
        store.mark_read(new, store.last_seq())
        await self.new_conversation("a", "空对话")
        listing = await self.agents_by_id()
        self.assertEqual(listing["a"], store.agent_item("a"))
        self.assertEqual(listing["a"]["latest_conversation"], {
            "id": new, "title": "新", "last_text": "新回复", "status": "working",
            "last_activity_seq": later.seq, "last_activity_at": 199,
        })
        self.assertGreater(later.seq, first.seq)
        self.assertLess(later.seq, store.last_seq())
        self.assertFalse(listing["a"]["unread"])

    async def test_empty_new_conversation_does_not_change_ranking_or_summary(self):
        in_a = await self.new_conversation("a", "有内容")
        await self.say(in_a, "内容", "m1")
        await self.say(await self.new_conversation("c", "乙"), "更新", "m2")
        await self.new_conversation("a", "空的")  # a 下新建、还没发消息
        listing = (await self.client.get("/agents")).json()["agents"]
        self.assertEqual([i["id"] for i in listing[:2]], ["c", "a"])  # 排序不变
        self.assertEqual(listing[1]["latest_conversation"]["id"], in_a)  # 有活动的对话才是摘要
        # 只有空对话的 Agent：摘要指向最新创建的空对话，没有活动时间，排在没有活动的一组里（导入顺序）。
        empty = await self.new_conversation("b", "只有空的")
        by_id = await self.agents_by_id()
        self.assertEqual(by_id["b"]["latest_conversation"]["id"], empty)
        self.assertIsNone(by_id["b"]["latest_conversation"]["last_activity_at"])
        self.assertIsNone(by_id["b"]["latest_conversation"]["last_activity_seq"])
        self.assertIsNone(by_id["b"]["latest_conversation"]["last_text"])
        order = [i["id"] for i in (await self.client.get("/agents")).json()["agents"]]
        self.assertEqual(order, ["c", "a", "main", "b", "d"])
        await self.say(empty, "b 的第一条", "m3")  # 发了消息才有活动
        self.assertEqual([i["id"] for i in (await self.client.get("/agents")).json()["agents"]][0], "b")

    async def test_hide_returns_to_home_only_on_new_messages_in_its_own_conversations(self):
        in_a = await self.new_conversation("a")
        hidden = await self.client.post("/agents/a/hide")
        self.assertEqual((hidden.status_code, hidden.json()["home"]), (200, False))
        self.assertFalse(await self.on_home("a"))
        # 查看、已读、状态变化、新建对话都不是新事件。
        self.gateway.on_human(in_a, "移出之后的新回复", [])  # 新的 Agent 消息：回到首页
        self.assertTrue(await self.on_home("a"))
        await self.client.post("/agents/a/hide")
        self.assertFalse(await self.on_home("a"))
        await self.client.post(f"/conversations/{in_a}/read", json={"seq": self.gateway.store.last_seq()})
        self.gateway.store.set_status(in_a, "working")
        self.gateway.store.set_status(in_a, "idle")
        await self.new_conversation("a")  # 新建了对话但还没发消息
        self.assertFalse(await self.on_home("a"))
        newest = (await self.client.get("/conversations", params={"agent_id": "a"})).json()["conversations"][0]["id"]
        await self.say(newest, "第一条消息", "m1")  # 发了第一条消息才回首页
        self.assertTrue(await self.on_home("a"))

    async def test_hide_then_agent_reply_returns_to_home(self):
        in_a = await self.new_conversation("a")
        await self.client.post("/agents/a/hide")
        self.gateway.on_human(in_a, "Agent 的回复", [])
        self.assertTrue(await self.on_home("a"))
        self.assertTrue(await self.on_home("c"))  # 没动过的 Agent 一直在首页

    async def test_work_delegated_to_a_member_does_not_bring_it_home(self):
        in_c = await self.new_conversation("c")
        await self.client.post("/agents/a/hide")
        await self.say(in_c, "给 a 做", "m1")
        member = self.manager.start("请 a 处理", sender_id=in_c, agent_name="a")["task_id"]
        await self.manager.wait(member)
        self.gateway.on_human(member, "a 作为成员的回复", [])
        events = [e for e in self.gateway.store.task_history(member) if e.type == "message.agent"]
        self.assertEqual([e.data["agent"] for e in events], ["a"])
        previews = [e for e in self.gateway.store.history(in_c, limit=100) if e.type == "message.task_preview"]
        self.assertEqual([e.data["task_id"] for e in previews], [member])
        self.assertFalse(await self.on_home("a"))
        self.assertIsNone((await self.agents_by_id())["a"]["latest_conversation"])
        self.assertTrue(await self.on_home("c"))

    async def test_hide_and_unhide_are_idempotent(self):
        seq = self.gateway.store.last_seq()
        first = await self.client.post("/agents/b/hide")
        again = await self.client.post("/agents/b/hide")
        self.assertEqual((first.status_code, again.status_code), (200, 200))
        self.assertEqual(self.gateway.store.last_seq(), seq + 1)  # 重复移出不再产生事件
        self.assertFalse(again.json()["home"])
        back = await self.client.post("/agents/b/unhide")
        self.assertTrue(back.json()["home"])
        self.assertEqual(self.gateway.store.last_seq(), seq + 2)
        await self.client.post("/agents/b/unhide")
        await self.client.post("/agents/main/unhide")  # 从没移出过
        self.assertEqual(self.gateway.store.last_seq(), seq + 2)
        for path in ("/agents/nobody/hide", "/agents/nobody/unhide"):
            response = await self.client.post(path)
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "not_found"))

    async def test_hide_events_are_resumable_and_belong_to_no_conversation(self):
        in_a = await self.new_conversation("a")
        after = self.gateway.store.last_seq()
        await self.client.post("/agents/a/hide")
        await self.client.post("/agents/a/unhide")
        stream = self.gateway.stream(after, heartbeat=60)  # 断线重连：从上次的 seq 补
        await anext(stream)
        received = [payload async for kind, payload in self._take(stream, 2)]
        self.assertEqual([e["type"] for e in received], ["resource.changed"] * 2)
        self.assertEqual([e["data"] for e in received], [
            {"kind": "agent", "id": "a", "op": "hidden"}, {"kind": "agent", "id": "a", "op": "unhidden"},
        ])
        self.assertTrue(all("conversation_id" not in e for e in received))
        self.assertEqual([e.type for e in self.gateway.store.history(in_a)], ["conversation.created"])

    @staticmethod
    async def _take(stream, count):
        for _ in range(count):
            yield await asyncio.wait_for(anext(stream), 2)

    async def test_commands_after_runtime_closed_are_unavailable(self):
        identity = (await self.client.post("/conversations", json={"agent_id": "main"})).json()["id"]
        await self.manager.close()
        response = await self.client.post(f"/conversations/{identity}/messages", json={"client_id": "x", "text": "y"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "unavailable"))

    async def test_state_write_failure_at_settlement_is_fatal_for_the_gateway(self):
        identity = (await self.client.post("/conversations", json={"agent_id": "main"})).json()["id"]
        set_status = self.gateway.store.set_status

        def failing(conversation_id, status):
            if status == "idle":
                raise OSError("disk I/O error")
            return set_status(conversation_id, status)

        self.gateway.store.set_status = failing
        open_stream = self.gateway.stream(self.gateway.store.last_seq(), heartbeat=60)
        await anext(open_stream)
        pending = asyncio.ensure_future(anext(open_stream))
        body = {"client_id": "m1", "text": "你好"}
        self.assertEqual((await self.client.post(f"/conversations/{identity}/messages", json=body)).status_code, 202)
        # Manager 的调度不受回调失败影响
        self.assertEqual((await self.manager.wait(identity))["status"], "completed")
        failure = await asyncio.wait_for(self.gateway.wait_failure(), 2)
        self.assertIsInstance(failure.__cause__, OSError)
        self.assertFalse(self.manager.snapshot()["closed"])
        await asyncio.wait_for(pending, 2)

        async def drain():  # 已有事件先交付，随后流结束
            return [item async for item in open_stream]

        await asyncio.wait_for(drain(), 2)
        for path, payload in ((f"/conversations/{identity}/messages", {"client_id": "m2", "text": "再来"}),
                              (f"/conversations/{identity}/stop", {"client_id": "s1"}),
                              ("/conversations", {"agent_id": "main"})):
            response = await self.client.post(path, json=payload)
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "unavailable"))

    async def test_integer_beyond_sqlite_range_is_a_request_error(self):
        identity = (await self.client.post("/conversations", json={"agent_id": "main"})).json()["id"]
        response = await self.client.get(f"/conversations/{identity}/events", params={"before": 2**63})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "invalid_request"))
        ok = await self.client.get(f"/conversations/{identity}/events", params={"before": 2**63 - 1})
        self.assertEqual(ok.status_code, 200)

    def test_last_event_id_takes_precedence_over_initial_after(self):
        # 审查第 4 条：自动重连保留原 URL（after=1），请求头带最新的 3。
        self.assertEqual(stream_cursor({"last-event-id": "3"}, {"after": "1"}), 3)
        self.assertEqual(stream_cursor({}, {"after": "1"}), 1)
        self.assertEqual(stream_cursor({}, {}), 0)


class GatewayErrorProjectionTests(unittest.TestCase):
    def test_agent_required_fields_are_named_without_internal_paths(self):
        gateway = Gateway(open_store(self, temp_dir(self) / "gateway.sqlite"))
        with self.assertRaisesRegex(ValueError, "说明.*提示词") as missing:
            gateway._agent_fields({"name": "演示", "model": "offline"})
        self.assertNotIn("system_prompt", str(missing.exception))
        with self.assertRaisesRegex(ValueError, "提示词") as blank:
            gateway._agent_fields({"system_prompt": "  "}, gateway.store.agent_catalog().agents["main"])
        # 字段校验在候选保存之前完成。
        self.assertEqual(gateway.store.agent("main")["system_prompt"], "完成任务。")
        self.assertNotIn("agents.", str(blank.exception))

    def test_task_diagnostics_are_classified_without_exposing_raw_detail(self):
        from wandrun.gateway.error_messages import task_failure

        for raw, expected in (
            ("APITimeoutError: private timeout token", "超时"),
            ("APIConnectionError: private network token", "网络"),
            ("AuthenticationError: private auth token", "认证"),
            ("RateLimitError: private quota token", "额度"),
            ("ContextWindowExceededError: private context token", "上下文"),
            ("RuntimeError: private unexpected token", "重试"),
            ("RuntimeError: 中文 mixed private token", "重试"),
        ):
            with self.subTest(raw=raw):
                public = task_failure(raw)
                self.assertIn(expected, public)
                self.assertNotIn("private", public)

    def test_subscription_adapter_errors_keep_actionable_status_without_response_body(self):
        from wandrun.gateway.error_messages import task_failure
        from wandrun.integrations.codex_subscription import CodexSubscriptionHTTPError, CodexSubscriptionStreamError

        cases = [
            (CodexSubscriptionHTTPError(401, "private provider credential detail"), "认证"),
            (CodexSubscriptionHTTPError(403, "private provider access detail"), "权限"),
            (CodexSubscriptionHTTPError(429, "private quota response"), "额度"),
            (CodexSubscriptionHTTPError(503, "private service response"), "暂不可用"),
            (CodexSubscriptionHTTPError(504, "private upstream timeout"), "超时"),
            (CodexSubscriptionStreamError("private stream data"), "中断"),
        ]
        for error, category in cases:
            with self.subTest(error=type(error).__name__, category=category):
                public = task_failure(f"{type(error).__name__}: {error}")
                self.assertIn(category, public)
                self.assertNotIn("private", public)


class AgentIdBoundaryTests(unittest.IsolatedAsyncioTestCase):
    """配置允许的每个 Agent id 都能经 HTTP 寻址并被选作对话入口。"""

    async def test_longest_and_punctuated_ids_work_end_to_end(self):
        ids = ["x" * 64, "a-b_C9"]
        store = open_store(self, temp_dir(self) / "gateway.sqlite", seeded=False)
        store.import_agents(AgentCatalog(ids[0], {identity: agent() for identity in ids}))
        gateway = Gateway(store)
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(gateway, "t")),
            base_url="http://gateway", headers={"Authorization": "Bearer t"},
        )
        self.addAsyncCleanup(client.aclose)
        for identity in ids:
            self.assertEqual((await client.get(f"/agents/{identity}")).status_code, 200)
            created = await client.post("/conversations", json={"agent_id": identity})
            self.assertEqual((created.status_code, created.json()["agent_id"]), (201, identity))
        too_long = await client.post("/conversations", json={"agent_id": "x" * 65})
        self.assertEqual(too_long.status_code, 413)  # 超出规则上限的 id 不可能存在


class FakeServer:
    """只模拟 uvicorn 的关闭约定：serve() 一直运行到 should_exit 被设置。"""

    def __init__(self):
        self.should_exit = False
        self.exited = False

    async def serve(self):
        while not self.should_exit:
            await asyncio.sleep(0.005)
        self.exited = True


class RunServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.gateway = Gateway(open_store(self, temp_dir(self) / "gateway.sqlite"))
        self.watcher_cancelled = False

    async def watcher(self):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.watcher_cancelled = True
            raise

    async def test_cancelling_the_entry_stops_server_and_watchers_before_returning(self):
        server = FakeServer()
        task = asyncio.ensure_future(run_server(server, self.gateway, self.watcher()))
        await asyncio.sleep(0.02)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(server.should_exit and server.exited)
        self.assertTrue(self.watcher_cancelled)

    async def test_failure_stops_server_and_is_returned(self):
        server = FakeServer()

        async def failing():
            await asyncio.sleep(0.02)
            return GatewayFailure("x")

        failure = await asyncio.wait_for(run_server(server, self.gateway, failing(), self.watcher()), 2)
        self.assertIsInstance(failure, GatewayFailure)
        self.assertTrue(server.exited)
        self.assertTrue(self.watcher_cancelled)


class ReportingFailureTests(unittest.TestCase):
    """审查 3-2、3-3：运行时收尾期间才发生的网关失败，以及退出信息里的附注。"""

    def setUp(self):
        self.gateway = Gateway(open_store(self, temp_dir(self) / "gateway.sqlite"))

    def test_failure_during_runtime_cleanup_is_raised_after_it(self):
        with self.assertRaises(GatewayFailure) as caught:
            with reporting_failure(self.gateway):
                self.gateway._fail(OSError("disk I/O error"))  # 例如取消 Worker 时写 idle 失败
        self.assertIsInstance(caught.exception.__cause__, OSError)

    def test_late_failure_is_attached_to_an_error_already_propagating(self):
        for propagating in (RuntimeError("调度存储失败"), asyncio.CancelledError()):
            gateway = Gateway(open_store(self, temp_dir(self) / "gateway.sqlite"))
            with self.assertRaises(type(propagating)) as caught:
                with reporting_failure(gateway):
                    gateway._fail(OSError("disk I/O error"))
                    raise propagating
            self.assertIs(caught.exception, propagating)
            self.assertIn("disk I/O error", caught.exception.__notes__[0])

    def test_the_failure_itself_gets_no_duplicate_note_and_keeps_cleanup_notes_on_exit(self):
        with self.assertRaises(GatewayFailure) as caught:
            with reporting_failure(self.gateway):
                failure = self.gateway._fail(OSError("disk I/O error"))
                failure.add_note("远端清理未确认：call-X")  # open_runtime 附上的收尾事实
                raise failure
        self.assertEqual(caught.exception.__notes__, ["远端清理未确认：call-X"])
        self.assertIn("call-X", exit_message("网关已停止", caught.exception))


class _RecoveryState(TypedDict):
    compaction_events: list[dict]


class ConversationDeletionTests(unittest.IsolatedAsyncioTestCase):
    """真实 SQLite 调度快照和 LangGraph 检查点，模型执行保持受控。"""

    async def asyncSetUp(self):
        self.directory = temp_dir(self)
        self.store = open_store(self, self.directory / "gateway.sqlite")
        self.checkpointer = await self.enterAsyncContext(
            AsyncSqliteSaver.from_conn_string(str(self.directory / "checkpoints.sqlite"))
        )
        self.graph = self.recovery_graph(self.checkpointer)
        self.scheduler_path = self.directory / "scheduler.sqlite"
        self.gateway = Gateway(self.store)
        self.release = asyncio.Event()
        self.entered = asyncio.Event()
        self.block = False
        self.manager = self.open_manager(self.gateway)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway", headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)

    def open_manager(self, gateway):
        scheduler = SchedulerStore(self.scheduler_path)
        self.addCleanup(scheduler.close)

        async def run(prompts, task_id):
            if self.block:
                self.entered.set()
                await self.release.wait()
            return "done"

        manager = WorkerManager(
            run, on_human=gateway.on_human, on_task=gateway.on_task,
            notify_human_of_roots=False, store=scheduler,
            agent_workers={name: item.workers for name, item in sample_catalog().agents.items()},
            default_agent="main",
        )
        self.addAsyncCleanup(manager.close)
        gateway.attach(manager, self.checkpointer, runtime=Runtime(
            workers=manager, checkpointer=self.checkpointer, main_agent="main",
            agent_models={name: {} for name in sample_catalog().agents},
            mcp=None, _assembly_for=lambda name: SimpleNamespace(graph=self.graph),
        ))
        return manager

    @staticmethod
    def recovery_graph(checkpointer, *, interrupt_before=None):
        """最小角色图：用真实 StateSnapshot 读取已提交和节点待合并的写入。"""
        builder = StateGraph(_RecoveryState)
        builder.add_node("model", lambda state: {})
        builder.add_edge(START, "model")
        return builder.compile(checkpointer=checkpointer, interrupt_before=interrupt_before)

    async def checkpoint(self, identity):
        config = {"configurable": {"thread_id": identity, "checkpoint_ns": ""}}
        await self.checkpointer.aput(
            config, empty_checkpoint(), {"source": "input", "step": 0, "writes": {}}, {}
        )
        self.assertIsNotNone(await self.checkpointer.aget_tuple(config))

    async def test_compaction_history_root_and_member_persists_without_waking_parent(self):
        root = self.gateway.create_conversation("压缩", "c")["id"]
        self.gateway.send_message(root, "first", "开始")
        await self.manager.wait(root)
        child = self.manager.start("成员处理", sender_id=root, agent_name="a")["task_id"]
        await self.manager.wait(child)
        definition = self.store.agent_catalog().agents["a"]
        self.store.update_agent("a", definition, "研究员", self.store.agent("a")["avatar"])
        before = self.store.conversation(root)
        parent_state = self.manager.get(root)
        summary = "## 目标\n完整摘要第一节\n\n## 事实\n完整摘要最后一节"
        event = {
            "status": "completed", "agent_name": "a", "event_id": "segment-1",
            "generation": 1, "reason": "threshold", "cutoff_index": 20,
            "created_at": "2026-10-12T10:00:00+00:00",
            "summary_text": summary, "archive_path": "/workspace/.wandrun/artifacts/compaction/child/index.md",
            "keep_tokens": 2000, "retained_tokens": 2020, "retention_reason": "target",
            "summary_model": "offline", "summary_usage": {"input_tokens": 80},
        }
        self.gateway.on_compaction(child, event)
        self.gateway.on_compaction(child, event)
        self.gateway.on_compaction(root, {**event, "agent_name": "c"})
        self.gateway.on_compaction(child, {
            "status": "failed", "agent_name": "a", "error": "PermissionError", "message": "private archive path: denied",
        })
        rows = [item for item in self.store.history(root, limit=100) if item.type.startswith("context.")]
        self.assertEqual([item.type for item in rows], [
            "context.compacted", "context.compacted", "context.compaction_failed",
        ])
        self.assertEqual([(item.data["task_id"], item.data["agent_id"]) for item in rows],
                         [(child, "a"), (root, "c"), (child, "a")])
        self.assertEqual(rows[0].data["agent_name"], "研究员")
        self.assertEqual(rows[0].data["summary_text"], summary)
        self.assertEqual(rows[0].data["retained_tokens"], 2020)
        self.assertEqual(rows[0].data["archive_path"], event["archive_path"])
        self.assertIn("权限", rows[-1].data["message"])
        self.assertNotIn("private", str(rows[-1].data))
        self.assertEqual(self.manager.get(root), parent_state)
        self.assertEqual(self.manager.take_messages(root), [])  # 通知不是成员回信
        self.assertEqual(self.store.conversation(root)["updated_at"], before["updated_at"])
        self.assertEqual(self.store.conversation(root)["last_text"], before["last_text"])
        self.assertEqual(self.store.conversation(root)["unread"], before["unread"])
        with closing(GatewayStore(self.directory / "gateway.sqlite")) as reopened:
            self.assertEqual([item.data for item in reopened.history(root) if item.type.startswith("context.")],
                             [item.data for item in rows])

    async def test_startup_reconciles_checkpoint_compaction_events_and_deletion_blocks_replay(self):
        root = self.gateway.create_conversation("恢复", "c")["id"]
        self.gateway.send_message(root, "first", "开始")
        await self.manager.wait(root)
        child = self.manager.start("成员处理", sender_id=root, agent_name="a")["task_id"]
        await self.manager.wait(child)
        event = {
            "event_id": "committed-1", "generation": 1, "reason": "threshold", "cutoff_index": 20,
            "summary_text": "可恢复的完整摘要", "archive_path": "/archive/index.md",
            "created_at": "2026-10-12T10:00:00+00:00",
            "keep_tokens": 2000, "retained_tokens": 2050, "retention_reason": "target",
            "summary_model": "offline", "summary_usage": None,
        }
        await self.graph.ainvoke(
            {"compaction_events": [event]},
            {"configurable": {"thread_id": child}},
            durability="sync",
        )
        empty = self.gateway.create_conversation("尚未发送消息", "c")["id"]
        self.assertEqual(self.manager.get(empty)["status"], "not_found")
        self.assertEqual(self.manager.branch_threads(empty), {empty})
        self.assertFalse(any(item.type == "context.compacted" for item in self.store.history(root)))
        await self.gateway.reconcile_compactions()
        await self.gateway.reconcile_compactions()
        rows = [item for item in self.store.history(root) if item.type == "context.compacted"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0].data["task_id"], rows[0].data["agent_id"]), (child, "a"))
        self.assertEqual(rows[0].data["summary_text"], event["summary_text"])
        self.assertFalse(any(item.type == "context.compacted" for item in self.store.history(empty)))
        self.store.begin_delete(root, {root, child})
        self.gateway.on_compaction(child, {
            "status": "completed", "agent_name": "a", **{**event, "event_id": "late-2"},
        })
        self.assertEqual(len([item for item in self.store.history(root) if item.type == "context.compacted"]), 1)
        self.store.finish_delete(root)
        self.assertEqual(self.store.history(root), [])
        self.gateway.on_compaction(child, {"status": "completed", "agent_name": "a", **event})
        self.assertEqual(self.store.history(root), [])

    async def test_startup_reconciliation_skips_tasks_whose_agent_was_removed(self):
        root = self.gateway.create_conversation("保留的对话", "c")["id"]
        self.gateway.send_message(root, "first", "开始")
        await self.manager.wait(root)
        child = self.manager.start("成员处理", sender_id=root, agent_name="a")["task_id"]
        await self.manager.wait(child)
        self.manager.replace_agent_workers({"c": (), "main": ()}, "main")
        del self.gateway.runtime.agent_models["a"]

        def assembly_for(name):
            if name == "a":
                raise KeyError(name)  # 已删除角色不再有图，但历史任务仍保留绑定。
            return SimpleNamespace(graph=self.graph)

        self.gateway.runtime._assembly_for = assembly_for
        await self.gateway.reconcile_compactions()
        self.assertEqual(await self.gateway.runtime.compaction_events(child), [])
        self.assertEqual(self.manager.agent_name(child), "a")
        self.assertFalse(any(item.type == "context.compacted" for item in self.store.history(root)))

    async def test_startup_reconciles_sqlite_pending_compaction_write(self):
        root = self.gateway.create_conversation("恢复待合并写入", "c")["id"]
        self.gateway.send_message(root, "first", "开始")
        await self.manager.wait(root)
        child = self.manager.start("成员处理", sender_id=root, agent_name="a")["task_id"]
        await self.manager.wait(child)
        event = {
            "event_id": "pending-1", "summary_text": "崩溃前已写入的摘要",
            "archive_path": "/archive/pending.md", "created_at": "2026-10-12T10:00:00+00:00",
        }
        config = {"configurable": {"thread_id": child}}
        self.graph = self.recovery_graph(self.checkpointer, interrupt_before=["model"])
        await self.graph.ainvoke({"compaction_events": []}, config, durability="sync")
        snapshot = await self.graph.aget_state(config)
        self.assertEqual(snapshot.next, ("model",))
        # 模型节点已将写入交给 SQLite，下一次完整 checkpoint 尚未生成。
        await self.checkpointer.aput_writes(
            snapshot.config, [("compaction_events", [event])], snapshot.tasks[0].id,
        )
        saved = await self.checkpointer.aget_tuple(config)
        self.assertEqual(saved.checkpoint["channel_values"].get("compaction_events"), [])
        self.assertIn((snapshot.tasks[0].id, "compaction_events", [event]), saved.pending_writes)
        before = self.store.conversation(root)
        async with AsyncSqliteSaver.from_conn_string(str(self.directory / "checkpoints.sqlite")) as reopened:
            self.graph = self.recovery_graph(reopened, interrupt_before=["model"])
            self.assertEqual((await self.graph.aget_state(config)).values["compaction_events"], [event])
            await self.gateway.reconcile_compactions()
            self.gateway.on_compaction(child, {"status": "completed", "agent_name": "a", **event})
            await self.gateway.reconcile_compactions()
        rows = [row for row in self.store.history(root) if row.type == "context.compacted"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0].data["task_id"], rows[0].data["agent_id"]), (child, "a"))
        self.assertEqual(rows[0].data["summary_text"], event["summary_text"])
        self.assertEqual(rows[0].data["archive_path"], event["archive_path"])
        self.assertEqual(self.store.conversation(root)["updated_at"], before["updated_at"])
        self.assertEqual(self.manager.take_messages(root), [])

    def scheduler_ids(self):
        with closing(sqlite3.connect(self.scheduler_path)) as db:
            return {row[0] for row in db.execute("SELECT task_id FROM tasks")}

    async def test_idle_and_empty_delete_replays_recomputes_home_and_stream(self):
        first = self.gateway.create_conversation("旧", "a")["id"]
        second = self.gateway.create_conversation("新", "a")["id"]
        self.gateway.send_message(first, "old", "旧消息")
        await self.manager.wait(first)
        self.gateway.send_message(second, "new", "新消息")
        await self.manager.wait(second)
        await self.checkpoint(second)
        self.gateway.set_agent_on_home("a", False)
        self.assertFalse(self.store.agent_item("a")["home"])
        cursor = self.store.last_seq()
        response = await self.client.delete(f"/conversations/{second}")
        event = response.json()["event"]
        self.assertEqual((response.status_code, event["type"]), (200, "conversation.deleted"))
        self.assertNotIn("conversation_id", event)
        self.assertEqual(event["data"], {"id": second, "agent_id": "a"})
        self.assertEqual((await self.client.delete(f"/conversations/{second}")).json()["event"], event)
        self.assertEqual((await self.client.delete("/conversations/never-created")).status_code, 404)
        self.assertIsNone(await self.checkpointer.aget_tuple({"configurable": {"thread_id": second}}))
        self.assertEqual(self.scheduler_ids(), {first})
        self.assertEqual(self.store.agent_item("a")["latest_conversation"]["id"], first)
        self.assertFalse(self.store.agent_item("a")["home"])  # 全局墓碑不算带回首页的产品活动
        self.assertFalse(self.store.history(second))
        stream = self.gateway.stream(cursor, heartbeat=60)
        await anext(stream)
        self.assertEqual(await anext(stream), ("event", event))
        await stream.aclose()
        empty = self.gateway.create_conversation("空的", "c")["id"]
        self.assertEqual((await self.client.delete(f"/conversations/{empty}")).status_code, 200)
        self.assertIsNone(self.store.agent_item("c")["latest_conversation"])

    async def test_running_descendants_and_stop_race_cleanup_before_forget(self):
        root = self.gateway.create_conversation("工作", "c")["id"]
        self.block = True
        self.gateway.send_message(root, "m", "开始")
        await self.entered.wait()
        child = self.manager.start("子任务", sender_id=root, agent_name="a")["task_id"]
        leaf = self.manager.start("孙任务", sender_id=child, agent_name="b")["task_id"]
        for identity in (root, child, leaf):
            await self.checkpoint(identity)
        cleaned = []

        async def stop_hook(scope):
            cleaned.append(set(scope))
            return []

        self.manager.add_stop_hook(stop_hook)
        stopping = asyncio.create_task(self.gateway.stop(root, "stop-id"))
        deleting = asyncio.create_task(self.gateway.delete_conversation(root))
        await asyncio.wait_for(deleting, 2)
        await asyncio.wait_for(stopping, 2)
        self.assertIn({root, child, leaf}, cleaned)
        self.assertEqual(self.manager.branch_threads(root), {root})
        self.assertEqual(self.scheduler_ids(), set())
        for identity in (root, child, leaf):
            self.assertIsNone(await self.checkpointer.aget_tuple({"configurable": {"thread_id": identity}}))
        self.assertIsNone(self.store.conversation(root))
        self.assertEqual(self.store.after(0)[-1].type, "conversation.deleted")

    async def test_new_descendant_after_intent_is_added_before_checkpoint_deletion(self):
        root = self.gateway.create_conversation("竞争", "c")["id"]
        self.gateway.send_message(root, "m", "任务")
        await self.manager.wait(root)
        await self.checkpoint("late-child")
        begin = self.store.begin_delete

        def spawn_after_intent(identity, threads):
            begin(identity, threads)
            self.manager.start("后来委派", "late-child", sender_id=root, agent_name="a")

        self.store.begin_delete = spawn_after_intent
        event = await self.gateway.delete_conversation(root)
        self.assertEqual(event.type, "conversation.deleted")
        self.assertIsNone(await self.checkpointer.aget_tuple({"configurable": {"thread_id": "late-child"}}))
        self.assertEqual(self.scheduler_ids(), set())

    async def test_deleting_rejects_commands_and_shared_waiters_survive_cancellation(self):
        root = self.gateway.create_conversation("并发", "main")["id"]
        self.block = True
        self.gateway.send_message(root, "m", "长任务")
        await self.entered.wait()
        cleanup_started, release_cleanup = asyncio.Event(), asyncio.Event()

        async def slow_cleanup(scope):
            cleanup_started.set()
            await release_cleanup.wait()
            return []

        self.manager.add_stop_hook(slow_cleanup)
        first = asyncio.create_task(self.gateway.delete_conversation(root))
        await asyncio.wait_for(cleanup_started.wait(), 2)
        other = asyncio.create_task(self.gateway.delete_conversation(root))
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(
            (await self.client.patch(f"/conversations/{root}", json={"title": "新"})).status_code, 409
        )
        self.assertEqual(
            (await self.client.post(
                f"/conversations/{root}/messages", json={"client_id": "again", "text": "继续"}
            )).status_code, 409
        )
        self.assertEqual(
            (await self.client.post(f"/conversations/{root}/stop", json={"client_id": "stop"})).status_code,
            409,
        )
        release_cleanup.set()
        event = await asyncio.wait_for(other, 2)
        self.assertEqual(event.type, "conversation.deleted")
        self.assertIsNone(self.store.conversation(root))

    async def test_unconfirmed_cleanup_is_fatal_and_durable_for_restart(self):
        root = self.gateway.create_conversation("未确认", "main")["id"]
        self.gateway.send_message(root, "m", "任务")
        await self.manager.wait(root)
        await self.checkpoint(root)

        async def unconfirmed(scope):
            return ["remote process could not be confirmed"]

        self.manager.add_stop_hook(unconfirmed)
        with self.assertRaises(GatewayFailure):
            await self.gateway.delete_conversation(root)
        self.assertIsNotNone(self.store.conversation(root))
        self.assertEqual(self.store.deletion_threads(root), [root])
        self.assertIsNotNone(await self.checkpointer.aget_tuple({"configurable": {"thread_id": root}}))
        self.assertEqual(self.scheduler_ids(), {root})
        await self.manager.close()
        restarted_store = open_store(self, self.directory / "gateway.sqlite", seeded=False)
        restarted = Gateway(restarted_store)
        self.open_manager(restarted)
        await restarted.resume_deletions()
        self.assertIsNone(restarted_store.conversation(root))
        self.assertEqual(self.scheduler_ids(), set())

    async def test_checkpoint_delete_failure_preserves_branch_until_recovery(self):
        root = self.gateway.create_conversation("检查点故障", "main")["id"]
        self.gateway.send_message(root, "m", "任务")
        await self.manager.wait(root)
        await self.checkpoint(root)
        original = self.checkpointer.adelete_thread

        async def fail_once(thread_id):
            raise OSError("injected checkpoint failure")

        self.checkpointer.adelete_thread = fail_once
        with self.assertRaises(GatewayFailure):
            await self.gateway.delete_conversation(root)
        self.assertIsInstance(self.gateway.failure.__cause__, OSError)
        self.assertEqual(self.scheduler_ids(), {root})
        self.assertIsNotNone(await self.checkpointer.aget_tuple({"configurable": {"thread_id": root}}))
        self.assertEqual(self.store.deletion_threads(root), [root])
        self.checkpointer.adelete_thread = original
        await self.manager.close()
        restarted_store = open_store(self, self.directory / "gateway.sqlite", seeded=False)
        restarted = Gateway(restarted_store)
        self.open_manager(restarted)
        await restarted.resume_deletions()
        self.assertEqual(self.scheduler_ids(), set())
        self.assertIsNone(await self.checkpointer.aget_tuple({"configurable": {"thread_id": root}}))

    async def test_failure_keeps_intent_and_restart_finishes_without_duplicate_event(self):
        root = self.gateway.create_conversation("故障", "main")["id"]
        self.gateway.send_message(root, "first", "开始")
        await self.manager.wait(root)
        await self.checkpoint(root)
        finish = self.store.finish_delete
        self.store.finish_delete = lambda *_: (_ for _ in ()).throw(OSError("injected I/O"))
        with self.assertRaises(GatewayFailure):
            await self.gateway.delete_conversation(root)
        self.assertEqual(self.store.deletion_threads(root), [root])
        self.assertIsNone(await self.checkpointer.aget_tuple({"configurable": {"thread_id": root}}))
        self.assertIsInstance(self.gateway.failure.__cause__, OSError)
        await self.manager.close()
        self.store.finish_delete = finish
        restarted_store = open_store(self, self.directory / "gateway.sqlite", seeded=False)
        restarted = Gateway(restarted_store)
        manager = self.open_manager(restarted)
        self.assertEqual(manager.get(root)["status"], "not_found")
        await restarted.resume_deletions()
        self.assertIsNone(restarted_store.conversation(root))
        event = await restarted.delete_conversation(root)
        self.assertEqual(event, await restarted.delete_conversation(root))
        self.assertEqual(
            [e.type for e in restarted_store.after(0) if e.type == "conversation.deleted"],
            ["conversation.deleted"],
        )


if __name__ == "__main__":
    unittest.main()
