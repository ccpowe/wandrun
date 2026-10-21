"""Real gateway processes must not publish credentials before owning their port."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from codex_test_home import isolate_codex_home
from wandrun.gateway.app import serve
from wandrun.integrations.codex_credentials import CodexCredentials
from wandrun.runtime.workspace import Workspace


PORT = 8785


class GatewayStartupTests(unittest.TestCase):
    def setUp(self):
        isolate_codex_home(self)

    def _command(self, workspace: Path, *args: str) -> list[str]:
        command = [sys.executable, "-m", "wandrun.gateway", *args, "--workspace", str(workspace)]
        if not args or args[0] != "pair":
            # Each process has an empty, isolated login so this port-ownership
            # test never reads developer credentials or calls the real provider.
            home = tempfile.mkdtemp(prefix="codex-home-", dir=workspace)
            command += ["--codex-home", home]
        return command

    def _start(self, workspace: Path) -> subprocess.Popen:
        return subprocess.Popen(
            self._command(workspace, "--port", str(PORT)),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    def _list(self, workspace: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            self._command(workspace, "pair", "--list"),
            capture_output=True, text=True, timeout=8,
        )

    def _wait_ready(self, process: subprocess.Popen, workspace: Path, previous: bytes | None = None) -> bytes:
        credential_path = workspace / ".wandrun" / "state" / "management.json"
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if process.poll() is not None:
                self.fail(f"gateway exited before readiness ({process.returncode})")
            if credential_path.exists():
                credential = credential_path.read_bytes()
                if credential != previous and self._list(workspace).returncode == 0:
                    return credential
            time.sleep(.1)
        self.fail("gateway did not accept pair --list before deadline")

    def _stop(self, process: subprocess.Popen) -> None:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def test_failed_duplicate_start_preserves_running_management_and_restart_rotates(self):
        with tempfile.TemporaryDirectory(prefix="gateway-startup-", dir=os.environ.get("TMPDIR")) as directory:
            workspace = Path(directory)
            # The default config needs Chrome on 9222 and Exa; this port-ownership
            # test must not reach the developer's browser or the network.
            Workspace(workspace).ensure_config()
            (workspace / ".wandrun" / "environments.toml").write_text(
                'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
            )
            (workspace / ".wandrun" / "mcps.toml").write_text("[mcp_servers]\n", encoding="utf-8")
            agents = workspace / ".wandrun" / "agents.toml"
            agents.write_text(
                agents.read_text(encoding="utf-8")
                .replace('mcp_servers = ["exa"]', "mcp_servers = []")
                .replace('skills = ["browser", "skill-installer"]', 'skills = ["skill-installer"]'),
                encoding="utf-8",
            )
            first = self._start(workspace)
            try:
                old = self._wait_ready(first, workspace)
                duplicate = subprocess.Popen(
                    self._command(workspace, "--port", str(PORT)),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                try:
                    _, stderr = duplicate.communicate(timeout=40)
                    self.assertNotEqual(duplicate.returncode, 0)
                    self.assertIn("Address already in use", stderr)
                finally:
                    self._stop(duplicate)
                path = workspace / ".wandrun" / "state" / "management.json"
                self.assertEqual(path.read_bytes(), old)
                self.assertIsNone(first.poll())
                listed = self._list(workspace)
                self.assertEqual(listed.returncode, 0, listed.stderr)
            finally:
                self._stop(first)

            restarted = self._start(workspace)
            try:
                new = self._wait_ready(restarted, workspace, old)
                self.assertNotEqual(json.loads(old)["token"], json.loads(new)["token"])
                listed = self._list(workspace)
                self.assertEqual(listed.returncode, 0, listed.stderr)
            finally:
                self._stop(restarted)

    def test_failed_metrics_startup_releases_credential_owner(self):
        with tempfile.TemporaryDirectory(prefix="gateway-startup-", dir=os.environ.get("TMPDIR")) as directory:
            workspace = Path(directory)
            runtime_dir = workspace / ".wandrun"
            runtime_dir.mkdir()
            (runtime_dir / "runs").write_text("not a directory", encoding="utf-8")
            codex_home = workspace / "codex-home"
            codex_home.mkdir()
            original_gateway = CodexCredentials.gateway
            acquired = []

            def acquire(*args, **kwargs):
                owner = original_gateway(*args, **kwargs)
                acquired.append(owner)
                return owner

            with patch.object(CodexCredentials, "gateway", side_effect=acquire):
                with self.assertRaises(NotADirectoryError):
                    asyncio.run(serve(
                        workspace=workspace, host="127.0.0.1", port=0, codex_home=codex_home,
                    ))

            self.assertEqual(len(acquired), 1)
            owner = acquired[0]
            try:
                self.assertTrue(owner._closed)
                self.assertIsNone(owner._directory)
                self.assertIsNone(owner._lock_file)
                second = CodexCredentials.gateway(codex_home)
                try:
                    self.assertFalse(second._closed)
                finally:
                    second.close()
            finally:
                owner.close()
