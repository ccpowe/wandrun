import assert from "node:assert/strict";
import { test } from "node:test";

import { sampleHermes, StreamMeter, type ClickEvent } from "../src/browser/measurements.ts";
import type { Frame, Pages } from "../src/browser/protocol.ts";

const pages = (current: string, epoch = 1, vp = 1): Pages => ({
  t: "pages", current, epoch, vp, state: "human", max_pages: 8, css: [100, 100], dpr: 1,
  pages: [{ id: current, title: current, url: "https://example.test/" }],
});
const frame = (seq: number, applied_input_id?: number): Frame => ({
  t: "frame", seq, page: "a", epoch: 1, vp: 1, css: [100, 100], dpr: 1,
  scroll: [0, 0], pageScale: 1, offsetTop: 0, max_in_flight: 2, in_flight: 1,
  in_flight_bytes: 1024, byte_budget: 4096, delivery_rate_bps: null, stop_reason: "none",
  frame_age_ms: null, credit_wait_ms: 0, send_lock_ms: null, ack_baseline_ms: null, ack_smoothed_ms: null, queue_delay_ms: null,
  ...(applied_input_id === undefined ? {} : { applied_input_id }),
});
const click = { t: "click", x: 1, y: 1, button: "left" } as const;
const done = (id: number, input_lock_wait_ms = 0, input_dispatch_ms = 0, input_cdp_ms = 0) =>
  ({ t: "input_done", id, input_lock_wait_ms, input_dispatch_ms, input_cdp_ms } as const);

test("trailing five seconds, full binary envelope, last 60 JPEGs and unknown gateway fields", () => {
  const meter = new StreamMeter();
  assert.deepEqual([meter.snapshot(0).gatewayDropped, meter.snapshot(0).ackWaitMs, meter.snapshot(0).rttMs,
    meter.snapshot(0).jpegMeanKiB, meter.snapshot(0).inputMedianMs], [null, null, null, null, null]);
  meter.select(pages("a"));
  meter.receivedBinary(1000, 0);
  meter.receivedFrame(frame(1), 1024, 0);
  meter.receivedBinary(4000, 1);
  meter.receivedFrame(frame(2), 2048, 1);
  meter.offered(frame(1));
  meter.displayed(frame(1), 1);
  assert.equal(meter.snapshot(1).receiveFps, 0.4);
  assert.equal(meter.snapshot(1).displayFps, 0.2);
  assert.equal(meter.snapshot(1).binaryKbps, 8, "binary WebSocket payload counts four-byte prefix and JSON header too");
  const jpeg = new StreamMeter();
  for (let n = 1; n <= 61; n++) jpeg.receivedFrame(frame(n), n * 1024, n);
  assert.equal(jpeg.snapshot(61).jpegMeanKiB, 31.5, "oldest of 61 is evicted");
  assert.equal(jpeg.snapshot(61).jpegMaxKiB, 61);
  assert.equal(meter.snapshot(5000).receiveFps, 0.2, "left edge is excluded");
  assert.equal(meter.snapshot(5000).displayFps, 0.2);
  assert.equal(meter.snapshot(5001).receiveFps, 0);
  assert.equal(meter.snapshot(5001).displayFps, 0);
});

test("gateway window and path diagnostics retain latest frame, input dispatch timings aggregate across all inputs", () => {
  const meter = new StreamMeter();
  meter.hello({ t: "hello", connection_id: "gateway-1", protocol: 1, ping_supported: true, window_mode: "adaptive", max_in_flight: 2, max_in_flight_limit: 32 });
  const first = { ...frame(1), max_in_flight: 6, in_flight: 4, frame_age_ms: 85,
    credit_wait_ms: 15, send_lock_ms: 20, ack_baseline_ms: 700, ack_smoothed_ms: 760, queue_delay_ms: 60 };
  meter.receivedFrame(first, 512, 1);
  meter.reply(done(1, 4, 14, 10));
  meter.sent(2, { t: "down", x: 1, y: 1, button: "left" }, 2);
  meter.reply(done(2, 6, 20, 14));
  const stats = meter.snapshot(3);
  assert.deepEqual([stats.windowMode, stats.maxInFlightLimit, stats.maxInFlight, stats.inFlight],
    ["adaptive", 32, 6, 4]);
  assert.deepEqual([stats.frameAgeMs, stats.creditWaitMs, stats.sendLockMs, stats.ackBaselineMs,
    stats.ackSmoothedMs, stats.queueDelayMs], [85, 15, 20, 700, 760, 60]);
  assert.deepEqual([stats.inputLockWaitMs, stats.inputDispatchMs, stats.inputCdpMs,
    stats.inputLockWaitMeanMs, stats.inputDispatchMeanMs, stats.inputCdpMeanMs, stats.inputDoneSamples, stats.inputSamples],
    [6, 20, 14, 5, 17, 12, 2, 0]);
  meter.receivedFrame({ ...frame(2), max_in_flight: 2 }, 500, 4);
  assert.deepEqual([meter.snapshot(4).maxInFlight, meter.snapshot(4).frameAgeMs,
    meter.snapshot(4).queueDelayMs], [2, null, null], "fresh nullable fields replace prior values");
});

test("five-second diagnostic peaks survive low samples and repeated snapshots, then expire by sample time", () => {
  const meter = new StreamMeter();
  const high = { ...frame(1), in_flight: 6, in_flight_bytes: 24000, byte_budget: 36000,
    delivery_rate_bps: 100000, stop_reason: "byte-credit" as const,
    frame_age_ms: 90, credit_wait_ms: 40, send_lock_ms: 30, queue_delay_ms: 70 };
  meter.receivedFrame(high, 1024, 0);
  meter.reply(done(1, 18, 45, 27), 0);
  meter.receivedFrame({ ...frame(2), in_flight: 1, in_flight_bytes: 1000,
    frame_age_ms: null, credit_wait_ms: 1, send_lock_ms: null, queue_delay_ms: null }, 1024, 1000);
  meter.reply(done(2, 1, 2, 1), 1000);
  const snapshot = meter.snapshot(2000);
  assert.deepEqual([snapshot.inFlightBytes, snapshot.byteBudget, snapshot.deliveryRateBps, snapshot.stopReason],
    [1000, 4096, null, "none"], "latest header values remain distinct from interval peaks");
  const peaks = (now: number) => {
    const s = meter.snapshot(now);
    return [s.inFlightPeak, s.inFlightBytesPeak, s.frameAgePeakMs, s.creditWaitPeakMs,
      s.sendLockPeakMs, s.queueDelayPeakMs, s.inputLockWaitPeakMs, s.inputDispatchPeakMs, s.inputCdpPeakMs];
  };
  const highPeaks = [6, 24000, 90, 40, 30, 70, 18, 45, 27];
  assert.deepEqual(peaks(2000), highPeaks);
  assert.deepEqual(peaks(3000), highPeaks, "sampling cannot reset the interval maximum");
  meter.receivedFrame({ ...frame(3), in_flight: 3, in_flight_bytes: 3000,
    frame_age_ms: 20, credit_wait_ms: 10, send_lock_ms: 5, queue_delay_ms: 15 }, 1024, 3000);
  meter.reply(done(3, 4, 8, 6), 3000);
  assert.deepEqual(peaks(5000), [3, 3000, 20, 10, 5, 15, 4, 8, 6], "earlier maximum expires at the window edge");
  assert.deepEqual(peaks(6000), [3, 3000, 20, 10, 5, 15, 4, 8, 6]);
  assert.deepEqual(peaks(8000), Array(9).fill(null), "all old samples expire without new frames or replies");
});

test("only completed id covered by displayed frame samples, with first display and nearest-rank P90", () => {
  const meter = new StreamMeter();
  meter.select(pages("a"));
  for (let id = 1; id <= 21; id++) {
    meter.sent(id, click, 0);
    meter.reply(done(id));
    const next = frame(id, id);
    meter.offered(next);
    meter.displayed(next, id);
    meter.displayed(next, id + 1000);
  }
  const stats = meter.snapshot(21);
  assert.equal(stats.inputSamples, 20);
  assert.equal(stats.inputMedianMs, 11.5, "even-sized window averages the middle two");
  assert.equal(stats.inputP90Ms, 19, "nearest rank selects item 18 of the retained values 2..21");
  assert.equal(stats.localDiscarded, 0);
});

test("reply ordering, rejects and pending gestures do not invent samples", () => {
  const meter = new StreamMeter();
  meter.select(pages("a"));
  meter.sent(1, click, 10);
  meter.reply({ t: "input_pending", id: 1 });
  meter.offered(frame(1, 1)); meter.displayed(frame(1, 1), 20);
  assert.equal(meter.snapshot(20).inputSamples, 0);
  meter.reply({ t: "reject", id: 1, why: "stale-frame" });
  meter.reply(done(1));
  assert.equal(meter.snapshot(30).inputSamples, 0);
  meter.sent(2, click, 30);
  meter.offered(frame(2)); meter.displayed(frame(2), 35);
  meter.offered(frame(3, 2)); meter.displayed(frame(3, 2), 40);
  meter.reply({ t: "input_pending", id: 2 });
  assert.equal(meter.snapshot(40).inputSamples, 0);
  meter.reply(done(2));
  assert.equal(meter.snapshot(40).inputMedianMs, 10, "done after display uses stored first commit");
  meter.offered(frame(4, 2)); meter.displayed(frame(4, 2), 50);
  assert.equal(meter.snapshot(50).inputSamples, 1, "later displays cannot re-sample one id");
});

test("held gestures do not count as clicks; selection invalidates unfinished samples", () => {
  const meter = new StreamMeter();
  meter.select(pages("a"));
  meter.sent(1, { t: "down", x: 1, y: 1, button: "left" }, 10);
  meter.sent(2, { t: "move", x: 2, y: 2 }, 20);
  meter.sent(3, { t: "up", x: 2, y: 2, button: "left" }, 30);
  meter.reply({ t: "input_pending", id: 3 });
  meter.offered(frame(1, 3)); meter.displayed(frame(1, 3), 40);
  assert.equal(meter.snapshot(40).inputSamples, 0);
  meter.reply(done(3));
  assert.equal(meter.snapshot(40).inputSamples, 0);
  meter.sent(4, click, 50);
  meter.select(pages("b", 1, 2));
  meter.reply(done(4));
  meter.offered({ ...frame(2, 4), page: "b", vp: 2 });
  meter.displayed({ ...frame(2, 4), page: "b", vp: 2 }, 80);
  assert.equal(meter.snapshot(80).inputSamples, 0, "selection invalidates unfinished sample");
});

test("held releases do not contribute click samples but a later direct click still does", () => {
  const meter = new StreamMeter();
  meter.select(pages("a"));
  meter.sent(1, { t: "down", x: 1, y: 1, button: "left" }, 10);
  meter.sent(2, { t: "up", x: 1, y: 1, button: "left" }, 30);
  meter.reply(done(2));
  meter.offered(frame(1, 2)); meter.displayed(frame(1, 2), 40);
  assert.equal(meter.snapshot(40).inputSamples, 0);
  meter.sent(3, click, 50);
  meter.reply(done(3));
  meter.offered(frame(2, 3)); meter.displayed(frame(2, 3), 75);
  assert.deepEqual([meter.snapshot(75).inputSamples, meter.snapshot(75).inputMedianMs], [1, 25]);
});

test("epoch, viewport and socket close invalidate unfinished input/display matches", () => {
  const meter = new StreamMeter();
  meter.select(pages("a"));
  meter.sent(1, click, 0);
  meter.select(pages("a", 2));
  meter.reply(done(1));
  meter.offered({ ...frame(1, 1), epoch: 2 });
  meter.displayed({ ...frame(1, 1), epoch: 2 }, 10);
  meter.sent(2, click, 11);
  meter.select(pages("a", 2, 3));
  meter.reply(done(2));
  meter.offered({ ...frame(2, 2), epoch: 2, vp: 3 });
  meter.displayed({ ...frame(2, 2), epoch: 2, vp: 3 }, 20);
  meter.sent(3, click, 21);
  meter.close();
  meter.reply(done(3));
  meter.offered({ ...frame(3, 3), epoch: 2, vp: 3 });
  meter.displayed({ ...frame(3, 3), epoch: 2, vp: 3 }, 30);
  assert.equal(meter.snapshot(30).inputSamples, 0);
});

test("gateway overwrites and app skips remain separate; display samples deduplicate", () => {
  const meter = new StreamMeter();
  meter.select(pages("a"));
  meter.receivedFrame({ ...frame(1), dropped_frames: 7, ack_wait_ms: null }, 512, 0);
  meter.offered(frame(1));
  meter.discarded(1);
  meter.offered(frame(2));
  meter.discarded(2);
  meter.offered(frame(3)); meter.displayed(frame(3), 20);
  meter.displayed(frame(3), 30);
  meter.receivedFrame({ ...frame(4), dropped_frames: 9, ack_wait_ms: 12.5 }, 1024, 30);
  meter.receivedFrame({ ...frame(5), dropped_frames: 8 }, 1024, 30);
  assert.deepEqual([meter.snapshot(30).gatewayDropped, meter.snapshot(30).localDiscarded,
    meter.snapshot(30).ackWaitMs, meter.snapshot(30).displayFps], [9, 2, 12.5, 0.2]);
});

test("connection totals survive window pruning and page changes, and a new socket starts a distinct segment", () => {
  const meter = new StreamMeter();
  meter.select(pages("a"));
  meter.receivedFrame(frame(1), 100, 0);
  meter.offered(frame(1));
  meter.displayed(frame(1), 1);
  meter.displayed(frame(1), 2);
  meter.receivedFrame(frame(2), 200, 2);
  meter.offered(frame(2));
  meter.discarded(2);
  meter.canvasRendered("frame");
  meter.canvasRendered("frame"); // e.g. stats refresh with the same displayed image
  meter.canvasRendered("cursor");
  meter.select(pages("b", 2, 3));
  const next = { ...frame(3), page: "b", epoch: 2, vp: 3 };
  meter.receivedFrame(next, 400, 10);
  meter.offered(next);
  meter.displayed(next, 11);
  meter.canvasRendered("frame");
  const totals = meter.snapshot(6000);
  assert.deepEqual([totals.framesTotal, totals.shownTotal, totals.jpegBytesTotal,
    totals.frameCanvasRenders, totals.cursorCanvasRenders], [3, 2, 700, 3, 1]);
  assert.equal(totals.receiveFps, 0);
  assert.equal(totals.displayFps, 0);
  meter.close();
  assert.deepEqual(meter.snapshot(6000), totals);
  const fresh = new StreamMeter().snapshot(6000);
  assert.notEqual(fresh.connectionId, totals.connectionId);
  assert.deepEqual([fresh.framesTotal, fresh.shownTotal, fresh.jpegBytesTotal,
    fresh.frameCanvasRenders, fresh.cursorCanvasRenders], [0, 0, 0, 0, 0]);
});

test("entire connection emits each completed click once, distinguishes rejects and censored cutoff", () => {
  const outcomes: ClickEvent[] = [];
  const meter = new StreamMeter((sample) => outcomes.push(sample), 0, 10000);
  meter.select(pages("a"));
  meter.hello({ t: "hello", protocol: 1, ping_supported: true, window_mode: "adaptive",
    max_in_flight: 2, max_in_flight_limit: 32, connection_id: "gw-round" });
  for (let id = 1; id <= 26; id++) {
    meter.sent(id, click, 0);
    meter.reply(done(id));
    const shown = { ...frame(id, id), connection_id: "gw-round", ack_wait_ms: id };
    meter.receivedBinary(100 + id, id * 10);
    meter.receivedFrame(shown, id, id * 10);
    meter.offered(shown);
    meter.displayed(shown, id * 10);
  }
  meter.pong(40);
  meter.pong(80);
  meter.sent(27, click, 270);
  meter.reply({ t: "reject", id: 27, why: "stale-frame" });
  meter.sent(28, click, 280);
  meter.select(pages("b", 2));
  meter.sent(29, click, 290);
  const interval = meter.takeInterval(300, 10300);
  assert.deepEqual([interval.startMonoMs, interval.endMonoMs, interval.startWallMs, interval.endWallMs,
    interval.firstSeq, interval.lastSeq, interval.receivedFrames, interval.shownFrames,
    interval.binaryBytes, interval.jpegBytes], [0, 300, 10000, 10300, 1, 26, 26, 26, 2951, 351]);
  assert.deepEqual(interval.rttMs, { count: 2, p50: 60, p90: 80 });
  assert.deepEqual(interval.frameHeaderAckWaitMs, { count: 26, p50: 13.5, p90: 24 });
  assert.deepEqual(interval.arrivalIntervalMs, { count: 25, p50: 10, p90: 10 });
  assert.equal(interval.gatewayConnectionId, "gw-round");
  const empty = meter.takeInterval(500, 10500);
  assert.deepEqual([empty.firstSeq, empty.binaryBytes, empty.rttMs.count], [null, 0, 0]);
  assert.equal(meter.snapshot(500).inputSamples, 20, "overlay stays recent20");
  assert.equal(meter.snapshot(500).pendingClicks, 1);
  const cutoff = meter.close();
  assert.deepEqual(cutoff, { pendingCount: 1, pendingIds: [29], clickTrackingOverflows: 0 });
  assert.deepEqual(outcomes.flatMap((sample) => sample.status === "completed" ? [sample.latencyMs] : []),
    Array.from({ length: 26 }, (_, index) => (index + 1) * 10));
  assert.deepEqual(outcomes.filter((sample) => sample.status === "rejected" || sample.status === "invalidated"), [
    { id: 27, status: "rejected", reason: "stale-frame" },
    { id: 28, status: "invalidated", reason: "selection" },
  ]);
});

test("stalled clicks stay bounded online, while every start and later event remains joinable offline", () => {
  const events: ClickEvent[] = [];
  const meter = new StreamMeter((event) => events.push(event), 0, 0);
  meter.select(pages("a"));
  for (let id = 1; id <= 300; id++) meter.sent(id, click, id);
  assert.deepEqual([meter.snapshot(300).pendingClicks, meter.snapshot(300).clickTrackingOverflows], [256, 44]);
  assert.deepEqual(events.filter((event) => event.status === "started").map((event) => event.id),
    Array.from({ length: 300 }, (_, index) => index + 1));
  assert.deepEqual(events.filter((event) => event.status === "overflow").map((event) => event.id),
    Array.from({ length: 44 }, (_, index) => index + 1));
  meter.reply({ t: "input_pending", id: 1 }, 301);
  meter.reply(done(1), 302);
  meter.reply(done(299), 303);
  const shown = frame(1, 299);
  meter.offered(shown);
  meter.displayed(shown, 310);
  meter.reply({ t: "reject", id: 2, why: "stale-frame" }, 311);
  assert.deepEqual(events.filter((event) => event.status === "input_pending" || event.status === "input_done"
    || event.status === "displayed" || event.status === "reject"), [
    { status: "input_pending", id: 1, atMonoMs: 301 },
    { status: "input_done", id: 1, atMonoMs: 302, inputLockWaitMs: 0, inputDispatchMs: 0, inputCdpMs: 0 },
    { status: "input_done", id: 299, atMonoMs: 303, inputLockWaitMs: 0, inputDispatchMs: 0, inputCdpMs: 0 },
    { status: "displayed", appliedInputId: 299, seq: 1, atMonoMs: 310, page: "a", epoch: 1, vp: 1 },
    { status: "reject", id: 2, atMonoMs: 311, reason: "stale-frame" },
  ]);
  assert.deepEqual(events.filter((event) => event.status === "completed"), [
    { id: 299, status: "completed", latencyMs: 11 },
  ], "online complete is retained even when older clicks overflow");
  const cutoff = meter.close();
  assert.deepEqual(cutoff, { pendingCount: 255,
    pendingIds: Array.from({ length: 256 }, (_, index) => index + 45).filter((id) => id !== 299),
    clickTrackingOverflows: 44 });
  assert.equal(events.filter((event) => event.status === "completed" && event.id === 1).length, 0,
    "evicted click stays reconstructable from raw events, not an invented online latency");
});

test("selection change invalidates retained flights and records the boundary for overflowed flights", () => {
  const events: ClickEvent[] = [];
  const meter = new StreamMeter((event) => events.push(event), 0, 0);
  meter.select(pages("a"));
  for (let id = 1; id <= 257; id++) meter.sent(id, click, id);
  meter.select(pages("b", 2, 3));
  meter.reply(done(1), 300);
  meter.reply(done(257), 301);
  meter.offered({ ...frame(2, 257), page: "b", epoch: 2, vp: 3 });
  meter.displayed({ ...frame(2, 257), page: "b", epoch: 2, vp: 3 }, 302);
  assert.deepEqual(events.filter((event) => event.status === "selection"), [
    { status: "selection", page: "a", epoch: 1, vp: 1, state: "human" },
    { status: "selection", page: "b", epoch: 2, vp: 3, state: "human" },
  ]);
  assert.equal(events.filter((event) => event.status === "invalidated").length, 256);
  assert.deepEqual([meter.snapshot(302).pendingClicks, meter.snapshot(302).clickTrackingOverflows,
    meter.snapshot(302).inputSamples], [0, 1, 0]);
  assert.deepEqual(meter.close(), { pendingCount: 0, pendingIds: [], clickTrackingOverflows: 1 });
});

test("Hermes sampling degrades to null per missing/invalid field without coercing or throwing", (t) => {
  const runtime = globalThis as typeof globalThis & { HermesInternal?: unknown };
  const original = Object.getOwnPropertyDescriptor(runtime, "HermesInternal");
  t.after(() => {
    if (original) Object.defineProperty(runtime, "HermesInternal", original);
    else delete runtime.HermesInternal;
  });
  const missing = { extBytes: null, heapBytes: null, gcCount: null };
  for (const api of [undefined, {}, { getInstrumentedStats: 42 },
    { getInstrumentedStats() { throw new Error("unavailable"); } },
    { getInstrumentedStats() { return undefined; } }]) {
    Object.defineProperty(runtime, "HermesInternal", { configurable: true, value: api });
    assert.deepEqual(sampleHermes(), missing);
  }
  Object.defineProperty(runtime, "HermesInternal", { configurable: true, value: {
    getInstrumentedStats() { return { js_externalBytes: 0, js_heapSize: 1048576, js_numGCs: 7 }; },
  } });
  assert.deepEqual(sampleHermes(), { extBytes: 0, heapBytes: 1048576, gcCount: 7 });
  Object.defineProperty(runtime, "HermesInternal", { configurable: true, value: {
    getInstrumentedStats() { return { js_externalBytes: 5242880, js_numGCs: "8" }; },
  } });
  assert.deepEqual(sampleHermes(), { extBytes: 5242880, heapBytes: null, gcCount: null });
  Object.defineProperty(runtime, "HermesInternal", { configurable: true, value: {
    getInstrumentedStats() { return { js_externalBytes: NaN, js_heapSize: Infinity, js_numGCs: -1 }; },
  } });
  assert.deepEqual(sampleHermes(), missing);
});
