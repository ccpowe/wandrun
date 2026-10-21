"""Gateway entry capabilities remain coherent across graph construction and rebuilds."""

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.capabilities import UI_CAPABILITY, gateway_capabilities
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.ui_blocks import model_instructions
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.agents import build_agents
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.environments import Environment
from wandrun.runtime.files import TaskFiles
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.session import open_runtime
from wandrun.runtime.workers import WorkerManager
from wandrun.runtime.workspace import Workspace


class GatewayEntryCapabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_entry_tool_rejects_mcp_name_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = GatewayStore(root / "gateway.sqlite")
            self.addCleanup(store.close)
            role = AgentDefinition("Main", "Work", "offline", environment="local", code_mode=False)
            store.import_agents(AgentCatalog("main", {"main": role}))
            gateway = Gateway(store)
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)
            self.addCleanup(backend.close)
            environment = Environment("local", backend, str(root / "skills"), str(root / "artifacts"))

            async def idle(_prompts, _task_id):
                return "done"

            manager = WorkerManager(idle, agent_workers={"main": ()}, default_agent="main")
            self.addAsyncCleanup(manager.close)
            files = TaskFiles(root, manager, {"main": ("local", str(root))}, conversation_workdirs=False)
            schedule, image, ui = gateway_capabilities(gateway)
            factories = {
                capability.id: capability.prepare_middleware(manager, files, "local")
                for capability in (schedule, image, ui)
            }

            @tool
            def mcp_schedule(name: str) -> str:
                """A connector whose public name collides with the gateway host tool."""
                return name

            with self.assertRaisesRegex(ValueError, "Agent main.*工具名重复：create_schedule"):
                build_agents(
                    manager, definitions={"main": role},
                    models={"main": CodexSubscriptionModel(model_name="offline")},
                    tools={"main": [mcp_schedule.model_copy(update={"name": "create_schedule"})]},
                    environments={"main": environment}, checkpointer=InMemorySaver(),
                    entry_capabilities=(schedule,),
                    entry_middleware_factories={"local": {"schedule": factories["schedule"]}},
                )

    async def test_empty_catalog_can_add_ssh_agent_with_prestaged_ui_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.runtime_dir.mkdir()
            workspace.environments_config.write_text(
                'default = "server"\n[environments.server]\ntype = "ssh"\n'
                f'host = "unused.invalid"\nworkdir = {json.dumps(str(workspace.root))}\n',
                encoding="utf-8",
            )
            workspace.mcps_config.write_text('[mcp_servers]\n', encoding="utf-8")
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            gateway = Gateway(store)
            catalog = AgentCatalog(None, {})
            staged = []

            async def environments(config, root, stack, opened, *, include_default, builtin_source=None):
                # Simulate a synchronized SSH snapshot without contacting a host. The
                # default environment must open even when no Agent exists yet.
                self.assertTrue(include_default)
                self.assertIsNotNone(builtin_source)
                self.assertTrue((builtin_source / "wandrun-ui" / "SKILL.md").is_file())
                staged.append(builtin_source)
                backend = ManagedShellBackend(root_dir=root.root, virtual_mode=False)
                stack.callback(backend.close)
                environment = Environment(
                    "server", backend, str(root.skills_dir), str(root.runtime_dir / "artifacts"),
                    synced_skills=frozenset(), builtin_skills_source=str(builtin_source),
                    builtin_skills=frozenset(UI_CAPABILITY.builtin_skills), type="ssh",
                )
                opened.append(environment)
                return {name: environment for name in config.agents}

            requests = []

            async def respond(model, body):
                requests.append(body)
                self.assertIn("**wandrun-ui**", body["instructions"])
                yield {"type": "response.completed", "response": {
                    "status": "completed",
                    "output": [{"type": "message", "id": "answer", "role": "assistant",
                                "phase": "final_answer", "content": [{
                        "type": "output_text", "text": json.dumps({"messages": [], "next": "done"}),
                    }]}],
                }}

            with (
                patch("wandrun.runtime.session.open_environments", side_effect=environments),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None, agent_catalog=catalog,
                    entry_capabilities=gateway_capabilities(gateway),
                ) as runtime:
                    client = httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                        base_url="http://gateway", headers={"Authorization": "Bearer dev"},
                    )
                    async with client:
                        gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                        empty = (await client.get("/builtin-skills")).json()["skills"]
                        self.assertEqual([item["name"] for item in empty], ["wandrun-ui"])
                        self.assertEqual(empty[0]["used_by"], [])
                        added = AgentCatalog("new", {
                            "new": AgentDefinition("New", "Work", "offline", environment="server"),
                        })
                        (await runtime.prepare_agents(added))()
                        store.create_agent("new", added.agents["new"], "New", None, "ssh-new")
                        response = await client.get("/agents/new/capabilities")
                        self.assertEqual(response.status_code, 200, response.text)
                        entries = {item["id"]: item for item in response.json()["capabilities"]}
                        self.assertEqual(entries["files"]["tools"][-1], "execute")
                        self.assertEqual((entries["processes"]["status"], entries["processes"]["reason"],
                                          entries["processes"]["tools"]),
                                         ("not_applicable", "需要本机环境", []))
                        self.assertEqual((entries["image_generation"]["status"], entries["image_generation"]["reason"],
                                          entries["image_generation"]["tools"]),
                                         ("not_applicable", "需要本机环境", []))
                        self.assertEqual((await client.get("/builtin-skills")).json()["skills"][0]["used_by"],
                                         [{"id": "new", "name": "New"}])
                        self.assertEqual(
                            (await client.get("/builtin-skills/wandrun-ui")).json()["content"],
                            UI_CAPABILITY.builtin_skills["wandrun-ui"]["SKILL.md"],
                        )
                    runtime.workers.start("Read builtin", "remote-first", agent_name="new")
                    result = await asyncio.wait_for(runtime.workers.wait("remote-first"), 5)
                    self.assertEqual(result["status"], "completed", result)
                    self.assertEqual(
                        {tool.get("name", tool["type"]) for tool in requests[0]["tools"]} - {"cancel_worker"},
                        {tool for item in entries.values() for tool in item["tools"]},
                    )
                    saved = await runtime.checkpointer.aget_tuple(conversation_config("remote-first"))
                    selected, = saved.checkpoint["channel_values"]["skills_metadata"]
                    self.assertEqual(selected["name"], "wandrun-ui")
                    self.assertTrue(Path(selected["path"]).is_file())
            self.assertEqual(len(staged), 1)

    async def test_ui_validation_count_and_instructions_survive_rebuild(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.runtime_dir.mkdir()
            workspace.environments_config.write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8",
            )
            workspace.mcps_config.write_text('[mcp_servers]\n', encoding="utf-8")
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            role = AgentDefinition("Main", "Complete work", "offline", environment="local")
            catalog = AgentCatalog("main", {"main": role})
            store.import_agents(catalog)
            gateway = Gateway(store)
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                yield {"type": "response.completed", "response": {
                    "status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{
                        "type": "output_text", "text": json.dumps({"messages": [], "next": "done"}),
                    }]}],
                }}

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=gateway.on_human, agent_catalog=catalog,
                    entry_capabilities=gateway_capabilities(gateway),
                ) as runtime:
                    gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                    conversation = gateway.create_conversation("UI", "main")["id"]
                    runtime.workers.start("First", conversation, agent_name="main")
                    self.assertEqual((await asyncio.wait_for(runtime.workers.wait(conversation), 5))["status"], "completed")
                    invalid = AgentOutput(messages=[SendMessage(
                        to="human", task_id=None, message="```wandrun-ui\n{invalid}\n```",
                    )], next="wait")
                    for _ in range(2):
                        self.assertFalse(runtime.workers.dispatch(invalid, conversation)[0]["accepted"])
                    changed = AgentCatalog("main", {"main": replace(role, system_prompt="Updated")})
                    (await runtime.prepare_agents(changed))()
                    accepted = runtime.workers.dispatch(invalid, conversation)[0]
                    self.assertTrue(accepted["accepted"])
                    self.assertFalse(store.history(conversation)[-1].data["ui"][0]["valid"])
                    runtime.workers.start("Again", conversation, agent_name="main")
                    self.assertEqual((await asyncio.wait_for(runtime.workers.wait(conversation), 5))["status"], "completed")
                    self.assertEqual(len(bodies), 2)
                    for body in bodies:
                        self.assertEqual(body["instructions"].count(model_instructions()), 1)
                    saved = await runtime.checkpointer.aget_tuple(conversation_config(conversation))
                    self.assertEqual(
                        {skill["name"] for skill in saved.checkpoint["channel_values"]["skills_metadata"]},
                        set(UI_CAPABILITY.builtin_skills),
                    )

    async def test_only_enabled_entry_skills_are_loaded_for_each_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.runtime_dir.mkdir()
            workspace.environments_config.write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8",
            )
            workspace.mcps_config.write_text('[mcp_servers]\n', encoding="utf-8")
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            catalog = AgentCatalog("enabled", {
                "enabled": AgentDefinition("Enabled", "Work", "offline", environment="local", name="Enabled"),
                "disabled": AgentDefinition("Disabled", "Work", "offline", environment="local", name="Disabled"),
            })
            store.import_agents(catalog)
            gateway = Gateway(store)
            bodies = {}

            async def respond(model, body):
                bodies[body["prompt_cache_key"]] = body
                yield {"type": "response.completed", "response": {
                    "status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{
                        "type": "output_text", "text": json.dumps({"messages": [], "next": "done"}),
                    }]}],
                }}

            capabilities = list(gateway_capabilities(gateway))
            capabilities[-1] = replace(capabilities[-1], condition=lambda role, _: (
                ("enabled", "Selected") if role.description == "Enabled" else ("disabled", "Not selected")
            ))
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None, agent_catalog=catalog,
                    entry_capabilities=capabilities,
                ) as runtime:
                    gateway.runtime = runtime
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                        base_url="http://gateway", headers={"Authorization": "Bearer dev"},
                    ) as client:
                        builtin = (await client.get("/builtin-skills")).json()["skills"]
                        self.assertEqual(builtin[0]["used_by"], [{"id": "enabled", "name": "Enabled"}])
                        enabled = (await client.get("/agents/enabled/capabilities")).json()["capabilities"]
                        disabled = (await client.get("/agents/disabled/capabilities")).json()["capabilities"]
                        self.assertEqual(next(item for item in enabled if item["id"] == "ui_blocks")["skills"],
                                         ["wandrun-ui"])
                        self.assertEqual(next(item for item in disabled if item["id"] == "ui_blocks")["skills"], [])
                    for agent_id in ("enabled", "disabled"):
                        runtime.workers.start("Show skills", agent_id, agent_name=agent_id)
                        result = await asyncio.wait_for(runtime.workers.wait(agent_id), 5)
                        self.assertEqual(result["status"], "completed", result)
                        saved = await runtime.checkpointer.aget_tuple(conversation_config(agent_id))
                        names = {skill["name"] for skill in saved.checkpoint["channel_values"]["skills_metadata"]}
                        self.assertEqual(names, {"wandrun-ui"} if agent_id == "enabled" else set())
                    self.assertEqual(bodies["enabled"]["instructions"].count(model_instructions()), 1)
                    self.assertNotIn(model_instructions(), bodies["disabled"]["instructions"])
