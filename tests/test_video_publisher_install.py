"""The starter serializes and atomically publishes optional video dependencies."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "src/wandrun/defaults/skills/browser/scripts/start_browser.py"
)
LAUNCHER = "import runpy,json,sys; print(json.dumps(runpy.run_path(sys.argv[1])['ensure_video_publisher']()))"
UV = """
import os
from pathlib import Path
import sys
import time

if sys.argv[1] == 'venv':
    root = Path(sys.argv[-1]); (root / 'bin').mkdir(exist_ok=True)
    python = root / 'bin' / 'python'
    python.write_text('#!%s\\nfrom pathlib import Path\\nraise SystemExit(0 if Path(__file__).parent.parent.joinpath("installed").exists() else 1)\\n' % sys.executable)
    python.chmod(0o700)
else:
    root = Path(sys.argv[sys.argv.index('--python')+1]).parent.parent
    with Path(os.environ['INSTALL_CALLS']).open('a') as stream: stream.write('install\\n')
    time.sleep(float(os.environ.get('INSTALL_DELAY','0')))
    if os.environ.get('INSTALL_FAIL') == 'yes': raise SystemExit(17)
    (root / 'installed').touch()
"""


class VideoInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        uv = self.bin / "uv"
        uv.write_text("#!%s\n%s" % (sys.executable, textwrap.dedent(UV)))
        uv.chmod(0o700)
        self.env = dict(
            os.environ,
            PATH=str(self.bin),
            WANDRUN_VIDEO_PUBLISHER_DIR=str(self.root / "video"),
            INSTALL_CALLS=str(self.root / "calls"),
        )
        self.commands = []
        self.addCleanup(self.stop)

    def start(self, **env):
        process = subprocess.Popen(
            [sys.executable, "-c", LAUNCHER, str(SCRIPT)],
            env=dict(self.env, **env),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.commands.append(process)
        return process

    def result(self, process, code=0):
        out, err = process.communicate(timeout=10)
        self.assertEqual(process.returncode, code, err)
        return json.loads(out) if code == 0 else err

    def stop(self):
        for process in self.commands:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

    def test_concurrent_first_install_is_published_once(self):
        first, second = self.start(INSTALL_DELAY="0.2"), self.start(INSTALL_DELAY="0.2")
        reports = [self.result(first), self.result(second)]
        self.assertEqual(sorted(r["installed"] for r in reports), [False, True])
        self.assertEqual((self.root / "calls").read_text().splitlines(), ["install"])
        python = self.root / "video/venv/bin/python"
        self.assertEqual(subprocess.run([str(python), "-c", "pass"]).returncode, 0)
        self.assertFalse(self.result(self.start())["installed"])

    def test_failed_replacement_preserves_old_install_and_recovers(self):
        self.result(self.start())
        root = self.root / "video"
        previous = (root / "venv").resolve()
        (previous / "installed").unlink()
        error = self.result(self.start(INSTALL_FAIL="yes"), code=1)
        self.assertIn("17", error)
        self.assertEqual((root / "venv").resolve(), previous)
        self.assertEqual(list(root.glob(".install-*")), [previous])
        self.assertTrue(self.result(self.start())["installed"])
        self.assertNotEqual((root / "venv").resolve(), previous)
        self.assertFalse(previous.exists())

    def test_interrupted_stage_is_reclaimed_without_touching_published_venv(self):
        self.result(self.start())
        root = self.root / "video"
        previous = (root / "venv").resolve()
        (previous / "installed").unlink()
        abandoned = root / ".install-interrupted"
        abandoned.mkdir()
        (abandoned / "incomplete").touch()
        (root / ".venv-next").symlink_to(abandoned.name)
        self.result(self.start())
        self.assertFalse(abandoned.exists())
        self.assertFalse((root / ".venv-next").exists())
        self.assertTrue((root / "venv/bin/python").is_file())
