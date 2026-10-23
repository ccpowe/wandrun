"""运行时的资源所有权、取消边界与实例隔离，不连接真实模型服务。"""

import asyncio
import json
import os
import re
import shlex
import sys
import subprocess
import tempfile
import threading
import unittest
import contextlib
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from langchain.agents.middleware import AgentMiddleware

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.capabilities import EntryCapabilityDefinition
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.code_mode import CodeModeCatalog, _Execution, _script_functions
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.session import RuntimeCleanupError, open_runtime
from wandrun.runtime.workspace import Workspace
from wandrun.runtime.scheduler_store import SchedulerStore
from wandrun.runtime.files import TaskBackend, TaskFiles, _current_task
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.integrations.local_processes import ProcessTable


def configure(root: Path, model="offline", grace=2.0) -> Workspace:
    workspace = Workspace(root)
    workspace.runtime_dir.mkdir()
    workspace.environments_config.write_text(
        'default = "local"\n[environments.local]\ntype = "local"\n'
        f"command_timeout = 30\ntermination_grace = {grace}\n",
        encoding="utf-8",
    )
    workspace.agents_config.write_text(
        'main_agent = "main"\n[agents.main]\n'
        'description = "Root"\nsystem_prompt = "Complete the task."\n'
        f'model = "{model}"\n',
        encoding="utf-8",
    )
    (workspace.runtime_dir / "mcps.toml").write_text(
        "[mcp_servers]\n", encoding="utf-8"
    )
    return workspace

def adapter_servers(config):
    """Extract adapter definitions from the configured FastMCP client."""
    return {
        name: definition.model_dump(mode="json", exclude_none=True)
        for name, definition in config.transport.config.mcpServers.items()
    }


@contextmanager
def created_backends(cls=ManagedShellBackend):
    """运行时自己构建 backend；记录它创建的实例，测试据此直接执行命令或检查关闭。"""
    created = []

    class Recording(cls):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            created.append(self)

    with patch("wandrun.runtime.environments.ManagedShellBackend", Recording):
        yield created


def answer(text):
    payload = {
        "messages": [{"to": "human", "task_id": None, "message": text, "attachments": []}],
        "next": "done",
    }
    return {
        "type": "response.completed",
        "response": {
            "status": "completed",
            "output": [
                {
                    "type": "message",
                    "id": "answer",
                    "role": "assistant",
                    "phase": "final_answer",
                    "content": [{"type": "output_text", "text": json.dumps(payload)}],
                }
            ],
        },
    }


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_human_rejection_continues_graph_and_persists_correction_receipt(self):
        from wandrun.gateway.ui_blocks import parse_blocks

        invalid = '```wandrun-ui\n{"root":"a","elements":{"a":{"type":"Unknown","props":{},"children":[]}},"state":{}}\n```'
        corrected = '```wandrun-ui\n{"root":"a","elements":{"a":{"type":"Text","props":{"text":"已修正"},"children":[]}},"state":{}}\n```'
        shown, requests = [], []

        async def respond(model, body):
            requests.append(body)
            yield answer(invalid if len(requests) == 1 else corrected)

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda _, text, attachments, draft_id: shown.append(text),
                    entry_capabilities=(EntryCapabilityDefinition(
                        "ui", "UI", lambda *_: ("enabled", "Test entry"),
                        lambda *_: AgentMiddleware,
                        validate_human=lambda _, text, attachments: parse_blocks(text)[0].error,
                    ),),
                    notify_human_of_roots=False,
                ) as runtime:
                    runtime.workers.start("展示内容", "root")
                    result = await asyncio.wait_for(runtime.workers.wait("root"), 5)
                    saved = await runtime._assembly_for("main").graph.aget_state(
                        conversation_config("root")
                    )
        self.assertEqual(result["status"], "completed")
        self.assertEqual(shown, [corrected])
        self.assertEqual(len(requests), 2)
        receipts = [
            json.loads(message.content.split("\n", 1)[1])["deliveries"]
            for message in saved.values["messages"]
            if message.additional_kwargs.get("receipt_for")
        ]
        self.assertFalse(receipts[0][0]["accepted"])
        self.assertIn("$.elements.a.type", receipts[0][0]["error"])

    async def test_shutdown_drains_worker_and_shell_before_mcp_disconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory), grace=0.1)
            metrics = RunMetrics(workspace.runs_dir)
            entered = asyncio.Event()
            model_cleaned = asyncio.Event()
            connection_open = False
            test = self

            class Pool:
                def __init__(self, *, oauth):
                    test.assertIsNone(oauth)
                    self.oauth_connectors = set()

                async def __aenter__(self):
                    nonlocal connection_open
                    connection_open = True
                    return self

                async def __aexit__(self, *_):
                    nonlocal connection_open
                    test.assertTrue(model_cleaned.is_set())
                    connection_open = False

            async def respond(model, body):
                entered.set()
                try:
                    await asyncio.Event().wait()
                    yield answer("unreachable")
                finally:
                    test.assertTrue(connection_open)
                    model_cleaned.set()

            with (
                patch("wandrun.runtime.session.MCPConnectionPool", Pool),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
                created_backends() as backends,
            ):
                async with open_runtime(
                    workspace,
                    metrics=metrics,
                    on_human=lambda *_: None,
                ) as runtime:
                    (backend,) = backends
                    runtime.workers.start("work", "root")
                    await asyncio.wait_for(entered.wait(), 2)
                    command = f"{shlex.quote(sys.executable)} -c \"from pathlib import Path; import time; Path('started').touch(); time.sleep(30)\""
                    shell = asyncio.create_task(
                        asyncio.to_thread(backend.execute, command)
                    )
                    async with asyncio.timeout(3):
                        while not (workspace.root / "started").exists():
                            await asyncio.sleep(0.01)
                result = await asyncio.wait_for(shell, 2)
            self.assertNotEqual(result.exit_code, 0)
            self.assertEqual(runtime.workers.get("root")["status"], "cancelled")
            self.assertFalse(connection_open)
            with self.assertRaises(RuntimeError):
                backend.execute("echo late")
            self.assertEqual(
                json.loads(metrics.summary_path.read_text())["request_statuses"],
                {"cancelled": 1},
            )

    async def test_cancelling_worker_kills_running_exec_command(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory), grace=0.1)
            metrics = RunMetrics(workspace.runs_dir)
            script = "import os, pathlib, time; pathlib.Path('pid').write_text(str(os.getpid())); time.sleep(30)"
            command = f"{shlex.quote(sys.executable)} -c {shlex.quote(script)}"
            requests = 0

            async def respond(model, body):
                nonlocal requests
                requests += 1
                yield {
                    "type": "response.completed",
                    "response": {
                        "status": "completed",
                        "output": [
                            {
                                "type": "function_call",
                                "id": "fc_shell",
                                "call_id": "call_shell",
                                "name": "exec_command",
                                "arguments": json.dumps({"command": command, "yield_seconds": 60}),
                            }
                        ],
                    },
                }


            pid_file = workspace.root / "pid"
            with (
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(
                    workspace,
                    metrics=metrics,
                    on_human=lambda *_: None,
                ) as runtime:
                    runtime.workers.start("work", "root")
                    async with asyncio.timeout(5):
                        while not pid_file.is_file() or not pid_file.read_text():
                            await asyncio.sleep(0.01)
                    pid = int(pid_file.read_text())
                    await asyncio.wait_for(runtime.workers.cancel("root"), 3)
                    # 取消返回时命令已被终止，不等到命令超时或运行时关闭。
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                    self.assertEqual(runtime.workers.get("root")["status"], "cancelled")
            self.assertEqual(requests, 1)

    async def test_background_command_result_wakes_waiting_owner(self):
        """本机角色用 exec_command 代替 execute；等待到期返回句柄，结算后通知唤醒 owner（ADR-0017）。"""
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory), grace=0.1)
            metrics = RunMetrics(workspace.runs_dir)
            bodies = []

            def call(name, arguments):
                return {
                    "type": "response.completed",
                    "response": {"status": "completed", "output": [{
                        "type": "function_call", "id": f"fc_{len(bodies)}", "call_id": f"call_{len(bodies)}",
                        "name": name, "arguments": json.dumps(arguments),
                    }]},
                }

            def waiting():
                reply = answer("waiting")
                payload = {"messages": [], "next": "wait"}
                reply["response"]["output"][0]["content"][0]["text"] = json.dumps(payload)
                return reply

            async def respond(model, body):
                bodies.append(json.dumps(body, ensure_ascii=False))
                if len(bodies) == 1:
                    yield call("exec_command", {"command": "sleep 0.3; echo bg-done", "yield_seconds": 0})
                elif len(bodies) == 2:
                    yield waiting()
                else:
                    yield answer("seen")


            with (
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(workspace, metrics=metrics, on_human=lambda *_: None) as runtime:
                    runtime.workers.start("work", "root")
                    async with asyncio.timeout(5):
                        while len(bodies) < 3:
                            await asyncio.sleep(0.01)
                    await runtime.workers.wait("root")
                    self.assertFalse(runtime.processes_pending())
            first = json.loads(bodies[0])
            names = {tool.get("name") for tool in first["tools"]}
            self.assertIn("exec_command", names)
            self.assertIn("kill_process", names)
            self.assertNotIn("execute", names)
            self.assertIn('\\"status\\": \\"running\\"', bodies[1])  # 工具返回句柄
            self.assertIn("background_process", bodies[2])
            self.assertIn("bg-done", bodies[2])

    async def test_large_tool_result_is_offloaded_inside_the_workspace(self):
        from langchain_core.tools import tool

        @tool
        def dump() -> str:
            """Return a very large report."""
            return "row\n" * 50_000

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    yield {
                        "type": "response.completed",
                        "response": {
                            "status": "completed",
                            "output": [{
                                "type": "function_call", "id": "fc_dump", "call_id": "call_dump",
                                "name": "dump", "arguments": "{}",
                            }],
                        },
                    }
                else:
                    yield answer("done")

            def selected(*_):
                return [dump], {}

            with (
                patch("wandrun.runtime.session.select_mcp_tools", selected),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None
                ) as runtime:
                    runtime.workers.start("work", "root")
                    self.assertEqual((await runtime.workers.wait("root"))["status"], "completed")
            (result,) = [
                item["output"] for item in bodies[1]["input"]
                if item.get("type") == "function_call_output"
            ]
            # 落盘后只回填摘要和路径；路径在 workspace 的 .wandrun/artifacts 下，而不是系统根目录。
            self.assertLess(len(str(result)), 5_000)
            stored = list((workspace.runtime_dir / "artifacts" / "large_tool_results").iterdir())
            self.assertEqual(len(stored), 1)
            self.assertIn(str(stored[0]), str(result))
            self.assertEqual(stored[0].read_text(encoding="utf-8"), "row\n" * 50_000)

    async def test_compaction_uses_offloaded_tool_result_and_preserves_full_file(self):
        from dataclasses import replace
        from langchain_core.tools import tool
        from langchain_core.messages import ToolMessage
        from wandrun.config import load_config
        from wandrun.runtime.compaction_summary import SUMMARY_INSTRUCTION
        from compaction_fixtures import SUMMARY_TEXT

        report = "trace row\n" * 20000 + "deep.wire_crc=8E91C2A4\n" + "tail row\n" * 2000
        @tool
        def diagnostic_report() -> str:
            """Return the diagnostic report including its deep checksum."""
            return report

        bodies, notices = [], []
        async def respond(model, body):
            bodies.append(body)
            if len(bodies) == 1:
                yield answer("ready")
                return
            if len(bodies) == 2:
                output = [{"type": "function_call", "call_id": "report", "name": "diagnostic_report",
                           "arguments": "{}"}]
            elif body["input"][-1].get("content") == SUMMARY_INSTRUCTION:
                yield answer(SUMMARY_TEXT.replace(
                    "已读 /reports/a.txt 第 1～80 行，覆盖全文；result=67，信息已足够回答。",
                    "诊断报告已卸载；只看到工具给出的预览，尚未核对深处校验值，完整文件可按工具结果路径读取。",
                ).replace(
                    "仅剩向 human 发送 result=67，不需要再次读取报告。",
                    "按留存的工具结果路径读取必要范围，核对深处校验值后交付。",
                ))
                return
            else:
                yield answer("报告已保存")
                return
            yield {"type": "response.completed", "response": {
                "status": "completed", "output": output,
                "usage": {"input_tokens": 35000, "output_tokens": 10, "total_tokens": 35010},
            }}

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            loaded = load_config(workspace.agents_config, workspace.mcps_config, workspace.environments_config)
            catalog = AgentCatalog("main", {
                "main": replace(loaded.agents["main"], context_window=40000, compaction_keep_tokens=100),
            })
            def prepare_report(*_):
                def middleware():
                    item = AgentMiddleware()
                    item.tools = [diagnostic_report]
                    return item
                return middleware
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, max_model_requests=4,
                    entry_capabilities=(EntryCapabilityDefinition(
                        "report", "Diagnostic", lambda *_: ("enabled", "Test entry"), prepare_report,
                    ),),
                    on_compaction=lambda task, event: notices.append(event),
                ) as runtime:
                    runtime.workers.start("历史诊断记录\n" + "trace row\n" * 3000, "large-result")
                    self.assertEqual((await runtime.workers.wait("large-result"))["status"], "completed")
                    runtime.workers.start("检查诊断报告的深处校验值", "large-result")
                    self.assertEqual((await runtime.workers.wait("large-result"))["status"], "completed")
                    checkpoint = await runtime._assembly_for("main").graph.aget_state(
                        conversation_config("large-result")
                    )
            (stored,) = (workspace.runtime_dir / "artifacts" / "large_tool_results").iterdir()
            self.assertEqual(stored.read_text(encoding="utf-8"), report)
            raw = checkpoint.values["messages"]
            tool_result = next(m.content for m in raw if isinstance(m, ToolMessage))
            self.assertLess(len(tool_result), 5000)
            self.assertIn(str(stored), tool_result)
            summary_request = next(body for body in bodies if body["input"][-1].get("content") == SUMMARY_INSTRUCTION)
            outputs = [item["output"] for item in summary_request["input"] if item.get("type") == "function_call_output"]
            self.assertEqual(outputs, [tool_result])
            self.assertEqual(summary_request["tools"], bodies[0]["tools"])
            self.assertEqual(summary_request["instructions"], bodies[0]["instructions"])
            self.assertEqual(summary_request["prompt_cache_key"], "large-result")
            self.assertNotIn(report, json.dumps(bodies[-1], ensure_ascii=False))
            self.assertEqual([notice["status"] for notice in notices], ["completed"])

    async def test_partial_startup_failure_releases_backend_connection_and_saves_usage(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            metrics = RunMetrics(workspace.runs_dir)

            class SlowBackend(ManagedShellBackend):
                def close(self):
                    super().close()
                    threading.Event().wait(0.08)

            connected = False

            class Adapter:
                def __init__(self, _):
                    self.client = self

                async def __aenter__(self):
                    nonlocal connected
                    connected = True
                    raise LookupError("discovery failed")

                async def __aexit__(self, *_):
                    pass

                async def close(self):
                    nonlocal connected
                    connected = False

            workspace.agents_config.write_text(
                workspace.agents_config.read_text(encoding="utf-8") + 'mcp_servers = ["broken"]\n',
                encoding="utf-8",
            )
            workspace.mcps_config.write_text(
                '[mcp_servers.broken]\nurl = "https://example.com/mcp"\n', encoding="utf-8"
            )
            with (
                patch("wandrun.integrations.mcp.MCPAdapter", Adapter),
                created_backends(SlowBackend) as backends,
            ):
                with self.assertRaisesRegex(ValueError, "连接或工具发现失败"):
                    async with open_runtime(
                        workspace,
                        metrics=metrics,
                        on_human=lambda *_: None,
                        cleanup_timeout=0.01,
                    ):
                        self.fail("failed startup cannot publish a runtime")
            self.assertFalse(connected)
            (backend,) = backends
            with self.assertRaises(RuntimeError):
                backend.execute("echo late")
            self.assertEqual(
                json.loads(metrics.summary_path.read_text())["model_request_count"], 0
            )

    async def test_cleanup_deadline_reports_only_after_backend_is_released(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            metrics = RunMetrics(workspace.runs_dir)
            release = threading.Event()
            closed = threading.Event()

            class SlowBackend(ManagedShellBackend):
                def close(self):
                    release.wait()
                    super().close()
                    closed.set()

            try:
                with created_backends(SlowBackend), self.assertRaises(RuntimeCleanupError):
                    async with open_runtime(
                        workspace,
                        metrics=metrics,
                        on_human=lambda *_: None,
                        cleanup_timeout=0.01,
                    ):
                        asyncio.get_running_loop().call_later(0.08, release.set)
            finally:
                release.set()
            self.assertTrue(closed.is_set())
            self.assertTrue(metrics.summary_path.is_file())

    async def test_cleanup_failures_from_every_environment_are_reported(self):
        from types import SimpleNamespace

        from wandrun.integrations.shell_backend import CleanupUnconfirmedError
        from wandrun.runtime import session

        class Backend:
            def __init__(self, name):
                self.name = name

            def close(self):
                raise CleanupUnconfirmedError(f"{self.name} unconfirmed: call-{self.name}")

        with tempfile.TemporaryDirectory() as directory:
            environments = [SimpleNamespace(backend=Backend(name), processes=None) for name in ("A", "B")]
            with self.assertRaises(RuntimeCleanupError) as raised:
                await session._shutdown(None, environments, contextlib.AsyncExitStack(), RunMetrics(Path(directory)))
        self.assertIn("call-A", str(raised.exception))
        self.assertIn("call-B", str(raised.exception))

        async def release_fails():
            raise OSError("MCP resource close failed")

        with tempfile.TemporaryDirectory() as directory:
            stack = contextlib.AsyncExitStack()
            stack.push_async_callback(release_fails)
            with self.assertRaises(OSError) as raised:
                await session._shutdown(None, environments, stack, RunMetrics(Path(directory)))
        notes = "".join(raised.exception.__notes__)  # 释放失败不覆盖已收集的远端清理事实
        self.assertIn("call-A", notes)
        self.assertIn("call-B", notes)

    async def test_instances_isolate_same_task_id_output_and_request_budgets(self):
        async def respond(model, body):
            yield answer(body["model"])

        with (
            tempfile.TemporaryDirectory() as first,
            tempfile.TemporaryDirectory() as second,
        ):
            workspaces = [
                configure(Path(first), "first"),
                configure(Path(second), "second"),
            ]
            outputs = [[], []]

            async def run(index):
                workspace = workspaces[index]
                metrics = RunMetrics(workspace.runs_dir)
                async with open_runtime(
                    workspace,
                    metrics=metrics,
                    on_human=lambda sender, text, attachments, draft_id: outputs[index].append((sender, text)),
                    max_model_requests=1,
                ) as runtime:
                    runtime.workers.start("start", "same-id")
                    self.assertEqual(
                        (await runtime.workers.wait("same-id"))["status"], "completed"
                    )
                    runtime.workers.start("over budget", "same-id")
                    self.assertEqual(
                        (await runtime.workers.wait("same-id"))["status"], "failed"
                    )
                self.assertEqual(metrics.summary()["model_request_count"], 1)

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                await asyncio.gather(run(0), run(1))
            self.assertEqual(outputs[0][0], ("same-id", "first"))
            self.assertEqual(outputs[1][0], ("same-id", "second"))


class AgentCatalogTests(unittest.IsolatedAsyncioTestCase):
    """网关从数据库提供 Agent：运行时不读 agents.toml，引用检查与文件来源相同。"""

    def catalog(self, **overrides) -> AgentCatalog:
        def definition(workers=()):
            return AgentDefinition(
                description="d", system_prompt="p", model="offline", workers=workers, environment="local"
            )

        agents = {"main": definition(), "c": definition(("a",)), "a": definition()}
        agents.update(overrides)
        return AgentCatalog("main", agents)

    async def test_builtin_skills_follow_initial_and_rebuilt_roles_without_changing_user_skills(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            user_skill = workspace.skills_dir / "wandrun-ui" / "SKILL.md"
            user_skill.parent.mkdir(parents=True)
            user_skill.write_text(
                "---\nname: wandrun-ui\ndescription: User skill\n---\nUser body.\n",
                encoding="utf-8",
            )
            builtin = {
                "wandrun-ui": {
                    "SKILL.md": "---\nname: wandrun-ui\ndescription: Runtime display skill\n---\n"
                    "Read design.md for details.\n",
                    "design.md": "built-in materialized detail\n",
                }
            }
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                yield answer("done")

            catalog = self.catalog(main=AgentDefinition(
                "Root", "Work", "offline", environment="local", skills=("wandrun-ui",),
            ))
            with created_backends() as backends, patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, entry_capabilities=(EntryCapabilityDefinition(
                        "ui", "UI", lambda *_: ("enabled", "Test entry"),
                        lambda *_: AgentMiddleware, builtin_skills=builtin,
                    ),),
                ) as runtime:
                    for name in ("main", "c", "a"):
                        runtime.workers.start("show skill", name, agent_name=name)
                        self.assertEqual((await runtime.workers.wait(name))["status"], "completed")
                    for body in bodies:
                        prompt = json.dumps(body, ensure_ascii=False)
                        self.assertIn("Runtime display skill", prompt)
                        self.assertNotIn("User skill", prompt)
                    # The model advertises a backend-readable absolute path, not a workspace skill path.
                    skill_path = Path(re.search(
                        r"Read `([^`]+/wandrun-ui/SKILL\.md)`", json.dumps(bodies[0], ensure_ascii=False),
                    ).group(1))
                    self.assertNotEqual(skill_path, user_skill)
                    self.assertNotIn(str(workspace.root), str(skill_path))
                    detail = backends[0].read(str(skill_path.with_name("design.md")))
                    self.assertIsNone(detail.error)
                    self.assertIn("built-in materialized detail", detail.file_data["content"])
                    updated = AgentCatalog("main", {
                        **catalog.agents,
                        "new": AgentDefinition("New", "Work", "offline", environment="local"),
                        "main": AgentDefinition("Root", "Updated", "offline", environment="local"),
                    })
                    (await runtime.prepare_agents(updated))()
                    for name in ("main", "new"):
                        runtime.workers.start("after update", f"after-{name}", agent_name=name)
                        self.assertEqual((await runtime.workers.wait(f"after-{name}"))["status"], "completed")
                        self.assertIn("Runtime display skill", json.dumps(bodies[-1], ensure_ascii=False))
                    self.assertEqual(updated.agents["new"].skills, ())
                self.assertFalse(skill_path.exists())
            self.assertIn("User body.", user_skill.read_text())

    async def test_builtin_skills_are_available_after_empty_catalog_and_absent_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            catalog = AgentCatalog(None, {})
            skill = {"sample": {
                "SKILL.md": "---\nname: sample\ndescription: Runtime sample\n---\nSample.\n",
            }}
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                yield answer("done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, entry_capabilities=(EntryCapabilityDefinition(
                        "sample", "Sample", lambda *_: ("enabled", "Test entry"),
                        lambda *_: AgentMiddleware, builtin_skills=skill,
                    ),),
                ) as runtime:
                    created = AgentCatalog("first", {
                        "first": AgentDefinition("First", "Work", "offline", environment="local"),
                    })
                    (await runtime.prepare_agents(created))()
                    runtime.workers.start("go", "builtin", agent_name="first")
                    self.assertEqual((await runtime.workers.wait("builtin"))["status"], "completed")
                    self.assertIn("Runtime sample", json.dumps(bodies[-1], ensure_ascii=False))
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=created,
                ) as runtime:
                    runtime.workers.start("go", "default", agent_name="first")
                    self.assertEqual((await runtime.workers.wait("default"))["status"], "completed")
                    self.assertNotIn("Runtime sample", json.dumps(bodies[-1], ensure_ascii=False))

    async def test_runtime_uses_the_given_definitions_instead_of_agents_toml(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            workspace.agents_config.write_text("不是合法 toml [[[", encoding="utf-8")
            async with open_runtime(
                workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                agent_catalog=self.catalog(),
            ) as runtime:
                self.assertEqual(set(runtime.agent_models), {"main", "c", "a"})
                runtime.workers.start("hi", "t1", agent_name="c")  # 不在 main 的委派范围内也能作为入口
                await runtime.workers.cancel("t1")

    async def test_catalog_is_validated_like_the_file_source(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            for bad, message in (
                (self.catalog(c=AgentDefinition("d", "p", "offline", workers=("ghost",), environment="local")), "ghost"),
                (self.catalog(c=AgentDefinition("d", "p", "offline", environment="nowhere")), "nowhere"),
                (self.catalog(c=AgentDefinition("d", "p", "offline", mcp_servers=("none",), environment="local")), "none"),
            ):
                with self.assertRaisesRegex(ValueError, message):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir),
                        on_human=lambda *_: None, agent_catalog=bad,
                    ):
                        self.fail("不应打开")

    async def test_catalog_and_agents_config_are_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            with self.assertRaises(ValueError):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=self.catalog(), agents_config=workspace.agents_config,
                ):
                    self.fail("不应打开")
            with self.assertRaisesRegex(ValueError, "mcps_config 与 mcp_servers"):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=self.catalog(), mcps_config=workspace.mcps_config,
                    mcp_servers={},
                ):
                    self.fail("不应打开")

    async def test_catalog_window_refresh_only_changes_compaction_after_commit(self):
        from wandrun.runtime.compaction_summary import SUMMARY_INSTRUCTION
        from compaction_fixtures import SUMMARY_TEXT

        requests = []
        async def respond(model, body):
            requests.append(body)
            yield answer(SUMMARY_TEXT if body["input"][-1].get("content") == SUMMARY_INSTRUCTION else "done")

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            catalog = AgentCatalog("main", {
                "main": AgentDefinition("Root", "p", "offline", compaction_keep_tokens=2000,
                                        environment="local"),
            })
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, model_context_windows={"offline": 1_000_000},
                ) as runtime:
                    initial_assembly = runtime._assembly_for("main")
                    initial_capabilities = initial_assembly.capabilities
                    async def turn(prompt):
                        runtime.workers.start(prompt, "window-refresh")
                        self.assertEqual((await runtime.workers.wait("window-refresh"))["status"], "completed")
                    await turn("不得覆盖已有文件。\n" + "diagnostic row\n" * 10000)
                    commit = await runtime.prepare_agents(catalog, model_context_windows={"offline": 40000})
                    self.assertIs(runtime._assembly_for("main"), initial_assembly)
                    self.assertIs(runtime._assembly_for("main").capabilities, initial_capabilities)
                    await turn("确认")
                    self.assertFalse(any(r["input"][-1].get("content") == SUMMARY_INSTRUCTION for r in requests))
                    commit()
                    rebuilt = runtime._assembly_for("main")
                    self.assertIsNot(rebuilt, initial_assembly)
                    self.assertIsNot(rebuilt.capabilities, initial_capabilities)
                    await turn("继续")
                    self.assertFalse(any("diagnostic row" in str(item) for item in requests[-1]["input"]))

    async def test_prepare_keeps_running_definition_and_rebuilds_member_directory(self):
        from dataclasses import replace

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            catalog = self.catalog(main=AgentDefinition(
                "Root", "旧提示", "offline-old", workers=("a",), environment="local", name="旧入口"
            ))
            entered, release = asyncio.Event(), asyncio.Event()
            bodies, shown = [], {}

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    entered.set()
                    await release.wait()
                    response = answer("unused")
                    response["response"]["output"][0]["content"][0]["text"] = json.dumps(
                        {"messages": [], "next": "continue"}
                    )
                    yield response
                else:
                    yield answer(body["model"])

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda task, text, attachments, draft_id: shown.update({task: text}), agent_catalog=catalog,
                    notify_human_of_roots=False,
                ) as runtime:
                    original_main = runtime._assembly_for("main")
                    original_member = runtime._assembly_for("a")
                    runtime.workers.start("first", "old", agent_name="main")
                    await asyncio.wait_for(entered.wait(), 3)
                    updated = AgentCatalog("main", {
                        **catalog.agents,
                        "main": replace(catalog.agents["main"], name="新入口", system_prompt="新提示", model="offline-new"),
                        "a": replace(catalog.agents["a"], name="写手", description="新职责"),
                    })
                    prepared = await runtime.prepare_agents(updated)
                    self.assertIs(runtime._assembly_for("main"), original_main)
                    self.assertIs(runtime._assembly_for("a"), original_member)
                    runtime.workers.start("before commit", "before", agent_name="main")
                    await runtime.workers.wait("before")
                    self.assertEqual(shown["before"], "offline-old")
                    prepared()
                    updated_main = runtime._assembly_for("main")
                    self.assertIsNot(updated_main, original_main)
                    self.assertIsNot(updated_main.capabilities, original_main.capabilities)
                    self.assertIsNot(runtime._assembly_for("a"), original_member)
                    runtime.workers.start("after commit", "after", agent_name="main")
                    await runtime.workers.wait("after")
                    self.assertEqual(shown["after"], "offline-new")
                    release.set()
                    await runtime.workers.wait("old")
                    self.assertEqual(shown["old"], "offline-old")
                    self.assertEqual([body["model"] for body in bodies], [
                        "offline-old", "offline-old", "offline-new", "offline-old",
                    ])
                    for index in (0, 1, 3):
                        prompt = json.dumps(bodies[index], ensure_ascii=False)
                        self.assertIn("main（旧入口）", prompt)
                        self.assertIn("旧提示", prompt)
                        self.assertNotIn("新职责", prompt)
                    updated_prompt = json.dumps(bodies[2], ensure_ascii=False)
                    self.assertIn("main（新入口）", updated_prompt)
                    self.assertIn("新提示", updated_prompt)
                    self.assertIn("a（写手）：新职责", updated_prompt)
                    prior_main = runtime._assembly_for("main")
                    prior_member = runtime._assembly_for("a")
                    (await runtime.prepare_agents(AgentCatalog("main", {
                        **updated.agents,
                        "a": replace(updated.agents["a"], name="校对者", description="检查文字"),
                    })))()
                    self.assertIsNot(runtime._assembly_for("main"), prior_main)
                    self.assertIsNot(runtime._assembly_for("main").capabilities, prior_main.capabilities)
                    self.assertIsNot(runtime._assembly_for("a"), prior_member)
                    runtime.workers.start("only member changed", "directory", agent_name="main")
                    await runtime.workers.wait("directory")
                    self.assertIn("a（校对者）：检查文字", json.dumps(bodies[-1], ensure_ascii=False))
                    self.assertEqual(shown["directory"], "offline-new")

    async def test_prepare_member_scope_add_delete_empty_and_failed_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            async with open_runtime(
                workspace, metrics=RunMetrics(workspace.runs_dir),
                on_human=lambda *_: None, agent_catalog=self.catalog(),
            ) as runtime:
                initial_models = runtime.agent_models
                bad = self.catalog(a=AgentDefinition(
                    "a", "p", "offline", workers=("missing",), environment="local"
                ))
                with self.assertRaisesRegex(ValueError, "missing"):
                    await runtime.prepare_agents(bad)
                self.assertIs(runtime.agent_models, initial_models)
                self.assertEqual(runtime.main_agent, "main")
                self.assertEqual(runtime.workers._agent_workers["c"], ("a",))
                with patch(
                    "wandrun.runtime.session.run_conversation",
                    new=AsyncMock(return_value="done"),
                ):
                    runtime.workers.start("existing", "old-a", agent_name="a")
                    await runtime.workers.wait("old-a")
                    new = AgentDefinition("new", "new prompt", "offline", environment=None)
                    catalog = AgentCatalog(None, {
                        "c": AgentDefinition("c", "p", "offline", workers=("new",), environment="local"),
                        "new": new,
                    })
                    (await runtime.prepare_agents(catalog))()
                    self.assertIsNone(runtime.main_agent)
                    self.assertEqual(set(runtime.agent_models), {"c", "new"})
                    with self.assertRaisesRegex(ValueError, "未知 Agent"):
                        runtime.workers.start("missing", "removed", agent_name="a")
                    runtime.workers.start("new role", "added", agent_name="new")
                    await runtime.workers.wait("added")
                    runtime.workers.start("parent", "parent", agent_name="c")
                    await runtime.workers.wait("parent")
                    receipt = runtime.workers.dispatch(
                        AgentOutput(messages=[SendMessage(to="new", task_id=None, message="work")], next="wait"),
                        "parent",
                    )[0]
                    self.assertTrue(receipt["accepted"])
                    await runtime.workers.wait(receipt["task_id"])
                    (await runtime.prepare_agents(AgentCatalog(None, {
                        **catalog.agents,
                        "c": AgentDefinition("c", "p", "offline", environment="local"),
                    })))()
                    rejected = runtime.workers.dispatch(
                        AgentOutput(messages=[SendMessage(to="new", task_id=None, message="again")], next="wait"),
                        "parent",
                    )[0]
                    self.assertFalse(rejected["accepted"])
                    self.assertIn("不能创建", rejected["error"])
                    orphan = runtime.workers.dispatch(
                        AgentOutput(messages=[SendMessage(to="c", task_id=None, message="work")], next="wait"),
                        "old-a",
                    )[0]
                    self.assertFalse(orphan["accepted"])
                    self.assertIn("已删除", orphan["error"])
                    (await runtime.prepare_agents(AgentCatalog(None, {})))()
                    self.assertEqual(runtime.agent_models, {})
                    with self.assertRaisesRegex(ValueError, "未知 Agent"):
                        runtime.workers.start("no default", "unassigned")

    async def test_new_role_executes_real_graph_after_empty_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            shown = []

            async def respond(model, body):
                yield answer("created agent replied")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda _, text, attachments, draft_id: shown.append(text),
                    agent_catalog=AgentCatalog(None, {}),
                ) as runtime:
                    self.assertEqual(runtime.default_environment, "local")
                    self.assertIsNone(runtime.main_agent)
                    (await runtime.prepare_agents(AgentCatalog(None, {
                        "fresh": AgentDefinition("Agent", "Help", "offline", environment=None)
                    })))()
                    runtime.workers.start("hi", "fresh-task", agent_name="fresh")
                    await asyncio.wait_for(runtime.workers.wait("fresh-task"), 5)
                    self.assertEqual(shown, ["created agent replied"])

    async def test_code_mode_dynamic_pool_same_thread_and_inflight_graph(self):
        from dataclasses import replace
        import pydantic_monty as pm

        from wandrun.runtime import session

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            workspace.environments_config.write_text(
                workspace.environments_config.read_text() + "[environments.other]\ntype = \"local\"\n",
                encoding="utf-8",
            )
            disabled = AgentDefinition("Root", "Work", "offline", environment="local", code_mode=False)
            off_catalog = AgentCatalog("main", {"main": disabled})
            on_catalog = AgentCatalog("main", {"main": replace(disabled, code_mode=True)})
            original_monty = pm.AsyncMonty
            pools = []

            class ObservedPool:
                def __init__(self):
                    self.pool = original_monty()
                    self.closed = False
                    pools.append(self)

                async def __aenter__(self):
                    return await self.pool.__aenter__()

                async def __aexit__(self, *args):
                    self.closed = True
                    return await self.pool.__aexit__(*args)

            mode = "off"
            requests = {}
            entered, release = asyncio.Event(), asyncio.Event()

            async def respond(model, body):
                task = body["prompt_cache_key"]
                selected = "inflight" if task == "inflight" else mode
                group = requests.setdefault((task, selected), [])
                group.append(body)
                if selected in ("on", "inflight", "reenabled") and len(group) == 1:
                    if selected == "inflight":
                        entered.set()
                        await release.wait()
                    filename = f"{selected}-proof.txt"
                    code = f"await write({filename!r}, {selected!r})\nprint(667)"
                    yield {
                        "type": "response.completed",
                        "response": {"status": "completed", "output": [{
                            "type": "function_call", "id": "code-" + selected,
                            "call_id": "code-" + selected, "name": "run_code",
                            "arguments": json.dumps({"code": code}),
                        }]},
                    }
                else:
                    yield answer("done")

            async def turn(selected):
                nonlocal mode
                mode = selected
                runtime.workers.start("next turn", "same-thread")
                result = await asyncio.wait_for(runtime.workers.wait("same-thread"), 10)
                self.assertEqual(result["status"], "completed", result)
                return requests[("same-thread", selected)]

            with (patch.object(session.pm, "AsyncMonty", side_effect=ObservedPool),
                  patch.object(CodexSubscriptionModel, "_arequest", respond)):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=off_catalog, notify_human_of_roots=False,
                ) as runtime:
                    self.assertEqual(pools, [])
                    first = await turn("off")
                    self.assertNotIn("run_code", {item.get("name") for item in first[0]["tools"]})
                    with self.assertRaisesRegex(ValueError, "environment"):
                        await runtime.prepare_agents(AgentCatalog("main", {
                            "main": replace(disabled, environment="other"),
                        }))
                    with self.assertRaisesRegex(ValueError, "默认执行环境"):
                        await runtime.prepare_agents(AgentCatalog("main", {
                            **off_catalog.agents,
                            "new": AgentDefinition("New", "Work", "offline", environment="other", code_mode=False),
                        }))
                    old = runtime._assembly_for("main")
                    with patch.object(session, "build_agents", side_effect=RuntimeError("graph failed")):
                        with self.assertRaisesRegex(RuntimeError, "graph failed"):
                            await runtime.prepare_agents(on_catalog)
                    self.assertEqual(len(pools), 1)
                    self.assertIs(runtime._assembly_for("main"), old)
                    publish = await runtime.prepare_agents(on_catalog)
                    self.assertIs(runtime._assembly_for("main"), old)
                    await turn("uncommitted")
                    publish()
                    enabled = await turn("on")
                    self.assertIn("run_code", {item.get("name") for item in enabled[0]["tools"]})
                    self.assertEqual((workspace.root / "on-proof.txt").read_text(), "on")
                    self.assertTrue(any(item.get("type") == "function_call_output"
                                        for item in enabled[1]["input"]))

                    runtime.workers.start("in-flight", "inflight")
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        (await runtime.prepare_agents(off_catalog))()
                        disabled_turn = await turn("disabled")
                        self.assertNotIn("run_code", {item.get("name") for item in disabled_turn[0]["tools"]})
                        self.assertTrue(any(item.get("type") == "function_call_output"
                                            for item in disabled_turn[0]["input"]))
                    finally:
                        release.set()
                    self.assertEqual((await asyncio.wait_for(runtime.workers.wait("inflight"), 10))["status"],
                                     "completed")
                    self.assertEqual((workspace.root / "inflight-proof.txt").read_text(), "inflight")
                    self.assertIn("run_code", {item.get("name") for item in requests[("inflight", "inflight")][1]["tools"]})
                    (await runtime.prepare_agents(on_catalog))()
                    reenabled = await turn("reenabled")
                    self.assertIn("run_code", {item.get("name") for item in reenabled[0]["tools"]})
                    self.assertEqual((workspace.root / "reenabled-proof.txt").read_text(), "reenabled")
                    self.assertEqual(len(pools), 1)
                self.assertTrue(pools[0].closed)

    async def test_new_ssh_role_executes_in_prepared_conversation_after_catalog_commit(self):
        from wandrun.runtime.environments import Environment

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            remote = workspace.root / "remote root"
            remote.mkdir()
            workspace.environments_config.write_text(
                'default = "vps"\n[environments.vps]\ntype = "ssh"\n'
                f'host = "unused.invalid"\nworkdir = {json.dumps(str(remote))}\n',
                encoding="utf-8",
            )
            bodies = []

            async def local_ssh_environment(config, workspace, stack, opened, *, include_default, builtin_source=None):
                backend = ManagedShellBackend(root_dir=remote, virtual_mode=False)
                opened.append(Environment(
                    "vps", backend, str(remote / ".wandrun/skills"),
                    str(remote / ".wandrun/artifacts"), synced_skills=frozenset(),
                ))
                return {}  # No role exists until prepare_agents commits the new catalog.

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    yield {
                        "type": "response.completed",
                        "response": {"status": "completed", "output": [{
                            "type": "function_call", "id": "fc_pwd", "call_id": "pwd_call",
                            "name": "execute",
                            "arguments": json.dumps({"command": "pwd; printf proof > executed.txt"}),
                        }]},
                    }
                else:
                    yield answer("finished")

            with (
                patch("wandrun.runtime.session.open_environments", side_effect=local_ssh_environment),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None, agent_catalog=AgentCatalog(None, {}),
                    conversation_workdirs=True,
                ) as runtime:
                    (await runtime.prepare_agents(AgentCatalog(None, {
                        "fresh": AgentDefinition("Agent", "Help", "offline", environment=None),
                    })))()
                    runtime.workers.start("Run in the conversation directory", "fresh-task", agent_name="fresh")
                    result = await asyncio.wait_for(runtime.workers.wait("fresh-task"), 5)
                    cwd = remote / "conversations" / "fresh-task"
                    self.assertEqual(result["status"], "completed", result)
                    self.assertEqual((cwd / "executed.txt").read_text(), "proof")
                    tool_results = [
                        item["output"] for item in bodies[1]["input"]
                        if item.get("type") == "function_call_output"
                    ]
                    self.assertIn(str(cwd), "\n".join(tool_results))

    async def test_new_mcp_reference_opens_before_commit_and_tool_runs_next_turn(self):
        from langchain_core.tools import StructuredTool

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            calls, connected, closed, bodies = [], [], [], []
            fail_first = [True]
            servers = {"docs": {"url": "https://example.com/mcp"}}

            class Adapter:
                def __init__(self, config):
                    self.client = self
                    connected.append(next(iter(adapter_servers(config))))

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_):
                    pass

                async def close(self):
                    closed.append("docs")

                async def list_tools(self):
                    if fail_first[0]:
                        fail_first[0] = False
                        raise RuntimeError("discovery failed")
                    async def lookup(query: str) -> str:
                        calls.append(query)
                        return f"found:{query}"

                    return [StructuredTool.from_function(
                        coroutine=lookup, name="lookup", description="Look up a page",
                    )]

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    yield {
                        "type": "response.completed",
                        "response": {"status": "completed", "output": [{
                            "type": "function_call", "id": "fc_docs", "call_id": "call_docs",
                            "name": "docs_lookup", "arguments": '{"query":"runtime"}',
                        }]},
                    }
                else:
                    yield answer("found the page")

            with (
                patch("wandrun.integrations.mcp.MCPAdapter", Adapter),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=AgentCatalog(None, {}), mcp_servers=servers,
                ) as runtime:
                    self.assertEqual(connected, [])
                    role = AgentDefinition("Docs", "Use docs", "offline", mcp_servers=("docs",))
                    with self.assertRaises(ValueError):
                        await runtime.prepare_agents(AgentCatalog(None, {"researcher": role}))
                    self.assertEqual(runtime.agent_models, {})
                    self.assertEqual(runtime.mcp.status("docs", servers["docs"])["status"], "failed")
                    self.assertEqual(closed, ["docs"])  # 失败的发现也必须释放已分配的连接。
                    commit = await runtime.prepare_agents(AgentCatalog(None, {"researcher": role}))
                    self.assertEqual(connected, ["docs", "docs"])
                    self.assertEqual(runtime.agent_models, {})
                    commit()
                    runtime.workers.start("look up runtime", "task", agent_name="researcher")
                    self.assertEqual((await runtime.workers.wait("task"))["status"], "completed")
                    self.assertEqual(calls, ["runtime"])
                    self.assertIn("found:runtime", json.dumps(bodies[1]))
                    (await runtime.prepare_agents(AgentCatalog(None, {
                        "researcher": AgentDefinition("Docs", "No tools", "offline"),
                    })))()
                    self.assertEqual(closed, ["docs"])  # 取消引用不能关闭第二次成功打开的连接。
                self.assertEqual(closed, ["docs", "docs"])

    async def test_unreferenced_mcp_cutover_drops_cached_tools_before_reference_returns(self):
        from dataclasses import replace
        from langchain_core.tools import StructuredTool

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            revision = ["previous-authorization"]
            opened, bodies = [], []
            role = AgentDefinition("Docs", "Use docs", "offline", mcp_servers=("docs",), code_mode=False)

            class Adapter:
                def __init__(self, config):
                    self.client = self
                    self.revision = revision[0]
                    opened.append(self.revision)

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_):
                    pass

                async def close(self):
                    pass

                async def list_tools(self):
                    async def lookup() -> str:
                        return self.revision

                    return [StructuredTool.from_function(
                        coroutine=lookup, name="lookup", description="Read the authorized note",
                    )]

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    yield {
                        "type": "response.completed",
                        "response": {"status": "completed", "output": [{
                            "type": "function_call", "id": "fc_docs", "call_id": "call_docs",
                            "name": "docs_lookup", "arguments": "{}",
                        }]},
                    }
                else:
                    yield answer("received the current note")

            with (
                patch("wandrun.integrations.mcp.MCPAdapter", Adapter),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=AgentCatalog(None, {"reader": role}),
                    mcp_servers={"docs": {"url": "https://example.com/mcp"}},
                ) as runtime:
                    (await runtime.prepare_agents(AgentCatalog(None, {
                        "reader": replace(role, mcp_servers=()),
                    })))()
                    # A credential cutover retires the pool owner while this service has no users.
                    await runtime.mcp.close_service("docs")
                    revision[0] = "current-authorization"
                    await runtime.refresh_mcp("docs")
                    self.assertEqual(opened, ["previous-authorization"],
                                     "refresh must not open an unreferenced connection")
                    (await runtime.prepare_agents(AgentCatalog(None, {"reader": role})))()
                    runtime.workers.start("read the current note", "reauthorized", agent_name="reader")
                    result = await asyncio.wait_for(runtime.workers.wait("reauthorized"), 10)
                    self.assertEqual(result["status"], "completed", result)
                    tool_results = [
                        item["output"] for item in bodies[1]["input"]
                        if item.get("type") == "function_call_output"
                    ]
                    self.assertIn("current-authorization", json.dumps(tool_results))
                    self.assertNotIn("previous-authorization", json.dumps(tool_results))

    async def test_connector_prepare_rejects_refs_and_keeps_live_transport_snapshot(self):
        from dataclasses import replace
        from langchain_core.tools import StructuredTool

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            opened, closed = [], []

            class Adapter:
                def __init__(self, config):
                    self.client = self
                    opened.append(adapter_servers(config)["docs"]["url"])

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_):
                    pass

                async def close(self):
                    closed.append("docs")

                async def list_tools(self):
                    async def lookup() -> str:
                        return "old transport"

                    return [StructuredTool.from_function(
                        coroutine=lookup, name="lookup", description="Look up docs"
                    )]

            old = {"docs": {"url": "https://old.example/mcp"}}
            role = AgentDefinition("Docs", "Use docs", "offline", searchable_mcp_servers=("docs",))
            with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=AgentCatalog(None, {"researcher": role}),
                    mcp_servers=old, mcp_descriptions={"docs": "Old description"},
                ) as runtime:
                    self.assertEqual(opened, ["https://old.example/mcp"])
                    with self.assertRaisesRegex(ValueError, "按需搜索的连接器不存在：docs"):
                        runtime.prepare_connectors({}, {})
                    with self.assertRaisesRegex(ValueError, "description"):
                        runtime.prepare_connectors(old, {})
                    changed = {"docs": {"url": "https://new.example/mcp"}}
                    commit = runtime.prepare_connectors(changed, {"docs": "New description"})
                    commit()
                    self.assertTrue(runtime.mcp.status("docs", changed["docs"])["pending_restart"])
                    candidate = AgentCatalog(None, {"researcher": replace(role, system_prompt="New graph")})
                    (await runtime.prepare_agents(candidate))()
                    self.assertEqual(opened, ["https://old.example/mcp"])
                    self.assertEqual(closed, [])
                self.assertEqual(closed, ["docs"])

    async def test_two_services_recover_changed_directories_without_rebuilding_graph(self):
        from langchain_core.tools import StructuredTool

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            generations = {"a": 0, "b": 0}
            arrived = set()
            both_reopened = asyncio.Event()
            fail_calls = True
            model_tools = []

            class Adapter:
                def __init__(self, config):
                    self.server = next(iter(adapter_servers(config)))
                    self.generation = generations[self.server]
                    generations[self.server] += 1
                    self.client = self

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_):
                    pass

                async def close(self):
                    pass

                async def ping(self):
                    if self.generation == 0:
                        raise ConnectionError("old session closed")
                    return True

                async def list_tools(self, *, cache_mode=None):
                    if self.generation:
                        arrived.add(self.server)
                        if len(arrived) == 2:
                            both_reopened.set()
                        await both_reopened.wait()

                    async def read() -> str:
                        if fail_calls and self.generation == 0:
                            raise ConnectionError("old session closed")
                        return f"{self.server}:{self.generation}"

                    tools = [StructuredTool.from_function(
                        coroutine=read, name="read", description="Read current data",
                    )]
                    if self.generation == 0:
                        async def removed() -> str:
                            return "obsolete"
                        tools.append(StructuredTool.from_function(
                            coroutine=removed, name="removed", description="Old directory entry",
                        ))
                    return tools

            async def respond(model, body):
                model_tools.append({tool["name"] for tool in body["tools"]})
                yield answer("done")

            catalog = AgentCatalog("reader", {"reader": AgentDefinition(
                "Reader", "Use both services", "offline", mcp_servers=("a", "b"),
                environment="local",
            )})
            servers = {name: {"url": f"https://{name}.example/mcp"} for name in ("a", "b")}
            with (patch("wandrun.integrations.mcp.MCPAdapter", Adapter),
                  patch.object(CodexSubscriptionModel, "_arequest", respond)):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, mcp_servers=servers,
                ) as runtime:
                    graph = runtime._assembly_for("reader")
                    runtime.workers.start("list services", "before", agent_name="reader")
                    self.assertEqual((await runtime.workers.wait("before"))["status"], "completed")
                    for name in ("a", "b"):
                        self.assertIn(f"{name}_read", model_tools[-1])
                        self.assertIn(f"{name}_removed", model_tools[-1])
                    originals = {
                        name: {tool.name: tool for tool in await runtime.mcp.open(name, servers[name])}
                        for name in ("a", "b")
                    }
                    for name in ("a", "b"):
                        self.assertIn("调用失败", await originals[name]["read"].ainvoke({}))
                    fail_calls = False
                    with self.assertLogs("wandrun.integrations.mcp", level="WARNING") as captured:
                        async with asyncio.timeout(8):
                            recovered = await asyncio.gather(
                                *(originals[name]["read"].ainvoke({}) for name in ("a", "b"))
                            )
                    self.assertEqual(recovered, ["a:1", "b:1"])
                    self.assertEqual(arrived, {"a", "b"})
                    self.assertIs(runtime._assembly_for("reader"), graph)
                    for name in ("a", "b"):
                        self.assertEqual(
                            await runtime.mcp.open(name, servers[name]),
                            list(originals[name].values()),
                        )
                        self.assertIn(
                            "已不再提供", await originals[name]["removed"].ainvoke({}),
                        )
                    runtime.workers.start("list after recovery", "after", agent_name="reader")
                    self.assertEqual((await runtime.workers.wait("after"))["status"], "completed")
                    self.assertEqual(model_tools[-1], model_tools[0])
                    self.assertIs(runtime._assembly_for("reader"), graph)
                    self.assertEqual(sum("工具目录已变化，沿用首次发现的定义" in line
                                         for line in captured.output), 2)

    async def test_skill_selection_updates_existing_thread_and_sqlite_checkpoint(self):
        from dataclasses import replace

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            for name in ("alpha", "beta", "gamma"):
                skill = workspace.skills_dir / name / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(
                    f"---\nname: {name}\ndescription: {name} selected skill\n---\nUse {name}.\n",
                    encoding="utf-8",
                )
            definition = AgentDefinition("Root", "prompt", "offline", environment="local")
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                yield answer("done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None,
                    agent_catalog=AgentCatalog("main", {"main": definition}),
                ) as runtime:
                    selections = (
                        (), ("alpha",), ("alpha", "beta"), ("beta",),
                        ("gamma",), (), ("alpha",),
                    )
                    for selected in selections:
                        definition = replace(definition, skills=selected)
                        (await runtime.prepare_agents(AgentCatalog("main", {"main": definition})))()
                        runtime.workers.start("next turn", "same-thread")
                        result = await runtime.workers.wait("same-thread")
                        self.assertEqual(result["status"], "completed", result)
                        instructions = bodies[-1]["instructions"]
                        for name in ("alpha", "beta", "gamma"):
                            self.assertEqual(
                                f"**{name}**" in instructions, name in selected,
                                (selected, instructions),
                            )
                        if not selected:
                            self.assertNotIn("## Skills System", instructions)
                        checkpoint = await runtime.checkpointer.aget(conversation_config("same-thread"))
                        state = checkpoint["channel_values"]
                        self.assertEqual(state["skills_selection"], list(selected))
                        self.assertEqual(
                            {skill["name"] for skill in state["skills_metadata"]},
                            set(selected),
                        )

    async def test_running_graph_keeps_old_skills_until_next_execution(self):
        from dataclasses import replace

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            for name in ("alpha", "beta"):
                skill = workspace.skills_dir / name / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(
                    f"---\nname: {name}\ndescription: {name} selected skill\n---\nUse {name}.\n",
                    encoding="utf-8",
                )
            old = AgentDefinition("Root", "prompt", "offline", skills=("alpha",), environment="local")
            entered, release = asyncio.Event(), asyncio.Event()
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    entered.set()
                    await release.wait()
                    response = answer("unused")
                    response["response"]["output"][0]["content"][0]["text"] = json.dumps(
                        {"messages": [], "next": "continue"}
                    )
                    yield response
                else:
                    yield answer("done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None,
                    agent_catalog=AgentCatalog("main", {"main": old}),
                ) as runtime:
                    runtime.workers.start("first turn", "same-thread")
                    await asyncio.wait_for(entered.wait(), 3)
                    (await runtime.prepare_agents(AgentCatalog(
                        "main", {"main": replace(old, skills=("beta",))}
                    )))()
                    release.set()
                    self.assertEqual((await runtime.workers.wait("same-thread"))["status"], "completed")
                    self.assertEqual(len(bodies), 2)
                    for body in bodies[:2]:
                        self.assertIn("**alpha**", body["instructions"])
                        self.assertNotIn("**beta**", body["instructions"])
                    runtime.workers.start("second turn", "same-thread")
                    self.assertEqual((await runtime.workers.wait("same-thread"))["status"], "completed")
                    self.assertEqual(len(bodies), 3)
                    self.assertIn("**beta**", bodies[2]["instructions"])
                    self.assertNotIn("**alpha**", bodies[2]["instructions"])

    async def test_cancel_existing_child_after_removing_last_worker(self):
        from dataclasses import replace

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            parent = AgentDefinition(
                "Parent", "prompt", "parent", workers=("child",), environment="local"
            )
            child = AgentDefinition("Child", "prompt", "child", environment="local")
            child_started = asyncio.Event()
            bodies = []
            child_id = None

            async def respond(model, body):
                if body["model"] == "child":
                    child_started.set()
                    await asyncio.Event().wait()
                    yield answer("unreachable")
                    return
                bodies.append(body)
                if len(bodies) == 2:
                    yield {
                        "type": "response.completed",
                        "response": {
                            "status": "completed",
                            "output": [{
                                "type": "function_call", "id": "cancel_function",
                                "call_id": "cancel_call", "name": "cancel_worker",
                                "arguments": json.dumps({"task_id": child_id}),
                            }],
                        },
                    }
                else:
                    yield answer("done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None,
                    agent_catalog=AgentCatalog("parent", {"parent": parent, "child": child}),
                ) as runtime:
                    runtime.workers.start("first turn", "parent-task")
                    self.assertEqual((await runtime.workers.wait("parent-task"))["status"], "completed")
                    created = runtime.workers.dispatch(
                        AgentOutput(messages=[
                            SendMessage(to="child", task_id=None, message="work")
                        ], next="done"), "parent-task",
                    )[0]
                    self.assertTrue(created["accepted"])
                    child_id = created["task_id"]
                    await asyncio.wait_for(child_started.wait(), 3)
                    (await runtime.prepare_agents(AgentCatalog(
                        "parent", {"parent": replace(parent, workers=()), "child": child}
                    )))()
                    runtime.workers.start("cancel existing child", "parent-task")
                    result = await runtime.workers.wait("parent-task")
                    self.assertEqual(result["status"], "completed", result)
                    self.assertIn("cancel_worker", [tool["name"] for tool in bodies[1]["tools"]])
                    self.assertEqual(runtime.workers.get(child_id)["status"], "cancelled")
                    outputs = [
                        item for item in bodies[2]["input"]
                        if item.get("type") == "function_call_output"
                    ]
                    self.assertTrue(outputs)
                    self.assertEqual(json.loads(outputs[-1]["output"])["status"], "cancelled")


class ConversationFileTests(unittest.IsolatedAsyncioTestCase):
    async def test_task_cwd_is_shared_by_descendants_not_other_roots_across_file_shell_and_process(self):
        from wandrun.runtime.workers import WorkerManager

        async def run(prompts, task_id):
            return AgentOutput(messages=[], next="wait")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manager = WorkerManager(
                run, agent_workers={"main": ("child",), "child": ("leaf",), "leaf": ()},
                default_agent="main",
            )
            self.addAsyncCleanup(manager.close)
            files = TaskFiles(
                root, manager, {role: ("local", str(root)) for role in ("main", "child", "leaf")},
                conversation_workdirs=True,
            )
            manager.start("one", "conversation-one")
            manager.start("two", "conversation-two")
            await manager.wait("conversation-one")
            await manager.wait("conversation-two")
            manager.start("child", "member", sender_id="conversation-one", agent_name="child")
            await manager.wait("member")
            manager.start("leaf", "grandchild", sender_id="member", agent_name="leaf")
            await manager.wait("grandchild")
            for task_id in ("conversation-one", "conversation-two", "member", "grandchild"):
                await files.prepare(task_id)
            self.assertEqual(files.directory("conversation-one"), files.directory("member"))
            self.assertEqual(files.directory("member"), files.directory("grandchild"))
            self.assertNotEqual(files.directory("member"), files.directory("conversation-two"))
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)
            try:
                view = TaskBackend(backend, files.directory)
                (root / "shared-explicit.txt").write_text("workspace access")
                for task_id, text in (("member", "shared"), ("conversation-two", "isolated")):
                    token = _current_task.set(task_id)
                    try:
                        self.assertIsNone((await view.awrite("same.txt", text)).error)
                        self.assertIn(files.directory(task_id), (await view.aexecute("pwd")).output)
                        bound = view.for_code_call()
                    finally:
                        _current_task.reset(token)
                    self.assertIn(text, str((await bound.aread("same.txt")).file_data))
                    self.assertEqual(
                        [item["path"] for item in (await bound.aglob("same.txt")).matches],
                        [str(Path(files.directory(task_id)) / "same.txt")],
                    )
                    self.assertEqual(
                        [item["path"] for item in (await bound.agrep(text)).matches],
                        [str(Path(files.directory(task_id)) / "same.txt")],
                    )
                    self.assertIn(
                        "workspace access",
                        str((await bound.aread(str(root / "shared-explicit.txt"))).file_data),
                    )
                    functions = _script_functions(CodeModeCatalog([], []), bound, _Execution(5))
                    self.assertIn(text, (await functions["read"]("same.txt"))["file_data"]["content"])
                    self.assertIn(files.directory(task_id), (await functions["execute"]("pwd"))["output"])
                self.assertEqual((root / "conversations/conversation-one/same.txt").read_text(), "shared")
                self.assertEqual((root / "conversations/conversation-two/same.txt").read_text(), "isolated")
                table = ProcessTable(cwd=root, log_dir=root / ".wandrun/processes", termination_grace=0.2)
                try:
                    execution = table.start(
                        "pwd", "grandchild", cwd=Path(files.directory("grandchild")),
                        on_settled=lambda execution: None, on_log_error=lambda execution: None,
                    )
                    result = await execution.settled
                    self.assertIn(files.directory("conversation-one"), result["output"])
                finally:
                    await table.aclose()
            finally:
                backend.close()

    async def test_compound_shell_commands_stay_in_cwd_and_failed_cd_stops_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cwd = root / "conversation space"
            cwd.mkdir()
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)
            try:
                view = TaskBackend(backend, lambda task: str(cwd), task_id="task")
                result = await view.aexecute("true & printf proof > result.txt; wait")
                self.assertEqual(result.exit_code, 0, result.output)
                self.assertEqual((cwd / "result.txt").read_text(), "proof")
                self.assertFalse((root / "result.txt").exists())
                missing = TaskBackend(backend, lambda task: str(root / "missing"), task_id="task")
                result = missing.execute("true & printf escaped > failed.txt; wait")
                self.assertNotEqual(result.exit_code, 0)
                self.assertFalse((root / "failed.txt").exists())
            finally:
                backend.close()

    async def test_cleanup_only_empty_directory_and_never_follows_links(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            files = TaskFiles(root, None, {}, conversation_workdirs=True)
            parent = root / "conversations"
            await files.cleanup_conversation("missing")
            parent.mkdir()
            target = parent / "empty"
            target.mkdir()
            await files.cleanup_conversation("empty")
            self.assertFalse(target.exists())
            for name, member in (("hidden", ".keep"), ("child", "nested")):
                target = parent / name
                target.mkdir()
                path = target / member
                path.mkdir() if member == "nested" else path.write_text("keep")
                await files.cleanup_conversation(name)
                self.assertTrue(target.exists())
            outside_file = Path(outside) / "protected"
            outside_file.write_text("safe")
            link = parent / "linked"
            link.symlink_to(outside, target_is_directory=True)
            await files.cleanup_conversation("linked")
            self.assertTrue(link.is_symlink())
            self.assertEqual(outside_file.read_text(), "safe")
            linked_workspace = root / "linked-workspace"
            linked_workspace.mkdir()
            (Path(outside) / "remote-root").mkdir()
            (Path(outside) / "remote-root" / "empty").mkdir()
            (linked_workspace / "conversations").symlink_to(Path(outside) / "remote-root",
                                                               target_is_directory=True)
            linked_files = TaskFiles(linked_workspace, None, {}, conversation_workdirs=True)
            await linked_files.cleanup_conversation("empty")
            self.assertTrue((Path(outside) / "remote-root" / "empty").is_dir())

    async def test_parent_replacement_cannot_redirect_empty_directory_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / "conversations"
            parent.mkdir()
            (parent / "empty").mkdir()
            outside = root / "outside"
            outside.mkdir()
            (outside / "empty").mkdir()
            original_rmdir = os.rmdir

            def replace_parent(name, *, dir_fd):
                self.assertEqual(name, "empty")
                parent.rename(root / "original-parent")
                parent.symlink_to(outside, target_is_directory=True)
                return original_rmdir(name, dir_fd=dir_fd)

            files = TaskFiles(root, None, {}, conversation_workdirs=True)
            with patch("wandrun.runtime.files.os.rmdir", side_effect=replace_parent):
                await files.cleanup_conversation("empty")
            self.assertFalse((root / "original-parent" / "empty").exists())
            self.assertTrue((outside / "empty").is_dir())

    async def test_remote_cleanup_parent_replacement_is_fd_anchored(self):
        from wandrun.integrations.ssh_backend import remote_script

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote"
            parent = remote / "conversations"
            parent.mkdir(parents=True)
            (parent / "empty").mkdir()
            outside = root / "outside"
            outside.mkdir()
            (outside / "empty").mkdir()
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)

            class ReplacingBackend:
                async def aexecute(self, command):
                    args = shlex.split(command)
                    injection = (
                        "import os, pathlib, sys\n"
                        "_rmdir = os.rmdir\n"
                        "def replace(name, *, dir_fd):\n"
                        "    parent = pathlib.Path(sys.argv[1]).parent\n"
                        f"    parent.rename({str(root / 'original-parent')!r})\n"
                        f"    parent.symlink_to({str(outside)!r}, target_is_directory=True)\n"
                        "    return _rmdir(name, dir_fd=dir_fd)\n"
                        "os.rmdir = replace\n"
                    )
                    return await backend.aexecute(remote_script(args[2], injection + args[4], args[5]))

            try:
                files = TaskFiles(
                    root, None, {"ssh": ("host", str(remote))},
                    remote_backends={"ssh": ReplacingBackend()}, conversation_workdirs=True,
                )
                await files.cleanup_conversation("empty")
                self.assertFalse((root / "original-parent" / "empty").exists())
                self.assertTrue((outside / "empty").is_dir())
            finally:
                backend.close()

    async def test_new_ssh_role_preparation_and_control_alias_preflight_without_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote"
            remote.mkdir()
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)
            manager = SimpleNamespace(agent_name=lambda task: "ssh", root_of=lambda task: "conversation")
            files = TaskFiles(
                root, manager, {"main": ("local", str(root))}, conversation_workdirs=True,
            )
            try:
                files.update_environments(
                    {"main": ("local", str(root)), "ssh": ("host", str(remote)),
                     "peer": ("host", str(remote))},
                    {"ssh": backend, "peer": backend},
                )
                await files.prepare("task")
                task_dir = remote / "conversations" / "conversation"
                self.assertTrue(task_dir.is_dir())
                (task_dir / "regular.txt").write_text("normal")
                (task_dir / "alias.txt").symlink_to(task_dir / "regular.txt")
                control = remote / "control"
                control.mkdir()
                (control / "secret").write_text("private")
                (remote / ".wandrun").symlink_to(control, target_is_directory=True)
                (remote / "shortcut").symlink_to(control, target_is_directory=True)
                resolved, receipts = await files.prepare_attachments(
                    "task", "peer", ["regular.txt", "alias.txt", str(remote / ".wandrun/secret"),
                                      str(remote / "shortcut/secret"), str(control / "secret")],
                )
                self.assertEqual([item["accepted"] for item in receipts],
                                 [True, True, False, False, False])
                self.assertEqual([item.name for item in resolved], ["regular.txt", "alias.txt"])
            finally:
                backend.close()

    async def test_remote_preflight_uses_fd_dentry_under_control_entry_replacement(self):
        from wandrun.integrations.ssh_backend import remote_script

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote"
            remote.mkdir()
            control = remote / "control"
            control.mkdir()
            secret = control / "secret"
            secret.write_text("private")
            (remote / ".wandrun").symlink_to(control, target_is_directory=True)
            (remote / "alias").symlink_to(control, target_is_directory=True)
            public = remote / "public"
            public.write_text("public")
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)

            class ReplacingBackend:
                async def aexecute(self, command):
                    args = shlex.split(command)
                    injection = (
                        "import os, pathlib\n"
                        "_readlink = os.readlink\n"
                        "def replace(path):\n"
                        "    actual = _readlink(path)\n"
                        f"    if str(path).startswith('/proc/self/fd/') and actual == {str(secret)!r}:\n"
                        f"        pathlib.Path({str(secret)!r}).rename({str(control / 'held')!r})\n"
                        f"        pathlib.Path({str(secret)!r}).symlink_to({str(public)!r})\n"
                        "    return actual\n"
                        "os.readlink = replace\n"
                    )
                    return await backend.aexecute(remote_script(
                        args[2], injection + args[4], args[5], args[6],
                    ))

            try:
                manager = SimpleNamespace(agent_name=lambda task: "ssh", root_of=lambda task: "conversation")
                files = TaskFiles(
                    root, manager, {"ssh": ("host", str(remote)), "peer": ("host", str(remote))},
                    remote_backends={"ssh": ReplacingBackend()}, conversation_workdirs=False,
                )
                attachments, receipts = await files.prepare_attachments(
                    "task", "peer", [str(remote / "alias/secret")],
                )
                self.assertEqual(attachments, [])
                self.assertFalse(receipts[0]["accepted"])
                self.assertTrue((control / "held").is_file())
            finally:
                backend.close()

    async def test_local_control_alias_rejected_but_other_symlinks_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            control = root / "control"
            control.mkdir()
            (control / "secret").write_text("private")
            (root / ".wandrun").symlink_to(control, target_is_directory=True)
            (root / "control-alias").symlink_to(control, target_is_directory=True)
            normal = root / "normal"
            normal.write_text("public")
            (root / "normal-alias").symlink_to(normal)
            files = TaskFiles(root, None, {}, conversation_workdirs=False)
            for path in (root / ".wandrun/secret", control / "secret", root / "control-alias/secret"):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    files.resolve_delivery(str(path))
            self.assertEqual(files.resolve_delivery(str(root / "normal-alias")).path, str(normal))

    async def test_fd_control_path_is_not_reresolved_after_entry_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            control = root / "control"
            control.mkdir()
            secret = control / "secret"
            secret.write_text("private")
            (root / ".wandrun").symlink_to(control, target_is_directory=True)
            (root / "alias").symlink_to(control, target_is_directory=True)
            public = root / "public"
            public.write_text("public")
            original_readlink = os.readlink

            def replace_after_fd_readlink(path):
                actual = original_readlink(path)
                if str(path).startswith("/proc/self/fd/") and actual == str(secret):
                    secret.rename(control / "held")
                    secret.symlink_to(public)
                return actual

            files = TaskFiles(root, None, {}, conversation_workdirs=False)
            with patch("wandrun.runtime.files.os.readlink", side_effect=replace_after_fd_readlink):
                with self.assertRaises(ValueError):
                    files.resolve_delivery(str(root / "alias/secret"))
            self.assertTrue((control / "held").is_file())
            self.assertTrue(secret.is_symlink())

    async def test_unlinked_open_fd_is_not_a_deliverable_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "removed.txt"
            candidate.write_text("temporary")
            original_open = os.open

            def unlink_after_open(path, flags, *args, **kwargs):
                descriptor = original_open(path, flags, *args, **kwargs)
                if Path(path) == candidate:
                    candidate.unlink()
                return descriptor

            files = TaskFiles(root, None, {}, conversation_workdirs=False)
            with patch("wandrun.runtime.files.os.open", side_effect=unlink_after_open):
                with self.assertRaisesRegex(ValueError, "替换或删除"):
                    files.resolve_delivery(str(candidate))

    async def test_delivery_rejects_control_escape_directory_and_fifo_without_blocking(self):
        from wandrun.runtime.workers import WorkerManager

        async def run(prompts, task_id):
            return AgentOutput(messages=[], next="wait")

        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            manager = WorkerManager(run)
            self.addAsyncCleanup(manager.close)
            files = TaskFiles(root, manager, {"worker": ("local", str(root))}, conversation_workdirs=True)
            manager.start("start", "root")
            await manager.wait("root")
            await files.prepare("root")
            task_dir = Path(files.directory("root"))
            (task_dir / "ok.txt").write_text("hello")
            (task_dir / "folder").mkdir()
            (task_dir / "escape").symlink_to(Path(outside) / "private")
            (Path(outside) / "private").write_text("secret")
            (root / ".wandrun").mkdir()
            (root / ".wandrun/state").write_text("private")
            os.mkfifo(task_dir / "pipe")
            accepted, receipts = files.resolve_attachments(
                "root", "human", ["ok.txt", "folder", "pipe", "escape",
                                  str(root / ".wandrun/state"), str(Path(outside) / "private")],
            )
            self.assertEqual([item["accepted"] for item in receipts],
                             [True, False, False, False, False, False])
            self.assertEqual(accepted[0].path, str(task_dir / "ok.txt"))
            code = (
                "import signal, sys\n"
                "from pathlib import Path\n"
                "from wandrun.runtime.files import TaskFiles\n"
                "f = TaskFiles(Path(sys.argv[1]), None, {}, conversation_workdirs=True)\n"
                "def timeout(signum, frame):\n"
                "    raise TimeoutError('FIFO_OPEN_BLOCKED')\n"
                "signal.signal(signal.SIGALRM, timeout)\n"
                "signal.setitimer(signal.ITIMER_REAL, 2)\n"
                "try:\n"
                "    f.resolve_delivery(sys.argv[2])\n"
                "except ValueError as error:\n"
                "    print(error, file=sys.stderr)\n"
                "    sys.exit(3)\n"
                "finally:\n"
                "    signal.setitimer(signal.ITIMER_REAL, 0)\n"
            )
            # The strict deadline surrounds only FIFO resolution, not cold imports.
            result = subprocess.run(
                [sys.executable, "-c", code, str(root), str(task_dir / "pipe")],
                capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(result.returncode, 3, result.stderr)
            self.assertIn("普通文件", result.stderr)

    async def test_restored_member_keeps_original_root_workdir(self):
        from wandrun.runtime.workers import WorkerManager

        async def run(prompts, task_id):
            return AgentOutput(messages=[], next="wait")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "scheduler.sqlite"
            roles = {"main": ("child",), "child": ()}
            store = SchedulerStore(path)
            first = WorkerManager(run, agent_workers=roles, default_agent="main", store=store)
            files = TaskFiles(
                root, first, {role: ("local", str(root)) for role in roles},
                conversation_workdirs=True,
            )
            try:
                first.start("begin", "conversation")
                await first.wait("conversation")
                first.start("delegate", "member", sender_id="conversation", agent_name="child")
                await first.wait("member")
                await files.prepare("member")
                before = files.directory("member")
                (Path(before) / "persist.txt").write_text("survives")
            finally:
                await first.close()
                store.close()
            restored_store = SchedulerStore(path)
            restored = WorkerManager(run, agent_workers=roles, default_agent="main",
                                     store=restored_store)
            try:
                after = TaskFiles(
                    root, restored, {role: ("local", str(root)) for role in roles},
                    conversation_workdirs=True,
                ).directory("member")
                self.assertEqual(after, before)
                self.assertEqual((Path(after) / "persist.txt").read_text(), "survives")
            finally:
                await restored.close()
                restored_store.close()
