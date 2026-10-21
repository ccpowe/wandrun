"""Keep synthetic Codex tests in a per-case HOME; this lexical hook is not a sandbox."""

import builtins
import io
import os
from pathlib import Path
import pwd
import tempfile
from unittest.mock import patch


def isolate_codex_home(case):
    """Give a unittest case disposable HOME/CODEX_HOME, restoring them at cleanup.

    The monkeypatch compares paths lexically without probing forbidden paths. It
    is not a sandbox: dir_fd-relative access, symlink aliases, and subprocesses
    are outside its interception boundary.
    """
    if hasattr(case, "_isolated_codex_home"):
        return case._isolated_codex_home
    user_home = pwd.getpwuid(os.getuid()).pw_dir
    daily_homes = (Path(user_home) / ".codex",
                   Path(os.environ.get("HOME", user_home)) / ".codex")
    forbidden = tuple(os.path.normcase(os.path.abspath(path)) for path in daily_homes)

    def deny_real_daily(path):
        if isinstance(path, (str, bytes, os.PathLike)):
            candidate = os.path.normcase(os.path.abspath(os.fsdecode(path)))
            if any(candidate == home or candidate.startswith(home + os.sep) for home in forbidden):
                raise AssertionError("Test attempted to access the real Codex home")

    for target in ("os.stat", "os.lstat", "os.open", "os.scandir",
                   "os.readlink", "os.access", "io.open", "builtins.open"):
        module, name = target.split(".")
        original = getattr({"os": os, "io": io, "builtins": builtins}[module], name)

        def guarded(path, *args, _original=original, **kwargs):
            deny_real_daily(path)
            return _original(path, *args, **kwargs)

        guard = patch(target, guarded)
        guard.start()
        case.addCleanup(guard.stop)

    directory = tempfile.TemporaryDirectory(prefix="codex-test-home-")
    case.addCleanup(directory.cleanup)
    root = Path(directory.name)
    daily = root / ".codex"
    daily.mkdir()
    environment = patch.dict(os.environ, {"HOME": str(root), "CODEX_HOME": str(daily)})
    environment.start()
    case.addCleanup(environment.stop)
    os.environ.pop("WANDRUN_CODEX_HOME", None)
    case._isolated_codex_home = daily
    return daily


def assert_isolated_codex_home(case, original_home):
    """Assert a test case uses its disposable Codex HOME rather than the original HOME."""
    daily = getattr(case, "_isolated_codex_home", None)
    case.assertIsInstance(daily, Path)
    case.assertNotEqual(daily.parent, Path(original_home))
    case.assertEqual(Path(os.environ["HOME"]), daily.parent)
    case.assertEqual(Path(os.environ["CODEX_HOME"]), daily)
