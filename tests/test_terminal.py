import asyncio
import unittest
from unittest.mock import patch

from wandrun.terminal.chat import TerminalOutput, chat
from wandrun.runtime.files import ResolvedAttachment
from wandrun.runtime.workers import WorkerManager


class TerminalTests(unittest.IsolatedAsyncioTestCase):
    async def test_human_reply_shows_registered_original_file(self):
        output = TerminalOutput()
        file = ResolvedAttachment("/workspace/report.txt", "report.txt", 12, "text/plain")
        with patch("builtins.print") as printed:
            output.on_human("task", "ready", [file])
        self.assertEqual(output.reply_to, "task")
        self.assertTrue(any("report.txt (12 bytes, text/plain)" in str(call)
                            and "/workspace/report.txt" in str(call) for call in printed.call_args_list))

    async def test_compaction_notices_are_one_line_and_do_not_change_reply_target(self):
        output = TerminalOutput()
        output.reply_to = "child"
        with patch("builtins.print") as printed:
            output.on_compaction("grandchild", {
                "status": "completed", "agent_name": "researcher",
                "archive_path": "/workspace/.wandrun/artifacts/compaction/history.md",
                "summary_text": "private summary",
            })
            output.on_compaction("grandchild", {
                "status": "failed", "agent_name": "researcher",
                "error": "ContextBudgetExhausted", "message": "protected\ncontext too large",
            })
        lines = [call.args[0] for call in printed.call_args_list]
        self.assertEqual(len(lines), 2)
        self.assertIn("已压缩上下文（Agent researcher，任务 grandchild）", lines[0])
        self.assertIn("history.md", lines[0])
        self.assertIn("压缩未完成（Agent researcher，任务 grandchild）", lines[1])
        self.assertIn("ContextBudgetExhausted: protected context too large", lines[1])
        self.assertTrue(all("\n" not in line and "private summary" not in line for line in lines))
        self.assertEqual(output.reply_to, "child")

    async def test_queued_message_runs_without_another_terminal_input(self):
        entered, release = asyncio.Event(), asyncio.Event()
        queued, completed = asyncio.Event(), asyncio.Event()
        calls, outputs = [], []

        async def run(prompts, identity):
            calls.append([m.content for m in prompts])
            if len(calls) == 1:
                entered.set()
                await release.wait()
            return "|".join(m.content for m in prompts)

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        lines = asyncio.Queue()
        lines.put_nowait("initial")

        def output(*parts, **kwargs):
            text = " ".join(map(str, parts))
            outputs.append(text)
            if "[queued]" in text:
                queued.set()
            if "[completed]" in text:
                completed.set()

        with patch("wandrun.terminal.chat.read_line", side_effect=lines.get), patch("builtins.print", side_effect=output):
            terminal = asyncio.create_task(chat(manager, "one", output=TerminalOutput()))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                lines.put_nowait("supplement")
                await asyncio.wait_for(queued.wait(), 2)
                release.set()
                # 不再输入任何消息，仍会自动续轮并在处理完后报告一次 completed。
                await asyncio.wait_for(completed.wait(), 2)
                self.assertEqual(calls, [["initial"], ["supplement"]])
                self.assertEqual(manager.get("one")["result"], "supplement")
                self.assertEqual(sum("[completed]" in text for text in outputs), 1)
                lines.put_nowait("/exit")
                await asyncio.wait_for(terminal, 2)
            finally:
                terminal.cancel()
                await asyncio.gather(terminal, return_exceptions=True)

    async def test_queue_status_cancel_while_running(self):
        entered, cleaned = asyncio.Event(), asyncio.Event()
        calls = []

        async def run(prompt, identity):
            calls.append([m.content for m in prompt])
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        lines = asyncio.Queue()
        lines.put_nowait("initial")
        outputs = []
        cancelled = asyncio.Event()

        def output(*parts, **kwargs):
            text = " ".join(map(str, parts))
            outputs.append(text)
            if '"status": "cancelled"' in text:
                cancelled.set()

        with patch("wandrun.terminal.chat.read_line", side_effect=lines.get), patch("builtins.print", side_effect=output):
            terminal = asyncio.create_task(chat(manager, "one", output=TerminalOutput()))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                for line in ("supplement", "/status", "/cancel"):
                    lines.put_nowait(line)
                await asyncio.wait_for(cancelled.wait(), 2)
                self.assertTrue(cleaned.is_set())
                self.assertEqual(calls, [["initial"]])
                self.assertEqual([m.content for m in manager.take_messages("one")], ["supplement"])
                lines.put_nowait("/exit")
                await asyncio.wait_for(terminal, 2)
            finally:
                terminal.cancel()
                await asyncio.gather(terminal, return_exceptions=True)
        self.assertTrue(any("[queued]" in text for text in outputs))
        self.assertTrue(any('"status": "running"' in text for text in outputs))

    async def test_failure_reported_without_more_input(self):
        async def run(prompt, identity):
            raise ValueError("example failure")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        lines = asyncio.Queue()
        lines.put_nowait("fail")
        reported = asyncio.Event()

        def output(*parts, **kwargs):
            if "example failure" in " ".join(map(str, parts)):
                reported.set()

        with patch("wandrun.terminal.chat.read_line", side_effect=lines.get), patch("builtins.print", side_effect=output):
            terminal = asyncio.create_task(chat(manager, "one", output=TerminalOutput()))
            try:
                await asyncio.wait_for(reported.wait(), 2)
                lines.put_nowait("/exit")
                await asyncio.wait_for(terminal, 2)
            finally:
                terminal.cancel()
                await asyncio.gather(terminal, return_exceptions=True)

    async def test_exit_and_eof_leave_caller_owned_workers_running(self):
        for ending in ("/exit", "exit", EOFError()):
            with self.subTest(ending=ending):
                entered, release = asyncio.Event(), asyncio.Event()

                async def run(prompt, identity):
                    entered.set()
                    await release.wait()
                    return "finished"

                manager = WorkerManager(run)
                self.addAsyncCleanup(manager.close)
                manager.start("background", "other")
                await asyncio.wait_for(entered.wait(), 2)
                with patch("wandrun.terminal.chat.read_line", side_effect=[ending]), patch("builtins.print"):
                    await chat(manager, "one", output=TerminalOutput())
                self.assertEqual(manager.get("other")["status"], "running")
                release.set()
                self.assertEqual((await manager.wait("other"))["result"], "finished")

    async def test_commands_do_not_become_messages(self):
        async def run(prompt, identity):
            self.fail("command must not reach Worker")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        with patch("wandrun.terminal.chat.read_line", side_effect=[" ", "/help", "/unknown", "/status", "/cancel", "/exit"]), patch("builtins.print"):
            await chat(manager, "one", output=TerminalOutput())
        self.assertEqual(manager.get("one")["status"], "not_found")

    async def test_cancel_stops_root_branch_and_resets_reply_target(self):
        from wandrun.runtime.messages import AgentOutput, SendMessage

        received, states_after_cancel = [], []
        output = TerminalOutput()

        async def run(prompts, task_id):
            received.append((task_id, [m.content for m in prompts]))
            if task_id == "child":
                manager.dispatch(AgentOutput(messages=[
                    SendMessage(to="human", task_id=None, message="Question from child"),
                ], next="wait"), task_id)
            return AgentOutput(messages=[], next="wait")

        manager = WorkerManager(run, on_human=output.on_human)
        self.addAsyncCleanup(manager.close)
        with patch("builtins.print"):
            manager.start("root input", "root")
            await manager.wait("root")
            manager.start("child input", "child", sender_id="root")
            await manager.wait("child")
        self.assertEqual(output.reply_to, "child")
        lines = iter(["/cancel", "continue", "/exit"])

        async def read_line():
            line = next(lines)
            if line == "continue":
                states_after_cancel.append((
                    manager.get("root")["status"],
                    manager.get("child")["status"],
                    output.reply_to,
                ))
            return line

        with patch("wandrun.terminal.chat.read_line", side_effect=read_line), patch("builtins.print"):
            await chat(manager, "root", output=output)
            await manager.wait("root")
        self.assertEqual(states_after_cancel, [("cancelled", "cancelled", "root")])
        # 恢复根任务时，先注入随它停止的子任务状态，再是用户新输入。
        task, prompts = received[-1]
        self.assertEqual((task, prompts[-1]), ("root", "continue"))
        self.assertIn('"task_id": "child"', prompts[0])
        self.assertIn('"cause": "stopped_with_parent"', prompts[0])
        self.assertEqual(manager.get("child")["status"], "cancelled")

    async def test_rejected_input_prints_reason_and_terminal_keeps_accepting_commands(self):
        from wandrun.runtime.messages import AgentOutput

        received = []

        async def run(prompts, task_id):
            received.append((task_id, [m.content for m in prompts]))
            return AgentOutput(messages=[], next="wait")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("root input", "root")
        await manager.wait("root")
        manager.start("child input", "child", sender_id="root")
        await manager.wait("child")
        await manager.cancel("root")
        output = TerminalOutput()
        output.reply_to = "child"
        printed = []
        with patch(
            "wandrun.terminal.chat.read_line",
            side_effect=["rejected input", "/cancel", "continue", "/exit"],
        ), patch("builtins.print", side_effect=lambda *args, **kwargs: printed.append(" ".join(map(str, args)))):
            await chat(manager, "root", output=output)
            await manager.wait("root")
        self.assertTrue(any("[rejected]" in text and "创建它的上级" in text for text in printed))
        self.assertEqual(received[-1][0], "root")
        self.assertEqual(received[-1][1][-1], "continue")
        self.assertEqual([task for task, _ in received], ["root", "child", "root"])
        self.assertEqual(manager.get("child")["status"], "cancelled")


class HumanRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_human_reply_returns_to_questioning_worker(self):
        from wandrun.runtime.messages import AgentOutput, SendMessage

        lines = asyncio.Queue()
        answered = asyncio.Event()
        received = []

        async def run(prompts, task_id):
            received.append((task_id, prompts))
            if len(received) == 1:
                result = AgentOutput(messages=[SendMessage(to="human", task_id=None, message="Which language?")], next="wait")
                manager.dispatch(result, task_id)
                return result
            answered.set()
            return AgentOutput(messages=[], next="done")

        output = TerminalOutput()
        manager = WorkerManager(run, on_human=output.on_human)
        self.addAsyncCleanup(manager.close)
        manager.start("work", "child")
        await asyncio.wait_for(manager.wait("child"), 2)
        with patch("wandrun.terminal.chat.read_line", side_effect=lines.get), patch("builtins.print"):
            terminal = asyncio.create_task(chat(manager, "root", output=output))
            try:
                lines.put_nowait("Python")
                await asyncio.wait_for(answered.wait(), 2)
                lines.put_nowait("/exit")
                await asyncio.wait_for(terminal, 2)
            finally:
                terminal.cancel()
                await asyncio.gather(terminal, return_exceptions=True)
        self.assertEqual(received[1][0], "child")
        self.assertEqual(received[1][1][-1].content, "Python")
        self.assertEqual(manager.get("root")["status"], "not_found")

    async def test_independent_terminal_outputs_route_to_their_own_worker(self):
        from wandrun.runtime.messages import AgentOutput, SendMessage

        answered = []
        outputs = [TerminalOutput(), TerminalOutput()]
        managers = []

        async def run(prompts, task_id):
            if prompts[0].content == "ask":
                result = AgentOutput(
                    messages=[SendMessage(to="human", task_id=None, message="Answer?")],
                    next="wait",
                )
                managers[0 if task_id == "first" else 1].dispatch(result, task_id)
                return result
            answered.append((task_id, prompts[-1].content))
            return AgentOutput(messages=[], next="done")

        for output in outputs:
            manager = WorkerManager(run, on_human=output.on_human)
            managers.append(manager)
            self.addAsyncCleanup(manager.close)
        for manager, task_id in zip(managers, ("first", "second")):
            manager.start("ask", task_id)
        await asyncio.gather(*(manager.wait(task_id) for manager, task_id in zip(managers, ("first", "second"))))

        for manager, output, answer in zip(managers, outputs, ("A", "B")):
            with patch("wandrun.terminal.chat.read_line", side_effect=[answer, "/exit"]), patch("builtins.print"):
                await chat(manager, "root", output=output)
        await asyncio.gather(*(manager.wait(task_id) for manager, task_id in zip(managers, ("first", "second"))))
        self.assertEqual(answered, [("first", "A"), ("second", "B")])


class TerminalExitTests(unittest.TestCase):
    def test_scheduler_failure_shows_its_notes(self):
        from wandrun.runtime.workers import SchedulerFailure
        from wandrun.terminal import app

        async def failing(*args, **kwargs):
            error = SchedulerFailure("scheduler stopped")
            error.__cause__ = OSError("disk write failed")
            error.add_note("remote terminal call-terminal unconfirmed")
            raise error

        with patch.object(app, "run_agent", failing):
            with self.assertRaises(SystemExit) as raised:
                app.main([])
        self.assertIn("call-terminal", str(raised.exception.code))

