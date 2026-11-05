"""Execution placement is observed by each model thread, without cloud I/O."""

import asyncio
from dataclasses import replace
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.config import BrowserDefinition
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.runtime.agent.agents import ConversationState
from wandrun.runtime.agent.conversations import conversation_config
from wandrun.runtime.communication.messages import runtime_message
from wandrun.runtime.context.compaction import CompactionMiddleware, context_messages, message_groups
from wandrun.runtime.context.environment_runtime import (
    ObservedEnvironmentMiddleware, environment_snapshot_index, recovery_feedback_applies,
)
from wandrun.runtime.execution.environments import Environment
from test_compaction import media_read_call, reply


def placement(root="/workspace", *, machine=None, name="alias"):
    backend = SimpleNamespace(cwd=Path(root), id="instabox:" + (machine or "unused"))
    return Environment(name, backend, root + "/.wandrun/skills", root + "/.wandrun/artifacts",
                       type="local" if machine is None else "instabox", workspace_root=root)


def snapshots(state):
    return [message for message in state["messages"]
            if message.additional_kwargs.get("environment_snapshot") is not None]


async def observe(environment, state):
    update = await ObservedEnvironmentMiddleware(environment).abefore_model(state, None)
    if update is None:
        return state
    return {**state, **update, "messages": [*state["messages"], *update["messages"]]}


class EnvironmentObservationTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_first_use_aliases_and_unobserved_round_trip(self):
        local = placement()
        state = await observe(local, {"messages": []})
        self.assertEqual(len(snapshots(state)), 1)
        self.assertIn('"status": "initial"', snapshots(state)[0].content)
        self.assertIn("Local", snapshots(state)[0].content)
        # Building bindings is not an observation: A -> B(no run) -> A is net zero.
        ObservedEnvironmentMiddleware(placement(machine="machine-b"))
        state = await observe(replace(local, name="other-alias"), state)
        self.assertEqual(len(snapshots(state)), 1)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            original = placement(str(root))
            same = replace(original, name="renamed", workspace_root=str(alias))
            self.assertEqual(original.context_identity(), same.context_identity())

    async def test_actual_switches_coalesce_and_threads_are_independent(self):
        a, b, c = placement(), placement(machine="b"), placement(machine="c")
        left = await observe(a, {"messages": []})
        right = await observe(b, {"messages": []})
        left = await observe(b, left)
        left = await observe(replace(b, name="another-name"), left)
        left = await observe(a, left)
        self.assertEqual(len(snapshots(left)), 3)
        self.assertEqual(sum('"status": "changed"' in m.content for m in snapshots(left)), 2)
        self.assertEqual(len(snapshots(right)), 1)
        self.assertEqual(right["observed_environment"]["identity"]["location"], "instabox:b")
        # Only the final binding is prepared, so B is absent from A -> C history.
        final = await observe(c, await observe(a, {"messages": []}))
        self.assertEqual(len(snapshots(final)), 2)
        self.assertNotIn("instabox:b", snapshots(final)[-1].content)
        moved = await observe(replace(c, workspace_root="/another-root"), final)
        self.assertEqual(len(snapshots(moved)), 3)
        self.assertIn("/another-root", snapshots(moved)[-1].content)

    async def test_machine_identity_survives_owner_recreation_without_preparation(self):
        machine = "m_" + "a" * 26
        owners = [InstaboxBackend(machine, workdir="/workspace") for _ in range(2)]
        for owner in owners:
            self.addAsyncCleanup(owner.aclose)
        with patch.object(InstaboxBackend, "_prepare", AsyncMock(side_effect=AssertionError("cloud I/O"))) as prepare:
            first = replace(placement(machine=machine), backend=owners[0])
            second = replace(first, backend=owners[1], name="renamed", workspace_root="/workspace/./")
            state = await observe(first, {"messages": []})
            state = await observe(second, state)
        prepare.assert_not_awaited()
        self.assertEqual(len(snapshots(state)), 1)
        self.assertEqual(state["observed_environment"]["identity"]["location"], "instabox:" + machine)

    async def test_marker_without_notice_restores_current_not_false_switch(self):
        environment = placement()
        state = await observe(environment, {"messages": []})
        missing = {**state, "messages": []}
        repaired = await observe(environment, missing)
        self.assertEqual(repaired["observed_environment"], state["observed_environment"])
        self.assertIn('"status": "current"', snapshots(repaired)[0].content)
        self.assertNotIn('"status": "changed"', snapshots(repaired)[0].content)
        self.assertEqual(environment_snapshot_index(repaired), 0)

    async def test_instabox_browser_observation_reports_configuration_without_waking_machine(self):
        owner = InstaboxBackend("m_" + "b" * 26, workdir="/workspace")
        self.addAsyncCleanup(owner.aclose)
        environment = replace(placement(machine="m_" + "b" * 26), backend=owner)
        with patch.object(InstaboxBackend, "_prepare", side_effect=AssertionError("cloud I/O")):
            state = await observe(environment, {"messages": []})
            self.assertFalse(state["observed_environment"]["browser"]["configured"])
            configured = replace(
                environment, browser=BrowserDefinition(cdp_port=9333, profile_dir="/data/home/b/p"),
            )
            state = await observe(configured, state)
            browser = state["observed_environment"]["browser"]
            self.assertTrue(browser["configured"])
            self.assertIn("未探测", browser["availability"])
            self.assertIn('python3 "$WANDRUN_BROWSER_START"', browser["startup"])
            self.assertNotIn('"status": "changed"', snapshots(state)[-1].content)
            repeated = await observe(replace(configured, name="same-machine"), state)
            self.assertIs(repeated, state)


class EnvironmentCheckpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_sqlite_restart_and_alias_rebuild_preserve_observation(self):
        calls = []
        class Model(CodexSubscriptionModel):
            async def _agenerate(self, messages, **kwargs):
                calls.append(messages)
                return ChatResult(generations=[ChatGeneration(message=AIMessage(content="done"))])

        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "checkpoints.sqlite")
            environment = placement(machine="stable-machine")
            config = conversation_config("thread")
            for name in ("first-alias", "after-restart"):
                async with AsyncSqliteSaver.from_conn_string(path) as saver:
                    graph = create_agent(Model(), state_schema=ConversationState, checkpointer=saver,
                                         middleware=[ObservedEnvironmentMiddleware(replace(environment, name=name))])
                    await graph.ainvoke({"messages": [HumanMessage(content=name)]}, config,
                                        context={"task_id": "thread"}, durability="sync")
                    state = (await graph.aget_state(config)).values
                    self.assertEqual(len(snapshots(state)), 1)
                    self.assertIsNotNone(environment_snapshot_index(state))
            self.assertEqual(len(calls), 2)
            self.assertEqual(sum("environment_snapshot" in m.additional_kwargs for m in calls[-1]), 1)

    async def test_failed_or_cancelled_model_keeps_notice_and_marker_together(self):
        for failure in ("error", "cancel"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                entered = asyncio.Event()
                failed = False
                calls = []
                class Model(CodexSubscriptionModel):
                    async def _agenerate(self, messages, **kwargs):
                        calls.append(messages)
                        if failed:
                            entered.set()
                            if failure == "error":
                                raise RuntimeError("controlled model failure")
                            await asyncio.Event().wait()
                        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="done"))])
                async with AsyncSqliteSaver.from_conn_string(str(Path(directory) / "state.sqlite")) as saver:
                    graph = create_agent(Model(), state_schema=ConversationState, checkpointer=saver,
                                         middleware=[ObservedEnvironmentMiddleware(placement())])
                    config = conversation_config("interrupted")
                    await graph.ainvoke({"messages": [HumanMessage(content="initial local use")]}, config,
                                        context={"task_id": "interrupted"}, durability="sync")
                    graph = create_agent(Model(), state_schema=ConversationState, checkpointer=saver,
                                         middleware=[ObservedEnvironmentMiddleware(placement(machine="new-machine"))])
                    failed = True
                    job = asyncio.create_task(graph.ainvoke(
                        {"messages": [HumanMessage(content="start")]}, config,
                        context={"task_id": "interrupted"}, durability="sync"))
                    await asyncio.wait_for(entered.wait(), 5)
                    if failure == "cancel":
                        job.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await job
                    else:
                        with self.assertRaisesRegex(RuntimeError, "controlled model failure"):
                            await job
                    saved = (await graph.aget_state(config)).values
                    self.assertEqual(len(snapshots(saved)), 2)
                    self.assertEqual(saved["observed_environment"]["identity"]["location"], "instabox:new-machine")
                    self.assertIsNotNone(environment_snapshot_index(saved))
                    failed = False
                    state = await graph.ainvoke({"messages": [HumanMessage(content="resume")]}, config,
                                                context={"task_id": "interrupted"}, durability="sync")
                    self.assertEqual(len(snapshots(state)), 2)
                    self.assertEqual(sum("environment_snapshot" in m.additional_kwargs for m in calls[-1]), 2)

    async def test_compaction_keeps_current_snapshot_and_closed_tool_group_without_reannouncing(self):
        calls = []
        class Model(CodexSubscriptionModel):
            async def _agenerate(self, messages, **kwargs):
                calls.append(messages)
                return ChatResult(generations=[ChatGeneration(message=reply(usage=False))])
        with tempfile.TemporaryDirectory() as directory:
            async with AsyncSqliteSaver.from_conn_string(str(Path(directory) / "state.sqlite")) as saver:
                environment = placement(machine="current-machine")
                graph = create_agent(Model(), state_schema=ConversationState, checkpointer=saver, middleware=[
                    ObservedEnvironmentMiddleware(environment),
                    CompactionMiddleware(context_window=10_000, keep_tokens=100),
                ])
                config = conversation_config("compact")
                await graph.ainvoke({"messages": [HumanMessage(content="initial")]}, config,
                                    context={"task_id": "compact"}, durability="sync")
                tool_call = media_read_call()
                tool_result = ToolMessage(content="task evidence", tool_call_id="read")
                with patch("wandrun.runtime.context.compaction.summarize_request",
                           AsyncMock(return_value=AIMessage(content="Historical facts"))):
                    await graph.ainvoke({"messages": [
                        reply("diagnostic " * 10000, usage=False), tool_call, tool_result,
                        HumanMessage(content="latest instruction"),
                    ]}, config, context={"task_id": "compact"}, durability="sync")
                state = (await graph.aget_state(config)).values
                self.assertTrue(state["compaction_events"])
                self.assertEqual(len(snapshots(state)), 1)
                view = context_messages(state)
                self.assertEqual(len(snapshots({"messages": view})), 1)
                self.assertIn("current-machine", snapshots({"messages": calls[-1]})[0].content)
                self.assertLess(len(view), len(state["messages"]))
                start, end = next(
                    (start, end) for start, end in message_groups(view)
                    if any(isinstance(message, ToolMessage) and message.tool_call_id == "read"
                           for message in view[start:end])
                )
                self.assertEqual(
                    [call["id"] for message in view[start:end] if isinstance(message, AIMessage)
                     for call in message.tool_calls],
                    [message.tool_call_id for message in view[start:end] if isinstance(message, ToolMessage)],
                )
                # Even a projection that drops runtime text cannot erase its authority.
                projected = [m for m in state["messages"] if "environment_snapshot" not in m.additional_kwargs]
                self.assertEqual(len(snapshots({"messages": context_messages(state, projected=projected)})), 1)
                state = await graph.ainvoke({"messages": [HumanMessage(content="continue")]}, config,
                                            context={"task_id": "compact"}, durability="sync")
                self.assertEqual(len(snapshots(state)), 1)
                self.assertEqual(sum("environment_snapshot" in m.additional_kwargs for m in calls[-1]), 1)


class RecoveryFeedbackAdmissionTests(unittest.TestCase):
    def test_recovery_uses_physical_identity_and_workspace_not_environment_alias(self):
        environment = placement(machine="stable", name="before")
        identity = environment.context_identity()
        message = runtime_message({"execution_environment": {
            "status": "recovered", "identity": identity, "note": "connection recovered",
        }})
        alias = replace(environment, name="after", workspace_root="/workspace/./")
        self.assertTrue(recovery_feedback_applies(message, alias.context_identity()))
        for current in (
            None,
            placement(machine="other").context_identity(),
            replace(environment, workspace_root="/other-workspace").context_identity(),
            placement().context_identity(),
        ):
            with self.subTest(current=current):
                self.assertFalse(recovery_feedback_applies(message, current))

    def test_unverifiable_recovery_is_not_admitted_as_current_environment(self):
        identity = placement(machine="stable").context_identity()
        for recovered in (
            {"status": "recovered", "name": "alias"},
            {"status": "recovered", "identity": None},
            {"status": "recovered", "identity": "stable"},
            {"status": "recovered", "identity": {"location": identity["location"]}},
            {"status": "recovered", "identity": {**identity, "workspace": ""}},
        ):
            with self.subTest(recovered=recovered):
                message = runtime_message({"execution_environment": recovered})
                self.assertFalse(recovery_feedback_applies(message, identity))

    def test_other_runtime_facts_and_untrusted_lookalikes_pass_unchanged(self):
        recovery = runtime_message({"execution_environment": {
            "status": "recovered", "identity": placement(machine="other").context_identity(),
        }})
        ordinary = [
            HumanMessage(content="ordinary user input"),
            HumanMessage(content=recovery.content),
            HumanMessage(content=recovery.content, additional_kwargs={"source": "worker", "sender_id": "peer"}),
            runtime_message({"deliveries": [{"accepted": True}]}, receipt_for="response"),
            runtime_message({"browser_control": {"status": "handed_back"}}),
            runtime_message({"execution_environment": {"status": "changed"}}),
        ]
        for message in ordinary:
            with self.subTest(message=message):
                before = message.model_dump()
                self.assertTrue(recovery_feedback_applies(message, None))
                self.assertEqual(message.model_dump(), before)
