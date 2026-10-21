import assert from "node:assert/strict";
import { test } from "node:test";

import { framePresentation } from "../src/browser/frame-presentation.ts";
import type { Frame } from "../src/browser/protocol.ts";

const frame: Frame = {
  t: "frame", seq: 1, page: "a", epoch: 2, vp: 3, css: [100, 50], dpr: 1,
  scroll: [0, 0], pageScale: 1, offsetTop: 0, max_in_flight: 2, in_flight: 1,
  in_flight_bytes: 1024, byte_budget: 4096, delivery_rate_bps: null, stop_reason: "none",
  frame_age_ms: null, credit_wait_ms: 0, send_lock_ms: null, ack_baseline_ms: null, ack_smoothed_ms: null, queue_delay_ms: null,
};
const portrait = { w: 200, h: 400 };

test("frame and local layout changes update the fitted rectangle without replacing canvas identity", () => {
  const first = framePresentation("socket-1", frame, portrait)!;
  assert.deepEqual({ x: first.x, y: first.y, width: first.width, height: first.height },
    { x: 0, y: 150, width: 200, height: 100 });
  const next = framePresentation("socket-1", {
    ...frame, seq: 2000, scroll: [0, 600], dpr: 2, pageScale: 3,
    applied_input_id: 999, quality_tier: "low", quality_reason: "queue-delay",
  }, { w: 400, h: 200 })!;
  assert.equal(next.key, first.key);
  assert.deepEqual({ x: next.x, y: next.y, width: next.width, height: next.height },
    { x: 0, y: 0, width: 400, height: 200 });
  const keyboard = framePresentation("socket-1", frame, { w: 200, h: 60 })!;
  assert.equal(keyboard.key, first.key);
  assert.deepEqual({ x: keyboard.x, y: keyboard.y, width: keyboard.width, height: keyboard.height },
    { x: 40, y: 0, width: 120, height: 60 });
});

test("socket, selected page, control epoch and viewport each isolate the old shared image lifetime", () => {
  const key = framePresentation("socket-1", frame, portrait)!.key;
  assert.notEqual(framePresentation("socket-2", frame, portrait)!.key, key);
  for (const change of [{ page: "b" }, { epoch: 3 }, { vp: 4 }]) {
    assert.notEqual(framePresentation("socket-1", { ...frame, ...change }, portrait)!.key, key);
  }
  // Identifiers are opaque; a delimiter inside them must not alias another generation.
  assert.notEqual(framePresentation("a:b", { ...frame, page: "c" }, portrait)!.key,
    framePresentation("a", { ...frame, page: "b:c" }, portrait)!.key);
});

test("unmeasured surfaces do not submit a frame; CSS dimensions, not JPEG density, determine fit", () => {
  assert.equal(framePresentation("socket", frame, { w: 0, h: 100 }), null);
  assert.equal(framePresentation("socket", frame, { w: 100, h: 0 }), null);
  assert.equal(framePresentation("socket", { ...frame, css: [0, 50] }, portrait), null);
  assert.deepEqual(framePresentation("socket", { ...frame, dpr: 3 }, portrait),
    framePresentation("socket", frame, portrait));
  const resized = framePresentation("socket", { ...frame, vp: 4, css: [50, 100] }, portrait)!;
  assert.deepEqual({ x: resized.x, y: resized.y, width: resized.width, height: resized.height },
    { x: 0, y: 0, width: 200, height: 400 });
});
