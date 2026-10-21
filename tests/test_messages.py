"""结构化交流：本地调度与真实 Agent 图，不调用远端模型。"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from langchain.agents import create_agent
from langchain.agents.structured_output import ProviderStrategy
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import tool
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.runtime.conversations import (
    conversation_config,
    missing_tool_results,
    prepare_conversation_input,
)
from types import SimpleNamespace
from wandrun.runtime.messages import AgentOutput, SendMessage, merge_response_outputs
from wandrun.runtime.files import TaskFiles
from wandrun.runtime.workers import CommunicationMiddleware, WorkerManager, worker_tools


def output(*messages, next="done"):
    return AgentOutput(messages=list(messages), next=next)


def message(text, target=None, to="worker"):
    return SendMessage(to=to, task_id=target, message=text)


class MessageTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_input_follows_dispatched_done_without_retracting_delivery(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls, shown, children = [], [], []

        async def run(prompts, task_id):
            if task_id != "a":
                children.extend(prompts)
                return output()
            calls.append(prompts)
            if len(calls) == 1:
                entered.set()
                await release.wait()
                result = output(
                    message("old answer", to="human"),
                    message("old assignment"),
                )
                receipts = manager.dispatch(result, task_id)
                self.assertTrue(all(item["accepted"] for item in receipts))
                return result
            self.assertEqual(shown, ["old answer"])
            self.assertTrue(prompts[1].content.endswith("supplement"))
            self.assertEqual(prompts[1].additional_kwargs["sender_id"], "b")
            feedback = json.loads(prompts[0].content.split("\n", 1)[1])
            self.assertEqual(len(feedback["deliveries"]), 2)
            self.assertTrue(all(item["accepted"] for item in feedback["deliveries"]))
            result = output(message("revised answer", to="human"))
            manager.dispatch(result, task_id)
            return result

        manager = WorkerManager(run, on_human=lambda sender, text, attachments, draft_id: shown.append(text))
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "a")
        await asyncio.wait_for(entered.wait(), 2)
        manager.start("supplement", "a", sender_id="b")
        release.set()
        self.assertEqual((await manager.wait("a"))["status"], "completed")
        self.assertEqual(len(calls), 2)
        self.assertEqual(shown, ["old answer", "revised answer"])
        await manager.wait(next(task_id for task_id in manager._tasks if task_id != "a"))
        self.assertEqual(len(children), 1)
        self.assertEqual(len(manager._tasks), 2)
        self.assertNotIn("a", manager._inflight)

    async def test_successful_receipt_is_retained_without_waking_idle_worker(self):
        calls, shown = [], []

        async def run(prompts, task_id):
            calls.append(prompts)
            return output(next="wait")

        manager = WorkerManager(run, on_human=lambda sender, text, attachments, draft_id: shown.append(text))
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "a")
        self.assertEqual((await manager.wait("a"))["status"], "waiting")
        old_task = manager._tasks["a"]
        receipts = manager.dispatch(output(message("visible", to="human")), "a")
        self.assertTrue(receipts[0]["accepted"])
        await asyncio.sleep(0)
        self.assertEqual(shown, ["visible"])
        self.assertEqual(len(calls), 1)
        self.assertIs(manager._tasks["a"], old_task)
        self.assertEqual(manager.get("a")["status"], "waiting")

        manager.start("new input", "a")
        self.assertEqual((await manager.wait("a"))["status"], "waiting")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][1].content, "new input")
        feedback = json.loads(calls[1][0].content.split("\n", 1)[1])
        self.assertEqual(feedback["deliveries"], receipts)
        self.assertEqual(shown, ["visible"])

    async def test_failure_notifies_original_caller_only(self):
        entered, release, notified = asyncio.Event(), asyncio.Event(), asyncio.Event()
        received = {}

        async def run(prompts, task_id):
            received.setdefault(task_id, []).extend(prompts)
            if task_id == "child":
                entered.set()
                await release.wait()
                raise ValueError("broken")
            if any(m.additional_kwargs.get("source") == "runtime" for m in prompts):
                notified.set()
            return output(next="wait")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        for caller in ("a", "b"):
            manager.start("initial", caller)
            await manager.wait(caller)
        manager.start("work", "child", sender_id="a")
        await entered.wait()
        manager.start("supplement", "child", sender_id="b")
        release.set()
        await asyncio.wait_for(notified.wait(), 2)
        self.assertEqual(manager._callers["child"], "a")
        self.assertEqual(len(received["b"]), 1)
        notices = [
            m for m in received["a"] if m.additional_kwargs.get("source") == "runtime"
        ]
        self.assertEqual(len(notices), 1)
        self.assertIn("ValueError: broken", notices[0].content)
        self.assertEqual(manager.get("child")["status"], "failed")

    async def test_cancel_before_start_waiting_and_repeat(self):
        for waiting in (False, True):
            with self.subTest(waiting=waiting):
                notices = []

                async def run(prompts, task_id):
                    if task_id == "caller":
                        notices.extend(prompts)
                    return output(next="wait")

                manager = WorkerManager(run)
                self.addAsyncCleanup(manager.close)
                manager.start("initial", "caller")
                await manager.wait("caller")
                manager.start("work", "child", sender_id="caller")
                if waiting:
                    await manager.wait("child")
                for _ in range(2):
                    status = await manager.cancel("child", cancelled_by="other")
                    self.assertEqual(status["status"], "cancelled")
                await manager.wait("caller")
                errors = [
                    m for m in notices if m.additional_kwargs.get("source") == "runtime"
                ]
                self.assertEqual(len(errors), 1)
                self.assertIn('"status": "cancelled"', errors[0].content)
                self.assertNotIn("cancelled_by", errors[0].content)

    async def test_cancel_tool_returns_result_without_duplicate_to_caller(self):
        received = []

        async def run(prompts, task_id):
            if task_id == "caller":
                received.extend(prompts)
            return output(next="wait")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "caller")
        await manager.wait("caller")
        manager.start("work", "child", sender_id="caller")
        (cancel,) = worker_tools(manager)
        await manager.wait("child")
        manager.start("nested work", "grandchild", sender_id="child")
        await manager.wait("grandchild")
        status = await cancel.ainvoke(
            {"task_id": "child"}, config=conversation_config("caller")
        )
        self.assertEqual(status["status"], "cancelled")
        self.assertEqual(status["stopped"], ["child", "grandchild"])
        self.assertEqual(manager.get("grandchild")["status"], "cancelled")
        self.assertEqual([m.content for m in received], ["initial"])
        self.assertFalse(
            (
                await cancel.ainvoke(
                    {"task_id": "caller"}, config=conversation_config("caller")
                )
            )["accepted"]
        )
        self.assertEqual(
            manager.get("child")["status"], "cancelled"
        )

    async def test_invalid_recipient_returns_receipt_without_losing_valid_delivery(
        self,
    ):
        calls, shown = [], []

        async def run(prompts, task_id):
            calls.append(prompts)
            return output(next="wait")

        manager = WorkerManager(run, on_human=lambda sender, text, attachments, draft_id: shown.append(text))
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "a")
        await manager.wait("a")
        receipts = manager.dispatch(
            output(message("visible", to="human"), message("bad", "unknown")),
            "a",
        )
        self.assertTrue(receipts[0]["accepted"])
        self.assertFalse(receipts[1]["accepted"])
        self.assertEqual(shown, ["visible"])
        self.assertNotIn("unknown", manager._tasks)
        manager.start("correct recipient", "a")
        await manager.wait("a")
        feedback = json.loads(calls[1][0].content.split("\n", 1)[1])
        self.assertEqual(feedback["deliveries"], receipts)
        self.assertEqual(calls[1][1].content, "correct recipient")

    async def test_reply_arrives_before_wait_boundary(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            calls.append(prompts)
            if len(calls) == 1:
                entered.set()
                await release.wait()
            return output(next="wait")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "a")
        await entered.wait()
        manager.start("reply", "a", sender_id="b")
        release.set()
        self.assertEqual((await manager.wait("a"))["status"], "waiting")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0].additional_kwargs["sender_id"], "b")

    async def test_real_graph_tools_schema_round_trip_and_checkpoint(self):
        counts, bindings, shown = [], [], []
        complete = asyncio.Event()
        test = self

        @tool
        def probe() -> str:
            """Return a local test value."""
            counts.append(1)
            return "42"

        class Model(FakeMessagesListChatModel):
            def bind_tools(self, tools, **kwargs):
                bindings.append((tools, kwargs))
                return self

            async def _agenerate(self, messages, **kwargs):
                test.assertEqual(missing_tool_results(messages), [])
                humans = [m for m in messages if isinstance(m, HumanMessage)]
                peers = [
                    m for m in humans if m.additional_kwargs.get("source") == "worker"
                ]
                if humans[0].additional_kwargs.get("source") == "worker":
                    result = output(
                        message("child answer", peers[0].additional_kwargs["sender_id"])
                    )
                elif peers:
                    result = output(message("final answer", to="human"))
                elif not any(isinstance(m, ToolMessage) for m in messages):
                    return ChatResult(
                        generations=[
                            ChatGeneration(
                                message=AIMessage(
                                    content="",
                                    tool_calls=[
                                        {
                                            "name": "probe",
                                            "args": {},
                                            "id": "probe-1",
                                            "type": "tool_call",
                                        }
                                    ],
                                )
                            )
                        ]
                    )
                else:
                    result = output(message("please help"), next="wait")
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

        with tempfile.TemporaryDirectory() as directory:
            database = str(Path(directory) / "state.sqlite")
            async with AsyncSqliteSaver.from_conn_string(database) as saver:

                async def run(prompts, task_id):
                    config = conversation_config(task_id)
                    inputs = await prepare_conversation_input(agent, config, prompts)
                    result = await agent.ainvoke(
                        inputs,
                        config=config,
                        context={"task_id": task_id},
                        durability="sync",
                    )
                    return AgentOutput.model_validate(result["structured_response"])

                def show(sender, text, attachments, draft_id):
                    shown.append(text)
                    complete.set()

                manager = WorkerManager(run, on_human=show)
                try:
                    agent = create_agent(
                        model=Model(responses=[]),
                        tools=[probe],
                        response_format=ProviderStrategy(
                            AgentOutput.model_json_schema(), strict=True
                        ),
                        middleware=[CommunicationMiddleware(manager)],
                        checkpointer=saver,
                    )
                    manager.start("initial", "parent")
                    await asyncio.wait_for(complete.wait(), 5)
                    await manager.wait("parent")
                    self.assertEqual(shown, ["final answer"])
                    self.assertEqual(counts, [1])
                    self.assertTrue(
                        all(
                            b[1]["response_format"]["json_schema"]["strict"]
                            for b in bindings
                        )
                    )
                    history = (
                        await agent.aget_state(conversation_config("parent"))
                    ).values["messages"]
                    self.assertEqual(missing_tool_results(history), [])
                    peers = [
                        m
                        for m in history
                        if m.additional_kwargs.get("source") == "worker"
                    ]
                    self.assertEqual(len(peers), 1)
                    child_id = peers[0].additional_kwargs["sender_id"]
                    self.assertEqual(manager._callers[child_id], "parent")
                finally:
                    await manager.close()
            async with AsyncSqliteSaver.from_conn_string(database) as reopened:
                saved = await reopened.aget_tuple(conversation_config("parent"))
                persisted = saved.checkpoint["channel_values"]["messages"]
                self.assertTrue(any(m.id == peers[0].id for m in persisted))

    async def test_different_callers_get_independent_threads(self):
        async def run(prompts, task_id):
            return output(next="wait")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        for caller in ("a", "b"):
            manager.start("initial", caller)
        first = manager.dispatch(output(message("work one")), "a")[0]["task_id"]
        second = manager.dispatch(output(message("work two")), "b")[0]["task_id"]
        self.assertNotEqual(first, second)
        self.assertEqual(manager._callers[first], "a")
        self.assertEqual(manager._callers[second], "b")
        await manager.wait(first)
        await manager.wait(second)
        await manager.close()
        self.assertEqual(manager.get(first)["status"], "cancelled")

    def test_schema_does_not_allow_model_to_supply_sender(self):
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            SendMessage(to="worker", task_id=None, message="text", sender_id="forged")
        with self.assertRaises(ValidationError):
            SendMessage(to="worker", task_id=None, message="  ")

    def test_response_merge_preserves_each_structured_attachment(self):
        frames = [
            {"type": "message", "role": "assistant", "phase": "commentary",
             "content": [{"type": "output_text", "text": json.dumps({
                 "messages": [{"to": "worker", "task_id": None, "message": "work",
                               "attachments": ["a.txt"]}], "next": "continue",
             })}]},
            {"type": "message", "role": "assistant", "phase": "final_answer",
             "content": [{"type": "output_text", "text": json.dumps({
                 "messages": [{"to": "human", "task_id": None, "message": "result",
                               "attachments": ["b.txt"]}], "next": "done",
             })}]},
        ]
        merged = merge_response_outputs(frames)
        self.assertEqual([message.attachments for message in merged.messages], [["a.txt"], ["b.txt"]])
        self.assertEqual(merged.next, "done")

    async def test_attachment_partial_failure_keeps_text_and_only_failed_path_needs_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shown = []

            async def run(prompts, task_id):
                return output(next="wait")

            files = TaskFiles(root, None, {"worker": ("local", str(root))}, conversation_workdirs=True)
            manager = WorkerManager(
                run, on_human=lambda sender, text, attachments, draft_id: shown.append((text, attachments)),
                attachment_resolver=files.resolve_attachments,
            )
            files.manager = manager
            self.addAsyncCleanup(manager.close)
            manager.start("initial", "root")
            await manager.wait("root")
            await files.prepare("root")
            workdir = Path(files.directory("root"))
            (workdir / "ok.txt").write_text("ok")
            payload = output(SendMessage(to="human", task_id=None, message="正文",
                                         attachments=["ok.txt", "missing.txt"]), next="done")
            response = AIMessage(content="", id="response-files", additional_kwargs={
                "wandrun_agent_output": payload.model_dump(),
            })
            middleware = CommunicationMiddleware(manager)
            jump = await middleware.aafter_model({"messages": [response]},
                                                  SimpleNamespace(context={"task_id": "root"}))
            self.assertEqual(jump, {"jump_to": "model"})
            self.assertEqual(shown[0][0], "正文")
            self.assertEqual([item.name for item in shown[0][1]], ["ok.txt"])
            receipt = json.loads(manager.take_messages("root")[0].content.split("\n", 1)[1])["deliveries"][0]
            self.assertEqual([item["accepted"] for item in receipt["attachments"]], [True, False])
            (workdir / "missing.txt").write_text("now ready")
            retry = manager.dispatch(
                output(SendMessage(to="human", task_id=None, message="补发失败项",
                                   attachments=["missing.txt"])), "root",
            )[0]
            self.assertTrue(retry["accepted"])
            self.assertEqual([[item.name for item in attached] for _, attached in shown],
                             [["ok.txt"], ["missing.txt"]])

    async def test_distinct_local_execution_environments_reject_path_but_deliver_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            seen = []

            async def run(prompts, task_id):
                seen.extend(prompts if task_id != "root" else [])
                return output(next="wait")

            files = TaskFiles(
                root, None, {"first": ("local", str(root)), "other": ("separate", str(root))},
                conversation_workdirs=True,
            )
            manager = WorkerManager(
                run, agent_workers={"first": ("other",), "other": ()},
                default_agent="first", attachment_resolver=files.resolve_attachments,
            )
            files.manager = manager
            self.addAsyncCleanup(manager.close)
            manager.start("begin", "root")
            await manager.wait("root")
            await files.prepare("root")
            (Path(files.directory("root")) / "same.txt").write_text("not shared by environment")
            receipt = manager.dispatch(output(SendMessage(
                to="other", task_id=None, message="text still arrives", attachments=["same.txt"],
            )), "root")[0]
            self.assertTrue(receipt["accepted"])
            self.assertFalse(receipt["attachments"][0]["accepted"])
            await manager.wait(receipt["task_id"])
            self.assertIn("text still arrives", seen[0].content)
            self.assertNotIn("attachments", seen[0].additional_kwargs)

    async def test_missing_attachment_resolver_rejects_each_path_and_reopens_model(self):
        shown = []

        async def run(prompts, task_id):
            return output(next="wait")

        manager = WorkerManager(
            run, on_human=lambda sender, text, attachments, draft_id: shown.append((text, attachments)),
        )
        self.addAsyncCleanup(manager.close)
        manager.start("begin", "root")
        await manager.wait("root")
        middleware = CommunicationMiddleware(manager)
        for end in ("done", "wait"):
            with self.subTest(next=end):
                payload = output(SendMessage(
                    to="human", task_id=None, message="正文",
                    attachments=["missing.txt", " another.txt "],
                ), next=end)
                response = AIMessage(content="", id=f"missing-resolver-{end}", additional_kwargs={
                    "wandrun_agent_output": payload.model_dump(),
                })
                jump = await middleware.aafter_model(
                    {"messages": [response]}, SimpleNamespace(context={"task_id": "root"}),
                )
                self.assertEqual(jump, {"jump_to": "model"})
                receipt = json.loads(manager.take_messages("root")[0].content.split("\n", 1)[1])["deliveries"][0]
                self.assertTrue(receipt["accepted"])  # The text was delivered, not the files.
                self.assertEqual(
                    [(item["path"], item["accepted"]) for item in receipt["attachments"]],
                    [("missing.txt", False), (" another.txt ", False)],
                )
                self.assertEqual(shown[-1], ("正文", []))

    async def test_attachment_paths_preserve_whitespace_and_select_the_original_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shown = []

            async def run(prompts, task_id):
                return output(next="wait")

            files = TaskFiles(root, None, {"worker": ("local", str(root))}, conversation_workdirs=True)
            manager = WorkerManager(
                run, on_human=lambda sender, text, attachments, draft_id: shown.extend(attachments),
                attachment_resolver=files.resolve_attachments,
                attachment_preflight=files.prepare_attachments,
            )
            files.manager = manager
            self.addAsyncCleanup(manager.close)
            manager.start("begin", "root")
            await manager.wait("root")
            await files.prepare("root")
            workdir = Path(files.directory("root"))
            (workdir / "result.txt").write_text("wrong file")
            paths = [" result.txt", "result.txt ", "result.txt\n"]
            for index, path in enumerate(paths):
                (workdir / path).write_text(f"intended {index}")
            response = AIMessage(content="", id="whitespace-paths", additional_kwargs={
                "wandrun_agent_output": {
                    "messages": [{"to": "human", "task_id": None, "message": "原文件", "attachments": paths}],
                    "next": "done",
                },
            })
            jump = await CommunicationMiddleware(manager).aafter_model(
                {"messages": [response]}, SimpleNamespace(context={"task_id": "root"}),
            )
            self.assertIsNone(jump)
            self.assertEqual([item.name for item in shown], paths)
            self.assertEqual([Path(item.path).read_text() for item in shown], ["intended 0", "intended 1", "intended 2"])
