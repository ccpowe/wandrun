"""Recovery routing through the real Runtime, SQLite checkpoints and model input."""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from langchain.agents.middleware import AgentMiddleware
from langchain_core.tools import tool

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.agent.capabilities import EntryCapabilityDefinition
from wandrun.runtime.agent.conversations import conversation_config
from wandrun.runtime.communication.scheduler_store import SchedulerStore, paired_store_path
from wandrun.runtime.execution.files import _current_task
from wandrun.runtime.session import open_runtime
from test_runtime import answer, configure


MACHINE_B = "m_" + "b" * 26


def feedback_payload(text):
    if not isinstance(text, str) or "\n" not in text:
        return {}
    try:
        value = json.loads(text.split("\n", 1)[1])
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def recovery_facts(messages):
    return [fact for message in messages
            if message.additional_kwargs.get("source") == "runtime"
            and (fact := feedback_payload(message.content).get("execution_environment", {})).get("status")
            == "recovered"]


def request_texts(body):
    for item in body["input"]:
        if item.get("role") != "user":
            continue
        content = item.get("content", [])
        if isinstance(content, str):
            yield content
        else:
            for part in content:
                if part.get("type") == "input_text":
                    yield part["text"]


def request_recoveries(body):
    return [fact for text in request_texts(body)
            if (fact := feedback_payload(text).get("execution_environment", {})).get("status") == "recovered"]


def capability(name, middleware):
    return EntryCapabilityDefinition(
        name, name, lambda *_: ("enabled", "Controlled test boundary"), lambda *_: middleware,
    )


class RecoveryRoutingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = configure(Path(directory.name))
        cloud = f'type = "instabox"\nmachine_id = "{MACHINE_B}"\nworkdir = "/work"\n'
        self.workspace.environments_config.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n'
            '[environments.cloud]\n' + cloud + '[environments.cloud_alias]\n' + cloud,
            encoding="utf-8",
        )
        self.requests = {}
        self.owners = []

    def catalog(self, environment="local", *, peer=False):
        agents = {"main": AgentDefinition(
            "Root", "Complete the task.", "offline", environment=environment,
            code_mode=False, workers=("peer",) if peer else (),
        )}
        if peer:
            agents["peer"] = AgentDefinition(
                "Peer", "Complete the task.", "offline", environment="cloud_alias", code_mode=False,
            )
        return AgentCatalog("main", agents)

    @asynccontextmanager
    async def runtime(self, catalog, *, respond=None, capabilities=()):
        owners = self.owners

        class RecordingInstabox(InstaboxBackend):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                owners.append(self)

        async def transport(model, body):
            self.requests.setdefault(_current_task.get(), []).append(body)
            if respond is None:
                yield answer("done")
            else:
                async for event in respond(model, body):
                    yield event

        with (
            patch("wandrun.runtime.execution.environments.InstaboxBackend", RecordingInstabox),
            patch.object(InstaboxBackend, "_prepare", AsyncMock(side_effect=AssertionError("cloud I/O"))) as prepare,
            patch.object(CodexSubscriptionModel, "_arequest", transport),
        ):
            async with open_runtime(
                self.workspace, metrics=RunMetrics(self.workspace.runs_dir), on_human=lambda *_: None,
                agent_catalog=catalog, notify_human_of_roots=False, entry_capabilities=capabilities,
            ) as runtime:
                yield runtime
            prepare.assert_not_awaited()

    async def checkpoint(self, runtime, thread):
        config = conversation_config(thread)
        saved = await runtime.checkpointer.aget_tuple(config)
        self.assertIsNotNone(saved)
        # Graph state reconstructs DeltaChannel messages; raw channel_values only
        # supplies the durable observation used by the recovery producer.
        graph = runtime._assembly_for(runtime.workers.agent_name(thread)).graph
        state = (await graph.aget_state(config)).values
        self.assertEqual(
            state.get("observed_environment"),
            saved.checkpoint["channel_values"].get("observed_environment"),
        )
        return state

    async def turn(self, runtime, thread, *, agent="main", prompt="next"):
        runtime.workers.start(prompt, thread, agent_name=agent)
        result = await asyncio.wait_for(runtime.workers.wait(thread), 5)
        self.assertEqual(result["status"], "completed", result)
        return await self.checkpoint(runtime, thread)

    async def recover(self, runtime, owner):
        # Invoke the real callback installed by initial/dynamic Runtime assembly.
        backend = self.owners[-1]
        self.assertEqual(backend.id, "instabox:" + MACHINE_B)
        self.assertIsNotNone(backend._recovery_feedback)
        token = _current_task.set(owner)
        try:
            self.assertTrue(await backend._recovery_feedback("controlled connection recovery"))
        finally:
            _current_task.reset(token)

    def mailboxes(self):
        store = SchedulerStore(paired_store_path(self.workspace.checkpoint_path))
        try:
            return {snapshot.task_id: [message for queue in snapshot.queues.values() for message in queue]
                    for snapshot in store.load()}
        finally:
            store.close()

    async def test_other_task_recovers_b_between_unobserved_a_b_a_switches(self):
        original = self.catalog()
        async with self.runtime(original) as runtime:
            first = await self.turn(runtime, "original")
            identity_a = first["observed_environment"]["identity"]
            # No cloud owner existed initially: this also exercises dynamic callback wiring.
            (await runtime.prepare_agents(self.catalog("cloud")))()
            other = await self.turn(runtime, "other")
            identity_b = other["observed_environment"]["identity"]
            self.assertNotEqual(identity_a, identity_b)
            await self.recover(runtime, "other")
            queued = self.mailboxes()
            self.assertEqual(recovery_facts(queued["original"]), [])
            self.assertEqual([fact["identity"] for fact in recovery_facts(queued["other"])], [identity_b])
            (await runtime.prepare_agents(original))()
            resumed = await self.turn(runtime, "original")
            self.assertEqual(resumed["observed_environment"]["identity"], identity_a)
            self.assertEqual(recovery_facts(resumed["messages"]), [])
            self.assertTrue(all(not request_recoveries(body) for body in self.requests["original"]))
            self.assertEqual(sum("environment_snapshot" in message.additional_kwargs
                                 for message in resumed["messages"]), 1)

    async def test_stale_queued_recovery_is_consumed_before_launch_and_never_revives(self):
        entered = asyncio.Event()
        block = False

        async def respond(model, body):
            if block:
                entered.set()
                await asyncio.Event().wait()
            yield answer("done")

        async with self.runtime(self.catalog("cloud"), respond=respond) as runtime:
            observed = await self.turn(runtime, "thread")
            identity_b = observed["observed_environment"]["identity"]
            await self.recover(runtime, "thread")
            runtime.workers.add_feedback("thread", {"browser_control": {"status": "handed_back"}})
            self.assertEqual([fact["identity"] for fact in recovery_facts(self.mailboxes()["thread"])], [identity_b])
            (await runtime.prepare_agents(self.catalog()))()
            block = True
            runtime.workers.start("continue in A", "thread")
            await asyncio.wait_for(entered.wait(), 5)
            self.assertEqual(request_recoveries(self.requests["thread"][-1]), [])
            self.assertEqual(recovery_facts(self.mailboxes()["thread"]), [])
            await runtime.workers.cancel("thread")
            self.assertTrue(runtime.workers.is_stopped("thread"))
            self.assertEqual(recovery_facts(self.mailboxes()["thread"]), [])
            saved = await self.checkpoint(runtime, "thread")
            self.assertEqual(recovery_facts(saved["messages"]), [])
            self.assertEqual(saved["observed_environment"]["identity"]["type"], "local")
        # The old B fact was rejected, not acknowledged as inflight retry input.
        async with self.runtime(self.catalog("cloud")) as runtime:
            self.assertEqual(recovery_facts(self.mailboxes()["thread"]), [])
            resumed = await self.turn(runtime, "thread")
            self.assertEqual(resumed["observed_environment"]["identity"], identity_b)
            self.assertEqual(recovery_facts(resumed["messages"]), [])
            self.assertEqual(request_recoveries(self.requests["thread"][-1]), [])
            self.assertTrue(any(feedback_payload(text).get("browser_control") == {"status": "handed_back"}
                                for text in request_texts(self.requests["thread"][-1])))

    async def test_alias_observers_receive_once_after_restart_but_stopped_and_first_use_do_not(self):
        entered, release = asyncio.Event(), asyncio.Event()

        class FirstUseGate(AgentMiddleware):
            async def abefore_agent(self, state, runtime):
                if runtime.context["task_id"] == "first-use":
                    entered.set()
                    await release.wait()

        catalog = self.catalog("cloud", peer=True)
        async with self.runtime(catalog, capabilities=(capability("first_use_gate", FirstUseGate),)) as runtime:
            identities = []
            for thread, agent in (("first", "main"), ("second", "main"), ("alias", "peer"), ("stopped", "main")):
                state = await self.turn(runtime, thread, agent=agent)
                identities.append(state["observed_environment"]["identity"])
                self.assertEqual(recovery_facts(state["messages"]), [])
            self.assertTrue(all(identity == identities[0] for identity in identities))
            self.assertEqual(len(self.owners), 1)
            await runtime.workers.cancel("stopped")
            runtime.workers.start("first use of B", "first-use")
            try:
                await asyncio.wait_for(entered.wait(), 5)
                unobserved = await self.checkpoint(runtime, "first-use")
                self.assertNotIn("observed_environment", unobserved)
                await self.recover(runtime, "first")
                queued = self.mailboxes()
                for thread in ("first", "second", "alias"):
                    self.assertEqual([fact["identity"] for fact in recovery_facts(queued[thread])], [identities[0]])
                for thread in ("stopped", "first-use"):
                    self.assertEqual(recovery_facts(queued[thread]), [])
            finally:
                release.set()
            self.assertEqual((await asyncio.wait_for(runtime.workers.wait("first-use"), 5))["status"], "completed")
            self.assertEqual(request_recoveries(self.requests["first-use"][-1]), [])
        # A queued fact is durable, and renaming the current binding does not make it stale.
        renamed = AgentCatalog("main", {
            **catalog.agents, "main": replace(catalog.agents["main"], environment="cloud_alias"),
        })
        async with self.runtime(renamed) as runtime:
            for thread, agent in (("first", "main"), ("second", "main"), ("alias", "peer")):
                for _ in range(2):
                    state = await self.turn(runtime, thread, agent=agent)
                    self.assertEqual([fact["identity"] for fact in recovery_facts(state["messages"])], [identities[0]])
                    self.assertEqual([fact["identity"] for fact in request_recoveries(self.requests[thread][-1])], [identities[0]])
                self.assertEqual(recovery_facts(self.mailboxes()[thread]), [])
            for thread in ("stopped", "first-use"):
                state = await self.turn(runtime, thread)
                self.assertEqual(recovery_facts(state["messages"]), [])
                self.assertEqual(request_recoveries(self.requests[thread][-1]), [])

    async def test_mid_tool_drain_admits_current_recovery_and_preserves_other_messages(self):
        entered, release = asyncio.Event(), asyncio.Event()

        @tool
        async def recovery_gate() -> str:
            """Wait at a controlled tool boundary without contacting the execution environment."""
            entered.set()
            await release.wait()
            return "controlled tool completed"

        def middleware():
            item = AgentMiddleware()
            item.tools = [recovery_gate]
            return item

        async def respond(model, body):
            if _current_task.get() == "active" and len(self.requests["active"]) == 1:
                yield {"type": "response.completed", "response": {
                    "status": "completed", "output": [{
                        "type": "function_call", "id": "recovery-gate", "call_id": "recovery-gate",
                        "name": "recovery_gate", "arguments": "{}",
                    }],
                }}
            else:
                yield answer("done")

        async with self.runtime(
            self.catalog("cloud", peer=True), respond=respond,
            capabilities=(capability("tool_gate", middleware),),
        ) as runtime:
            runtime.workers.start("work", "active")
            try:
                await asyncio.wait_for(entered.wait(), 5)
                current = (await self.checkpoint(runtime, "active"))["observed_environment"]["identity"]
                self.assertEqual(request_recoveries(self.requests["active"][0]), [])
                runtime.workers.start("help", "child", sender_id="active", agent_name="peer")
                self.assertEqual((await asyncio.wait_for(runtime.workers.wait("child"), 5))["status"], "completed")
                await self.recover(runtime, "active")
                foreign = {**current, "location": "instabox:m_" + "c" * 26}
                # Inbox arrivals and producer feedback share the same admission boundary.
                runtime.workers.notify("active", {"execution_environment": {
                    "status": "recovered", "identity": foreign, "note": "delayed foreign fact",
                }})
                runtime.workers.add_feedback("active", {"browser_control": {"status": "handed_back"}})
                runtime.workers.start("ordinary user input", "active")
                runtime.workers.start("ordinary colleague input", "active", sender_id="child", agent_name="main")
            finally:
                release.set()
            result = await asyncio.wait_for(runtime.workers.wait("active"), 5)
            self.assertEqual(result["status"], "completed", result)
            self.assertEqual(len(self.requests["active"]), 2)
            body = self.requests["active"][1]
            self.assertEqual([fact["identity"] for fact in request_recoveries(body)], [current])
            self.assertTrue(any(item.get("type") == "function_call_output"
                                and "controlled tool completed" in item["output"] for item in body["input"]))
            texts = list(request_texts(body))
            self.assertIn("ordinary user input", texts)
            self.assertTrue(any("ordinary colleague input" in text for text in texts))
            self.assertTrue(any(feedback_payload(text).get("browser_control") == {"status": "handed_back"}
                                for text in texts))
            state = await self.checkpoint(runtime, "active")
            self.assertEqual([fact["identity"] for fact in recovery_facts(state["messages"])], [current])
            self.assertEqual(recovery_facts(self.mailboxes()["active"]), [])

    async def test_cancelled_checkpoint_scan_delivers_no_partial_batch_before_retry(self):
        async with self.runtime(self.catalog("cloud")) as runtime:
            first = await self.turn(runtime, "first")
            await self.turn(runtime, "second")
            identity = first["observed_environment"]["identity"]
            entered = asyncio.Event()
            read_checkpoint = runtime.checkpointer.aget_tuple

            async def delayed_read(config):
                saved = await read_checkpoint(config)
                if config["configurable"]["thread_id"] == "second":
                    entered.set()
                    await asyncio.Event().wait()
                return saved

            with patch.object(runtime.checkpointer, "aget_tuple", delayed_read):
                delivery = asyncio.create_task(self.recover(runtime, "first"))
                try:
                    await asyncio.wait_for(entered.wait(), 5)
                    delivery.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await delivery
                finally:
                    if not delivery.done():
                        delivery.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await delivery
            for thread in ("first", "second"):
                self.assertEqual(recovery_facts(self.mailboxes()[thread]), [])
            await self.recover(runtime, "first")
            for thread in ("first", "second"):
                state = await self.turn(runtime, thread)
                self.assertEqual([fact["identity"] for fact in recovery_facts(state["messages"])], [identity])
                self.assertEqual([fact["identity"] for fact in request_recoveries(self.requests[thread][-1])], [identity])

    async def test_accepted_inflight_recovery_is_revalidated_after_cancel_and_restart(self):
        from wandrun.runtime.agent.agents import run_conversation

        entered, release = asyncio.Event(), asyncio.Event()

        async def before_checkpoint(*args, **kwargs):
            entered.set()
            await release.wait()
            return await run_conversation(*args, **kwargs)

        async with self.runtime(self.catalog("cloud")) as runtime:
            first = await self.turn(runtime, "thread")
            identity = first["observed_environment"]["identity"]
            await self.recover(runtime, "thread")
            with patch("wandrun.runtime.session.run_conversation", before_checkpoint):
                runtime.workers.start("accepted but not checkpointed", "thread")
                try:
                    await asyncio.wait_for(entered.wait(), 5)
                    store = SchedulerStore(paired_store_path(self.workspace.checkpoint_path))
                    try:
                        saved = next(item for item in store.load() if item.task_id == "thread")
                        self.assertEqual(
                            [fact["identity"] for fact in recovery_facts(saved.queues["inflight"])],
                            [identity],
                        )
                    finally:
                        store.close()
                    await runtime.workers.cancel("thread")
                finally:
                    release.set()
            self.assertEqual(recovery_facts((await self.checkpoint(runtime, "thread"))["messages"]), [])
        async with self.runtime(self.catalog()) as runtime:
            resumed = await self.turn(runtime, "thread")
            self.assertEqual(resumed["observed_environment"]["identity"]["type"], "local")
            self.assertEqual(recovery_facts(resumed["messages"]), [])
            self.assertEqual(request_recoveries(self.requests["thread"][-1]), [])
            self.assertIn("accepted but not checkpointed", list(request_texts(self.requests["thread"][-1])))
