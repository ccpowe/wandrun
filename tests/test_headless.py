import asyncio
import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import asynccontextmanager, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from langchain.messages import AIMessage
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool

from wandrun.evaluation.headless import LifecycleError, _wait_for_root, main, run_headless
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.session import RuntimeCleanupError, open_runtime
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.runtime.compaction_summary import SUMMARY_INSTRUCTION
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.runtime.workers import WorkerManager

from compaction_fixtures import SUMMARY_TEXT


def output(*messages, next="done"):
    return AgentOutput(messages=list(messages), next=next)


class HeadlessLifecycleTests(unittest.IsolatedAsyncioTestCase):

    async def test_missing_agent_config_writes_machine_readable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            result_path = workspace / "output" / "result.json"
            result, code = await run_headless(
                "do work",
                workspace=workspace,
                state_dir=workspace / "state",
                output_dir=workspace / "output",
                result_path=result_path,
                agents_config=workspace / "missing-agents.toml",
                task_timeout=2,
                model_timeout=2,
                model_max_retries=0,
                cleanup_grace=2,
                max_model_requests=2,
                thread_id="root",
            )
            self.assertEqual(code, 1)
            self.assertEqual(result["status"], "agent_failed")
            self.assertIn("missing-agents.toml", result["error"])
            self.assertEqual(result["usage"]["model_request_count"], 0)
            self.assertEqual(result["compaction_count"], 0)
            self.assertEqual(
                json.loads(result_path.read_text(encoding="utf-8"))["status"],
                "agent_failed",
            )
            self.assertTrue(Path(result["metrics_summary_path"]).is_file())

    async def test_committed_compaction_counts_without_exposing_summary_or_faking_delivery(self):
        @tool
        def diagnostic_report() -> str:
            """Read a diagnostic report."""
            return "trace row\n" * 1500

        def answer_text(text):
            payload = output(SendMessage(to="human", task_id=None, message=text))
            return {
                "type": "response.completed",
                "response": {
                    "status": "completed",
                    "output": [{
                        "type": "message", "id": "answer", "role": "assistant",
                        "phase": "final_answer",
                        "content": [{"type": "output_text", "text": payload.model_dump_json()}],
                    }],
                },
            }

        requests = []
        fail_summary = False

        async def respond(model, body):
            requests.append(body)
            if body["input"][-1].get("content") == SUMMARY_INSTRUCTION:
                if fail_summary:
                    raise ValueError("summary rejected")
                yield answer_text(SUMMARY_TEXT)
            elif len(requests) == 1:
                yield {
                    "type": "response.completed",
                    "response": {
                        "status": "completed",
                        "output": [{
                            "type": "function_call", "id": "fc_report",
                            "call_id": "report", "name": "diagnostic_report", "arguments": "{}",
                        }],
                        "usage": {"input_tokens": 35000, "output_tokens": 10, "total_tokens": 35010},
                    },
                }
            else:
                yield answer_text("finished")

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            agents = workspace / "agents.toml"
            agents.write_text(
                'main_agent = "planner"\n[agents.planner]\n'
                'description = "Main"\nsystem_prompt = "Work"\nmodel = "offline"\n'
                'context_window = 40000\ncompaction_keep_tokens = 100\n',
                encoding="utf-8",
            )
            (workspace / "mcps.toml").write_text("[mcp_servers]\n", encoding="utf-8")
            (workspace / "environments.toml").write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n',
                encoding="utf-8",
            )
            result_path = workspace / "output" / "result.json"
            stdout = io.StringIO()
            with (
                patch("wandrun.runtime.session.select_mcp_tools",
                      return_value=([diagnostic_report], {})),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
                redirect_stdout(stdout),
            ):
                result, code = await run_headless(
                    "read report", workspace=workspace, state_dir=workspace / "state",
                    output_dir=workspace / "output", result_path=result_path,
                    agents_config=agents, task_timeout=10, model_timeout=2,
                    model_max_retries=0, cleanup_grace=2, max_model_requests=4,
                    thread_id="root",
                )
            saved = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual((result["status"], code, saved["compaction_count"]),
                             ("completed", 0, 1))
            self.assertEqual(result["messages"][0]["message"], "finished")
            self.assertEqual(len(result["messages"]), 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertNotIn("result=67", json.dumps(saved, ensure_ascii=False))
            requests.clear()
            fail_summary = True
            with (
                patch("wandrun.runtime.session.select_mcp_tools",
                      return_value=([diagnostic_report], {})),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
                redirect_stdout(stdout),
            ):
                failed, failure_code = await run_headless(
                    "read report", workspace=workspace, state_dir=workspace / "failed-state",
                    output_dir=workspace / "failed-output",
                    result_path=workspace / "failed-output" / "result.json",
                    agents_config=agents, task_timeout=10, model_timeout=2,
                    model_max_retries=0, cleanup_grace=2, max_model_requests=4,
                    thread_id="failed-root",
                )
            self.assertEqual((failed["status"], failure_code, failed["compaction_count"]),
                             ("agent_failed", 1, 0))
            self.assertIn("summary rejected", failed["error"])
            failed_saved = json.loads(
                (workspace / "failed-output" / "result.json").read_text(encoding="utf-8")
            )
            self.assertEqual(failed_saved["compaction_count"], 0)
            self.assertNotIn("result=67", json.dumps(failed_saved, ensure_ascii=False))

    async def test_task_outcome_and_cleanup_breach_preserve_result_and_metrics(self):
        class Model(FakeMessagesListChatModel):
            model_name: str = "offline"
            reasoning_effort: str | None = None
            behavior: str

            def bind_tools(self, tools, **kwargs):
                return self.bind(**kwargs)

            async def _agenerate(self, messages, **kwargs):
                if self.behavior == "timeout":
                    await asyncio.Event().wait()
                if self.behavior == "failed":
                    raise ValueError("model broke")
                result = (
                    output(SendMessage(to="human", task_id=None, message="done"))
                    if self.behavior == "completed"
                    else output(next="wait")
                )
                response = AIMessage(
                    content=result.model_dump_json(),
                    additional_kwargs={"wandrun_agent_output": result.model_dump()},
                )
                return ChatResult(generations=[ChatGeneration(message=response)])

        @asynccontextmanager
        async def cleanup_breach(*args, **kwargs):
            async with open_runtime(*args, **kwargs) as runtime:
                yield runtime
            raise RuntimeCleanupError("cleanup threshold exceeded")

        for behavior, breach, expected_status, expected_code in (
            ("stalled", False, "stalled", 4),
            ("failed", False, "agent_failed", 1),
            ("timeout", False, "timeout", 124),
            ("completed", True, "cleanup_failed", 1),
            ("stalled", True, "stalled", 4),
            ("failed", True, "agent_failed", 1),
            ("timeout", True, "timeout", 124),
        ):
            with (
                self.subTest(behavior=behavior, breach=breach),
                tempfile.TemporaryDirectory() as directory,
            ):
                workspace = Path(directory)
                agents = workspace / "agents.toml"
                agents.write_text(
                    'main_agent = "planner"\n[agents.planner]\n'
                    'description = "Main"\nsystem_prompt = "Work"\nmodel = "offline"\n',
                    encoding="utf-8",
                )
                (workspace / "mcps.toml").write_text(
                    "[mcp_servers]\n", encoding="utf-8"
                )
                (workspace / "environments.toml").write_text(
                    'default = "local"\n[environments.local]\ntype = "local"\n',
                    encoding="utf-8",
                )
                result_path = workspace / "output" / "result.json"
                with (
                    patch(
                        "wandrun.runtime.session.create_models",
                        return_value={"planner": Model(responses=[], behavior=behavior)},
                    ),
                    patch(
                        "wandrun.evaluation.headless.open_runtime",
                        cleanup_breach if breach else open_runtime,
                    ),
                ):
                    result, code = await run_headless(
                        "do work",
                        workspace=workspace,
                        state_dir=workspace / "state",
                        output_dir=workspace / "output",
                        result_path=result_path,
                        agents_config=agents,
                        task_timeout=0.2 if behavior == "timeout" else 2,
                        model_timeout=2,
                        model_max_retries=0,
                        cleanup_grace=2,
                        max_model_requests=2,
                        thread_id="root",
                    )
                self.assertEqual(
                    (result["status"], code), (expected_status, expected_code)
                )
                self.assertEqual(
                    json.loads(result_path.read_text(encoding="utf-8"))["status"],
                    expected_status,
                )
                self.assertEqual(result["compaction_count"], 0)
                summary_path = Path(result["metrics_summary_path"])
                self.assertEqual(
                    json.loads(summary_path.read_text(encoding="utf-8"))["run_id"],
                    result["run_id"],
                )
                if behavior == "failed":
                    self.assertIn("model broke", result["error"])
                if expected_status == "cleanup_failed":
                    # 保留清理失败的原文（超时阈值或远端清理未确认的调用 ID），不改写成别的原因。
                    self.assertEqual(result["error"], "cleanup threshold exceeded")
                elif breach:
                    # 已有失败时保留原状态，清理事实附在后面而不是丢弃。
                    self.assertIn("清理：cleanup threshold exceeded", result["error"])

    async def test_startup_failure_keeps_exception_notes(self):
        @asynccontextmanager
        async def failing_runtime(*args, **kwargs):
            error = ValueError("skills sync failed")
            error.add_note("关闭远端会话时：unconfirmed call-1")
            raise error
            yield

        with tempfile.TemporaryDirectory() as directory, \
                patch("wandrun.evaluation.headless.open_runtime", failing_runtime):
            workspace = Path(directory)
            result, code = await run_headless(
                "do work", workspace=workspace, state_dir=workspace / "state",
                output_dir=workspace / "output", result_path=workspace / "output" / "result.json",
                agents_config=workspace / "agents.toml", task_timeout=2, model_timeout=2,
                model_max_retries=0, cleanup_grace=2, max_model_requests=2, thread_id="root",
            )
        self.assertEqual(code, 1)
        self.assertIn("skills sync failed", result["error"])
        self.assertIn("call-1", result["error"])

    async def test_completed_root_requires_workers_to_have_stopped(self):
        release = asyncio.Event()

        async def run(prompts, task_id):
            if task_id == "root":
                result = output(
                    SendMessage(to="executor", task_id=None, message="继续工作")
                )
                manager.dispatch(result, task_id)
                return result
            await release.wait()
            return output()

        manager = WorkerManager(
            run,
            agent_workers={"planner": ("executor",), "executor": ()},
            default_agent="planner",
        )
        self.addAsyncCleanup(manager.close)
        manager.start("开始", "root", agent_name="planner")
        with self.assertRaisesRegex(LifecycleError, "仍有运行中的 Worker"):
            await asyncio.wait_for(_wait_for_root(manager, "root"), 2)
        release.set()

    async def test_global_wait_without_running_work_is_stalled(self):
        async def run(prompts, task_id):
            return output(next="wait")

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("开始", "root")
        with self.assertRaisesRegex(LifecycleError, "仍处于 wait") as caught:
            await asyncio.wait_for(_wait_for_root(manager, "root"), 2)
        self.assertEqual(caught.exception.kind, "stalled")

    async def test_completed_root_without_live_work_succeeds(self):
        async def run(prompts, task_id):
            result = output(SendMessage(to="human", task_id=None, message="完成"))
            manager.dispatch(result, task_id)
            return result

        manager = WorkerManager(run, on_human=lambda sender, text, attachments, draft_id: None)
        self.addAsyncCleanup(manager.close)
        manager.start("开始", "root")
        result = await asyncio.wait_for(_wait_for_root(manager, "root"), 2)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(manager.snapshot()["running"], [])

    async def test_completed_root_observes_worker_failure_before_declaring_success(self):
        release = asyncio.Event()
        root_calls = 0

        async def run(prompts, task_id):
            nonlocal root_calls
            if task_id == "child":
                await release.wait()
                raise ValueError("child failed")
            root_calls += 1
            if root_calls == 1:
                manager.start("work", "child", sender_id="root", agent_name="executor")
                return output()
            self.assertTrue(any("child failed" in str(message.content) for message in prompts))
            raise RuntimeError("planner received worker failure")

        manager = WorkerManager(
            run,
            on_human=lambda sender, text, attachments, draft_id: None,
            agent_workers={"planner": ("executor",), "executor": ()},
            default_agent="planner",
        )
        self.addAsyncCleanup(manager.close)
        manager.start("start", "root")
        await manager.wait("root")
        # Schedule child completion first, then the headless check. The child's
        # done callback is enqueued behind that check, so its notification is pending.
        release.set()
        waiter = asyncio.create_task(_wait_for_root(manager, "root"))
        with self.assertRaisesRegex(RuntimeError, "planner received worker failure"):
            await asyncio.wait_for(waiter, 2)


class WorkspaceLayoutTests(unittest.TestCase):
    def test_cli_uses_workspace_config_and_selected_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            runtime = workspace / ".wandrun"
            skill = runtime / "skills" / "proof" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text(
                "---\nname: proof\ndescription: Workspace-only skill.\n"
                "---\nPrivate instructions.\n",
                encoding="utf-8",
            )
            (runtime / "agents.toml").write_text(
                'main_agent = "planner"\n[agents.planner]\n'
                'description = "Main"\nsystem_prompt = "Report success"\n'
                'model = "offline"\nskills = ["proof"]\n',
                encoding="utf-8",
            )
            (runtime / "mcps.toml").write_text("[mcp_servers]\n", encoding="utf-8")
            (runtime / "environments.toml").write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
            )
            (workspace / "report.txt").write_text("headless proof")
            test = self

            class Model(FakeMessagesListChatModel):
                model_name: str = "offline"
                reasoning_effort: str | None = None

                def bind_tools(self, tools, **kwargs):
                    return self.bind(**kwargs)

                async def _agenerate(self, messages, **kwargs):
                    system = str(messages[0].content)
                    test.assertIn("Workspace-only skill.", system)
                    test.assertNotIn("Private instructions.", system)
                    result = output(
                        SendMessage(to="human", task_id=None, message="workspace-ready",
                                    attachments=["report.txt"])
                    )
                    response = AIMessage(
                        content=result.model_dump_json(),
                        additional_kwargs={"wandrun_agent_output": result.model_dump()},
                    )
                    return ChatResult(generations=[ChatGeneration(message=response)])

            with patch(
                "wandrun.runtime.session.create_models",
                return_value={"planner": Model(responses=[])},
            ):
                with redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as exit_status:
                        main(["run", "--instruction", "Report", "--workspace", str(workspace)])
            self.assertEqual(exit_status.exception.code, 0)
            results = list(runtime.glob("evaluations/*/output/result.json"))
            self.assertEqual(len(results), 1)
            result = json.loads(results[0].read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["messages"][0]["message"], "workspace-ready")
            self.assertEqual(result["messages"][0]["attachments"], [{
                "path": str(workspace / "report.txt"), "name": "report.txt",
                "size": len("headless proof"), "media_type": "text/plain",
            }])
            self.assertTrue((results[0].parents[1] / "state" / "checkpoints.sqlite").is_file())


class ManagedShellTests(unittest.TestCase):
    def test_non_virtual_mode_preserves_workspace_absolute_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "absolute.txt"
            backend = ManagedShellBackend(root_dir=directory, virtual_mode=False)
            backend.write(str(marker), "content")
            self.assertEqual(marker.read_text(), "content")
            self.assertFalse((Path(directory) / marker.as_posix().lstrip("/")).exists())

    def test_timeout_kills_child_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "should-not-exist"
            backend = ManagedShellBackend(root_dir=directory, timeout=1)
            result = backend.execute(
                f"(sleep 1.5; touch {marker.name}) & wait",
            )
            self.assertEqual(result.exit_code, 124)
            import time

            time.sleep(0.8)
            self.assertFalse(marker.exists())


class ManagedShellCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_execute_kills_process_group_before_returning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = ManagedShellBackend(
                root_dir=directory, timeout=30, termination_grace=0.1
            )
            running = asyncio.create_task(
                backend.aexecute("(sleep 0.5; touch late) & echo $$ > pgid; wait")
            )
            async with asyncio.timeout(3):
                while not (root / "pgid").is_file() or not (root / "pgid").read_text():
                    await asyncio.sleep(0.01)
            pgid = int((root / "pgid").read_text())
            running.cancel()
            async with asyncio.timeout(2):
                with self.assertRaises(asyncio.CancelledError):
                    await running
            # 组长已由取消路径回收；后台子 shell 同组被终止，交给 init 回收。
            async with asyncio.timeout(1):
                while True:
                    try:
                        os.killpg(pgid, 0)
                    except ProcessLookupError:
                        break
                    await asyncio.sleep(0.01)
            await asyncio.sleep(0.8)
            self.assertFalse((root / "late").exists())
            backend.close()

    async def test_async_timeout_and_close_share_termination(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = ManagedShellBackend(root_dir=directory, timeout=1)
            result = await backend.aexecute("sleep 5")
            self.assertEqual(result.exit_code, 124)
            running = asyncio.create_task(backend.aexecute("sleep 30", timeout=30))
            await asyncio.sleep(0.2)
            await asyncio.to_thread(backend.close)
            result = await asyncio.wait_for(running, 3)
            self.assertNotEqual(result.exit_code, 0)
            with self.assertRaises(RuntimeError):
                await backend.aexecute("echo late")

    async def _wait_for_pgid(self, root: Path) -> int:
        async with asyncio.timeout(3):
            while not (root / "pgid").is_file() or not (root / "pgid").read_text():
                await asyncio.sleep(0.01)
        return int((root / "pgid").read_text())

    def assertGroupGone(self, pgid: int):
        with self.assertRaises(ProcessLookupError):
            os.killpg(pgid, 0)

    async def test_cancel_kills_group_member_that_outlives_its_leader(self):
        # 组长 shell 收到 SIGTERM 退出，同组子进程忽略 SIGTERM：必须按进程组升级 SIGKILL。
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = ManagedShellBackend(
                root_dir=directory, timeout=30, termination_grace=0.2
            )
            running = asyncio.create_task(
                backend.aexecute(
                    "(trap '' TERM; sleep 0.8; touch late) & echo $$ > pgid; wait"
                )
            )
            pgid = await self._wait_for_pgid(root)
            running.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(running, 2)
            self.assertGroupGone(pgid)
            await asyncio.sleep(1)
            self.assertFalse((root / "late").exists())

    def test_timeout_kills_group_member_that_outlives_its_leader(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = ManagedShellBackend(
                root_dir=directory, timeout=1, termination_grace=0.2
            )
            result = backend.execute(
                "(trap '' TERM; sleep 2; touch late) & echo $$ > pgid; wait"
            )
            self.assertEqual(result.exit_code, 124)
            self.assertGroupGone(int((root / "pgid").read_text()))

    async def test_cancel_does_not_queue_behind_saturated_thread_pool(self):
        from concurrent.futures import ThreadPoolExecutor

        with tempfile.TemporaryDirectory() as directory:
            loop = asyncio.get_running_loop()
            loop.set_default_executor(ThreadPoolExecutor(max_workers=2))
            backend = ManagedShellBackend(
                root_dir=directory, timeout=30, termination_grace=0.1
            )
            running = [
                asyncio.create_task(backend.aexecute("sleep 30")) for _ in range(2)
            ]
            await asyncio.sleep(0.3)
            for task in running:
                task.cancel()
            started = loop.time()
            results = await asyncio.wait_for(
                asyncio.gather(*running, return_exceptions=True), 3
            )
            self.assertLess(loop.time() - started, 1)
            self.assertTrue(
                all(isinstance(r, asyncio.CancelledError) for r in results)
            )

    async def test_repeated_cancel_still_waits_for_termination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = ManagedShellBackend(
                root_dir=directory, timeout=30, termination_grace=0.5
            )
            running = asyncio.create_task(
                backend.aexecute("trap '' TERM; echo $$ > pgid; sleep 30")
            )
            pgid = await self._wait_for_pgid(root)
            running.cancel()
            await asyncio.sleep(0.1)
            running.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(running, 3)
            self.assertGroupGone(pgid)

    async def _occupy_default_executor(self):
        from concurrent.futures import ThreadPoolExecutor

        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
        release = threading.Event()
        blocker = asyncio.ensure_future(asyncio.to_thread(release.wait))
        await asyncio.sleep(0.05)
        return release, blocker

    async def test_timeout_is_enforced_while_default_executor_is_busy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release, blocker = await self._occupy_default_executor()
            try:
                backend = ManagedShellBackend(
                    root_dir=directory, timeout=1, termination_grace=0.1
                )
                started = asyncio.get_running_loop().time()
                result = await asyncio.wait_for(
                    backend.aexecute("sleep 1.5; touch late"), 3
                )
                self.assertEqual(result.exit_code, 124)
                self.assertLess(asyncio.get_running_loop().time() - started, 1.4)
                await asyncio.sleep(0.5)
                self.assertFalse((root / "late").exists())
            finally:
                release.set()
                await blocker

    async def test_cancel_while_default_executor_is_busy_releases_process(self):
        with tempfile.TemporaryDirectory() as directory:
            release, blocker = await self._occupy_default_executor()
            try:
                backend = ManagedShellBackend(
                    root_dir=directory, timeout=30, termination_grace=0.1
                )
                running = [
                    asyncio.create_task(backend.aexecute("sleep 30")) for _ in range(3)
                ]
                await asyncio.sleep(0.2)
                for task in running:
                    task.cancel()
                await asyncio.wait_for(
                    asyncio.gather(*running, return_exceptions=True), 2
                )
                # 收集线程负责关闭管道并注销；它必须在取消后照常收尾。
                async with asyncio.timeout(1):
                    while backend._processes:
                        await asyncio.sleep(0.01)
            finally:
                release.set()
                await blocker
