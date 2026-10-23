"""Optional Harbor integration: private env transport, never shell/exec arguments."""

import importlib.util
import json
import logging
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

_HAS_HARBOR = importlib.util.find_spec("harbor") is not None
if _HAS_HARBOR:
    from harbor.agents.installed.base import AgentAuthenticationError
    from harbor.models.agent.context import AgentContext
    from wandrun.evaluation.harbor_agent import WandrunAgent


class RecordingEnvironment:
    default_user = None

    def __init__(self):
        self.commands = []
        self.uploads = {}
        self.upload_modes = {}

    async def exec(self, **kwargs):
        self.commands.append(kwargs)
        return SimpleNamespace(return_code=0, stdout="", stderr="")

    async def upload_file(self, source, target):
        self.uploads[target] = Path(source).read_text()
        self.upload_modes[target] = Path(source).stat().st_mode & 0o777


@unittest.skipUnless(_HAS_HARBOR, "Harbor is an isolated optional dependency")
class HarborTracingTests(unittest.IsolatedAsyncioTestCase):
    async def run_agent(self, directory, *, enabled=False):
        directory = Path(directory)
        for name in ("agents", "mcps", "environments"):
            (directory / f"{name}.toml").write_text("")
        agent = WandrunAgent(
            logs_dir=directory, package_spec="wandrun.whl",
            agents_config=directory / "agents.toml", langsmith_tracing=enabled,
        )
        agent.context_id = uuid4()
        environment = RecordingEnvironment()
        with (
            patch("wandrun.evaluation.harbor_agent.load_config"),
            patch.object(agent, "_upload_auth", AsyncMock(return_value="/private/codex")),
        ):
            await agent.run("solve task", environment, AgentContext())
        return environment

    async def test_disabled_does_not_forward_ambient_langsmith_credentials_or_parent(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "LANGSMITH_API_KEY": "private-disabled-key",
            "LANGSMITH_TRACING": "true",
            "HARBOR_LANGSMITH_PARENT": "ambient-parent",
        }):
            environment = await self.run_agent(directory)
        self.assertFalse(any("langsmith" in path for path in environment.uploads))
        for call in environment.commands:
            self.assertFalse(any("LANGSMITH" in key for key in (call.get("env") or {})))
            self.assertNotIn("private-disabled-key", call["command"])
            self.assertNotIn("ambient-parent", call["command"])

    @unittest.skipUnless(importlib.util.find_spec("harbor_langsmith"), "requires plugin")
    async def test_enabled_uploads_private_env_without_secret_in_commands_or_logs(self):
        from harbor_langsmith import nesting

        key = "private-key-with-'quotes\nand-newline"
        parent = "trial-specific-parent"
        original = nesting.parent_env

        def per_trial(context_id):
            nesting.publish(context_id, {
                "HARBOR_LANGSMITH_PARENT": parent,
                "HARBOR_LANGSMITH_BAGGAGE": "langsmith-project=experiment",
                "LANGSMITH_PROJECT": "experiment",
            })
            self.addCleanup(nesting.clear, context_id)
            return original(context_id)

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "LANGSMITH_API_KEY": key, "LANGSMITH_ENDPOINT": "https://trace.invalid",
            "LANGSMITH_PROJECT": "wandrun-eval", "LANGSMITH_TRACING": "false",
            "HARBOR_LANGSMITH_PARENT": "wrong-ambient-trial",
            "LANGSMITH_UNRELATED_SECRET": "do-not-forward",
        }), patch("harbor_langsmith.parent_env", side_effect=per_trial), self.assertLogs(
            "harbor", level=logging.DEBUG,
        ) as logs:
            environment = await self.run_agent(directory, enabled=True)
            target = "/installed-agent/wandrun-state/langsmith.env"
            source = Path(directory) / "received.env"
            source.write_text(environment.uploads[target])
            # Execute the actual uploaded shell format: quoted values must survive intact.
            result = subprocess.run([
                "bash", "-c", 'set -a; . "$1"; set +a; python3 -c '
                "'import os,json; print(json.dumps({k:v for k,v in os.environ.items() "
                "if \"LANGSMITH\" in k}))'", "bash", str(source),
            ], env={"PATH": os.environ["PATH"]}, capture_output=True, text=True, check=True)
        values = json.loads(result.stdout)
        self.assertEqual(values["LANGSMITH_API_KEY"], key)
        self.assertEqual(values["LANGSMITH_TRACING"], "true")
        self.assertEqual(values["LANGSMITH_PROJECT"], "experiment")
        self.assertEqual(values["LANGSMITH_ENDPOINT"], "https://trace.invalid")
        self.assertEqual(values["HARBOR_LANGSMITH_PARENT"], parent)
        self.assertNotIn("LANGSMITH_UNRELATED_SECRET", values)
        recorded = repr(environment.commands) + repr([record.__dict__ for record in logs.records])
        self.assertNotIn(key, recorded)
        self.assertNotIn(repr(key)[1:-1], recorded)
        self.assertNotIn("wrong-ambient-trial", recorded)
        self.assertEqual(environment.upload_modes[target], 0o600)
        self.assertFalse(any("LANGSMITH" in name for name in environment.commands[-1]["env"]))

    async def test_enabled_missing_key_fails_without_running_agent(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(AgentAuthenticationError, "LANGSMITH_API_KEY"):
                await self.run_agent(directory, enabled=True)
