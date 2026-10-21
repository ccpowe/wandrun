"""Verify the Codex test HOME hook against synthetic original credentials only."""

import builtins
import io
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from codex_test_home import assert_isolated_codex_home, isolate_codex_home


class CodexTestHomeTests(unittest.TestCase):
    def test_original_home_paths_are_intercepted_without_touching_real_credentials(self):
        with tempfile.TemporaryDirectory(prefix="codex-original-home-") as directory:
            original_home = Path(directory) / "original"
            original_codex = original_home / ".codex"
            original_codex.mkdir(parents=True)
            original_auth = original_codex / "auth.json"
            original_auth.write_bytes(b"synthetic-original-login")

            with (patch.dict(os.environ, {"HOME": str(original_home),
                                       "CODEX_HOME": str(original_codex),
                                       "WANDRUN_CODEX_HOME": str(original_codex)}),
                  patch("codex_test_home.pwd.getpwuid",
                        return_value=SimpleNamespace(pw_dir=str(original_home)))):
                case = unittest.TestCase()
                try:
                    daily = isolate_codex_home(case)
                    assert_isolated_codex_home(case, original_home)
                    self.assertEqual(os.environ.get("WANDRUN_CODEX_HOME"), None)
                    (daily / "auth.json").write_bytes(b"isolated-login")
                    self.assertEqual((daily / "auth.json").read_bytes(), b"isolated-login")

                    def open_fd():
                        fd = os.open(original_auth, os.O_RDONLY)
                        os.close(fd)

                    def scan_directory():
                        with os.scandir(original_codex) as entries:
                            next(entries)

                    def read_builtin():
                        with builtins.open(original_auth, "rb") as stream:
                            stream.read()

                    def read_io():
                        with io.open(original_auth, "rb") as stream:
                            stream.read()

                    probes = {
                        "stat": lambda: os.stat(original_auth),
                        "lstat": lambda: os.lstat(original_auth),
                        "open_fd": open_fd,
                        "scandir": scan_directory,
                        "readlink": lambda: os.readlink(original_auth),
                        "access": lambda: os.access(original_auth, os.R_OK),
                        "builtin_open": read_builtin,
                        "io_open": read_io,
                        "pathlib_read": original_auth.read_bytes,
                    }
                    for name, probe in probes.items():
                        with self.subTest(probe=name):
                            with self.assertRaisesRegex(AssertionError, "real Codex home"):
                                probe()
                finally:
                    case.doCleanups()

                self.assertEqual(Path(os.environ["HOME"]), original_home)
                self.assertEqual(Path(os.environ["CODEX_HOME"]), original_codex)
                self.assertEqual(Path(os.environ["WANDRUN_CODEX_HOME"]), original_codex)
                self.assertEqual(original_auth.read_bytes(), b"synthetic-original-login")
