import assert from "node:assert/strict";
import { test } from "node:test";

import { gestureTouches } from "../src/browser/touches.ts";
import type { TouchEvent } from "../src/takeover-lab/gestures.ts";
import { MouseModeRecognizer, WheelControl } from "../src/takeover-lab/mouse-gestures.ts";

const finger = (id: number, x: number, y: number) => ({ id, x, y });
const event = (type: TouchEvent["type"], t: number, allTouches: { id: number; x: number; y: number }[], changedTouches = allTouches) =>
  gestureTouches(type, { allTouches, changedTouches }, t);

for (const firstUp of ["button", "surface"] as const) {
  test(`native cross-region drag releases on ${firstUp} lift and flushes sub-frame motion first`, () => {
    const mouse = new MouseModeRecognizer();
    const button = finger(0, 30, 30);
    const surface = finger(1, 80, 80);
    assert.deepEqual(mouse.handleButton("left", event("start", 0, [button])), [{ kind: "press", button: "left", count: 1 }]);
    assert.deepEqual(mouse.handle(event("start", 10, [surface])), []);
    assert.deepEqual(mouse.handle(event("move", 20, [finger(1, 83, 80)])), [{ kind: "move", dx: 3, dy: 0, dragging: true }]);
    const moved = finger(1, 84, 80);
    assert.deepEqual(mouse.handle(event("move", 25, [moved])), []);
    const release = firstUp === "button"
      ? mouse.handleButton("left", event("end", 30, [button]))
      : mouse.handle(event("end", 30, [moved]));
    assert.deepEqual(release, [{ kind: "move", dx: 1, dy: 0, dragging: true }, { kind: "release", button: "left", count: 1 }]);
    assert.deepEqual(firstUp === "button"
      ? mouse.handle(event("end", 40, [moved]))
      : mouse.handleButton("left", event("end", 40, [button])), []);
  });
}

test("held left button supports another drag stroke, but surface taps add no click", () => {
  const mouse = new MouseModeRecognizer();
  mouse.handleButton("left", event("start", 0, [finger(0, 30, 30)]));
  mouse.handle(event("start", 10, [finger(1, 80, 80)]));
  assert.deepEqual(mouse.handle(event("end", 20, [finger(1, 80, 80)])), []);
  mouse.handle(event("start", 30, [finger(1, 80, 80)]));
  mouse.handle(event("move", 40, [finger(1, 83, 80)]));
  assert.deepEqual(mouse.handle(event("end", 50, [finger(1, 83, 80)])), [{ kind: "release", button: "left", count: 1 }]);
  mouse.handle(event("start", 60, [finger(1, 80, 80)]));
  assert.deepEqual(mouse.handle(event("move", 80, [finger(1, 82, 80)])), [
    { kind: "press", button: "left", count: 1 }, { kind: "move", dx: 2, dy: 0, dragging: true },
  ]);
  assert.deepEqual(mouse.handle(event("cancel", 90, [finger(1, 82, 80)])), [{ kind: "release", button: "left", count: 1 }]);
  assert.deepEqual(mouse.handleButton("left", event("cancel", 100, [finger(0, 30, 30)])), []);
});

test("button tracks its first finger; secondary lift cannot release, cancellation cannot right-click", () => {
  const mouse = new MouseModeRecognizer();
  const first = finger(4, 10, 10), second = finger(7, 15, 15);
  mouse.handleButton("right", event("start", 0, [first]));
  mouse.handleButton("right", event("start", 10, [first, second], [second]));
  assert.deepEqual(mouse.handleButton("right", event("end", 20, [first, second], [second])), []);
  assert.deepEqual(mouse.handleButton("right", event("cancel", 30, [first])), []);
  mouse.handleButton("right", event("start", 40, [first]));
  assert.deepEqual(mouse.handleButton("right", event("end", 60, [first])), [{ kind: "click", button: "right", count: 1 }]);
});

test("RNGH second surface finger cancels pending click; UP leaves only the surviving pointer", () => {
  const mouse = new MouseModeRecognizer();
  const first = finger(1, 80, 80), second = finger(2, 180, 80);
  mouse.handle(event("start", 0, [first]));
  mouse.handle(event("start", 10, [first, second], [second]));
  assert.deepEqual(mouse.handle(event("end", 20, [first, second], [second])), []);
  assert.deepEqual(mouse.handle(event("end", 30, [first])), []);
  mouse.handle(event("start", 40, [first]));
  assert.deepEqual(mouse.handle(event("end", 60, [first])), [{ kind: "click", button: "left", count: 1 }]);
});

test("native wheel release and cancel stop scrolling with the lifted pointer still in allTouches", () => {
  for (const finish of ["end", "cancel"] as const) {
    const wheel = new WheelControl();
    wheel.handle(event("start", 0, [finger(3, 20, 20)]));
    wheel.handle(event("move", 10, [finger(3, 20, 60)]));
    assert.equal(wheel.offset, 40);
    wheel.tick(10);
    assert.ok(wheel.tick(30) > 0);
    wheel.handle(event(finish, 40, [finger(3, 20, 60)]));
    assert.equal(wheel.active, false);
    assert.equal(wheel.offset, 0);
    assert.equal(wheel.tick(50), 0);
  }
});
