"""Exercise the standalone starter with real processes and a fake Chrome binary."""

import fcntl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest


SCRIPT = (Path(__file__).resolve().parents[1]
          / "src/wandrun/defaults/skills/browser/scripts/start_browser.py")
CLI_VERSION = runpy.run_path(str(SCRIPT))["AGENT_BROWSER_VERSION"]
# Isolate discovery from any real Chrome installed on the test runner. Everything
# after the template-path substitution uses the script's actual CLI and OS calls.
LAUNCHER = """
import runpy
import sys
from pathlib import Path
script, template = sys.argv[1:3]
sys.argv = [script, *sys.argv[3:]]
namespace = runpy.run_path(script)
namespace['find_chrome'].__globals__['TEMPLATE_CHROME'] = Path(template)
raise SystemExit(namespace['main']())
"""
INSTALL_LAUNCHER = """
import json
import os
from pathlib import Path
import runpy
import signal
import sys

install = runpy.run_path(sys.argv[1])['ensure_agent_browser']
checkpoint = sys.argv[2]
root = Path(os.environ['WANDRUN_BROWSER_CLI_DIR'])

def pause_at_checkpoint(frame, event, arg):
    if frame.f_code is install.__code__ and event == 'line':
        stage = frame.f_locals.get('stage')
        reached = (
            checkpoint == 'before-publish' and (root / '.bin-next').is_symlink()
            or checkpoint == 'after-publish' and stage is not None
            and (root / 'bin').resolve() == stage / 'bin'
        )
        if reached:
            Path(os.environ['FAKE_INSTALL_READY']).touch()
            signal.pause()
    return pause_at_checkpoint

if checkpoint in ('before-publish', 'after-publish'):
    sys.settrace(pause_at_checkpoint)
print(json.dumps(install()))
"""
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "HeadlessChrome/157.0.0.0 Safari/537.36"
)
FAKE_CHROME = """
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import sys
import time

if '--dump-dom' in sys.argv:
    mode = os.environ.get('FAKE_CHROME_UA_MODE', 'ready')
    if mode == 'exit':
        raise SystemExit(24)
    if mode == 'timeout':
        time.sleep(30)
    user_agent = os.environ['FAKE_CHROME_USER_AGENT']
    print('<html><head></head><body>%s</body></html>' %
          (user_agent if mode == 'ready' else 'unavailable'))
    raise SystemExit(0)

arguments = dict(argument.split('=', 1) for argument in sys.argv[1:] if '=' in argument)
profile = Path(arguments['--user-data-dir'])
port = int(arguments['--remote-debugging-port'])
record = {
    'pid': os.getpid(), 'pgid': os.getpgid(0), 'sid': os.getsid(0),
    'stdin': os.readlink('/proc/self/fd/0'),
    'headless': arguments.get('--headless'),
    'address': arguments.get('--remote-debugging-address'),
    'user_agent': arguments.get('--user-agent'),
    'executable': sys.argv[0],
}
with (profile / 'launches.jsonl').open('a', encoding='utf-8') as stream:
    stream.write(json.dumps(record) + '\\n')
print('fake Chrome stdout', flush=True)
print('fake Chrome stderr', file=sys.stderr, flush=True)
mode = os.environ.get('FAKE_CHROME_MODE', 'ready')
if mode == 'exit':
    raise SystemExit(23)
time.sleep(float(os.environ.get('FAKE_CHROME_DELAY', '0')))

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        payload = {
            'Browser': 'Chrome/154.0.0.0', 'Protocol-Version': '1.3',
            'webSocketDebuggerUrl': 'ws://127.0.0.1:%s/devtools/browser/fake' % port,
        } if mode == 'ready' and self.path == '/json/version' else {}
        raw = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *args):
        pass

HTTPServer(('127.0.0.1', port), Handler).serve_forever()
"""
FAKE_NPM = """
import os
from pathlib import Path
import signal
import sys
import time

prefix = Path(sys.argv[sys.argv.index('--prefix') + 1])
version = sys.argv[-1].split('@')[-1]
with Path(os.environ['FAKE_NPM_CALLS']).open('a') as stream:
    stream.write(str(prefix) + '\\n')
binary = prefix / 'bin' / 'agent-browser'
binary.parent.mkdir(parents=True)
binary.write_text('#!%s\\nprint(%r)\\n' %
                  (sys.executable, 'agent-browser ' + version))
binary.chmod(0o700)
if os.environ.get('FAKE_NPM_MODE') == 'interrupted':
    Path(os.environ['FAKE_INSTALL_READY']).touch()
    signal.pause()
time.sleep(float(os.environ.get('FAKE_NPM_DELAY', '0')))
if os.environ.get('FAKE_NPM_MODE') == 'failure':
    print('npm ERR! code ENETUNREACH network unreachable', file=sys.stderr)
    raise SystemExit(17)
if os.environ.get('FAKE_NPM_MODE') == 'wrong-version':
    binary.write_text('#!%s\\nprint(\"agent-browser wrong\")\\n' % sys.executable)
"""


class BrowserStartScriptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.profile = self.root / "p"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.chrome = self.bin / "chromium"
        self.chrome.write_text(
            "#!%s\n%s" % (sys.executable, textwrap.dedent(FAKE_CHROME)), encoding="utf-8")
        self.chrome.chmod(0o700)
        self.cli_root = self.root / "cli"
        initial = self.cli_root / ".install-initial" / "bin"
        initial.mkdir(parents=True)
        (self.cli_root / "bin").symlink_to(".install-initial/bin")
        self.cli = initial / "agent-browser"
        self.write_cli(self.cli, CLI_VERSION)
        npm = self.bin / "npm"
        npm.write_text("#!%s\n%s" % (sys.executable, textwrap.dedent(FAKE_NPM)),
                       encoding="utf-8")
        npm.chmod(0o700)
        self.npm_calls = self.root / "npm-calls"
        video_python = self.root / "video" / "venv" / "bin" / "python"
        video_python.parent.mkdir(parents=True)
        video_python.write_text("#!%s\nraise SystemExit(0)\n" % sys.executable)
        video_python.chmod(0o700)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        self.commands = []
        self.addCleanup(self.stop_browsers)
        self.addCleanup(self.stop_commands)
        self.environment = dict(os.environ)
        for key in ("WANDRUN_BROWSER_PORT", "WANDRUN_BROWSER_PROFILE", "WANDRUN_BROWSER_START",
                    "FAKE_CHROME_MODE", "FAKE_CHROME_DELAY", "FAKE_CHROME_UA_MODE"):
            self.environment.pop(key, None)
        self.environment.update({
            "WANDRUN_BROWSER_PORT": str(self.port),
            "WANDRUN_BROWSER_PROFILE": str(self.profile),
            "WANDRUN_BROWSER_CLI_DIR": str(self.cli_root),
            "WANDRUN_VIDEO_PUBLISHER_DIR": str(self.root / "video"),
            "FAKE_NPM_CALLS": str(self.npm_calls),
            "PATH": str(self.bin),
            "FAKE_CHROME_USER_AGENT": DEFAULT_USER_AGENT,
        })

    def write_cli(self, path, version):
        path.write_text("#!%s\nprint(%r)\n" % (
            sys.executable, "agent-browser " + version), encoding="utf-8")
        path.chmod(0o700)

    def test_valid_managed_cli_skips_npm(self):
        report = self.result(self.start_cli())
        self.assertFalse(report["agent_browser"]["installed"])
        self.assertFalse(self.npm_calls.exists())

    def test_valid_path_cli_skips_npm(self):
        self.cli.unlink()
        external = self.bin / "agent-browser"
        self.write_cli(external, CLI_VERSION)
        report = self.result(self.start_cli())
        self.assertEqual(report["agent_browser"], {
            "installed": False, "executable": str(external)})
        self.assertFalse(self.npm_calls.exists())

    def test_first_install_publishes_working_cli_and_reuses_running_chrome(self):
        first = self.result(self.start_cli())
        launch, = self.launches()
        self.cli.unlink()
        installed = self.result(self.start_cli())
        self.assertTrue(installed["agent_browser"]["installed"])
        self.assertTrue(installed["already_running"])
        self.assertEqual(self.launches(), [launch])
        self.assertFalse(self.cli.parent.parent.exists())
        executable = self.cli_root / "bin" / "agent-browser"
        self.assertEqual(subprocess.check_output(
            [str(executable), "--version"], text=True).strip(),
            "agent-browser " + CLI_VERSION)
        again = self.result(self.start_cli())
        self.assertFalse(first["agent_browser"]["installed"])
        self.assertFalse(again["agent_browser"]["installed"])
        self.assertEqual(len(self.npm_calls.read_text().splitlines()), 1)

    def test_failed_install_cleans_stage_and_preserves_previous_cli(self):
        for mode in ("failure", "wrong-version"):
            with self.subTest(mode=mode):
                self.write_cli(self.cli, "old")
                error = self.result(self.start_cli(environment=dict(
                    self.environment, FAKE_NPM_MODE=mode)), expected_exit=1)
                self.assertIn("ENETUNREACH" if mode == "failure" else "--version", error)
                self.assertEqual((self.cli_root / "bin").resolve(), self.cli.parent)
                self.assertEqual(list(self.cli_root.glob(".install-*")), [self.cli.parent.parent])
                self.assertFalse((self.cli_root / ".bin-next").exists())
                self.assertFalse(self.profile.exists())

    def test_concurrent_installers_publish_only_once(self):
        self.cli.unlink()
        environment = dict(self.environment, FAKE_NPM_DELAY="0.4")
        reports = [self.result(process) for process in (
            self.start_cli(environment=environment), self.start_cli(environment=environment))]
        self.assertEqual(sorted(report["agent_browser"]["installed"] for report in reports),
                         [False, True])
        self.assertEqual(len(self.npm_calls.read_text().splitlines()), 1)
        self.assertEqual(len(list(self.cli_root.glob(".install-*"))), 1)
        self.assertEqual(len(self.launches()), 1)

    def test_version_mismatch_replaces_old_install(self):
        self.write_cli(self.cli, "old")
        report = self.result(self.start_cli())
        self.assertTrue(report["agent_browser"]["installed"])
        self.assertFalse(self.cli.parent.parent.exists())
        self.assertEqual(len(list(self.cli_root.glob(".install-*"))), 1)

    def interrupt_install(self, checkpoint):
        self.write_cli(self.cli, "old")
        ready = self.root / "install-ready"
        ready.unlink(missing_ok=True)
        environment = dict(self.environment, FAKE_INSTALL_READY=str(ready))
        if checkpoint == "npm":
            environment["FAKE_NPM_MODE"] = "interrupted"
        process = subprocess.Popen(
            [sys.executable, "-I", "-S", "-c", INSTALL_LAUNCHER, str(SCRIPT), checkpoint],
            env=environment, cwd=self.root, start_new_session=True,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        self.commands.append(process)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists(), "installer did not reach " + checkpoint)
        finally:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=5)
        self.assertEqual(process.returncode, -signal.SIGKILL)
        stages = set(self.cli_root.glob(".install-*")) - {self.cli.parent.parent}
        stage, = stages
        return stage

    def assert_current_install(self, stage):
        self.assertEqual((self.cli_root / "bin").resolve(), stage / "bin")
        self.assertEqual(set(self.cli_root.glob(".install-*")), {stage})
        self.assertFalse((self.cli_root / ".bin-next").is_symlink())
        self.assertEqual(subprocess.check_output(
            [str(self.cli_root / "bin" / "agent-browser"), "--version"], text=True).strip(),
            "agent-browser " + CLI_VERSION)

    def test_interrupted_link_publication_recovers_on_first_retry(self):
        abandoned = self.interrupt_install("before-publish")
        self.assertEqual((self.cli_root / ".bin-next").resolve(), abandoned / "bin")
        self.assertEqual((self.cli_root / "bin").resolve(), self.cli.parent)
        self.assertTrue(self.cli.exists())
        report = self.result(self.start_cli())
        self.assertTrue(report["agent_browser"]["installed"])
        self.assertFalse(abandoned.exists())
        self.assert_current_install((self.cli_root / "bin").resolve().parent)

    def test_interrupted_npm_recovers_on_first_retry(self):
        abandoned = self.interrupt_install("npm")
        self.assertTrue((abandoned / "bin" / "agent-browser").exists())
        self.assertEqual((self.cli_root / "bin").resolve(), self.cli.parent)
        self.assertTrue(self.cli.exists())
        report = self.result(self.start_cli())
        self.assertTrue(report["agent_browser"]["installed"])
        self.assertFalse(abandoned.exists())
        self.assert_current_install((self.cli_root / "bin").resolve().parent)

    def test_interrupted_npm_is_reclaimed_when_current_cli_can_be_reused(self):
        abandoned = self.interrupt_install("npm")
        self.write_cli(self.cli, CLI_VERSION)
        report = self.result(self.start_cli())
        self.assertFalse(report["agent_browser"]["installed"])
        self.assertFalse(abandoned.exists())
        self.assert_current_install(self.cli.parent.parent)
        self.assertEqual(len(self.npm_calls.read_text().splitlines()), 1)

    def test_interrupted_link_is_reclaimed_when_path_cli_can_be_reused(self):
        abandoned = self.interrupt_install("before-publish")
        external = self.bin / "agent-browser"
        self.write_cli(external, CLI_VERSION)
        report = self.result(self.start_cli())
        self.assertEqual(report["agent_browser"], {
            "installed": False, "executable": str(external)})
        self.assertFalse(abandoned.exists())
        self.assertFalse((self.cli_root / ".bin-next").is_symlink())
        self.assertEqual((self.cli_root / "bin").resolve(), self.cli.parent)
        self.assertTrue(self.cli.exists())
        self.assertEqual(set(self.cli_root.glob(".install-*")), {self.cli.parent.parent})
        self.assertEqual(len(self.npm_calls.read_text().splitlines()), 1)

    def test_published_install_survives_interruption_before_old_install_cleanup(self):
        current = self.interrupt_install("after-publish")
        self.assertEqual((self.cli_root / "bin").resolve(), current / "bin")
        self.assertTrue(self.cli.exists())
        report = self.result(self.start_cli())
        self.assertFalse(report["agent_browser"]["installed"])
        self.assertFalse(self.cli.parent.parent.exists())
        self.assert_current_install(current)
        self.assertEqual(len(self.npm_calls.read_text().splitlines()), 1)

    def launches(self):
        path = self.profile / "launches.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def stop_commands(self):
        for command in self.commands:
            if command.poll() is None:
                command.kill()
            command.communicate(timeout=5)

    def stop_browsers(self):
        if not (self.profile / "launches.jsonl").exists():
            return
        for launch in self.launches():
            try:
                os.killpg(launch["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass

    def start_cli(self, *args, environment=None, template=None):
        process = subprocess.Popen(
            [sys.executable, "-I", "-S", "-c", LAUNCHER, str(SCRIPT),
             str(template or self.root / "missing-template"), *args],
            env=self.environment if environment is None else environment, cwd=self.root,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        self.commands.append(process)
        return process

    def result(self, process, expected_exit=0):
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, expected_exit, (stdout, stderr))
        if expected_exit == 0:
            self.assertEqual(stderr, "", stderr)
            return json.loads(stdout)
        self.assertEqual(stdout, "", stdout)
        return stderr

    def test_local_and_partial_injection_refuse_without_creating_profile(self):
        for missing in (("WANDRUN_BROWSER_PORT", "WANDRUN_BROWSER_PROFILE"),
                        ("WANDRUN_BROWSER_PORT",), ("WANDRUN_BROWSER_PROFILE",)):
            with self.subTest(missing=missing):
                environment = dict(self.environment)
                for key in missing:
                    environment.pop(key)
                error = self.result(self.start_cli(environment=environment), expected_exit=1)
                self.assertIn("Local", error)
                self.assertIn("拒绝启动", error)
                self.assertFalse(self.profile.exists())

    def test_missing_profile_parents_are_created_private_and_owned_by_running_user(self):
        self.profile = self.root / "wandrun-browser" / "profile"
        environment = dict(self.environment, WANDRUN_BROWSER_PROFILE=str(self.profile))
        report = self.result(self.start_cli(environment=environment))
        self.assertFalse(report["already_running"])
        for directory in (self.profile.parent, self.profile):
            with self.subTest(directory=directory):
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
                self.assertEqual(directory.stat().st_uid, os.geteuid())

    def test_start_is_detached_private_and_reuses_real_discovery_without_executable(self):
        self.profile.mkdir(mode=0o755)
        self.profile.chmod(0o755)
        log = self.profile / "chrome.log"
        log.write_text("previous log\n", encoding="utf-8")
        log.chmod(0o644)
        first = self.result(self.start_cli())
        self.assertFalse(first["already_running"])
        launch, = self.launches()
        self.assertEqual(first["pid"], launch["pid"])
        self.assertEqual(launch["pgid"], launch["pid"])
        self.assertEqual(launch["sid"], launch["pid"])
        self.assertEqual(launch["stdin"], "/dev/null")
        self.assertEqual(launch["headless"], "new")
        self.assertEqual(launch["address"], "127.0.0.1")
        self.assertEqual(launch["user_agent"],
                         DEFAULT_USER_AGENT.replace("HeadlessChrome", "Chrome"))
        self.assertEqual(stat.S_IMODE(self.profile.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.profile / "start.lock").stat().st_mode), 0o600)
        contents = log.read_text(encoding="utf-8")
        self.assertIn("previous log", contents)
        self.assertIn("fake Chrome stdout", contents)
        self.assertIn("fake Chrome stderr", contents)
        environment = dict(self.environment, PATH=str(self.root / "empty-path"))
        second = self.result(self.start_cli(environment=environment))
        self.assertTrue(second["already_running"])
        self.assertEqual(self.launches(), [launch])
        # The successful starter and its pipes are gone, but environment Chrome lives.
        os.kill(launch["pid"], 0)

    def test_user_agent_preserves_browser_platform_and_version(self):
        default = DEFAULT_USER_AGENT.replace("X11; Linux x86_64", "X11; Linux aarch64")
        environment = dict(self.environment, FAKE_CHROME_USER_AGENT=default)
        self.result(self.start_cli(environment=environment))
        launch, = self.launches()
        self.assertEqual(launch["user_agent"], default.replace("HeadlessChrome", "Chrome"))

    def test_user_agent_probe_failures_warn_but_still_start_headless(self):
        for mode in ("exit", "malformed", "timeout"):
            with self.subTest(mode=mode):
                self.profile = self.root / mode
                environment = dict(self.environment, FAKE_CHROME_UA_MODE=mode,
                                   WANDRUN_BROWSER_PROFILE=str(self.profile))
                process = self.start_cli(environment=environment)
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, (stdout, stderr))
                self.assertFalse(json.loads(stdout)["already_running"])
                self.assertIn("User-Agent", stderr)
                self.assertIn("默认", stderr)
                launch, = self.launches()
                self.assertEqual(launch["headless"], "new")
                self.assertIsNone(launch["user_agent"])
                self.stop_browsers()

    def test_concurrent_starters_launch_one_shared_chrome(self):
        environment = dict(self.environment, FAKE_CHROME_DELAY="0.4")
        processes = [self.start_cli(environment=environment) for _ in range(4)]
        reports = [self.result(process) for process in processes]
        self.assertEqual(sorted(report["already_running"] for report in reports),
                         [False, True, True, True])
        launch, = self.launches()
        self.assertEqual(next(report["pid"] for report in reports if "pid" in report),
                         launch["pid"])
        os.kill(launch["pid"], 0)

    def test_template_executable_precedes_path_candidates(self):
        template = self.root / "template-chrome"
        template.write_text(self.chrome.read_text(encoding="utf-8"), encoding="utf-8")
        template.chmod(0o700)
        report = self.result(self.start_cli(template=template))
        self.assertFalse(report["already_running"])
        launch, = self.launches()
        self.assertEqual(launch["executable"], str(template))

    def test_early_exit_reports_real_status_and_private_log(self):
        environment = dict(self.environment, FAKE_CHROME_MODE="exit")
        error = self.result(self.start_cli(environment=environment), expected_exit=1)
        self.assertIn("23", error)
        log = self.profile / "chrome.log"
        self.assertIn(str(log), error)
        self.assertIn("fake Chrome stderr", log.read_text(encoding="utf-8"))
        self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)

    def test_http_listener_without_cdp_metadata_is_not_reused(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                raw = b'{"Browser":"Chrome/154.0.0.0"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        environment = dict(self.environment, WANDRUN_BROWSER_PORT=str(server.server_port),
                           FAKE_CHROME_MODE="exit")
        error = self.result(self.start_cli(environment=environment), expected_exit=1)
        self.assertIn("23", error)

    def test_readiness_timeout_stops_only_the_failed_launch(self):
        environment = dict(self.environment, FAKE_CHROME_MODE="not-ready")
        started = time.monotonic()
        error = self.result(self.start_cli("--timeout", "1", environment=environment),
                            expected_exit=1)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("超时", error)
        self.assertIn(str(self.profile / "chrome.log"), error)
        launch, = self.launches()
        with self.assertRaises(ProcessLookupError):
            os.kill(launch["pid"], 0)

    def test_busy_start_lock_has_bounded_wait_without_spawning(self):
        self.profile.mkdir()
        with (self.profile / "start.lock").open("ab") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            error = self.result(self.start_cli("--timeout", "0.2"), expected_exit=1)
        self.assertIn("文件锁", error)
        self.assertIn("超时", error)
        self.assertIn(str(self.profile / "chrome.log"), error)
        self.assertFalse((self.profile / "launches.jsonl").exists())

    def test_missing_binary_reports_log_instead_of_trying_default_browser(self):
        environment = dict(self.environment, PATH=str(self.root / "empty-path"))
        error = self.result(self.start_cli(environment=environment), expected_exit=1)
        self.assertIn("找不到 Chrome", error)
        log = self.profile / "chrome.log"
        self.assertIn(str(log), error)
        self.assertIn("找不到 Chrome", log.read_text(encoding="utf-8"))
        self.assertFalse((self.profile / "launches.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
