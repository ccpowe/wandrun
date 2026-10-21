"""两种角色的调度和真实图装配；不访问 MCP 或远端模型。"""

from collections import defaultdict
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from deepagents.backends import LocalShellBackend
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.runtime.agents import COMMUNICATION, _system_prompt, build_agents, run_conversation
from wandrun.runtime.files import TaskFiles, _current_task
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.config import AgentDefinition
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.workers import CommunicationMiddleware, WorkerManager
from wandrun.runtime.environments import Environment


DEFINITIONS = {
    "planner": AgentDefinition(
        description="planner",
        system_prompt="你是 planner",
        model="test",
        workers=("executor",), code_mode=False,
    ),
    "executor": AgentDefinition(
        description="executor", system_prompt="你是 executor", model="test", code_mode=False,
    ),
}


def output(to=None, task_id=None, text="work", next="wait"):
    return AgentOutput(
        messages=[]
        if to is None
        else [SendMessage(to=to, task_id=task_id, message=text)],
        next=next,
    )



class CommunicationPromptTests(unittest.TestCase):
    def test_shared_protocol_does_not_prescribe_agent_roles(self):
        for text in (COMMUNICATION, str(AgentOutput.model_json_schema())):
            with self.subTest(text=text):
                self.assertNotRegex(text, r"planner|executor|search_agent")


class DisplayIdentityTests(unittest.TestCase):
    def test_display_identity_preserves_worker_ids_and_avoids_duplicate_name(self):
        definitions = {
            "lead": AgentDefinition("lead", "prompt", "m", workers=("writer",), name="协调者"),
            "writer": AgentDefinition("writes", "prompt", "m", name="写手"),
        }
        prompt = _system_prompt("lead", definitions)
        self.assertIn("当前 Agent 身份：lead（协调者）", prompt)
        self.assertIn("- writer（写手）：writes", prompt)
        self.assertNotIn("to：writer（写手）", prompt)
        definitions["writer"] = AgentDefinition("writes", "prompt", "m", name="writer")
        self.assertIn("- writer：writes", _system_prompt("lead", definitions))

class AgentTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, run, **kwargs):
        manager = WorkerManager(
            run,
            agent_workers={name: spec.workers for name, spec in DEFINITIONS.items()},
            default_agent="planner",
            **kwargs,
        )
        self.addAsyncCleanup(manager.close)
        return manager

    async def test_identity_admission_replies_and_cancellation(self):
        received = {}

        async def run(prompts, task_id):
            received.setdefault(task_id, []).extend(prompts)
            return output()

        manager = self.manager(run)
        for parent in ("p", "other"):
            manager.start("initial", parent)
            await manager.wait(parent)
        receipt = manager.dispatch(output("executor"), "p")[0]
        child = receipt["task_id"]
        await manager.wait(child)
        self.assertTrue(receipt["accepted"])
        self.assertEqual(manager.agent_name(child), "executor")
        self.assertEqual(
            received[child][0].additional_kwargs["sender_agent"], "planner"
        )

        reply = manager.dispatch(output("planner", "p", "answer"), child)[0]
        self.assertTrue(reply["accepted"])
        await manager.wait("p")
        self.assertEqual(
            received["p"][-1].additional_kwargs["sender_agent"], "executor"
        )
        self.assertEqual(manager._callers["p"], None)
        self.assertEqual(manager._callers[child], "p")

        for sender, to, target in (
            (child, "executor", None),
            (child, "planner", None),
            ("p", "missing", None),
            ("p", "planner", child),
            ("p", "executor", "unknown"),
        ):
            with self.subTest(sender=sender, to=to, target=target):
                self.assertFalse(
                    manager.dispatch(output(to, target), sender)[0]["accepted"]
                )
        self.assertEqual(set(manager._tasks), {"p", "other", child})

        (cancel,) = CommunicationMiddleware(manager).tools
        for caller, target in (("other", child), (child, "p"), ("p", "p")):
            result = await cancel.ainvoke(
                {"task_id": target}, config=conversation_config(caller)
            )
            self.assertFalse(result["accepted"])
        self.assertEqual(manager.get(child)["status"], "waiting")
        result = await cancel.ainvoke(
            {"task_id": child}, config=conversation_config("p")
        )
        self.assertEqual(result["status"], "cancelled")
        # 已停止的任务只能由创建者恢复；用户和其他任务都不能恢复。
        with self.assertRaises(ValueError):
            manager.start("resume", child)
        self.assertFalse(
            manager.dispatch(output("executor", child, "resume"), "other")[0]["accepted"]
        )
        # 创建者恢复时继续原角色，不把 executor 换成默认 planner。
        self.assertTrue(
            manager.dispatch(output("executor", child, "resume"), "p")[0]["accepted"]
        )
        await manager.wait(child)
        self.assertEqual(manager.agent_name(child), "executor")
        self.assertEqual(manager._callers[child], "p")

    async def test_failure_wakes_planner_with_original_identity(self):
        noticed = asyncio.Event()

        async def run(prompts, task_id):
            if manager.agent_name(task_id) == "executor":
                raise ValueError("controlled failure")
            if any("controlled failure" in m.content for m in prompts):
                noticed.set()
            return output()

        manager = self.manager(run)
        manager.start("initial", "p")
        await manager.wait("p")
        child = manager.dispatch(output("executor"), "p")[0]["task_id"]
        await asyncio.wait_for(noticed.wait(), 2)
        await manager.wait("p")
        self.assertEqual(manager.agent_name("p"), "planner")
        self.assertEqual(manager.get(child)["status"], "failed")

    async def test_code_mode_without_monty_pool_preserves_error(self):
        async def unused_run(prompts, task_id):
            raise AssertionError("Graph construction must not execute a task")

        manager = self.manager(unused_run)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(
                ValueError, r"^Agent coder 启用了 code_mode，但没有提供 Monty 池$"
            ):
                build_agents(
                    manager,
                    definitions={"coder": AgentDefinition(
                        "coder", "write code", "test", code_mode=True,
                    )},
                    models={"coder": FakeMessagesListChatModel(responses=[])},
                    tools={"coder": []},
                    environments={"coder": Environment(
                        "local", LocalShellBackend(root_dir=directory, virtual_mode=True),
                        "/skills", "/",
                    )},
                    checkpointer=InMemorySaver(),
                )

    async def test_model_retry_retries_transport_error_only_at_model_boundary(self):
        calls = 0

        class Model(FakeMessagesListChatModel):
            def bind_tools(self, tools, **kwargs):
                return self.bind(**kwargs)

            async def _agenerate(self, messages, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise httpx.ConnectTimeout("controlled timeout")
                result = output("human", text="recovered", next="done")
                return ChatResult(
                    generations=[
                        ChatGeneration(
                            message=AIMessage(
                                content=result.model_dump_json(),
                                additional_kwargs={
                                    "wandrun_agent_output": result.model_dump()
                                },
                            )
                        )
                    ]
                )

        async def run(prompts, task_id):
            return await run_conversation(
                agents["planner"].graph, prompts, task_id, "planner"
            )

        shown = []
        manager = self.manager(run, on_human=lambda sender, text, attachments, draft_id: shown.append(text))
        with tempfile.TemporaryDirectory() as directory:
            agents = build_agents(
                manager,
                definitions=DEFINITIONS,
                models={name: Model(responses=[]) for name in DEFINITIONS},
                tools={name: [] for name in DEFINITIONS},
                environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                checkpointer=InMemorySaver(),
                model_max_retries=1,
            )
            with patch(
                "langchain.agents.middleware.model_retry.asyncio.sleep",
                new=AsyncMock(),
            ):
                manager.start("start", "root", agent_name="planner")
                await manager.wait("root")
        self.assertEqual(calls, 2)
        self.assertEqual(shown, ["recovered"])

    async def test_real_graph_easy_and_two_executor_paths(self):
        for difficulty in ("easy", "hard"):
            with (
                self.subTest(difficulty=difficulty),
                tempfile.TemporaryDirectory() as directory,
            ):
                root = Path(directory)
                (root / "input.txt").write_text("shared workspace evidence")
                shown, observed = [], []
                delivered = asyncio.Event()
                test = self

                class Model(FakeMessagesListChatModel):
                    def bind_tools(self, tools, **kwargs):
                        names = [
                            t.name if hasattr(t, "name") else t["name"] for t in tools
                        ]
                        return self.bind(bound_names=names)

                    async def _agenerate(self, messages, **kwargs):
                        system = str(messages[0].content)
                        role = "executor" if "你是 executor" in system else "planner"
                        humans = [m for m in messages if isinstance(m, HumanMessage)]
                        results = [m for m in messages if isinstance(m, ToolMessage)]
                        peers = [
                            m
                            for m in humans
                            if m.additional_kwargs.get("source") == "worker"
                        ]
                        names = kwargs["bound_names"]
                        test.assertIn("execute", names)
                        test.assertIn("write_file", names)
                        test.assertIn("cancel_worker", names)
                        test.assertNotIn("get_worker", names)
                        observed.append((role, humans[0].content))
                        if not results:
                            response = AIMessage(
                                content="",
                                tool_calls=[
                                    {
                                        "name": "read_file",
                                        "args": {"file_path": "/input.txt"},
                                        "id": "read-1",
                                        "type": "tool_call",
                                    }
                                ],
                            )
                        elif not any(m.name == "write_file" for m in results) and (
                            role == "executor" or difficulty == "easy"
                        ):
                            test.assertIn(
                                "shared workspace evidence", str(results[0].content)
                            )
                            filename = (
                                "easy"
                                if role == "planner"
                                else (
                                    "piece-a"
                                    if "piece-a" in humans[0].content
                                    else "piece-b"
                                )
                            )
                            response = AIMessage(
                                content="",
                                tool_calls=[
                                    {
                                        "name": "write_file",
                                        "args": {
                                            "file_path": f"/{filename}.txt",
                                            "content": "fixed",
                                        },
                                        "id": "write-1",
                                        "type": "tool_call",
                                    }
                                ],
                            )
                        else:
                            if role == "executor":
                                test.assertEqual(len(peers), 1)
                                result = output(
                                    peers[0].additional_kwargs["sender_agent"],
                                    peers[0].additional_kwargs["sender_id"],
                                    "verified child result",
                                    next="done",
                                )
                            elif difficulty == "easy" or len(peers) == 2:
                                result = output(
                                    "human", text="verified final", next="done"
                                )
                            elif peers:
                                result = output()
                            else:
                                result = AgentOutput(
                                    messages=[
                                        SendMessage(
                                            to="executor", task_id=None, message=piece
                                        )
                                        for piece in ("piece-a", "piece-b")
                                    ],
                                    next="wait",
                                )
                            response = AIMessage(
                                content=result.model_dump_json(),
                                additional_kwargs={
                                    "wandrun_agent_output": result.model_dump()
                                },
                            )
                        return ChatResult(
                            generations=[ChatGeneration(message=response)]
                        )

                async def run(prompts, task_id):
                    name = manager.agent_name(task_id)
                    return await run_conversation(agents[name].graph, prompts, task_id, name)

                def show(sender, text, attachments, draft_id):
                    shown.append(text)
                    delivered.set()

                manager = self.manager(run, on_human=show)
                saver = InMemorySaver()
                agents = build_agents(
                    manager,
                    definitions=DEFINITIONS,
                    models={name: Model(responses=[]) for name in DEFINITIONS},
                    tools={name: [] for name in DEFINITIONS},
                    environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=root, virtual_mode=True), "/skills", "/")),
                    checkpointer=saver,
                )
                manager.start(difficulty, "root")
                await asyncio.wait_for(delivered.wait(), 5)
                await manager.wait("root")
                self.assertEqual(shown, ["verified final"])
                self.assertEqual(len(manager._tasks), 1 if difficulty == "easy" else 3)
                expected_files = (
                    ("easy",) if difficulty == "easy" else ("piece-a", "piece-b")
                )
                for name in expected_files:
                    self.assertEqual((root / f"{name}.txt").read_text(), "fixed")
                for task_id in manager._tasks:
                    name = manager.agent_name(task_id)
                    snapshot = await agents[name].graph.aget_state(
                        conversation_config(task_id)
                    )
                    self.assertEqual(snapshot.values["agent_name"], name)
                # 持久历史可恢复，但不能把已有角色换成另一张图。
                with self.assertRaises(ValueError):
                    await run_conversation(
                        agents["executor"].graph,
                        [HumanMessage(content="resume")],
                        "root",
                        "executor",
                    )
                await manager.close()

    async def test_real_filesystem_tools_resolve_relative_paths_in_conversation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input.txt").write_text("wrong workspace file")
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)
            observed = []

            class Model(FakeMessagesListChatModel):
                def bind_tools(self, tools, **kwargs):
                    return self.bind()

                async def _agenerate(self, messages, **kwargs):
                    results = [message for message in messages if isinstance(message, ToolMessage)]
                    if not results:
                        response = AIMessage(content="", tool_calls=[{
                            "name": "read_file", "args": {"file_path": "input.txt"},
                            "id": "relative-read", "type": "tool_call",
                        }])
                    elif len(results) == 1:
                        observed.append(str(results[0].content))
                        response = AIMessage(content="", tool_calls=[{
                            "name": "write_file",
                            "args": {"file_path": "output.txt", "content": "from conversation"},
                            "id": "relative-write", "type": "tool_call",
                        }])
                    else:
                        response_output = output(next="done")
                        response = AIMessage(
                            content=response_output.model_dump_json(),
                            additional_kwargs={"wandrun_agent_output": response_output.model_dump()},
                        )
                    return ChatResult(generations=[ChatGeneration(message=response)])

            async def run(prompts, task_id):
                await files.prepare(task_id)
                token = _current_task.set(task_id)
                try:
                    return await run_conversation(agents["worker"].graph, prompts, task_id, "worker")
                finally:
                    _current_task.reset(token)

            manager = WorkerManager(
                run, agent_workers={"worker": ()}, default_agent="worker",
            )
            files = TaskFiles(
                root, manager, {"worker": ("local", str(root))},
                conversation_workdirs=True,
            )
            agents = build_agents(
                manager,
                definitions={"worker": AgentDefinition("worker", "worker prompt", "test", code_mode=False)},
                models={"worker": Model(responses=[])},
                tools={"worker": []},
                environments={"worker": Environment(
                    "local", backend, str(root / ".wandrun/skills"),
                    str(root / ".wandrun/artifacts"),
                )},
                checkpointer=InMemorySaver(),
                files=files,
            )
            task_directory = root / "conversations/chat"
            task_directory.mkdir(parents=True)
            (task_directory / "input.txt").write_text("conversation input")
            try:
                manager.start("read and write", "chat")
                self.assertEqual((await manager.wait("chat"))["status"], "completed")
                self.assertEqual(len(observed), 1)
                self.assertIn("conversation input", observed[0])
                self.assertNotIn("wrong workspace file", observed[0])
                self.assertEqual(
                    (Path(files.directory("chat")) / "output.txt").read_text(),
                    "from conversation",
                )
                self.assertFalse((root / "output.txt").exists())
                self.assertTrue(agents["worker"].capabilities.enabled("files"))
                self.assertTrue(agents["worker"].capabilities.enabled("task_path"))
            finally:
                await manager.close()
                backend.close()
