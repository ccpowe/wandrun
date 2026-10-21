"""Skills 在两种文件系统路径模式下都能渐进读取，不把正文提前塞入提示词。"""

from collections import defaultdict
import tempfile
import unittest
from pathlib import Path

from deepagents.backends import LocalShellBackend
from langchain.agents.middleware import AgentMiddleware
from langchain.messages import AIMessage, ToolMessage
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver

from wandrun.runtime.agents import _ConfiguredSkillsMiddleware, build_agents, run_conversation
from wandrun.config import AgentDefinition
from wandrun.runtime.capabilities import EntryCapabilityDefinition
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.workers import WorkerManager
from wandrun.runtime.environments import Environment


class SkillsTests(unittest.IsolatedAsyncioTestCase):
    async def test_skill_discovery_then_read_in_virtual_and_absolute_modes(self):
        for virtual in (True, False):
            with self.subTest(virtual=virtual), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                skill = root / "skills" / "local-proof" / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(
                    "---\nname: local-proof\ndescription: Workspace-specific evidence recipe.\n"
                    "---\nThe evidence code is sapphire-742.\n",
                    encoding="utf-8",
                )
                unused = root / "skills" / "unselected" / "SKILL.md"
                unused.parent.mkdir(parents=True)
                unused.write_text(
                    "---\nname: unselected\ndescription: Should not be shown.\n"
                    "---\nHidden instructions.\n",
                    encoding="utf-8",
                )
                source = "/skills" if virtual else str(root / "skills")
                skill_path = source + "/local-proof/SKILL.md"
                test = self

                class Model(FakeMessagesListChatModel):
                    def bind_tools(self, tools, **kwargs):
                        return self.bind(**kwargs)

                    async def _agenerate(self, messages, **kwargs):
                        results = [m for m in messages if isinstance(m, ToolMessage)]
                        if not results:
                            test.assertIn("Workspace-specific evidence recipe.", str(messages[0].content))
                            test.assertNotIn("sapphire-742", str(messages[0].content))
                            test.assertNotIn("Should not be shown.", str(messages[0].content))
                            response = AIMessage(
                                content="",
                                tool_calls=[{
                                    "name": "read_file",
                                    "args": {"file_path": skill_path},
                                    "id": "read-skill",
                                    "type": "tool_call",
                                }],
                            )
                        else:
                            test.assertIn("sapphire-742", str(results[-1].content))
                            result = AgentOutput(
                                messages=[SendMessage(to="human", task_id=None, message="sapphire-742")],
                                next="done",
                            )
                            response = AIMessage(
                                content=result.model_dump_json(),
                                additional_kwargs={"wandrun_agent_output": result.model_dump()},
                            )
                        return ChatResult(generations=[ChatGeneration(message=response)])

                definitions = {
                    "helper": AgentDefinition(
                        description="Reads local skills", system_prompt="Use the local skill.",
                        model="offline", skills=("local-proof",), code_mode=False,
                    )
                }
                shown = []

                async def run(prompts, task_id):
                    return await run_conversation(agents["helper"].graph, prompts, task_id, "helper")

                manager = WorkerManager(
                    run, agent_workers={"helper": ()}, default_agent="helper",
                    on_human=lambda sender, text, attachments, draft_id: shown.append(text),
                )
                try:
                    agents = build_agents(
                        manager,
                        definitions=definitions,
                        models={"helper": Model(responses=[])},
                        tools={"helper": []},
                        environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=root, virtual_mode=virtual), source, "/")),
                        checkpointer=InMemorySaver(),
                    )
                    manager.start("Read the local evidence skill", "root")
                    outcome = await manager.wait("root")
                    self.assertEqual(outcome["status"], "completed", outcome)
                    self.assertEqual(shown, ["sapphire-742"])
                finally:
                    await manager.close()

    async def test_builtin_metadata_and_files_are_available_to_every_role_and_own_collisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            user_skill = root / "skills" / "wandrun-ui" / "SKILL.md"
            user_skill.parent.mkdir(parents=True)
            user_skill.write_text(
                "---\nname: wandrun-ui\ndescription: User collision\n---\nUser document.\n",
                encoding="utf-8",
            )
            builtin = root / "builtin" / "wandrun-ui"
            builtin.mkdir(parents=True)
            (builtin / "SKILL.md").write_text(
                "---\nname: wandrun-ui\ndescription: Builtin display recipe\n---\n"
                "Read display.md for the lavender-842 detail.\n", encoding="utf-8",
            )
            (builtin / "display.md").write_text("lavender-842\n", encoding="utf-8")
            read_path = str(builtin / "display.md")
            backend = LocalShellBackend(root_dir=root, virtual_mode=False)
            environment = Environment(
                "local", backend, str(root / "skills"), str(root),
                builtin_skills_source=str(root / "builtin"),
                builtin_skills=frozenset({"wandrun-ui"}),
            )
            observed = []
            test = self

            class Model(FakeMessagesListChatModel):
                def bind_tools(self, tools, **kwargs):
                    return self.bind(**kwargs)

                async def _agenerate(self, messages, **kwargs):
                    prompt = str(messages[0].content)
                    observed.append(prompt)
                    test.assertIn("Builtin display recipe", prompt)
                    test.assertIn(str(builtin / "SKILL.md"), prompt)
                    test.assertNotIn("User collision", prompt)
                    results = [m for m in messages if isinstance(m, ToolMessage)]
                    if not results:
                        response = AIMessage(content="", tool_calls=[{
                            "name": "read_file", "args": {"file_path": read_path},
                            "id": "read-display", "type": "tool_call",
                        }])
                    else:
                        test.assertIn("lavender-842", str(results[-1].content))
                        result = AgentOutput(messages=[], next="done")
                        response = AIMessage(
                            content=result.model_dump_json(),
                            additional_kwargs={"wandrun_agent_output": result.model_dump()},
                        )
                    return ChatResult(generations=[ChatGeneration(message=response)])

            async def run(prompts, task_id):
                name = manager.agent_name(task_id)
                return await run_conversation(agents[name].graph, prompts, task_id, name)

            definitions = {
                "configured": AgentDefinition("Configured", "Work", "offline", skills=("wandrun-ui",), code_mode=False),
                "unconfigured": AgentDefinition("Unconfigured", "Work", "offline", code_mode=False),
            }
            manager = WorkerManager(
                run, agent_workers={name: () for name in definitions}, default_agent="configured",
            )
            try:
                agents = build_agents(
                    manager, definitions=definitions,
                    models={name: Model(responses=[]) for name in definitions},
                    tools={name: [] for name in definitions},
                    environments={name: environment for name in definitions},
                    checkpointer=InMemorySaver(),
                    entry_capabilities=(EntryCapabilityDefinition(
                        "ui", "UI", lambda *_: ("enabled", "Test entry"),
                        lambda *_: AgentMiddleware,
                        builtin_skills={"wandrun-ui": {}},
                    ),),
                    entry_middleware_factories={"local": {"ui": AgentMiddleware}},
                )
                for name in definitions:
                    manager.start("Read display detail", name, agent_name=name)
                    outcome = await manager.wait(name)
                    self.assertEqual(outcome["status"], "completed", outcome)
                self.assertEqual(len(observed), 4)
                self.assertIn("lavender-842", backend.read(read_path).file_data["content"])
                self.assertIn("User document.", user_skill.read_text())
            finally:
                await manager.close()

    async def test_skill_metadata_refreshes_when_same_named_file_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skills" / "recipe" / "SKILL.md"
            skill.parent.mkdir(parents=True)

            def replace(description):
                skill.write_text(
                    f"---\nname: recipe\ndescription: {description}\n---\nInstructions.\n",
                    encoding="utf-8",
                )

            replace("Old recipe")
            seen = []

            class Model(FakeMessagesListChatModel):
                def bind_tools(self, tools, **kwargs):
                    return self.bind(**kwargs)

                async def _agenerate(self, messages, **kwargs):
                    seen.append(str(messages[0].content))
                    output = AgentOutput(messages=[], next="done")
                    response = AIMessage(
                        content=output.model_dump_json(),
                        additional_kwargs={"wandrun_agent_output": output.model_dump()},
                    )
                    return ChatResult(generations=[ChatGeneration(message=response)])

            async def run(prompts, task_id):
                return await run_conversation(agents["helper"].graph, prompts, task_id, "helper")

            manager = WorkerManager(run, agent_workers={"helper": ()}, default_agent="helper")
            try:
                agents = build_agents(
                    manager,
                    definitions={"helper": AgentDefinition(
                        "Reads skills", "Work", "offline", skills=("recipe",), code_mode=False,
                    )},
                    models={"helper": Model(responses=[])},
                    tools={"helper": []},
                    environments={"helper": Environment(
                        "local", LocalShellBackend(root_dir=root, virtual_mode=True), "/skills", "/",
                    )},
                    checkpointer=InMemorySaver(),
                )
                manager.start("first turn", "root")
                self.assertEqual((await manager.wait("root"))["status"], "completed")
                replace("New recipe")
                manager.start("second turn", "root")
                self.assertEqual((await manager.wait("root"))["status"], "completed")
                self.assertEqual(len(seen), 2)
                self.assertIn("Old recipe", seen[0])
                self.assertNotIn("New recipe", seen[0])
                self.assertIn("New recipe", seen[1])
                self.assertNotIn("Old recipe", seen[1])
            finally:
                await manager.close()

    async def test_deep_yaml_warns_without_aborting_turn_and_repair_clears_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, extra in (("valid", ""), ("nested", "extra: " + "[" * 600 + "0" + "]" * 600 + "\n")):
                skill = root / "skills" / name / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(
                    f"---\nname: {name}\ndescription: {name} recipe\n{extra}---\nInstructions.\n",
                    encoding="utf-8",
                )
            seen = []

            class Model(FakeMessagesListChatModel):
                def bind_tools(self, tools, **kwargs):
                    return self.bind(**kwargs)

                async def _agenerate(self, messages, **kwargs):
                    seen.append(str(messages[0].content))
                    output = AgentOutput(messages=[], next="done")
                    return ChatResult(generations=[ChatGeneration(message=AIMessage(
                        content=output.model_dump_json(),
                        additional_kwargs={"wandrun_agent_output": output.model_dump()},
                    ))])

            async def run(prompts, task_id):
                return await run_conversation(agents["helper"].graph, prompts, task_id, "helper")

            manager = WorkerManager(run, agent_workers={"helper": ()}, default_agent="helper")
            try:
                agents = build_agents(
                    manager,
                    definitions={"helper": AgentDefinition(
                        "Reads skills", "Work", "offline", skills=("nested", "valid"), code_mode=False,
                    )},
                    models={"helper": Model(responses=[])},
                    tools={"helper": []},
                    environments={"helper": Environment(
                        "local", LocalShellBackend(root_dir=root, virtual_mode=True), "/skills", "/",
                    )},
                    checkpointer=InMemorySaver(),
                )
                for turn in ("first", "unchanged"):
                    manager.start(turn, "root")
                    self.assertEqual((await manager.wait("root"))["status"], "completed")
                for prompt in seen:
                    self.assertIn("valid recipe", prompt)
                    self.assertNotIn("nested recipe", prompt)
                    self.assertIn("/skills/nested/SKILL.md", prompt)
                    self.assertIn("<skill_load_warnings>", prompt)
                (root / "skills" / "nested" / "SKILL.md").write_text(
                    "---\nname: nested\ndescription: Repaired recipe\n---\nInstructions.\n",
                    encoding="utf-8",
                )
                manager.start("repaired", "root")
                self.assertEqual((await manager.wait("root"))["status"], "completed")
                self.assertIn("valid recipe", seen[-1])
                self.assertIn("Repaired recipe", seen[-1])
                self.assertNotIn("<skill_load_warnings>", seen[-1])
            finally:
                await manager.close()

    async def test_unchanged_selection_and_content_skip_update_and_clear_removes_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skills" / "recipe" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text(
                "---\nname: recipe\ndescription: First recipe\n---\nInstructions.\n",
                encoding="utf-8",
            )
            backend = LocalShellBackend(root_dir=root, virtual_mode=True)
            selected = _ConfiguredSkillsMiddleware(backend, ("recipe",), "/skills")
            initial = await selected.abefore_agent({}, None, {})
            self.assertEqual(initial["skills_metadata"][0]["description"], "First recipe")
            self.assertEqual(len(initial["skills_fingerprints"]), 1)
            self.assertIsNone(await selected.abefore_agent(initial, None, {}))

            skill.write_text(
                "---\nname: recipe\ndescription: Second recipe\n---\nInstructions.\n",
                encoding="utf-8",
            )
            refreshed = await selected.abefore_agent(initial, None, {})
            self.assertEqual(refreshed["skills_metadata"][0]["description"], "Second recipe")
            self.assertNotEqual(initial["skills_fingerprints"], refreshed["skills_fingerprints"])
            self.assertIsNone(await selected.abefore_agent(refreshed, None, {}))

            other = root / "skills" / "other" / "SKILL.md"
            other.parent.mkdir()
            other.write_text(
                "---\nname: other\ndescription: Different skill\n---\nInstructions.\n",
                encoding="utf-8",
            )
            switched = await _ConfiguredSkillsMiddleware(
                backend, ("other",), "/skills",
            ).abefore_agent(refreshed, None, {})
            self.assertEqual(switched["skills_selection"], ["other"])
            self.assertEqual(switched["skills_metadata"][0]["description"], "Different skill")

            cleared = _ConfiguredSkillsMiddleware(backend, (), "/skills")
            removed = await cleared.abefore_agent(switched, None, {})
            self.assertEqual(removed["skills_selection"], [])
            self.assertEqual(removed["skills_fingerprints"], [])
            self.assertEqual(removed["skills_metadata"], [])
            self.assertIsNone(await cleared.abefore_agent(removed, None, {}))

    async def test_reopened_builtin_refreshes_checkpoint_path_even_when_content_is_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = LocalShellBackend(root_dir=root, virtual_mode=False)
            previous = None
            for source in (root / "first", root / "second"):
                skill = source / "wandrun-ui" / "SKILL.md"
                skill.parent.mkdir(parents=True)
                skill.write_text(
                    "---\nname: wandrun-ui\ndescription: UI recipe\n---\nBody.\n",
                    encoding="utf-8",
                )
                middleware = _ConfiguredSkillsMiddleware(
                    backend, (), str(root / "skills"),
                    builtin_source=str(source), builtin_names={"wandrun-ui"},
                )
                updated = await middleware.abefore_agent(previous or {}, None, {})
                self.assertIsNotNone(updated)
                self.assertEqual(updated["skills_metadata"][0]["path"], str(skill))
                if previous is not None:
                    self.assertNotEqual(previous["skills_fingerprints"], updated["skills_fingerprints"])
                previous = updated

    async def test_unconfigured_role_has_no_skill_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "skills" / "other" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text(
                "---\nname: other\ndescription: Not for this role.\n---\n"
                "Do not disclose.\n", encoding="utf-8",
            )
            test = self

            class Model(FakeMessagesListChatModel):
                def bind_tools(self, tools, **kwargs):
                    return self.bind(**kwargs)

                async def _agenerate(self, messages, **kwargs):
                    test.assertNotIn("Not for this role.", str(messages[0].content))
                    test.assertNotIn("Available Skills", str(messages[0].content))
                    output = AgentOutput(messages=[], next="done")
                    response = AIMessage(
                        content=output.model_dump_json(),
                        additional_kwargs={"wandrun_agent_output": output.model_dump()},
                    )
                    return ChatResult(generations=[ChatGeneration(message=response)])

            async def run(prompts, task_id):
                return await run_conversation(agents["helper"].graph, prompts, task_id, "helper")

            manager = WorkerManager(run, agent_workers={"helper": ()}, default_agent="helper")
            try:
                agents = build_agents(
                    manager,
                    definitions={"helper": AgentDefinition("No skills", "Work", "offline", code_mode=False)},
                    models={"helper": Model(responses=[])},
                    tools={"helper": []},
                    environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=root, virtual_mode=True), "/skills", "/")),
                    checkpointer=InMemorySaver(),
                )
                manager.start("Proceed", "root")
                self.assertEqual((await manager.wait("root"))["status"], "completed")
            finally:
                await manager.close()

    async def test_missing_configured_skill_reports_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "skills").mkdir()

            async def run(prompts, task_id):
                return await run_conversation(agents["helper"].graph, prompts, task_id, "helper")

            manager = WorkerManager(run, agent_workers={"helper": ()}, default_agent="helper")
            try:
                agents = build_agents(
                    manager,
                    definitions={"helper": AgentDefinition(
                        "Reads skills", "Work", "offline", skills=("missing",), code_mode=False,
                    )},
                    models={"helper": FakeMessagesListChatModel(responses=[])},
                    tools={"helper": []},
                    environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=root, virtual_mode=True), "/skills", "/")),
                    checkpointer=InMemorySaver(),
                )
                manager.start("Proceed", "root")
                status = await manager.wait("root")
                self.assertEqual(status["status"], "failed")
                self.assertIn("未找到配置的 skill: missing", status["error"])
            finally:
                await manager.close()
