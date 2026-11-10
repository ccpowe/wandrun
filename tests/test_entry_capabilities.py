"""Gateway entry capabilities remain coherent across graph construction and rebuilds."""

import asyncio
import base64
import json
import re
import tempfile
import unittest
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.capabilities import UI_CAPABILITY, gateway_capabilities
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.ui_blocks import model_instructions
from wandrun.integrations import file_transfer
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.agent.agents import build_agents
from wandrun.runtime.agent.conversations import conversation_config
from wandrun.runtime.execution.environments import Environment, open_environments
from wandrun.runtime.execution.files import TaskFiles
from wandrun.runtime.communication.messages import AgentOutput, SendMessage
from wandrun.runtime.session import open_runtime
from wandrun.runtime.communication.workers import WorkerManager
from wandrun.runtime.execution.workspace import Workspace
from test_environments import loopback_instabox
from test_file_transfer import remote_backend
from test_runtime import answer, configure


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
            schedule, image, uploads, ui = gateway_capabilities(gateway)
            factories = {
                capability.id: capability.prepare_middleware(manager, files, "local")
                for capability in (schedule, image, uploads, ui)
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

    async def test_empty_catalog_can_add_instabox_agent_with_readable_builtin_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.runtime_dir.mkdir()
            remote_root = workspace.root / "remote"
            workspace.environments_config.write_text(
                'default = "server"\n[environments.server]\ntype = "instabox"\n'
                f'machine_id = "m_{"a" * 26}"\nworkdir = {json.dumps(str(remote_root))}\n',
                encoding="utf-8",
            )
            workspace.mcps_config.write_text('[mcp_servers]\n', encoding="utf-8")
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            gateway = Gateway(store)
            catalog = AgentCatalog(None, {})
            requests = []
            read_path = None
            read_outputs = []

            async def respond(model, body):
                requests.append(body)
                self.assertIn("**wandrun-ui**", body["instructions"])
                outputs = [item["output"] for item in body["input"] if item.get("type") == "function_call_output"]
                if read_path is not None and not outputs:
                    yield {"type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "function_call", "id": "builtin-read", "call_id": "builtin-call",
                            "name": "read_file", "arguments": json.dumps({"file_path": read_path}),
                        }],
                    }}
                    return
                read_outputs.extend(outputs)
                yield {"type": "response.completed", "response": {
                    "status": "completed",
                    "output": [{"type": "message", "id": "answer", "role": "assistant",
                                "phase": "final_answer", "content": [{
                        "type": "output_text", "text": json.dumps({"messages": [], "next": "done"}),
                    }]}],
                }}

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with loopback_instabox() as prepared, open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None, agent_catalog=catalog,
                    entry_capabilities=gateway_capabilities(gateway),
                ) as runtime:
                    self.assertEqual(prepared, [])
                    self.assertFalse(remote_root.exists())
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
                        store.create_agent("new", added.agents["new"], "New", None, "instabox-new")
                        response = await client.get("/agents/new/capabilities")
                        self.assertEqual(response.status_code, 200, response.text)
                        entries = {item["id"]: item for item in response.json()["capabilities"]}
                        self.assertNotIn("execute", entries["files"]["tools"])
                        self.assertEqual(entries["processes"]["status"], "enabled")
                        self.assertIn("exec_command", entries["processes"]["tools"])
                        self.assertEqual((entries["image_generation"]["status"], entries["image_generation"]["tools"]),
                                         ("enabled", ["generate_image"]))
                        self.assertEqual((await client.get("/builtin-skills")).json()["skills"][0]["used_by"],
                                         [{"id": "new", "name": "New"}])
                        self.assertEqual(
                            (await client.get("/builtin-skills/wandrun-ui")).json()["content"],
                            UI_CAPABILITY.builtin_skills["wandrun-ui"]["SKILL.md"],
                        )
                        runtime.workers.start("Discover builtin", "remote-first", agent_name="new")
                        result = await asyncio.wait_for(runtime.workers.wait("remote-first"), 5)
                        self.assertEqual(result["status"], "completed", result)
                        self.assertEqual(
                            {tool.get("name", tool["type"]) for tool in requests[0]["tools"]} - {"cancel_worker"},
                            {tool for item in entries.values() for tool in item["tools"]},
                        )
                        saved = await runtime.checkpointer.aget_tuple(conversation_config("remote-first"))
                        selected, = saved.checkpoint["channel_values"]["skills_metadata"]
                        self.assertEqual(selected["name"], "wandrun-ui")
                        self.assertEqual(prepared, [])  # Graph metadata is gateway-owned.
                        self.assertFalse(Path(selected["path"]).exists())
                        read_path = selected["path"]
                        rebuilt = AgentCatalog("new", {
                            "new": replace(added.agents["new"], system_prompt="Read the builtin skill"),
                        })
                        (await runtime.prepare_agents(rebuilt))()
                        response = await client.get("/agents/new/capabilities")
                        self.assertEqual(
                            {item["id"]: item for item in response.json()["capabilities"]}, entries,
                        )
                        runtime.workers.start("Read builtin", "remote-rebuilt", agent_name="new")
                        result = await asyncio.wait_for(runtime.workers.wait("remote-rebuilt"), 10)
                        self.assertEqual(result["status"], "completed", result)
                        self.assertEqual(len(prepared), 1)
                        self.assertEqual(
                            Path(read_path).read_text(encoding="utf-8"),
                            UI_CAPABILITY.builtin_skills["wandrun-ui"]["SKILL.md"],
                        )
                        self.assertTrue(read_outputs)
                self.assertTrue(prepared[0]._closed)

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
                    conversation = gateway.create_conversation("UI", "main", client_id=uuid4().hex)[0]["id"]
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
                'default = "server"\n[environments.server]\ntype = "instabox"\n'
                f'machine_id = "m_{"b" * 26}"\nworkdir = {json.dumps(str(workspace.root / "remote"))}\n',
                encoding="utf-8",
            )
            workspace.mcps_config.write_text('[mcp_servers]\n', encoding="utf-8")
            reserved = workspace.skills_dir / "wandrun-ui"
            reserved.mkdir(parents=True)
            (reserved / "SKILL.md").write_text(
                "---\nname: wandrun-ui\ndescription: User override must stay reserved\n---\n",
                encoding="utf-8",
            )
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            catalog = AgentCatalog("enabled", {
                "enabled": AgentDefinition(
                    "Enabled", "Work", "offline", environment="server", name="Enabled", skills=("wandrun-ui",),
                ),
                "disabled": AgentDefinition(
                    "Disabled", "Work", "offline", environment="server", name="Disabled", skills=("wandrun-ui",),
                ),
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
                async with loopback_instabox() as prepared, open_runtime(
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
                    self.assertEqual(prepared, [])
                    for body in bodies.values():
                        self.assertNotIn("User override must stay reserved", body["instructions"])

    async def test_upload_capability_executes_direct_fetch_with_local_and_instabox_in_both_code_modes(self):
        for remote in (False, True):
            for code_mode in (False, True):
                with self.subTest(remote=remote, code_mode=code_mode), tempfile.TemporaryDirectory() as directory:
                    workspace = configure(Path(directory))
                    remote_root = workspace.root / "sandbox"
                    environment_name = "cloud" if remote else "local"
                    if remote:
                        workspace.environments_config.write_text(
                            'default = "cloud"\n[environments.cloud]\ntype = "instabox"\n'
                            f'machine_id = "m_{"a" * 26}"\nworkdir = {json.dumps(str(remote_root))}\n',
                            encoding="utf-8",
                        )
                    store = GatewayStore(workspace.state_dir / "gateway.sqlite")
                    self.addCleanup(store.close)
                    role = AgentDefinition("Main", "Read the supplied upload", "offline",
                                           environment=environment_name, code_mode=code_mode)
                    catalog = AgentCatalog("main", {"main": role})
                    store.import_agents(catalog)
                    gateway = Gateway(store)
                    bodies, fetched, read_outputs = [], [], []

                    async def environment_factory(config, current_workspace, stack, opened, **options):
                        if not remote:
                            return await open_environments(config, current_workspace, stack, opened, **options)
                        backend = await stack.enter_async_context(remote_backend(remote_root))
                        environment = Environment(
                            "cloud", backend, str(current_workspace.skills_dir),
                            str(remote_root / ".wandrun" / "artifacts"),
                            processes=backend.processes, type="instabox",
                        )
                        opened.append(environment)
                        return {"main": environment}

                    async def respond(model, body):
                        bodies.append(body)
                        names = [item.get("name") for item in body["tools"]]
                        self.assertEqual(names.count("fetch_upload"), 1)
                        self.assertEqual("run_code" in names, code_mode)
                        outputs = {item.get("call_id"): item["output"] for item in body["input"]
                                   if item.get("type") == "function_call_output"}
                        if "read-upload" in outputs:
                            read_outputs.append(outputs["read-upload"])
                            yield answer("read complete")
                            return
                        if "fetch-upload" in outputs:
                            result = json.loads(outputs["fetch-upload"])
                            self.assertNotIn("error", result)
                            fetched.append(result)
                            call_id, name, arguments = "read-upload", "read_file", {"file_path": result["path"]}
                        else:
                            references = set(re.findall(r"\bf_[0-9a-f]{32}\b", json.dumps(body["input"])))
                            self.assertEqual(len(references), 1)
                            call_id, name, arguments = "fetch-upload", "fetch_upload", {"upload_id": references.pop()}
                        yield {
                            "type": "response.completed",
                            "response": {"status": "completed", "output": [{
                                "type": "function_call", "id": call_id, "call_id": call_id,
                                "name": name, "arguments": json.dumps(arguments),
                            }]},
                        }

                    with patch("wandrun.runtime.session.open_environments", side_effect=environment_factory), \
                            patch.object(CodexSubscriptionModel, "_arequest", respond):
                        async with open_runtime(
                            workspace, metrics=RunMetrics(workspace.runs_dir), on_human=gateway.on_human,
                            agent_catalog=catalog, entry_capabilities=gateway_capabilities(gateway),
                            on_task=gateway.on_task, conversation_workdirs=True, notify_human_of_roots=False,
                        ) as runtime:
                            gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                            gateway.enable_uploads()
                            conversation = gateway.create_conversation("Upload", "main", client_id=uuid4().hex)[0]["id"]
                            async with httpx.AsyncClient(
                                transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                                base_url="http://gateway", headers={"Authorization": "Bearer dev"},
                            ) as client:
                                metadata = ",".join(
                                    f"{key} {base64.b64encode(value.encode()).decode()}"
                                    for key, value in {"conversation_id": conversation, "filename": "evidence.txt",
                                                       "filetype": "text/plain"}.items()
                                )
                                content = b"gateway-upload-evidence"
                                created = await client.post("/uploads", headers={
                                    "Tus-Resumable": "1.0.0", "Upload-Length": str(len(content)),
                                    "Upload-Metadata": metadata,
                                })
                                self.assertEqual(created.status_code, 201, created.text)
                                completed = await client.patch(created.headers["Location"], content=content, headers={
                                    "Tus-Resumable": "1.0.0", "Upload-Offset": "0",
                                    "Content-Type": "application/offset+octet-stream",
                                })
                                self.assertEqual(completed.status_code, 204, completed.text)
                                upload_id = completed.headers["Upload-File-Id"]
                                entries = (await client.get("/agents/main/capabilities")).json()["capabilities"]
                                entry = next(item for item in entries if item["id"] == "uploads")
                                self.assertEqual((entry["status"], entry["tools"]), ("enabled", ["fetch_upload"]))
                                gateway.send_message(conversation, "fetch-upload-message", "Read it", [upload_id])
                                result = await asyncio.wait_for(runtime.workers.wait(conversation), 15)
                                self.assertEqual(result["status"], "completed", result)
                                self.assertEqual(len(fetched), 1)
                                self.assertEqual(Path(fetched[0]["path"]).read_bytes(), content)
                                self.assertIn(content.decode(), "\n".join(read_outputs))
                                expected_root = remote_root if remote else workspace.root
                                self.assertTrue(Path(fetched[0]["path"]).is_relative_to(expected_root / "conversations" / conversation))

    async def test_headless_graph_never_advertises_upload_tools_without_gateway_entry(self):
        for code_mode in (False, True):
            with self.subTest(code_mode=code_mode), tempfile.TemporaryDirectory() as directory:
                workspace = configure(Path(directory))
                catalog = AgentCatalog("main", {"main": AgentDefinition(
                    "Main", "Chat only", "offline", environment="local", code_mode=code_mode,
                )})
                requests = []

                async def respond(model, body):
                    requests.append(body)
                    yield answer("chat")

                with patch.object(CodexSubscriptionModel, "_arequest", respond):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                        agent_catalog=catalog,
                    ) as runtime:
                        runtime.workers.start("Chat", "headless")
                        self.assertEqual((await runtime.workers.wait("headless"))["status"], "completed")
                        self.assertNotIn("uploads", runtime._assembly_for("main").capabilities.entries)
                        self.assertNotIn("fetch_upload", [item.get("name") for item in requests[0]["tools"]])

    async def test_local_upload_reference_reaches_cloud_through_history_or_delegation(self):
        for scenario in ("switch", "delegate"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                workspace = configure(Path(directory))
                remote_root = workspace.root / "sandbox"
                workspace.environments_config.write_text(
                    'default = "local"\n[environments.local]\ntype = "local"\n'
                    '[environments.cloud]\ntype = "instabox"\n'
                    f'machine_id = "m_{"a" * 26}"\nworkdir = {json.dumps(str(remote_root))}\n',
                    encoding="utf-8",
                )
                definitions = {"main": AgentDefinition(
                    "Root", "Handle the supplied upload", "parent", environment="local",
                    workers=("cloudchild",) if scenario == "delegate" else (), code_mode=True,
                )}
                if scenario == "delegate":
                    definitions["cloudchild"] = AgentDefinition(
                        "Cloud", "Read the upload identified in your input", "child",
                        environment="cloud", code_mode=True,
                    )
                catalog = AgentCatalog("main", definitions)
                store = GatewayStore(workspace.state_dir / "gateway.sqlite")
                self.addCleanup(store.close)
                store.import_agents(catalog)
                gateway = Gateway(store)
                phase, delegated = "remember", False
                observed, fetched, read_outputs = [], [], []

                @asynccontextmanager
                async def open_cloud(name, definition, current_workspace, builtin_source=None):
                    async with remote_backend(Path(definition.workdir)) as backend:
                        yield Environment(
                            name, backend, str(current_workspace.skills_dir),
                            str(Path(definition.workdir) / ".wandrun" / "artifacts"),
                            processes=backend.processes, type="instabox",
                        )

                async def respond(model, body):
                    nonlocal delegated
                    references = set(re.findall(r"\bf_[0-9a-f]{32}\b", json.dumps(body["input"])))
                    self.assertEqual(len(references), 1)
                    reference = references.pop()
                    observed.append((model.model_name, phase, reference))
                    if scenario == "switch" and phase == "remember":
                        output = {"messages": [], "next": "done"}
                    elif scenario == "delegate" and model.model_name == "parent":
                        output = {"messages": [] if delegated else [{
                            "to": "cloudchild", "task_id": None, "attachments": [],
                            "message": f"Read the supplied user upload {reference} in your environment.",
                        }], "next": "done"}
                        delegated = True
                    else:
                        outputs = {item.get("call_id"): item["output"] for item in body["input"]
                                   if item.get("type") == "function_call_output"}
                        if "history-read" in outputs:
                            read_outputs.append(outputs["history-read"])
                            output = {"messages": [], "next": "done"}
                        else:
                            if "history-fetch" in outputs:
                                result = json.loads(outputs["history-fetch"])
                                self.assertNotIn("error", result)
                                fetched.append(result)
                                call_id, name, arguments = "history-read", "read_file", {"file_path": result["path"]}
                            else:
                                self.assertIn("fetch_upload", [item.get("name") for item in body["tools"]])
                                call_id, name, arguments = "history-fetch", "fetch_upload", {"upload_id": reference}
                            yield {"type": "response.completed", "response": {
                                "status": "completed", "output": [{
                                    "type": "function_call", "id": call_id, "call_id": call_id,
                                    "name": name, "arguments": json.dumps(arguments),
                                }],
                            }}
                            return
                    yield {"type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "message", "id": "finish", "role": "assistant", "phase": "final_answer",
                            "content": [{"type": "output_text", "text": json.dumps(output)}],
                        }],
                    }}

                with (
                    patch("wandrun.runtime.execution.environments.open_instabox", open_cloud),
                    patch("wandrun.runtime.session.open_instabox", open_cloud),
                    patch.object(CodexSubscriptionModel, "_arequest", respond),
                ):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir), on_human=gateway.on_human,
                        agent_catalog=catalog, entry_capabilities=gateway_capabilities(gateway),
                        on_task=gateway.on_task, on_task_created=gateway.on_task_created,
                        on_task_message=gateway.on_task_message, conversation_workdirs=True,
                        notify_human_of_roots=False,
                    ) as runtime:
                        gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                        gateway.enable_uploads()
                        conversation = gateway.create_conversation("Keep the upload reference", "main", client_id=uuid4().hex)[0]["id"]
                        async with httpx.AsyncClient(
                            transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                            base_url="http://gateway", headers={"Authorization": "Bearer dev"},
                        ) as client:
                            content = b"opaque-upload-reference-evidence"
                            metadata = ",".join(
                                f"{key} {base64.b64encode(value.encode()).decode()}"
                                for key, value in {"conversation_id": conversation, "filename": "reference.txt",
                                                   "filetype": "text/plain"}.items()
                            )
                            created = await client.post("/uploads", headers={
                                "Tus-Resumable": "1.0.0", "Upload-Length": str(len(content)),
                                "Upload-Metadata": metadata,
                            })
                            self.assertEqual(created.status_code, 201, created.text)
                            completed = await client.patch(created.headers["Location"], content=content, headers={
                                "Tus-Resumable": "1.0.0", "Upload-Offset": "0",
                                "Content-Type": "application/offset+octet-stream",
                            })
                            self.assertEqual(completed.status_code, 204, completed.text)
                            file_id = completed.headers["Upload-File-Id"]
                            source = store.user_uploads(conversation, [file_id])[0][1]
                            gateway.send_message(conversation, "initial-upload", "Keep this upload for the requested work", [file_id])
                            self.assertEqual((await asyncio.wait_for(runtime.workers.wait(conversation), 15))["status"], "completed")
                            if scenario == "switch":
                                snapshot = await runtime._assembly_for("main").graph.aget_state(conversation_config(conversation))
                                self.assertIn(file_id, repr(snapshot.values["messages"]))
                                selected = await client.patch("/agents/main", json={"environment": "cloud"})
                                self.assertEqual(selected.status_code, 200, selected.text)
                                phase = "cloud"
                                gateway.send_message(conversation, "continue-in-cloud", "Read the earlier upload in this environment")
                                self.assertEqual((await asyncio.wait_for(runtime.workers.wait(conversation), 15))["status"], "completed")
                                self.assertTrue(any(turn == "cloud" for _, turn, _ in observed))
                            else:
                                children = store.task_conversations(creator_agent_id="main")
                                self.assertEqual(len(children), 1)
                                self.assertEqual((await asyncio.wait_for(runtime.workers.wait(children[0]["task_id"]), 15))["status"], "completed")
                                self.assertTrue(any(model == "child" for model, _, _ in observed))
                            self.assertEqual({reference for _, _, reference in observed}, {file_id})
                            self.assertEqual(len(fetched), 1)
                            target = Path(fetched[0]["path"])
                            self.assertTrue(target.is_relative_to(remote_root / "conversations" / conversation))
                            self.assertNotEqual(str(target), source)
                            self.assertEqual(target.read_bytes(), content)
                            self.assertEqual(Path(source).read_bytes(), content)
                            self.assertIn(content.decode(), "\n".join(read_outputs))

    async def test_switch_stops_actual_transfer_without_waiting_for_historical_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            remote_root = workspace.root / "sandbox"
            workspace.environments_config.write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n'
                '[environments.cloud]\ntype = "instabox"\n'
                f'machine_id = "m_{"a" * 26}"\nworkdir = {json.dumps(str(remote_root))}\n',
                encoding="utf-8",
            )
            role = AgentDefinition("Cloud", "Fetch the user upload", "offline",
                                   environment="cloud", code_mode=False)
            catalog = AgentCatalog("main", {"main": role, "other": role})
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            store.import_agents(catalog)
            gateway = Gateway(store)
            gate, observed = asyncio.Event(), asyncio.Event()
            owners, errors = [], []

            @asynccontextmanager
            async def open_cloud(name, definition, current_workspace, builtin_source=None):
                async with remote_backend(remote_root, cleanup_gate=gate, observed=observed) as backend:
                    owners.append(backend)
                    yield Environment(
                        name, backend, str(current_workspace.skills_dir),
                        str(remote_root / ".wandrun" / "artifacts"),
                        processes=backend.processes, type="instabox",
                    )

            async def respond(model, body):
                outputs = [item["output"] for item in body["input"]
                           if item.get("type") == "function_call_output" and item.get("call_id") == "pending-fetch"]
                if outputs:
                    errors.append(json.loads(outputs[-1]))
                    yield {"type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "message", "role": "assistant", "phase": "final_answer",
                            "content": [{"type": "output_text", "text": json.dumps({"messages": [], "next": "done"})}],
                        }],
                    }}
                else:
                    references = set(re.findall(r"\bf_[0-9a-f]{32}\b", json.dumps(body["input"])))
                    self.assertEqual(len(references), 1)
                    yield {"type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "function_call", "id": "pending-fetch", "call_id": "pending-fetch",
                            "name": "fetch_upload", "arguments": json.dumps({"upload_id": references.pop()}),
                        }],
                    }}

            with patch("wandrun.runtime.execution.environments.open_instabox", open_cloud), \
                    patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=gateway.on_human,
                    agent_catalog=catalog, entry_capabilities=gateway_capabilities(gateway),
                    on_task=gateway.on_task, conversation_workdirs=True, notify_human_of_roots=False,
                ) as runtime:
                    try:
                        gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                        gateway.enable_uploads()
                        conversation = gateway.create_conversation("Retain cleanup ownership", "main", client_id=uuid4().hex)[0]["id"]
                        content = b"pending-file-content"
                        upload = gateway.create_upload(conversation, "pending.txt", "text/plain", len(content), "")

                        async def body():
                            yield content

                        completed = await gateway.uploads.advance(upload, 0, body())
                        with patch.object(file_transfer, "TRANSFER_CLEANUP_LIMIT", 0.01):
                            gateway.send_message(conversation, "pending-file", "Fetch this upload", [completed["file_id"]])
                            result = await asyncio.wait_for(runtime.workers.wait(conversation), 15)
                        self.assertEqual(result["status"], "completed", result)
                        await asyncio.wait_for(observed.wait(), 5)
                        self.assertEqual(len(errors), 1)
                        self.assertIn("error", errors[0])
                        self.assertEqual(runtime.agent_tasks_pending("main"), [])
                        self.assertEqual(len(owners), 1)
                        self.assertEqual(owners[0].pending_transfer_owners(), {conversation})
                        self.assertTrue(runtime.file_transfers_pending("main"))
                        self.assertFalse(runtime.file_transfers_pending("other"))
                        async with httpx.AsyncClient(
                            transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                            base_url="http://gateway", headers={"Authorization": "Bearer dev"},
                        ) as client:
                            other = await client.patch("/agents/other", json={"environment": "local"})
                            self.assertEqual(other.status_code, 200, other.text)
                            switched = await client.patch("/agents/main", json={"environment": "local"})
                            self.assertEqual(switched.status_code, 200, switched.text)
                            self.assertEqual(store.agent("main")["environment"], "local")
                            self.assertTrue(any(item.get("environment") == "cloud"
                                                for item in switched.json()["cleanup_unconfirmed"]))
                            gate.set()
                            async with asyncio.timeout(5):
                                while owners[0].pending_transfer_owners():
                                    await asyncio.sleep(0.001)
                            self.assertEqual(list(remote_root.rglob("*.stage")), [])
                    finally:
                        gate.set()

    async def test_stopped_file_waiter_does_not_spread_preparation_debt_to_agent_switches(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            remote_root = workspace.root / "sandbox"
            workspace.environments_config.write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n'
                '[environments.cloud]\ntype = "instabox"\n'
                f'machine_id = "m_{"a" * 26}"\nworkdir = {json.dumps(str(remote_root))}\n',
                encoding="utf-8",
            )
            role = AgentDefinition("Cloud", "Fetch the user upload", "offline",
                                   environment="cloud", code_mode=False)
            catalog = AgentCatalog("main", {"main": role, "other": role})
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            store.import_agents(catalog)
            gateway = Gateway(store)
            entered, release = asyncio.Event(), asyncio.Event()
            owners = []

            @asynccontextmanager
            async def open_cloud(name, definition, current_workspace, builtin_source=None):
                async with remote_backend(remote_root) as backend:
                    owners.append(backend)
                    ready_backend = backend._backend

                    async def prepare():
                        entered.set()
                        await release.wait()
                        backend._backend = ready_backend
                        return ready_backend, False

                    # The real readiness owner creates and shields its preparation
                    # task; only its private provider-connection completion is gated.
                    backend._backend = None
                    with patch.object(backend, "_prepare", side_effect=prepare):
                        yield Environment(
                            name, backend, str(current_workspace.skills_dir),
                            str(remote_root / ".wandrun" / "artifacts"),
                            processes=backend.processes, type="instabox",
                        )

            async def respond(model, body):
                references = set(re.findall(r"\bf_[0-9a-f]{32}\b", json.dumps(body["input"])))
                self.assertEqual(len(references), 1)
                yield {"type": "response.completed", "response": {
                    "status": "completed", "output": [{
                        "type": "function_call", "id": "preparing-fetch", "call_id": "preparing-fetch",
                        "name": "fetch_upload", "arguments": json.dumps({"upload_id": references.pop()}),
                    }],
                }}

            with patch("wandrun.runtime.execution.environments.open_instabox", open_cloud), \
                    patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=gateway.on_human,
                    agent_catalog=catalog, entry_capabilities=gateway_capabilities(gateway),
                    on_task=gateway.on_task, conversation_workdirs=True, notify_human_of_roots=False,
                ) as runtime:
                    try:
                        gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                        gateway.enable_uploads()
                        conversation = gateway.create_conversation("Stop a preparing transfer", "main", client_id=uuid4().hex)[0]["id"]
                        upload = gateway.create_upload(conversation, "not-submitted.txt", "text/plain", 1, "")

                        async def body():
                            yield b"x"

                        completed = await gateway.uploads.advance(upload, 0, body())
                        gateway.send_message(conversation, "preparing-file", "Fetch this upload", [completed["file_id"]])
                        await asyncio.wait_for(entered.wait(), 5)
                        await asyncio.wait_for(gateway.stop(conversation, "stop-preparing-file"), 5)
                        self.assertTrue(runtime.workers.is_stopped(conversation))
                        self.assertEqual(runtime.agent_tasks_pending("main"), [])
                        self.assertEqual(len(owners), 1)
                        self.assertEqual(owners[0].pending_transfer_owners(), {None})
                        self.assertFalse(runtime.file_transfers_pending("main"))
                        self.assertFalse(runtime.file_transfers_pending("other"))
                        async with httpx.AsyncClient(
                            transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                            base_url="http://gateway", headers={"Authorization": "Bearer dev"},
                        ) as client:
                            for agent in ("main", "other"):
                                switched = await client.patch(f"/agents/{agent}", json={"environment": "local"})
                                self.assertEqual(switched.status_code, 200, switched.text)
                                self.assertEqual(store.agent(agent)["environment"], "local")
                            release.set()
                            await asyncio.wait_for(asyncio.shield(owners[0]._preparing), 5)
                            self.assertEqual(owners[0].pending_transfer_owners(), set())
                            self.assertEqual(list(remote_root.rglob("not-submitted.txt")), [])
                    finally:
                        release.set()
