"""Tool collision boundaries and old/new Code Mode graphs through offline model transport."""

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pydantic_monty as pm
from langchain.agents.middleware import AgentMiddleware
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.config import AgentDefinition
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.runtime.agents import build_agents, run_conversation
from wandrun.runtime.capabilities import EntryCapabilityDefinition
from wandrun.runtime.environments import Environment
from wandrun.runtime.tool_search import ToolNamespace
from wandrun.runtime.workers import WorkerManager

from test_capabilities import tool_call, tool_names
from test_runtime import answer


@tool
def echo(value: str) -> str:
    """Return a value from the MCP fixture."""
    return "MCP:" + value


class MiddlewareToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.backend = ManagedShellBackend(root_dir=self.root, virtual_mode=False)
        self.addCleanup(self.backend.close)
        self.environment = Environment("local", self.backend, str(self.root / "skills"), str(self.root / "artifacts"))
        self.definition = AgentDefinition("Root", "Exercise tools", "offline", code_mode=False)
        self.checkpointer = InMemorySaver()
        self.shown = []

        async def run(prompts, task_id):
            # Select the published graph once, before entering its first await.
            graph = self.assembly.graph
            return await run_conversation(graph, prompts, task_id, "main")

        self.manager = WorkerManager(
            run, agent_workers={"main": ()}, default_agent="main",
            on_human=lambda _, text, *_rest: self.shown.append(text), notify_human_of_roots=False,
        )
        self.addAsyncCleanup(self.manager.close)

    def build(self, **overrides):
        arguments = dict(
            definitions={"main": self.definition}, models={"main": CodexSubscriptionModel(model_name="offline")},
            tools={"main": []}, environments={"main": self.environment}, checkpointer=self.checkpointer,
        )
        arguments.update(overrides)
        return build_agents(self.manager, **arguments)["main"]

    async def run_task(self, task_id):
        self.manager.start("exercise", task_id)
        result = await asyncio.wait_for(self.manager.wait(task_id), 5)
        self.assertEqual(result["status"], "completed", result)

    async def test_duplicate_tools_fail_before_framework_can_overwrite_them(self):
        for source in ("middleware", "direct_mcp", "entry"):
            with self.subTest(source=source):
                duplicate = echo.model_copy(update={"name": "cancel_worker"})
                if source == "middleware":
                    # Even a later, normally tool-free middleware participates in the guard.
                    extra = AgentMiddleware()
                    extra.tools = [duplicate]
                    with patch("wandrun.runtime.agents.ModelRetryMiddleware", return_value=extra):
                        with self.assertRaisesRegex(ValueError, "Agent main.*工具名重复：cancel_worker"):
                            self.build()
                elif source == "direct_mcp":
                    with self.assertRaisesRegex(ValueError, "Agent main.*工具名重复：cancel_worker"):
                        self.build(tools={"main": [duplicate]})
                else:
                    def middleware():
                        item = AgentMiddleware()
                        item.tools = [duplicate]
                        return item
                    with self.assertRaisesRegex(ValueError, "Agent main.*工具名重复：cancel_worker"):
                        self.build(
                            entry_capabilities=(EntryCapabilityDefinition(
                                "entry", "Entry", lambda *_: ("enabled", "Test entry"),
                                lambda *_: middleware,
                            ),),
                            entry_middleware_factories={"local": {"entry": middleware}},
                        )

    async def test_native_search_reservation_includes_middleware_tools(self):
        extra = AgentMiddleware()
        extra.tools = [echo.model_copy(update={"name": "tool_search"})]
        with patch("wandrun.runtime.agents.ModelRetryMiddleware", return_value=extra):
            with self.assertRaisesRegex(ValueError, "Agent main.*tool_search.*按需搜索冲突"):
                self.build(searchable={"main": [ToolNamespace("remote", "Remote", (echo,))]})

    async def test_search_catalog_names_do_not_collide_with_system_or_other_namespaces(self):
        remote = echo.model_copy(update={"name": "cancel_worker"})
        self.assembly = self.build(searchable={"main": [
            ToolNamespace("first", "Remote first lookup", (remote,)),
            ToolNamespace("second", "Remote second lookup", (remote,)),
        ]})
        bodies = []

        async def respond(model, body):
            bodies.append(body)
            if len(bodies) == 1:
                yield {"type": "response.completed", "response": {"status": "completed", "output": [{
                    "type": "tool_search_call", "id": "search", "call_id": "search", "execution": "client",
                    "status": "completed", "arguments": {"query": "Remote lookup"},
                }]}}
            elif len(bodies) in (2, 3):
                namespace = "first" if len(bodies) == 2 else "second"
                response = tool_call("cancel_worker", {"value": namespace}, namespace)
                response["response"]["output"][0]["namespace"] = namespace
                yield response
            else:
                yield answer("remote tools complete")

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            await self.run_task("catalog")
        self.assertIn("MCP:first", json.dumps(bodies[2]["input"]))
        self.assertIn("MCP:second", json.dumps(bodies[3]["input"]))
        self.assertEqual(self.shown, ["remote tools complete"])
        self.assertIn("cancel_worker", tool_names(bodies[0]))

    async def test_code_mode_http_projection_uses_constructed_definition_not_direct_mcp(self):
        from wandrun.config import AgentCatalog

        store = GatewayStore(self.root / "gateway.sqlite")
        self.addCleanup(store.close)
        store.import_agents(AgentCatalog("main", {"main": replace(self.definition, environment="local")}))
        gateway = Gateway(store)
        gateway.runtime = SimpleNamespace(_assembly_for=lambda identity: self.assembly)
        async with pm.AsyncMonty() as pool:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                base_url="http://gateway", headers={"Authorization": "Bearer dev"},
            ) as client:
                async def code_mode():
                    response = await client.get("/agents/main/capabilities")
                    self.assertEqual(response.status_code, 200, response.text)
                    return next(item for item in response.json()["capabilities"] if item["id"] == "code_mode")

                self.assembly = self.build(
                    definitions={"main": replace(self.definition, code_mode=True)},
                    tools={"main": [echo]}, code_pool=pool,
                )
                enabled = await code_mode()
                self.assertEqual((enabled["status"], enabled["tools"]), ("enabled", ["run_code"]))
                self.assertNotIn("echo", enabled["tools"])
                self.assembly = self.build(
                    definitions={"main": replace(self.definition, code_mode=False)},
                    tools={"main": [echo]}, code_pool=pool,
                )
                disabled = await code_mode()
                self.assertEqual((disabled["status"], disabled["reason"], disabled["tools"]),
                                 ("disabled", "未开启", []))
                searchable = self.build(searchable={"main": [ToolNamespace("remote", "Remote", (echo,))]})
                self.assembly = searchable
                response = await client.get("/agents/main/capabilities")
                search = next(item for item in response.json()["capabilities"] if item["id"] == "tool_search")
                self.assertEqual((search["status"], search["tools"]), ("enabled", []))

    async def test_code_mode_rebuild_keeps_inflight_graph_and_next_graph_selection(self):
        entered, release = asyncio.Event(), asyncio.Event()
        requests = {}

        async def respond(model, body):
            task_id = body["prompt_cache_key"]
            requests.setdefault(task_id, []).append(body)
            if len(requests[task_id]) == 1 and task_id != "disabled":
                if task_id == "inflight":
                    entered.set()
                    await release.wait()
                destination = str(self.root / (task_id + ".txt"))
                yield tool_call("run_code", {"code": (
                    f"result = await tools.echo(value={task_id!r})\n"
                    f"await write({destination!r}, result)\nprint(result)"
                )}, "code-" + task_id)
            else:
                yield answer("done " + task_id)

        async with pm.AsyncMonty() as pool:
            def rebuild(enabled):
                return self.build(
                    definitions={"main": replace(self.definition, code_mode=enabled)},
                    tools={"main": [echo]}, code_pool=pool,
                )

            self.assembly = rebuild(True)
            self.assertEqual(self.assembly.capabilities.entries["code_mode"].tools, ("run_code",))
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                try:
                    self.manager.start("code", "inflight")
                    await asyncio.wait_for(entered.wait(), 5)
                    self.assembly = rebuild(False)
                    self.assertEqual(self.assembly.capabilities.entries["code_mode"].tools, ())
                    await self.run_task("disabled")
                    self.assertNotIn("run_code", tool_names(requests["disabled"][0]))
                    release.set()
                    result = await asyncio.wait_for(self.manager.wait("inflight"), 5)
                    self.assertEqual(result["status"], "completed", result)
                    self.assertEqual((self.root / "inflight.txt").read_text(), "MCP:inflight")
                    for request in requests["inflight"]:
                        self.assertIn("run_code", tool_names(request))
                    self.assembly = rebuild(True)
                    await self.run_task("reenabled")
                    self.assertIn("run_code", tool_names(requests["reenabled"][0]))
                    self.assertEqual((self.root / "reenabled.txt").read_text(), "MCP:reenabled")
                finally:
                    release.set()
                    # The pool is runtime-owned: finish graph calls before releasing it.
                    await self.manager.close()
