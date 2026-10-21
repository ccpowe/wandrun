"""ADR-0013：打断目标当前的执行并插入消息。"""

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.scheduler_store import SchedulerStore
from wandrun.runtime.workers import WorkerManager


def contents(prompts):
    return [
        "<interrupted>" if '"interrupted": true' in m.content else m.content
        for m in prompts
    ]


class InterruptTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, run, **kwargs):
        shown = []
        manager = WorkerManager(run, on_human=lambda sender, text, attachments, draft_id: shown.append((sender, text)), **kwargs)
        self.addAsyncCleanup(manager.close)
        return manager, shown

    async def test_interrupt_restarts_only_the_current_round(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = {}

        async def run(prompts, task_id):
            calls.setdefault(task_id, []).append(contents(prompts))
            if task_id == "child":
                await release.wait()
                return AgentOutput(messages=[], next="done")
            if len(calls["root"]) > 1:
                return "resumed"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        manager, shown = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.start("child work", "child", sender_id="root")
        manager.start("queued earlier", "root")

        result = manager.interrupt("new", "root")
        self.assertEqual(result, {
            "task_id": "root", "status": "running", "queued": True, "interrupted": True,
        })
        await asyncio.wait_for(cleaning.wait(), 2)
        # 清理期间：任务仍在继续；来信只排队，子任务的完成通知也不能抢先启动新一轮。
        self.assertEqual(manager.get("root")["status"], "running")
        manager.start("during", "root")
        waiter = asyncio.create_task(manager.wait("root"))
        release.set()
        self.assertEqual((await asyncio.wait_for(waiter, 2))["result"], "resumed")

        # 按到达顺序：打断反馈、在途消息、原有队列、打断消息、清理期间的来信。
        self.assertEqual(calls["root"], [
            ["start"],
            ["<interrupted>", "start", "queued earlier", "new", "during"],
        ])
        self.assertEqual(manager.get("child")["status"], "completed")  # 后代未被取消
        self.assertFalse(any("cancelled" in text for _, text in shown))

    async def test_notification_during_cleanup_joins_the_resumed_round(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            if task_id == "child":
                return AgentOutput(messages=[], next="done")
            calls.append(contents(prompts))
            if len(calls) > 1:
                return "resumed"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        manager, _ = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "root")
        await asyncio.wait_for(cleaning.wait(), 2)
        # 子任务的失败通知会 _enqueue 到 root；root 被打断期间不能由它启动新一轮。
        manager.start("child work", "child", sender_id="root")
        manager._notify_completion("child", "failed", error="boom")
        release.set()
        await asyncio.wait_for(manager.wait("root"), 2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][:3], ["<interrupted>", "start", "new"])
        self.assertIn('"status": "failed"', calls[1][3])

    async def test_message_between_end_and_settlement_does_not_start_a_round(self):
        entered = asyncio.Event()
        calls, launched = [], []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) > 1:
                return "resumed"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # 这个回调排在旧 Task 的 done 回调之前：旧执行已结束、尚未结算。
                asyncio.get_running_loop().call_soon(
                    lambda: launched.append(manager.start("in window", "root"))
                )
                raise

        manager, _ = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "root")
        await asyncio.wait_for(manager.wait("root"), 2)
        self.assertTrue(launched[0]["queued"])
        self.assertEqual(calls, [["start"], ["<interrupted>", "start", "new", "in window"]])

    async def test_wait_follows_into_the_resumed_round(self):
        entered, resumed, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) == 1:
                entered.set()
                await asyncio.Event().wait()
            resumed.set()
            await release.wait()
            return "resumed"

        manager, _ = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        waiter = asyncio.create_task(manager.wait("root"))
        await asyncio.sleep(0)
        manager.interrupt("new", "root")
        await asyncio.wait_for(resumed.wait(), 2)
        await asyncio.sleep(0.01)
        self.assertFalse(waiter.done())
        release.set()
        self.assertEqual((await asyncio.wait_for(waiter, 2))["result"], "resumed")

    async def test_message_is_persisted_before_cleanup(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def run(prompts, task_id):
            if entered.is_set():
                return "resumed"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        with tempfile.TemporaryDirectory() as directory:
            store = SchedulerStore(Path(directory) / "scheduler.sqlite")
            self.addCleanup(store.close)
            manager, _ = self.manager(run, store=store)
            self.addCleanup(release.set)
            manager.start("start", "root")
            await asyncio.wait_for(entered.wait(), 2)
            manager.interrupt("new", "root")
            # 返回时已经提交，旧执行还没有完成清理。
            (snapshot,) = SchedulerStore(Path(directory) / "scheduler.sqlite").load()
            self.assertEqual(snapshot.status, "running")
            self.assertEqual([m.content for m in snapshot.queues["inbox"]], ["new"])
            self.assertEqual(contents(snapshot.queues["feedback"]), ["<interrupted>"])
            self.assertEqual([m.content for m in snapshot.queues["inflight"]], ["start"])
            release.set()
            await asyncio.wait_for(manager.wait("root"), 2)

    async def test_earlier_execution_callback_does_not_consume_the_interrupt(self):
        calls, hooked = [], []

        async def run(prompts, task_id):
            if task_id == "root":
                return AgentOutput(messages=[], next="wait")
            calls.append(contents(prompts))
            if len(calls) == 1:
                # T0 结束时 done 回调排在这个回调之后：在其间启动 T1 并打断它。
                def hook():
                    manager.start("second", "child")
                    hooked.append(manager.interrupt("third", "child"))

                asyncio.get_running_loop().call_soon(hook)
                return AgentOutput(messages=[], next="done")
            return AgentOutput(messages=[], next="done")

        manager, _ = self.manager(run)
        received = []
        manager.start("root", "root")
        await manager.wait("root")
        original = manager._enqueue

        def record(message, task_id):
            if task_id == "root":
                received.append(message.content)
            return original(message, task_id)

        manager._enqueue = record
        manager.start("first", "child", sender_id="root")
        for _ in range(20):
            await asyncio.sleep(0)
        await asyncio.wait_for(manager.wait("child"), 2)
        self.assertTrue(hooked[0]["interrupted"])
        # T1 尚未开始就被取消；续轮 T2 带着它的输入和打断消息。
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0][0].endswith("first"))
        self.assertEqual(calls[1], ["<interrupted>", "second", "third"])
        self.assertEqual(manager.get("child")["status"], "completed")
        self.assertFalse(any("cancelled" in text for text in received))

    async def test_cancel_after_interrupt_keeps_stop_feedback_and_does_not_resume(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            calls.append((task_id, contents(prompts)))
            if task_id != "child":
                return AgentOutput(messages=[], next="wait")
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        manager, _ = self.manager(run)
        manager.start("root", "root")
        await manager.wait("root")
        manager.start("work", "child", sender_id="root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "child")
        await asyncio.wait_for(cleaning.wait(), 2)
        stopping = asyncio.create_task(manager.cancel("root"))
        await asyncio.sleep(0)
        release.set()
        await asyncio.wait_for(stopping, 2)
        self.assertEqual(manager.get("child")["status"], "cancelled")
        self.assertEqual([task for task, _ in calls].count("child"), 1)
        self.assertEqual(manager.snapshot()["queued"], [])  # 停止的任务保留输入，但不算可推进积压
        self.assertIn("new", [m.content for m in manager._inbox["child"]])

        manager.start("continue", "root")
        await manager.wait("root")
        task, prompts = calls[-1]
        self.assertEqual((task, prompts[-1]), ("root", "continue"))
        self.assertIn('"cause": "stopped_with_parent"', prompts[0])

    async def test_creator_cancelling_interrupted_child_gets_no_duplicate_notice(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            calls.append(task_id)
            if task_id != "child":
                return AgentOutput(messages=[], next="wait")
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        manager, _ = self.manager(run)
        manager.start("root", "root")
        await manager.wait("root")
        manager.start("work", "child", sender_id="root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "child")
        await asyncio.wait_for(cleaning.wait(), 2)
        stopping = asyncio.create_task(manager.cancel("child", cancelled_by="root"))
        await asyncio.sleep(0)
        release.set()
        result = await asyncio.wait_for(stopping, 2)
        self.assertEqual(result["status"], "cancelled")
        self.assertNotIn("root", manager._inbox)
        self.assertNotIn("root", manager._feedback)
        self.assertEqual(calls, ["root", "child"])

    async def test_cancel_between_end_and_settlement_waits_for_settlement(self):
        entered = asyncio.Event()
        calls, stopping = [], []

        async def run(prompts, task_id):
            calls.append(task_id)
            if task_id != "child":
                return AgentOutput(messages=[], next="wait")
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # 排在旧 Task 的 done 回调之前：执行已结束、打断尚未结算时，创建者取消它。
                # eager_start 让 cancel 的同步部分就在这个窗口内执行。
                loop = asyncio.get_running_loop()
                loop.call_soon(lambda: stopping.append(asyncio.Task(
                    manager.cancel("child", cancelled_by="root"), loop=loop, eager_start=True
                )))
                raise

        manager, _ = self.manager(run)
        manager.start("root", "root")
        await manager.wait("root")
        manager.start("work", "child", sender_id="root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "child")
        for _ in range(100):
            if stopping:
                break
            await asyncio.sleep(0)
        result = await asyncio.wait_for(stopping[0], 2)
        self.assertEqual(result["status"], "cancelled")
        for _ in range(5):
            await asyncio.sleep(0)
        self.assertNotIn("root", manager._inbox)
        self.assertNotIn("root", manager._feedback)
        self.assertEqual(calls, ["root", "child"])

    async def test_wait_between_end_and_settlement_follows_the_resumed_round(self):
        entered = asyncio.Event()
        calls, waiting = [], []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) > 1:
                await asyncio.sleep(0.01)
                return "resumed"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                loop = asyncio.get_running_loop()
                loop.call_soon(lambda: waiting.append(asyncio.Task(
                    manager.wait("root"), loop=loop, eager_start=True
                )))
                raise

        manager, _ = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "root")
        for _ in range(100):
            if waiting:
                break
            await asyncio.sleep(0)
        self.assertEqual((await asyncio.wait_for(waiting[0], 2))["result"], "resumed")

    async def test_cleanup_failure_is_reported_and_not_resumed(self):
        entered = asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) > 1:
                return "rerun"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                raise RuntimeError("cleanup failed")

        manager, shown = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "root")
        status = await asyncio.wait_for(manager.wait("root"), 2)
        self.assertEqual(status["status"], "failed")
        self.assertIn("cleanup failed", status["error"])
        self.assertEqual(len(calls), 1)
        self.assertTrue(any('"status": "failed"' in text for _, text in shown))
        # 输入保留，下一条消息照常重新运行。
        manager.start("again", "root")
        await manager.wait("root")
        self.assertEqual(calls[-1], ["<interrupted>", "start", "new", "again"])

    async def test_swallowed_cancellation_cannot_deliver_or_take_new_messages(self):
        entered = asyncio.Event()
        calls, late = [], []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) > 1:
                return "resumed"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                pass  # 模拟下层吞掉取消后继续运行
            for attempt in (
                lambda: manager.dispatch(AgentOutput(messages=[
                    SendMessage(to="human", task_id=None, message="late output"),
                ], next="done"), task_id),
                lambda: manager.take_messages(task_id),
            ):
                try:
                    attempt()
                except asyncio.CancelledError:
                    late.append("cancelled")
            return "swallowed"

        manager, shown = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "root")
        status = await asyncio.wait_for(manager.wait("root"), 2)
        self.assertEqual(late, ["cancelled", "cancelled"])
        self.assertEqual(shown, [])
        self.assertNotIn("root", manager._feedback)  # 没有留下回执
        self.assertEqual(status["result"], "resumed")
        self.assertEqual(calls[1], ["<interrupted>", "start", "new"])

    async def test_finishing_or_idle_target_is_started_normally(self):
        release = asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) == 1:
                manager.finish_model_loop(task_id)
                await release.wait()
            return "|".join(contents(prompts))

        manager, _ = self.manager(run)
        manager.start("start", "root")
        await asyncio.sleep(0)
        finishing = manager.interrupt("during finishing", "root")
        self.assertEqual(
            (finishing["queued"], finishing["interrupted"]), (True, False)
        )
        release.set()
        await manager.wait("root")
        self.assertEqual(calls, [["start"], ["during finishing"]])
        self.assertEqual(manager.get("root")["result"], "during finishing")

        idle = manager.interrupt("idle", "root")
        self.assertEqual((idle["status"], idle["interrupted"]), ("running", False))
        await manager.wait("root")
        self.assertEqual(calls[-1], ["idle"])

    async def test_repeated_interrupt_cancels_once_and_keeps_order(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls, cancels = [], []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) > 1:
                return "resumed"
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancels.append(1)
                cleaning.set()
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    cancels.append(2)
                raise asyncio.CancelledError()

        manager, _ = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("first", "root")
        await asyncio.wait_for(cleaning.wait(), 2)
        self.assertTrue(manager.interrupt("second", "root")["interrupted"])
        release.set()
        await asyncio.wait_for(manager.wait("root"), 2)
        self.assertEqual(cancels, [1])
        self.assertEqual(calls[1], ["<interrupted>", "start", "first", "second"])

    async def test_close_during_cleanup_does_not_resume(self):
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        manager, shown = self.manager(run)
        manager.start("start", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "root")
        await asyncio.wait_for(cleaning.wait(), 2)
        closing = asyncio.create_task(manager.close())
        await asyncio.sleep(0)
        release.set()
        await asyncio.wait_for(closing, 2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(shown, [])
        self.assertEqual(manager.get("root")["status"], "cancelled")

    async def test_terminal_interrupt_reports_the_resumed_round(self):
        from wandrun.terminal.chat import TerminalOutput, chat

        entered = asyncio.Event()
        completed = asyncio.Event()
        calls, outputs = [], []

        async def run(prompts, task_id):
            calls.append(contents(prompts))
            if len(calls) == 1:
                entered.set()
                await asyncio.Event().wait()
            return "done"

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        lines = asyncio.Queue()
        lines.put_nowait("initial")

        def output(*parts, **kwargs):
            text = " ".join(map(str, parts))
            outputs.append(text)
            if "[completed]" in text:
                completed.set()

        with patch("wandrun.terminal.chat.read_line", side_effect=lines.get), patch(
            "builtins.print", side_effect=output
        ):
            terminal = asyncio.create_task(chat(manager, "one", output=TerminalOutput()))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                lines.put_nowait("/interrupt")
                lines.put_nowait("/interrupt change direction")
                await asyncio.wait_for(completed.wait(), 2)
                lines.put_nowait("/exit")
                await asyncio.wait_for(terminal, 2)
            finally:
                terminal.cancel()
                await asyncio.gather(terminal, return_exceptions=True)
        self.assertEqual(calls, [["initial"], ["<interrupted>", "initial", "change direction"]])
        self.assertIn("用法：/interrupt <消息>", outputs)
        self.assertTrue(any("[interrupted]" in text for text in outputs))
        self.assertFalse(any("[cancelled]" in text for text in outputs))
        self.assertEqual(sum("[completed]" in text for text in outputs), 1)


if __name__ == "__main__":
    unittest.main()
