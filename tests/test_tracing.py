"""Development tracing stays optional; cloud payloads preserve identity, never credentials."""

import asyncio
import builtins
import json
import os
import tempfile
import threading
import unittest
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import quote
from uuid import uuid4

import requests
from langchain.messages import HumanMessage
from langsmith.run_helpers import get_current_run_tree

from test_runtime import answer, configure
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.session import open_runtime
from wandrun.runtime.tracing import RuntimeTracing, TraceRedactor, _create_client
from wandrun.runtime.workers import WorkerManager


class RecordingSession(requests.Session):
    """Exercise the real SDK send path without contacting any service."""

    def __init__(self):
        super().__init__()
        self.payloads = []
        self.delivered = threading.Event()

    def request(self, method, url, **kwargs):
        if method in {"POST", "PATCH"} and "/runs" in url:
            self.payloads.append(json.loads(kwargs["data"]))
            if method == "PATCH":
                self.delivered.set()
        response = requests.Response()
        response.status_code = 200
        response._content = b"{}"
        response.url = url
        return response


class TracePrivacyTests(unittest.TestCase):
    def test_create_and_update_redact_every_text_field_before_transport(self):
        old, new = "private-old-token-7f19", 'private-new-"token-938b'
        secrets = [old]
        redactor = TraceRedactor(lambda: tuple(secrets))
        redactor.remember((old,))
        session = RecordingSession()
        client = _create_client(
            redactor, api_url="https://trace.invalid", api_key="synthetic-unit-test-key",
            session=session, auto_batch_tracing=False,
        )
        self.addCleanup(client.close)
        identity = uuid4()
        client.create_run(
            f"run {old}", {"messages": [HumanMessage(content=f"context {old}")]}, "llm",
            id=identity, serialized={"repr": f"adapter({old})"},
            extra={"invocation_params": {"safe": old}, "metadata": {"agent_id": "lead"}},
            tags=[old], attachments={"private": ("text/plain", old.encode())},
        )
        secrets[:] = [new]  # Cumulative registration must retain the old generation.
        client.update_run(
            identity, outputs={"messages": [HumanMessage(content=f"{old} {new} {quote(new)}")], "bytes": old.encode()},
            error=f"tool failed: {old} {new}", extra={"invocation_params": {new: new}},
        )
        client.close()  # No pre-wait: close must not race an extra preprocessing stage.
        self.assertTrue(session.delivered.is_set(), "final patch lost during close")
        payload = json.dumps(session.payloads)
        for secret in (old, new, quote(new), json.dumps(new)[1:-1]):
            self.assertNotIn(secret, payload)
        created = next(item for item in session.payloads if "inputs" in item)
        patched = next(item for item in session.payloads if "outputs" in item)
        self.assertEqual(created["id"], str(identity))
        self.assertEqual(created["extra"]["metadata"]["agent_id"], "lead")
        self.assertNotIn("attachments", created)
        self.assertIn("context [redacted]", json.dumps(created["inputs"]))
        self.assertEqual(created["serialized"]["repr"], "adapter([redacted])")
        self.assertIn("[redacted]", patched["error"])
        self.assertEqual(patched["outputs"]["bytes"], "[redacted]")

    def test_named_credentials_are_removed_without_hiding_usage_or_plain_text(self):
        redactor = TraceRedactor()
        run = {
            "id": str(uuid4()), "name": "model", "run_type": "llm",
            "inputs": {"headers": {"Authorization": "unknown"}, "api_key": "unknown"},
            "outputs": {"text": "ordinary answer", "usage_metadata": {"input_tokens": 12, "output_tokens": 3}},
            "error": "access_token=unregistered-secret Bearer opaque-credential",
            "events": [{"message": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"}],
        }
        clean = redactor([run])[0]
        self.assertEqual(clean["outputs"], run["outputs"])
        self.assertEqual(clean["inputs"], {"headers": "[redacted]", "api_key": "[redacted]"})
        self.assertNotIn("unregistered-secret", clean["error"])
        self.assertNotIn("opaque-credential", clean["error"])
        self.assertEqual(clean["events"][0]["message"], "[redacted]")
        self.assertEqual(run["inputs"]["api_key"], "unknown")

    def test_dynamic_connectors_and_subscription_generations_remain_private(self):
        tracer = RuntimeTracing(client=SimpleNamespace())
        old, new, login = "connector-old-783f", "connector-new-44a2", "login-token-b018"
        tracer.remember_connectors({"service": {"headers": {"Authorization": f"Bearer {old}"}}})
        tracer.remember_connectors({"service": {"env": {"SERVICE_API_KEY": new}}})
        tracer.remember_credentials(SimpleNamespace(tokens={"access_token": login}, headers={}))
        run = tracer.redactor([{"id": str(uuid4()), "inputs": {"text": f"{old} {new} {login}"}}])[0]
        self.assertEqual(run["inputs"]["text"], "[redacted] [redacted] [redacted]")

    def test_redaction_source_failure_never_returns_raw_payload(self):
        def fail():
            raise ValueError("sensitive source detail")

        redactor = TraceRedactor(fail)
        with self.assertRaisesRegex(RuntimeError, "batch not uploaded") as caught:
            redactor([{"inputs": {"text": "private"}}])
        self.assertNotIn("sensitive source detail", str(caught.exception))


class TraceWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_trace_upload_does_not_consume_execution_cleanup_deadline(self):
        entered, release = threading.Event(), threading.Event()

        class SlowClient:
            closed = False

            def close(self, **kwargs):
                entered.set()
                release.wait(5)
                self.closed = True

        client = SlowClient()
        tracing = RuntimeTracing(client=client)
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))

            async def run():
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda *_: None, cleanup_timeout=0.05,
                ):
                    pass
                return "execution resources released"

            with (
                patch.dict(os.environ, {"LANGSMITH_TRACING": "true"}),
                patch("wandrun.runtime.tracing.RuntimeTracing", return_value=tracing),
            ):
                task = asyncio.create_task(run())
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 5))
                    await asyncio.sleep(0.1)  # Deliberately longer than the execution deadline.
                    self.assertFalse(task.done(), "runtime abandoned its tracing client")
                finally:
                    release.set()
                self.assertEqual(await task, "execution resources released")
        self.assertTrue(client.closed)

    async def test_disabled_runtime_keeps_outputs_and_never_constructs_tracing_client(self):
        shown = []

        async def respond(model, body):
            yield answer("offline reply")

        original_import = builtins.__import__

        def guard(name, *args, **kwargs):
            if name == "wandrun.runtime.tracing":
                raise AssertionError("disabled runtime imported tracing integration")
            return original_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            with (
                patch.dict(os.environ, {"LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false"}),
                patch("builtins.__import__", side_effect=guard),
                patch("langsmith.Client", side_effect=AssertionError("unexpected tracing client")),
                patch.object(CodexSubscriptionModel, "_arequest", respond),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    on_human=lambda _, text, *_rest: shown.append(text),
                    notify_human_of_roots=False,
                ) as runtime:
                    runtime.workers.start("hello", "root")
                    result = await asyncio.wait_for(runtime.workers.wait("root"), 5)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(shown, ["offline reply"])

    async def test_harbor_parent_survives_isolated_worker_context(self):
        from langsmith.run_trees import RunTree

        trial = RunTree(name="harbor-trial")
        phase = trial.create_child("agent_start")
        observed = {}

        async def operation(prompts, task_id):
            observed[task_id] = get_current_run_tree()
            return AgentOutput(messages=[], next="done")

        with (
            patch.dict(os.environ, {
                "HARBOR_LANGSMITH_PARENT": phase.dotted_order,
                "HARBOR_LANGSMITH_BAGGAGE": "langsmith-project=private-evaluation",
            }),
            patch("langsmith.utils.tracing_is_enabled", return_value="local"),
        ):
            tracer = RuntimeTracing(client=SimpleNamespace())
            manager = WorkerManager(
                tracer.wrap_worker(operation, lambda: manager),
                agent_workers={"lead": ()}, default_agent="lead",
            )
            self.addAsyncCleanup(manager.close)
            for identity in ("first", "second"):
                manager.start("hello", identity)
                await manager.wait(identity)
        for identity, span in observed.items():
            self.assertEqual(span.parent_run_id, phase.id)
            self.assertEqual(span.trace_id, trial.id)
            self.assertEqual(span.session_name, "private-evaluation")
            self.assertEqual(span.metadata["task_id"], identity)
            self.assertEqual(span.metadata["root_task_id"], identity)
        self.assertNotEqual(observed["first"].id, observed["second"].id)

    async def test_independent_workers_preserve_task_ancestry_and_child_metadata(self):
        # Local SDK mode constructs real RunTrees and native ancestry without uploads.
        observed = {}
        parent_context = ContextVar("private_execution", default="isolated")
        parent_context.set("must not propagate")
        tracer = RuntimeTracing(client=SimpleNamespace())
        manager = None
        child_ready, release_child = asyncio.Event(), asyncio.Event()
        children = []

        async def operation(prompts, task_id):
            span = get_current_run_tree()
            observed.setdefault(task_id, []).append((span, parent_context.get()))
            if task_id == "root" and not children:
                children.append(manager.dispatch(AgentOutput(messages=[
                    SendMessage(to="helper", task_id=None, message="work"),
                ], next="wait"), task_id)[0]["task_id"])
                await child_ready.wait()
                return AgentOutput(messages=[], next="wait")
            if task_id != "root":
                child_ready.set()
                await release_child.wait()
            return AgentOutput(messages=[], next="done")

        # Suppress only SDK transport; actual context/RunTree/WorkerManager all run.
        with patch("langsmith.utils.tracing_is_enabled", return_value="local"):
            manager = WorkerManager(
                tracer.wrap_worker(operation, lambda: manager),
                agent_workers={"lead": ("helper",), "helper": ()}, default_agent="lead",
            )
            self.addAsyncCleanup(manager.close)
            manager.start("hello", "root")
            await asyncio.wait_for(child_ready.wait(), 5)
            await manager.wait("root")
            release_child.set()
            await manager.wait(children[0])
            manager.start("continue", "root")
            await manager.wait("root")
        parent, _ = observed["root"][0]
        continuation, _ = observed["root"][1]
        child, context = observed[children[0]][0]
        self.assertEqual(context, "isolated")
        self.assertEqual(child.parent_run_id, parent.id)
        self.assertEqual(child.trace_id, parent.trace_id)
        self.assertEqual(continuation.parent_run_id, parent.id)
        self.assertIs(child.client, tracer.client)
        self.assertIs(continuation.client, tracer.client)
        self.assertEqual(child.metadata["agent_id"], "helper")
        self.assertEqual(child.metadata["task_id"], children[0])
        self.assertEqual(child.metadata["parent_task_id"], "root")
        self.assertEqual(child.metadata["conversation_id"], "root")
        self.assertEqual(child.metadata["root_task_id"], "root")
        self.assertEqual(parent.metadata["status"], "waiting")
        self.assertEqual(child.metadata["status"], "completed")
        self.assertEqual(continuation.metadata["status"], "completed")
