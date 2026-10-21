"""ADR-0008：调度状态的持久化、重启恢复、提交边界与失败收尾。

进程内的“崩溃”用 close() 模拟：close 一开始就冻结存储，恢复方式与崩溃相同。
事务内部分写入、提交后入口未返回这两类中断用独立子进程验证。
"""

from collections import defaultdict
import asyncio
import json
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from unittest.mock import patch

from deepagents.backends import LocalShellBackend
from langchain.agents.middleware import hook_config
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.config import AgentDefinition
from wandrun.runtime.agents import build_agents, run_conversation
from wandrun.runtime.conversations import conversation_config, prepare_conversation_input
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime import scheduler_store
from wandrun.runtime.scheduler_store import SchedulerStore, TaskSnapshot, paired_store_path
from wandrun.runtime.workers import CommunicationMiddleware, SchedulerFailure, WorkerManager
from wandrun.runtime.environments import Environment


def send(manager, sender, target, text, to="worker"):
    return manager.dispatch(
        AgentOutput(messages=[SendMessage(to=to, task_id=target, message=text)], next="wait"),
        sender,
    )[0]


def stop_notices(messages):
    return [m for m in messages if "stopped_with_parent" in m.content]


class ArmedStore(SchedulerStore):
    """被 arm 后，第 fail_on 次 save 调用抛出提交错误。"""

    def __init__(self, path):
        super().__init__(path)
        self.fail_on = None
        self.statuses = []

    def arm(self, fail_on=1):
        self.fail_on = fail_on

    def save(self, snapshots):
        snapshots = list(snapshots)
        self.statuses.append({s.task_id: s.status for s in snapshots})
        if self.fail_on is not None:
            self.fail_on -= 1
            if self.fail_on == 0:
                raise sqlite3.OperationalError("injected commit failure")
        super().save(snapshots)


class StoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "scheduler.sqlite"

    def test_round_trip_keeps_order_ids_and_metadata(self):
        messages = [
            HumanMessage(content=f"m{index}", id=f"id-{index}", additional_kwargs={"source": "worker", "n": index})
            for index in range(4)
        ]
        snapshot = TaskSnapshot(
            task_id="child", agent="executor", caller="root", stopped=True,
            status="failed", error="ValueError: x",
            queues={"feedback": (messages[3],), "inbox": (messages[1], messages[0]), "inflight": (messages[2],)},
        )
        store = SchedulerStore(self.path)
        store.save([snapshot])
        store.close()
        reopened = SchedulerStore(self.path)
        self.addCleanup(reopened.close)
        (loaded,) = reopened.load()
        self.assertEqual(loaded.fingerprint(), snapshot.fingerprint())
        self.assertEqual(
            [m.additional_kwargs for m in loaded.queues["inbox"]],
            [{"source": "worker", "n": 1}, {"source": "worker", "n": 0}],
        )
        self.assertEqual(loaded.queues["feedback"][0].content, "m3")

    def test_failed_schema_creation_leaves_no_partial_tables(self):
        broken = scheduler_store._SCHEMA.replace("COMMIT;", "CREATE TABLE broken(;\nCOMMIT;")
        with patch.object(scheduler_store, "_SCHEMA", broken):
            with self.assertRaises(sqlite3.OperationalError):
                SchedulerStore(self.path)
        store = SchedulerStore(self.path)  # 不会因为残留的 tasks 表而失败
        self.addCleanup(store.close)
        self.assertEqual(store.load(), [])

    def test_each_checkpoint_gets_its_own_store(self):
        paths = [paired_store_path(Path(f"/state/{name}")) for name in ("a.sqlite", "b.sqlite", "a.db")]
        self.assertEqual(len(set(paths)), 3)  # 同 stem、不同扩展名也不碰撞
        self.assertEqual(
            paired_store_path(Path("/state/checkpoints.sqlite")),
            Path("/state/checkpoints.sqlite.scheduler.sqlite"),
        )

    def test_incompatible_schema_version_is_rejected(self):
        SchedulerStore(self.path).close()
        with sqlite3.connect(self.path) as connection:
            connection.execute("PRAGMA user_version = 99")
        with self.assertRaises(RuntimeError):
            SchedulerStore(self.path)


class RestartTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "scheduler.sqlite"
        self.calls = []

    async def run_worker(self, prompts, task_id):
        """根任务（root、new-root）完成一轮后等待；其他任务一直运行，直到被取消。"""
        self.calls.append((task_id, [(m.id, m.content) for m in prompts]))
        if task_id in {"root", "new-root"}:
            return AgentOutput(messages=[], next=self.root_next)
        await asyncio.Event().wait()

    root_next = "wait"

    def open(self, **kwargs):
        store = SchedulerStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(self.run_worker, store=store, **kwargs)
        self.addAsyncCleanup(manager.close)
        return manager

    async def start_tree(self):
        """root 委派 child，child 再委派 leaf；child、leaf 都在运行。"""
        manager = self.open()
        manager.start("goal", "root")
        await manager.wait("root")
        child = send(manager, "root", None, "child work")["task_id"]
        leaf = send(manager, child, None, "leaf work")["task_id"]
        await asyncio.sleep(0)
        self.assertEqual(manager.get(leaf)["status"], "running")
        return manager, child, leaf

    async def test_restart_restores_relations_stops_tree_and_resumes_by_creator(self):
        manager, child, leaf = await self.start_tree()
        await manager.close()  # 冻结存储，等同于崩溃
        self.calls.clear()

        restarted = self.open()
        await asyncio.sleep(0)
        self.assertEqual(self.calls, [], "重启后不应自动运行任何任务")
        self.assertEqual(restarted._callers[leaf], child)
        self.assertEqual(restarted.agent_name(child), "worker")
        for task_id in ("root", child, leaf):
            self.assertEqual(restarted.get(task_id)["status"], "cancelled")
        # 用户不是 child 的创建者；根任务由用户恢复。
        with self.assertRaises(ValueError):
            restarted.start("user input", child)
        restarted.start("继续", "root")
        await restarted.wait("root")
        task, prompts = self.calls[-1]
        self.assertEqual((task, prompts[-1][1]), ("root", "继续"))
        (notice,) = [content for _, content in prompts if "stopped_with_parent" in content]
        self.assertIn(child, notice)
        self.assertNotIn(leaf, notice)  # 孙任务的状态只交给 child

        # root 恢复 child：child 收到重启前领取但未确认的委派、leaf 的状态和新指令。
        self.assertTrue(send(restarted, "root", child, "resume")["accepted"])
        await asyncio.sleep(0)
        task, prompts = self.calls[-1]
        self.assertEqual(task, child)
        contents = [content for _, content in prompts]
        self.assertTrue(any("child work" in content for content in contents))
        self.assertTrue(any(leaf in content and "stopped_with_parent" in content for content in contents))
        self.assertIn("resume", contents[-1])

        # 级联取消仍能沿恢复的创建关系找到后代。
        result = await restarted.cancel("root")
        self.assertEqual(result["stopped"], sorted(["root", child, leaf]))

    async def test_restored_inflight_keeps_message_ids(self):
        manager, child, _ = await self.start_tree()
        (first_ids,) = [[i for i, _ in prompts] for task, prompts in self.calls if task == child]
        await manager.close()
        restarted = self.open()
        restarted.start("继续", "root")
        await restarted.wait("root")
        send(restarted, "root", child, "resume")
        await asyncio.sleep(0)
        _, prompts = self.calls[-1]
        resent = [i for i, _ in prompts]
        # 重启前已交给图的消息按原 ID 再次交付（排在保存的反馈之后、新指令之前），
        # 由检查点按 ID 去重，不重复写入历史。
        positions = [resent.index(i) for i in first_ids]
        self.assertEqual(positions, sorted(positions))
        self.assertLess(positions[-1], len(resent) - 1)

    async def test_recovery_is_idempotent(self):
        manager, child, _ = await self.start_tree()
        await manager.close()
        await self.open().close()
        again = self.open()
        self.assertEqual(len(stop_notices(again._feedback["root"])), 1)
        self.assertEqual(len(stop_notices(again._feedback[child])), 1)

    async def test_completed_root_with_running_descendant_is_stopped(self):
        self.root_next = "done"
        manager, child, leaf = await self.start_tree()
        self.assertEqual(manager.get("root")["status"], "completed")
        await manager.close()
        restarted = self.open()
        self.assertEqual(restarted.get("root")["status"], "completed")
        self.assertIn("root", restarted._stopped)
        self.assertEqual(restarted.get(leaf)["status"], "cancelled")
        self.assertEqual(len(stop_notices(restarted._feedback["root"])), 1)
        self.assertEqual(len(stop_notices(restarted._feedback[child])), 1)

    async def test_stopping_waiting_task_before_its_callback_settles_it_once(self):
        """child 已返回 wait、done 回调尚未执行时 cancel(root)，随后在回调提交前崩溃。"""
        returned = asyncio.Event()

        async def run(prompts, task_id):
            if task_id == "child":
                returned.set()  # 唤醒下面的 stopper，它排在 child 的 done 回调之前
            return AgentOutput(messages=[], next="wait")

        store = SchedulerStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(run, store=store)
        manager.start("goal", "root")
        await manager.wait("root")

        async def stopper():
            await returned.wait()
            self.assertTrue(manager._tasks["child"].done())
            self.assertIn(manager._tasks["child"], manager._unsettled)
            await manager.cancel("root")
            await manager.close()  # 冻结存储：child 的 done 回调不会再提交

        stopping = asyncio.create_task(stopper())
        manager.start("work", "child", sender_id="root")
        await stopping
        store.close()

        restarted = self.open()
        self.assertEqual(len(stop_notices(restarted._feedback["root"])), 1)
        self.assertEqual(restarted.get("child")["status"], "cancelled")

    async def test_restored_task_rerun_and_stopped_before_callback_settles_once(self):
        """重启恢复后再次执行的任务，返回 wait、回调尚未执行时被停止，随后崩溃。"""
        returned = asyncio.Event()
        runs = []

        async def run(prompts, task_id):
            runs.append(task_id)
            if task_id == "root":
                return AgentOutput(messages=[], next="wait")
            if runs.count(task_id) == 1:
                await asyncio.Event().wait()  # 首次执行：一直运行到进程“崩溃”
            returned.set()
            return AgentOutput(messages=[], next="wait")

        def open_manager():
            store = SchedulerStore(self.path)
            self.addCleanup(store.close)
            manager = WorkerManager(run, store=store)
            self.addAsyncCleanup(manager.close)
            return manager

        first = open_manager()
        first.start("goal", "root")
        await first.wait("root")
        child = send(first, "root", None, "work")["task_id"]
        await asyncio.sleep(0)
        await first.close()

        second = open_manager()
        second.start("继续", "root")
        await second.wait("root")

        async def stopper():
            await returned.wait()
            self.assertIn(second._tasks[child], second._unsettled)
            await second.cancel("root")
            await second.close()

        stopping = asyncio.create_task(stopper())
        self.assertTrue(send(second, "root", child, "resume")["accepted"])
        await stopping

        third = open_manager()
        # 第一次重启的反馈已在 root 恢复时交付；这里只应有第二次停止留下的一条。
        self.assertEqual(len(stop_notices(third._feedback["root"])), 1)

    def persisted_deliveries(self):
        restarted = self.open()
        (receipt_message,) = [
            m for m in restarted._feedback["root"] if '"deliveries"' in m.content
        ]
        children = [t for t in restarted._callers if t != "root"]
        return children, json.loads(receipt_message.content.split("\n", 1)[1])["deliveries"]

    async def test_human_display_error_is_unknown_and_batch_continues(self):
        shown = []

        def on_human(sender, text, attachments, draft_id):
            shown.append(text)
            raise ValueError("display broke after showing")  # 异常类型不代表参数被拒绝

        store = SchedulerStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(self.run_worker, store=store, on_human=on_human)
        manager.start("goal", "root")
        await manager.wait("root")
        receipts = manager.dispatch(AgentOutput(messages=[
            SendMessage(to="worker", task_id=None, message="first"),
            SendMessage(to="human", task_id=None, message="second"),
            SendMessage(to="worker", task_id=None, message="third"),
        ], next="wait"), "root")
        self.assertEqual(shown, ["second"])
        self.assertEqual([r["accepted"] for r in receipts], [True, None, True])
        await manager.close()
        store.close()

        children, deliveries = self.persisted_deliveries()
        self.assertEqual(len(children), 2)
        self.assertEqual([d["accepted"] for d in deliveries], [True, None, True])
        self.assertIn("可能已经显示", deliveries[1]["error"])

    async def test_unexpected_delivery_error_interrupts_and_still_records_every_message(self):
        store = SchedulerStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(self.run_worker, store=store)
        manager.start("goal", "root")
        await manager.wait("root")
        original, calls = manager.start, []

        def flaky_start(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                raise RuntimeError("unexpected")
            return original(*args, **kwargs)

        manager.start = flaky_start
        with self.assertRaises(RuntimeError):
            manager.dispatch(AgentOutput(messages=[
                SendMessage(to="worker", task_id=None, message=text)
                for text in ("first", "second", "third")
            ], next="wait"), "root")
        await manager.close()
        store.close()

        children, deliveries = self.persisted_deliveries()
        self.assertEqual(len(children), 1)  # 只有 first 被接收
        # first 已接收；second 的投递调用异常，结果未知；third 未处理。
        self.assertEqual([d["accepted"] for d in deliveries], [True, None, False])
        self.assertEqual(deliveries[0]["task_id"], children[0])
        self.assertIn("结果未知", deliveries[1]["error"])
        self.assertIn("未处理", deliveries[2]["error"])

    async def test_stopped_backlog_is_not_reported_as_current_work(self):
        manager, child, _ = await self.start_tree()
        await manager.close()
        restarted = self.open()
        self.assertTrue(restarted._inflight[child])  # 旧输入仍然保留
        restarted.start("new goal", "new-root")
        await restarted.wait("new-root")
        snapshot = restarted.snapshot()
        self.assertEqual(snapshot["running"], [])
        self.assertEqual((snapshot["queued"], snapshot["inflight"]), ([], []))

    async def test_removed_role_is_rejected_instead_of_rebound(self):
        roles = {"planner": ("executor",), "executor": ()}
        store = SchedulerStore(self.path)
        manager = WorkerManager(self.run_worker, store=store, agent_workers=roles, default_agent="planner")
        manager.start("goal", "root")
        await manager.wait("root")
        child = send(manager, "root", None, "work", to="executor")["task_id"]
        await asyncio.sleep(0)
        await manager.close()
        store.close()
        restarted = self.open(agent_workers={"planner": ()}, default_agent="planner")
        restarted.start("继续", "root")
        await restarted.wait("root")
        receipt = send(restarted, "root", child, "resume", to="executor")
        self.assertFalse(receipt["accepted"])
        self.assertIn("未知 Agent", receipt["error"])
        self.assertEqual(restarted.agent_name(child), "executor")


class CommitFailureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "scheduler.sqlite"
        self.calls = []
        self.loop_errors = []
        loop = asyncio.get_running_loop()
        previous = loop.get_exception_handler()
        loop.set_exception_handler(lambda _, context: self.loop_errors.append(context))
        self.addCleanup(loop.set_exception_handler, previous)

    async def test_failed_commit_in_entry_cancels_new_and_running_workers(self):
        async def run(prompts, task_id):
            self.calls.append(task_id)
            await asyncio.Event().wait()

        store = ArmedStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(run, store=store)
        manager.start("other", "other")
        await asyncio.sleep(0)
        store.arm()
        with self.assertRaises(SchedulerFailure) as raised:
            manager.start("new", "new")
        self.assertIsInstance(raised.exception.__cause__, sqlite3.OperationalError)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(self.calls, ["other"], "提交失败时刚创建的 Task 不应执行")
        self.assertEqual(manager.get("other")["status"], "cancelled")
        self.assertIn("injected", manager.snapshot()["failure"])
        with self.assertRaises(RuntimeError):
            manager.start("later", "later")
        with self.assertRaises(RuntimeError):
            await manager.close()
        reopened = SchedulerStore(self.path)
        self.addCleanup(reopened.close)
        self.assertEqual({s.task_id for s in reopened.load()}, {"other"})

    async def test_failed_manager_rejects_all_dispatch_including_human(self):
        async def run(prompts, task_id):
            return AgentOutput(messages=[], next="wait")

        shown = []
        store = ArmedStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(run, store=store, on_human=lambda *args: shown.append(args))
        manager.start("goal", "a")
        await manager.wait("a")
        store.arm()
        with self.assertRaises(SchedulerFailure):
            manager.start("x", "b")
        with self.assertRaises(SchedulerFailure):
            manager.start("later", "c")
        # 模拟吞掉取消后仍走到投递：不调用输出接收方，也不留下回执。
        with self.assertRaises(asyncio.CancelledError):
            manager.dispatch(AgentOutput(
                messages=[SendMessage(to="human", task_id=None, message="late")], next="done",
            ), "a")
        self.assertEqual(shown, [])
        self.assertEqual(manager._feedback.get("a", []), [])
        with self.assertRaises(SchedulerFailure):
            await manager.close()

    async def test_failed_commit_in_done_callback_is_contained_and_reported(self):
        release = asyncio.Event()

        async def run(prompts, task_id):
            if task_id == "a":
                await release.wait()
                raise ValueError("boom")  # 直接失败，唯一的提交发生在 done 回调中
            await asyncio.Event().wait()

        store = ArmedStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(run, store=store)
        manager.start("a", "a")
        manager.start("b", "b")
        await asyncio.sleep(0)
        store.arm()
        release.set()
        for _ in range(3):
            await asyncio.sleep(0)
        self.assertIsNotNone(manager.snapshot()["failure"])
        self.assertEqual(manager.get("b")["status"], "cancelled")
        self.assertEqual(self.loop_errors, [], "存储失败不应泄漏到事件循环的异常处理器")
        with self.assertRaises(RuntimeError):
            await manager.close()


    async def test_failed_recovery_commit_raises_scheduler_failure(self):
        store = SchedulerStore(self.path)
        store.save([TaskSnapshot(
            task_id="root", agent="worker", caller=None, stopped=False,
            status="running", error=None, queues={},
        )])
        store.close()
        failing = ArmedStore(self.path)
        self.addCleanup(failing.close)
        failing.arm()

        async def run(prompts, task_id):
            raise AssertionError("不应运行")

        with self.assertRaises(SchedulerFailure):
            WorkerManager(run, store=failing)

    async def test_background_failure_is_reported_by_terminal_immediately(self):
        from wandrun.terminal.chat import TerminalOutput, chat

        release = asyncio.Event()

        async def run(prompts, task_id):
            if task_id == "bg":
                await release.wait()
                raise ValueError("boom")  # 唯一的提交发生在 done 回调中
            return AgentOutput(messages=[], next="wait")

        store = ArmedStore(self.path)
        self.addCleanup(store.close)
        manager = WorkerManager(run, store=store)
        manager.start("bg", "bg")
        printed = []
        lines = iter(["/exit"])

        async def read_line():
            store.arm()
            release.set()
            for _ in range(20):
                if any("[failed]" in text for text in printed):
                    break
                await asyncio.sleep(0)
            return next(lines)

        with patch("wandrun.terminal.chat.read_line", side_effect=read_line), patch(
            "builtins.print", side_effect=lambda *a, **k: printed.append(" ".join(map(str, a)))
        ):
            await chat(manager, "root", output=TerminalOutput())
        self.assertTrue(any("[failed]" in text and "injected" in text for text in printed))
        with self.assertRaises(SchedulerFailure):
            await manager.close()


class StaleCallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_stale_done_callback_does_not_overwrite_new_run(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        runs = []

        async def run(prompts, task_id):
            runs.append((task_id, [m.content for m in prompts]))
            if task_id == "root":
                return AgentOutput(messages=[], next="wait")
            if sum(1 for t, _ in runs if t == task_id) == 1:
                # 在旧 Task 结束、它的 done 回调执行之前，同一 task_id 收到新输入。
                asyncio.get_running_loop().call_soon(manager.start, "again", task_id)
                raise ValueError("old boom")
            await asyncio.Event().wait()

        store = ArmedStore(Path(directory.name) / "scheduler.sqlite")
        self.addCleanup(store.close)
        manager = WorkerManager(run, store=store)
        self.addAsyncCleanup(manager.close)
        manager.start("goal", "root")
        await manager.wait("root")
        child = send(manager, "root", None, "work")["task_id"]
        for _ in range(10):
            await asyncio.sleep(0)
        self.assertEqual(manager.get(child)["status"], "running")
        child_statuses = [s[child] for s in store.statuses if child in s]
        self.assertNotIn("failed", child_statuses, "旧执行的结果不应覆盖新一轮")
        # 旧执行的失败仍通知创建者。
        self.assertTrue(any(
            task == "root" and any("old boom" in content for content in prompts)
            for task, prompts in runs
        ))


CRASH_SCRIPT = textwrap.dedent('''
    import asyncio, os, sys
    from pathlib import Path
    from wandrun.runtime.messages import AgentOutput, SendMessage
    from wandrun.runtime.scheduler_store import SchedulerStore
    from wandrun.runtime.workers import WorkerManager

    path, mode = Path(sys.argv[1]), sys.argv[2]

    class CrashingStore(SchedulerStore):
        armed = False

        def _write(self, snapshot):
            super()._write(snapshot)
            if self.armed and mode == "partial":
                os._exit(0)  # 事务中已写入部分任务，尚未提交

        def save(self, snapshots):
            super().save(snapshots)
            if self.armed and mode == "committed":
                os._exit(0)  # 已提交，dispatch 尚未返回

    async def main():
        async def run(prompts, task_id):
            if task_id == "root":
                return AgentOutput(messages=[], next="wait")
            await asyncio.Event().wait()

        store = CrashingStore(path)
        manager = WorkerManager(run, store=store)
        manager.start("goal", "root")
        await manager.wait("root")
        store.armed = True
        manager.dispatch(AgentOutput(
            messages=[SendMessage(to="worker", task_id=None, message="child work")],
            next="wait",
        ), "root")
        os._exit(3)  # 不应到达

    asyncio.run(main())
''')


RECOVERY_CRASH_SCRIPT = textwrap.dedent('''
    import os, sys
    from pathlib import Path
    from wandrun.runtime.scheduler_store import SchedulerStore
    from wandrun.runtime.workers import WorkerManager

    class CrashingStore(SchedulerStore):
        def _write(self, snapshot):
            super()._write(snapshot)
            os._exit(0)  # 恢复事务中已写入一个任务，尚未提交

    async def run(prompts, task_id):
        raise AssertionError("恢复不应运行任务")

    WorkerManager(run, store=CrashingStore(Path(sys.argv[1])))
    os._exit(3)  # 不应到达
''')


class CrashBoundaryTests(unittest.TestCase):
    """委派是一次逻辑转换：子任务身份、首条输入、发送方回执要么都在，要么都不在。"""

    def crash(self, mode):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "scheduler.sqlite"
        result = subprocess.run(
            [sys.executable, "-c", CRASH_SCRIPT, str(path), mode],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return path

    def test_crash_during_recovery_is_recovered_once(self):
        path = self.crash("committed")  # 留下一棵未恢复过的树：root 与运行中的 child
        result = subprocess.run(
            [sys.executable, "-c", RECOVERY_CRASH_SCRIPT, str(path)],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        store = SchedulerStore(path)
        self.addCleanup(store.close)

        async def run(prompts, task_id):
            return AgentOutput(messages=[], next="wait")

        manager = WorkerManager(run, store=store)
        (child,) = [t for t in manager._callers if t != "root"]
        self.assertEqual(manager.get(child)["status"], "cancelled")
        self.assertEqual(len(stop_notices(manager._feedback["root"])), 1)
        store.close()
        again = WorkerManager(run, store=SchedulerStore(path))
        self.assertEqual(len(stop_notices(again._feedback["root"])), 1)
        again._store.close()

    def test_partial_transaction_leaves_previous_state(self):
        path = self.crash("partial")
        store = SchedulerStore(path)
        self.addCleanup(store.close)
        snapshots = {s.task_id: s for s in store.load()}
        self.assertEqual(set(snapshots), {"root"})
        self.assertEqual(snapshots["root"].status, "waiting")
        self.assertEqual(snapshots["root"].queues["feedback"], ())

    def test_committed_but_unreturned_delegation_is_recovered(self):
        path = self.crash("committed")
        store = SchedulerStore(path)
        self.addCleanup(store.close)

        async def run(prompts, task_id):
            return AgentOutput(messages=[], next="wait")

        # 恢复不创建 Task，无需事件循环。
        manager = WorkerManager(run, store=store)
        (child,) = [t for t in manager._callers if t != "root"]
        self.assertEqual(manager._callers[child], "root")
        self.assertEqual(manager.get(child)["status"], "cancelled")
        self.assertIn("child work", manager._inflight[child][0].content)
        feedback = [m.content for m in manager._feedback["root"]]
        self.assertTrue(any('"deliveries"' in content for content in feedback))
        self.assertEqual(len(stop_notices(manager._feedback["root"])), 1)


GRAPH_CRASH_SCRIPT = textwrap.dedent('''
    """用真实角色图（假模型）+ SQLite 检查点 + 调度存储运行 root 的第一次响应，在指定位置崩溃。

    send_intent       委派；model 节点已提交，after_model 投递之前退出
    send_intent_tool  同上，但响应同时带工具调用
    dispatched        委派；dispatch 已提交，after_model 节点的检查点保存之前退出
    confirm           不发消息；图已返回，确认 inflight 的事务提交之前退出
    """
    import asyncio, os, sys
    from collections import defaultdict
    from pathlib import Path
    from deepagents.backends import LocalShellBackend
    from langchain.messages import AIMessage
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
    from wandrun.config import AgentDefinition
    from wandrun.runtime import workers
    from wandrun.runtime.agents import build_agents, run_conversation
    from wandrun.runtime.environments import Environment
    from wandrun.runtime.messages import AgentOutput, SendMessage
    from wandrun.runtime.scheduler_store import SchedulerStore

    state, mode = Path(sys.argv[1]), sys.argv[2]

    class Model(FakeMessagesListChatModel):
        def bind_tools(self, tools, **kwargs):
            return self.bind(**kwargs)

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            result = AgentOutput(
                messages=[] if mode == "confirm"
                else [SendMessage(to="executor", task_id=None, message="delegated work")],
                next="wait",
            )
            calls = [{"name": "ls", "args": {"path": "/"}, "id": "call-1", "type": "tool_call"}]
            return ChatResult(generations=[ChatGeneration(message=AIMessage(
                content=result.model_dump_json(),
                additional_kwargs={"wandrun_agent_output": result.model_dump()},
                tool_calls=calls if mode == "send_intent_tool" else [],
            ))])

    original = workers.CommunicationMiddleware.aafter_model

    async def crash_before_dispatch(self, state, runtime):
        os._exit(0)

    async def crash_after_dispatch(self, state, runtime):
        await original(self, state, runtime)
        os._exit(0)

    class ConfirmCrashStore(SchedulerStore):
        def save(self, snapshots):
            snapshots = list(snapshots)
            root = next((s for s in snapshots if s.task_id == "root"), None)
            if root is not None and root.status == "running" and not root.queues["inflight"]:
                os._exit(0)
            super().save(snapshots)

    if mode in {"send_intent", "send_intent_tool"}:
        workers.CommunicationMiddleware.aafter_model = crash_before_dispatch
    elif mode == "dispatched":
        workers.CommunicationMiddleware.aafter_model = crash_after_dispatch
    Store = ConfirmCrashStore if mode == "confirm" else SchedulerStore

    async def main():
        async with AsyncSqliteSaver.from_conn_string(str(state / "checkpoints.sqlite")) as saver:
            async def run(prompts, task_id):
                name = manager.agent_name(task_id)
                return await run_conversation(agents[name].graph, prompts, task_id, name)

            manager = workers.WorkerManager(
                run, store=Store(state / "scheduler.sqlite"),
                agent_workers={"planner": ("executor",), "executor": ()}, default_agent="planner",
            )
            definitions = {
                name: AgentDefinition(description=name, system_prompt=name, model="offline",
                                      workers=("executor",) if name == "planner" else (), code_mode=False)
                for name in ("planner", "executor")
            }
            agents = build_agents(
                manager, definitions=definitions,
                models={name: Model(responses=[]) for name in definitions},
                tools={name: [] for name in definitions},
                environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=state, virtual_mode=True), "/skills", "/")),
                checkpointer=saver,
            )
            manager.start("goal", "root")
            await asyncio.Event().wait()
        os._exit(3)  # 不应到达

    asyncio.run(main())
''')


def notices_in(messages):
    return [m for m in messages if str(m.id or "").startswith("undelivered:")]


class GraphRestartTests(unittest.IsolatedAsyncioTestCase):
    """用真实的角色图（假模型）+ SQLite 检查点 + 调度存储，验证续聊时的历史与提示。"""

    async def crash(self, mode):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        state = Path(directory.name)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-c", GRAPH_CRASH_SCRIPT, str(state), mode,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(process.communicate(), 60)
        self.assertEqual(process.returncode, 0, stderr.decode())
        return state

    def fresh_state(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return Path(directory.name)

    async def runtime(self, state, respond=None, on_human=None):
        """打开运行时。respond(按 task 分组前的模型输入) 返回 AgentOutput，默认 wait；
        seen 记录每次模型调用看到的输入。"""
        seen = []

        class Model(FakeMessagesListChatModel):
            def bind_tools(self, tools, **kwargs):
                return self.bind(**kwargs)

            def _generate(self, messages, stop=None, run_manager=None, **kwargs):
                seen.append(list(messages))
                result = (respond or (lambda _: AgentOutput(messages=[], next="wait")))(messages)
                return ChatResult(generations=[ChatGeneration(message=AIMessage(
                    content=result.model_dump_json(),
                    additional_kwargs={"wandrun_agent_output": result.model_dump()},
                ))])

        # 清理按注册的逆序执行：先关闭 Manager，再关闭存储和检查点连接。
        stack = AsyncExitStack()
        self.addAsyncCleanup(stack.aclose)
        saver = await stack.enter_async_context(
            AsyncSqliteSaver.from_conn_string(str(state / "checkpoints.sqlite"))
        )

        async def run(prompts, task_id):
            name = manager.agent_name(task_id)
            return await run_conversation(agents[name].graph, prompts, task_id, name)

        store = SchedulerStore(state / "scheduler.sqlite")
        self.addCleanup(store.close)
        manager = WorkerManager(
            run, store=store, on_human=on_human,
            agent_workers={"planner": ("executor",), "executor": ()}, default_agent="planner",
        )
        self.addAsyncCleanup(manager.close)
        definitions = {
            name: AgentDefinition(description=name, system_prompt=name, model="offline",
                                  workers=("executor",) if name == "planner" else (), code_mode=False)
            for name in ("planner", "executor")
        }
        agents = build_agents(
            manager, definitions=definitions,
            models={name: Model(responses=[]) for name in definitions},
            tools={name: [] for name in definitions},
            environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=state, virtual_mode=True), "/skills", "/")),
            checkpointer=saver,
        )
        return manager, agents["planner"].graph, seen

    async def history(self, planner):
        return (await planner.aget_state(conversation_config("root"))).values["messages"]

    async def test_replayed_input_is_not_duplicated_in_history(self):
        """图已返回、检查点已提交，但确认 inflight 的事务未提交时崩溃。"""
        state = await self.crash("confirm")
        manager, planner, seen = await self.runtime(state)
        self.assertEqual([m.content for m in manager._inflight["root"]], ["goal"])
        manager.start("继续", "root")
        await manager.wait("root")
        # 重新交付的 goal 按 ID 去重，没有第二次写入历史；但模型确实被再次调用。
        self.assertEqual(
            [m.content for m in await self.history(planner) if isinstance(m, HumanMessage)],
            ["goal", "继续"],
        )
        self.assertEqual(len(seen), 1)

    async def test_unaccepted_delegation_is_reported_once_on_resume(self):
        state = await self.crash("send_intent")
        manager, planner, seen = await self.runtime(state)
        snapshot = await planner.aget_state(conversation_config("root"))
        self.assertEqual(snapshot.next, ("CommunicationMiddleware.after_model",))
        self.assertEqual(list(manager._callers), ["root"])  # 子任务从未创建

        manager.start("继续", "root")
        await manager.wait("root")
        (inputs,) = seen
        (notice,) = notices_in(inputs)
        self.assertIn("delegated work", notice.content)
        self.assertIn("没有创建任务", notice.content)
        self.assertEqual(inputs[-1].content, "继续")  # 提示在本次输入之前
        self.assertEqual(list(manager._callers), ["root"])  # 不重放、不自动重发

        manager.start("再继续", "root")
        await manager.wait("root")
        self.assertEqual(len(notices_in(seen[-1])), 1)  # 提示只写入一次
        self.assertEqual(len(notices_in(await self.history(planner))), 1)

    async def test_notice_follows_patched_tool_results(self):
        state = await self.crash("send_intent_tool")
        manager, planner, seen = await self.runtime(state)
        manager.start("继续", "root")
        await manager.wait("root")
        (inputs,) = seen
        kinds = [
            "tool" if isinstance(m, ToolMessage)
            else "notice" if m in notices_in(inputs)
            else "input" if getattr(m, "content", None) == "继续"
            else None
            for m in inputs
        ]
        self.assertEqual([k for k in kinds if k], ["tool", "notice", "input"])

    async def test_committed_dispatch_without_after_model_checkpoint_is_not_reported(self):
        state = await self.crash("dispatched")
        manager, planner, seen = await self.runtime(state)
        self.assertEqual(len([t for t in manager._callers if t != "root"]), 1)  # 委派已接收
        manager.start("继续", "root")
        await manager.wait("root")
        self.assertEqual(notices_in(seen[0]), [])

    async def test_successful_delegation_with_pending_receipt_is_not_reported(self):
        """委派成功、根任务已完成，回执只在待交付输入中（评审中的反例）。"""
        def respond(messages):
            if any(getattr(m, "content", None) == "goal" for m in messages) and not any(
                isinstance(m, AIMessage) for m in messages
            ):
                return AgentOutput(
                    messages=[SendMessage(to="executor", task_id=None, message="work")],
                    next="done",
                )
            return AgentOutput(messages=[], next="wait")

        manager, planner, seen = await self.runtime(self.fresh_state(), respond)
        manager.start("goal", "root")
        self.assertEqual((await manager.wait("root"))["status"], "completed")
        self.assertTrue(manager._feedback["root"])  # 成功回执没有触发下一次模型调用
        manager.start("继续", "root")
        await manager.wait("root")
        self.assertEqual(notices_in(seen[-1]), [])

    async def test_failed_human_display_has_receipt_and_is_not_reported(self):
        def respond(messages):
            if not any(isinstance(m, AIMessage) for m in messages) and any(
                getattr(m, "content", None) == "goal" for m in messages
            ):
                return AgentOutput(messages=[
                    SendMessage(to="executor", task_id=None, message="work"),
                    SendMessage(to="human", task_id=None, message="hi"),
                ], next="wait")
            return AgentOutput(messages=[], next="wait")

        def on_human(sender, text, attachments, draft_id):
            if text == "hi":
                raise RuntimeError("display broke")

        manager, planner, seen = await self.runtime(self.fresh_state(), respond, on_human)
        manager.start("goal", "root")
        await manager.wait("root")
        self.assertEqual(len([t for t in manager._callers if t != "root"]), 1)
        manager.start("继续", "root")
        await manager.wait("root")
        inputs = seen[-1]
        self.assertEqual(notices_in(inputs), [])
        (receipt,) = [m for m in inputs if '"deliveries"' in str(m.content)]
        self.assertIn('"accepted": null', receipt.content)

    async def test_notice_survives_crash_after_end_is_saved(self):
        """续聊准备已保存 END（待执行节点被清掉），提示和新输入还没写入时中断，再次准备。"""
        state = await self.crash("send_intent")
        manager, planner, seen = await self.runtime(state)
        config = conversation_config("root")
        prompts = [HumanMessage("继续", id="resume")]
        first = await prepare_conversation_input(planner, config, prompts)
        self.assertEqual((await planner.aget_state(config)).next, ())
        # 返回的输入没有被执行：等同于在写入检查点之前中断。再次准备仍生成同一条提示。
        again = await prepare_conversation_input(planner, config, prompts)
        self.assertEqual(
            [m.id for m in notices_in(first["messages"])],
            [m.id for m in notices_in(again["messages"])],
        )
        self.assertEqual(len(notices_in(again["messages"])), 1)
        self.assertEqual(list(manager._callers), ["root"])  # 旧委派没有被重放

        manager.start("继续", "root")
        await manager.wait("root")
        later = await prepare_conversation_input(planner, config, [HumanMessage("再继续")])
        self.assertEqual(notices_in(later["messages"]), [])

    async def test_in_process_cancel_before_dispatch_is_reported(self):
        """进程内取消落在 model 节点已提交、after_model 投递之前。"""
        original = CommunicationMiddleware.aafter_model
        paused = asyncio.Event()
        calls = []

        @hook_config(can_jump_to=["model"])
        async def pause_first(self, state, runtime):
            calls.append(1)
            if len(calls) == 1:
                paused.set()
                await asyncio.Event().wait()  # 在投递前的 await 处被取消
            return await original(self, state, runtime)

        def respond(messages):
            if not any(isinstance(m, AIMessage) for m in messages):
                return AgentOutput(
                    messages=[SendMessage(to="executor", task_id=None, message="work")],
                    next="wait",
                )
            return AgentOutput(messages=[], next="wait")

        with patch.object(CommunicationMiddleware, "aafter_model", pause_first):
            manager, planner, seen = await self.runtime(self.fresh_state(), respond)
            manager.start("goal", "root")
            await asyncio.wait_for(paused.wait(), 5)
            self.assertEqual((await manager.cancel("root"))["status"], "cancelled")
            self.assertEqual(list(manager._callers), ["root"])
            manager.start("继续", "root")
            await manager.wait("root")
        self.assertEqual(len(notices_in(seen[-1])), 1)


if __name__ == "__main__":
    unittest.main()
