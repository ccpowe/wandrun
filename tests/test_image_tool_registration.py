"""Host image generation is offered only to local roles, including rebuilt graphs."""

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.capabilities import gateway_capabilities
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.environments import Environment
from wandrun.runtime import agents
from wandrun.runtime.session import open_runtime
from wandrun.runtime.workspace import Workspace


class ImageToolRegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_remote_rebuild_new_role_and_non_gateway_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.runtime_dir.mkdir()
            remote_root = workspace.root / "remote"
            remote_root.mkdir()
            workspace.environments_config.write_text(
                'default = "desktop"\n[environments.desktop]\ntype = "local"\n'
                '[environments.server]\ntype = "ssh"\nhost = "unused.invalid"\n'
                f'workdir = {json.dumps(str(remote_root))}\n'
            )
            workspace.mcps_config.write_text('[mcp_servers]\n')
            catalog = AgentCatalog("main", {
                "main": AgentDefinition("local", "Help", "offline", environment="desktop", code_mode=True),
                "remote": AgentDefinition("remote", "Help", "offline", environment="server"),
            })
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            store.import_agents(catalog)
            gateway = Gateway(store)
            seen = {}
            image_calls = []
            image_outputs = []
            graph_tools = []
            create_agent = agents.create_agent

            def capture_graph(**kwargs):
                graph_tools.append({
                    item.name: item
                    for middleware in kwargs["middleware"] for item in getattr(middleware, "tools", ())
                })
                return create_agent(**kwargs)

            async def environments(config, workspace, stack, opened, *, include_default, builtin_source=None):
                # Exercise the real graph and scheduler with isolated local backends;
                # the configured type, not the backend class or environment name, gates tools.
                by_name = {}
                for name, definition in config.environments.items():
                    root = workspace.root if definition.type == "local" else remote_root
                    backend = ManagedShellBackend(root_dir=root, virtual_mode=False)
                    environment = Environment(
                        name, backend, str(root / ".wandrun/skills"), str(root / ".wandrun/artifacts"),
                        type=definition.type,
                    )
                    by_name[name] = environment
                    opened.append(environment)
                return {name: by_name[role.environment] for name, role in config.agents.items()}

            async def respond(model, body):
                task = body["prompt_cache_key"]
                seen[task] = {tool.get("name"): tool for tool in body["tools"]}
                if task == "invoke-image" and not any(
                    item.get("type") == "function_call_output" for item in body["input"]
                ):
                    yield {"type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "function_call", "id": "image-action", "call_id": "image-call",
                            "name": "generate_image", "arguments": json.dumps({"prompt": "画只猫"}),
                        }],
                    }}
                    return
                if task == "invoke-image":
                    image_outputs.extend(
                        item["output"] for item in body["input"]
                        if item.get("type") == "function_call_output"
                    )
                yield {"type": "response.completed", "response": {"status": "completed", "output": [{
                    "type": "message", "role": "assistant", "content": [{
                        "type": "output_text", "text": json.dumps({"messages": [], "next": "done"}),
                    }],
                }]}}

            async def generate(prompt, *, model_name, credentials):
                image_calls.append((prompt, model_name))
                return b"\x89PNG\r\n\x1a\ncomplete image"

            async def run(runtime, role, task):
                runtime.workers.start("show tools", task, agent_name=role)
                result = await asyncio.wait_for(runtime.workers.wait(task), 5)
                self.assertEqual(result["status"], "completed", result)

            with (
                patch("wandrun.runtime.session.open_environments", side_effect=environments),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
                patch("wandrun.gateway.image_tools.request_image", generate),
                patch.object(agents, "create_agent", capture_graph),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, conversation_workdirs=True,
                    entry_capabilities=gateway_capabilities(gateway),
                ) as runtime:
                    gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                    await run(runtime, "main", "local-before")
                    await run(runtime, "remote", "remote-before")
                    updated = AgentCatalog("main", {
                        **{name: replace(role, system_prompt="Updated") for name, role in catalog.agents.items()},
                        "fresh": AgentDefinition("new", "Help", "offline", environment="desktop"),
                    })
                    (await runtime.prepare_agents(updated))()
                    await run(runtime, "main", "local-after")
                    await run(runtime, "remote", "remote-after")
                    await run(runtime, "fresh", "new-local")
                    await run(runtime, "main", "invoke-image")
                    local_tools = [items for items in graph_tools if "generate_image" in items]
                    remote_tools = [items for items in graph_tools if "generate_image" not in items]
                    for name in ("create_schedule", "generate_image"):
                        self.assertTrue(all(items[name] is local_tools[0][name] for items in local_tools))
                    self.assertTrue(all(
                        items["create_schedule"] is remote_tools[0]["create_schedule"] for items in remote_tools
                    ))
                    self.assertIsNot(local_tools[0]["create_schedule"], remote_tools[0]["create_schedule"])
                # Terminal/headless omit entry capabilities; no host tool leaks into them.
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog,
                ) as runtime:
                    await run(runtime, "main", "without-host")
                    self.assertNotIn("create_schedule", seen["without-host"])

            for task in ("local-before", "local-after", "new-local"):
                self.assertIn("generate_image", seen[task])
                self.assertEqual(set(seen[task]["generate_image"]["parameters"]["properties"]), {"prompt"})
                self.assertIn("create_schedule", seen[task])
            for task in ("remote-before", "remote-after", "without-host"):
                self.assertNotIn("generate_image", seen[task])
            for task in ("remote-before", "remote-after"):
                self.assertIn("create_schedule", seen[task])
            self.assertEqual(len(image_calls), 1)
            self.assertEqual(image_calls[0][0], "画只猫")
            self.assertEqual(len(image_outputs), 1)
            image_result = json.loads(image_outputs[0])
            self.assertEqual(Path(image_result["path"]).read_bytes(), b"\x89PNG\r\n\x1a\ncomplete image")
            self.assertIn("invoke-image", image_result["path"])
            self.assertIn("run_code", seen["local-before"])
            self.assertIn("run_code", seen["local-after"])
