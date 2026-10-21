"""Memory snapshots and guarded ordinary file tools through real Agent graphs."""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pydantic_monty as pm
from deepagents.backends import LocalShellBackend
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.config import AgentDefinition
from wandrun.runtime.agents import build_agents, run_conversation
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.environments import Environment
from wandrun.runtime.memory import MemoryReadError, MemoryStore
from wandrun.runtime.memory_runtime import MEMORY_PATH, ManagedMemoryBackend, MemoryMiddleware
from wandrun.runtime.messages import AgentOutput
from wandrun.runtime.workers import WorkerManager


def _done():
    result = AgentOutput(messages=[], next="done")
    return AIMessage(
        content=result.model_dump_json(),
        additional_kwargs={"wandrun_agent_output": result.model_dump()},
    )


class RecordingModel(FakeMessagesListChatModel):
    observations: list
    calls: list

    def __init__(self, calls=()):
        super().__init__(responses=[], observations=[], calls=list(calls))

    def bind_tools(self, tools, **kwargs):
        return self.bind()

    async def _agenerate(self, messages, **kwargs):
        self.observations.append([
            message.content for message in messages
            if isinstance(message, HumanMessage)
            and message.additional_kwargs.get("source") == "runtime"
            and "Agent 记忆更新" in message.content
        ])
        result = self.calls.pop(0) if self.calls else _done()
        return ChatResult(generations=[ChatGeneration(message=result)])


def _call(name, args, number):
    return AIMessage(content="", tool_calls=[{
        "name": name, "args": args, "id": f"call-{number}", "type": "tool_call",
    }])


class RuntimeMemoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / "local"
        self.remote = self.root / "remote"
        self.local.mkdir()
        self.remote.mkdir()
        self.changes = []
        self.store = MemoryStore(self.root / "host-memory", on_change=self.changes.append)
        self.saver = InMemorySaver()
        self.backends = []
        self.managers = []

    async def asyncTearDown(self):
        for manager in self.managers:
            await manager.close()

    def assemblies(self, models, *, remote=(), code_pool=None):
        definitions = {
            name: AgentDefinition(name, "role", "test", code_mode=code_pool is not None)
            for name in models
        }
        environments = {}
        for name in models:
            backend = LocalShellBackend(
                root_dir=self.remote if name in remote else self.local, virtual_mode=True,
            )
            self.backends.append(backend)
            environments[name] = Environment("remote" if name in remote else "local", backend, "/skills", "/artifacts")
        async def runner(prompts, task_id):
            raise AssertionError("No delegation expected")
        manager = WorkerManager(
            runner, agent_workers={name: () for name in models}, default_agent=next(iter(models)),
        )
        self.managers.append(manager)
        return build_agents(
            manager, definitions=definitions, models=models,
            tools={name: [] for name in models}, environments=environments,
            checkpointer=self.saver, memory=self.store, code_pool=code_pool,
        )

    async def run_task(self, assembly, task_id, agent_id):
        await run_conversation(
            assembly.graph, [HumanMessage(content="continue")], task_id, agent_id,
        )
        return (await assembly.graph.aget_state(conversation_config(task_id))).values

    async def test_thread_versions_restart_clear_and_agent_identity(self):
        alpha = RecordingModel()
        beta = RecordingModel()
        agents = self.assemblies({"alpha": alpha, "beta": beta}, remote=("beta",))
        initial = await self.run_task(agents["alpha"], "one", "alpha")
        self.assertIn("当前记忆为空", alpha.observations[-1][-1])
        self.assertEqual(initial["memory_version"], self.store.read("alpha").version)
        self.assertEqual(len(alpha.observations[-1]), 1)

        await self.run_task(agents["alpha"], "one", "alpha")
        self.assertEqual(len(alpha.observations[-1]), 1)
        before = self.store.read("alpha")
        self.store.save("alpha", "新背景 🐳", before.version)
        await self.run_task(agents["alpha"], "one", "alpha")
        self.assertEqual(len(alpha.observations[-1]), 2)
        self.assertIn("新背景 🐳", alpha.observations[-1][-1])
        self.assertEqual(len(alpha.observations[-1][-1].split("新背景 🐳")), 2)

        # A second thread gets its own first complete snapshot; another Agent
        # never inherits alpha's content even when it runs against a remote backend.
        await self.run_task(agents["alpha"], "two", "alpha")
        self.assertEqual(len(alpha.observations[-1]), 1)
        await self.run_task(agents["beta"], "delegated", "beta")
        self.assertEqual(len(beta.observations[-1]), 1)
        self.assertNotIn("新背景", beta.observations[-1][-1])

        self.store.save("alpha", "", self.store.read("alpha").version)
        self.store = MemoryStore(self.store.root, on_change=self.changes.append)
        rebuilt = self.assemblies({"alpha": RecordingModel()})["alpha"]
        state = await self.run_task(rebuilt, "one", "alpha")
        memory_rows = [m for m in state["messages"] if isinstance(m, HumanMessage)
                       and "Agent 记忆更新" in m.content]
        self.assertEqual(len(memory_rows), 3)
        self.assertIn("当前记忆为空", memory_rows[-1].content)
        self.assertEqual(state["memory_version"], self.store.read("alpha").version)

    async def test_running_task_observes_update_only_at_next_model_boundary(self):
        entered, release = asyncio.Event(), asyncio.Event()

        class PausedModel(RecordingModel):
            async def _agenerate(model, messages, **kwargs):
                response = await super()._agenerate(messages, **kwargs)
                if len(model.observations) == 1:
                    entered.set()
                    await release.wait()
                return response

        saved = self.store.save("alpha", "旧背景", self.store.read("alpha").version)
        model = PausedModel([_call("read_file", {"file_path": "/notes.md"}, 1), _done()])
        (self.local / "notes.md").write_text("普通任务", encoding="utf-8")
        assembly = self.assemblies({"alpha": model})["alpha"]
        running = asyncio.create_task(self.run_task(assembly, "active", "alpha"))
        try:
            await asyncio.wait_for(entered.wait(), 5)
            updated = self.store.save("alpha", "新背景", saved.version)
            self.assertIn("旧背景", model.observations[0][-1])
            self.assertNotIn("新背景", model.observations[0][-1])
        finally:
            release.set()
        state = await running
        self.assertIn("新背景", model.observations[1][-1])
        self.assertEqual(len(model.observations[1]), 2)
        self.assertEqual(state["memory_version"], updated.version)

    async def test_sqlite_reopen_replays_snapshot_after_model_failure_then_loads_new_version(self):
        database = str(self.root / "checkpoints.sqlite")
        saved = self.store.save("alpha", "持久旧正文", self.store.read("alpha").version)
        async with AsyncSqliteSaver.from_conn_string(database) as saver:
            self.saver = saver
            model = RecordingModel()
            assembly = self.assemblies({"alpha": model})["alpha"]
            with patch.object(RecordingModel, "_agenerate", side_effect=RuntimeError("model unavailable")):
                with self.assertRaisesRegex(RuntimeError, "model unavailable"):
                    await self.run_task(assembly, "persisted", "alpha")
            state = (await assembly.graph.aget_state(conversation_config("persisted"))).values
            self.assertEqual(state["memory_version"], saved.version)
            self.assertIn("持久旧正文", state["messages"][-1].content)
        async with AsyncSqliteSaver.from_conn_string(database) as saver:
            self.saver = saver
            model = RecordingModel()
            assembly = self.assemblies({"alpha": model})["alpha"]
            await self.run_task(assembly, "persisted", "alpha")
            self.assertEqual(len(model.observations[-1]), 1)
            updated = self.store.save("alpha", "重启后新正文", saved.version)
        async with AsyncSqliteSaver.from_conn_string(database) as saver:
            self.saver = saver
            model = RecordingModel()
            assembly = self.assemblies({"alpha": model})["alpha"]
            state = await self.run_task(assembly, "persisted", "alpha")
            self.assertEqual(state["memory_version"], updated.version)
            self.assertEqual(len(model.observations[-1]), 2)
            self.assertIn("重启后新正文", model.observations[-1][-1])
            (self.store.root / "alpha.md").unlink()
            await self.run_task(assembly, "persisted", "alpha")
            self.assertIn("当前记忆为空", model.observations[-1][-1])

    async def test_unreadable_or_oversized_memory_never_requests_model(self):
        saved = self.store.save("alpha", "有效正文", self.store.read("alpha").version)
        model = RecordingModel()
        assembly = self.assemblies({"alpha": model})["alpha"]
        await self.run_task(assembly, "existing", "alpha")
        path = self.store.root / "alpha.md"
        path.chmod(0)
        try:
            with self.assertRaises(PermissionError):
                await self.run_task(assembly, "existing", "alpha")
        finally:
            path.chmod(0o600)
        path.write_text("中" * 1001, encoding="utf-8")
        with self.assertRaises(MemoryReadError):
            await self.run_task(assembly, "existing", "alpha")
        self.assertEqual(len(model.observations), 1)
        state = (await assembly.graph.aget_state(conversation_config("existing"))).values
        self.assertEqual(state["memory_version"], saved.version)

    async def test_double_slash_virtual_alias_cannot_create_shadow_memory(self):
        model = RecordingModel([
            _call("write_file", {"file_path": "//.wandrun/memory.md", "content": "宿主正文"}, 1),
            _call("edit_file", {
                "file_path": "///.wandrun/./memory.md", "old_string": "宿主", "new_string": "唯一宿主",
            }, 2),
            _call("read_file", {"file_path": MEMORY_PATH}, 3),
            _done(),
        ])
        state = await self.run_task(self.assemblies({"alpha": model})["alpha"], "aliases", "alpha")
        self.assertEqual(self.store.read("alpha").content, "唯一宿主正文")
        results = [message for message in state["messages"] if isinstance(message, ToolMessage)]
        self.assertEqual([message.status for message in results], ["success"] * 3)
        self.assertIn("唯一宿主正文", results[-1].content)
        self.assertFalse((self.local / ".wandrun" / "memory.md").exists())

    async def test_ordinary_file_tools_edit_exactly_and_report_source_task(self):
        model = RecordingModel([
            _call("write_file", {"file_path": MEMORY_PATH, "content": "前文\n保留\n旧值\n"}, 1),
            _call("edit_file", {
                "file_path": MEMORY_PATH, "old_string": "旧值", "new_string": "新值",
            }, 2),
            _call("read_file", {"file_path": MEMORY_PATH}, 3),
            _done(),
        ])
        assembly = self.assemblies({"alpha": model})["alpha"]
        state = await self.run_task(assembly, "root-task", "alpha")
        self.assertEqual(self.store.read("alpha").content, "前文\n保留\n新值\n")
        self.assertEqual([change.task_id for change in self.changes], ["root-task", "root-task"])
        self.assertEqual(len([m for m in state["messages"] if isinstance(m, HumanMessage)
                              and "Agent 记忆更新" in m.content]), 3)
        tool_rows = [m for m in state["messages"] if isinstance(m, ToolMessage)]
        self.assertTrue(all(m.status == "success" for m in tool_rows))
        self.assertIn("保留", tool_rows[-1].content)

    async def test_conflict_missing_ambiguous_clear_and_local_alias(self):
        model = RecordingModel([
            _call("write_file", {"file_path": MEMORY_PATH, "content": "一\n一\n留存\n"}, 1),
            _call("edit_file", {"file_path": MEMORY_PATH, "old_string": "一", "new_string": "二"}, 2),
            _call("edit_file", {"file_path": MEMORY_PATH, "old_string": "不存在", "new_string": "二"}, 3),
            _call("edit_file", {
                "file_path": MEMORY_PATH, "old_string": "一", "new_string": "二", "replace_all": True,
            }, 4),
            _call("delete", {"file_path": MEMORY_PATH}, 5),
            _done(),
        ])
        assembly = self.assemblies({"alpha": model})["alpha"]
        state = await self.run_task(assembly, "task", "alpha")
        statuses = [(m.name, m.status) for m in state["messages"] if isinstance(m, ToolMessage)]
        self.assertEqual(statuses, [
            ("write_file", "success"), ("edit_file", "error"), ("edit_file", "error"),
            ("edit_file", "success"), ("delete", "success"),
        ])
        self.assertEqual(self.store.read("alpha").content, "")
        self.assertEqual(len(self.changes), 3)

        backend = ManagedMemoryBackend(self.backends[0], self.store, "alpha")
        other = self.store.root / "beta.md"
        with self.assertRaisesRegex(ValueError, "受管记忆"):
            await backend.awrite(str(other), "bypass")
        with self.assertRaisesRegex(ValueError, "受管记忆"):
            await backend.aread(str(self.store.root / "alpha.md"))
        self.assertFalse(other.exists())

    async def test_relative_and_symlink_host_aliases_cannot_escape_code_mode_guard(self):
        from types import SimpleNamespace

        from wandrun.runtime.code_mode import CodeModeCatalog, code_mode_tool

        store = MemoryStore(self.root / ".wandrun" / "state" / "memory")
        initial = store.read("alpha")
        store.save("alpha", "authoritative", initial.version)
        (self.root / "memory-alias").symlink_to(store.root, target_is_directory=True)
        backend = ManagedMemoryBackend(
            LocalShellBackend(root_dir=self.root, virtual_mode=False), store, "alpha",
        )
        aliases = (
            ".wandrun/state/memory/alpha.md",
            "memory-alias/alpha.md",
            ".wandrun/state/memory/beta.md",
        )
        for alias in aliases:
            with self.subTest(alias=alias):
                with self.assertRaisesRegex(ValueError, "受管记忆"):
                    await backend.aread(alias)
                with self.assertRaisesRegex(ValueError, "受管记忆"):
                    await backend.awrite(alias, "unsafe")

        request = SimpleNamespace(
            runtime=SimpleNamespace(context={"task_id": "code-task"}),
            state={"memory_version": store.read("alpha").version},
        )
        async with pm.AsyncMonty() as pool:
            tool = code_mode_tool(pool, backend, CodeModeCatalog([], []))

            async def operation(_request):
                return await tool.ainvoke({
                    "type": "tool_call", "id": "alias", "name": "run_code",
                    "args": {"code": "await write('.wandrun/state/memory/beta.md', 'unsafe')"},
                })

            result = await MemoryMiddleware(store, "alpha").awrap_tool_call(request, operation)
        self.assertEqual(result.status, "error")
        self.assertEqual(store.read("alpha").content, "authoritative")
        self.assertFalse((store.root / "beta.md").exists())
        store.save("beta", "other Agent", store.read("beta").version)
        (self.root / "state-alias").symlink_to(store.root.parent, target_is_directory=True)
        for ancestor in (".wandrun/state", "state-alias", str(self.root)):
            with self.subTest(ancestor=ancestor):
                with self.assertRaisesRegex(ValueError, "上级路径"):
                    await backend.adelete(ancestor)
        self.assertEqual(store.read("alpha").content, "authoritative")
        self.assertEqual(store.read("beta").content, "other Agent")
        # The deletion rule is specific to recursive delete, not normal reads.
        self.assertIsNone((await backend.als(str(self.root))).error)


    async def test_parallel_tool_calls_keep_independent_write_baselines(self):
        model = RecordingModel([
            AIMessage(content="", tool_calls=[
                {"name": "write_file", "args": {"file_path": MEMORY_PATH, "content": "first"},
                 "id": "first", "type": "tool_call"},
                {"name": "write_file", "args": {"file_path": MEMORY_PATH, "content": "second"},
                 "id": "second", "type": "tool_call"},
            ]),
            _done(),
        ])
        assembly = self.assemblies({"alpha": model})["alpha"]
        state = await self.run_task(assembly, "parallel", "alpha")
        statuses = sorted(m.status for m in state["messages"] if isinstance(m, ToolMessage))
        self.assertEqual(statuses, ["error", "success"])
        self.assertIn(self.store.read("alpha").content, ("first", "second"))
        self.assertEqual(len(self.changes), 1)

    async def test_external_conflict_and_invalid_document_stop_before_model(self):
        model = RecordingModel()
        assembly = self.assemblies({"alpha": model})["alpha"]
        original = self.store.read("alpha")
        # A tool call made with the checkpoint-observed version must not silently
        # refresh its baseline when an external writer changed the file.
        observation = MemoryMiddleware(self.store, "alpha")
        async def conflict(request):
            backend = ManagedMemoryBackend(self.backends[0], self.store, "alpha")
            partial = await backend.aread(MEMORY_PATH, limit=0)
            self.assertTrue(partial.no_lines_requested)
            return await backend.awrite(MEMORY_PATH, "不能覆盖")
        from types import SimpleNamespace
        stale = SimpleNamespace(runtime=SimpleNamespace(context={"task_id": "task"}),
                                state={"memory_version": original.version})
        self.store.save("alpha", "外部新版本", original.version)
        result = await observation.awrap_tool_call(stale, conflict)
        self.assertIn("已更新", result.error)
        self.assertEqual(self.store.read("alpha").content, "外部新版本")

        async def observed(request):
            backend = ManagedMemoryBackend(self.backends[0], self.store, "alpha")
            content = await backend.aread(MEMORY_PATH)
            self.assertEqual(content.file_data["content"], "外部新版本")
            return await backend.aedit(MEMORY_PATH, "新版本", "合并版")

        merged = await observation.awrap_tool_call(stale, observed)
        self.assertIsNone(merged.error)
        self.assertEqual(self.store.read("alpha").content, "外部合并版")

        path = self.store.root / "alpha.md"
        path.write_bytes(b"\xff")
        with self.assertRaises(MemoryReadError):
            await self.run_task(assembly, "broken", "alpha")
        self.assertEqual(model.observations, [])

    async def test_invalid_checkpoint_version_and_retired_agent_stop_at_boundary(self):
        middleware = MemoryMiddleware(self.store, "alpha")
        with self.assertRaisesRegex(ValueError, "版本无效"):
            await middleware.abefore_model({"memory_version": "damaged"}, None)
        self.store.retire("alpha")
        with self.assertRaisesRegex(ValueError, "已删除"):
            await middleware.abefore_model({}, None)

    async def test_upload_download_share_managed_content_and_version(self):
        from types import SimpleNamespace

        backend = ManagedMemoryBackend(
            LocalShellBackend(root_dir=self.local, virtual_mode=True), self.store, "alpha",
        )
        self.backends.append(backend.backend)
        middleware = MemoryMiddleware(self.store, "alpha")
        request = SimpleNamespace(
            runtime=SimpleNamespace(context={"task_id": "transfer-task"}),
            state={"memory_version": self.store.read("alpha").version},
        )

        async def transfer(_request):
            uploaded = await backend.aupload_files([(MEMORY_PATH, "长期背景".encode("utf-8"))])
            invalid = await backend.aupload_files([(MEMORY_PATH, b"\xff")])
            downloaded = await backend.adownload_files([MEMORY_PATH])
            return uploaded, invalid, downloaded

        uploaded, invalid, downloaded = await middleware.awrap_tool_call(request, transfer)
        self.assertIsNone(uploaded[0].error)
        self.assertIsNotNone(invalid[0].error)
        self.assertEqual(downloaded[0].content.decode("utf-8"), "长期背景")
        self.assertEqual(self.changes[0].task_id, "transfer-task")
        self.assertFalse((self.local / ".wandrun" / "memory.md").exists())

    async def test_code_mode_sequential_host_operations(self):
        async with pm.AsyncMonty() as pool:
            model = RecordingModel([
                _call("run_code", {"code": (
                    f"await write('{MEMORY_PATH}', '甲\\n乙')\n"
                    f"await edit('{MEMORY_PATH}', '甲', '更新')\n"
                    "await write('/notes.md', 'remote document')\n"
                    f"data = await read('{MEMORY_PATH}')\nprint(data['file_data']['content'])"
                )}, 1),
                _done(),
            ])
            assembly = self.assemblies({"alpha": model}, remote=("alpha",), code_pool=pool)["alpha"]
            state = await self.run_task(assembly, "code-task", "alpha")
            result = next(m for m in state["messages"] if isinstance(m, ToolMessage))
            self.assertEqual(result.status, "success")
            self.assertIn("更新", result.content)
            self.assertEqual(self.store.read("alpha").content, "更新\n乙")
            self.assertFalse((self.remote / ".wandrun" / "memory.md").exists())
            self.assertEqual((self.remote / "notes.md").read_text(), "remote document")
            self.assertEqual([c.task_id for c in self.changes], ["code-task", "code-task"])
