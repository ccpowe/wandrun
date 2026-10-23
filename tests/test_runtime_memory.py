"""Two scoped snapshots and managed file/Code Mode write permissions."""

import asyncio
import re
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import pydantic_monty as pm
from deepagents.backends import FilesystemBackend, LocalShellBackend
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.config import AgentDefinition
from wandrun.runtime.agents import build_agents, run_conversation
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.environments import Environment
from wandrun.runtime.memory import InvalidMemory, MemoryStore
from wandrun.runtime.memory_runtime import (
    PROFILE_MEMORY_PATH, WORK_MEMORY_PATH, ManagedMemoryBackend, MemoryMiddleware,
    _ToolObservation,
)
from wandrun.runtime.messages import AgentOutput
from wandrun.runtime.workers import WorkerManager


def _done():
    output = AgentOutput(messages=[], next="done")
    return AIMessage(content=output.model_dump_json(),
                     additional_kwargs={"wandrun_agent_output": output.model_dump()})


class RecordingModel(FakeMessagesListChatModel):
    observations: list
    calls: list

    def __init__(self, calls=()):
        super().__init__(responses=[], observations=[], calls=list(calls))

    def bind_tools(self, tools, **kwargs):
        return self.bind()

    async def _agenerate(self, messages, **kwargs):
        self.observations.append([
            (message.additional_kwargs.get("memory_snapshot_scope"), message.content)
            for message in messages if isinstance(message, HumanMessage)
            and message.additional_kwargs.get("memory_snapshot_scope")
        ])
        result = self.calls.pop(0) if self.calls else _done()
        return ChatResult(generations=[ChatGeneration(message=result)])

class DetailPublishingModel(RecordingModel):
    """Publish only the canonical path supplied by the ordinary tool feedback."""
    store: object = None
    existing_path: str | None = None
    feedback: object = None
    published_path: str | None = None

    def __init__(self, store, *, existing_path=None):
        super().__init__()
        self.store = store
        self.existing_path = existing_path
        self.feedback = None
        self.published_path = None

    async def _agenerate(self, messages, **kwargs):
        feedback = [message for message in messages if isinstance(message, ToolMessage)]
        if not feedback:
            name = "edit_file" if self.existing_path else "write_file"
            args = ({"file_path": self.existing_path, "old_string": "old detail",
                     "new_string": "new detail"} if self.existing_path else {
                         "file_path": "/.wandrun/memory/work/details/style.md",
                         "content": "new detail",
                     })
            response = AIMessage(content="", tool_calls=[
                {"name": name, "args": args, "id": "prepare", "type": "tool_call"},
            ])
        elif len(feedback) == 1:
            self.feedback = feedback[0]
            paths = {
                path for path in re.findall(
                    r"/\.wandrun/memory/work/details/style/[0-9a-f]{64}\.md",
                    self.feedback.content,
                ) if path != self.existing_path
            }
            if len(paths) != 1:
                raise AssertionError("ordinary ToolMessage did not supply one new canonical path")
            self.published_path = paths.pop()
            current = self.store.read("alpha")
            if self.existing_path:
                assert current.details["style"]["path"] == self.existing_path
                assert self.store.read_detail("alpha", "style").content == "old detail"
            else:
                assert "style" not in current.details
            index = f"偏好 [详情]({self.published_path})"
            if self.existing_path:
                response = AIMessage(content="", tool_calls=[{
                    "name": "edit_file",
                    "args": {"file_path": WORK_MEMORY_PATH,
                             "old_string": f"偏好 [详情]({self.existing_path})",
                             "new_string": index},
                    "id": "publish", "type": "tool_call",
                }])
            else:
                response = AIMessage(content="", tool_calls=[{
                    "name": "write_file", "args": {"file_path": WORK_MEMORY_PATH, "content": index},
                    "id": "publish", "type": "tool_call",
                }])
        else:
            response = AIMessage(content="", tool_calls=[{
                "name": "read_file", "args": {"file_path": self.published_path},
                "id": "read-published", "type": "tool_call",
            }]) if len(feedback) == 2 else _done()
        return ChatResult(generations=[ChatGeneration(message=response)])


class LeaseManager:
    """Trusted task lease for direct backend and Code Mode host-callback tests."""

    def __init__(self):
        self.generation = 1
        self.agent = "alpha"
        self.task = "root"
        self.profile = True

    def authorize_memory(self, task_id, agent_id, generation, *, profile):
        if (task_id != self.task or agent_id != self.agent or generation != self.generation
                or (profile and not self.profile)):
            raise ValueError("当前任务无记忆写入权限")

    def memory_permission(self, task_id, agent_id, generation):
        try:
            self.authorize_memory(task_id, agent_id, generation, profile=True)
        except ValueError:
            return False
        return True


class RuntimeMemoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.changes = []
        self.store = MemoryStore(self.root / "host-memory", on_change=self.changes.append)
        self.saver = InMemorySaver()
        self.managers = []

    async def asyncTearDown(self):
        for manager in self.managers:
            await manager.close()

    def assemblies(self, models, *, code_pool=None, delegates=None):
        agents = {}
        async def runner(prompts, task_id):
            name = manager.agent_name(task_id)
            return await run_conversation(agents[name].graph, prompts, task_id, name)
        manager = WorkerManager(runner, agent_workers=delegates or {name: () for name in models},
                                default_agent=next(iter(models)))
        self.managers.append(manager)
        definitions = {
            name: AgentDefinition(name, "role", "test", code_mode=code_pool is not None)
            for name in models
        }
        environments = {
            name: Environment("local", LocalShellBackend(root_dir=self.workspace, virtual_mode=True),
                              "/skills", "/artifacts") for name in models
        }
        agents.update(build_agents(
            manager, definitions=definitions, models=models,
            tools={name: [] for name in models}, environments=environments,
            checkpointer=self.saver, memory=self.store, code_pool=code_pool,
        ))
        return agents, manager

    async def run_task(self, agents, manager, task_id, agent_id, *, direct_user=True):
        manager.start("continue", task_id, agent_name=agent_id, direct_user=direct_user)
        result = await manager.wait(task_id)
        self.assertEqual(result["status"], "completed")
        return (await agents[agent_id].graph.aget_state(conversation_config(task_id))).values

    def backend(self, *, task_id="root", generation=1, manager=None):
        lease = manager or LeaseManager()
        observation = _ToolObservation(
            task_id, generation, {"profile": self.store.read(None).version,
                                  "work": self.store.read("alpha").version},
        )
        backend = ManagedMemoryBackend(
            LocalShellBackend(root_dir=self.workspace, virtual_mode=True),
            self.store, "alpha", manager=lease, observation=observation,
        )
        return backend, observation, lease

    async def test_independent_snapshots_shared_profile_and_work_isolation(self):
        profile = self.store.save(None, "共享画像", self.store.read(None).version)
        alpha = self.store.save("alpha", "alpha 工作方式", self.store.read("alpha").version)
        models = {"alpha": RecordingModel(), "beta": RecordingModel()}
        agents, manager = self.assemblies(models)
        state = await self.run_task(agents, manager, "root", "alpha")
        self.assertEqual(state["memory_versions"], {"profile": profile.version, "work": alpha.version})
        self.assertEqual([scope for scope, _ in models["alpha"].observations[-1]], ["profile", "work"])
        await self.run_task(agents, manager, "root", "alpha")
        self.assertEqual(len(models["alpha"].observations[-1]), 2)

        changed = self.store.save(None, "共享画像已更正", profile.version)
        await self.run_task(agents, manager, "root", "alpha")
        self.assertEqual([scope for scope, _ in models["alpha"].observations[-1]],
                         ["profile", "work", "profile"])
        self.assertIn("共享画像已更正", models["alpha"].observations[-1][-1][1])
        state = await self.run_task(agents, manager, "member", "beta", direct_user=False)
        self.assertEqual(state["memory_versions"]["profile"], changed.version)
        self.assertEqual(state["memory_versions"]["work"], self.store.read("beta").version)
        self.assertNotIn("alpha 工作方式", " ".join(body for _, body in models["beta"].observations[-1]))

        self.store.save("alpha", "新的 Agent 反馈", alpha.version)
        await self.run_task(agents, manager, "root", "alpha")
        self.assertEqual(models["alpha"].observations[-1][-1][0], "work")
        await self.run_task(agents, manager, "member", "beta", direct_user=False)
        self.assertEqual(len(models["beta"].observations[-1]), 2)

    async def test_permission_change_is_recorded_without_reappending_unchanged_indexes(self):
        model = RecordingModel()
        agents, manager = self.assemblies({"alpha": model})
        initial = await self.run_task(agents, manager, "root", "alpha", direct_user=False)
        self.assertEqual(initial["memory_permissions"]["profile"], "read-only")
        versions = initial["memory_versions"]
        interactive = await self.run_task(agents, manager, "root", "alpha", direct_user=True)
        self.assertEqual(interactive["memory_permissions"]["profile"], "read-write")
        self.assertEqual(interactive["memory_versions"], versions)
        self.assertEqual(len(model.observations[-1]), 2)
        noninteractive = await self.run_task(agents, manager, "root", "alpha", direct_user=False)
        self.assertEqual(noninteractive["memory_permissions"]["profile"], "read-only")
        self.assertEqual(noninteractive["memory_versions"], versions)
        self.assertEqual(len(model.observations[-1]), 2)

    async def test_detail_only_change_advances_document_snapshot(self):
        agents, manager = self.assemblies({"alpha": RecordingModel()})
        initial = await self.run_task(agents, manager, "root", "alpha")
        baseline = self.store.read(None)
        index = "协作偏好 [详情](" + "/.wandrun/memory/profile/details/style.md)"
        updated = self.store.put_detail(None, "style", "必要理由", baseline.version,
                                        index_content=index)
        self.assertNotEqual(updated.version, baseline.version)
        state = await self.run_task(agents, manager, "root", "alpha")
        self.assertEqual(state["memory_versions"]["profile"], updated.version)
        self.assertEqual(state["memory_versions"]["work"], initial["memory_versions"]["work"])
        self.assertEqual(self.store.read_detail(None, "style").version, updated.version)
        replaced = self.store.put_detail(None, "style", "更新理由", updated.version)
        state = await self.run_task(agents, manager, "root", "alpha")
        self.assertEqual(state["memory_versions"]["profile"], replaced.version)
        self.assertEqual(state["memory_versions"]["work"], initial["memory_versions"]["work"])

    async def test_running_request_sees_edit_only_at_next_boundary(self):
        entered, release = asyncio.Event(), asyncio.Event()
        class Paused(RecordingModel):
            async def _agenerate(model, messages, **kwargs):
                response = await super()._agenerate(messages, **kwargs)
                if len(model.observations) == 1:
                    entered.set()
                    await release.wait()
                return response
        saved = self.store.save(None, "旧画像", self.store.read(None).version)
        model = Paused([AIMessage(content="", tool_calls=[{
            "name": "read_file", "args": {"file_path": "/notes.md"},
            "id": "read-1", "type": "tool_call",
        }]), _done()])
        (self.workspace / "notes.md").write_text("ordinary")
        agents, manager = self.assemblies({"alpha": model})
        manager.start("work", "root", direct_user=True)
        try:
            await asyncio.wait_for(entered.wait(), 5)
            updated = self.store.save(None, "新画像", saved.version)
            self.assertIn("旧画像", model.observations[0][0][1])
            self.assertNotIn("新画像", model.observations[0][0][1])
        finally:
            release.set()
        self.assertEqual((await manager.wait("root"))["status"], "completed")
        state = (await agents["alpha"].graph.aget_state(conversation_config("root"))).values
        self.assertEqual(state["memory_versions"]["profile"], updated.version)
        self.assertIn("新画像", model.observations[-1][-1][1])

    async def test_parallel_ordinary_file_tools_commit_one_observed_baseline(self):
        for scope, path, owner in (("profile", PROFILE_MEMORY_PATH, None),
                                   ("work", WORK_MEMORY_PATH, "alpha")):
            with self.subTest(scope=scope):
                initial = self.store.read(owner)
                contents = {f"{scope}-a": "first candidate", f"{scope}-b": "second candidate"}
                model = RecordingModel([AIMessage(content="", tool_calls=[
                    {"name": "write_file", "args": {"file_path": path, "content": content},
                     "id": call_id, "type": "tool_call"}
                    for call_id, content in contents.items()
                ])])
                agents, manager = self.assemblies({"alpha": model})
                change_start = len(self.changes)
                state = await self.run_task(agents, manager, f"parallel-{scope}", "alpha")
                feedback = [m for m in state["messages"] if isinstance(m, ToolMessage)
                            and m.tool_call_id in contents]
                self.assertEqual(sorted(m.status for m in feedback), ["error", "success"])
                winner = next(m.tool_call_id for m in feedback if m.status == "success")
                current = self.store.read(owner)
                self.assertEqual(current.content, contents[winner])
                self.assertEqual(current.revision, initial.revision + 1)
                self.assertEqual(state["memory_versions"][scope], current.version)
                self.assertEqual(len(self.changes[change_start:]), 1)

    async def test_real_monty_same_agent_member_cannot_write_profile_but_can_write_work(self):
        profile = self.store.save(None, "user-owned profile", self.store.read(None).version)
        waiting = AgentOutput(messages=[], next="wait")
        script = (
            f"try:\n    await write({PROFILE_MEMORY_PATH!r}, 'unauthorized profile')\n"
            "except RuntimeError:\n    pass\n"
            "else:\n    raise RuntimeError('delegated profile write unexpectedly succeeded')\n"
            f"await write({WORK_MEMORY_PATH!r}, 'member working memory')\n"
            f"print((await read({WORK_MEMORY_PATH!r}))['file_data']['content'])\n"
        )
        model = RecordingModel([
            AIMessage(content=waiting.model_dump_json(),
                      additional_kwargs={"wandrun_agent_output": waiting.model_dump()}),
            AIMessage(content="", tool_calls=[{
                "name": "run_code", "args": {"code": script}, "id": "member-code", "type": "tool_call",
            }]),
        ])
        async with pm.AsyncMonty() as pool:
            # Same Agent identity deliberately cannot stand in for root provenance.
            # The manager admits this delegated task; the actual graph captures its
            # execution generation and Monty callbacks must recheck that lease.
            agents, manager = self.assemblies({"alpha": model}, code_pool=pool,
                                               delegates={"alpha": ("alpha",)})
            try:
                manager.start("wait for delegated work", "root", direct_user=True)
                self.assertEqual((await manager.wait("root"))["status"], "waiting")
                manager.start("delegated work", "member", sender_id="root", agent_name="alpha")
                self.assertEqual((await manager.wait("member"))["status"], "completed")
                state = (await agents["alpha"].graph.aget_state(conversation_config("member"))).values
                result = next(m for m in state["messages"] if isinstance(m, ToolMessage)
                              and m.tool_call_id == "member-code")
                self.assertEqual(result.status, "success")
                self.assertEqual(manager.task_identity("member"), ("alpha", "root"))
                self.assertEqual(state["memory_permissions"], {"profile": "read-only", "work": "read-write"})
                self.assertEqual(self.store.read(None), profile)
                self.assertEqual(self.store.read("alpha").content, "member working memory")
                self.assertEqual(self.changes[-1].task_id, "member")
            finally:
                await manager.close()

    async def test_nonvirtual_relative_and_symlink_aliases_cannot_bypass_host_memory(self):
        profile = self.store.save(None, "private profile", self.store.read(None).version)
        work = self.store.save("alpha", "private work", self.store.read("alpha").version)
        link = self.workspace / "memory-alias"
        link.symlink_to(self.store.root, target_is_directory=True)
        for backend_type in (FilesystemBackend, LocalShellBackend):
            with self.subTest(backend=backend_type.__name__):
                backend = ManagedMemoryBackend(
                    backend_type(root_dir=self.workspace, virtual_mode=False), self.store, "alpha",
                )
                for alias in ("../host-memory/profile/current.json", "memory-alias/profile/current.json",
                              "../host-memory/agents/alpha/current.json", "memory-alias/agents/alpha/current.json"):
                    with self.subTest(alias=alias):
                        with self.assertRaises(ValueError):
                            await backend.aread(alias)
                        with self.assertRaises(ValueError):
                            await backend.awrite(alias, "bypass")
                        with self.assertRaises(ValueError):
                            await backend.adelete(alias)
                for ancestor in ("..", "memory-alias", "memory-alias/.."):
                    with self.subTest(ancestor=ancestor), self.assertRaises(ValueError):
                        await backend.adelete(ancestor)
                self.assertEqual(self.store.read(None), profile)
                self.assertEqual(self.store.read("alpha"), work)
                self.assertTrue(link.is_symlink())
                self.assertTrue(self.workspace.is_dir())
                # Positive control: ordinary nonvirtual files still use the real
                # filesystem, so rejecting aliases cannot mean denying every path.
                self.assertIsNone((await backend.awrite("ordinary.txt", "task result")).error)
                self.assertEqual((self.workspace / "ordinary.txt").read_text(), "task result")
                self.assertEqual((await backend.aread("ordinary.txt")).file_data["content"], "task result")
                self.assertIsNone((await backend.adelete("ordinary.txt")).error)
                self.assertFalse((self.workspace / "ordinary.txt").exists())

    async def test_ordinary_detail_prepare_publish_and_read_uses_tool_feedback_path(self):
        for editing in (False, True):
            with self.subTest(editing=editing):
                existing_path = None
                if editing:
                    baseline = self.store.read("alpha")
                    initial = self.store.put_detail(
                        "alpha", "style", "old detail", baseline.version,
                        index_content="偏好 [详情](/.wandrun/memory/work/details/style.md)",
                    )
                    existing_path = initial.details["style"]["path"]
                model = DetailPublishingModel(self.store, existing_path=existing_path)
                agents, manager = self.assemblies({"alpha": model})
                state = await self.run_task(agents, manager, f"detail-{editing}", "alpha")
                self.assertIsNotNone(model.feedback)
                self.assertEqual(model.feedback.status, "success")
                self.assertNotEqual(model.published_path, existing_path)
                feedback = {message.tool_call_id: message for message in state["messages"]
                            if isinstance(message, ToolMessage)}
                self.assertEqual(feedback["publish"].status, "success")
                self.assertEqual(feedback["read-published"].status, "success")
                self.assertIn("new detail", feedback["read-published"].content)
                current = self.store.read("alpha")
                self.assertEqual(current.details["style"]["path"], model.published_path)
                self.assertEqual(current.content, f"偏好 [详情]({model.published_path})")
                self.assertEqual(self.store.read_detail("alpha", "style").content, "new detail")
                if existing_path:
                    self.assertNotIn(existing_path, current.content)
                    with self.assertRaises(InvalidMemory):
                        self.store.read_detail("alpha", "style", path=existing_path)

    async def test_prepared_detail_copy_on_write_and_code_mode_provenance(self):
        backend, observation, _ = self.backend()
        logical = "/.wandrun/memory/work/details/style.md"
        prepared = backend.for_code_call().write(logical, "简洁答复")
        self.assertIsNone(prepared.error)
        self.assertEqual(prepared.publication_status, "prepared_not_published")
        self.assertIn("/work/details/style/", prepared.path)
        self.assertRegex(backend.read(prepared.path).error, "失效|未发布")
        published = backend.write(WORK_MEMORY_PATH, f"风格 [详情]({prepared.path})")
        self.assertIsNone(published.error)
        detail = backend.for_code_call().read(prepared.path)
        self.assertEqual(detail.file_data["content"], "简洁答复")
        self.assertEqual(detail.memory["scope"], "work")
        self.assertEqual(detail.memory["version"], self.store.read("alpha").version)
        self.assertEqual(detail.memory["sha256"], self.store.read("alpha").details["style"]["sha256"])
        edited = backend.edit(prepared.path, "简洁", "详尽")
        self.assertEqual(edited.publication_status, "prepared_not_published")
        self.assertNotEqual(edited.path, prepared.path)
        self.assertEqual(backend.read(prepared.path).file_data["content"], "简洁答复")
        current = self.store.read("alpha")
        backend.edit(WORK_MEMORY_PATH, prepared.path, edited.path)
        self.assertNotEqual(current.version, self.store.read("alpha").version)
        self.assertIn("失效", backend.read(prepared.path).error)
        downloaded = backend.download_files([edited.path])[0]
        self.assertEqual(downloaded.memory["scope"], "work")
        self.assertEqual(downloaded.memory["version"], self.store.read("alpha").version)
        self.assertEqual(downloaded.content, "详尽答复".encode())
        self.assertEqual(observation.versions["work"], self.store.read("alpha").version)

    async def test_batch_alias_permissions_and_revoked_staging(self):
        backend, observation, lease = self.backend()
        self.assertEqual(backend.upload_files([(PROFILE_MEMORY_PATH, "共享".encode())])[0].error, None)
        self.assertEqual(self.store.read(None).content, "共享")
        lease.profile = False
        denied = backend.upload_files([(PROFILE_MEMORY_PATH, "越权".encode())])[0]
        self.assertIn("权限", denied.error)
        self.assertEqual(backend.upload_files([(WORK_MEMORY_PATH, "本 Agent".encode())])[0].error, None)
        staged = backend.write("/.wandrun/memory/work/details/plan.md", "待发布")
        self.assertIsNone(staged.error)
        self.store.discard_prepared(observation.owner)
        self.assertIn("未由当前操作", backend.write(WORK_MEMORY_PATH,
            f"记忆 [{staged.path}]({staged.path})").error)
        lease.generation = 2
        self.assertIn("权限", backend.write(WORK_MEMORY_PATH, "迟到提交").error)
        with self.assertRaisesRegex(ValueError, "记忆路径"):
            backend.read("//.wandrun/memory.md")
        with self.assertRaisesRegex(ValueError, "上级路径"):
            backend.delete("/.wandrun")
        with self.assertRaisesRegex(ValueError, "宿主|记忆路径"):
            backend.write(str(self.store.root / "profile" / "current.json"), "shadow")
        self.assertFalse((self.workspace / ".wandrun" / "memory.md").exists())

    async def test_tool_feedback_exposes_detail_provenance_and_marks_code_mode_access(self):
        lease = LeaseManager()
        backend = ManagedMemoryBackend(
            LocalShellBackend(root_dir=self.workspace, virtual_mode=True),
            self.store, "alpha", manager=lease,
        )
        middleware = MemoryMiddleware(self.store, "alpha", lease)
        baseline = self.store.read("alpha")
        saved = self.store.put_detail(
            "alpha", "style", "有范围的理由", baseline.version,
            index_content="偏好 [详情](/.wandrun/memory/work/details/style.md)",
        )
        path = saved.details["style"]["path"]
        state = {
            "memory_versions": {"profile": self.store.read(None).version, "work": saved.version},
            "messages": [],
        }
        def request(name, path=None):
            return SimpleNamespace(
                state=state,
                runtime=SimpleNamespace(context={"task_id": "root", "execution_generation": 1}),
                tool_call={"name": name, "args": {"file_path": path} if path else {}, "id": name},
            )
        async def read_detail(_):
            result = backend.read(path)
            return ToolMessage(content=result.file_data["content"], tool_call_id="read_file")
        detail = await middleware.awrap_tool_call(request("read_file", path), read_detail)
        self.assertIn(saved.version, detail.content)
        self.assertIn(saved.details["style"]["sha256"], detail.content)
        self.assertTrue(detail.additional_kwargs["managed_memory_access"])

        async def prepare(_):
            result = backend.write("/.wandrun/memory/work/details/next.md", "new detail")
            return ToolMessage(content=f"Updated file {result.path}", tool_call_id="write_file")
        prepared = await middleware.awrap_tool_call(
            request("write_file", "/.wandrun/memory/work/details/next.md"), prepare,
        )
        self.assertIn("尚未发布", prepared.content)
        self.assertTrue(prepared.additional_kwargs["managed_memory_access"])

        async def code_with_memory(_):
            result = backend.for_code_call().read(path)
            return ToolMessage(content=result.file_data["content"], tool_call_id="run_code")
        tagged = await middleware.awrap_tool_call(request("run_code"), code_with_memory)
        self.assertTrue(tagged.additional_kwargs["managed_memory_access"])
        untouched = await middleware.awrap_tool_call(
            request("run_code"),
            lambda _: asyncio.sleep(0, result=ToolMessage(content="task facts", tool_call_id="run_code")),
        )
        self.assertNotIn("managed_memory_access", untouched.additional_kwargs)

    async def test_read_only_unknown_or_stale_task_cannot_mutate_even_empty_index(self):
        agents, manager = self.assemblies({"alpha": RecordingModel()})
        backend = ManagedMemoryBackend(
            LocalShellBackend(root_dir=self.workspace, virtual_mode=True),
            self.store, "alpha", manager=manager,
            observation=_ToolObservation("unknown", 1, {
                "profile": self.store.read(None).version, "work": self.store.read("alpha").version,
            }),
        )
        self.assertIn("失效", backend.write(WORK_MEMORY_PATH, "not allowed").error)
        self.assertIn("失效", backend.write(PROFILE_MEMORY_PATH, "not allowed").error)
        self.assertEqual(backend.read(WORK_MEMORY_PATH).file_data["content"], "")
        # No manager means read-only, regardless of a forged observed version.
        unbound = ManagedMemoryBackend(
            LocalShellBackend(root_dir=self.workspace, virtual_mode=True), self.store, "alpha",
            observation=_ToolObservation("root", 1, {"profile": self.store.read(None).version,
                                                        "work": self.store.read("alpha").version}),
        )
        self.assertIn("可信", unbound.write(WORK_MEMORY_PATH, "forged").error)
        self.assertEqual((await self.run_task(agents, manager, "root", "alpha"))["memory_permissions"]["profile"], "read-write")
        self.assertFalse(manager.memory_permission("root", "alpha", 1))
