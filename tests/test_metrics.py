"""真实适配器/Agent 图，替换服务端事件验证计数与取消边界。"""

from collections import defaultdict
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deepagents.backends import LocalShellBackend
from langchain.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.runtime.agents import build_agents, run_conversation
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.config import AgentDefinition
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.metrics import RunMetrics, summarize_log
from wandrun.runtime.workers import WorkerManager
from wandrun.terminal.chat import TerminalOutput, chat
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


def event(text="OK", *, status="completed", usage=True):
    response = {
        "id": "response-test",
        "status": status,
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
    }
    if usage:
        response["usage"] = {
            "input_tokens": 100,
            "output_tokens": 20,
            "total_tokens": 120,
            "input_tokens_details": {"cached_tokens": 80},
            "output_tokens_details": {"reasoning_tokens": 10},
        }
    return {"type": f"response.{status}", "response": response}


class MetricsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.metrics = RunMetrics(Path(self.directory.name))
        self.model = CodexSubscriptionModel()

    def records(self):
        records = {}
        for line in self.metrics.log_path.read_text().splitlines():
            record = json.loads(line)
            records[record["request_id"]] = record
        return list(records.values())

    def test_sync_requests_history_and_log_replay_count_once(self):
        with patch.object(
            CodexSubscriptionModel,
            "_request",
            side_effect=lambda body: (item for item in [event()]),
        ):
            with self.metrics.agent_scope("p", "planner"):
                first = self.model.invoke("first")
                self.model.invoke(
                    [HumanMessage(content="first"), first, HumanMessage(content="next")]
                )
        totals = self.metrics.summary()
        self.assertEqual(totals["model_request_count"], 2)
        self.assertEqual(totals["input_tokens"], 200)
        self.assertEqual(totals["cached_input_tokens"], 160)
        self.assertEqual(totals["reasoning_tokens"], 20)
        self.assertEqual(totals["total_tokens"], 240)
        self.assertTrue(totals["usage_complete"])
        self.assertEqual(totals["request_statuses"], {"completed": 2})
        self.assertEqual(summarize_log(self.metrics.log_path), totals)
        self.assertEqual(json.loads(self.metrics.write_summary().read_text()), totals)
        # 日志不含消息正文或凭据；同一个服务端 ID 的两次请求仍是两次独立消耗。
        self.assertNotIn('"content"', self.metrics.log_path.read_text())

    async def test_failure_after_usage_and_missing_usage(self):
        for payload in (event(status="incomplete"), event(usage=False)):

            async def respond(model, body):
                yield payload

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                with self.metrics.agent_scope("e", "executor"):
                    if payload["type"] == "response.incomplete":
                        with self.assertRaises(RuntimeError):
                            await self.model.ainvoke("hello")
                    else:
                        await self.model.ainvoke("hello")
        totals = self.metrics.summary()
        self.assertEqual(totals["total_tokens"], 120)
        self.assertEqual(totals["model_request_count"], 2)
        self.assertEqual(totals["usage_missing_requests"], 1)
        self.assertFalse(totals["usage_complete"])
        self.assertEqual(totals["request_statuses"], {"failed": 1, "completed": 1})
        self.assertIsNone(self.records()[1]["input_tokens"])

    async def test_cancel_and_transport_failure_preserve_unknown(self):
        entered = asyncio.Event()

        async def respond(model, body):
            entered.set()
            await asyncio.Event().wait()
            yield event()

        async def call():
            with self.metrics.agent_scope("child", "executor"):
                await self.model.ainvoke("wait")

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            task = asyncio.create_task(call())
            await asyncio.wait_for(entered.wait(), 2)
            # 即使没有最终 summary，开始记录已可从文件恢复。
            recovered = summarize_log(self.metrics.log_path)
            self.assertEqual(recovered["request_statuses"], {"interrupted": 1})
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        async def failed(model, body):
            raise OSError("network failure with private details")
            yield event()

        with patch.object(CodexSubscriptionModel, "_arequest", failed):
            with self.metrics.agent_scope("p", "planner"):
                with self.assertRaises(OSError):
                    await self.model.ainvoke("hello")
        totals = self.metrics.summary()
        self.assertEqual(totals["usage_missing_requests"], 2)
        self.assertEqual(totals["request_statuses"], {"cancelled": 1, "failed": 1})
        self.assertNotIn("private details", self.metrics.log_path.read_text())

    async def test_parser_failure_does_not_lose_service_usage(self):
        broken = event()
        broken["response"]["output"] = [
            {
                "type": "function_call",
                "id": "fc-1",
                "call_id": "call-1",
                "name": "tool",
                "arguments": "invalid json",
            }
        ]

        async def respond(model, body):
            yield broken

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            with self.metrics.agent_scope("p", "planner"):
                with self.assertRaises(ValueError):
                    await self.model.ainvoke("hello")
        self.assertEqual(self.metrics.summary()["total_tokens"], 120)
        self.assertEqual(self.metrics.summary()["request_statuses"], {"failed": 1})

    async def test_worker_graphs_share_run_but_keep_request_attribution(self):
        delivered = asyncio.Event()

        async def respond(model, body):
            await asyncio.sleep(0)  # 让两个 executor 的请求交错。
            executor = "你是 executor" in body["instructions"]
            replies = [
                m
                for m in body["input"]
                if m.get("role") == "user" and "child answer" in str(m)
            ]
            if executor:
                result = AgentOutput(
                    messages=[
                        SendMessage(to="planner", task_id="p", message="child answer")
                    ],
                    next="done",
                )
            elif len(replies) == 2:
                result = AgentOutput(
                    messages=[SendMessage(to="human", task_id=None, message="final")],
                    next="done",
                )
            elif replies:
                result = AgentOutput(messages=[], next="wait")
            else:
                result = AgentOutput(
                    messages=[
                        SendMessage(to="executor", task_id=None, message="work")
                        for _ in range(2)
                    ],
                    next="wait",
                )
            yield event(result.model_dump_json())

        async def run(prompts, task_id):
            role = manager.agent_name(task_id)
            with self.metrics.agent_scope(task_id, role):
                return await run_conversation(agents[role].graph, prompts, task_id, role)

        manager = WorkerManager(
            run,
            on_human=lambda *args: delivered.set(),
            agent_workers={name: spec.workers for name, spec in DEFINITIONS.items()},
            default_agent="planner",
        )
        self.addAsyncCleanup(manager.close)
        agents = build_agents(
            manager,
            definitions=DEFINITIONS,
            models={name: self.model for name in DEFINITIONS},
            tools={name: [] for name in DEFINITIONS},
            environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=self.directory.name), str(Path(self.directory.name) / "skills"), "/")),
            checkpointer=InMemorySaver(),
        )
        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            manager.start("initial", "p")
            await asyncio.wait_for(delivered.wait(), 5)
            await manager.wait("p")
        totals = self.metrics.summary()
        self.assertEqual(totals["by_agent"]["executor"]["model_request_count"], 2)
        self.assertGreaterEqual(totals["by_agent"]["planner"]["model_request_count"], 2)
        self.assertEqual(len(totals["by_task_id"]), 3)
        self.assertEqual(totals["total_tokens"], totals["model_request_count"] * 120)
        self.assertEqual(summarize_log(self.metrics.log_path), totals)

    def test_partial_last_log_line_and_absent_details(self):
        payload = event()
        payload["response"]["usage"] = {
            "input_tokens": 5,
            "output_tokens": 2,
            "total_tokens": 7,
        }
        with patch.object(
            CodexSubscriptionModel,
            "_request",
            side_effect=lambda body: (item for item in [payload]),
        ):
            with self.metrics.agent_scope("p", "planner"):
                self.model.invoke("hello")
        totals = self.metrics.summary()
        self.assertTrue(totals["usage_complete"])
        self.assertEqual(totals["cached_input_tokens_missing_requests"], 1)
        with self.metrics.log_path.open("a") as stream:
            stream.write('{"request_id":')
        self.assertEqual(summarize_log(self.metrics.log_path), totals)

    async def test_terminal_tokens_is_local_and_does_not_invoke_model(self):
        async def run(*args):
            self.fail("/tokens 不应调用模型")

        manager = WorkerManager(run)
        with (
            patch("wandrun.terminal.chat.read_line", side_effect=["/tokens", "/exit"]),
            patch("builtins.print") as printed,
        ):
            await chat(manager, "p", output=TerminalOutput(), metrics=self.metrics)
        summaries = [
            json.loads(call.args[0])
            for call in printed.call_args_list
            if call.args[0].startswith("{")
        ]
        self.assertEqual(summaries, [self.metrics.summary()])
