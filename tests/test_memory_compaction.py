"""Memory filtering must remain replayable and must not erase task execution state."""

import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import pydantic_monty as pm
from deepagents.backends import LocalShellBackend
from langchain.agents import create_agent
from langchain.agents.middleware.types import ModelRequest
from langchain.tools import tool
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.runtime.agents import ConversationState
from wandrun.runtime.code_mode import CodeModeCatalog, code_mode_tool
from wandrun.runtime.compaction import (
    CompactionMiddleware, ContextBudgetExhausted, context_messages, message_groups,
)
from wandrun.runtime.compaction_archive import CompactionArchive
from wandrun.runtime.compaction_summary import _summary_history, SUMMARY_INSTRUCTION
from wandrun.runtime.memory import MemoryStore
from wandrun.runtime.memory_runtime import MemoryMiddleware, PROFILE_MEMORY_PATH

from compaction_fixtures import SUMMARY_TEXT


def completed(text, *, output_tokens=10):
    return {"type": "response.completed", "response": {
        "status": "completed", "output": [{
            "type": "message", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "output_text", "text": text}],
        }], "usage": {"input_tokens": 100, "output_tokens": output_tokens,
                      "total_tokens": 100 + output_tokens},
    }}


def native_call(name, arguments, call_id):
    return {"type": "function_call", "name": name, "call_id": call_id,
            "arguments": json.dumps(arguments)}


class MemoryReplayTests(unittest.TestCase):
    def test_native_projection_redacts_memory_and_preserves_batch_sibling(self):
        for name, arguments in (
            ("read_file", {"file_path": "/.wandrun/memory/work.md"}),
            ("write_file", {"file_path": "//.wandrun/./memory/profile.md", "content": "RETIRED_PROFILE"}),
            ("run_code", {"code": "print('RETIRED_PROFILE'); print('job-67')"}),
        ):
            with self.subTest(name=name):
                replay = [native_call(name, arguments, "memory"),
                          native_call("lookup", {"query": "current task"}, "ordinary")]
                call = AIMessage(content="", tool_calls=[
                    {"name": name, "id": "memory", "args": arguments},
                    {"name": "lookup", "id": "ordinary", "args": {"query": "current task"}},
                ], additional_kwargs={"codex_output_items": replay})
                before = call.model_dump()
                messages = list(_summary_history([
                    HumanMessage(content="task"), call,
                    ToolMessage(content="RETIRED_PROFILE and mixed job-67", name=name,
                                tool_call_id="memory", artifact={"private": "RETIRED_PROFILE"},
                                additional_kwargs={"managed_memory_access": True}),
                    ToolMessage(content="ordinary operation-68 succeeded /artifact.txt", tool_call_id="ordinary"),
                ]))
                body = CodexSubscriptionModel()._build_request(messages)
                calls = {item["call_id"]: item for item in body["input"] if item.get("type") == "function_call"}
                outputs = {item["call_id"]: item for item in body["input"] if item.get("type") == "function_call_output"}
                self.assertEqual(set(calls), set(outputs))
                self.assertEqual(json.loads(calls["memory"]["arguments"]), {})
                self.assertEqual(messages[1].tool_calls[0]["args"], {})
                self.assertEqual(json.loads(calls["ordinary"]["arguments"]), {"query": "current task"})
                self.assertIn("operation-68 succeeded /artifact.txt", outputs["ordinary"]["output"])
                self.assertNotIn("RETIRED_PROFILE", json.dumps(body))
                self.assertEqual(call.model_dump(), before)


class MixedExecutionCompactionTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_monty_mixed_group_before_cut_keeps_receipts_on_continuation(self):
        with tempfile.TemporaryDirectory(prefix="memory-fix-mixed-") as directory:
            root = Path(directory)
            memory = MemoryStore(root / "memory")
            original = memory.save(None, "RETIRED_PROFILE", memory.read(None).version)
            artifacts = {state: root / f"{state}.json" for state in ("succeeded", "failed", "unknown")}
            operations = []
            started, cancelled = asyncio.Event(), asyncio.Event()

            @tool
            async def successful_operation() -> dict:
                """Publish a completed task artifact and its execution receipt."""
                operations.append("succeeded")
                receipt = {"operation_id": "job-succeeded", "artifact_path": str(artifacts["succeeded"]),
                           "operation_state": "succeeded"}
                artifacts["succeeded"].write_text(json.dumps(receipt))
                return receipt

            @tool
            async def failing_operation() -> str:
                """Fail after producing a partial artifact, with a recoverable receipt."""
                operations.append("failed")
                receipt = {"operation_id": "job-failed", "artifact_path": str(artifacts["failed"]),
                           "operation_state": "failed"}
                artifacts["failed"].write_text(json.dumps(receipt))
                raise RuntimeError(json.dumps(receipt))

            @tool
            async def unknown_operation() -> None:
                """Start a side effect without confirming its external completion."""
                operations.append("unknown")
                artifacts["unknown"].write_text(json.dumps({
                    "operation_id": "job-unknown", "operation_state": "unknown",
                }))
                started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise

            @tool
            async def abort_after_start() -> None:
                """Fail only after the concurrent operation has started."""
                await started.wait()
                raise RuntimeError("independent script failure after operation start")

            unknown_receipt = {
                "operation_id": "job-unknown", "artifact_path": str(artifacts["unknown"]),
                "operation_state": "unknown",
            }
            code = (
                f"memory = await read({PROFILE_MEMORY_PATH!r})\n"
                "print(memory['file_data']['content'])\n"
                "print(await tools.successful_operation())\n"
                "try:\n    await tools.failing_operation()\n"
                "except RuntimeError as error:\n    print(str(error))\n"
                f"print({unknown_receipt!r})\n"
                "import asyncio\n"
                "await asyncio.gather(tools.unknown_operation(), tools.abort_after_start())\n"
            )
            normal_calls, summaries, source_outputs = [], [], []
            model = CodexSubscriptionModel(model_name="offline")

            async def provider(_model, body):
                # The real adapter builds both summary and main requests; only the
                # HTTP boundary is replaced. No stale memory may reach the summary.
                if body["input"][-1].get("content", "").startswith(SUMMARY_INSTRUCTION):
                    summaries.append(body)
                    self.assertNotIn("RETIRED_PROFILE", json.dumps(body))
                    yield completed(SUMMARY_TEXT)
                    return
                normal_calls.append(body)
                if len(normal_calls) == 1:
                    yield {"type": "response.completed", "response": {
                        "status": "completed", "output": [native_call("run_code", {"code": code}, "mixed-call")],
                        "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
                    }}
                    return
                outputs = [item["output"] for item in body["input"]
                           if item.get("type") == "function_call_output" and item["call_id"] == "mixed-call"]
                self.assertEqual(len(outputs), 1)
                if len(normal_calls) == 2:
                    source_outputs.append(outputs[0])
                    yield completed("diagnostic " * 5000, output_tokens=9000)
                else:
                    # A continuation must see the original receipts, not infer task
                    # state from a memory-redaction placeholder or repeat side effects.
                    self.assertEqual(outputs, source_outputs)
                    for state, path in artifacts.items():
                        self.assertIn(f"job-{state}", outputs[0])
                        self.assertIn(str(path), outputs[0])
                    yield completed("DELIVERED existing results; unknown operation must not be repeated")

            async with pm.AsyncMonty() as pool:
                middleware = MemoryMiddleware(memory, "agent")
                backend = middleware.wrap_backend(LocalShellBackend(root_dir=root, virtual_mode=False))
                catalog = CodeModeCatalog([
                    successful_operation, failing_operation, unknown_operation, abort_after_start,
                ], [])
                run_code = code_mode_tool(pool, backend, catalog)
                archive = CompactionArchive(str(root / "archive"), backend)
                graph = create_agent(
                    model, tools=[run_code], middleware=[middleware, CompactionMiddleware(
                        context_window=10000, keep_tokens=1, memory=middleware, archive=archive,
                    )], state_schema=ConversationState, checkpointer=InMemorySaver(),
                )
                config = {"configurable": {"thread_id": "mixed"}}
                context = {"task_id": "mixed", "compaction_attempts": 0, "execution_generation": None}
                with patch.object(CodexSubscriptionModel, "_arequest", provider):
                    first = await graph.ainvoke({"messages": [HumanMessage(content="Perform the operations once", id="goal")]},
                                                config, context=context)
                    mixed_index = next(i for i, message in enumerate(first["messages"])
                                       if isinstance(message, ToolMessage) and message.tool_call_id == "mixed-call")
                    source = first["messages"][mixed_index]
                    self.assertTrue(source.additional_kwargs["managed_memory_access"])
                    self.assertEqual(source.status, "error")
                    statuses = {record["name"]: record["status"] for record in source.artifact["calls"]}
                    self.assertEqual(statuses["successful_operation"], "succeeded")
                    self.assertEqual(statuses["failing_operation"], "failed")
                    self.assertEqual(statuses["unknown_operation"], "cancelled")
                    self.assertTrue(cancelled.is_set())
                    memory.save(None, "", original.version)
                    await graph.ainvoke({"messages": [HumanMessage(content="Continue from the actual operation states", id="continue")]},
                                        config, context={**context, "compaction_attempts": 0})
                    second = (await graph.aget_state(config)).values
                    event = second["compaction_events"][-1]
                    self.assertGreater(event["cutoff_index"], mixed_index)
                    view = context_messages(second)
                    message_groups(view)
                    self.assertEqual(sum(isinstance(m, ToolMessage) and m.tool_call_id == "mixed-call" for m in view), 1)
                    self.assertEqual(memory.read(None).content, "")
                    self.assertNotIn("RETIRED_PROFILE", event["summary_text"])
                    third = await graph.ainvoke({"messages": [HumanMessage(content="Confirm delivery only, no new operations", id="again")]},
                                                config, context={**context, "compaction_attempts": 0})
                self.assertEqual(operations, ["succeeded", "failed", "unknown"])
                for state, path in artifacts.items():
                    self.assertEqual(json.loads(path.read_text())["operation_state"], state)
                self.assertIn("DELIVERED existing results", third["messages"][-1].text)
                self.assertEqual(len(summaries), 1)
                # Lossy/reordered filesystem copies must not replace execution
                # authority or introduce duplicate/unpaired tool results.
                projected = [m.model_copy(update={"content": "projected copy"}) if isinstance(m, ToolMessage)
                             else m.model_copy() for m in reversed(second["messages"])]
                recovered = context_messages(second, projected=projected)
                receipt = next(m for m in recovered if isinstance(m, ToolMessage) and m.tool_call_id == "mixed-call")
                self.assertEqual(receipt.content, source.content)
                self.assertEqual(receipt.artifact, source.artifact)
                message_groups(recovered)

    async def test_oversized_execution_barrier_fails_closed_with_recovery_archive(self):
        with tempfile.TemporaryDirectory(prefix="memory-fix-barrier-") as directory:
            root = Path(directory)
            backend = LocalShellBackend(root_dir=root, virtual_mode=False)
            archive = CompactionArchive(str(root / "archive"), backend)
            call = AIMessage(content="", id="call", tool_calls=[{"name": "run_code", "id": "mixed", "args": {"code": "print('large')"}}],
                             additional_kwargs={"codex_output_items": [native_call("run_code", {"code": "print('large')"}, "mixed")]})
            raw = [HumanMessage(content="task", id="task"), call,
                   ToolMessage(content="job-67 unknown " + "large task output " * 10000, id="result", name="run_code",
                               tool_call_id="mixed", additional_kwargs={"managed_memory_access": True}),
                   HumanMessage(content="continue", id="latest")]
            request = ModelRequest(model=CodexSubscriptionModel(), messages=raw, state={"messages": raw},
                                   runtime=SimpleNamespace(context={"task_id": "bounded", "compaction_attempts": 0}))
            async def summary(_request, **_kwargs):
                return AIMessage(content=SUMMARY_TEXT)
            before = [m.model_dump() for m in raw]
            with patch("wandrun.runtime.compaction.summarize_request", summary):
                with self.assertRaises(ContextBudgetExhausted) as failure:
                    await CompactionMiddleware(context_window=10000, keep_tokens=1, archive=archive)._compact(
                        request, request, None, "threshold",
                    )
            recovery = next(path for path in (root / "archive").rglob("index-*.md")
                            if str(path) in str(failure.exception))
            segment = recovery.read_text().splitlines()[-1].split(". ", 1)[1]
            rows = [json.loads(line) for line in Path(segment).read_text().splitlines()]
            parts = {}
            for row in rows[1:]:
                parts.setdefault(row["message_index"], []).append(row["json"])
            restored = [json.loads("".join(chunks)) for chunks in parts.values()]
            self.assertEqual(next(row["content"] for row in restored if row["id"] == "result"), raw[2].content)
            self.assertEqual(next(row["tool_calls"] for row in restored if row["id"] == "call"), call.model_dump()["tool_calls"])
            self.assertEqual([m.model_dump() for m in raw], before)
            self.assertNotIn("compaction_events", request.state)


if __name__ == "__main__":
    unittest.main()
