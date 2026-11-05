"""Actual remote-session protocol over local pipes; no cloud calls or local-PID facade."""

import asyncio
import json
import os
import shlex
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import PropertyMock, patch

from wandrun.integrations import remote_session
from wandrun.integrations.remote_processes import RemoteProcessTable
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.integrations.ssh_backend import SSHBackend, SessionChannel
from wandrun.runtime.execution.files import TaskDirectoryError
from wandrun.runtime.execution.process_tools import process_tools


async def until(predicate):
    async with asyncio.timeout(10):
        while not predicate():
            await asyncio.sleep(0.01)


def alive(pid):
    try:
        with open(f"/proc/{pid}/stat", "rb") as stream:
            return stream.read().rsplit(b")", 1)[1].split()[0] not in (b"Z", b"X")
    except (FileNotFoundError, ProcessLookupError):
        return False


class Manager:
    def __init__(self):
        self.notices = []
        self.feedback = []

    def ensure_active(self, owner):
        return None

    def notify(self, owner, payload):
        self.notices.append((owner, payload))

    def is_stopped(self, owner):
        return False

    def add_feedback(self, owner, payload):
        self.feedback.append((owner, payload))


@unittest.skipUnless(sys.platform.startswith("linux"), "managed cleanup requires Linux /proc")
class RemoteProcessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="remote managed ")
        self.root = Path(self.directory.name)
        self.server = await asyncio.create_subprocess_exec(
            sys.executable, remote_session.__file__, str(self.root), "0.1",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024,
        )
        channel = SessionChannel(self.server.stdout, self.server.stdin)
        await channel.open(0.1)
        self.backend = SSHBackend(channel, connection=None, label="test-pipe",
                                  workdir=str(self.root), timeout=10, termination_grace=0.1)
        self.prepares = 0

        async def prepare():
            self.prepares += 1
            return self.backend

        self.table = RemoteProcessTable(prepare, workdir=str(self.root))
        self.manager = Manager()
        self.exec_tool, self.kill_tool = process_tools(self.manager, self.table)
        self.config = {"configurable": {"thread_id": "owner-a"}}
        self.results = []
        self.log_errors = []

    async def asyncTearDown(self):
        for resource in (self.table, self.backend):
            try:
                await resource.aclose()
            except CleanupUnconfirmedError:
                pass
        self.server.stdin.close()
        await asyncio.wait_for(self.server.wait(), 15)
        self.directory.cleanup()

    def start(self, command, owner="owner-a", **kwargs):
        return self.table.start(command, owner, on_settled=self.results.append,
                                on_log_error=self.log_errors.append, **kwargs)

    async def execute(self, command, wait=0):
        return await self.exec_tool.ainvoke({"command": command, "yield_seconds": wait}, self.config)

    async def test_short_tool_result_real_output_code_log_and_no_duplicate_notice(self):
        result = await self.execute("printf out; printf err >&2; exit 7", wait=5)
        self.assertEqual(result["status"], "exited")
        self.assertTrue(result["submitted"])
        self.assertEqual(result["exit_code"], 7)
        self.assertEqual(result["output"], "outerr")
        self.assertEqual(result["cleanup"], "confirmed")
        self.assertEqual(Path(result["log"]).read_text(), "outerr")
        self.assertEqual(self.manager.notices, [])
        self.assertFalse(self.table.pending())
        self.assertEqual(self.table.pending_owners(), set())

    async def test_background_stream_log_and_terminal_delivered_exactly_once(self):
        result = await self.execute("echo first; sleep 0.4; echo last")
        self.assertIn(result["status"], ("preparing", "running"))
        execution = self.table.get(result["process_id"])
        await until(lambda: "first" in execution.output())
        await until(lambda: Path(result["log"]).exists() and "first" in Path(result["log"]).read_text())
        self.assertIn("first", Path(result["log"]).read_text())
        await execution.settled
        self.assertIn("last", execution.output())
        await asyncio.sleep(0)
        self.assertEqual(len(self.manager.notices), 1)
        notice = self.manager.notices[0][1]["background_process"]
        self.assertEqual(notice["exit_code"], 0)
        self.assertEqual(notice["cleanup"], "confirmed")
        self.assertTrue(notice["submitted"])
        self.assertTrue(notice["output_complete"])

    async def test_wait_cancel_leaves_execution_running(self):
        waiting = asyncio.create_task(self.execute("echo ready; sleep 30", wait=10))
        await until(lambda: self.table.pending())
        execution = next(iter(self.table._executions.values()))
        await until(lambda: "ready" in execution.output())
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertFalse(execution.settled.done())
        self.assertEqual(len(self.manager.feedback), 1)
        await execution.request_stop("test-cleanup")
        self.assertEqual(len(self.manager.notices), 1)

    async def test_owner_stop_does_not_touch_other_owner_and_denies_foreign_kill(self):
        first = self.start("echo one; exec sleep 30")
        second = self.start("echo two; exec sleep 30", owner="owner-b")
        self.assertEqual(self.table.pending_owners(), {"owner-a", "owner-b"})
        await until(lambda: "one" in first.output() and "two" in second.output())
        rejected = await self.kill_tool.ainvoke({"process_id": second.process_id}, self.config)
        self.assertIn("error", rejected)
        self.assertEqual(await self.table.stop_owners({"owner-a"}), [])
        self.assertEqual((await first.settled)["cleanup"], "confirmed")
        self.assertFalse(second.settled.done())
        self.assertEqual(self.table.pending_owners(), {"owner-b"})
        await second.request_stop("test-cleanup")

    async def test_shell_exit_cleans_redirected_and_term_ignoring_descendants(self):
        command = "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $! > child; echo done"
        execution = self.start(command)
        result = await asyncio.wait_for(execution.settled, 5)
        pid = int((self.root / "child").read_text())
        self.assertEqual(result["output"], "done\n")
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["cleanup"], "confirmed")
        self.assertFalse(alive(pid))

    async def test_term_ignoring_leader_is_killed_with_real_exit_status(self):
        execution = self.start("trap '' TERM; echo ready; while :; do sleep 0.1; done")
        await until(lambda: "ready" in execution.output())
        result = await asyncio.wait_for(execution.request_stop("kill_process"), 5)
        self.assertEqual(result["exit_code"], 137)
        self.assertEqual(result["cleanup"], "confirmed")

    async def test_escaped_pipe_holder_bounds_output_wait_without_claiming_eof(self):
        execution = self.start(
            "setsid sh -c 'echo $$ > escaped; exec sleep 30' & "
            "while [ ! -s escaped ]; do sleep 0.01; done; echo out"
        )
        try:
            result = await asyncio.wait_for(execution.settled, 5)
            self.assertFalse(result["output_complete"])
            self.assertTrue(result["output_settled"])
            self.assertEqual(result["output"], "out\n")
        finally:
            if (self.root / "escaped").exists():
                os.kill(int((self.root / "escaped").read_text()), signal.SIGKILL)

    async def test_rotation_summary_and_log_failure_notice_are_real(self):
        execution = self.start("python3 -c \"import sys; sys.stdout.write('x' * 11000000)\"")
        result = await asyncio.wait_for(execution.settled, 15)
        self.assertIn("省略", result["output"])
        self.assertEqual(result["output"].count("x"), 50_000)
        self.assertTrue(Path(str(execution.log_path) + ".1").exists())
        self.assertLessEqual(Path(execution.log_path).stat().st_size, remote_session.LOG_LIMIT)
        blocked = self.root / "not-a-directory"
        blocked.write_bytes(b"file")
        self.table.log_dir = str(blocked)
        failed = self.start("echo output-still-collected; sleep 0.1")
        failed_result = await failed.settled
        self.assertEqual(len(self.log_errors), 1)
        self.assertIn("log_error", failed_result)
        self.assertIn("output-still-collected", failed_result["output"])
        self.assertEqual(failed_result["exit_code"], 0)

    async def test_cwd_env_and_prepare_cancellation_before_submission(self):
        child = self.root / "child dir"
        child.mkdir()
        execution = self.start("pwd; printf %s \"$INJECTED\"", cwd=child, env={"INJECTED": "value"})
        result = await execution.settled
        self.assertEqual(result["output"], str(child) + "\nvalue")
        gate = asyncio.Event()

        async def prepare():
            await gate.wait()
            return self.backend

        self.table.prepare = prepare
        pending = self.start("touch never-submitted")
        result = await asyncio.wait_for(pending.request_stop("cancelled"), 1)
        self.assertEqual(result["status"], "not_submitted")
        self.assertIsNone(result["exit_code"])
        self.assertFalse((self.root / "never-submitted").exists())

    async def test_yield_zero_reports_preparing_and_kill_never_submits_the_command(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        async def prepare():
            entered.set()
            await release.wait()
            return self.backend

        self.table.prepare = prepare
        handle = await self.execute("touch never-prepared", wait=0)
        self.assertEqual(handle["status"], "preparing")
        self.assertFalse(handle["submitted"])
        await entered.wait()
        execution = self.table.get(handle["process_id"])
        self.assertIsNone(execution._call)
        stopped = await self.kill_tool.ainvoke({"process_id": execution.process_id}, self.config)
        self.assertEqual(stopped["status"], "not_submitted")
        self.assertFalse(stopped["submitted"])
        self.assertEqual(stopped["cleanup"], "confirmed")
        self.assertFalse((self.root / "never-prepared").exists())
        self.assertFalse(Path(handle["log"]).exists())
        self.assertEqual(self.manager.notices, [])

    async def test_interrupted_prepare_feedback_uses_the_true_unsubmitted_snapshot(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        async def prepare():
            entered.set()
            await release.wait()
            return self.backend

        self.table.prepare = prepare
        waiting = asyncio.create_task(self.execute("touch never-interrupted-prepare", wait=30))
        await entered.wait()
        execution = next(iter(self.table._executions.values()))
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertFalse(execution.settled.done())
        feedback = self.manager.feedback[0][1]["background_process"]
        self.assertEqual(feedback["status"], "preparing")
        self.assertFalse(feedback["submitted"])
        self.assertEqual(feedback["output"], "")
        result = await self.kill_tool.ainvoke({"process_id": execution.process_id}, self.config)
        self.assertFalse(result["submitted"])
        self.assertFalse((self.root / "never-interrupted-prepare").exists())

    async def test_disconnect_is_unknown_and_close_never_claims_cleanup(self):
        execution = self.start("echo ready; sleep 30; touch must-not-replay")
        await until(lambda: "ready" in execution.output())
        await self.backend._channel.stop_reading()
        result = await asyncio.wait_for(execution.settled, 1)
        self.assertEqual(result["status"], "unknown")
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["cleanup"], "unconfirmed")
        self.assertFalse(result["output_settled"])
        self.assertIs(self.table.get(execution.process_id), execution)
        self.assertEqual(self.table.pending_owners(), {"owner-a"})
        with self.assertRaises(CleanupUnconfirmedError):
            await self.table.aclose()
        with self.assertRaises(CleanupUnconfirmedError):
            await self.backend.aclose()
        self.server.stdin.close()  # Actual service EOF still owns best-effort cleanup.
        await asyncio.wait_for(self.server.wait(), 15)
        self.assertFalse((self.root / "must-not-replay").exists())

    async def test_failed_conversation_prepare_is_tool_error_without_start(self):
        class Files:
            async def prepare(self, owner):
                raise TaskDirectoryError("环境刚恢复；旧执行未核验；本次未提交")

        tools = process_tools(self.manager, self.table, files=Files())
        result = await tools[0].ainvoke({"command": "touch not-submitted", "yield_seconds": 0}, self.config)
        self.assertFalse(result["submitted"])
        self.assertIn("本次未提交", result["error"])
        self.assertFalse(self.table.pending())
        self.assertEqual(self.prepares, 0)

    async def test_prepare_cancel_and_cleanup_failure_settle_without_submitting(self):
        async def cancelled():
            raise asyncio.CancelledError()

        self.table.prepare = cancelled
        result = await self.start("touch never-cancelled").settled
        self.assertEqual(result["status"], "not_submitted")
        self.assertFalse(result["submitted"])

        async def unconfirmed():
            raise CleanupUnconfirmedError("skill staging cleanup unconfirmed")

        self.table.prepare = unconfirmed
        execution = self.start("touch never-unconfirmed")
        result = await execution.settled
        self.assertEqual(result["cleanup"], "unconfirmed")
        self.assertFalse(result["submitted"])
        self.assertIsNone(self.table.get(execution.process_id))
        await self.table.aclose()
        self.assertFalse((self.root / "never-cancelled").exists())
        self.assertFalse((self.root / "never-unconfirmed").exists())

    async def test_owner_stop_does_not_duplicate_completed_preparer_cleanup_debt(self):
        entered = asyncio.Event()

        async def prepare():
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                raise CleanupUnconfirmedError("preparer retains its skill staging ledger") from None

        self.table.prepare = prepare
        execution = self.start("touch never-preparer-debt")
        await entered.wait()
        reports = await self.table.stop_owners({"owner-a"})
        result = execution.settled.result()
        self.assertFalse(result["submitted"])
        self.assertEqual(result["cleanup"], "unconfirmed")
        self.assertEqual(reports, [])
        self.assertIsNone(self.table.get(execution.process_id))
        await self.table.aclose()
        self.assertFalse((self.root / "never-preparer-debt").exists())

    async def test_owner_stop_bounds_unresponsive_prepare_cleanup(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        async def prepare():
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                await release.wait()
                raise

        self.table.prepare = prepare
        execution = self.start("touch never-unresponsive")
        await entered.wait()
        try:
            with patch("wandrun.integrations.remote_processes.PREPARE_STOP_LIMIT", 0.01):
                result = await asyncio.wait_for(execution.request_stop("cancelled"), 1)
            self.assertFalse(result["submitted"])
            self.assertEqual(result["cleanup"], "unconfirmed")
            with self.assertRaises(CleanupUnconfirmedError):
                await self.table.aclose()
        finally:
            release.set()
            await asyncio.gather(execution._preparing, return_exceptions=True)
        self.assertIsNone(self.table.get(execution.process_id))
        await self.table.aclose()
        self.assertEqual(result["cleanup"], "unconfirmed")

    async def _hold_send_lock(self):
        channel = self.backend._channel
        original = channel._writer
        entered = asyncio.Event()
        release = asyncio.Event()
        messages = []

        class Writer:
            first = True

            def write(self, data):
                messages.append(json.loads(data))
                original.write(data)

            async def drain(self):
                if self.first:
                    self.first = False
                    entered.set()
                    await release.wait()
                await original.drain()

        channel._writer = Writer()
        blocker = asyncio.create_task(channel.send({"type": "cancel", "id": "unowned-barrier"}))
        await entered.wait()
        return release, blocker, messages

    async def test_owner_stop_cancels_queued_send_without_submitting_side_effect(self):
        release, blocker, messages = await self._hold_send_lock()
        execution = self.start("touch never-queued-stop")
        try:
            await until(lambda: execution._call is not None)
            await asyncio.sleep(0)
            result = await asyncio.wait_for(execution.request_stop("kill_process"), 1)
            self.assertFalse(result["submitted"])
            self.assertFalse(execution._call.sent)
            self.assertFalse(any(message["type"] == "managed" for message in messages))
        finally:
            release.set()
            await blocker
        self.assertFalse((self.root / "never-queued-stop").exists())

    async def test_table_close_cancels_queued_send_without_submitting_side_effect(self):
        release, blocker, messages = await self._hold_send_lock()
        execution = self.start("touch never-queued-close")
        try:
            await until(lambda: execution._call is not None)
            await asyncio.sleep(0)
            await asyncio.wait_for(self.table.aclose(), 1)
            self.assertFalse(execution.result()["submitted"])
            self.assertFalse(execution._call.sent)
            self.assertFalse(any(message["type"] == "managed" for message in messages))
        finally:
            release.set()
            await blocker
        self.assertFalse((self.root / "never-queued-close").exists())

    async def test_submission_barrier_is_rechecked_inside_send_lock(self):
        release, blocker, messages = await self._hold_send_lock()
        channel = self.backend._channel
        call = channel.register()
        allowed = True
        sending = asyncio.create_task(channel.send(
            {"type": "managed", "id": call.id, "command": "touch never-barrier",
             "cwd": str(self.root), "env": {}, "log": str(self.root / "barrier.log")},
            call, can_send=lambda: allowed,
        ))
        try:
            await asyncio.sleep(0)
            allowed = False
            release.set()
            await blocker
            await sending
            self.assertFalse(call.sent)
            self.assertFalse(any(message["type"] == "managed" for message in messages))
            self.assertFalse((self.root / "never-barrier").exists())
        finally:
            release.set()
            await asyncio.gather(blocker, sending, return_exceptions=True)
            channel.calls.pop(call.id, None)

    async def test_channel_sealing_rejects_queued_synchronous_execute_before_write(self):
        release, blocker, messages = await self._hold_send_lock()
        channel = self.backend._channel
        execution = asyncio.create_task(self.backend.aexecute("touch never-sealed"))
        try:
            await until(lambda: bool(channel.calls))
            await asyncio.sleep(0)
            channel.seal()
            release.set()
            await blocker
            result = await execution
            self.assertIsNone(result.exit_code)
            self.assertIn("未提交", result.output)
            self.assertFalse(any(message["type"] == "run" for message in messages))
            self.assertFalse((self.root / "never-sealed").exists())
        finally:
            release.set()
            await asyncio.gather(blocker, execution, return_exceptions=True)


@unittest.skipUnless(sys.platform.startswith("linux"), "managed cleanup requires Linux /proc")
class ManagedCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_group_verification_is_retained_in_service_close(self):
        with tempfile.TemporaryDirectory() as root:
            session = remote_session.Session(root, 0.01)
            messages = []
            session.send = messages.append
            call = remote_session.ManagedCall(
                session, "owned", "echo ready; exec sleep 30", root, {}, root + "/owned.log",
            )
            session.calls[call.id] = call
            try:
                await until(lambda: any(message["type"] == "output" for message in messages))
                with patch.object(remote_session, "live_members", return_value=None):
                    call.stop("cancelled")
                    await asyncio.wait_for(call.task, 5)
                terminal = next(message for message in messages if message["type"] == "result")
                self.assertEqual(terminal["cleanup"], "unconfirmed")
                self.assertIn(call, session.retained)
                await session.close()
                self.assertEqual(messages[-1], {"type": "closed", "unconfirmed": ["owned"]})
            finally:
                call.stop("cancelled")
                if not call.task.done():
                    await asyncio.wait_for(call.task, 10)
                await until(call.observe)
                call.reap()


class FinalizingSilenceTests(unittest.IsolatedAsyncioTestCase):
    """Keep the protocol stream open after finalizing, without a terminal receipt."""

    async def asyncSetUp(self):
        self.reader = asyncio.StreamReader()
        self.messages = []
        messages = self.messages

        class Writer:
            def write(self, data):
                messages.append(json.loads(data))

            async def drain(self):
                return None

        self.channel = SessionChannel(self.reader, Writer())
        self.channel._reading = asyncio.create_task(self.channel._read())
        self.backend = SSHBackend(
            self.channel, connection=None, label="silent-open-channel",
            workdir="/test", timeout=1, termination_grace=0.01,
        )

        async def prepare():
            return self.backend

        self.table = RemoteProcessTable(prepare, workdir="/test")
        patcher = patch.object(SSHBackend, "_stop_limit", new_callable=PropertyMock, return_value=0.02)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addAsyncCleanup(self.close_resources)

    async def close_resources(self):
        await self.channel.stop_reading()
        for resource in (self.table, self.backend):
            try:
                await resource.aclose()
            except CleanupUnconfirmedError:
                pass

    async def finalizing(self):
        execution = self.table.start(
            "command-with-no-terminal-receipt", "owner",
            on_settled=lambda item: None, on_log_error=lambda item: None,
        )
        await until(lambda: execution._call is not None and execution._call.sent)
        self.reader.feed_data((json.dumps({"type": "finalizing", "id": execution._call.id}) + "\n").encode())
        await until(lambda: execution.state == "finalizing")
        self.assertFalse(self.channel.broken)
        self.assertFalse(self.reader.at_eof())
        return execution

    async def bounded(self, future):
        done, _ = await asyncio.wait({future}, timeout=1)
        self.assertTrue(done, "停止必须有界结算，不能无限等待活连接上的终态回执")
        return future.result()

    def assert_unknown(self, execution):
        result = execution.result()
        self.assertEqual(result["status"], "unknown")
        self.assertIsNone(result["exit_code"])
        self.assertEqual(result["cleanup"], "unconfirmed")
        self.assertFalse(result["output_complete"])
        self.assertFalse(result["output_settled"])
        self.assertIs(self.table.get(execution.process_id), execution)
        self.assertIn(execution._call.id, self.backend._unconfirmed)
        self.assertFalse(self.channel.broken)
        self.assertEqual(sum(message["type"] == "cancel" for message in self.messages), 1)

    async def test_kill_after_finalizing_enters_bounded_unknown_path(self):
        execution = await self.finalizing()
        await self.bounded(execution.request_stop("kill_process"))
        self.assert_unknown(execution)
        with self.assertRaises(CleanupUnconfirmedError):
            await self.table.aclose()

    async def test_owner_stop_after_finalizing_enters_bounded_unknown_path(self):
        execution = await self.finalizing()
        reports = await self.bounded(asyncio.create_task(self.table.stop_owners({"owner"})))
        self.assertTrue(any(execution.process_id in report for report in reports))
        self.assert_unknown(execution)

    async def test_close_after_finalizing_reports_unknown_without_waiting_for_eof(self):
        execution = await self.finalizing()
        closing = asyncio.create_task(self.table.aclose())
        with self.assertRaises(CleanupUnconfirmedError):
            await self.bounded(closing)
        self.assert_unknown(execution)
