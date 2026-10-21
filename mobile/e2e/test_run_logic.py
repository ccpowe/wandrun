"""Exercise runner decisions without importing run.py's device-active main block."""

import ast
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock


RUNNER = Path(__file__).with_name("run.py")
FUNCTIONS = {"dismiss_known_dev_overlay", "pairing_selected", "assert_pairing_selection",
             "pairing_computer_row", "pairing_skip_reason", "pairing_preflight",
             "pairing_guard_result", "pairing_gate", "run_pairing_if_development", "overall_status"}


def runner_logic():
    """Load real runner functions without executing its argument parser or device setup."""
    tree = ast.parse(RUNNER.read_text())
    functions = [node for node in tree.body
                 if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS]
    namespace = {"json": json, "print": Mock(), "time": time}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(RUNNER), "exec"), namespace)
    return namespace


def runner_main(namespace):
    """Execute only the coordinator block, with all device/service dependencies injected."""
    tree = ast.parse(RUNNER.read_text())
    start = next(index for index, node in enumerate(tree.body)
                 if isinstance(node, ast.Assign)
                 and any(isinstance(target, ast.Name) and target.id == "run_out"
                         for target in node.targets))
    coordinator = tree.body[start:start + 5]  # state assignments followed by the guarded try/finally
    exec(compile(ast.Module(body=coordinator, type_ignores=[]), str(RUNNER), "exec"), namespace)


class PairingGuardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.directory.cleanup)
        self.logic = runner_logic()
        self.logic["run_out"] = Path(self.directory.name)
        self.home = Mock()
        self.replay = Mock()
        self.logic.update(home=self.home, replay_steps=self.replay,
                          GATEWAY="http://127.0.0.1:18785")

    def display(self, text, address="http://127.0.0.1:18785/"):
        snapshots = iter([
            {"nodes": [{"label": "设置", "hittable": True}]},
            {"nodes": [{"id": "connection-method", "text": text},
                       {"id": "connection-address", "text": address}]},
        ])

        def ad(action, *args):
            if action == "snapshot":
                return next(snapshots)
            if action == "wait":
                return None
            raise AssertionError(f"Unexpected device action: {action}")

        self.logic["ad"] = ad

    def test_qr_connection_skips_before_fixture_or_cleanup(self):
        self.display("扫码 · 2026年10月11日")
        start_pairing = Mock()
        result = self.logic["run_pairing_if_development"](start_pairing)
        self.assertEqual(result["status"], "SKIP")
        self.assertEqual(result["cleanup_errors"], [])
        self.assertIsNone(result["error"])
        start_pairing.assert_not_called()
        self.assertEqual(self.logic["overall_status"]([result]), "SKIP")

    def test_pairing_only_skip_avoids_shared_setup_and_restoration(self):
        self.display("扫码 · 2026年10月11日")
        setup = Mock()
        cleanup = Mock()
        run_group = Mock()
        self.logic.update(
            OUT=Path(self.directory.name), selected=["pairing"], START=time.monotonic(),
            LOG=Mock(), require_expo=Mock(), prepare_reverse=setup, restore=cleanup,
            run_group=run_group, all_home=Mock(), phone_command=Mock(),
            assert_rows=Mock(), api=Mock(), PRESERVE_SYSTEM_THEME=False,
        )
        runner_main(self.logic)
        report = self.logic["report"]
        self.assertEqual(report["status"], "SKIP")
        self.assertEqual(report["groups"][0]["status"], "SKIP")
        self.assertEqual(report["restored_screenshot"], None)
        self.assertIsNone(report["reverse"])
        setup.assert_not_called()
        cleanup.assert_not_called()
        run_group.assert_not_called()
        self.logic["all_home"].assert_not_called()
        self.logic["phone_command"].assert_not_called()

    def test_development_connection_enters_normal_group(self):
        self.display("开发连接 · —")
        result = {"group": "pairing", "status": "PASS"}
        start_pairing = Mock(return_value=result)
        self.logic["run_pairing_if_development"](start_pairing)
        start_pairing.assert_called_once()
        self.assertFalse((Path(self.directory.name) / "pairing").exists())

    def test_saved_computer_match_uses_exact_url_not_name(self):
        rows = [
            {"id": "connection-computer-user", "label": "Same computer, 当前, http://127.0.0.1:8765/"},
            {"id": "connection-computer-test", "label": "Same computer, http://127.0.0.1:18785/"},
            {"id": "connection-address", "text": "http://127.0.0.1:8765/"},
        ]
        self.assertEqual(self.logic["pairing_computer_row"](rows, self.logic["GATEWAY"]),
                         "connection-computer-test")
        with self.assertRaises(RuntimeError):
            self.logic["pairing_computer_row"](rows[:1], self.logic["GATEWAY"])

    def test_other_development_url_fails_before_fixture(self):
        self.display("开发连接 · —", "http://127.0.0.1:8765/")
        start_pairing = Mock()
        result = self.logic["run_pairing_if_development"](start_pairing)
        self.assertEqual(result["status"], "FAIL")
        self.assertIn("http://127.0.0.1:8765", result["error"])
        start_pairing.assert_not_called()

    def test_manual_pairing_is_not_mistaken_for_development(self):
        self.display("手动输入 · 2026年10月11日")
        start_pairing = Mock()
        result = self.logic["run_pairing_if_development"](start_pairing)
        self.assertEqual(result["status"], "SKIP")
        start_pairing.assert_not_called()

    def test_disconnected_app_skips_without_navigation(self):
        self.logic["ad"] = lambda action, *args: {"nodes": [{"id": "pairing-title"}]}
        start_pairing = Mock()
        result = self.logic["run_pairing_if_development"](start_pairing)
        self.assertEqual(result["status"], "SKIP")
        start_pairing.assert_not_called()
        self.home.assert_not_called()
        self.replay.assert_not_called()

    def test_unreadable_method_is_failure_not_permission_or_skip(self):
        self.display("未知连接")
        start_pairing = Mock()
        result = self.logic["run_pairing_if_development"](start_pairing)
        self.assertEqual(result["status"], "FAIL")
        start_pairing.assert_not_called()
        self.assertEqual(self.logic["overall_status"]([result]), "FAIL")

    def test_real_group_and_cleanup_failures_still_fail_total(self):
        failure = {"group": "pairing", "status": "FAIL", "error": "exchange failed"}
        skipped = {"group": "pairing", "status": "SKIP"}
        self.assertEqual(self.logic["overall_status"]([skipped, failure]), "FAIL")
        self.assertEqual(self.logic["overall_status"]([skipped], cleanup_errors=["restore failed"]), "FAIL")
        self.assertEqual(self.logic["overall_status"]([skipped, {"status": "PASS"}]), "PASS")


class KnownOverlayGuardTests(unittest.TestCase):
    def test_unrelated_logbox_error_remains_visible(self):
        logic = runner_logic()
        ad = Mock(return_value={"nodes": [
            {"label": "Console Error"},
            {"label": "Console Warning"},
            {"label": "[legend-list] No unused container available"},
            {"label": "Dismiss", "hittable": True, "ref": "e3"},
        ]})
        logic["ad"] = ad
        logic["dismiss_known_dev_overlay"]()
        ad.assert_called_once_with("snapshot")

    def test_other_warning_is_not_dismissed_because_a_known_banner_is_behind_it(self):
        logic = runner_logic()
        nodes = [
            {"label": "Console Warning"},
            {"label": "A different warning needs investigation"},
            {"label": "[legend-list] No unused container available"},
            {"label": "Dismiss", "hittable": True, "ref": "e3"},
        ]
        presses = []

        def ad(action, *args):
            if action == "snapshot":
                return {"nodes": [] if presses else nodes}
            if action == "press":
                presses.append(args)
            return {}

        logic.update(ad=ad, OUT=Path("."), LOG=Mock(),
                     uuid4=Mock(return_value=Mock(hex="guard")))
        logic["dismiss_known_dev_overlay"]()
        self.assertEqual(presses, [])


if __name__ == "__main__":
    unittest.main()
