"""协议回归：真实适配器与 Agent 图，替换网络响应而非解析、投递逻辑。"""

from collections import defaultdict
import asyncio
import copy
import json
import tempfile
import unittest
from unittest.mock import patch

from deepagents.backends import LocalShellBackend
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.runtime.agents import build_agents, run_conversation
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.config import AgentDefinition
from wandrun.runtime.messages import AgentOutput, merge_response_outputs
from wandrun.runtime.workers import WorkerManager
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


FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "AgentOutput",
        "strict": True,
        "schema": AgentOutput.model_json_schema(),
    },
}


def msg(text, to="executor", task_id=None):
    return {"to": to, "task_id": task_id, "message": text, "attachments": []}


def item(messages=(), next="wait", phase="final_answer"):
    return {
        "type": "message",
        "role": "assistant",
        "phase": phase,
        "content": [
            {
                "type": "output_text",
                "text": json.dumps({"messages": list(messages), "next": next}),
            }
        ],
    }


def text_item(text, phase="commentary"):
    return {
        "type": "message",
        "role": "assistant",
        "phase": phase,
        "content": [{"type": "output_text", "text": text}],
    }


def events(items):
    for index, output in enumerate(items):
        if output["type"] == "message":
            yield {
                "type": "response.output_item.added",
                "output_index": index,
                "item": {**output, "content": []},
            }
            yield {
                "type": "response.output_text.delta",
                "output_index": index,
                "content_index": 0,
                "delta": output["content"][0]["text"],
            }
        yield {
            "type": "response.output_item.done",
            "output_index": index,
            "item": output,
        }
    yield {
        "type": "response.completed",
        "response": {"status": "completed", "output": items},
    }


def runtime_feedback(body):
    return [
        json.loads(entry["content"].split("\n", 1)[1])
        for entry in body["input"]
        if entry.get("role") == "user"
        and isinstance(entry.get("content"), str)
        and entry["content"].startswith("[运行时反馈]\n")
    ]


class ResponseMergeTests(unittest.TestCase):
    def test_routing_is_preserved_without_recipient_or_content_deduplication(self):
        messages = [
            msg("new a"),
            msg("new b"),
            msg("new a"),
            msg("first", task_id="a"),
            msg("second", task_id="a"),
            msg("other", task_id="b"),
            msg("wrong role", to="planner", task_id="a"),
            msg("human 1", to="human"),
            msg("human 2", to="human"),
        ]
        items = [
            item(messages[:4], phase="commentary"),
            item(messages[4:], next="done"),
        ]
        original = copy.deepcopy(items)
        merged = merge_response_outputs(items)
        self.assertEqual(merged.model_dump(), {"messages": messages, "next": "done"})
        self.assertEqual(items, original)

    def test_next_uses_final_phase_not_priority_or_last_commentary(self):
        for first in ("continue", "wait", "done"):
            for final in ("continue", "wait", "done"):
                with self.subTest(first=first, final=final):
                    merged = merge_response_outputs(
                        [
                            item([msg("work")], first, "commentary"),
                            item([], final),
                            item([], first, "commentary"),
                        ]
                    )
                    self.assertEqual(merged.next, final)
                    self.assertEqual(len(merged.messages), 1)
        self.assertEqual(
            merge_response_outputs([item(next="continue", phase=None)]).next, "continue"
        )
        self.assertEqual(
            merge_response_outputs(
                [
                    item(next="done", phase="commentary"),
                    item(next="wait", phase="commentary"),
                ]
            ).next,
            "wait",
        )
        self.assertIsNone(
            merge_response_outputs([{"type": "reasoning", "summary": []}])
        )

    def test_plain_commentary_does_not_erase_structured_communication(self):
        items = [
            text_item("我先整理背景，再发送委派。"),
            item([msg("early")], next="continue", phase="commentary"),
            text_item("正在使用工具。"),
            item([msg("final")], next="done"),
            text_item("进度说明", phase="commentary"),
        ]
        original = copy.deepcopy(items)
        self.assertEqual(
            merge_response_outputs(items).model_dump(),
            {"messages": [msg("early"), msg("final")], "next": "done"},
        )
        self.assertEqual(items, original)

    def test_invalid_structured_commentary_is_not_silently_dropped(self):
        invalid = [
            '{"messages":[],"next":"invalid"}',
            "{}",
            '{"messages":',
            '  [ {"messages": []}',
            ' ```json\n{"messages":[],"next":"done"}\n```',
            '["not an AgentOutput"]',
            '"ordinary words in valid JSON"',
            "null",
            "42",
        ]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(ValueError):
                merge_response_outputs([text_item(text), item()])
            with self.subTest(text=text, after_valid=True), self.assertRaises(ValueError):
                merge_response_outputs(
                    [item([msg("early")], phase="commentary"), text_item(text)]
                )

    def test_invalid_metadata_and_final_are_strict(self):
        invalid_items = [
            text_item("plain final", phase="final_answer"),
            text_item("plain final", phase=None),
            text_item("plain commentary", phase="unknown"),
            {**text_item("plain commentary"), "role": "user"},
            {
                **text_item("plain commentary"),
                "content": [{"type": "refusal", "refusal": "No"}],
            },
            {
                **text_item("plain commentary"),
                "content": [{"type": "input_text", "text": "No"}],
            },
        ]
        for invalid in invalid_items:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                merge_response_outputs([invalid, item()])

    def test_stream_merges_once_after_completed_and_replays_raw_phases(self):
        items = [
            {"type": "reasoning", "encrypted_content": "opaque", "summary": []},
            text_item("我先核对需求。"),
            item([msg("names"), msg("paging"), msg("totals")], phase="commentary"),
            item(),
        ]
        completed = False

        def respond(model, body):
            nonlocal completed
            for event in events(items):
                completed = event["type"] == "response.completed"
                yield event

        model = CodexSubscriptionModel()
        with patch.object(CodexSubscriptionModel, "_request", respond):
            chunks = []
            for chunk in model.stream("work", response_format=FORMAT):
                self.assertTrue(completed)
                chunks.append(chunk)
            self.assertEqual(len(chunks), 1)
            merged = AgentOutput.model_validate_json(chunks[0].content)
            self.assertEqual(len(merged.messages), 3)
            self.assertEqual(merged.next, "wait")
            answer = model.invoke("work", response_format=FORMAT)
        replay = model._build_request([HumanMessage(content="work"), answer])["input"][
            1:
        ]
        self.assertEqual(replay, items)
        self.assertEqual(answer.additional_kwargs["codex_output_items"], items)
        self.assertEqual(
            answer.additional_kwargs["wandrun_agent_output"], merged.model_dump()
        )

    def test_progress_only_requires_communication_or_tools(self):
        progress = text_item("正在处理。")
        self.assertIsNone(merge_response_outputs([progress]))
        with patch.object(
            CodexSubscriptionModel,
            "_request",
            lambda model, body: events([progress]),
        ):
            with self.assertRaises(RuntimeError):
                list(CodexSubscriptionModel().stream("work", response_format=FORMAT))

        tool = {
            "type": "function_call",
            "id": "fc_check",
            "call_id": "call_check",
            "name": "check",
            "arguments": "{}",
        }
        items = [progress, tool]
        with patch.object(
            CodexSubscriptionModel,
            "_request",
            lambda model, body: events(items),
        ):
            chunks = list(CodexSubscriptionModel().stream("work", response_format=FORMAT))
        self.assertEqual(chunks[-1].additional_kwargs["codex_output_items"], items)
        self.assertNotIn("wandrun_agent_output", chunks[-1].additional_kwargs)
        self.assertEqual(chunks[-1].content, "")

    def test_plain_final_cannot_be_discarded_by_stream(self):
        for phase in ("final_answer", None):
            with self.subTest(phase=phase), patch.object(
                CodexSubscriptionModel,
                "_request",
                lambda model, body: events(
                    [text_item("我已经委派", phase=phase), item(phase="commentary")]
                ),
            ):
                with self.assertRaises(ValueError):
                    list(CodexSubscriptionModel().stream("work", response_format=FORMAT))

    def test_incomplete_response_does_not_emit_partial_communication(self):
        def respond(model, body):
            yield from list(events([item([msg("must not send")], phase="commentary")]))[
                :-1
            ]

        with patch.object(CodexSubscriptionModel, "_request", respond):
            stream = CodexSubscriptionModel().stream("work", response_format=FORMAT)
            with self.assertRaises(RuntimeError):
                next(stream)

    def test_other_schema_keeps_existing_final_text_behavior(self):
        items = [item([msg("ignored")], phase="commentary"), item()]
        other = copy.deepcopy(FORMAT)
        other["json_schema"]["schema"] = {"type": "object", "properties": {}}
        with patch.object(
            CodexSubscriptionModel, "_request", lambda model, body: events(items)
        ):
            answer = CodexSubscriptionModel().invoke("work", response_format=other)
        self.assertEqual(answer.content, items[-1]["content"][0]["text"])
        self.assertNotIn("wandrun_agent_output", answer.additional_kwargs)


class ResponseGraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_worker_replies_keep_independent_cache_identities(self):
        with tempfile.TemporaryDirectory() as directory:
            shown, child_ids, bodies = [], set(), []
            delivered = asyncio.Event()

            async def respond(model, body):
                bodies.append(body)
                executor = "你是 executor" in body["instructions"]
                key = body["prompt_cache_key"]
                if executor:
                    self.assertIn(key, child_ids)
                else:
                    self.assertEqual(key, "p")
                await asyncio.sleep(0)
                self.assertEqual(body["prompt_cache_key"], key)
                replies = [
                    entry for entry in body["input"]
                    if entry.get("role") == "user" and "child answer" in str(entry)
                ]
                if executor:
                    response = [item([msg("child answer", "planner", "p")], "done")]
                elif len(replies) == 3:
                    response = [item([msg("all finished", "human")], "done")]
                elif replies:
                    response = [item()]
                else:
                    response = [
                        item(
                            [msg("names"), msg("paging"), msg("totals")],
                            phase="commentary",
                        ),
                        item(),
                    ]
                for event in events(response):
                    yield event

            async def run(prompts, task_id):
                role = manager.agent_name(task_id)
                if role == "executor":
                    child_ids.add(task_id)
                return await run_conversation(agents[role].graph, prompts, task_id, role)

            def human(sender, text, attachments, draft_id):
                shown.append(text)
                delivered.set()

            manager = WorkerManager(
                run,
                on_human=human,
                agent_workers={
                    name: spec.workers for name, spec in DEFINITIONS.items()
                },
                default_agent="planner",
            )
            self.addAsyncCleanup(manager.close)
            model = CodexSubscriptionModel()
            agents = build_agents(
                manager,
                definitions=DEFINITIONS,
                models={name: model for name in DEFINITIONS},
                tools={name: [] for name in DEFINITIONS},
                environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                checkpointer=InMemorySaver(),
            )
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                manager.start("repair three modules", "p")
                await asyncio.wait_for(delivered.wait(), 5)
                self.assertEqual((await manager.wait("p"))["status"], "completed")
                for child_id in child_ids:
                    self.assertEqual((await manager.wait(child_id))["status"], "completed")
            self.assertEqual(len(child_ids), 3)
            self.assertEqual({body["prompt_cache_key"] for body in bodies}, {"p", *child_ids})
            self.assertIsNone(model.prompt_cache_key)
            self.assertEqual(len(manager.snapshot()["tasks"]), 4)
            self.assertEqual(shown, ["all finished"])
            self.assertTrue(
                any(
                    entry.get("phase") == "commentary"
                    for body in bodies for entry in body["input"]
                )
            )
            await manager.close()

    async def test_mixed_response_dispatches_before_blocking_tool_completes(self):
        from langchain_core.tools import tool

        for next_state in ("wait", "done"):
            with self.subTest(next_state=next_state), tempfile.TemporaryDirectory() as directory:
                child_started = asyncio.Event()
                tool_finished = asyncio.Event()
                parent_bodies, child_bodies, shown = [], [], []

                @tool
                async def await_child() -> str:
                    """Wait for the delegated executor to begin."""
                    await asyncio.wait_for(child_started.wait(), 3)
                    tool_finished.set()
                    return "child started"

                async def respond(model, body):
                    if "你是 executor" in body["instructions"]:
                        child_bodies.append(body)
                        self.assertFalse(tool_finished.is_set())
                        child_started.set()
                        response = [item(next="wait")]
                    else:
                        parent_bodies.append(body)
                        if len(parent_bodies) == 1:
                            response = [
                                text_item("我先交付任务，再调用工具。"),
                                item([msg("delegate")], phase="commentary"),
                                {
                                    "type": "function_call",
                                    "id": "fc_wait",
                                    "call_id": "call_wait",
                                    "name": "await_child",
                                    "arguments": "{}",
                                },
                                item(next=next_state),
                            ]
                        elif len(parent_bodies) == 2:
                            self.assertTrue(tool_finished.is_set())
                            self.assertTrue(
                                any(
                                    entry.get("type") == "function_call_output"
                                    and entry["output"] == "child started"
                                    for entry in body["input"]
                                )
                            )
                            self.assertTrue(
                                runtime_feedback(body)[-1]["deliveries"][0]["accepted"]
                            )
                            self.assertTrue(
                                any(
                                    entry.get("type") == "message"
                                    and entry.get("content") == [
                                        {"type": "output_text", "text": "我先交付任务，再调用工具。"}
                                    ]
                                    for entry in body["input"]
                                )
                            )
                            response = [item([msg("done", "human")], next="done")]
                        else:
                            response = [item(next="done")]
                    for event in events(response):
                        yield event

                async def run(prompts, task_id):
                    role = manager.agent_name(task_id)
                    return await run_conversation(agents[role].graph, prompts, task_id, role)

                manager = WorkerManager(
                    run,
                    on_human=lambda sender, text, attachments, draft_id: shown.append(text),
                    agent_workers={
                        name: spec.workers for name, spec in DEFINITIONS.items()
                    },
                    default_agent="planner",
                )
                self.addAsyncCleanup(manager.close)
                agents = build_agents(
                    manager,
                    definitions=DEFINITIONS,
                    models={name: CodexSubscriptionModel() for name in DEFINITIONS},
                    tools={name: [await_child] for name in DEFINITIONS},
                    environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                    checkpointer=InMemorySaver(),
                )
                with patch.object(CodexSubscriptionModel, "_arequest", respond):
                    manager.start("delegate and wait for the tool", "p")
                    result = await asyncio.wait_for(manager.wait("p"), 5)
                    self.assertEqual(result["status"], "completed")
                    self.assertEqual(
                        result["result"],
                        {"messages": [msg("done", "human")], "next": "done"},
                    )
                    child_id = next(
                        task_id for task_id in manager.snapshot()["tasks"] if task_id != "p"
                    )
                    self.assertEqual((await manager.wait(child_id))["status"], "waiting")
                    self.assertEqual(shown, ["done"])
                    self.assertEqual(len(child_bodies), 1)
                    self.assertEqual(len(parent_bodies), 2)
                    # Resuming the same graph must not send its previous response again.
                    manager.start("new independent input", "p")
                    self.assertEqual(
                        (await asyncio.wait_for(manager.wait("p"), 5))["status"],
                        "completed",
                    )
                self.assertEqual(len(parent_bodies), 3)
                self.assertEqual(len(child_bodies), 1)
                self.assertEqual(shown, ["done"])
                await manager.close()

    async def test_pure_tool_response_runs_tool_before_structured_answer(self):
        from langchain_core.tools import tool

        with tempfile.TemporaryDirectory() as directory:
            parent_bodies, invoked, shown = [], [], []

            @tool
            async def inspect() -> str:
                """Return an observed local value."""
                invoked.append("ran")
                return "observed value"

            async def respond(model, body):
                parent_bodies.append(body)
                if len(parent_bodies) == 1:
                    response = [
                        {
                            "type": "function_call",
                            "id": "fc_inspect",
                            "call_id": "call_inspect",
                            "name": "inspect",
                            "arguments": "{}",
                        }
                    ]
                else:
                    self.assertEqual(len(parent_bodies), 2)
                    self.assertEqual(invoked, ["ran"])
                    self.assertFalse(runtime_feedback(body))
                    self.assertTrue(
                        any(
                            entry.get("type") == "function_call_output"
                            and entry["output"] == "observed value"
                            for entry in body["input"]
                        )
                    )
                    response = [item([msg("finished", "human")], next="done")]
                for event in events(response):
                    yield event

            async def run(prompts, task_id):
                return await run_conversation(agents["planner"].graph, prompts, task_id, "planner")

            manager = WorkerManager(run, on_human=lambda sender, text, attachments, draft_id: shown.append(text))
            self.addAsyncCleanup(manager.close)
            agents = build_agents(
                manager,
                definitions=DEFINITIONS,
                models={name: CodexSubscriptionModel() for name in DEFINITIONS},
                tools={name: [inspect] for name in DEFINITIONS},
                environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                checkpointer=InMemorySaver(),
            )
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                manager.start("inspect before replying", "p")
                self.assertEqual(
                    (await asyncio.wait_for(manager.wait("p"), 5))["status"], "completed"
                )
            self.assertEqual(len(parent_bodies), 2)
            self.assertEqual(shown, ["finished"])
            await manager.close()

    async def test_no_tool_continue_consumes_receipts_without_resending(self):
        with tempfile.TemporaryDirectory() as directory:
            parent_bodies, shown = [], []

            async def respond(model, body):
                parent_bodies.append(body)
                if len(parent_bodies) == 1:
                    response = [item([msg("only once", "human")], next="continue")]
                else:
                    self.assertEqual(len(parent_bodies), 2)
                    deliveries = runtime_feedback(body)[-1]["deliveries"]
                    self.assertEqual(len(deliveries), 1)
                    self.assertTrue(deliveries[0]["accepted"])
                    response = [item(next="wait")]
                for event in events(response):
                    yield event

            async def run(prompts, task_id):
                return await run_conversation(agents["planner"].graph, prompts, task_id, "planner")

            manager = WorkerManager(run, on_human=lambda sender, text, attachments, draft_id: shown.append(text))
            self.addAsyncCleanup(manager.close)
            agents = build_agents(
                manager,
                definitions=DEFINITIONS,
                models={name: CodexSubscriptionModel() for name in DEFINITIONS},
                tools={name: [] for name in DEFINITIONS},
                environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                checkpointer=InMemorySaver(),
            )
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                manager.start("work", "p")
                self.assertEqual(
                    (await asyncio.wait_for(manager.wait("p"), 5))["status"], "waiting"
                )
            self.assertEqual(shown, ["only once"])
            self.assertEqual(len(parent_bodies), 2)
            await manager.close()

    async def test_success_receipts_wait_for_new_input_instead_of_spinning(self):
        for next_state in ("wait", "done"):
            with self.subTest(next_state=next_state), tempfile.TemporaryDirectory() as directory:
                parent_bodies, child_bodies = [], []

                async def respond(model, body):
                    if "你是 executor" in body["instructions"]:
                        child_bodies.append(body)
                        response = [item(next="wait")]
                    else:
                        parent_bodies.append(body)
                        if len(parent_bodies) == 1:
                            response = [item([msg("delegate")], next=next_state)]
                        else:
                            deliveries = runtime_feedback(body)[-1]["deliveries"]
                            self.assertEqual(len(deliveries), 1)
                            self.assertTrue(deliveries[0]["accepted"])
                            response = [item(next="done")]
                    for event in events(response):
                        yield event

                async def run(prompts, task_id):
                    role = manager.agent_name(task_id)
                    return await run_conversation(agents[role].graph, prompts, task_id, role)

                manager = WorkerManager(
                    run,
                    agent_workers={
                        name: spec.workers for name, spec in DEFINITIONS.items()
                    },
                    default_agent="planner",
                )
                self.addAsyncCleanup(manager.close)
                agents = build_agents(
                    manager,
                    definitions=DEFINITIONS,
                    models={name: CodexSubscriptionModel() for name in DEFINITIONS},
                    tools={name: [] for name in DEFINITIONS},
                    environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                    checkpointer=InMemorySaver(),
                )
                with patch.object(CodexSubscriptionModel, "_arequest", respond):
                    manager.start("work", "p")
                    self.assertEqual(
                        (await asyncio.wait_for(manager.wait("p"), 5))["status"],
                        "waiting" if next_state == "wait" else "completed",
                    )
                    self.assertEqual(len(parent_bodies), 1)
                    manager.start("new input", "p")
                    self.assertEqual(
                        (await asyncio.wait_for(manager.wait("p"), 5))["status"],
                        "completed",
                    )
                    child_id = next(
                        task_id for task_id in manager.snapshot()["tasks"] if task_id != "p"
                    )
                    await manager.wait(child_id)
                self.assertEqual(len(child_bodies), 1)
                self.assertEqual(len(parent_bodies), 2)
                await manager.close()

    async def test_partial_failure_corrects_wait_or_done_without_resending_success(self):
        for next_state in ("wait", "done"):
            with self.subTest(next_state=next_state), tempfile.TemporaryDirectory() as directory:
                parent_bodies, child_bodies, shown = [], [], []

                async def respond(model, body):
                    if "你是 executor" in body["instructions"]:
                        child_bodies.append(body)
                        response = [item(next="wait")]
                    else:
                        parent_bodies.append(body)
                        if len(parent_bodies) == 1:
                            response = [
                                item(
                                    [msg("accepted once", "human")],
                                    phase="commentary",
                                ),
                                item([msg("correction", "planner", "child")], next_state),
                            ]
                        else:
                            self.assertEqual(len(parent_bodies), 2)
                            deliveries = runtime_feedback(body)[-1]["deliveries"]
                            self.assertEqual(len(deliveries), 2)
                            self.assertTrue(deliveries[0]["accepted"])
                            self.assertFalse(deliveries[1]["accepted"])
                            response = [
                                item([msg("correction", "executor", "child")], next="done")
                            ]
                    for event in events(response):
                        yield event

                async def run(prompts, task_id):
                    role = manager.agent_name(task_id)
                    return await run_conversation(agents[role].graph, prompts, task_id, role)

                manager = WorkerManager(
                    run,
                    on_human=lambda sender, text, attachments, draft_id: shown.append(text),
                    agent_workers={"planner": ("executor",), "executor": ()},
                    default_agent="planner",
                )
                self.addAsyncCleanup(manager.close)
                agents = build_agents(
                    manager,
                    definitions=DEFINITIONS,
                    models={name: CodexSubscriptionModel() for name in DEFINITIONS},
                    tools={name: [] for name in DEFINITIONS},
                    environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                    checkpointer=InMemorySaver(),
                )
                with patch.object(CodexSubscriptionModel, "_arequest", respond):
                    manager.start("initial", "child", agent_name="executor")
                    await asyncio.wait_for(manager.wait("child"), 5)
                    manager.start("work", "p")
                    self.assertEqual(
                        (await asyncio.wait_for(manager.wait("p"), 5))["status"],
                        "completed",
                    )
                    await asyncio.wait_for(manager.wait("child"), 5)
                self.assertEqual(len(parent_bodies), 2)
                self.assertEqual(len(child_bodies), 2)
                self.assertTrue(
                    any(
                        entry.get("role") == "user"
                        and "消息正文：\ncorrection" in entry["content"]
                        for entry in child_bodies[-1]["input"]
                    )
                )
                self.assertEqual(shown, ["accepted once"])
                await manager.close()

    async def test_dispatched_messages_survive_later_tool_failure(self):
        from langchain_core.tools import tool

        with tempfile.TemporaryDirectory() as directory:
            parent_bodies, child_bodies, shown = [], [], []

            @tool
            async def fail_tool() -> str:
                """Fail after a structured message was sent."""
                raise RuntimeError("controlled tool failure")

            async def respond(model, body):
                if "你是 executor" in body["instructions"]:
                    child_bodies.append(body)
                    response = [item(next="wait")]
                else:
                    parent_bodies.append(body)
                    response = [
                        item(
                            [msg("delegate"), msg("already sent", "human")],
                            phase="commentary",
                        ),
                        {
                            "type": "function_call",
                            "id": "fc_fail",
                            "call_id": "call_fail",
                            "name": "fail_tool",
                            "arguments": "{}",
                        },
                        item(next="done"),
                    ]
                for event in events(response):
                    yield event

            async def run(prompts, task_id):
                role = manager.agent_name(task_id)
                return await run_conversation(agents[role].graph, prompts, task_id, role)

            manager = WorkerManager(
                run,
                on_human=lambda sender, text, attachments, draft_id: shown.append(text),
                agent_workers={
                    name: spec.workers for name, spec in DEFINITIONS.items()
                },
                default_agent="planner",
            )
            self.addAsyncCleanup(manager.close)
            agents = build_agents(
                manager,
                definitions=DEFINITIONS,
                models={name: CodexSubscriptionModel() for name in DEFINITIONS},
                tools={name: [fail_tool] for name in DEFINITIONS},
                environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                checkpointer=InMemorySaver(),
            )
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                manager.start("delegate before the tool fails", "p")
                result = await asyncio.wait_for(manager.wait("p"), 5)
                self.assertEqual(result["status"], "failed")
                self.assertIn("controlled tool failure", result["error"])
                child_id = next(
                    task_id for task_id in manager.snapshot()["tasks"] if task_id != "p"
                )
                self.assertEqual((await manager.wait(child_id))["status"], "waiting")
            self.assertEqual(len(parent_bodies), 1)
            self.assertEqual(len(child_bodies), 1)
            self.assertTrue(
                any(
                    entry.get("role") == "user"
                    and "消息正文：\ndelegate" in entry["content"]
                    for entry in child_bodies[0]["input"]
                )
            )
            self.assertEqual(shown.count("already sent"), 1)
            self.assertEqual(shown[0], "already sent")
            await manager.close()

    async def test_headless_waits_for_child_checkpoint_tail_and_observes_failure(self):
        from wandrun.evaluation.headless import LifecycleError, _wait_for_root

        for outcome in ("committed", "failed", "new_input"):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                checkpoint_entered, release_checkpoint = asyncio.Event(), asyncio.Event()
                held = False
                shown = []

                class DelayedSaver(InMemorySaver):
                    async def aput(self, config, checkpoint, metadata, new_versions):
                        nonlocal held
                        task_id = config["configurable"]["thread_id"]
                        # durability=sync: this write occurs after the child's dispatch,
                        # not while its model response is still being generated.
                        if task_id != "p" and manager._feedback.get(task_id) and not held:
                            held = True
                            checkpoint_entered.set()
                            await release_checkpoint.wait()
                            if outcome == "failed":
                                raise OSError("controlled checkpoint failure")
                        return await super().aput(config, checkpoint, metadata, new_versions)

                async def respond(model, body):
                    if "你是 executor" in body["instructions"]:
                        response = [item([msg("child finished", "planner", "p")], "done")]
                    elif any(
                        "controlled checkpoint failure" in feedback.get("error", "")
                        for feedback in runtime_feedback(body)
                    ):
                        raise RuntimeError("checkpoint failure reached planner")
                    elif any(
                        entry.get("role") == "user" and "child finished" in str(entry)
                        for entry in body["input"]
                    ):
                        response = [item([msg("all finished", "human")], "done")]
                    else:
                        response = [item([msg("work")], "wait")]
                    for event in events(response):
                        yield event

                async def run(prompts, task_id):
                    role = manager.agent_name(task_id)
                    return await run_conversation(agents[role].graph, prompts, task_id, role)

                manager = WorkerManager(
                    run,
                    on_human=lambda sender, text, attachments, draft_id: shown.append(text),
                    agent_workers={
                        name: spec.workers for name, spec in DEFINITIONS.items()
                    },
                    default_agent="planner",
                )
                self.addAsyncCleanup(manager.close)
                agents = build_agents(
                    manager,
                    definitions=DEFINITIONS,
                    models={name: CodexSubscriptionModel() for name in DEFINITIONS},
                    tools={name: [] for name in DEFINITIONS},
                    environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=directory, virtual_mode=True), "/skills", "/")),
                    checkpointer=DelayedSaver(),
                )
                with patch.object(CodexSubscriptionModel, "_arequest", respond):
                    manager.start("work", "p")
                    await asyncio.wait_for(checkpoint_entered.wait(), 5)
                    self.assertEqual(
                        (await asyncio.wait_for(manager.wait("p"), 5))["status"], "completed"
                    )
                    child_id = next(task_id for task_id in manager._tasks if task_id != "p")
                    self.assertEqual(manager.get(child_id)["status"], "running")
                    self.assertEqual(shown, ["all finished"])
                    waiter = asyncio.create_task(_wait_for_root(manager, "p"))
                    try:
                        if outcome == "new_input":
                            manager.start("more work", child_id)
                            with self.assertRaises(LifecycleError):
                                await asyncio.wait_for(waiter, 5)
                            continue
                        await asyncio.sleep(0)
                        if waiter.done():
                            waiter.result()  # Report premature lifecycle failure directly.
                        self.assertFalse(waiter.done(), "headless returned before checkpoint commit")
                        release_checkpoint.set()
                        if outcome == "failed":
                            with self.assertRaises(RuntimeError):
                                await asyncio.wait_for(waiter, 5)
                            self.assertEqual(manager.get(child_id)["status"], "failed")
                        else:
                            result = await asyncio.wait_for(waiter, 5)
                            self.assertEqual(result["status"], "completed")
                            self.assertEqual(manager.get(child_id)["status"], "completed")
                    finally:
                        release_checkpoint.set()
                        waiter.cancel()
                        await asyncio.gather(waiter, return_exceptions=True)
                        await manager.close()
