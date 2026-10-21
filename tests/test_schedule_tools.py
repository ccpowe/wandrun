"""Native schedule creation uses the executing task's Agent and Gateway resources."""

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from langchain_core.utils.function_calling import convert_to_openai_tool

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.capabilities import gateway_capabilities
from wandrun.gateway.schedule_tools import schedule_tools
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.session import open_runtime
from wandrun.runtime.workers import WorkerManager
from wandrun.runtime.workspace import Workspace


RULE = {"kind": "once", "local_at": "2099-01-02T10:00"}


def catalog(*, code_mode=False):
    return AgentCatalog("main", {
        "main": AgentDefinition(
            "入口", "完成任务", "offline", workers=("child",), code_mode=code_mode,
            environment="local",
        ),
        "child": AgentDefinition("成员", "完成任务", "offline", environment="local"),
    })


def call(call_id, *, name="提醒", timezone="UTC"):
    args = {"name": name, "content": "明天提醒用户带伞", "rule": RULE, "timezone": timezone}
    return {"name": "create_schedule", "type": "tool_call", "id": call_id, "args": args}


def body(message):
    return json.loads(message.content)


class ScheduleToolTests(unittest.IsolatedAsyncioTestCase):
    async def test_replay_delegated_identity_and_stopped_context(self):
        with tempfile.TemporaryDirectory() as directory:
            store = GatewayStore(Path(directory) / "gateway.sqlite")
            manager = None
            try:
                store.import_agents(catalog())
                gateway = Gateway(store)
                started = asyncio.Event()
                release = asyncio.Event()
                child_started = asyncio.Event()
                child_release = asyncio.Event()

                async def run(prompts, task_id):
                    if task_id == "root":
                        started.set()
                        await release.wait()
                    else:
                        child_started.set()
                        await child_release.wait()
                    return "done"

                manager = WorkerManager(
                    run, agent_workers={"main": ("child",), "child": ()}, default_agent="main"
                )
                gateway.attach(manager)
                tool, = schedule_tools(gateway, manager)
                schema = convert_to_openai_tool(tool)["function"]["parameters"]
                self.assertEqual(set(schema["properties"]), {"name", "content", "rule", "timezone"})
                self.assertNotIn("agent_id", schema["properties"])
                self.assertNotIn("tool_call_id", schema["properties"])

                manager.start("工作", "root", agent_name="main")
                await asyncio.wait_for(started.wait(), 2)
                config = {"configurable": {"thread_id": "root"}}
                first = body(await tool.ainvoke(call("same"), config=config))
                replay = body(await tool.ainvoke(call("same", name="另一个名称"), config=config))
                self.assertEqual(first, replay)
                self.assertEqual(first["agent_id"], "main")
                self.assertEqual(first["timezone"], "UTC")
                self.assertEqual(first["rule"], RULE)
                self.assertIsInstance(first["next_at"], (int, float))
                self.assertEqual(len(store.after(0)), 1)

                manager.start("由成员安排", "child-task", sender_id="root", agent_name="child")
                await asyncio.wait_for(child_started.wait(), 2)
                child_config = {"configurable": {"thread_id": "child-task"}}
                delegated = body(await tool.ainvoke(call("same"), config=child_config))
                self.assertEqual(delegated["agent_id"], "child")
                self.assertNotEqual(delegated["id"], first["id"])
                self.assertEqual(store.schedule(first["id"])["agent_id"], "main")
                self.assertEqual(store.schedule(delegated["id"])["agent_id"], "child")

                invalid = body(await tool.ainvoke(call("bad-zone", timezone="Mars/Phobos"), config=config))
                self.assertIn("error", invalid)
                self.assertEqual(len(store.after(0)), 2)
                without_zone = call("no-local-zone")
                without_zone["args"].pop("timezone")
                with patch("wandrun.gateway.service.local_timezone", return_value=None):
                    missing = body(await tool.ainvoke(without_zone, config=config))
                self.assertIn("error", missing)
                with patch("wandrun.gateway.service.local_timezone", return_value="Asia/Shanghai"):
                    defaulted = body(await tool.ainvoke(without_zone, config=config))
                self.assertEqual(defaulted["timezone"], "Asia/Shanghai")
                self.assertEqual(store.schedule(defaulted["id"])["timezone"], "Asia/Shanghai")
                self.assertEqual(len(store.after(0)), 3)

                await manager.cancel("child-task", cancelled_by="root")
                with self.assertRaises(asyncio.CancelledError):
                    await tool.ainvoke(call("stopped"), config=child_config)
                self.assertEqual(len(store.after(0)), 3)
                gateway.end_streams()
                with self.assertRaisesRegex(RuntimeError, "网关正在退出"):
                    await tool.ainvoke(call("closing"), config=config)
                self.assertEqual(len(store.after(0)), 3)
                release.set()
                await manager.wait("root")
                with self.assertRaises(asyncio.CancelledError):
                    await tool.ainvoke(call("finished"), config=config)
            finally:
                if manager is not None:
                    await manager.close()
                store.close()

    async def test_runtime_rebuild_keeps_native_tool_for_code_mode_role(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.runtime_dir.mkdir()
            workspace.environments_config.write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
            )
            (workspace.runtime_dir / "mcps.toml").write_text("[mcp_servers]\n", encoding="utf-8")
            store = GatewayStore(Path(directory) / "gateway.sqlite")
            try:
                original = catalog(code_mode=True)
                store.import_agents(original)
                gateway = Gateway(store)
                seen = []

                async def respond(model, request):
                    seen.append(request["tools"])
                    if not any(item.get("type") == "function_call_output" for item in request["input"]):
                        yield {"type": "response.completed", "response": {
                            "status": "completed", "output": [{
                                "type": "function_call", "id": "schedule-action",
                                "call_id": "schedule-call", "name": "create_schedule",
                                "arguments": json.dumps(call("ignored")["args"]),
                            }],
                        }}
                    else:
                        answer = json.dumps({"messages": [], "next": "done"})
                        yield {"type": "response.completed", "response": {
                            "status": "completed", "output": [{
                                "type": "message", "id": "answer", "role": "assistant",
                                "phase": "final_answer", "content": [{"type": "output_text", "text": answer}],
                            }],
                        }}

                with (
                    patch.object(CodexSubscriptionModel, "_arequest", respond),
                    patch("wandrun.gateway.schedule_tools.schedule_tools", wraps=schedule_tools) as created,
                ):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir),
                        on_human=lambda *_: None, agent_catalog=original,
                        entry_capabilities=gateway_capabilities(gateway),
                    ) as runtime:
                        gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                        runtime.workers.start("设置提醒", "before", agent_name="main")
                        self.assertEqual((await asyncio.wait_for(runtime.workers.wait("before"), 5))["status"], "completed")
                        updated = AgentCatalog("main", {
                            **original.agents,
                            "main": replace(original.agents["main"], system_prompt="更新后的任务"),
                        })
                        (await runtime.prepare_agents(updated))()
                        runtime.workers.start("再设置提醒", "after", agent_name="main")
                        self.assertEqual((await asyncio.wait_for(runtime.workers.wait("after"), 5))["status"], "completed")
                        self.assertEqual(len(store.schedules("main")), 2)
                        for declarations in seen:
                            names = {item.get("name") for item in declarations}
                            self.assertIn("create_schedule", names)
                            self.assertIn("run_code", names)
                        self.assertEqual(created.call_count, 1)
            finally:
                store.close()
