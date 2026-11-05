"""Human input owns uncertain writes independently of a stream's reply wait."""

import asyncio
import json
import time
import unittest

from wandrun.config import BrowserDefinition
from wandrun.gateway.browser_stream import BrowserStream
from wandrun.gateway.stream_config import InputConfig, StreamConfig
from wandrun.gateway.video_stream import VideoStreams
from wandrun.runtime.browser.cdp import CDPSocket
from wandrun.runtime.browser.leases import BrowserLeases, _Lease, _Page
from wandrun.runtime.browser.human_input import HumanInputUnknown

from test_browser_stream_cleanup import ControlledWire, Socket


class HumanInputSettlementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.browser = BrowserLeases(BrowserDefinition("http://127.0.0.1:1", idle_timeout=0))
        self.lease = _Lease("lease", "task", "root", "agent", "entry", state="human", current="page")
        self.cdp = CDPSocket("unused")
        self.wire = ControlledWire(self.cdp)
        self.cdp.ws = self.wire
        self.lease.pages["page"] = _Page("page", self.cdp)
        self.browser._leases["lease"] = self.lease
        self.inputs = self.browser.human_inputs("lease")
        self.inputs.configure(window=16, reply_timeout=.08, held_idle=10)
        self.addAsyncCleanup(self.cleanup)

    async def cleanup(self):
        self.wire.release()
        await self.inputs.settle("disconnect")
        if self.inputs.idle_task is not None:
            self.inputs.idle_task.cancel()
            await asyncio.gather(self.inputs.idle_task, return_exceptions=True)
        await self.cdp.close()

    async def send(self, kind, **params):
        return await self.browser.human_send("lease", "page", 1,
            "Input.dispatchMouseEvent", {"type": kind, "button": "left", "x": 10, "y": 10, **params},
            connection="viewer")

    async def test_pipeline_sends_before_replies_and_keeps_release_responsibility(self):
        self.wire.hold_types.update(("mousePressed", "mouseMoved", "mouseReleased"))
        handles = [await self.send(kind) for kind in ("mousePressed", "mouseMoved", "mouseReleased")]
        self.assertEqual([m["params"]["type"] for m in self.wire.inputs],
                         ["mousePressed", "mouseMoved", "mouseReleased"])
        self.assertEqual(len(self.inputs.commands), 3)
        self.assertEqual(self.lease.mouse, {"left": ("page", 10, 10)})
        # Even an out-of-order up response cannot release a subsequent new down.
        newer = await self.send("mousePressed", x=20)
        self.wire.reply(self.wire.inputs[2])
        await handles[2].wait()
        self.assertEqual(self.lease.mouse, {"left": ("page", 20, 10)})
        self.wire.release()
        await asyncio.gather(*(h.wait() for h in [*handles, newer]))

    async def test_first_press_cancelled_before_reply_is_unknown_and_released_once(self):
        self.wire.hold_types.add("mousePressed")
        command = await self.send("mousePressed")
        self.inputs.cancel(command)
        first = self.inputs.settle("disconnect", connection="viewer")
        second = self.inputs.settle("disconnect", connection="viewer")
        self.assertIs(first, second)
        await first
        self.assertEqual(command.outcome, "unknown")
        self.assertEqual(self.inputs.unknown, 1)
        self.assertEqual(self.lease.mouse, {})
        self.assertEqual([m["method"] for m in self.wire.inputs],
                         ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.cancelDragging"])
        self.wire.release()  # Late reply does not undo unknown.
        self.assertEqual(command.outcome, "unknown")

    async def test_deadline_and_release_phase_are_bounded(self):
        self.wire.hold_types.update(("mousePressed", "mouseReleased"))
        command = await self.send("mousePressed")
        started = time.monotonic()
        await self.inputs.settle("handback")
        self.assertLess(time.monotonic() - started, .35)
        self.assertEqual(command.outcome, "unknown")
        self.assertEqual(self.inputs.unknown, 2)
        self.assertEqual(self.lease.mouse, {})
        self.assertFalse(self.lease.lock.locked())







    async def test_outer_cancellation_before_first_press_reply_keeps_release_owner(self):
        self.wire.hold_types.add("mousePressed")
        task = asyncio.create_task(self.browser.human_batch("lease", "page", 1, [
            ("Input.dispatchMouseEvent", {"type": "mousePressed", "button": "left", "x": 10, "y": 10}),
            ("Input.dispatchMouseEvent", {"type": "mouseReleased", "button": "left", "x": 10, "y": 10}),
        ], connection="viewer"))
        await asyncio.wait_for(self.wire.sent_input.get(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await self.inputs.settle("disconnect", connection="viewer")
        self.assertEqual(self.inputs.unknown, 1)
        self.assertEqual(self.lease.mouse, {})
        self.assertEqual([m["params"].get("type") for m in self.wire.inputs],
                         ["mousePressed", "mouseReleased", None])

    async def test_pipeline_window_is_shared_across_connections_and_keeps_send_order(self):
        self.inputs.window = 2
        self.wire.hold_types.add("mouseMoved")
        first = await self.send("mouseMoved", x=1)
        second = await self.send("mouseMoved", x=2)
        third = asyncio.create_task(self.browser.human_send("lease", "page", 1,
            "Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 3, "y": 10},
            connection="another-viewer"))
        await asyncio.sleep(0)
        self.assertFalse(third.done())
        self.assertEqual([m["params"]["x"] for m in self.wire.inputs], [1, 2])
        self.wire.reply(self.wire.inputs[0])
        await first.wait()
        last = await asyncio.wait_for(third, 1)
        self.assertEqual([m["params"]["x"] for m in self.wire.inputs], [1, 2, 3])
        self.wire.release()
        await asyncio.gather(second.wait(), last.wait())

    async def test_held_idle_releases_without_a_following_event(self):
        self.inputs.held_idle = .02
        self.inputs.event("viewer")
        await self.send("mousePressed")
        await self.wire.sent_input.get()
        release = await asyncio.wait_for(self.wire.sent_input.get(), 1)
        self.assertEqual(release["params"]["type"], "mouseReleased")
        await self.inputs.settle("held-idle")
        self.assertEqual(self.lease.mouse, {})

    async def test_navigation_releases_touch_and_keys(self):
        for method, params in (
            ("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"id": 0, "x": 10, "y": 10}]}),
            ("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Shift", "code": "ShiftLeft"}),
        ):
            command = await self.browser.human_send("lease", "page", 1, method, params, connection="viewer")
            await command.wait()
        await self.browser._page_event("lease", "page", {"method": "Page.frameNavigated", "params": {"frame": {}}})
        await self.inputs.settle("vp", target="page")
        self.assertEqual([m["params"]["type"] for m in self.wire.inputs],
                         ["touchStart", "rawKeyDown", "touchCancel", "keyUp"])
        self.assertEqual((self.lease.touching, self.lease.keys), (None, {}))

    async def test_handback_hung_commands_is_bounded_and_tells_agent_unknown_count(self):
        self.browser.register("task", "root", "agent", "entry")
        self.browser._tasks["task"].lease = self.lease
        notices = []

        async def notify(task, text, interrupt):
            notices.append(text)

        self.browser.notify = notify
        self.wire.hold_types.update(("mousePressed", "mouseReleased"))
        await self.send("mousePressed")
        started = time.monotonic()
        result = await self.browser.handback("lease")
        self.assertLess(time.monotonic() - started, .4)
        self.assertEqual(result["state"], "agent")
        self.assertEqual(self.lease.mouse, {})
        self.assertIn("2 条输入结果未确认", notices[-1])

    async def test_close_page_and_lease_settle_hung_inputs_before_target_cleanup(self):
        for whole_lease in (False, True):
            with self.subTest(whole_lease=whole_lease):
                self.browser.register("task", "root", "agent", "entry")
                self.browser._tasks["task"].lease = self.lease
                self.wire.hold_types.update(("mousePressed", "mouseReleased"))
                await self.send("mousePressed")
                wire = self.wire

                class Chrome:
                    async def call(inner, method, params=None, **kwargs):
                        self.assertTrue(any(m["params"].get("type") == "mouseReleased" for m in wire.inputs))
                        return {"targetInfos": []} if method == "Target.getTargets" else {"success": True}

                self.browser._chrome = Chrome()
                started = time.monotonic()
                if whole_lease:
                    result = await self.browser.close("lease")
                    self.assertEqual(result["state"], "released")
                else:
                    result = await self.browser.close_page("lease", "page")
                    self.assertEqual(result["pages"], [])
                self.assertLess(time.monotonic() - started, .4)
            if not whole_lease:
                self.lease.pages["page"] = _Page("page", self.cdp)
                self.wire.closed = False
                self.lease.current = "page"
                self.wire.inputs.clear()

    async def open_peer(self, *, window=16, held_idle=10, reply_timeout=.3):
        socket = Socket()
        config = StreamConfig(input=InputConfig(
            window=window, reply_timeout_s=reply_timeout, held_idle_release_s=held_idle))
        stream = BrowserStream(socket, self.browser, "lease", control=True,
                               video_streams=VideoStreams(config))
        await stream._sync_pages()
        await socket.outgoing.get()
        stream.sent[1] = (1, stream.vp, "page")
        await stream._input({"t": "pointer", "id": 0, "epoch": 1, "vp": stream.vp, "page": "page",
                             "frame": 1, "ts": 0, "x": 10, "y": 10, "buttons": 0})
        await stream._input({"t": "touch", "id": 0, "epoch": 1, "vp": stream.vp, "page": "page",
                             "frame": 1, "ts": 0, "touches": []})
        self.wire.inputs.clear()
        while not self.wire.sent_input.empty():
            self.wire.sent_input.get_nowait()
        receiver = asyncio.create_task(stream._receive())

        async def close():
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            await stream._cleanup()

        self.addAsyncCleanup(close)
        return stream, socket

    async def input(self, stream, socket, kind, identity, **fields):
        await socket.incoming.put(json.dumps({
            "t": kind, "id": identity, "epoch": 1, "vp": stream.vp, "frame": 1, "page": stream.page,
            "ts": time.monotonic() * 1000, **fields,
        }))

    async def response(self, socket, identity):
        async with asyncio.timeout(1):
            while True:
                item = await socket.outgoing.get()
                if item.get("id") == identity:
                    return item

    async def exercise_catch_up(self, touch):
        stream, socket = await self.open_peer(window=1)
        self.wire.hold_types.update(("touchStart", "touchMove") if touch else ("mousePressed", "mouseMoved"))
        await self.input(stream, socket, "touch" if touch else "pointer", 1,
                         **({"touches": [{"id": 0, "x": 10, "y": 10}]} if touch else {
                             "x": 10, "y": 10, "buttons": 1}))
        first = await asyncio.wait_for(self.wire.sent_input.get(), 1)
        for identity in range(2, 7):
            await self.input(stream, socket, "touch" if touch else "pointer", identity,
                             **({"touches": [{"id": 0, "x": identity * 10, "y": 10}]} if touch else {
                                 "x": identity * 10, "y": 10, "buttons": 1}))
        await self.input(stream, socket, "touch" if touch else "pointer", 7,
                         **({"touches": []} if touch else {"x": 70, "y": 10, "buttons": 0}))
        await socket.incoming.put(json.dumps({"t": "ping", "id": 99}))
        await self.response(socket, 99)
        self.wire.reply(first)
        moved = await asyncio.wait_for(self.wire.sent_input.get(), 1)
        position = moved["params"]["touchPoints"][0] if touch else moved["params"]
        self.assertEqual(position["x"], 60)
        self.wire.reply(moved)
        if not touch:
            final_position = await asyncio.wait_for(self.wire.sent_input.get(), 1)
            self.assertEqual((final_position["params"]["type"], final_position["params"]["x"],
                              final_position["params"]["buttons"]), ("mouseMoved", 70, 1))
            self.wire.reply(final_position)
        completed = set()
        async with asyncio.timeout(1):
            while len(completed) != 7:
                item = await socket.outgoing.get()
                if item.get("id") in range(1, 8):
                    self.assertEqual((item["t"], item["outcome"]), ("input_done", "sent"))
                    completed.add(item["id"])
        self.assertEqual([m["params"]["type"] for m in self.wire.inputs],
                         ["touchStart", "touchMove", "touchEnd"] if touch else
                         ["mousePressed", "mouseMoved", "mouseMoved", "mouseReleased"])

    async def test_mouse_catches_up_using_moves_received_while_window_is_full(self):
        await self.exercise_catch_up(False)

    async def test_touch_catches_up_without_crossing_the_end_boundary(self):
        await self.exercise_catch_up(True)





    async def test_grouped_input_stays_indivisible_to_a_second_viewer(self):
        self.wire.hold_types.add("mousePressed")
        first = asyncio.create_task(self.browser.human_batch("lease", "page", 1, [
            ("Input.dispatchMouseEvent", {"type": kind, "button": "left", "x": 10, "y": 10})
            for kind in ("mousePressed", "mouseReleased")], connection="first"))
        initial = await asyncio.wait_for(self.wire.sent_input.get(), 1)
        second = asyncio.create_task(self.send("mousePressed", x=20))
        self.wire.reply(initial)
        release = await asyncio.wait_for(self.wire.sent_input.get(), 1)
        self.assertEqual((release["params"]["type"], release["params"]["x"]), ("mouseReleased", 10))
        await first
        another = await asyncio.wait_for(second, 1)
        self.assertEqual(self.wire.inputs[-1]["params"]["x"], 20)
        self.wire.release()
        await another.wait()











    async def test_grouped_deadline_never_returns_a_success_shaped_result(self):
        self.wire.hold_types.add("mousePressed")
        with self.assertRaises(HumanInputUnknown):
            await self.browser.human_call("lease", "page", 1, "Input.dispatchMouseEvent",
                {"type": "mousePressed", "button": "left", "x": 10, "y": 10})
        await self.inputs.settle("input-error", connection="")
        self.assertEqual(self.inputs.unknown, 1)
        self.assertEqual(self.lease.mouse, {})

    async def test_release_phase_respects_page_window_and_counts_unsent_release_timeout(self):
        self.inputs.window = 1
        self.inputs.reply_timeout = .04
        in_flight = []

        def observe(event, **values):
            if event == "dispatch":
                in_flight.append(values["in_flight"])

        self.inputs.observers["viewer"] = observe
        for code in ("KeyA", "KeyB"):
            command = await self.browser.human_send("lease", "page", 1,
                "Input.dispatchKeyEvent", {"type": "rawKeyDown", "code": code, "key": code[-1]},
                connection="viewer", observer=observe)
            await command.wait()
        self.wire.hold_types.add("keyUp")
        started = time.monotonic()
        await self.inputs.settle("handback")
        self.assertLess(time.monotonic() - started, .2)
        self.assertEqual(max(in_flight), 1)
        self.assertEqual(self.inputs.unknown, 2)
        self.assertEqual(self.lease.keys, {})

    async def test_review_close_page_rechecks_epoch_after_settlement(self):
        from wandrun.runtime.browser.leases import BrowserRejected
        self.browser.register("task", "root", "agent", "entry")
        self.browser._tasks["task"].lease = self.lease
        self.lease.state = "agent"
        closed = []

        class Chrome:
            async def call(inner, method, params=None, **kwargs):
                if method == "Target.closeTarget":
                    closed.append(params["targetId"])
                return {"targetInfos": []} if method == "Target.getTargets" else {"success": True}

        self.browser._chrome = Chrome()
        results = await asyncio.gather(
            self.browser.close_page("lease", "page", expected_epoch=1),
            self.browser.takeover("lease"), return_exceptions=True)
        self.assertIsInstance(results[0], BrowserRejected)
        self.assertEqual(results[1]["state"], "human")
        self.assertEqual(closed, [])

































    async def test_rereview_existing_fence_rejects_before_group_wait(self):
        self.inputs.reply_timeout = 1
        self.wire.hold_types.update(("mouseWheel", "mousePressed"))
        held = await self.send("mouseWheel", deltaY=10)
        other = asyncio.create_task(self.browser.human_batch("lease", "page", 1, [
            ("Input.dispatchMouseEvent", {"type": kind, "button": "left", "x": 70, "y": 10})
            for kind in ("mousePressed", "mouseReleased")], connection="other"))
        await asyncio.wait_for(self.wire.sent_input.get(), 1)
        first = await asyncio.wait_for(self.wire.sent_input.get(), 1)
        fence = self.inputs.settle("vp", connection="viewer")
        try:
            with self.assertRaisesRegex(ValueError, "^stale-viewport$"):
                await asyncio.wait_for(self.send("mouseMoved", x=20), .2)
            self.assertFalse(any(m["params"].get("x") == 20 for m in self.wire.inputs))
            self.wire.reply(first)
            await asyncio.wait_for(other, 1)
            self.assertEqual([m["params"].get("x") for m in self.wire.inputs], [10, 70, 70])
        finally:
            self.wire.release()
            await asyncio.gather(other, held.wait(), fence, return_exceptions=True)



    async def reply_with_latency(self, seconds):
        while True:
            command = await self.wire.sent_input.get()
            # Model healthy external CDP RTT, not ordering inside the product.
            await asyncio.sleep(seconds)
            self.wire.reply(command)

    async def test_idle_does_not_interrupt_slow_grouped_drag(self):
        self.inputs.configure(window=16, reply_timeout=.3, held_idle=.04)
        self.inputs.event("viewer")
        self.wire.hold_types.update(("mousePressed", "mouseMoved", "mouseReleased"))
        responder = asyncio.create_task(self.reply_with_latency(.025))
        commands = [
            ("Input.dispatchMouseEvent", {"type": kind, "button": "left", "x": x, "y": 10})
            for kind, x in [("mousePressed", 10), ("mouseMoved", 30), ("mouseMoved", 60),
                            ("mouseMoved", 90), ("mouseReleased", 100)]
        ]
        try:
            await self.browser.human_batch("lease", "page", 1, commands, connection="viewer")
            self.assertEqual([(m["params"].get("type"), m["params"].get("x")) for m in self.wire.inputs],
                             [(params["type"], params["x"]) for _, params in commands])
        finally:
            self.wire.release()
            responder.cancel()
            await asyncio.gather(responder, return_exceptions=True)





    async def test_idle_deadline_restarts_when_a_command_completes(self):
        self.inputs.configure(window=16, reply_timeout=.5, held_idle=.12)
        self.inputs.event("viewer")
        self.wire.hold_types.add("mousePressed")
        command = await self.send("mousePressed")
        press = await self.wire.sent_input.get()
        await asyncio.sleep(.08)  # Healthy RTT below both the input and held-idle deadlines.
        replied_at = time.monotonic()
        self.wire.reply(press)
        await command.wait()
        release = await asyncio.wait_for(self.wire.sent_input.get(), .5)
        self.assertEqual(release["params"]["type"], "mouseReleased")
        self.assertGreaterEqual(time.monotonic() - replied_at, .10)

    async def test_idle_releases_only_idle_connection_while_another_group_is_busy(self):
        self.inputs.configure(window=16, reply_timeout=.3, held_idle=.04)
        pressed = await self.send("mousePressed")
        await pressed.wait()
        await self.wire.sent_input.get()
        self.wire.hold_types.add("rawKeyDown")
        other = asyncio.create_task(self.browser.human_batch("lease", "page", 1, [
            ("Input.dispatchKeyEvent", {"type": kind, "code": "ShiftLeft", "key": "Shift"})
            for kind in ("rawKeyDown", "keyUp")], connection="busy"))
        command = await asyncio.wait_for(self.wire.sent_input.get(), .2)
        try:
            released = await asyncio.wait_for(self.wire.sent_input.get(), .2)
            self.assertEqual(released["params"]["type"], "mouseReleased")
            self.assertFalse(any(m["params"].get("type") == "keyUp" for m in self.wire.inputs))
            self.wire.reply(command)
            await asyncio.wait_for(other, .2)
            self.assertEqual([m["params"].get("type") for m in self.wire.inputs],
                             ["mousePressed", "rawKeyDown", "mouseReleased", None, "keyUp"])
        finally:
            self.wire.release()
            await asyncio.gather(other, return_exceptions=True)



    async def exercise_staggered_idle_release(self, *, lose_touch_reply):
        self.inputs.configure(window=16, reply_timeout=.3, held_idle=.12)
        self.wire.hold_types.add("mouseReleased")
        if lose_touch_reply:
            self.wire.hold_types.add("touchCancel")
        mouse = await self.send("mousePressed")
        await mouse.wait()
        await self.wire.sent_input.get()
        # Offset a second client's confirmed press, not a wait for product readiness.
        await asyncio.sleep(.04)
        touch = await self.browser.human_send("lease", "page", 1, "Input.dispatchTouchEvent",
            {"type": "touchStart", "touchPoints": [{"x": 20, "y": 20, "id": 0}]},
            connection="touch-viewer")
        await touch.wait()
        touch_confirmed = time.monotonic()
        await self.wire.sent_input.get()
        try:
            mouse_release = await asyncio.wait_for(self.wire.sent_input.get(), .2)
            self.assertEqual(mouse_release["params"]["type"], "mouseReleased")
            # A concurrent disconnect shares the existing release, not a second attempt.
            mouse_settlement = self.inputs.settle("disconnect", connection="viewer")
            async with asyncio.timeout(.16):
                while True:
                    touch_release = await self.wire.sent_input.get()
                    if touch_release["params"].get("type") == "touchCancel":
                        break
            self.assertLess(time.monotonic() - touch_confirmed, .20)
            await self.inputs.settle("disconnect", connection="touch-viewer")
            self.assertLess(time.monotonic() - touch_confirmed, .52)
            await mouse_settlement
            self.assertEqual(self.inputs.unknown, 2 if lose_touch_reply else 1)
            self.wire.release()  # Late acknowledgements cannot restart a settled release.
            await self.inputs.settle("disconnect", connection="viewer")
            await self.inputs.settle("disconnect", connection="touch-viewer")
            self.assertEqual(sum(m["params"].get("type") == "mouseReleased" for m in self.wire.inputs), 1)
            self.assertEqual(sum(m["params"].get("type") == "touchCancel" for m in self.wire.inputs), 1)
        finally:
            self.wire.release()
            await asyncio.gather(self.inputs.settle("disconnect", connection="viewer"),
                                 self.inputs.settle("disconnect", connection="touch-viewer"))

    async def test_staggered_idle_release_is_not_delayed_by_another_connections_lost_reply(self):
        await self.exercise_staggered_idle_release(lose_touch_reply=False)

    async def test_staggered_idle_release_uses_only_its_own_release_budget(self):
        await self.exercise_staggered_idle_release(lose_touch_reply=True)

    async def state_input(self, stream, kind="pointer", **fields):
        return await stream._input({
            "t": kind, "id": 1, "epoch": 1, "vp": stream.vp, "page": stream.page,
            "frame": 1, "ts": time.monotonic() * 1000, "x": 10, "y": 10, **fields})

    async def test_state_multibutton_diff_preserves_same_frame_clicks(self):
        stream, _ = await self.open_peer()
        for buttons in (1, 3, 2, 0, 1, 0):
            await self.state_input(stream, buttons=buttons, ts=1000)
        events = [message["params"] for message in self.wire.inputs]
        self.assertEqual([(event["type"], event["button"], event["buttons"]) for event in events], [
            ("mousePressed", "left", 1), ("mousePressed", "right", 3),
            ("mouseReleased", "left", 2), ("mouseReleased", "right", 0),
            ("mousePressed", "left", 1), ("mouseReleased", "left", 0)])
        self.assertEqual(self.lease.mouse, {})
        self.assertTrue(all(event["timestamp"] == events[0]["timestamp"] for event in events))

    async def test_state_touch_add_remove_and_move_preserve_remaining_contact(self):
        stream, _ = await self.open_peer()
        one = {"id": 1, "x": 20, "y": 20}
        two = {"id": 2, "x": 30, "y": 30}
        for touches in ([one], [one, two], [two], [{**two, "x": 40}], []):
            await self.state_input(stream, "touch", touches=touches)
        events = [message["params"] for message in self.wire.inputs]
        self.assertEqual([(event["type"], [p["id"] for p in event["touchPoints"]]) for event in events],
                         [("touchStart", [1]), ("touchStart", [1, 2]), ("touchMove", [2]),
                          ("touchMove", [2]), ("touchEnd", [])])
        self.assertEqual(events[-2]["touchPoints"][0]["x"], 40)
        self.assertIsNone(self.lease.touching)

    async def test_omitted_intermediate_pointer_states_converge_to_final_mask(self):
        stream, _ = await self.open_peer()
        snapshots = [(1, 20), (3, 30), (2, 40), (0, 50), (5, 60)]
        for omitted in range(len(snapshots) - 1):
            with self.subTest(omitted=omitted):
                await self.state_input(stream, buttons=0)
                self.wire.inputs.clear()
                for index, (buttons, x) in enumerate(snapshots):
                    if index != omitted:
                        await self.state_input(stream, buttons=buttons, x=x)
                self.assertEqual(self.lease.mouse, {"left": ("page", 60, 10), "middle": ("page", 60, 10)})
                self.assertEqual(self.wire.inputs[-1]["params"]["buttons"], 5)

    async def test_omitted_intermediate_touch_states_converge_to_final_contacts(self):
        stream, _ = await self.open_peer()
        one, two = {"id": 1, "x": 20, "y": 20}, {"id": 2, "x": 30, "y": 30}
        snapshots = [[one], [one, two], [], [{**two, "x": 70}]]
        for omitted in range(len(snapshots) - 1):
            with self.subTest(omitted=omitted):
                await self.state_input(stream, "touch", touches=[])
                for index, touches in enumerate(snapshots):
                    if index != omitted:
                        await self.state_input(stream, "touch", touches=touches)
                self.assertEqual(self.wire.inputs[-1]["params"]["touchPoints"], [{"id": 2, "x": 70, "y": 30}])
                self.assertEqual(self.lease.touching, "page")

    async def test_each_release_boundary_requires_individual_button_up_before_press(self):
        stream, _ = await self.open_peer()
        for trigger in ("disconnect", "handback", "page", "vp", "held-idle", "sequence-rejected"):
            with self.subTest(trigger=trigger):
                await self.state_input(stream, buttons=0)
                await self.state_input(stream, buttons=3)
                state = self.inputs.state(stream.connection_id, "page", "pointer")
                await self.inputs.settle(trigger, connection=stream.connection_id,
                                         sequence=state.sequence if trigger == "sequence-rejected" else None)
                self.wire.inputs.clear()
                await self.state_input(stream, buttons=3, x=30)
                self.assertFalse(any(m["params"].get("type") == "mousePressed" for m in self.wire.inputs))
                await self.state_input(stream, buttons=2)  # Only left has been observed up.
                await self.state_input(stream, buttons=3)
                self.assertEqual(self.lease.mouse, {"left": ("page", 10, 10)})
                await self.state_input(stream, buttons=0)
                await self.state_input(stream, buttons=3)
                self.assertEqual(set(self.lease.mouse), {"left", "right"})
                await self.state_input(stream, buttons=0)

    async def test_release_gate_tracks_touch_ids_independently(self):
        stream, _ = await self.open_peer()
        one, two = {"id": 1, "x": 20, "y": 20}, {"id": 2, "x": 30, "y": 30}
        await self.state_input(stream, "touch", touches=[one, two])
        await self.inputs.settle("vp", connection=stream.connection_id)
        self.wire.inputs.clear()
        await self.state_input(stream, "touch", touches=[one, two])
        self.assertEqual(self.wire.inputs, [])
        await self.state_input(stream, "touch", touches=[two])
        await self.state_input(stream, "touch", touches=[one, two])
        self.assertEqual(self.wire.inputs[-1]["params"]["touchPoints"], [one])
        await self.state_input(stream, "touch", touches=[])
        await self.state_input(stream, "touch", touches=[one, two])
        self.assertEqual(self.wire.inputs[-1]["params"]["touchPoints"], [one, two])

    async def test_fresh_connection_suppresses_already_held_pointer_and_touch(self):
        stream = BrowserStream(Socket(), self.browser, "lease", control=True)
        await stream._sync_pages()
        stream.sent[1] = (1, stream.vp, "page")
        self.addAsyncCleanup(stream._cleanup)
        await self.state_input(stream, buttons=1)
        await self.state_input(stream, "touch", touches=[{"id": 9, "x": 20, "y": 20}])
        self.assertEqual(self.lease.mouse, {})
        self.assertIsNone(self.lease.touching)
        await self.state_input(stream, buttons=0)
        await self.state_input(stream, buttons=1)
        self.assertEqual(set(self.lease.mouse), {"left"})

    async def test_rejected_state_releases_then_accepts_up_and_fresh_press(self):
        stream, socket = await self.open_peer()
        for identity, fields in ((1, {"buttons": 1}), (2, {"buttons": 1, "x": -1})):
            await self.input(stream, socket, "pointer", identity, x=fields.pop("x", 10), y=10, **fields)
            response = await self.response(socket, identity)
        self.assertEqual((response["t"], response["why"]), ("reject", "out-of-bounds"))
        await asyncio.gather(*tuple(self.inputs.barriers.values()))
        await self.input(stream, socket, "pointer", 3, x=20, y=10, buttons=1)
        self.assertEqual((await self.response(socket, 3))["outcome"], "sent")
        self.assertEqual(self.lease.mouse, {})
        await self.input(stream, socket, "pointer", 4, x=20, y=10, buttons=0)
        await self.response(socket, 4)
        await self.input(stream, socket, "pointer", 5, x=20, y=10, buttons=1)
        self.assertEqual((await self.response(socket, 5))["outcome"], "sent")
        self.assertEqual(self.lease.mouse, {"left": ("page", 20, 10)})

    async def test_page_switch_releases_and_requires_new_page_neutral_state(self):
        stream, socket = await self.open_peer()
        self.lease.pages["other"] = _Page("other", self.cdp)
        await self.state_input(stream, buttons=1)
        await socket.incoming.put(json.dumps({"t": "switch_page", "id": 1, "target": "other"}))
        self.assertEqual((await self.response(socket, 1))["t"], "page_done")
        self.assertEqual(self.lease.mouse, {})
        stream.sent[1] = (1, stream.vp, "other")
        await self.state_input(stream, buttons=1, x=30)
        self.assertEqual(self.lease.mouse, {})
        await self.state_input(stream, buttons=0, x=30)
        await self.state_input(stream, buttons=1, x=30)
        self.assertEqual(self.lease.mouse, {"left": ("other", 30, 10)})

    async def test_pending_up_and_slow_drag_are_not_held_idle(self):
        stream, socket = await self.open_peer(window=1, held_idle=.04)
        self.wire.hold_types.update(("mousePressed", "mouseMoved", "mouseReleased"))
        responder = asyncio.create_task(self.reply_with_latency(.025))
        try:
            for identity, buttons in enumerate((1, 1, 1, 1, 0), 1):
                await self.input(stream, socket, "pointer", identity, x=identity * 20, y=10, buttons=buttons)
                # A paired key is a non-coalescing boundary, not a timing patch.
                if buttons:
                    await self.input(stream, socket, "key", identity + 10, key="Shift", code="ShiftLeft", vk=16)
            async with asyncio.timeout(2):
                replies = [await socket.outgoing.get() for _ in range(9)]
            self.assertTrue(all(item.get("outcome") == "sent" for item in replies))
            self.assertEqual(self.lease.mouse, {})
            self.assertFalse(any(m["method"] == "Input.cancelDragging" for m in self.wire.inputs))
        finally:
            responder.cancel()
            await asyncio.gather(responder, return_exceptions=True)

    async def test_retired_messages_reject_without_releasing_current_press(self):
        stream, socket = await self.open_peer()
        await self.state_input(stream, buttons=1)
        for kind in ("transport", "input_mode", "client_stats", "down", "move", "up", "click"):
            await socket.incoming.put(json.dumps({"t": kind, "id": kind, "value": "jpeg"}))
            self.assertEqual(await self.response(socket, kind),
                             {"t": "reject", "id": kind, "why": "unsupported-message"})
        self.assertEqual(self.lease.mouse, {"left": ("page", 10, 10)})

    async def test_partial_key_send_is_unknown_and_late_reply_cannot_rewrite_it(self):
        stream, socket = await self.open_peer(window=1)
        self.wire.hold_types.add("rawKeyDown")
        await self.input(stream, socket, "key", 1, key="Shift", code="ShiftLeft", vk=16)
        first = await asyncio.wait_for(self.wire.sent_input.get(), 1)
        stream._invalidate()
        result = await self.response(socket, 1)
        self.assertEqual((result["t"], result["outcome"]), ("input_done", "unknown"))
        await asyncio.gather(*tuple(self.inputs.barriers.values()))
        self.assertEqual(self.lease.keys, {})
        unknown = self.inputs.unknown
        self.wire.reply(first)
        await asyncio.sleep(0)
        self.assertEqual(self.inputs.unknown, unknown)
        self.assertTrue(socket.outgoing.empty())

    async def test_idle_waits_for_up_already_received_before_view_admission(self):
        stream, socket = await self.open_peer(held_idle=.04)
        await self.state_input(stream, buttons=1)
        await stream._view_lock.acquire()
        try:
            await self.input(stream, socket, "pointer", 1, buttons=0, x=10, y=10)
            await socket.incoming.put(json.dumps({"t": "ping", "id": 2}))
            await self.response(socket, 2)
            await asyncio.sleep(.08)
            self.assertEqual(set(self.lease.mouse), {"left"})
            self.assertFalse(any(m["method"] == "Input.cancelDragging" for m in self.wire.inputs))
        finally:
            stream._view_lock.release()
        self.assertEqual((await self.response(socket, 1))["outcome"], "sent")
        self.assertEqual(self.lease.mouse, {})

    async def test_click_count_is_preserved_on_both_edges_and_invalid_count_rejected(self):
        stream, _ = await self.open_peer()
        for buttons in (1, 0):
            await self.state_input(stream, buttons=buttons, count=2)
        self.assertEqual([m["params"]["clickCount"] for m in self.wire.inputs], [2, 2])
        for count in (0, -1, 1.5, True):
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "invalid-count"):
                await self.state_input(stream, buttons=1, count=count)

    async def test_late_old_sequence_failure_does_not_reset_fresh_state(self):
        stream, _ = await self.open_peer()
        await self.state_input(stream, buttons=1)
        self.wire.hold_types.add("mouseMoved")
        message = {"t": "pointer", "id": 1, "epoch": 1, "vp": stream.vp,
                   "page": "page", "frame": 1, "ts": 1000, "x": 20, "y": 10, "buttons": 1}
        moving = await stream._input(message, defer=True)
        old_command = self.wire.inputs[-1]
        self.wire.hold_types.remove("mouseMoved")
        ending_message = {**message, "id": 2, "buttons": 0}
        ending = await stream._input(ending_message, defer=True)
        await self.state_input(stream, buttons=1, x=40)
        self.cdp._pending[old_command["id"]].set_result({
            "id": old_command["id"], "error": {"message": "late explicit Chrome rejection"}})
        await asyncio.gather(
            stream._deliver_input(message, [(1, time.perf_counter())], time.perf_counter(), moving),
            stream._deliver_input(ending_message, [(2, time.perf_counter())], time.perf_counter(), ending))
        self.wire.release()
        await asyncio.gather(*tuple(self.inputs.barriers.values()))
        self.assertEqual(self.lease.mouse, {"left": ("page", 40, 10)})
        await self.state_input(stream, buttons=1, x=50)
        self.assertEqual(self.lease.mouse, {"left": ("page", 50, 10)})

    async def test_unknown_final_up_requires_another_neutral_state_before_repress(self):
        stream, _ = await self.open_peer()
        await self.state_input(stream, buttons=1)
        self.wire.hold_types.add("mouseReleased")
        result = await self.state_input(stream, buttons=0)
        self.assertEqual(result["outcome"], "unknown")
        await asyncio.gather(*tuple(self.inputs.barriers.values()))
        self.wire.release()
        await self.state_input(stream, buttons=1, x=40)
        self.assertEqual(self.lease.mouse, {})
        await self.state_input(stream, buttons=0, x=40)
        await self.state_input(stream, buttons=1, x=40)
        self.assertEqual(self.lease.mouse, {"left": ("page", 40, 10)})

    async def exercise_repress_during_sequence_drain(self, touch=False):
        stream, socket = await self.open_peer(reply_timeout=2)
        kind = "touch" if touch else "pointer"
        first = {"touches": [{"id": 1, "x": 10, "y": 10}]} if touch else {"buttons": 1}
        moved = {"touches": [{"id": 1, "x": 20, "y": 10}]} if touch else {"buttons": 1, "x": 20}
        neutral = {"touches": []} if touch else {"buttons": 0, "x": 20}
        await self.state_input(stream, kind, **first)
        self.wire.hold_types.add("touchMove" if touch else "mouseMoved")
        moving = asyncio.create_task(await stream._input({
            "t": kind, "id": 1, "epoch": 1, "vp": stream.vp, "page": "page", "frame": 1,
            "ts": time.monotonic() * 1000, "x": 20, "y": 10, **moved}, defer=True))
        try:
            stream.sent.pop(1)
            stream.sent[2] = (1, stream.vp, "page")
            await self.input(stream, socket, kind, 2, **moved)
            self.assertEqual((await self.response(socket, 2))["why"], "stale-frame")
            self.wire.hold_types.clear()
            self.wire.hold_types.add("touchCancel" if touch else "mouseReleased")
            self.assertEqual((await self.state_input(stream, kind, frame=2, **neutral))["outcome"], "sent")
            result = await asyncio.wait_for(self.state_input(stream, kind, frame=2, **moved), .5)
            old_still_pending = not moving.done()
            messages = list(self.wire.inputs)
            self.wire.release()
            await moving
            await asyncio.gather(*tuple(self.inputs.barriers.values()))
            self.assertEqual(result["outcome"], "sent")
            self.assertEqual(self.lease.touching, "page" if touch else None)
            if not touch:
                self.assertEqual(self.lease.mouse, {"left": ("page", 20, 10)})
            return messages, old_still_pending
        finally:
            self.wire.release()
            await asyncio.gather(moving, return_exceptions=True)

    async def test_pointer_repress_sends_owed_release_before_old_reply_finishes(self):
        messages, old_pending = await self.exercise_repress_during_sequence_drain()
        self.assertTrue(old_pending)
        self.assertEqual([m["params"]["type"] for m in messages if "type" in m["params"]],
                         ["mousePressed", "mouseMoved", "mouseReleased", "mousePressed"])

    async def test_touch_repress_sends_owed_cancel_before_old_reply_finishes(self):
        messages, old_pending = await self.exercise_repress_during_sequence_drain(touch=True)
        self.assertTrue(old_pending)
        self.assertEqual([m["params"]["type"] for m in messages if "type" in m["params"]],
                         ["touchStart", "touchMove", "touchCancel", "touchStart"])

    async def exercise_repeated_lifecycle_release(self, touch):
        stream, _ = await self.open_peer(reply_timeout=2)
        kind = "touch" if touch else "pointer"
        held = {"touches": [{"id": 1, "x": 10, "y": 10}]} if touch else {"buttons": 1}
        moved = {"touches": [{"id": 1, "x": 20, "y": 10}]} if touch else {"buttons": 1, "x": 20}
        neutral = {"touches": []} if touch else {"buttons": 0, "x": 20}
        await self.state_input(stream, kind, **held)
        self.wire.hold_types.add("touchMove" if touch else "mouseMoved")
        moving = asyncio.create_task(await stream._input({
            "t": kind, "id": 1, "epoch": 1, "vp": stream.vp, "page": "page", "frame": 1,
            "ts": 1000, "x": 20, "y": 10, **moved}, defer=True))
        try:
            barrier = self.inputs.settle("vp", connection=stream.connection_id)
            self.assertEqual((await self.state_input(stream, kind, **neutral))["outcome"], "sent")
            self.inputs.settle("vp", connection=stream.connection_id)
            self.wire.release()
            await moving
            await barrier
            self.wire.inputs.clear()
            await self.state_input(stream, kind, **held)
            self.assertFalse(any(m["params"].get("type") in ("mousePressed", "touchStart")
                                 for m in self.wire.inputs))
            await self.state_input(stream, kind, **neutral)
            await self.state_input(stream, kind, **held)
            self.assertEqual(self.lease.touching, "page" if touch else None)
            if not touch:
                self.assertEqual(self.lease.mouse, {"left": ("page", 10, 10)})
        finally:
            self.wire.release()
            await asyncio.gather(moving, return_exceptions=True)
            await self.inputs.settle("disconnect", connection=stream.connection_id)

    async def test_repeated_lifecycle_release_closes_gate_during_existing_drain(self):
        await self.exercise_repeated_lifecycle_release(False)

    async def test_repeated_lifecycle_release_closes_touch_gate_during_existing_drain(self):
        await self.exercise_repeated_lifecycle_release(True)

    async def test_neutral_hover_does_not_inherit_previous_ending_reply(self):
        stream, _ = await self.open_peer(reply_timeout=2)
        await self.state_input(stream, buttons=1)
        self.wire.hold_types.add("mouseReleased")
        ending = asyncio.create_task(await stream._input({
            "t": "pointer", "id": 1, "epoch": 1, "vp": stream.vp, "page": "page",
            "frame": 1, "ts": 1000, "x": 10, "y": 10, "buttons": 0}, defer=True))
        try:
            reply = await asyncio.wait_for(self.state_input(stream, buttons=0), .5)
            self.assertEqual(reply["outcome"], "sent")
            self.assertFalse(ending.done())
        finally:
            self.wire.release()
            await asyncio.gather(ending, return_exceptions=True)
            await asyncio.gather(*tuple(self.inputs.barriers.values()))

    async def test_held_move_uses_primary_button_from_complete_mask(self):
        stream, _ = await self.open_peer()
        for buttons, primary in ((1, "left"), (2, "right"), (4, "middle"), (8, "back"),
                                 (16, "forward"), (3, "left"), (6, "right"), (24, "back")):
            with self.subTest(buttons=buttons):
                await self.state_input(stream, buttons=buttons, x=10)
                await self.state_input(stream, buttons=buttons, x=20)
                move = self.wire.inputs[-1]["params"]
                self.assertEqual((move["type"], move["button"], move["buttons"]),
                                 ("mouseMoved", primary, buttons))
                await self.state_input(stream, buttons=0, x=20)

    async def test_cancelled_repress_waiter_keeps_shared_release_owner(self):
        stream, _ = await self.open_peer()
        await self.state_input(stream, buttons=1)
        self.wire.blocked_types.add("mouseReleased")
        barrier = self.inputs.settle("sequence-rejected", connection=stream.connection_id,
                                     sequence=self.inputs.state(stream.connection_id, "page", "pointer").sequence)
        await self.state_input(stream, buttons=0)
        pressing = asyncio.create_task(self.state_input(stream, buttons=1))
        try:
            await asyncio.wait_for(self.wire.send_blocked.wait(), 1)
            pressing.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pressing
            self.wire.allow_send.set()
            await barrier
            self.assertEqual([m["params"]["type"] for m in self.wire.inputs if "type" in m["params"]],
                             ["mousePressed", "mouseReleased"])
            self.assertEqual(self.lease.mouse, {})
        finally:
            self.wire.allow_send.set()
            self.wire.release()
            await asyncio.gather(pressing, barrier, return_exceptions=True)

    async def test_unsent_release_deadline_rejects_repress_without_new_down(self):
        stream, socket = await self.open_peer(reply_timeout=.1)
        await self.state_input(stream, buttons=1)
        self.wire.blocked_types.add("mouseReleased")
        barrier = self.inputs.settle("sequence-rejected", connection=stream.connection_id,
                                     sequence=self.inputs.state(stream.connection_id, "page", "pointer").sequence)
        await self.state_input(stream, buttons=0)
        try:
            await self.input(stream, socket, "pointer", 3, buttons=1, x=10, y=10)
            reply = await self.response(socket, 3)
            self.assertEqual((reply["t"], reply["why"]), ("reject", "stale-viewport"))
            await barrier
            self.assertTrue(self.wire.send_cancelled.is_set())
            self.assertEqual([m["params"]["type"] for m in self.wire.inputs if "type" in m["params"]],
                             ["mousePressed"])
        finally:
            self.wire.allow_send.set()
            self.wire.release()
            await asyncio.gather(barrier, return_exceptions=True)
