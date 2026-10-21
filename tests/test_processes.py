"""本机后台执行（ADR-0017）：真实进程上的收尾契约，以及工具层的结果交付与 Worker 接入。"""

import asyncio
import json
import os
import shlex
import signal
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from wandrun.config import BrowserDefinition
from wandrun.evaluation.headless import LifecycleError, _wait_for_root
from wandrun.integrations import local_processes
from wandrun.integrations.local_processes import ProcessTable
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.runtime.browser import BrowserLeases
from wandrun.runtime.process_tools import CommandMiddleware, process_tools
from wandrun.runtime.workers import WorkerManager

GRACE = 0.3


def alive(pid: int) -> bool:
    """进程存在且不是僵尸。"""
    try:
        with open(f"/proc/{pid}/stat", "rb") as file:
            return file.read().rsplit(b")", 1)[1].split()[0] != b"Z"
    except (FileNotFoundError, ProcessLookupError):
        return False


async def until(predicate, timeout=5.0):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


def nothing(execution):
    return None


@unittest.skipUnless(sys.platform.startswith("linux"), "剩余组员判定依赖 Linux /proc")
class ProcessTableTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.table = ProcessTable(cwd=self.directory, log_dir=self.directory / "logs", termination_grace=GRACE)
        self.addAsyncCleanup(self.close_table)

    async def close_table(self):
        try:
            await self.table.aclose()
        except CleanupUnconfirmedError:
            pass

    def start(self, command, owner="owner", **callbacks):
        return self.table.start(
            command,
            owner,
            on_settled=callbacks.get("on_settled", nothing),
            on_log_error=callbacks.get("on_log_error", nothing),
        )

    def pid_of(self, name):
        return int((self.directory / name).read_text())

    async def test_short_command_settles_without_waiting_grace(self):
        started = time.monotonic()
        result = await asyncio.wait_for(self.start("echo hi").settled, 2)
        self.assertLess(time.monotonic() - started, GRACE)  # 没有剩余组员，不走满宽限期
        self.assertEqual(result["status"], "exited")
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["cleanup"], "confirmed")
        self.assertTrue(result["output_complete"])
        self.assertEqual(result["output"], "hi\n")
        self.assertEqual(Path(result["log"]).read_text(), "hi\n")
        self.assertFalse(self.table.pending())

    async def test_output_written_before_exit_is_collected(self):
        result = await asyncio.wait_for(self.start("printf diag; exit 7").settled, 2)
        self.assertEqual(result["exit_code"], 7)
        self.assertEqual(result["output"], "diag")

    async def test_shell_exit_terminates_remaining_group_members(self):
        result = await asyncio.wait_for(
            self.start("sleep 30 & echo $! > child; echo started").settled, 3
        )
        self.assertEqual(result["output"], "started\n")
        self.assertEqual(result["cleanup"], "confirmed")
        self.assertFalse(alive(self.pid_of("child")))

    async def test_explicit_stop_terminates_a_lone_running_leader(self):
        execution = self.start("exec sleep 30")
        await asyncio.sleep(0.2)
        self.assertEqual(execution.state, "running")
        result = await asyncio.wait_for(execution.request_stop("kill_process"), 3)
        self.assertEqual(result["status"], "stopped")
        self.assertEqual(result["stopped_by"], "kill_process")
        self.assertEqual(result["exit_code"], -15)
        self.assertEqual(result["cleanup"], "confirmed")

    async def test_leader_ignoring_sigterm_is_killed(self):
        execution = self.start("trap '' TERM; echo ready; while :; do sleep 0.05; done")
        await until(lambda: "ready" in execution.output())
        result = await asyncio.wait_for(execution.request_stop("kill_process"), 3)
        self.assertEqual(result["exit_code"], -9)
        self.assertEqual(result["cleanup"], "confirmed")

    async def test_empty_scan_before_kill_does_not_skip_termination(self):
        """扫描期间 fork 后退出会让一次扫描漏掉新成员；SIGKILL 仍无条件发送，不误报确认。"""
        real = local_processes.live_members
        real_signal = local_processes.Execution._signal
        killed = False

        def signal_group(execution, sig):
            nonlocal killed
            killed = killed or sig == signal.SIGKILL
            real_signal(execution, sig)

        def racing(pgid):
            return real(pgid) if killed else []  # SIGKILL 之前的扫描都“看漏”了新成员

        execution = self.start(
            "(trap '' TERM; exec sleep 30) & echo $! > child; wait"
        )
        await until(lambda: (self.directory / "child").exists() and (self.directory / "child").read_text())
        child = self.pid_of("child")
        with (
            patch.object(local_processes, "live_members", racing),
            patch.object(local_processes.Execution, "_signal", signal_group),
        ):
            result = await asyncio.wait_for(execution.request_stop("kill_process"), 3)
        self.assertFalse(alive(child))
        self.assertEqual(result["cleanup"], "confirmed")

    async def test_escaped_descendant_holding_pipe_bounds_output_collection(self):
        started = time.monotonic()
        result = await asyncio.wait_for(
            # 等后代真正脱组后 shell 才退出；否则它仍在原组中，会被正常清理。
            self.start(
                "setsid sh -c 'echo $$ > escaped; exec sleep 30' & "
                "while [ ! -s escaped ]; do sleep 0.01; done; echo out"
            ).settled,
            local_processes.OUTPUT_GRACE + 3,
        )
        escaped = self.pid_of("escaped")
        try:
            self.assertLess(time.monotonic() - started, local_processes.OUTPUT_GRACE + 2)
            self.assertFalse(result["output_complete"])
            self.assertEqual(result["output"], "out\n")
            self.assertTrue(alive(escaped))  # 超出清理保证，是已知限制
        finally:
            os.kill(escaped, 9)

    async def test_leader_not_exiting_reports_unknown_and_close_reports_leftover(self):
        observed = False

        def stuck(execution):
            return observed and real_observe(execution)

        real_observe = local_processes.Execution._observe_exit
        with (
            patch.object(local_processes.Execution, "_observe_exit", stuck),
            patch.object(local_processes, "live_members", lambda pgid: [pgid]),
        ):
            execution = self.start("sleep 30")
            result = await asyncio.wait_for(execution.request_stop("kill_process"), 3)
            self.assertIsNone(result["exit_code"])
            self.assertEqual(result["cleanup"], "unconfirmed")
            self.assertIn("退出码未知", result["note"])
            self.assertFalse(self.table.pending())  # 结果已交付，不算待交付工作
            with self.assertRaises(CleanupUnconfirmedError) as raised:
                await self.table.aclose()
            self.assertIn(execution.process_id, str(raised.exception))
        observed = True

    async def test_leftover_leader_is_reaped_once_it_exits(self):
        observed = False
        real_observe = local_processes.Execution._observe_exit
        with patch.object(
            local_processes.Execution, "_observe_exit", lambda e: observed and real_observe(e)
        ):
            execution = self.start("sleep 30")
            await asyncio.wait_for(execution.request_stop("kill_process"), 3)
            observed = True
            await until(lambda: execution.reaped)
        self.assertIsNone(self.table.get(execution.process_id))

    async def test_log_rotates_past_limit(self):
        with patch.object(local_processes, "LOG_LIMIT", 1000):
            # 两段输出间隔开，第二段必然单独读到：写入它时日志已超限，触发轮换。
            result = await asyncio.wait_for(
                self.start("head -c 1500 /dev/zero | tr '\\0' a; sleep 0.3; echo tail-marker").settled, 3
            )
        log = Path(result["log"])
        self.assertEqual(Path(f"{log}.1").read_text(), "a" * 1500)
        self.assertEqual(log.read_text(), "tail-marker\n")
        self.assertNotIn("log_error", result)

    async def test_log_failure_while_running_is_reported_once_and_command_continues(self):
        failures = []

        def refuse(*args):
            raise OSError("disk full")

        with patch.object(local_processes, "LOG_LIMIT", 100), patch.object(local_processes.os, "replace", refuse):
            execution = self.start(
                "for i in $(seq 1 50); do echo line-$i; done; sleep 0.3; echo done",
                on_log_error=failures.append,
            )
            result = await asyncio.wait_for(execution.settled, 3)
        self.assertEqual(failures, [execution])
        self.assertIn("disk full", result["log_error"])
        self.assertEqual(result["exit_code"], 0)
        self.assertIn("done", result["output"])

    async def test_stop_owners_only_stops_that_owners_executions(self):
        mine = self.start("exec sleep 30", owner="a")
        other = self.start("exec sleep 30", owner="b")
        # 清理已确认时不报告任何执行（ADR-0019：接管入口据此提示可以操作）。
        self.assertEqual(await asyncio.wait_for(self.table.stop_owners({"a"}), 3), [])
        self.assertEqual(mine.state, "settled")
        self.assertEqual(other.state, "running")
        self.assertTrue(self.table.pending())

    async def test_close_stops_everything_and_refuses_new_commands(self):
        execution = self.start("exec sleep 30")
        await asyncio.wait_for(self.table.aclose(), 3)
        self.assertEqual(execution.settled.result()["stopped_by"], "closed")
        with self.assertRaises(RuntimeError):
            self.start("echo late")


    async def test_initialization_failure_after_spawn_leaves_no_process(self):
        """派生之后初始化失败：回滚已派生的进程组，不留下没有登记的命令。"""
        spawned = []
        real_popen = local_processes.subprocess.Popen

        def recording(*args, **kwargs):
            spawned.append(real_popen(*args, **kwargs))
            return spawned[-1]

        def refuse(thread):
            raise RuntimeError("can't start new thread")

        with (
            patch.object(local_processes.subprocess, "Popen", recording),
            patch.object(local_processes.threading.Thread, "start", refuse),
        ):
            with self.assertRaises(RuntimeError):
                self.start("exec sleep 60")
        (process,) = spawned
        self.assertFalse(alive(process.pid))
        self.assertTrue(process.stdout.closed)
        self.assertFalse(self.table.pending())

    async def test_reader_that_cannot_stop_keeps_ownership_and_is_reported(self):
        """读取线程卡在日志写入中：交付不承诺输出稳定，记录持有到它停止；关闭时仍未停止则报告未确认。"""
        release = threading.Event()
        real_write = local_processes._Output._write

        def blocked(output, chunk):
            release.wait()
            real_write(output, chunk)

        with (
            patch.object(local_processes, "OUTPUT_GRACE", 0.2),
            patch.object(local_processes, "_READER_STOP", 0.2),
            patch.object(local_processes._Output, "_write", blocked),
        ):
            first = self.start("echo delayed-log")
            result = await asyncio.wait_for(first.settled, 3)
            self.assertFalse(result["output_settled"])
            self.assertIs(self.table.get(first.process_id), first)
            release.set()
            await until(lambda: first.released)
            self.assertIsNone(self.table.get(first.process_id))
            self.assertEqual(Path(result["log"]).read_text(), "delayed-log\n")

            release.clear()
            second = self.start("echo stuck")
            await asyncio.wait_for(second.settled, 3)
            with self.assertRaises(CleanupUnconfirmedError) as raised:
                await self.table.aclose()
            self.assertIn(second.process_id, str(raised.exception))
            self.assertIn("输出读取未停止", str(raised.exception))
            self.assertTrue(second.reaped)  # 读取未停止不妨碍回收已退出的组长
            self.assertNotIn("组长未回收", str(raised.exception))
            release.set()

    async def test_close_reports_unconfirmed_cleanup_even_when_leader_was_reaped(self):
        with patch.object(local_processes, "live_members", lambda pgid: None):
            execution = self.start("exec sleep 30")
            with self.assertRaises(CleanupUnconfirmedError) as raised:
                await asyncio.wait_for(self.table.aclose(), 3)
        self.assertTrue(execution.released)
        self.assertEqual(execution.settled.result()["cleanup"], "unconfirmed")
        self.assertIn(execution.process_id, str(raised.exception))

    async def test_inline_output_stays_within_budget(self):
        script = shlex.quote(sys.executable) + " -c " + shlex.quote("import sys; sys.stdout.write('x' * 200000)")
        result = await asyncio.wait_for(self.start(script).settled, 3)
        kept = result["output"].replace("x", "")
        self.assertIn("省略 150000 字节", kept)
        self.assertEqual(result["output"].count("x"), local_processes.INLINE_HEAD + local_processes.INLINE_TAIL)


@unittest.skipUnless(sys.platform.startswith("linux"), "剩余组员判定依赖 Linux /proc")
class ProcessToolTests(unittest.IsolatedAsyncioTestCase):
    """工具经 Worker 执行：owner 来自调用方 thread_id，结果只交付一次。"""

    async def asyncSetUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.table = ProcessTable(cwd=self.directory, log_dir=self.directory / "logs", termination_grace=GRACE)
        self.prompts: list[list[str]] = []
        self.results: list = []
        self.script: list = []  # 每轮执行的动作
        self.manager = WorkerManager(self.run_worker)
        self.manager.add_stop_hook(self.table.stop_owners)
        self.exec_command, self.kill_process = CommandMiddleware(self.manager, self.table).tools
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):
        await self.manager.close()
        try:
            await self.table.aclose()
        except CleanupUnconfirmedError:
            pass

    async def run_worker(self, prompts, task_id):
        self.prompts.append([message.content for message in prompts])
        if self.script:
            action = self.script.pop(0)
            self.results.append(await action(task_id))
        return "ok"

    def call(self, tool, **arguments):
        async def action(task_id):
            return await tool.ainvoke(arguments, config={"configurable": {"thread_id": task_id}})
        return action

    def notices(self):
        found = []
        for batch in self.prompts:
            for content in batch:
                if content.startswith("[运行时反馈]"):
                    data = json.loads(content.split("\n", 1)[1])
                    if "background_process" in data:
                        found.append(data["background_process"])
        return found

    async def test_result_within_wait_is_returned_and_not_notified(self):
        self.script.append(self.call(self.exec_command, command="echo hi", yield_seconds=5))
        self.manager.start("go", "root")
        await self.manager.wait("root")
        (result,) = self.results
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["output"], "hi\n")
        await asyncio.sleep(0.2)
        self.assertEqual(self.notices(), [])
        self.assertEqual(len(self.prompts), 1)

    async def test_wait_expiry_returns_handle_and_settlement_wakes_owner(self):
        self.script.append(self.call(self.exec_command, command="sleep 0.5; echo finished", yield_seconds=0))
        self.manager.start("go", "root")
        await self.manager.wait("root")
        (handle,) = self.results
        self.assertEqual(handle["status"], "running")
        process_id = handle["process_id"]
        await until(lambda: len(self.prompts) == 2)  # 通知唤醒空闲的 owner
        await self.manager.wait("root")
        (notice,) = self.notices()
        self.assertEqual(notice["process_id"], process_id)
        self.assertEqual(notice["exit_code"], 0)
        self.assertIn("finished", notice["output"])

    async def test_interrupt_only_stops_waiting_and_resume_lists_running_process(self):
        script = shlex.quote(sys.executable) + " -c " + shlex.quote(
            "import os,pathlib,time; pathlib.Path('pid').write_text(str(os.getpid())); time.sleep(30)"
        )
        self.script.append(self.call(self.exec_command, command=f"exec {script}", yield_seconds=60))
        self.manager.start("go", "root")
        pid_file = self.directory / "pid"
        await until(lambda: pid_file.is_file() and pid_file.read_text())
        self.manager.interrupt("change of plan", "root")
        await until(lambda: len(self.prompts) == 2)
        resumed = self.prompts[1]
        self.assertTrue(any('"interrupted": true' in content for content in resumed))
        (notice,) = self.notices()
        self.assertEqual(notice["status"], "running")
        self.assertIn("仍在运行", notice["note"])
        self.assertTrue(alive(int(pid_file.read_text())))
        self.assertTrue(self.table.pending())

    async def test_settlement_racing_with_interrupt_is_delivered_by_notice(self):
        """结算与打断同时发生：工具没有返回结果，就必须由通知交付，且只交付一次。"""
        cancelled = asyncio.Event()
        work: list[asyncio.Task] = []
        start = self.table.start

        def capture(*args, **kwargs):
            execution = start(*args, **kwargs)
            # 启动时同步登记：结算的同一时刻取消等待中的工具调用，模拟打断与结算竞争。
            execution.settled.add_done_callback(lambda _: (work[0].cancel(), cancelled.set()))
            return execution

        async def action(task_id):
            work.append(asyncio.create_task(
                self.exec_command.ainvoke(
                    {"command": "echo raced", "yield_seconds": 60},
                    config={"configurable": {"thread_id": task_id}},
                )
            ))
            try:
                return await work[0]
            except asyncio.CancelledError:
                return "cancelled"

        self.table.start = capture

        self.script.append(action)
        self.manager.start("go", "root")
        await asyncio.wait_for(cancelled.wait(), 3)
        await until(lambda: len(self.prompts) == 2)
        await self.manager.wait("root")
        self.assertEqual(self.results[0], "cancelled")
        (notice,) = self.notices()
        self.assertEqual(notice["status"], "exited")
        self.assertIn("raced", notice["output"])

    async def test_cancelling_owner_stops_its_processes_without_waking_it(self):
        self.script.append(self.call(self.exec_command, command="exec sleep 30", yield_seconds=0))
        self.manager.start("go", "root")
        await self.manager.wait("root")
        process_id = self.results[0]["process_id"]
        await asyncio.wait_for(self.manager.cancel("root"), 3)
        self.assertIsNone(self.table.get(process_id))
        self.assertFalse(self.table.pending())
        await asyncio.sleep(0.2)
        self.assertEqual(len(self.prompts), 1)  # 结果保存为反馈，不唤醒已停止的 owner

    async def test_kill_process_returns_result_once_and_checks_owner(self):
        self.script.append(self.call(self.exec_command, command="exec sleep 30", yield_seconds=0))
        self.manager.start("go", "root")
        await self.manager.wait("root")
        process_id = self.results[0]["process_id"]

        other = await self.kill_process.ainvoke(
            {"process_id": process_id}, config={"configurable": {"thread_id": "someone-else"}}
        )
        self.assertIn("error", other)
        self.script.append(self.call(self.kill_process, process_id=process_id))
        self.manager.start("stop it", "root")
        await self.manager.wait("root")
        self.assertEqual(self.results[1]["stopped_by"], "kill_process")
        await asyncio.sleep(0.2)
        self.assertEqual(self.notices(), [])
        self.assertEqual(len(self.prompts), 2)

    async def test_stopped_owner_cannot_start_commands(self):
        self.manager.start("go", "root")
        await self.manager.wait("root")
        await self.manager.cancel("root")
        with self.assertRaises(asyncio.CancelledError):
            await self.exec_command.ainvoke(
                {"command": "echo late"}, config={"configurable": {"thread_id": "root"}}
            )
        self.assertFalse(self.table.pending())

    async def test_browser_rejection_is_feedback_before_starting_command(self):
        # Browser setup must finish before the command can be started.
        browser = BrowserLeases(BrowserDefinition("http://127.0.0.1:9222"))
        invoke = process_tools(self.manager, self.table, browser=browser)[0]
        self.script.append(self.call(invoke, command="echo must-not-run"))
        with patch.object(self.table, "start", side_effect=AssertionError("command started")):
            self.manager.start("go", "root")
            result = await self.manager.wait("root")
        self.assertEqual(result["status"], "completed")
        self.assertIn("浏览器命令被拒绝：任务没有可用的浏览器", self.results[0]["error"])
        self.assertFalse(self.table.pending())

    async def test_browser_environment_cancellation_and_fault_propagate(self):
        class Browser:
            failure = None

            async def command_environment(self, owner):
                raise self.failure

        browser = Browser()
        invoke = process_tools(self.manager, self.table, browser=browser)[0]
        self.manager.start("go", "root")
        await self.manager.wait("root")
        for failure in (asyncio.CancelledError(), RuntimeError("broken browser runtime")):
            browser.failure = failure
            with self.subTest(failure=type(failure).__name__), self.assertRaises(type(failure)):
                await invoke.ainvoke(
                    {"command": "echo must-not-run"},
                    config={"configurable": {"thread_id": "root"}},
                )
        self.assertFalse(self.table.pending())


@unittest.skipUnless(sys.platform.startswith("linux"), "剩余组员判定依赖 Linux /proc")
class DeliveryFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_notice_commit_failure_still_reports_and_releases_resources(self):
        """完成通知提交调度库失败：调度失败照常报告，组长仍被回收、资源仍被释放。"""

        class Store:
            failing = False

            def load(self):
                return []

            def save(self, snapshots):
                if self.failing:
                    raise OSError("disk full")

        directory = Path(tempfile.mkdtemp())
        table = ProcessTable(cwd=directory, log_dir=directory / "logs", termination_grace=GRACE)
        store = Store()

        async def run(prompts, task_id):
            return "ok"

        manager = WorkerManager(run, store=store)
        exec_command, _ = process_tools(manager, table)
        manager.start("go", "root")
        await manager.wait("root")
        handle = await exec_command.ainvoke(
            {"command": "sleep 0.3", "yield_seconds": 0},
            config={"configurable": {"thread_id": "root"}},
        )
        execution = table.get(handle["process_id"])
        store.failing = True
        failure = await asyncio.wait_for(manager.wait_failure(), 3)
        self.assertIn("调度存储提交失败", str(failure))
        await until(lambda: execution.released, timeout=3)
        self.assertTrue(execution.reaped)
        self.assertIsNone(table.get(execution.process_id))
        with self.assertRaises(Exception):
            await manager.close()
        await table.aclose()


class BranchStopTests(unittest.IsolatedAsyncioTestCase):
    """分支取消包括 Worker 清理与后台执行停止；调用方离开不撤销它，完成前不能恢复（ADR-0007/0017）。"""

    async def test_cancelled_caller_does_not_skip_stop_hooks(self):
        hooked = []
        entered = asyncio.Event()

        async def run(prompts, task_id):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.sleep(0.2)  # Worker 自身的清理需要时间
                raise

        async def hook(scope):
            hooked.append(sorted(scope))
            return []

        manager = WorkerManager(run)
        manager.add_stop_hook(hook)
        self.addAsyncCleanup(manager.close)
        manager.start("go", "root")
        await entered.wait()
        caller = asyncio.create_task(manager.cancel("root"))
        await asyncio.sleep(0.05)
        caller.cancel()  # 例如调用 cancel_worker 的上级被打断
        await asyncio.gather(caller, return_exceptions=True)
        await until(lambda: hooked, timeout=2)
        self.assertEqual(hooked, [["root"]])

    async def test_branch_cannot_resume_until_background_stop_finishes(self):
        release = asyncio.Event()
        hook_entered = asyncio.Event()

        async def run(prompts, task_id):
            return "ok"

        async def hook(scope):
            hook_entered.set()
            await release.wait()
            return []

        manager = WorkerManager(run)
        manager.add_stop_hook(hook)
        self.addAsyncCleanup(manager.close)
        manager.start("go", "root")
        await manager.wait("root")
        cancelling = asyncio.create_task(manager.cancel("root"))
        await hook_entered.wait()
        with self.assertRaisesRegex(ValueError, "正在停止"):
            manager.start("again", "root")
        release.set()
        await cancelling
        self.assertEqual(manager.start("again", "root")["status"], "running")


class HeadlessPendingTests(unittest.IsolatedAsyncioTestCase):
    async def test_waiting_root_with_pending_process_is_not_stalled(self):
        class Manager:
            def get(self, task_id):
                return {"task_id": task_id, "status": "waiting"}

            def snapshot(self):
                return {"running": [], "finishing": [], "queued": [], "inflight": []}

        pending = True
        waiting = asyncio.create_task(_wait_for_root(Manager(), "root", lambda: pending))
        await asyncio.sleep(0.2)
        self.assertFalse(waiting.done())
        pending = False
        with self.assertRaises(LifecycleError):
            await asyncio.wait_for(waiting, 1)


if __name__ == "__main__":
    unittest.main()
