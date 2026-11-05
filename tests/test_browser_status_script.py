"""Exercise the standalone browser preflight CLI with local HTTP/proc fixtures."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


SCRIPT = (Path(__file__).resolve().parents[1]
          / "src/wandrun/defaults/skills/browser/scripts/browser_status.py")
GIB = 1024 ** 3


class BrowserStatusScriptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.meminfo = self.root / "meminfo"
        self.proc_cgroup = self.root / "cgroup"
        self.mountinfo = self.root / "mountinfo"
        self.cgroup_mount = self.root / "cgroup mount"
        self.cgroup_mount.mkdir()
        self.write_memory(8 * GIB, 4 * GIB)
        self.proc_cgroup.write_text("0::/\n", encoding="utf-8")
        self.write_mount()
        self.payload = {
            "state": "agent", "pages_used": 1,
            "environment_id": "local", "environment_name": "Local",
            "capacity": {"pages_used": 3, "pages_limit": 12, "pages_registered": 1,
                         "pages_creating": 1, "pages_pending_cleanup": 1},
            "reason": None,
        }
        self.http_status = 200
        self.paths = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.paths.append(self.path)
                raw = (owner.payload if isinstance(owner.payload, bytes)
                       else json.dumps(owner.payload, ensure_ascii=False).encode("utf-8"))
                self.send_response(owner.http_status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.endpoint = "http://127.0.0.1:%s" % self.server.server_port

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def write_memory(self, total, available):
        self.meminfo.write_text("MemTotal: %s kB\nMemAvailable: %s kB\n" % (
            total // 1024, available // 1024), encoding="utf-8")

    def write_mount(self, root="/"):
        escaped = str(self.cgroup_mount).replace(" ", "\\040")
        self.mountinfo.write_text(
            "25 20 0:25 %s %s rw - cgroup2 cgroup rw\n" % (root, escaped),
            encoding="utf-8")

    def write_group(self, relative, maximum, current):
        group = self.cgroup_mount / relative
        group.mkdir(parents=True, exist_ok=True)
        (group / "memory.max").write_text(str(maximum) + "\n", encoding="utf-8")
        (group / "memory.current").write_text(str(current) + "\n", encoding="utf-8")
        return group

    def run_cli(self, *args, endpoint=True):
        env = dict(os.environ)
        env.pop("WANDRUN_BROWSER_CDP", None)
        if endpoint is not None:
            env["WANDRUN_BROWSER_CDP"] = self.endpoint if endpoint is True else endpoint
        env["NO_PROXY"] = "*"
        # -I -S prevents accidental reliance on project imports or site packages.
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(SCRIPT),
             "--meminfo", str(self.meminfo), "--proc-cgroup", str(self.proc_cgroup),
             "--mountinfo", str(self.mountinfo), *args],
            env=env, cwd=self.root, capture_output=True, text=True, encoding="utf-8", timeout=10,
        )
        self.assertEqual(result.stderr, "", result.stderr)
        return result

    def json_report(self, expected_exit=0, **kwargs):
        result = self.run_cli("--json", **kwargs)
        self.assertEqual(result.returncode, expected_exit, result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report["complete"], expected_exit == 0)
        return report


    def test_json_without_cgroup_uses_meminfo(self):
        self.proc_cgroup.write_text("5:memory:/legacy\n", encoding="utf-8")
        self.mountinfo.unlink()
        report = self.json_report()
        self.assertEqual(report["browser"], self.payload)
        self.assertEqual(report["memory"]["cgroups"], [])
        self.assertEqual(report["memory"]["total_bytes"], 8 * GIB)
        self.assertEqual(report["memory"]["available_bytes"], 4 * GIB)
        self.assertEqual(report["warnings"], [])

    def test_absolute_and_percentage_low_memory_are_advisory(self):
        for total, available in ((4 * GIB, GIB // 2), (16 * GIB, 2 * GIB)):
            with self.subTest(total=total, available=available):
                self.write_memory(total, available)
                report = self.json_report()
                self.assertTrue(report["memory"]["low"])
                self.assertIn("不是硬性限制", report["warnings"][0])
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("低于 1 GiB 或总量的 15%", result.stdout)

    def test_low_thresholds_are_strictly_below(self):
        for total, available in ((4 * GIB, GIB), (20 * GIB, 3 * GIB)):
            with self.subTest(total=total, available=available):
                self.write_memory(total, available)
                report = self.json_report()
                self.assertFalse(report["memory"]["low"])
                self.assertEqual(report["warnings"], [])

    def test_finite_cgroup_uses_actual_membership_and_parent_headroom(self):
        self.proc_cgroup.write_text("0::/team/worker\n", encoding="utf-8")
        child = self.write_group("team/worker", 4 * GIB, GIB)
        parent = self.write_group("team", 6 * GIB, 6 * GIB - GIB // 2)
        self.write_group("unrelated", GIB, GIB)
        report = self.json_report()
        memory = report["memory"]
        self.assertEqual(memory["total_bytes"], 4 * GIB)
        self.assertEqual(memory["available_bytes"], GIB // 2)
        self.assertTrue(memory["low"])
        self.assertEqual([group["path"] for group in memory["cgroups"]], [str(child), str(parent)])
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("上限 4.00 GiB，当前 1.00 GiB", result.stdout)
        self.assertIn("上限 6.00 GiB，当前 5.50 GiB", result.stdout)

    def test_unlimited_child_still_observes_parent_limit(self):
        self.proc_cgroup.write_text("0::/team/worker\n", encoding="utf-8")
        self.write_group("team/worker", "max", GIB)
        self.write_group("team", 2 * GIB, GIB)
        report = self.json_report()
        self.assertIsNone(report["memory"]["cgroups"][0]["max_bytes"])
        self.assertIsNone(report["memory"]["cgroups"][0]["available_bytes"])
        self.assertEqual(report["memory"]["total_bytes"], 2 * GIB)
        self.assertEqual(report["memory"]["available_bytes"], GIB)
        self.assertFalse(report["memory"]["low"])

    def test_all_unlimited_groups_preserve_host_memory(self):
        self.write_group("", "max", 100 * GIB)
        report = self.json_report()
        self.assertEqual(report["memory"]["total_bytes"], 8 * GIB)
        self.assertEqual(report["memory"]["available_bytes"], 4 * GIB)
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("max（不设上限）", result.stdout)

    def test_host_can_be_tighter_than_cgroup(self):
        self.write_group("", 32 * GIB, GIB)
        report = self.json_report()
        self.assertEqual(report["memory"]["total_bytes"], 8 * GIB)
        self.assertEqual(report["memory"]["available_bytes"], 4 * GIB)

    def test_mount_root_and_namespace_relative_membership(self):
        self.write_mount(root="/host/team")
        self.write_group("", 4 * GIB, GIB)
        self.write_group("worker", "max", GIB)
        for membership in ("/host/team/worker", "/worker"):
            with self.subTest(membership=membership):
                self.proc_cgroup.write_text("0::%s\n" % membership, encoding="utf-8")
                report = self.json_report()
                self.assertEqual(len(report["memory"]["cgroups"]), 2)
                self.assertEqual(report["memory"]["total_bytes"], 4 * GIB)
                self.assertEqual(report["memory"]["available_bytes"], 3 * GIB)

    def test_subtree_mount_does_not_hide_visible_parent_limit(self):
        self.proc_cgroup.write_text("0::/team/worker\n", encoding="utf-8")
        self.write_group("team/worker", "max", GIB)
        self.write_group("team", "max", GIB)
        self.write_group("", 2 * GIB, GIB + GIB // 2)
        subtree = self.root / "subtree"
        subtree.mkdir()
        child = subtree / "worker"
        child.mkdir()
        (child / "memory.max").write_text("max\n", encoding="utf-8")
        (child / "memory.current").write_text(str(GIB), encoding="utf-8")
        with self.mountinfo.open("a", encoding="utf-8") as stream:
            stream.write("26 20 0:25 /team %s rw - cgroup2 cgroup rw\n" % subtree)
        report = self.json_report()
        self.assertEqual(report["memory"]["total_bytes"], 2 * GIB)
        self.assertEqual(report["memory"]["available_bytes"], GIB // 2)
        self.assertTrue(report["memory"]["low"])

    def test_exhausted_and_zero_cgroup_limit_are_nonnegative(self):
        for maximum, current in ((GIB, 2 * GIB), (0, 0)):
            with self.subTest(maximum=maximum):
                self.write_group("", maximum, current)
                report = self.json_report()
                self.assertEqual(report["memory"]["available_bytes"], 0)
                self.assertTrue(report["memory"]["low"])
                if maximum == 0:
                    self.assertIsNone(report["memory"]["available_percent"])

    def test_unreachable_interface_still_reports_memory(self):
        # A port that has been bound and closed is a deterministic local refusal.
        unavailable = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        port = unavailable.server_port
        unavailable.server_close()
        report = self.json_report(expected_exit=2, endpoint="http://127.0.0.1:%s" % port)
        self.assertIsNone(report["browser"])
        self.assertIn("接口不可达", report["browser_error"])
        self.assertEqual(report["memory"]["available_bytes"], 4 * GIB)

    def test_missing_injection_is_explicit_and_keeps_memory(self):
        report = self.json_report(expected_exit=2, endpoint=None)
        self.assertIn("未注入 WANDRUN_BROWSER_CDP", report["browser_error"])
        self.assertEqual(report["memory"]["total_bytes"], 8 * GIB)
        result = self.run_cli(endpoint=None)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("浏览器：无法检查", result.stdout)
        self.assertIn("本环境内存", result.stdout)

    def test_stale_epoch_409_is_complete_status_with_advisory(self):
        self.http_status = 409
        for state in ("revoking", "human", "stopping"):
            with self.subTest(state=state):
                self.payload.update(state=state, error="浏览器控制代际已过期")
                report = self.json_report()
                self.assertEqual(report["browser"]["state"], state)
                self.assertEqual(report["browser"]["error"], "浏览器控制代际已过期")
                self.assertIsNone(report["browser_error"])
                result = self.run_cli()
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertIn("浏览器控制代际已过期", result.stdout)

    def test_revoked_409_without_status_is_incomplete(self):
        self.http_status = 409
        self.payload = {"error": "任务授权已撤销"}
        report = self.json_report(expected_exit=2)
        self.assertIn("任务授权已撤销", report["browser_error"])
        self.assertEqual(report["memory"]["available_bytes"], 4 * GIB)

    def test_other_browser_states_and_reason_are_displayed(self):
        for state, label in (("unallocated", "尚未分配"), ("requested", "已请求用户接管"),
                             ("released", "租约已释放")):
            with self.subTest(state=state):
                self.payload.update(state=state, reason="状态说明")
                result = self.run_cli()
                self.assertEqual(result.returncode, 0, result.stdout)
                self.assertIn(label, result.stdout)
                self.assertIn("状态说明", result.stdout)

    def test_invalid_or_failed_browser_response_is_incomplete(self):
        for status, payload in ((503, {"error": "unavailable"}), (200, b"not json"),
                                (200, {"state": []}), (200, {"state": "agent"})):
            with self.subTest(status=status, payload=payload):
                self.http_status, self.payload = status, payload
                report = self.json_report(expected_exit=2)
                self.assertIsNotNone(report["browser_error"])
                self.assertEqual(report["memory"]["available_bytes"], 4 * GIB)

    def test_unreadable_or_invalid_meminfo_keeps_browser_status(self):
        for contents in (None, "MemTotal: 8 kB\n", "MemTotal: bad kB\nMemAvailable: 4 kB\n",
                         "MemTotal: 4 kB\nMemAvailable: 8 kB\n"):
            with self.subTest(contents=contents):
                if contents is None:
                    self.meminfo.unlink()
                else:
                    self.meminfo.write_text(contents, encoding="utf-8")
                report = self.json_report(expected_exit=2)
                self.assertEqual(report["browser"], self.payload)
                self.assertIn("meminfo 不可读取", report["memory_error"])
                self.assertIsNone(report["memory"]["total_bytes"])
        result = self.run_cli()
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("Agent 控制中", result.stdout)
        self.assertIn("内存：无法完整检查", result.stdout)

    def test_broken_cgroup_is_not_silently_treated_as_unlimited(self):
        for maximum, current in (("bad", "0"), ("max", "bad"), ("-1", "0")):
            with self.subTest(maximum=maximum, current=current):
                self.write_group("", maximum, current)
                report = self.json_report(expected_exit=2)
                self.assertIn("cgroup 不可读取", report["memory_error"])
                self.assertEqual(report["memory"]["host_total_bytes"], 8 * GIB)
        (self.cgroup_mount / "memory.current").unlink()
        report = self.json_report(expected_exit=2)
        self.assertIn("cgroup 不可读取", report["memory_error"])

    def test_missing_cgroup_mount_or_membership_path_is_incomplete(self):
        for membership, mountinfo in (("/missing", True), ("/", False), ("/../outside", True)):
            with self.subTest(membership=membership, mountinfo=mountinfo):
                self.proc_cgroup.write_text("0::%s\n" % membership, encoding="utf-8")
                self.write_mount()
                if not mountinfo:
                    self.mountinfo.write_text("", encoding="utf-8")
                report = self.json_report(expected_exit=2)
                self.assertIn("cgroup 不可读取", report["memory_error"])
                self.assertEqual(report["browser"], self.payload)


if __name__ == "__main__":
    unittest.main()
