import assert from "node:assert/strict";
import { test } from "node:test";

import { feedbackPoint } from "../src/browser/feedback.ts";
import { IDENTITY_VIEW, toRemote, toScreen } from "../src/takeover-lab/geometry.ts";
import { inputFrame, type Frame, type Pages } from "../src/browser/protocol.ts";

const container = { w: 400, h: 400 };
const css = { w: 1000, h: 500 };

test("touch feedback follows contact without marking letterboxing or missing geometry", () => {
  assert.deepEqual(feedbackPoint("touch", { x: 80, y: 160 }, null, container, css, IDENTITY_VIEW), { x: 80, y: 160 });
  assert.equal(feedbackPoint("touch", { x: 80, y: 20 }, null, container, css, IDENTITY_VIEW), null);
  assert.equal(feedbackPoint("touch", { x: 80, y: 160 }, null, { w: 0, h: 0 }, css, IDENTITY_VIEW), null);
  const view = { z: 2, tx: -60, ty: -180 };
  const contact = { x: 100, y: 100 };
  assert.deepEqual(feedbackPoint("touch", contact, null, container, css, view), contact);
});

test("mouse contact marks CSS pointer rather than finger, including zoom and viewport clamp", () => {
  const contact = { x: 1, y: 1 };
  assert.deepEqual(feedbackPoint("mouse", contact, null, container, css, IDENTITY_VIEW), { x: 200, y: 200 });
  assert.deepEqual(feedbackPoint("mouse", contact, { x: 200, y: 150 }, container, css, { z: 2, tx: -60, ty: -180 }), { x: 100, y: 140 });
  assert.deepEqual(feedbackPoint("mouse", contact, { x: 1500, y: 800 }, container, css, IDENTITY_VIEW), { x: 400, y: 300 });
});

test("quality changes keep CSS input mapping; actual viewport change rejects old credentials", () => {
  const frame: Frame = { t: "frame", seq: 1, page: "page", epoch: 2, vp: 3, css: [1000, 500], dpr: 1,
    scroll: [0, 0], pageScale: 1, offsetTop: 0, quality_tier: "high", quality_reason: "initial",
    max_in_flight: 2, in_flight: 1, in_flight_bytes: 1024, byte_budget: 4096, delivery_rate_bps: null, stop_reason: "none",
    frame_age_ms: null, credit_wait_ms: 0, send_lock_ms: null,
    ack_baseline_ms: null, ack_smoothed_ms: null, queue_delay_ms: null };
  const pages: Pages = { t: "pages", current: "page", pages: [{ id: "page", title: "page", url: "about:blank" }],
    state: "human", max_pages: 3, epoch: 2, vp: 3, css: [1000, 500], dpr: 1 };
  const low: Frame = { ...frame, seq: 2, quality_tier: "low", quality_reason: "queue-delay" };
  const restored: Frame = { ...frame, seq: 3, quality_reason: "idle-refresh" };
  const contact = { x: 320, y: 180 };
  for (const current of [frame, low, restored]) {
    const credential = inputFrame(current, pages, true)!;
    const size = { w: credential.css[0], h: credential.css[1] };
    const point = toRemote(contact, container, size)!;
    assert.deepEqual(point, { x: 800, y: 200 });
    assert.deepEqual(toScreen(point, container, size), contact);
  }
  assert.equal(inputFrame(low, { ...pages, vp: 4, css: [500, 1000] }, true), null);
});
