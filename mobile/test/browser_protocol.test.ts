import assert from "node:assert/strict";
import { test } from "node:test";

import { BUTTON_MARGIN, buttonLayout, WHEEL_WIDTH } from "../src/takeover-lab/layout.ts";
import { applyPages, EMPTY_PAGE_STATE, initialPageSelection, isEmptyControlPages, observePageSelection, rejectPageRestoration, resumePageSelection } from "../src/browser/pages.ts";
import { decodeFrame, decodeHello, decodeInputDone, endedReason, inputFrame, rejectReason, type Frame, type Pages } from "../src/browser/protocol.ts";
import { BrowserStream, type StreamState } from "../src/browser/stream.ts";
import { GatewayApi } from "../src/gateway/api.ts";

const frame: Frame = { t: "frame", connection_id: "gateway-1", seq: 5, page: "a", epoch: 3, vp: 7, css: [100, 50], dpr: 1, scroll: [0, 0], pageScale: 1, offsetTop: 0,
  max_in_flight: 2, in_flight: 1, in_flight_bytes: 1024, byte_budget: 4096, delivery_rate_bps: null, stop_reason: "none",
  frame_age_ms: null, credit_wait_ms: 0, send_lock_ms: null,
  ack_baseline_ms: null, ack_smoothed_ms: null, queue_delay_ms: null };
const pages = (current: string | null, epoch = 3, vp = 7, state: Pages["state"] = "human", ids = ["a"]): Pages => ({
  t: "pages", current, epoch, vp, state, max_pages: 8, css: [100, 50], dpr: 1,
  pages: ids.map((id) => ({ id, title: `Page ${id}`, url: `https://${id}.example/` })),
});
const packet = (meta: unknown = frame) => {
  const header = new TextEncoder().encode(typeof meta === "string" ? meta : JSON.stringify(meta));
  const bytes = new Uint8Array(4 + header.length + 4);
  new DataView(bytes.buffer).setUint32(0, header.length, false);
  bytes.set(header, 4); bytes.set([0xff, 0xd8, 0xff, 0xd9], 4 + header.length);
  return bytes.buffer;
};

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: object[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  readonly options: { headers: Record<string, string> };
  constructor(url: string, _protocols: string[], options: { headers: Record<string, string> }) {
    this.url = url; this.options = options; Socket.instances.push(this);
  }
  send(message: string) { this.sent.push(JSON.parse(message)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(message: object | ArrayBuffer) { this.onmessage?.({ data: message instanceof ArrayBuffer ? message : JSON.stringify(message) }); }
}

function withSocket(
  run: (socket: Socket, stream: BrowserStream, states: StreamState[], refusals: () => number, tick: () => void, decoded: number[], api: GatewayApi, reasons: string[]) => void,
) {
  const original = globalThis.WebSocket;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;
  globalThis.requestAnimationFrame = (callback) => { const handle = nextHandle++; callbacks.set(handle, callback); return handle; };
  globalThis.cancelAnimationFrame = (handle) => { if (handle != null) callbacks.delete(handle); };
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  try {
    const states: StreamState[] = [];
    const decoded: number[] = [];
    let refusalCount = 0;
    const reasons: string[] = [];
    const api = new GatewayApi({ baseUrl: "http://example", token: "token" },
      async () => Response.json({ device_id: "device", computer_name: "computer", gateway_version: "1", paired_at: null, pairing_method: "manual" }),
      (reason) => { refusalCount++; reasons.push(reason); });
    const stream = new BrowserStream(api, "lease", true, {
      state: (state) => states.push(state), frame: (packet) => {
        decoded.push(packet.frame.seq); if (packet.frame.seq === 5) stream.displayedFrame(packet.frame);
      },
      pages: () => {}, reply: () => {}, ended: () => {}, error: () => {},
    });
    const socket = Socket.instances.at(-1)!;
    const tick = () => {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) callback(performance.now());
    };
    run(socket, stream, states, () => refusalCount, tick, decoded, api, reasons);
    stream.close();
    assert.equal(callbacks.size, 0, "closing the stream cancels pending decode work");
  } finally {
    globalThis.WebSocket = original;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
}

test("binary frame preserves BE header, epoch and raw JPEG; malformed packets are rejected", () => {
  assert.deepEqual(decodeFrame(packet()).frame, frame);
  assert.deepEqual([...decodeFrame(packet()).jpeg], [0xff, 0xd8, 0xff, 0xd9]);
  const littleEndian = packet(); new DataView(littleEndian).setUint32(0, 500_000, false);
  assert.throws(() => decodeFrame(littleEndian), /invalid-header-length/);
  const noJpeg = packet(); new Uint8Array(noJpeg)[noJpeg.byteLength - 4] = 0;
  assert.throws(() => decodeFrame(noJpeg), /invalid-jpeg/);
  assert.throws(() => decodeFrame(new ArrayBuffer(3)), /short-frame/);
  const measured = { ...frame, dropped_frames: 3, ack_wait_ms: null, applied_input_id: 0 };
  assert.deepEqual(decodeFrame(packet(measured)).frame, measured);
  assert.throws(() => decodeFrame(packet({ ...frame, applied_input_id: -1 })), /invalid-frame-header/);
  assert.throws(() => decodeFrame(packet({ ...frame, dropped_frames: -1 })), /invalid-frame-header/);
  assert.throws(() => decodeFrame(packet({ ...frame, ack_wait_ms: -1 })), /invalid-frame-header/);
  for (const field of ["frame_age_ms", "credit_wait_ms", "send_lock_ms", "ack_baseline_ms", "ack_smoothed_ms", "queue_delay_ms", "delivery_rate_bps"] as const) {
    for (const invalid of [-1, undefined, "3"]) {
      assert.throws(() => decodeFrame(packet({ ...frame, [field]: invalid })), /invalid-frame-header/, `${field} rejects ${String(invalid)}`);
    }
    // JSON.stringify maps NaN/Infinity to valid null, so exercise a wire number
    // that JSON.parse actually turns into Infinity instead of testing the encoder.
    const overflow = JSON.stringify({ ...frame, [field]: 0 }).replace(`"${field}":0`, `"${field}":1e999`);
    assert.throws(() => decodeFrame(packet(overflow)), /invalid-frame-header/);
  }
  for (const field of ["max_in_flight", "in_flight"] as const) {
    for (const invalid of [0, 33, 1.5, undefined]) {
      assert.throws(() => decodeFrame(packet({ ...frame, [field]: invalid })), /invalid-frame-header/);
    }
  }
  assert.equal(decodeFrame(packet({ ...frame, max_in_flight: 32, in_flight: 32 })).frame.in_flight, 32);
  for (const connection_id of ["", 42, null]) {
    assert.throws(() => decodeFrame(packet({ ...frame, connection_id })), /invalid-frame-header/);
  }
  for (const [field, invalids] of [["in_flight_bytes", [-1, 1.5, null, undefined, "5", Number.MAX_SAFE_INTEGER + 1]],
    ["byte_budget", [0, -1, 1.5, null, undefined, Number.MAX_SAFE_INTEGER + 1]]] as const) {
    for (const invalid of invalids) assert.throws(() => decodeFrame(packet({ ...frame, [field]: invalid })), /invalid-frame-header/);
  }
  for (const invalid of [null, undefined, "unknown", "frame_credit", 5]) {
    assert.throws(() => decodeFrame(packet({ ...frame, stop_reason: invalid })), /invalid-frame-header/);
  }
  for (const stop_reason of ["none", "frame-credit", "byte-credit", "pacing", "oldest-frame"] as const) {
    assert.equal(decodeFrame(packet({ ...frame, stop_reason, delivery_rate_bps: 0, in_flight_bytes: 0 })).frame.stop_reason, stop_reason);
  }
  assert.throws(() => decodeFrame(packet({ ...frame, quality_reason: "ack-delay" })), /invalid-frame-header/);
  assert.equal(decodeFrame(packet({ ...frame, quality_reason: "queue-delay" })).frame.quality_reason, "queue-delay");
  assert.equal(decodeFrame(packet({ ...frame, quality_reason: "bandwidth" })).frame.quality_reason, "bandwidth");
  assert.equal(decodeFrame(packet({ ...frame, quality_reason: "steady" })).frame.quality_reason, "steady");
  for (const reason of ["frame-size", "byte-cap"]) {
    assert.throws(() => decodeFrame(packet({ ...frame, quality_reason: reason })), /invalid-frame-header/);
  }
});

test("hello and input completion timings have bounded finite protocol fields", () => {
  const hello = { t: "hello", connection_id: "gateway-1", protocol: 1, ping_supported: true, window_mode: "adaptive", max_in_flight: 2, max_in_flight_limit: 32 };
  assert.deepEqual(decodeHello(hello), hello);
  assert.deepEqual(decodeHello({ ...hello, window_mode: "fixed", max_in_flight: 32 }), { ...hello, window_mode: "fixed", max_in_flight: 32 });
  for (const broken of [{ max_in_flight: 0 }, { max_in_flight: 33 }, { max_in_flight_limit: 24 },
    { window_mode: "bogus" }, { max_in_flight: 3 }, { ping_supported: "true" }, { connection_id: "" }, { connection_id: 42 }]) {
    assert.throws(() => decodeHello({ ...hello, ...broken }), /invalid-hello/);
  }
  assert.equal(decodeHello({ ...hello, connection_id: undefined }).connection_id, undefined, "legacy fixture may omit id");
  const done = { t: "input_done", id: 4, input_lock_wait_ms: 2, input_dispatch_ms: 7, input_cdp_ms: 5 };
  assert.deepEqual(decodeInputDone(done), done);
  for (const field of ["input_lock_wait_ms", "input_dispatch_ms", "input_cdp_ms"] as const) {
    for (const invalid of [-1, Number.NaN, undefined, null, "3"]) {
      assert.throws(() => decodeInputDone({ ...done, [field]: invalid }), /invalid-input-done/);
    }
  }

});

test("native JPEG decoding receives only JPEG bytes, not the WebSocket envelope", () => {
  const data = packet();
  const { jpeg } = decodeFrame(data);
  assert.equal(jpeg.byteOffset, 0);
  assert.equal(jpeg.byteLength, 4);
  assert.equal(jpeg.buffer.byteLength, jpeg.byteLength);
  // Skia reads the backing buffer, not the TypedArray view.
  assert.deepEqual([...new Uint8Array(jpeg.buffer)], [0xff, 0xd8, 0xff, 0xd9]);
  new Uint8Array(data).fill(0);
  assert.deepEqual([...jpeg], [0xff, 0xd8, 0xff, 0xd9]);
});

test("input credential matches page, epoch, viewport and human state", () => {
  assert.equal(inputFrame(frame, pages("a"), true), frame);
  assert.equal(inputFrame(frame, pages("b", 3, 7, "human", ["a", "b"]), true), null);
  assert.equal(inputFrame(frame, pages("a", 4), true), null);
  assert.equal(inputFrame(frame, pages("a", 3, 8), true), null);
  assert.equal(inputFrame(frame, pages(null), true), null);
  assert.equal(inputFrame(frame, pages("a", 3, 7, "revoking"), true), null);
  assert.equal(inputFrame(frame, pages("a"), false), null);
  assert.match(rejectReason("stale-frame"), /过期/);
  assert.match(rejectReason("invalid-gesture"), /手势/);
});

test("unknown browser diagnostics never become user-facing text", () => {
  const diagnostic = "Protocol error (Input.dispatchMouseEvent): target closed";
  assert.doesNotMatch(rejectReason(diagnostic), /Protocol error|target closed/);
  assert.match(rejectReason("no-page"), /新建页面/);
  assert.doesNotMatch(endedReason(`关闭未确认：${diagnostic}`), /Protocol error|target closed/);
  assert.match(rejectReason("page-limit"), /上限/);
  assert.match(rejectReason("task-ended"), /任务已结束/);
  assert.match(endedReason("Agent 删除"), /Agent 已删除/);
  assert.match(endedReason("对话删除"), /对话已删除/);
  assert.match(endedReason("任务结束"), /任务已结束/);
  assert.match(endedReason("浏览器空闲超时"), /超时|长时间/);
});

test("new pages are notices, never automatic switches; closed notices expire", () => {
  let state = applyPages(EMPTY_PAGE_STATE, pages("a"), 100);
  state = applyPages(state, pages("a", 3, 7, "human", ["a", "b"]), 200);
  assert.equal(state.current, "a");
  assert.equal(state.notices.at(-1)?.page?.id, "b");
  state = applyPages(state, pages("b", 3, 9, "human", ["a", "b"]), 300);
  assert.equal(state.current, "b");
  assert.equal(state.notices.length, 0);
  assert.equal(applyPages(state, pages(null, 4, 10, "released", []), 400).pages.length, 0);
});

test("empty control stage appears only for a live human snapshot and clears on new page", () => {
  assert.equal(isEmptyControlPages(EMPTY_PAGE_STATE), false, "connecting is not an empty lease");
  let state = applyPages(EMPTY_PAGE_STATE, pages("a"), 100);
  assert.equal(isEmptyControlPages(state), false);
  state = applyPages(state, pages(null, 3, 8, "human", []), 200);
  assert.equal(isEmptyControlPages(state), true, "the last page closed without releasing control");
  state = applyPages(state, pages("b", 3, 9, "human", ["b"]), 300);
  assert.equal(isEmptyControlPages(state), false, "a newly created page restores the stage");
  state = applyPages(state, pages(null, 4, 10, "released", []), 400);
  assert.equal(isEmptyControlPages(state), false, "lease release has its own ended stage");
});

test("reconnect restores the last confirmed selection instead of reusing the route page", () => {
  let selection = initialPageSelection("a");
  let observed = observePageSelection(selection, pages("b", 3, 7, "human", ["a", "b"]));
  assert.equal(observed.switchTo, "a");
  selection = observed.selection;
  assert.equal(selection.confirmed, null, "the initial socket has not confirmed a yet");
  observed = observePageSelection(selection, pages("a", 3, 8, "human", ["a", "b"]));
  selection = observed.selection;
  observed = observePageSelection(selection, pages("b", 3, 9, "human", ["a", "b"]));
  assert.equal(observed.switchTo, null, "the user switched to b");
  selection = resumePageSelection(observed.selection);
  observed = observePageSelection(selection, pages("a", 3, 10, "human", ["a", "b"]));
  assert.equal(observed.switchTo, "b");
  assert.equal(observed.selection.confirmed, "b", "a reconnect default must not replace b before confirmation");
  observed = observePageSelection(observed.selection, pages("a", 3, 10, "human", ["a", "b"]));
  assert.equal(observed.selection.confirmed, "b", "an intermediate snapshot must not undo pending restoration");
  observed = observePageSelection(observed.selection, pages("b", 3, 11, "human", ["a", "b"]));
  assert.equal(observed.selection.confirmed, "b");
  assert.equal(observed.selection.pending, null);
});

test("missing preferred page falls back to socket current and never reselects a stale route", () => {
  let selection = initialPageSelection("a");
  let observed = observePageSelection(selection, pages("b", 3, 7, "human", ["b"]));
  assert.equal(observed.switchTo, null);
  assert.equal(observed.selection.confirmed, "b");
  selection = resumePageSelection(observed.selection);
  observed = observePageSelection(selection, pages("c", 3, 8, "human", ["a", "c"]));
  assert.equal(observed.switchTo, null, "the old route a is not reconsidered when b disappears");
  assert.equal(observed.selection.confirmed, "c");
  selection = resumePageSelection(observed.selection);
  observed = observePageSelection(selection, pages("a", 3, 9, "human", ["a", "c"]));
  assert.equal(observed.switchTo, "c", "the fallback is now the last confirmed page");
  observed = observePageSelection(observed.selection, pages("a", 3, 10, "human", ["a"]));
  assert.equal(observed.selection.confirmed, "a", "a pending page that closes yields to the live page");
  assert.equal(observed.selection.pending, null);
});

test("a failed restoration yields to the currently selected page", () => {
  let selection = observePageSelection(initialPageSelection("b"), pages("a", 3, 7, "human", ["a", "b"])).selection;
  selection = rejectPageRestoration(selection, "a");
  assert.equal(observePageSelection(resumePageSelection(selection), pages("a", 3, 8, "human", ["a", "b"])).switchTo, null);
});

test("remembered browser page is never restored against another computer with identical page IDs", () => {
  const first = observePageSelection(initialPageSelection("a", "first"), pages("b", 3, 7, "human", ["a", "b"]));
  assert.equal(first.selection.computerId, "first");
  const selected = observePageSelection(first.selection, pages("a", 3, 8, "human", ["a", "b"])).selection;
  assert.equal(selected.computerId, "first");
  assert.equal(resumePageSelection(selected, "first").confirmed, "a", "reconnecting the same computer remembers its page");
  const second = resumePageSelection(selected, "second");
  assert.equal(second.confirmed, null);
  assert.equal(second.route, null);
  assert.equal(observePageSelection(second, pages("b", 3, 7, "human", ["a", "b"])).switchTo, null);
});

test("socket auth, displayed-only ack, pending gesture, page switch and disconnect guards", () => withSocket((socket, stream, states, _refusals, tick) => {
  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(socket.options.headers.Authorization, "Bearer token");
  socket.open();
  socket.emit({ t: "hello", connection_id: "gateway-1", protocol: 1, ping_supported: true, window_mode: "adaptive", max_in_flight: 2, max_in_flight_limit: 32 });
  assert.deepEqual(socket.sent.at(-1), { t: "ping", id: 1 });
  socket.emit({ t: "pong", id: 1 });
  const firstRtt = stream.measurements.snapshot(performance.now()).rttMs;
  assert.ok(firstRtt !== null && firstRtt >= 0);
  socket.emit({ t: "pong", id: 1 }); // duplicate response is ignored
  socket.emit({ t: "pong", id: 999 }); // unsolicited response is ignored
  assert.equal(stream.measurements.snapshot(performance.now()).rttMs, firstRtt);
  socket.emit(pages("a"));
  assert.equal(stream.input({ t: "click", x: 2, y: 3, button: "left" }), null);
  stream.discardFrame(4); assert.equal(stream.input({ t: "reload" }), null);
  socket.emit(packet());
  assert.equal(stream.input({ t: "reload" }), null, "queued JPEG cannot authorize input");
  tick();
  assert.deepEqual(socket.sent.at(-1), { t: "ack", seq: 5, displayed: true });
  const click = stream.input({ t: "click", x: 100, y: 50, button: "left" });
  assert.ok(click);
  assert.deepEqual(socket.sent.at(-1), { t: "click", x: 99.999, y: 49.999, button: "left", id: click, epoch: 3, vp: 7, frame: 5 });
  socket.emit({ t: "input_pending", id: click });
  assert.equal(stream.input({ t: "reload" }) !== null, true, "pending is not completion or revocation");
  assert.equal(stream.switchPage("b"), null, "unknown page cannot switch");
  assert.ok(stream.input({ t: "reload" }), "unknown page does not revoke current credential");
  socket.emit(pages("a", 4)); assert.equal(stream.input({ t: "reload" }), null);
  socket.close(); const count = socket.sent.length;
  socket.onopen?.(); socket.onerror?.(); socket.onclose?.({ code: 1000 });
  assert.equal(stream.input({ t: "reload" }), null);
  assert.equal(socket.sent.length, count);
  assert.deepEqual(states, ["connecting", "open", "closed"]);
}));

test("two-second pings measure slower roundtrips and stop with the socket", () => {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const originalNow = performance.now;
  let now = 0;
  performance.now = () => now;
  const ticks = new Map<number, () => void>();
  const cleared = new Set<number>();
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    assert.ok(delay === 2000 || delay === 5000);
    ticks.set(delay, callback);
    return delay;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: number) => {
    cleared.add(timer);
  }) as typeof clearInterval;
  try {
    withSocket((socket, stream) => {
      socket.open();
      socket.emit({ t: "hello", connection_id: "gateway-1", protocol: 1, ping_supported: true, window_mode: "adaptive", max_in_flight: 2, max_in_flight_limit: 32 });
      assert.deepEqual(socket.sent.at(-1), { t: "ping", id: 1 });
      assert.ok(ticks.get(2000));
      now = 2000;
      ticks.get(2000)!();
      assert.deepEqual(socket.sent.at(-1), { t: "ping", id: 2 });
      now = 3000;
      socket.emit({ t: "pong", id: 1 });
      assert.equal(stream.measurements.snapshot(now).rttMs, 3000, "RTT above the probe interval remains measurable");
      now = 4000;
      socket.emit({ t: "pong", id: 2 });
      assert.equal(stream.measurements.snapshot(now).rttMs, 2000);
      socket.emit({ t: "pong", id: 1 });
      assert.equal(stream.measurements.snapshot(now).rttMs, 2000, "duplicate pong must not resample");
      stream.close();
      const count = socket.sent.length;
      ticks.get(2000)!();
      assert.equal(socket.sent.length, count);
      assert.deepEqual(cleared, new Set([2000, 5000]));
    });
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    performance.now = originalNow;
  }
});

test("hello without ping support leaves RTT unknown", () => withSocket((socket, stream, _states, _refusals, tick) => {
  socket.open();
  socket.emit({ t: "hello", connection_id: "gateway-1", protocol: 1, ping_supported: false, window_mode: "adaptive", max_in_flight: 2, max_in_flight_limit: 32 });
  socket.emit(pages("a"));
  socket.emit(packet());
  tick();
  assert.deepEqual(socket.sent, [{ t: "ack", seq: frame.seq, displayed: true }]);
  assert.equal(stream.measurements.snapshot(performance.now()).rttMs, null);
  assert.deepEqual([stream.measurements.snapshot(performance.now()).windowMode,
    stream.measurements.snapshot(performance.now()).maxInFlightLimit], ["adaptive", 32]);
  assert.ok(stream.input({ t: "click", x: 2, y: 3, button: "left" }));
}));

test("socket frame measurement follows actual display and bound input id", () => withSocket((socket, stream, _states, _refusals, tick) => {
  socket.open(); socket.emit(pages("a")); socket.emit(packet()); tick();
  const id = stream.input({ t: "click", x: 2, y: 3, button: "left" })!;
  socket.emit({ t: "input_done", id, input_lock_wait_ms: 2, input_dispatch_ms: 7, input_cdp_ms: 5 });
  const before = { ...frame, seq: 6, applied_input_id: id - 1 };
  socket.emit(packet(before)); tick();
  stream.displayedFrame(before);
  assert.equal(stream.measurements.snapshot(performance.now()).inputSamples, 0);
  const current = { ...frame, seq: 7, applied_input_id: id, dropped_frames: 2, ack_wait_ms: 4,
    max_in_flight: 8, in_flight: 5, frame_age_ms: 30, credit_wait_ms: 10, send_lock_ms: 6,
    ack_baseline_ms: 700, ack_smoothed_ms: 760, queue_delay_ms: 60 };
  socket.emit(packet(current));
  assert.equal(stream.measurements.snapshot(performance.now()).inputSamples, 0, "receiving is not display");
  tick();
  assert.equal(stream.measurements.snapshot(performance.now()).inputSamples, 0, "decoding is not display");
  stream.displayedFrame(current);
  stream.displayedFrame(current);
  assert.equal(stream.measurements.snapshot(performance.now()).inputSamples, 1);
  assert.equal(stream.measurements.snapshot(performance.now()).gatewayDropped, 2);
  assert.equal(stream.measurements.snapshot(performance.now()).ackWaitMs, 4);
  const stats = stream.measurements.snapshot(performance.now());
  assert.deepEqual([stats.maxInFlight, stats.inFlight, stats.frameAgeMs, stats.creditWaitMs,
    stats.sendLockMs, stats.ackBaselineMs, stats.ackSmoothedMs, stats.queueDelayMs],
    [8, 5, 30, 10, 6, 700, 760, 60]);
  assert.deepEqual([stats.inputLockWaitMs, stats.inputDispatchMs, stats.inputCdpMs, stats.inputDoneSamples],
    [2, 7, 5, 1]);
  assert.equal(socket.sent.filter((message) => "t" in message && message.t === "ack" && "seq" in message && message.seq === 7).length, 1);
}));

test("Metro lines retain all completed click samples and cutoff pending after socket stop", () => {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try {
    withSocket((socket, stream, _states, _refusals, tick) => {
      socket.open();
      socket.emit({ t: "hello", protocol: 1, ping_supported: false, connection_id: "gateway-1",
        window_mode: "adaptive", max_in_flight: 2, max_in_flight_limit: 32 });
      socket.emit(pages("a")); socket.emit(packet()); tick();
      for (let n = 1; n <= 23; n++) {
        const id = stream.input({ t: "click", x: 2, y: 3, button: "left" })!;
        socket.emit({ t: "input_done", id, input_lock_wait_ms: 0, input_dispatch_ms: 0, input_cdp_ms: 0 });
        const next = { ...frame, seq: frame.seq + n, applied_input_id: id, ack_wait_ms: n };
        socket.emit(packet(next)); tick(); stream.displayedFrame(next);
      }
      const pendingId = stream.input({ t: "click", x: 2, y: 3, button: "left" })!;
      stream.close();
      const clickLines = lines.filter((line) => line.startsWith("[stream-click] "))
        .map((line) => JSON.parse(line.slice("[stream-click] ".length)) as {
          id?: number; status: string; latencyMs?: number; connectionId: string; appliedInputId?: number;
        });
      const started = clickLines.filter((event) => event.status === "started");
      const completed = clickLines.filter((event) => event.status === "completed");
      assert.deepEqual(started.map((event) => event.id), Array.from({ length: 24 }, (_, index) => index + 1));
      assert.deepEqual(completed.map((event) => event.id), Array.from({ length: 23 }, (_, index) => index + 1));
      assert.ok(completed.every((event) => event.latencyMs! >= 0));
      assert.deepEqual(clickLines.filter((event) => event.status === "displayed").map((event) => event.appliedInputId),
        Array.from({ length: 23 }, (_, index) => index + 1));
      const intervals = lines.filter((line) => line.startsWith("[stream-interval] "))
        .map((line) => JSON.parse(line.slice("[stream-interval] ".length)) as {
          receivedFrames: number; firstSeq: number; gatewayConnectionId: string;
          frameHeaderAckWaitMs: { count: number; p50: number | null; p90: number | null };
        });
      assert.deepEqual(intervals.map((interval) => interval.receivedFrames), [24]);
      assert.equal(intervals[0].firstSeq, frame.seq);
      assert.equal(intervals[0].gatewayConnectionId, "gateway-1");
      assert.deepEqual(intervals[0].frameHeaderAckWaitMs, { count: 23, p50: 12, p90: 21 });
      const cutoff = JSON.parse(lines.find((line) => line.startsWith("[stream-cutoff] "))!.slice("[stream-cutoff] ".length));
      assert.deepEqual([cutoff.pendingCount, cutoff.pendingIds, cutoff.clickTrackingOverflows, cutoff.shownTotal], [1, [pendingId], 0, 24]);
      assert.ok(clickLines.every((event) => event.connectionId === cutoff.connectionId));
    });
  } finally {
    console.log = originalLog;
  }
});

test("an authenticated browser 4401 explicitly revokes without HTTP confirmation", () => withSocket((socket, _stream, states, refusals, _tick, _decoded, _api, reasons) => {
  socket.open();
  socket.close(4401);
  assert.equal(refusals(), 1);
  assert.deepEqual(reasons, ["revoked"]);
  assert.deepEqual(states, ["connecting", "open", "closed"]);
}));

test("switch closes the old browser socket before its screen unmounts and ignores late revocation", () => withSocket((socket, stream, states, refusals, tick, decoded, api) => {
  socket.open();
  socket.emit(pages("a"));
  socket.emit(packet());
  api.close();
  assert.equal(socket.readyState, 3);
  assert.equal(stream.isOpen, false);
  assert.deepEqual(states, ["connecting", "open", "closed"]);
  socket.emit(packet({ ...frame, seq: 6 }));
  socket.onclose?.({ code: 4401 });
  tick();
  assert.deepEqual(decoded, []);
  assert.equal(refusals(), 0);
}));

test("switch waits for selected page and fresh displayed frame", () => withSocket((socket, stream, _states, _refusals, tick) => {
  socket.open(); socket.emit(pages("a", 3, 7, "human", ["a", "b"])); socket.emit(packet()); tick();
  assert.equal(stream.switchPage("a"), null, "already selected page must not deadlock waiting for a pages event");
  assert.ok(stream.switchPage("b"));
  socket.emit(packet({ ...frame, seq: 6 })); assert.equal(stream.input({ t: "reload" }), null);
  assert.deepEqual(socket.sent.at(-1), { t: "ack", seq: 6, displayed: false });
  socket.emit(pages("b", 3, 8, "human", ["a", "b"]));
  assert.equal(stream.input({ t: "reload" }), null);
  const selected = { ...frame, page: "b", vp: 8, seq: 7 };
  socket.emit(packet(selected));
  assert.equal(stream.input({ t: "reload" }), null);
  tick();
  assert.equal(stream.input({ t: "reload" }), null, "decode is not committed display");
  stream.displayedFrame(selected);
  assert.ok(stream.input({ t: "reload" }));
}));

test("new-page sends epoch and cannot reuse old frame until new selection appears", () => withSocket((socket, stream, _states, _refusals, tick) => {
  socket.open(); socket.emit(pages("a")); socket.emit(packet()); tick();
  const id = stream.newPage();
  assert.ok(id);
  assert.deepEqual(socket.sent.at(-1), { t: "new_page", id, epoch: 3 });
  assert.equal(stream.input({ t: "reload" }), null);
  socket.emit(pages("a", 3, 7, "human", ["a", "b"]));
  socket.emit(packet({ ...frame, seq: 6 })); assert.equal(stream.input({ t: "reload" }), null);
  socket.emit(pages("b", 3, 8, "human", ["a", "b"]));
  const selected = { ...frame, page: "b", vp: 8, seq: 7 };
  socket.emit(packet(selected)); tick();
  stream.displayedFrame(selected);
  assert.ok(stream.input({ t: "reload" }));
  socket.emit(pages("b", 4, 9, "requested", ["a", "b"]));
  assert.equal(stream.newPage(), null);
  assert.equal(stream.input({ t: "reload" }), null);
}));

test("empty human lease can create a new page but a released lease cannot", () => withSocket((socket, stream) => {
  socket.open();
  socket.emit(pages(null, 3, 8, "human", []));
  assert.equal(stream.input({ t: "reload" }), null);
  const id = stream.newPage();
  assert.ok(id);
  assert.deepEqual(socket.sent.at(-1), { t: "new_page", id, epoch: 3 });
  socket.emit(pages("b", 3, 9, "human", ["b"]));
  assert.equal(stream.input({ t: "reload" }), null, "new page needs its own displayed frame");
  socket.emit(pages(null, 4, 10, "released", []));
  assert.equal(stream.newPage(), null);
}));

test("rejected page command restores the still-displayed frame", () => withSocket((socket, stream, _states, _refusals, tick) => {
  socket.open(); socket.emit(pages("a")); socket.emit(packet()); tick();
  const id = stream.newPage();
  assert.ok(id);
  assert.equal(stream.input({ t: "reload" }), null);
  socket.emit({ t: "reject", id, why: "浏览器页面数已达上限" });
  assert.ok(stream.input({ t: "reload" }), "rejected command did not change page, epoch or displayed frame");
}));

test("burst keeps only newest raw JPEG and ACKs every superseded frame once", () => withSocket((socket, stream, _states, _refusals, tick, decoded) => {
  socket.open(); socket.emit(pages("a"));
  socket.emit(packet());
  socket.emit(packet({ ...frame, seq: 6 }));
  socket.emit(packet({ ...frame, seq: 7 }));
  const acknowledgments = () => socket.sent.filter((message) => "t" in message && message.t === "ack");
  assert.deepEqual(acknowledgments(), [
    { t: "ack", seq: 5, displayed: false }, { t: "ack", seq: 6, displayed: false },
  ]);
  assert.equal(stream.input({ t: "reload" }), null);
  tick();
  assert.deepEqual(decoded, [7], "only newest envelope reaches JPEG copy/native decoder");
  assert.equal(stream.displayedFrame(frame), false, "superseded frame cannot promote itself");
  assert.equal(acknowledgments().length, 2, "decoding alone does not ACK as displayed");
  assert.equal(stream.displayedFrame({ ...frame, seq: 7 }), true);
  assert.equal(stream.displayedFrame({ ...frame, seq: 7 }), false);
  socket.emit(packet({ ...frame, seq: 7 })); // duplicate transport event adds no second credit
  assert.deepEqual(acknowledgments(), [
    { t: "ack", seq: 5, displayed: false }, { t: "ack", seq: 6, displayed: false },
    { t: "ack", seq: 7, displayed: true },
  ]);
  assert.equal(stream.measurements.snapshot(performance.now()).localDiscarded, 2);
  assert.ok(stream.input({ t: "reload" }));
  assert.deepEqual(socket.sent.at(-1), { t: "reload", id: 1, epoch: 3, vp: 7, frame: 7 });

  socket.emit(packet({ ...frame, seq: 8 })); tick();
  socket.emit(packet({ ...frame, seq: 9 }));
  socket.emit(packet({ ...frame, seq: 10 }));
  assert.deepEqual(acknowledgments().at(-1), { t: "ack", seq: 9, displayed: false });
  assert.equal(stream.displayedFrame({ ...frame, seq: 8 }), true, "active image can commit despite newer arrivals");
  tick();
  assert.deepEqual(decoded, [7, 8, 10]);
  assert.equal(stream.displayedFrame({ ...frame, seq: 10 }), true);
  assert.deepEqual(acknowledgments().slice(-3), [
    { t: "ack", seq: 9, displayed: false }, { t: "ack", seq: 8, displayed: true },
    { t: "ack", seq: 10, displayed: true },
  ]);
  assert.equal(stream.measurements.snapshot(performance.now()).localDiscarded, 3);
  assert.ok(stream.input({ t: "reload" }));
  assert.deepEqual(socket.sent.at(-1), { t: "reload", id: 2, epoch: 3, vp: 7, frame: 10 });
  socket.emit(packet({ ...frame, seq: 11 })); tick();
  stream.discardFrame(11); stream.discardFrame(11);
  assert.deepEqual(acknowledgments().at(-1), { t: "ack", seq: 11, displayed: false });
  assert.equal(stream.measurements.snapshot(performance.now()).localDiscarded, 4);
  assert.ok(stream.input({ t: "reload" }), "decode failure retains prior displayed credential");
}));

test("slow UI commit keeps active frame alive while a bounded latest slot absorbs four in-flight frames", () => withSocket((socket, stream, _states, _refusals, tick, decoded) => {
  socket.open();
  socket.emit({ t: "hello", connection_id: "gateway-1", protocol: 1, ping_supported: false, window_mode: "fixed", max_in_flight: 4, max_in_flight_limit: 32 });
  socket.emit(pages("a"));
  socket.emit(packet({ ...frame, seq: 6 })); tick();
  assert.deepEqual(decoded, [6]);
  for (const seq of [7, 8, 9]) socket.emit(packet({ ...frame, seq }));
  tick();
  assert.deepEqual(decoded, [6], "pending arrivals do not decode or preempt an uncommitted image");
  assert.equal(stream.input({ t: "reload" }), null);
  assert.equal(stream.displayedFrame({ ...frame, seq: 6 }), true);
  assert.ok(stream.input({ t: "reload" }));
  assert.deepEqual(socket.sent.at(-1), { t: "reload", id: 1, epoch: 3, vp: 7, frame: 6 });
  tick();
  assert.deepEqual(decoded, [6, 9], "latest pending packet is the next display candidate");
  assert.equal(stream.displayedFrame({ ...frame, seq: 9 }), true);
  assert.ok(stream.input({ t: "reload" }));
  assert.deepEqual(socket.sent.at(-1), { t: "reload", id: 2, epoch: 3, vp: 7, frame: 9 });
  assert.deepEqual(socket.sent.filter((message) => "t" in message && message.t === "ack"), [
    { t: "ack", seq: 7, displayed: false }, { t: "ack", seq: 8, displayed: false },
    { t: "ack", seq: 6, displayed: true }, { t: "ack", seq: 9, displayed: true },
  ]);
  assert.equal(stream.measurements.snapshot(performance.now()).localDiscarded, 2);
  assert.equal(stream.measurements.snapshot(performance.now()).displayFps, 0.4);
}));

test("page/epoch/viewport transitions and close settle pending credits without stale promotion", () => withSocket((socket, stream, _states, _refusals, tick) => {
  socket.open(); socket.emit(pages("a", 3, 7, "human", ["a", "b"]));
  socket.emit(packet()); tick();
  socket.emit(packet({ ...frame, seq: 6 }));
  socket.emit(pages("b", 3, 8, "human", ["a", "b"]));
  tick();
  assert.equal(stream.displayedFrame({ ...frame, seq: 6 }), false);
  assert.equal(stream.input({ t: "reload" }), null);
  const next = { ...frame, seq: 7, page: "b", vp: 8 };
  socket.emit(packet(next)); tick();
  socket.emit(pages("b", 4, 8, "human", ["a", "b"]));
  assert.equal(stream.displayedFrame(next), false);
  const current = { ...next, seq: 8, epoch: 4 };
  socket.emit(packet(current)); tick(); stream.displayedFrame(current);
  assert.ok(stream.input({ t: "reload" }));
  socket.emit(packet({ ...current, seq: 9 }));
  stream.close();
  tick();
  assert.deepEqual(socket.sent.filter((message) => "t" in message && message.t === "ack"), [
    { t: "ack", seq: 5, displayed: true }, { t: "ack", seq: 6, displayed: false },
    { t: "ack", seq: 7, displayed: false }, { t: "ack", seq: 8, displayed: true },
    { t: "ack", seq: 9, displayed: false },
  ]);
}));

test("mouse controls remain inside stage in portrait and keyboard mode", () => {
  const area = { w: 400, h: 300 };
  assert.equal(buttonLayout("touch", area, false), null);
  for (const keyboard of [false, true]) {
    const layout = buttonLayout("mouse", area, keyboard)!;
    for (const rect of [layout.left, layout.right]) {
      assert.ok(rect.left >= 0 && rect.top >= 0);
      assert.ok(rect.left + rect.width <= area.w - WHEEL_WIDTH);
      assert.ok(rect.top + rect.height <= area.h - BUTTON_MARGIN + 1e-9);
    }
    assert.ok(layout.left.left + layout.left.width < layout.right.left);
  }
});
