"""Native browser evidence validation at the device/server boundaries; no device is driven."""
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest

from browser_native import _canvas, _scroll


def portrait_nodes(picture_height=540, picture_y=268):
    """Screen 1100 high; stage 100..1000; 192 band (180 wheel + 12) leaves 708 for the picture."""
    return [
        {"id": "takeover-mode", "label": "当前鼠标模式，点按切换"},
        {"id": "browser-stage", "bundleId": "test-app", "rect": {"x": 0, "y": 100, "width": 720, "height": 900}},
        {"id": "browser-picture", "bundleId": "test-app", "rect": {"x": 0, "y": picture_y, "width": 720, "height": picture_height}},
        {"bundleId": "test-app", "rect": {"x": 0, "y": 0, "width": 720, "height": 1100}},
        {"id": "takeover-url"},
        {"id": "takeover-keyboard", "rect": {"x": 320, "y": 1010, "width": 64, "height": 60}},
        {"label": "左键", "rect": {"x": 300, "y": 936, "width": 52, "height": 52}},
        {"label": "右键", "rect": {"x": 368, "y": 936, "width": 52, "height": 52}},
        {"label": "滚动条", "rect": {"x": 644, "y": 808, "width": 52, "height": 180}},
    ]


class ImmediateCondition(threading.Condition):
    """All supplied device results are synchronous; absent evidence times out immediately."""
    def wait_for(self, predicate, timeout=None):
        return predicate()


class NativeScrollEvidenceTests(unittest.TestCase):
    def run_scroll(self, outputs, initial=()):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        server = SimpleNamespace(input_changed=ImmediateCondition(), geometry={"width": 800, "height": 600}, events=list(initial))
        batches = iter(outputs)

        class Runner:
            OUT = Path(directory.name)

            def ad(self, action, *args):
                if action == "snapshot":
                    return {"nodes": portrait_nodes()}
                if action == "gesture":
                    server.events.extend(next(batches))
                elif action not in ("wait", "screenshot"):
                    raise AssertionError(f"Unexpected native action: {action}")

        _scroll(Runner(), server)
        return json.loads((Path(directory.name) / "browser-scroll-events.json").read_text())

    def test_scroll_requires_new_trusted_movement_in_both_directions(self):
        events = self.run_scroll([
            [{"kind": "scroll", "trusted": False, "y": 900}, {"kind": "scroll", "trusted": True, "y": 100}],
            [{"kind": "scroll", "trusted": True, "y": 20}],
        ])
        self.assertEqual([event["y"] for event in events if event["trusted"]], [100, 20])

    def test_scroll_rejects_untrusted_opposite_and_stale_results(self):
        cases = [
            ([{"kind": "scroll", "trusted": False, "y": 100}], ()),
            ([{"kind": "scroll", "trusted": True, "y": -100}], ()),
            ([], ({"kind": "scroll", "trusted": True, "y": 100},)),
        ]
        for output, initial in cases:
            with self.subTest(output=output, initial=initial):
                with self.assertRaisesRegex(AssertionError, "Native wheel did not scroll"):
                    self.run_scroll([output], initial)

    def test_tall_remote_picture_shrinks_only_to_fit_above_the_band(self):
        canvas, _, controls, _ = _canvas(portrait_nodes(picture_height=708, picture_y=100), {"width": 800, "height": 1200})
        self.assertEqual(canvas, {"x": 0, "y": 100, "width": 720, "height": 708})
        self.assertGreaterEqual(controls["滚动条"]["y"], canvas["y"] + canvas["height"])
        self.assertEqual(controls["左键"]["y"] + controls["左键"]["height"], 988)

    def test_picture_that_would_overlap_the_band_is_raised_not_shrunk(self):
        canvas, _, _, _ = _canvas(portrait_nodes(picture_height=540, picture_y=268), {"width": 800, "height": 600})
        self.assertEqual(canvas["y"] + canvas["height"], 808)
        with self.assertRaises(AssertionError):
            _canvas(portrait_nodes(picture_y=280), {"width": 800, "height": 600})

    def test_wide_remote_picture_is_centered_on_the_whole_screen(self):
        canvas, _, _, _ = _canvas(portrait_nodes(picture_height=405, picture_y=347.5), {"width": 1600, "height": 900})
        self.assertEqual(canvas, {"x": 0, "y": 347.5, "width": 720, "height": 405})

    def test_picture_must_not_overlap_the_bottom_button_band(self):
        nodes = portrait_nodes(picture_height=720, picture_y=100)
        with self.assertRaises(AssertionError):
            _canvas(nodes, {"width": 800, "height": 1200})


if __name__ == "__main__":
    unittest.main()
