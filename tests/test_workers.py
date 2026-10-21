import asyncio
import unittest
from contextvars import ContextVar
from unittest.mock import patch

from langchain.agents import create_agent
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import tool
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.workers import CommunicationMiddleware, WorkerManager, worker_tools


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_and_message_share_one_execution(self):
        from wandrun.terminal.chat import TerminalOutput, chat

        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompt, task_id):
            calls.append(([m.content for m in prompt], task_id))
            entered.set()
            await release.wait()
            return "|".join(m.content for m in [*prompt, *manager.take_messages(task_id)])

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        inputs = asyncio.Queue()
        inputs.put_nowait("terminal message")
        with patch("wandrun.terminal.chat.read_line", side_effect=inputs.get):
            terminal = asyncio.create_task(
                chat(manager, "conversation", output=TerminalOutput())
            )
            try:
                await asyncio.wait_for(entered.wait(), 2)
                queued = manager.start("colleague message", "conversation", sender_id="colleague")
                self.assertTrue(queued["queued"])
                release.set()
                await manager.wait("conversation")
                inputs.put_nowait("/exit")
                await asyncio.wait_for(terminal, 2)
            finally:
                terminal.cancel()
                await asyncio.gather(terminal, return_exceptions=True)
        self.assertEqual(calls, [(["terminal message"], "conversation")])
        result = manager.get("conversation")["result"]
        self.assertIn('"colleague"', result)
        self.assertTrue(result.endswith("colleague message"))

    async def test_without_human_receiver_rejects_delivery_and_keeps_failure_queryable(self):
        from wandrun.runtime.messages import AgentOutput, SendMessage

        async def run(prompt, task_id):
            raise ValueError("execution failed")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        receipts = manager.dispatch(
            AgentOutput(
                messages=[SendMessage(to="human", task_id=None, message="answer")],
                next="done",
            ),
            "one",
        )
        self.assertFalse(receipts[0]["accepted"])
        manager.start("work", "one")
        status = await manager.wait("one")
        self.assertEqual(status["status"], "failed")
        self.assertIn("execution failed", status["error"])

    async def test_cancelling_waiter_does_not_cancel_worker(self):
        release = asyncio.Event()

        async def run(prompt, task_id):
            await release.wait()
            return "answer"

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("work", "one")
        waiter = asyncio.create_task(manager.wait("one"))
        await asyncio.sleep(0)
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        self.assertEqual(manager.get("one")["status"], "running")
        release.set()
        self.assertEqual((await manager.wait("one"))["result"], "answer")
        self.assertEqual((await manager.wait("missing"))["status"], "not_found")

    async def test_child_does_not_inherit_parent_execution_context(self):
        parent_context = ContextVar("parent_run", default="independent")
        parent_context.set("parent tool call")

        async def run(prompt, task_id):
            return parent_context.get()

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        task_id = manager.start("work")["task_id"]
        await asyncio.sleep(0)
        self.assertEqual(manager.get(task_id)["result"], "independent")

    async def test_immediate_return_and_independent_results(self):
        release = asyncio.Event()

        async def run(prompt, task_id):
            await release.wait()
            return prompt[0].content.upper()

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        first = manager.start("one")
        second = manager.start("one")
        self.assertNotEqual(first["task_id"], second["task_id"])
        self.assertEqual(manager.get(first["task_id"])["status"], "running")
        release.set()
        await asyncio.sleep(0)
        result = manager.get(first["task_id"])
        self.assertEqual(result["result"], "ONE")

    async def test_failure_is_queryable(self):
        async def run(prompt, task_id):
            raise ValueError("example failure")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        task_id = manager.start("fail")["task_id"]
        await asyncio.sleep(0)
        self.assertEqual(manager.get(task_id)["status"], "failed")
        self.assertIn("example failure", manager.get(task_id)["error"])

    async def test_cancel_before_start_and_repeat(self):
        async def run(prompt, task_id):
            self.fail("Cancelled before its first execution")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        task_id = manager.start("cancel")["task_id"]
        self.assertEqual((await manager.cancel(task_id))["status"], "cancelled")
        self.assertEqual((await manager.cancel(task_id))["status"], "cancelled")
        self.assertEqual((await manager.cancel("missing"))["status"], "not_found")

    async def test_close_waits_for_running_child_cleanup(self):
        started = asyncio.Event()
        cleaned = asyncio.Event()

        async def run(prompt, task_id):
            try:
                started.set()
                await asyncio.Event().wait()
            finally:
                # 清理可以包含 await，close 必须等它完成。
                await asyncio.sleep(0)
                cleaned.set()

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        task_id = manager.start("wait")["task_id"]
        await asyncio.wait_for(started.wait(), 1)
        await manager.close()
        self.assertTrue(cleaned.is_set())
        self.assertEqual(manager.get(task_id)["status"], "cancelled")
        with self.assertRaises(RuntimeError):
            manager.start("too late")

    async def test_manager_status_and_cancel_tool(self):
        release = asyncio.Event()

        async def run(prompt, task_id):
            await release.wait()
            return "child result"

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        (cancel,) = worker_tools(manager)
        launched = manager.start("work", sender_id="caller")
        task_id = launched["task_id"]
        self.assertEqual(manager.get(task_id)["status"], "running")
        # 启动工具已经返回，子任务仍未结束，模拟父轮次之外的后台进展。
        release.set()
        await asyncio.sleep(0)
        self.assertEqual(manager.get(task_id)["result"], "child result")
        self.assertEqual((await cancel.ainvoke({"task_id": task_id}, config={"configurable": {"thread_id": "caller"}}))["status"], "completed")

    async def test_failed_and_cancelled_threads_restart_only_on_new_message(self):
        calls = []

        async def run(prompt, task_id):
            calls.append((task_id, [m.content for m in prompt]))
            raise ValueError("failure")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("work", "failed")
        await asyncio.sleep(0)
        self.assertEqual(manager.get("failed")["status"], "failed")
        self.assertEqual(manager.start("again", "failed")["status"], "running")
        await manager.wait("failed")
        self.assertEqual(calls[-1], ("failed", ["work", "again"]))
        manager.start("work", "cancelled")
        await manager.cancel("cancelled")
        self.assertEqual(manager.start("again", "cancelled")["status"], "running")
        await manager.wait("cancelled")
        self.assertEqual(calls[-1], ("cancelled", ["work", "again"]))

    async def test_inboxes_are_separate_and_consumed_once(self):
        async def run(prompt, task_id):
            await asyncio.Event().wait()

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("first", "a")
        manager.start("first", "b")
        manager.start("a-1", "a")
        manager.start("b-1", "b")
        manager.start("a-2", "a")
        self.assertEqual([m.content for m in manager.take_messages("a")], ["a-1", "a-2"])
        self.assertEqual(manager.take_messages("a"), [])
        self.assertEqual([m.content for m in manager.take_messages("b")], ["b-1"])

    async def test_agent_injects_after_tool_result_and_keeps_history(self):
        class ToolCallingModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, **kwargs):
                return self

        tool_started = asyncio.Event()
        release_tool = asyncio.Event()
        finished = asyncio.Event()
        invocations = []

        @tool
        async def slow_search() -> str:
            """A controllable offline search for testing."""
            tool_started.set()
            await release_tool.wait()
            return "search result"

        async def run(prompt, task_id):
            invocations.append([m.content for m in prompt])
            try:
                result = await child.ainvoke(
                    {"messages": prompt},
                    config={"configurable": {"thread_id": task_id}},
                    context={"task_id": task_id},
                )
                return result["messages"][-1].text
            finally:
                finished.set()

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        child = create_agent(
            model=ToolCallingModel(responses=[
                AIMessage(content="", tool_calls=[
                    {"name": "slow_search", "args": {}, "id": "call-1", "type": "tool_call"}
                ]),
                AIMessage(content="answer"),
                AIMessage(content="follow-up answer"),
            ]),
            tools=[slow_search],
            middleware=[CommunicationMiddleware(manager)],
            checkpointer=InMemorySaver(),
        )
        manager.start("initial", "child-1")
        await asyncio.wait_for(tool_started.wait(), 2)
        queued = manager.start("Python only", "child-1")
        self.assertTrue(queued["queued"])
        release_tool.set()
        await asyncio.wait_for(finished.wait(), 2)
        self.assertEqual(manager.get("child-1")["result"], "answer")
        self.assertEqual(invocations, [["initial"]])
        state = await child.aget_state({"configurable": {"thread_id": "child-1"}})
        messages = state.values["messages"]
        self.assertIsInstance(messages[2], ToolMessage)
        self.assertEqual(messages[2].tool_call_id, "call-1")
        self.assertIsInstance(messages[3], HumanMessage)
        self.assertEqual(messages[3].content, "Python only")
        self.assertEqual(manager.take_messages("child-1"), [])

        finished.clear()
        manager.start("follow up", "child-1")
        await asyncio.wait_for(finished.wait(), 2)
        state = await child.aget_state({"configurable": {"thread_id": "child-1"}})
        self.assertEqual(
            [m.content for m in state.values["messages"] if isinstance(m, HumanMessage)],
            ["initial", "Python only", "follow up"],
        )

    async def test_leftover_pending_automatically_starts_next_turn(self):
        model_started, release_model = asyncio.Event(), asyncio.Event()
        next_model_started, release_next_model = asyncio.Event(), asyncio.Event()
        seen = []
        batches = []

        class PausedModel(FakeMessagesListChatModel):
            def bind_tools(self, tools, **kwargs):
                return self

            async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
                seen.append([m.content for m in messages if isinstance(m, HumanMessage)])
                if len(seen) == 1:
                    model_started.set()
                    await release_model.wait()
                elif len(seen) == 2:
                    next_model_started.set()
                    await release_next_model.wait()
                return await super()._agenerate(
                    messages, stop=stop, run_manager=run_manager, **kwargs
                )

        async def run(prompts, task_id):
            batches.append([m.content for m in prompts])
            result = await agent.ainvoke(
                {"messages": prompts},
                config={"configurable": {"thread_id": task_id}},
                context={"task_id": task_id},
            )
            return result["messages"][-1].text

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        agent = create_agent(
            model=PausedModel(responses=[
                AIMessage(content="first answer"),
                AIMessage(content="second answer"),
                AIMessage(content="third answer"),
            ]),
            middleware=[CommunicationMiddleware(manager)],
            checkpointer=InMemorySaver(),
        )
        manager.start("你有哪些工具？", "one")
        await asyncio.wait_for(model_started.wait(), 2)
        for text in ("你真厉害", "第二条补充"):
            self.assertTrue(manager.start(text, "one")["queued"])
        task = manager._tasks["one"]
        waiter = asyncio.create_task(manager.wait("one"))

        async def close_waiter():
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)

        self.addAsyncCleanup(close_waiter)
        release_model.set()
        # 不再发送唤醒消息，也应自动开始第二轮；同一个 Task 一直 running。
        await asyncio.wait_for(next_model_started.wait(), 2)
        self.assertIs(manager._tasks["one"], task)
        self.assertEqual(manager.get("one")["status"], "running")
        self.assertFalse(waiter.done())
        self.assertEqual(batches, [["你有哪些工具？"], ["你真厉害", "第二条补充"]])
        self.assertEqual(seen[1], ["你有哪些工具？", "你真厉害", "第二条补充"])

        # 自动续轮期间仍能排队，必要时再自动开启第三轮。
        self.assertTrue(manager.start("你看我夸你了么？", "one")["queued"])
        release_next_model.set()
        status = await asyncio.wait_for(waiter, 2)
        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["result"], "third answer")
        expected = ["你有哪些工具？", "你真厉害", "第二条补充", "你看我夸你了么？"]
        self.assertEqual(batches, [[expected[0]], expected[1:3], [expected[3]]])
        self.assertEqual(seen[2], expected)
        snapshot = await agent.aget_state({"configurable": {"thread_id": "one"}})
        self.assertEqual(
            [m.content for m in snapshot.values["messages"] if isinstance(m, HumanMessage)],
            expected,
        )
        self.assertEqual(manager.take_messages("one"), [])
        manager.start("再问一次", "one")
        # 结束之后的新输入启动新 Task，紧接的补充仍保持顺序且只注入一次。
        self.assertIsNot(manager._tasks["one"], task)
        self.assertTrue(manager.start("刚启动后又补充", "one")["queued"])
        await asyncio.wait_for(manager.wait("one"), 2)
        self.assertEqual(seen[3], [*expected, "再问一次", "刚启动后又补充"])
        self.assertEqual(len(batches), 4)

    async def test_pending_does_not_restart_after_failure_cancel_or_close(self):
        for action, swallow_cancel in (
            ("failure", False), ("cancel", False), ("close", False),
            ("cancel", True), ("close", True),
        ):
            with self.subTest(action=action, swallow_cancel=swallow_cancel):
                entered, release = asyncio.Event(), asyncio.Event()
                calls = []

                async def run(prompts, task_id):
                    calls.append([m.content for m in prompts])
                    entered.set()
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        if swallow_cancel:
                            return "底层吞掉取消"
                        raise
                    raise ValueError("example failure")

                manager = WorkerManager(run)
                self.addAsyncCleanup(manager.close)
                manager.start("initial", "one")
                await asyncio.wait_for(entered.wait(), 2)
                manager.start("pending", "one")
                if action == "failure":
                    release.set()
                elif action == "cancel":
                    await asyncio.wait_for(manager.cancel("one"), 2)
                else:
                    await asyncio.wait_for(manager.close(), 2)
                status = await asyncio.wait_for(manager.wait("one"), 2)
                self.assertEqual(status["status"], "failed" if action == "failure" else "cancelled")
                self.assertEqual(calls, [["initial"]])
                self.assertEqual([m.content for m in manager.take_messages("one")], ["pending"])


class SubtreeCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cascade_crosses_completed_nodes_and_leaves_other_root_running(self):
        entered = {name: asyncio.Event() for name in ("root", "leaf", "other")}
        cleaned = set()

        async def run(prompts, task_id):
            if task_id == "middle":
                return "already finished"
            entered[task_id].set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.add(task_id)

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("root", "root")
        manager.start("middle", "middle", sender_id="root")
        await manager.wait("middle")
        manager.start("leaf", "leaf", sender_id="middle")
        manager.start("other", "other")
        await asyncio.wait_for(
            asyncio.gather(*(event.wait() for event in entered.values())), 2
        )
        result = await manager.cancel("root")
        self.assertEqual(result["stopped"], ["leaf", "middle", "root"])
        self.assertEqual(cleaned, {"root", "leaf"})
        self.assertEqual(manager.get("leaf")["status"], "cancelled")
        self.assertEqual(manager.get("middle")["result"], "already finished")
        self.assertEqual(manager.get("other")["status"], "running")
        await manager.cancel("root")
        self.assertEqual(cleaned, {"root", "leaf"})

    async def test_cleanup_cannot_deliver_or_reawaken_stopped_parent(self):
        for fail_cleanup in (False, True):
            with self.subTest(fail_cleanup=fail_cleanup):
                entered, cleaning, release = (
                    asyncio.Event(), asyncio.Event(), asyncio.Event()
                )
                calls, shown, late = [], [], []

                async def run(prompts, task_id):
                    calls.append(task_id)
                    if task_id != "child":
                        return AgentOutput(messages=[], next="wait")
                    entered.set()
                    try:
                        await asyncio.Event().wait()
                    except asyncio.CancelledError:
                        # 模拟下层吞掉取消后仍走到投递。
                        try:
                            manager.dispatch(AgentOutput(messages=[
                                SendMessage(to="human", task_id=None, message="late output"),
                                SendMessage(to="worker", task_id=None, message="late spawn"),
                                SendMessage(to="worker", task_id="other", message="late mail"),
                            ], next="done"), task_id)
                        except asyncio.CancelledError:
                            late.append("dispatch cancelled")
                        cleaning.set()
                        await release.wait()
                        if fail_cleanup:
                            raise RuntimeError("cleanup failed")
                        return "swallowed cancellation"

                manager = WorkerManager(run, on_human=lambda *args: shown.append(args))
                self.addAsyncCleanup(manager.close)
                self.addCleanup(release.set)
                for task_id in ("root", "other"):
                    manager.start(task_id, task_id)
                    await manager.wait(task_id)
                manager.start("child", "child", sender_id="root")
                await asyncio.wait_for(entered.wait(), 2)
                stopping = asyncio.create_task(manager.cancel("root"))
                await asyncio.wait_for(cleaning.wait(), 2)
                self.assertEqual(late, ["dispatch cancelled"])
                self.assertEqual(shown, [])
                self.assertNotIn("child", manager._feedback)  # 不留下过期回执。
                self.assertEqual(set(manager.snapshot()["tasks"]), {"root", "child", "other"})
                with self.assertRaises(ValueError):
                    manager.start("too early", "root")
                rejected = manager.dispatch(AgentOutput(messages=[
                    SendMessage(to="worker", task_id="root", message="wake up"),
                ], next="done"), "other")
                self.assertFalse(rejected[0]["accepted"])
                release.set()
                await asyncio.wait_for(stopping, 2)
                self.assertEqual(calls, ["root", "other", "child"])
                self.assertEqual(manager.get("root")["status"], "cancelled")
                self.assertEqual(
                    manager.get("child")["status"],
                    "failed" if fail_cleanup else "cancelled",
                )
                self.assertEqual(manager.get("other")["status"], "waiting")
                # 子任务的终态作为反馈保存给已停止的 root，不唤醒它。
                (notice,) = manager._feedback["root"]
                self.assertIn(
                    '"status": "failed"' if fail_cleanup else '"cause": "stopped_with_parent"',
                    notice.content,
                )

    async def test_only_creator_resumes_and_receives_stored_child_state(self):
        received = []

        async def run(prompts, task_id):
            received.append((task_id, [m.content for m in prompts]))
            return AgentOutput(messages=[], next="wait")

        def send(sender, target, text):
            return manager.dispatch(AgentOutput(messages=[
                SendMessage(to="worker", task_id=target, message=text),
            ], next="wait"), sender)[0]

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        for task_id, parent in (
            ("root", None), ("child", "root"), ("leaf", "child"), ("other", None)
        ):
            manager.start("initial", task_id, sender_id=parent)
            await manager.wait(task_id)
        runs_before = len(received)
        await manager.cancel("root")
        await asyncio.sleep(0)
        # 停止反馈只保存，不唤醒任何任务。
        self.assertEqual(len(received), runs_before)

        # 用户不是 child/leaf 的创建者；其他任务也不是。
        for target in ("child", "leaf"):
            with self.assertRaises(ValueError):
                manager.start("user input", target)
        self.assertFalse(send("other", "child", "wake up")["accepted"])
        # 仍停止的创建者不能投递。
        with self.assertRaises(asyncio.CancelledError):
            send("root", "child", "too early")

        manager.start("continue root", "root")
        await manager.wait("root")
        task, prompts = received[-1]
        self.assertEqual((task, prompts[-1]), ("root", "continue root"))
        (notice,) = prompts[:-1]
        self.assertIn('"task_id": "child"', notice)
        self.assertIn('"cause": "stopped_with_parent"', notice)
        self.assertNotIn("cancelled_by", notice)
        self.assertEqual(manager.get("child")["status"], "cancelled")

        # 创建者按新指令恢复子任务；子任务同样先看到自己后代的状态。
        self.assertTrue(send("root", "child", "resume old work")["accepted"])
        await manager.wait("child")
        task, prompts = received[-1]
        self.assertEqual(task, "child")
        self.assertIn('"task_id": "leaf"', prompts[0])
        self.assertIn("resume old work", prompts[-1])
        self.assertEqual(manager.get("leaf")["status"], "cancelled")
        self.assertTrue(send("child", "leaf", "resume leaf")["accepted"])
        await manager.wait("leaf")
        self.assertEqual(received[-1][0], "leaf")
        self.assertEqual(manager.get("leaf")["status"], "waiting")

    async def test_cancel_waiter_and_overlapping_stop_do_not_interrupt_cleanup(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        cleaned = []

        async def run(prompts, task_id):
            if task_id == "root":
                return "finished root"
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await release.wait()
                cleaned.append(task_id)

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        self.addCleanup(release.set)
        manager.start("root", "root")
        await manager.wait("root")
        manager.start("child", "child", sender_id="root")
        await asyncio.wait_for(entered.wait(), 2)
        first = asyncio.create_task(manager.cancel("child", cancelled_by="root"))
        await asyncio.wait_for(cleaning.wait(), 2)
        second = asyncio.create_task(manager.cancel("root"))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(manager.get("child")["status"], "running")
        self.assertFalse(second.done())
        with self.assertRaises(ValueError):
            manager.start("too soon", "root")
        release.set()
        result = await asyncio.wait_for(second, 2)
        self.assertEqual(result["stopped"], ["child", "root"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(cleaned, ["child"])
        manager.start("now continue", "root")
        self.assertEqual((await manager.wait("root"))["result"], "finished root")
        self.assertEqual(manager.get("child")["status"], "cancelled")

    async def test_cannot_cancel_branch_containing_current_execution(self):
        decisions = []

        async def run(prompts, task_id):
            if task_id == "child":
                decisions.append(await manager.cancel("root"))
            return AgentOutput(messages=[], next="wait")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("root", "root")
        await manager.wait("root")
        manager.start("child", "child", sender_id="root")
        await asyncio.wait_for(manager.wait("child"), 2)
        self.assertFalse(decisions[0]["accepted"])
        self.assertEqual(manager.get("root")["status"], "waiting")
        self.assertEqual(manager.get("child")["status"], "waiting")


if __name__ == "__main__":
    unittest.main()
