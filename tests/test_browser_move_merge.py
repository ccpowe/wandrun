"""Complete-state motion coalescing preserves all button/contact boundaries."""

import unittest

from test_browser_wheel_latency import _Harness


def _pointer(identity, credential, *, buttons=0, x=None, **changes):
    return {"t": "pointer", "id": identity, **credential, "x": 100 + identity if x is None else x,
            "y": 120, "buttons": buttons, **changes}


class MoveQueueMergeTests(unittest.IsolatedAsyncioTestCase):
    async def test_cross_frame_hover_keeps_last_position_and_each_id_finishes(self):
        async with _Harness() as harness:
            await harness.enqueue([_pointer(i, harness.frame(i)) for i in range(1, 7)])
            replies = await harness.replies(6)
            self.assertEqual({reply["id"] for reply in replies}, set(range(1, 7)))
            self.assertTrue(all(reply.get("outcome") == "sent" for reply in replies))
            self.assertEqual([(m["params"]["type"], m["params"]["x"]) for m in harness.wire.inputs],
                             [("mouseMoved", 106)])

    async def test_invalid_candidate_remains_an_independent_rejection_boundary(self):
        cases = (({"frame": 99}, "stale-frame"), ({"epoch": 2}, "stale-epoch"),
                 ({"vp": 99}, "stale-viewport"), ({"page": "other"}, "invalid-page"),
                 ({"x": -1}, "out-of-bounds"), ({"buttons": 32}, "invalid-buttons"))
        for changes, why in cases:
            with self.subTest(why=why):
                async with _Harness() as harness:
                    credential = harness.frame(1)
                    await harness.enqueue([_pointer(1, credential), _pointer(2, credential, **changes),
                                           _pointer(3, credential)])
                    replies = {reply["id"]: reply for reply in await harness.replies(3)}
                    self.assertEqual(replies[2]["why"], why)
                    self.assertEqual((replies[1]["outcome"], replies[3]["outcome"]), ("sent", "sent"))
                    self.assertEqual([m["params"]["x"] for m in harness.wire.inputs], [101, 103])

    async def test_frame_expiry_and_control_revocation_at_send_make_no_stale_write(self):
        for revoke in (False, True):
            with self.subTest(revoke=revoke):
                async with _Harness() as harness:
                    credential = harness.frame(1)
                    await harness.cdp._send_lock.acquire()
                    try:
                        await harness.enqueue([_pointer(1, credential), _pointer(2, credential)])
                        if revoke:
                            harness.lease.state = "agent"
                        else:
                            harness.stream.sent.clear()
                    finally:
                        harness.cdp._send_lock.release()
                    replies = await harness.replies(2)
                    self.assertEqual([reply["why"] for reply in replies],
                                     ["not-human" if revoke else "stale-frame"] * 2)
                    self.assertEqual(harness.wire.inputs, [])

    async def test_button_changes_never_merge_but_held_motion_catches_up(self):
        async with _Harness() as harness:
            credential = harness.frame(1)
            await harness.enqueue([_pointer(1, credential, buttons=1),
                                   _pointer(2, credential, buttons=1),
                                   _pointer(3, credential, buttons=1),
                                   _pointer(4, credential, buttons=3),
                                   _pointer(5, credential, buttons=2),
                                   _pointer(6, credential, buttons=0)])
            replies = await harness.replies(6)
            self.assertTrue(all(reply.get("outcome") == "sent" for reply in replies))
            events = [m["params"] for m in harness.wire.inputs]
            self.assertEqual([(p["type"], p["x"], p["buttons"]) for p in events], [
                ("mouseMoved", 101, 0), ("mousePressed", 101, 1), ("mouseMoved", 103, 1),
                ("mouseMoved", 104, 1), ("mousePressed", 104, 3),
                ("mouseMoved", 105, 3), ("mouseReleased", 105, 2),
                ("mouseMoved", 106, 2), ("mouseReleased", 106, 0)])
            self.assertEqual(harness.lease.mouse, {})

    async def test_key_and_text_remain_ordered_non_motion_boundaries(self):
        for kind, fields in (("key", {"key": "A", "code": "KeyA", "vk": 65, "text": "a"}),
                             ("text", {"text": "hello"})):
            with self.subTest(kind=kind):
                async with _Harness() as harness:
                    credential = harness.frame(1)
                    await harness.enqueue([_pointer(1, credential),
                        {"t": kind, "id": 2, **credential, **fields}, _pointer(3, credential)])
                    await harness.replies(3)
                    methods = [m["method"] for m in harness.wire.inputs]
                    self.assertEqual(methods, ["Input.dispatchMouseEvent"] + (
                        ["Input.dispatchKeyEvent"] * 2 if kind == "key" else ["Input.insertText"]) +
                        ["Input.dispatchMouseEvent"])
                    self.assertEqual(harness.wire.inputs[-1]["params"]["x"], 103)

    async def test_repeated_state_is_idempotent_and_does_not_generate_another_press(self):
        async with _Harness() as harness:
            credential = harness.frame(1)
            await harness.enqueue([_pointer(1, credential, buttons=1, x=100),
                                   _pointer(2, credential, buttons=1, x=100),
                                   _pointer(3, credential, buttons=0, x=100),
                                   _pointer(4, credential, buttons=0, x=100)])
            replies = await harness.replies(4)
            self.assertTrue(all(reply.get("outcome") == "sent" for reply in replies))
            self.assertEqual([m["params"]["type"] for m in harness.wire.inputs],
                             ["mousePressed", "mouseReleased"])

    async def test_touch_motion_does_not_cross_contact_changes(self):
        async with _Harness() as harness:
            credential = harness.frame(1)
            await harness.stream._input({"t": "touch", "id": 0, **credential, "touches": []})
            def touch(identity, ids):
                return {"t": "touch", "id": identity, **credential,
                        "touches": [{"id": point, "x": identity * 10, "y": 20} for point in ids]}
            await harness.enqueue([touch(1, [1]), touch(2, [1]), touch(3, [1]),
                                   touch(4, [1, 2]), touch(5, [2]), touch(6, [])])
            await harness.replies(6)
            events = [m["params"] for m in harness.wire.inputs]
            self.assertEqual([(p["type"], [point["id"] for point in p["touchPoints"]]) for p in events],
                             [("touchStart", [1]), ("touchMove", [1]), ("touchStart", [1, 2]),
                              ("touchMove", [2]), ("touchEnd", [])])
            self.assertEqual(events[1]["touchPoints"][0]["x"], 30)
            self.assertIsNone(harness.lease.touching)
