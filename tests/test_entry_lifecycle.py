"""Entry capability decisions, startup resources and graph publication boundaries."""

import asyncio
import re
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from langchain.agents.middleware import AgentMiddleware
from langchain.tools import tool

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.capabilities import EntryCapabilityDefinition
from wandrun.runtime.session import open_runtime

from test_capabilities import tool_call, tool_names
from test_runtime import answer, configure


class EntryLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_enabled_skills_and_tools_follow_committed_graph_not_candidate_or_inflight_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            calls, bound, installed, bodies = [], [], [], {}
            entered, release = asyncio.Event(), asyncio.Event()
            builtin = {"proof": {"SKILL.md": (
                "---\nname: proof\ndescription: Entry-owned evidence\n---\n"
                "Capability proof is amber-483.\n"
            )}}
            # A colliding workspace skill must not leak into a disabled capability.
            collision = workspace.skills_dir / "proof" / "SKILL.md"
            collision.parent.mkdir(parents=True)
            collision.write_text("---\nname: proof\ndescription: User collision\n---\nWrong source.\n")

            def condition(definition, environment):
                if definition.system_prompt == "fail-prepare":
                    raise ValueError("controlled capability preparation failure")
                return (("enabled", "Selected by role") if definition.system_prompt == "enabled"
                        else ("disabled", "Not selected by role"))

            def prepare(manager, files, kind):
                bound.append(kind)

                @tool
                def record_entry() -> int:
                    """Record use of this runtime's entry capability."""
                    calls.append(kind)
                    return len(calls)

                class EntryMiddleware(AgentMiddleware):
                    def __init__(self):
                        self.tools = [record_entry]
                        installed.append(record_entry)

                return EntryMiddleware

            capability = EntryCapabilityDefinition(
                "proof", "Evidence", condition, prepare, builtin_skills=builtin,
            )

            async def respond(model, body):
                task_id = body["prompt_cache_key"]
                requests = bodies.setdefault(task_id, [])
                requests.append(body)
                if task_id == "inflight" and len(requests) == 1:
                    entered.set()
                    await release.wait()
                if "record_entry" not in tool_names(body):
                    self.assertNotIn("Entry-owned evidence", body["instructions"])
                    self.assertNotIn("User collision", body["instructions"])
                    yield answer("disabled")
                elif len(requests) == 1:
                    path = re.search(r"Read `([^`]+/proof/SKILL\.md)`", body["instructions"]).group(1)
                    yield tool_call("read_file", {"file_path": path}, "read-proof")
                elif len(requests) == 2:
                    outputs = [item for item in body["input"] if item.get("type") == "function_call_output"]
                    self.assertIn("amber-483", str(outputs))
                    yield tool_call("record_entry", {}, "record")
                else:
                    yield answer("enabled")

            async def run(runtime, task_id, agent="first"):
                runtime.workers.start("Use entry evidence", task_id, agent_name=agent)
                result = await asyncio.wait_for(runtime.workers.wait(task_id), 10)
                self.assertEqual(result["status"], "completed", result)

            disabled = AgentDefinition("First", "disabled", "offline", skills=("proof",), environment="local")
            enabled = replace(disabled, system_prompt="enabled")
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=AgentCatalog(None, {}), entry_capabilities=(capability,),
                    notify_human_of_roots=False,
                ) as runtime:
                    catalog = AgentCatalog("first", {"first": disabled})
                    (await runtime.prepare_agents(catalog))()
                    initial = runtime._assembly_for("first")
                    await run(runtime, "initial-disabled")
                    self.assertEqual(initial.capabilities.entries["proof"].status, "disabled")
                    selected = AgentCatalog("first", {"first": enabled})
                    commit = await runtime.prepare_agents(selected)
                    self.assertIs(runtime._assembly_for("first"), initial)
                    await run(runtime, "uncommitted")
                    with self.assertRaisesRegex(ValueError, "controlled capability"):
                        await runtime.prepare_agents(AgentCatalog("first", {
                            "first": replace(disabled, system_prompt="fail-prepare"),
                        }))
                    self.assertIs(runtime._assembly_for("first"), initial)
                    commit()
                    selected_assembly = runtime._assembly_for("first")
                    self.assertEqual(selected_assembly.capabilities.entries["proof"].status, "enabled")
                    await run(runtime, "enabled-first")
                    (await runtime.prepare_agents(selected))()
                    self.assertIs(runtime._assembly_for("first"), selected_assembly)
                    runtime.workers.start("Use entry evidence", "inflight", agent_name="first")
                    try:
                        await asyncio.wait_for(entered.wait(), 10)
                        (await runtime.prepare_agents(catalog))()
                    finally:
                        release.set()
                    self.assertEqual((await runtime.workers.wait("inflight"))["status"], "completed")
                    await run(runtime, "next-disabled")
                    expanded = AgentCatalog("first", {"first": enabled, "second": enabled})
                    (await runtime.prepare_agents(expanded))()
                    await run(runtime, "second-agent", "second")
                    self.assertEqual(calls, ["local", "local", "local"])
                    self.assertEqual(bound, ["local"])
                    self.assertTrue(all(item is installed[0] for item in installed))
                    (await runtime.prepare_agents(AgentCatalog(None, {})))()
                    with self.assertRaises(KeyError):
                        runtime._assembly_for("first")
            self.assertIn("Wrong source.", collision.read_text())

    async def test_multiple_delivery_policies_rejected_even_with_empty_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            first = EntryCapabilityDefinition(
                "first", "First", lambda *_: ("disabled", "No selected roles"),
                lambda *_: AgentMiddleware, validate_human=lambda *_: None,
            )
            second = replace(first, id="second")
            with self.assertRaisesRegex(ValueError, "只能声明一份 human 投递策略"):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                    agent_catalog=AgentCatalog(None, {}), entry_capabilities=(first, second),
                ):
                    self.fail("Conflicting delivery policies must prevent startup")

    async def test_restart_reloads_builtin_path_in_existing_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            capability = EntryCapabilityDefinition(
                "proof", "Evidence", lambda *_: ("enabled", "Entry available"),
                lambda *_: AgentMiddleware, builtin_skills={"proof": {
                    "SKILL.md": "---\nname: proof\ndescription: Restart evidence\n---\nAmber.\n",
                }},
            )
            paths = []

            async def respond(model, body):
                path = re.search(r"Read `([^`]+/proof/SKILL\.md)`", body["instructions"]).group(1)
                paths.append(path)
                self.assertTrue(Path(path).is_file())
                yield answer("done")

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                for _ in range(2):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                        entry_capabilities=(capability,), notify_human_of_roots=False,
                    ) as runtime:
                        runtime.workers.start("Read current builtin", "same-thread")
                        self.assertEqual((await runtime.workers.wait("same-thread"))["status"], "completed")
                    self.assertFalse(Path(paths[-1]).exists())
            self.assertNotEqual(paths[0], paths[1])
