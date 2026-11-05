"""Request-only guidance and invocation-local memory through assembled Agent graphs."""

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pydantic_monty as pm
from deepagents.backends import LocalShellBackend
from langchain.messages import SystemMessage, ToolMessage
from langchain.tools import tool
from langchain_core.callbacks import AsyncCallbackHandler
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.config import AgentDefinition
from wandrun.gateway.ui_blocks import model_instructions
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.runtime.agent.agents import build_agents, run_conversation
from wandrun.runtime.agent.capabilities import EntryCapabilityDefinition
from wandrun.runtime.communication.human_message_guidance import HumanMessageGuidanceMiddleware
from wandrun.runtime.context.compaction import message_groups
from wandrun.runtime.context.compaction_summary import SUMMARY_INSTRUCTION
from wandrun.runtime.agent.conversations import conversation_config
from wandrun.runtime.execution.environments import Environment
from wandrun.runtime.execution.files import TaskBackend, TaskFiles, _current_task
from wandrun.runtime.context.memory import MemoryStore
from wandrun.runtime.context.memory_runtime import WORK_MEMORY_PATH
from wandrun.runtime.communication.workers import WorkerManager

from test_capabilities import tool_call
from test_runtime import answer
from compaction_fixtures import SUMMARY_TEXT


class MiddlewareGuidanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.backend = ManagedShellBackend(root_dir=self.root, virtual_mode=False)
        self.addCleanup(self.backend.close)
        self.store = MemoryStore(self.root / "memory")
        self.saver = InMemorySaver()
        self.definition = AgentDefinition("Root", "Keep the user instruction.", "offline", code_mode=False)
        self.shown = []

        async def run(prompts, task_id):
            token = _current_task.set(task_id)
            try:
                return await run_conversation(self.graph, prompts, task_id, "main")
            finally:
                _current_task.reset(token)

        self.manager = WorkerManager(
            run, agent_workers={"main": ()}, default_agent="main",
            on_human=lambda _, text, *_rest: self.shown.append(text), notify_human_of_roots=False,
        )
        self.addAsyncCleanup(self.manager.close)
        self.files = TaskFiles(
            self.root, self.manager, {"main": ("local", str(self.root))}, conversation_workdirs=True,
        )

    def build(self, **overrides):
        arguments = dict(
            definitions={"main": self.definition}, models={"main": CodexSubscriptionModel(model_name="offline")},
            tools={"main": []}, environments={"main": Environment(
                "local", self.backend, str(self.root / "skills"), str(self.root / "artifacts"),
            )}, checkpointer=self.saver, memory=self.store, files=self.files,
        )
        arguments.update(overrides)
        self.graph = build_agents(self.manager, **arguments)["main"].graph

    async def finish(self, task_id):
        result = await asyncio.wait_for(self.manager.wait(task_id), 10)
        self.assertEqual(result["status"], "completed", result)
        return (await self.graph.aget_state(conversation_config(task_id))).values

    async def test_official_glob_cancellation_waits_for_pending_directory_preparation(self):
        entered, release = asyncio.Event(), asyncio.Event()
        cleanup_started, cleanup_release, cleanup_finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
        backend = self.backend

        class RemotePreparation:
            async def aexecute(self, command):
                entered.set()
                try:
                    await release.wait()
                    return await backend.aexecute(command)
                finally:
                    cleanup_started.set()
                    await cleanup_release.wait()
                    cleanup_finished.set()

        self.files.remote_backends["main"] = RemotePreparation()
        self.build()

        async def respond(model, body):
            yield tool_call("glob", {"pattern": "**/*.txt"}, "glob")

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            self.manager.start("find files", "glob-chat")
            await asyncio.wait_for(entered.wait(), 2)
            stop = asyncio.create_task(self.manager.cancel("glob-chat"))
            try:
                await asyncio.wait_for(cleanup_started.wait(), 2)
                self.assertFalse(stop.done())
            finally:
                cleanup_release.set()
            result = await asyncio.wait_for(stop, 2)
            self.assertEqual(result["status"], "cancelled")
            self.assertTrue(cleanup_finished.is_set())
            release.set()
            await asyncio.sleep(0)
            self.assertFalse((self.root / "conversations/glob-chat").exists())

    async def test_official_glob_timeout_waits_for_cleanup_already_started_in_callback(self):
        entered, release = asyncio.Event(), asyncio.Event()
        cleanup_started, cleanup_release, cleanup_finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
        callback_finished = asyncio.Event()
        backend = self.backend

        class RemotePreparation:
            async def aexecute(self, command):
                entered.set()
                try:
                    await release.wait()
                    return await backend.aexecute(command)
                finally:
                    cleanup_started.set()
                    await cleanup_release.wait()
                    cleanup_finished.set()

        class YieldAfterGlob(AsyncCallbackHandler):
            async def on_tool_end(self, output, **kwargs):
                if isinstance(output, ToolMessage) and output.name == "glob":
                    await cleanup_started.wait()
                    callback_finished.set()

        self.files.remote_backends["main"] = RemotePreparation()
        self.build()
        self.graph = self.graph.with_config({"callbacks": [YieldAfterGlob()]})
        calls = [tool_call("glob", {"pattern": "**/*.txt"}, "glob"), answer("done")]

        async def respond(model, body):
            yield calls.pop(0)

        with (
            patch.object(CodexSubscriptionModel, "_arequest", respond),
            patch("deepagents.middleware.filesystem.GLOB_TIMEOUT", 0.01),
        ):
            self.manager.start("find files", "glob-timeout")
            waiter = asyncio.create_task(self.manager.wait("glob-timeout"))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                await asyncio.wait_for(callback_finished.wait(), 2)
                done, _ = await asyncio.wait({waiter}, timeout=0.05)
                self.assertFalse(done, "tool must wait for the timeout's pending cleanup")
                self.assertFalse(cleanup_finished.is_set())
            finally:
                cleanup_release.set()
            result = await asyncio.wait_for(waiter, 2)
            self.assertEqual(result["status"], "completed", result)
            self.assertTrue(cleanup_finished.is_set())
            release.set()
            await asyncio.sleep(0)
            self.assertFalse((self.root / "conversations/glob-timeout").exists())

    async def test_official_glob_late_backend_task_cannot_prepare_after_tool_stops(self):
        entered, release, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
        original = TaskBackend.aglob

        async def delayed(backend, pattern, path=None):
            entered.set()
            await release.wait()
            try:
                return await original(backend, pattern, path)
            finally:
                finished.set()

        self.build()

        async def respond(model, body):
            yield tool_call("glob", {"pattern": "**/*.txt"}, "glob")

        with patch.object(CodexSubscriptionModel, "_arequest", respond), patch.object(TaskBackend, "aglob", delayed):
            self.manager.start("find files", "late-glob")
            await asyncio.wait_for(entered.wait(), 2)
            try:
                result = await asyncio.wait_for(self.manager.cancel("late-glob"), 2)
                self.assertEqual(result["status"], "cancelled")
            finally:
                release.set()
            await asyncio.wait_for(finished.wait(), 2)
            self.assertFalse((self.root / "conversations/late-glob").exists())

    async def test_official_first_listing_accepts_double_leading_separator(self):
        directory = self.root / "conversations/double-slash"
        spelling = "/" + str(directory)
        calls = [tool_call("ls", {"path": spelling}, "list"), answer("done")]

        async def respond(model, body):
            yield calls.pop(0)

        self.build()
        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            self.manager.start("list the empty cwd", "double-slash")
            state = await self.finish("double-slash")
        results = [message for message in state["messages"] if isinstance(message, ToolMessage)]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].status, "success", results[0].content)
        self.assertTrue(directory.is_dir())

    async def test_guidance_stays_request_local_across_turns_and_summary(self):
        skill = self.root / "skills" / "research"
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            "---\nname: research\ndescription: Find reliable evidence.\n---\nRead sources.\n", encoding="utf-8",
        )
        self.definition = replace(
            self.definition, skills=("research",), context_window=40000, compaction_keep_tokens=100,
        )
        guidance = model_instructions()
        capability = EntryCapabilityDefinition(
            "ui", "UI", lambda *_: ("enabled", "Test entry"),
            lambda *_: lambda: HumanMessageGuidanceMiddleware(guidance),
        )
        self.build(
            entry_capabilities=(capability,),
            entry_middleware_factories={"local": {
                "ui": capability.prepare_middleware(self.manager, self.files, "local"),
            }},
        )
        bodies = []

        async def respond(model, body):
            bodies.append(body)
            response = answer(SUMMARY_TEXT if body["input"][-1].get("content") == SUMMARY_INSTRUCTION else "done")
            if len(bodies) == 2:
                response["response"]["usage"] = {
                    "input_tokens": 35000, "output_tokens": 10, "total_tokens": 35010,
                }
            yield response

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            for prompt in ("old diagnostic\n" + "trace row\n" * 3000, "next", "finish"):
                self.manager.start(prompt, "stable")
                state = await self.finish("stable")
        self.assertEqual(len(state["compaction_events"]), 1)
        self.assertEqual(self.shown, ["done"] * 3)  # The summary is never delivered.
        summaries = [b for b in bodies if b["input"][-1].get("content") == SUMMARY_INSTRUCTION]
        self.assertEqual(len(summaries), 1)
        for body in bodies:
            instructions = body["instructions"]
            self.assertEqual(instructions, bodies[0]["instructions"])
            self.assertEqual(
                {key: value for key, value in body.items() if key != "input"},
                {key: value for key, value in bodies[0].items() if key != "input"},
            )
            self.assertNotIn(guidance, json.dumps(body["input"], ensure_ascii=False))
        async for snapshot in self.graph.aget_state_history(conversation_config("stable")):
            for message in snapshot.values.get("messages", []):
                self.assertNotIsInstance(message, SystemMessage)
                self.assertNotIn(guidance, str(message.content))
        message_groups(state["messages"])

    async def test_without_store_memory_path_is_an_ordinary_file_for_both_consumers(self):
        backend = LocalShellBackend(root_dir=self.root, virtual_mode=True)
        self.definition = replace(self.definition, code_mode=True)
        calls = [
            tool_call("write_file", {"file_path": WORK_MEMORY_PATH, "content": "ordinary"}, "write"),
            tool_call("run_code", {"code": f"print(await edit({WORK_MEMORY_PATH!r}, 'ordinary', 'ordinary edited'))"}, "edit"),
            answer("done"),
        ]

        async def respond(model, body):
            yield calls.pop(0)

        async with pm.AsyncMonty() as pool:
            self.build(memory=None, files=None, code_pool=pool, environments={"main": Environment(
                "local", backend, "/skills", "/artifacts",
            )})
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                self.manager.start("write", "ordinary")
                state = await self.finish("ordinary")
        self.assertEqual((self.root / ".wandrun" / "memory" / "work.md").read_text(), "ordinary edited")
        self.assertEqual(self.store.read("main").content, "")
        self.assertNotIn("memory_versions", state)
        self.assertFalse(any("memory_snapshot_scope" in m.additional_kwargs for m in state["messages"]))

    async def test_concurrent_code_tasks_keep_paths_and_observed_versions_isolated(self):
        entered = {name: asyncio.Event() for name in ("old", "new")}
        release = {name: asyncio.Event() for name in entered}

        @tool
        async def pause(label: str) -> str:
            """Hold the host call until its task is released."""
            entered[label].set()
            await release[label].wait()
            return label

        original = self.store.save("main", "initial", self.store.read("main").version)
        self.definition = replace(self.definition, code_mode=True)
        requests = {}

        async def respond(model, body):
            task = body["prompt_cache_key"]
            requests.setdefault(task, []).append(body)
            if len(requests[task]) == 1:
                old = "initial" if task == "old" else "external"
                code = (
                    f"await write('before.txt', {task!r})\n"
                    f"await tools.pause(label={task!r})\n"
                    f"await write('after.txt', {task!r})\n"
                    f"print(await edit({WORK_MEMORY_PATH!r}, {old!r}, {task!r}))"
                )
                yield tool_call("run_code", {"code": code}, task)
            else:
                yield answer("done " + task)

        async with pm.AsyncMonty() as pool:
            self.build(code_pool=pool, tools={"main": [pause]})
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                try:
                    self.manager.start("write", "old")
                    await asyncio.wait_for(entered["old"].wait(), 10)
                    self.store.save("main", "external", original.version)
                    self.manager.start("write", "new")
                    await asyncio.wait_for(entered["new"].wait(), 10)
                    release["new"].set()
                    new = await self.finish("new")
                    release["old"].set()
                    old = await self.finish("old")
                finally:
                    for event in release.values():
                        event.set()
                    await self.manager.close()
        self.assertEqual(self.store.read("main").content, "new")
        new_result = next(m for m in new["messages"] if isinstance(m, ToolMessage))
        old_result = next(m for m in old["messages"] if isinstance(m, ToolMessage))
        self.assertNotIn("已更新", new_result.content)
        self.assertIn("已更新", old_result.content)
        for task in entered:
            for filename in ("before.txt", "after.txt"):
                self.assertEqual((self.root / "conversations" / task / filename).read_text(), task)
                self.assertFalse((self.root / filename).exists())
