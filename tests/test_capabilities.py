"""End-to-end capability snapshots at the runtime's publication boundary."""

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.session import open_runtime
from wandrun.runtime.workspace import Workspace

from test_runtime import answer

def workspace_at(root: Path, *, browser: bool = False) -> Workspace:
    workspace = Workspace(root)
    workspace.runtime_dir.mkdir()
    workspace.environments_config.write_text(
        'default = "local"\n[environments.local]\ntype = "local"\n'
        + ('[environments.local.browser]\ncdp_url = "http://127.0.0.1:9222"\n' if browser else ''),
        encoding="utf-8",
    )
    workspace.mcps_config.write_text("[mcp_servers]\n", encoding="utf-8")
    return workspace


def tool_call(name: str, arguments: dict, call_id: str) -> dict:
    return {"type": "response.completed", "response": {"status": "completed", "output": [{
        "type": "function_call", "id": call_id, "call_id": call_id,
        "name": name, "arguments": json.dumps(arguments),
    }]}}


def tool_names(body: dict) -> set[str]:
    return {item["name"] if "name" in item else item["type"] for item in body.get("tools", [])}


class OfflineBrowserLeases:
    """Observe registration and takeover without opening Chrome or a device connection."""

    def __init__(self, definition, **kwargs):
        self.registrations = []
        self.takeovers = []
        self.closed = []

    async def start(self):
        pass

    async def aclose(self):
        pass

    def register(self, task_id, root_id, agent_id, entry_id):
        self.registrations.append((task_id, root_id, agent_id, entry_id))

    async def close_task(self, task_id, *, reason):
        self.closed.append(task_id)

    async def request_takeover(self, task_id, reason):
        self.takeovers.append((task_id, reason))
        return {"status": "requested"}


class CapabilityRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def run_task(self, runtime, task_id: str, *, agent_name: str = "main"):
        runtime.workers.start("exercise current assembly", task_id, agent_name=agent_name)
        result = await asyncio.wait_for(runtime.workers.wait(task_id), 5)
        self.assertEqual(result["status"], "completed", result)

    def assert_browser(self, assembly, status: str, browser):
        capability = assembly.capabilities
        entry = capability.entries["browser"]
        self.assertEqual(entry.definition.id, "browser")
        self.assertEqual(entry.status, status)
        self.assertTrue(entry.reason)
        self.assertEqual(capability.enabled("browser"), status == "enabled")
        self.assertIs(capability.browser, browser if status == "enabled" else None)

    async def test_browser_selection_rebuild_publishes_tools_and_registration_together(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = workspace_at(Path(directory), browser=True)
            skill = workspace.skills_dir / "browser" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("---\nname: browser\ndescription: Browser skill\n---\nUse browser.\n", encoding="utf-8")
            selected = AgentDefinition("Selected", "Use browser", "offline", skills=("browser",), environment="local", code_mode=False)
            unselected = AgentDefinition("Unselected", "No browser", "offline", environment="local", code_mode=False)
            catalog = AgentCatalog("main", {"main": selected, "other": unselected})
            requests = {}
            leases = OfflineBrowserLeases(None)

            async def respond(model, body):
                task_id = body["prompt_cache_key"]
                requests.setdefault(task_id, []).append(body)
                if task_id in {"selected", "added"} and len(requests[task_id]) == 1:
                    yield tool_call("request_takeover", {"reason": "sign in"}, task_id)
                else:
                    yield answer("done")

            with (patch("wandrun.runtime.session.BrowserLeases", return_value=leases),
                  patch.object(CodexSubscriptionModel, "_arequest", respond)):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, notify_human_of_roots=False,
                ) as runtime:
                    old_main = runtime._assembly_for("main")
                    old_other = runtime._assembly_for("other")
                    self.assert_browser(old_main, "enabled", leases)
                    self.assert_browser(old_other, "disabled", None)
                    with self.assertRaises(TypeError):
                        old_main.capabilities.entries["browser"] = old_other.capabilities.entries["browser"]
                    await self.run_task(runtime, "selected")
                    await self.run_task(runtime, "unselected", agent_name="other")
                    self.assertIn("request_takeover", tool_names(requests["selected"][0]))
                    self.assertNotIn("request_takeover", tool_names(requests["unselected"][0]))
                    self.assertIn("Browser skill", requests["selected"][0]["instructions"])
                    self.assertNotIn("Browser skill", requests["unselected"][0]["instructions"])
                    self.assertEqual(leases.takeovers, [("selected", "sign in")])
                    self.assertEqual([row[0] for row in leases.registrations], ["selected"])

                    changed = AgentCatalog("main", {
                        "main": replace(selected, skills=()),
                        "other": replace(unselected, skills=("browser",)),
                    })
                    commit = await runtime.prepare_agents(changed)
                    self.assertIs(runtime._assembly_for("main"), old_main)
                    self.assertIs(runtime._assembly_for("other"), old_other)
                    await self.run_task(runtime, "still-selected")
                    self.assertIn("request_takeover", tool_names(requests["still-selected"][0]))
                    self.assertEqual([row[0] for row in leases.registrations], ["selected", "still-selected"])
                    commit()
                    new_main = runtime._assembly_for("main")
                    new_other = runtime._assembly_for("other")
                    self.assertIsNot(new_main, old_main)
                    self.assertIsNot(new_other, old_other)
                    self.assertIsNot(new_main.capabilities, old_main.capabilities)
                    self.assertIsNot(new_other.capabilities, old_other.capabilities)
                    self.assert_browser(new_main, "disabled", None)
                    self.assert_browser(new_other, "enabled", leases)
                    self.assert_browser(old_main, "enabled", leases)
                    await self.run_task(runtime, "removed")
                    await self.run_task(runtime, "added", agent_name="other")
                    self.assertNotIn("request_takeover", tool_names(requests["removed"][0]))
                    self.assertIn("request_takeover", tool_names(requests["added"][0]))
                    self.assertNotIn("Browser skill", requests["removed"][0]["instructions"])
                    self.assertIn("Browser skill", requests["added"][0]["instructions"])
                    self.assertEqual(leases.takeovers, [("selected", "sign in"), ("added", "sign in")])
                    self.assertEqual([row[0] for row in leases.registrations],
                                     ["selected", "still-selected", "added"])

    async def test_browser_http_edit_publishes_only_committed_graph_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = workspace_at(Path(directory), browser=True)
            skill = workspace.skills_dir / "browser" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("---\nname: browser\ndescription: Browse\n---\nUse browser.\n", encoding="utf-8")
            definition = AgentDefinition("Browser", "Work", "offline", environment="local")
            catalog = AgentCatalog("main", {"main": definition})
            store = GatewayStore(workspace.state_dir / "gateway.sqlite")
            self.addCleanup(store.close)
            store.import_agents(catalog)
            gateway = Gateway(store)
            leases = OfflineBrowserLeases(None)
            with patch("wandrun.runtime.session.BrowserLeases", return_value=leases):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    agent_catalog=catalog, on_human=lambda *_: None,
                ) as runtime:
                    gateway.runtime = runtime
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                        base_url="http://gateway", headers={"Authorization": "Bearer dev"},
                    ) as client:
                        url = "/agents/main/capabilities"

                        async def browser():
                            response = await client.get(url)
                            self.assertEqual(response.status_code, 200, response.text)
                            return next(item for item in response.json()["capabilities"] if item["id"] == "browser")

                        self.assertEqual((await browser())["reason"], "未选择 browser 技能")
                        initial = runtime._assembly_for("main")
                        changed = await client.patch("/agents/main", json={"skills": ["browser"]})
                        self.assertEqual(changed.status_code, 200, changed.text)
                        self.assertIsNot(runtime._assembly_for("main"), initial)
                        self.assertEqual((await browser())["tools"], ["request_takeover"])
                        self.assertEqual((await browser())["status"], "enabled")
                        removed = await client.patch("/agents/main", json={"skills": []})
                        self.assertEqual(removed.status_code, 200, removed.text)
                        self.assertEqual((await browser())["tools"], [])
                        self.assertEqual((await browser())["reason"], "未选择 browser 技能")

    async def test_prepare_not_committed_or_failed_after_build_does_not_publish(self):
        from wandrun.runtime import session

        with tempfile.TemporaryDirectory() as directory:
            workspace = workspace_at(Path(directory))
            original = AgentDefinition("Root", "Old instructions", "offline", environment="local", code_mode=False)
            candidate = AgentCatalog("main", {"main": replace(original, system_prompt="New instructions")})
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                yield answer("done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=AgentCatalog("main", {"main": original}),
                    notify_human_of_roots=False,
                ) as runtime:
                    initial = runtime._assembly_for("main")
                    self.assert_browser(initial, "not_applicable", None)
                    self.assertEqual(initial.capabilities.entries["code_mode"].status, "disabled")
                    self.assertTrue(initial.capabilities.entries["code_mode"].reason)
                    await runtime.prepare_agents(candidate)  # Caller abandons a successful candidate.
                    self.assertIs(runtime._assembly_for("main"), initial)
                    await self.run_task(runtime, "abandoned")
                    self.assertIn("Old instructions", bodies[-1]["instructions"])
                    self.assertNotIn("New instructions", bodies[-1]["instructions"])
                    real_build = session.build_agents
                    built = []

                    def build_then_fail(*args, **kwargs):
                        result = real_build(*args, **kwargs)
                        built.extend(result.values())
                        raise RuntimeError("candidate graph construction failed")

                    with patch.object(session, "build_agents", side_effect=build_then_fail):
                        with self.assertRaisesRegex(RuntimeError, "candidate graph construction failed"):
                            await runtime.prepare_agents(candidate)
                    self.assertTrue(built)
                    self.assertIs(runtime._assembly_for("main"), initial)
                    await self.run_task(runtime, "unchanged")
                    self.assertIn("Old instructions", bodies[-1]["instructions"])
                    self.assertNotIn("New instructions", bodies[-1]["instructions"])
                    published = await runtime.prepare_agents(candidate)
                    self.assertIs(runtime._assembly_for("main"), initial)
                    published()
                    self.assertIsNot(runtime._assembly_for("main"), initial)
                    self.assertIsNot(runtime._assembly_for("main").capabilities, initial.capabilities)
                    await self.run_task(runtime, "published")
                    self.assertIn("New instructions", bodies[-1]["instructions"])

    async def test_noop_reuses_assemblies_and_delete_empty_then_add_runs_graph(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = workspace_at(Path(directory))
            main = AgentDefinition("Root", "Root instructions", "offline", environment="local", code_mode=False)
            other = AgentDefinition("Other", "Other instructions", "offline", environment="local", code_mode=False)
            catalog = AgentCatalog("main", {"main": main, "other": other})
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                yield answer("done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=catalog, notify_human_of_roots=False,
                ) as runtime:
                    main_assembly, other_assembly = runtime._assembly_for("main"), runtime._assembly_for("other")
                    (await runtime.prepare_agents(catalog))()
                    self.assertIs(runtime._assembly_for("main"), main_assembly)
                    self.assertIs(runtime._assembly_for("other"), other_assembly)
                    changed = AgentCatalog("main", {"main": replace(main, system_prompt="New root"), "other": other})
                    (await runtime.prepare_agents(changed))()
                    self.assertIsNot(runtime._assembly_for("main"), main_assembly)
                    self.assertIs(runtime._assembly_for("other"), other_assembly)
                    await self.run_task(runtime, "other-run", agent_name="other")
                    self.assertIn("Other instructions", bodies[-1]["instructions"])
                    (await runtime.prepare_agents(AgentCatalog(None, {})))()
                    with self.assertRaises(KeyError):
                        runtime._assembly_for("main")
                    (await runtime.prepare_agents(AgentCatalog(None, {"fresh": main})))()
                    fresh = runtime._assembly_for("fresh")
                    self.assertIsNot(fresh, main_assembly)
                    self.assertTrue(fresh.capabilities.enabled("files"))
                    await self.run_task(runtime, "fresh-run", agent_name="fresh")
                    self.assertIn("Root instructions", bodies[-1]["instructions"])
                    self.assertIn("read_file", tool_names(bodies[-1]))

    async def test_inflight_browser_graph_keeps_its_owner_after_skill_removal(self):
        for boundary in ("files.prepare", "model"):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as directory:
                workspace = workspace_at(Path(directory), browser=True)
                selected = AgentDefinition("Root", "Use browser", "offline", skills=("browser",))
                entered, release = asyncio.Event(), asyncio.Event()
                leases = OfflineBrowserLeases(None)
                requests = []

                async def respond(model, body):
                    requests.append(body)
                    if len(requests) == 1:
                        if boundary == "model":
                            entered.set()
                            await release.wait()
                        yield tool_call("request_takeover", {"reason": "old turn"}, "inflight-takeover")
                    else:
                        yield answer("done")

                with (patch("wandrun.runtime.session.BrowserLeases", return_value=leases),
                      patch.object(CodexSubscriptionModel, "_arequest", respond)):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                        agent_catalog=AgentCatalog("main", {"main": selected}),
                        notify_human_of_roots=False,
                    ) as runtime:
                        prepare = runtime.files.prepare

                        async def paused_prepare(task_id):
                            if boundary == "files.prepare" and task_id == "inflight":
                                entered.set()
                                await release.wait()
                            return await prepare(task_id)

                        with patch.object(runtime.files, "prepare", paused_prepare):
                            original = runtime._assembly_for("main")
                            runtime.workers.start("take over", "inflight")
                            await asyncio.wait_for(entered.wait(), 5)
                            (await runtime.prepare_agents(AgentCatalog("main", {
                                "main": replace(selected, skills=()),
                            })))()
                            self.assert_browser(runtime._assembly_for("main"), "disabled", None)
                            release.set()
                            result = await asyncio.wait_for(runtime.workers.wait("inflight"), 5)
                            self.assertEqual(result["status"], "completed", result)
                            self.assert_browser(original, "enabled", leases)
                            self.assertEqual(leases.takeovers, [("inflight", "old turn")])
                            for body in requests:
                                self.assertIn("request_takeover", tool_names(body))
                            await self.run_task(runtime, "next-turn")
                            self.assertNotIn("request_takeover", tool_names(requests[-1]))
                            self.assertEqual([row[0] for row in leases.registrations], ["inflight"])

    async def test_browser_each_missing_prerequisite_disables_tool_and_registration(self):
        for missing in ("resource", "environment", "skill"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                workspace = workspace_at(Path(directory), browser=True)
                with workspace.environments_config.open("a", encoding="utf-8") as config:
                    config.write('\n[environments.other]\ntype = "local"\n')
                selected = AgentDefinition(
                    "Root", "Browser prerequisites", "offline",
                    skills=() if missing == "skill" else ("browser",),
                    environment="other" if missing == "environment" else "local",
                )
                leases = OfflineBrowserLeases(None)
                requests = []

                async def respond(model, body):
                    requests.append(body)
                    yield answer("done")

                with (patch("wandrun.runtime.session.BrowserLeases",
                            return_value=None if missing == "resource" else leases),
                      patch.object(CodexSubscriptionModel, "_arequest", respond)):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                        agent_catalog=AgentCatalog("main", {"main": selected}),
                        notify_human_of_roots=False,
                    ) as runtime:
                        assembly = runtime._assembly_for("main")
                        self.assert_browser(
                            assembly, "disabled" if missing == "skill" else "not_applicable", None,
                        )
                        await self.run_task(runtime, "missing-" + missing)
                        self.assertNotIn("request_takeover", tool_names(requests[0]))
                        self.assertEqual(leases.registrations, [])
                        self.assertEqual(leases.takeovers, [])

    async def test_absent_resources_keep_inapplicable_decisions_and_sync_execute(self):
        from langgraph.checkpoint.memory import InMemorySaver

        from wandrun.integrations.shell_backend import ManagedShellBackend
        from wandrun.runtime.agents import build_agents, run_conversation
        from wandrun.runtime.environments import Environment
        from wandrun.runtime.workers import WorkerManager

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = ManagedShellBackend(root_dir=root, virtual_mode=False)
            self.addCleanup(backend.close)
            requests = []
            leases = OfflineBrowserLeases(None)

            async def run(prompts, task_id):
                return await run_conversation(assembly.graph, prompts, task_id, "main")

            async def respond(model, body):
                requests.append(body)
                if len(requests) == 1:
                    yield tool_call("execute", {"command": "printf sync-proof > proof.txt; pwd"}, "sync")
                else:
                    yield answer("done")

            shown = []
            manager = WorkerManager(
                run, agent_workers={"main": ()}, default_agent="main",
                on_human=lambda _, text, *_rest: shown.append(text), notify_human_of_roots=False,
            )
            self.addAsyncCleanup(manager.close)
            assembly = build_agents(
                manager, definitions={"main": AgentDefinition("Root", "Execute", "offline", code_mode=False)},
                models={"main": CodexSubscriptionModel(model_name="offline")},
                tools={"main": []}, checkpointer=InMemorySaver(),
                environments={"main": Environment(
                    "no-browser", backend, str(root / "skills"), str(root / "artifacts"),
                )}, browser=leases, browser_environments=("other-environment",),
            )["main"]
            store = GatewayStore(root / "gateway.sqlite")
            self.addCleanup(store.close)
            store.import_agents(AgentCatalog("main", {
                "main": AgentDefinition("Root", "Execute", "offline", environment="no-browser", code_mode=False),
            }))
            gateway = Gateway(store)
            gateway.runtime = SimpleNamespace(_assembly_for=lambda identity: assembly)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=create_app(gateway, "dev")),
                base_url="http://gateway", headers={"Authorization": "Bearer dev"},
            ) as client:
                response = await client.get("/agents/main/capabilities")
            self.assertEqual(response.status_code, 200, response.text)
            visible = {item["id"]: item for item in response.json()["capabilities"]}
            self.assertEqual((visible["memory"]["status"], visible["memory"]["reason"], visible["memory"]["tools"]),
                             ("not_applicable", "未提供记忆库", []))
            self.assertEqual(visible["files"]["tools"][-1], "execute")
            self.assertEqual(visible["processes"]["tools"], [])
            self.assertEqual(visible["tool_search"]["tools"], [])
            for capability_id in ("memory", "task_path", "processes", "browser"):
                entry = assembly.capabilities.entries[capability_id]
                self.assertEqual(entry.status, "not_applicable")
                self.assertTrue(entry.reason)
            for capability_id in ("code_mode", "tool_search"):
                self.assertEqual(assembly.capabilities.entries[capability_id].status, "disabled")
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                manager.start("execute", "sync-command")
                result = await asyncio.wait_for(manager.wait("sync-command"), 5)
            self.assertEqual(result["status"], "completed", result)
            self.assertEqual(shown, ["done"])
            self.assertEqual((root / "proof.txt").read_text(), "sync-proof")
            self.assertIn(str(root), json.dumps(requests[-1]["input"]))
            self.assertEqual(
                {item.get("name", item["type"]) for item in requests[0]["tools"]} - {"cancel_worker"},
                {tool for item in visible.values() for tool in item["tools"]},
            )
            self.assertIn("execute", tool_names(requests[0]))
            self.assertTrue({"exec_command", "kill_process", "request_takeover", "run_code", "tool_search"}
                            .isdisjoint(tool_names(requests[0])))

    async def test_standard_runtime_relative_file_tools_use_workspace_root(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = workspace_at(Path(directory))
            (workspace.root / "input.txt").write_text("workspace marker", encoding="utf-8")
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    yield tool_call("read_file", {"file_path": "input.txt"}, "read")
                elif len(bodies) == 2:
                    yield tool_call("write_file", {"file_path": "output.txt", "content": "workspace result"}, "write")
                else:
                    yield answer("files done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=AgentCatalog("main", {
                        "main": AgentDefinition("Root", "Use relative files", "offline", environment="local"),
                    }), notify_human_of_roots=False,
                ) as runtime:
                    self.assertTrue(runtime._assembly_for("main").capabilities.enabled("task_path"))
                    await self.run_task(runtime, "relative-files")
                    self.assertIn("workspace marker", json.dumps(bodies[1]["input"]))
                    self.assertEqual((workspace.root / "output.txt").read_text(encoding="utf-8"), "workspace result")
                    self.assertFalse((workspace.root / "conversations" / "relative-files" / "output.txt").exists())
