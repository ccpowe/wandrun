import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { act, createElement, startTransition, Suspense, useEffect, useState } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";
import { useRuntimeCallback } from "../src/browser/use-runtime-callback.ts";

import type { SkImage } from "@shopify/react-native-skia";
import { GatewayApi } from "../src/gateway/api.ts";
import type { Frame, Pages } from "../src/browser/protocol.ts";
import type { FrameCandidate } from "../src/browser/frame-canvas.tsx";
import type { TouchEvent } from "../src/takeover-lab/gestures.ts";

type GestureHandler = (...args: unknown[]) => void;
interface ManualGesture {
  handlers: Record<string, GestureHandler>;
  shouldCancelWhenOutside(value: boolean): this;
  onTouchesDown(handler: GestureHandler): this;
  onTouchesMove(handler: GestureHandler): this;
  onTouchesUp(handler: GestureHandler): this;
  onTouchesCancelled(handler: GestureHandler): this;
  onFinalize(handler: GestureHandler): this;
}

class Scheduler {
  ui: (() => void)[] = [];
  rn: { callback: GestureHandler; args: unknown[] }[] = [];
  raf = new Map<number, FrameRequestCallback>();
  nextHandle = 1;
  observe: ((listeners: Set<() => void>) => void) | null = null;
  gestures: ManualGesture[] = [];
  shared<T>(initial: T) {
    let current = initial;
    const listeners = new Set<() => void>();
    const state = this;
    return {
      get value() { state.observe?.(listeners); return current; },
      set value(next: T) { current = next; for (const listener of listeners) listener(); },
    };
  }
  watch<T>(prepare: () => T, react: (value: T, previous: T | null) => void): () => void {
    let previous: T | null = null;
    const listeners = new Set<Set<() => void>>();
    const mapper = () => { const value = prepare(); react(value, previous); previous = value; };
    this.observe = (subscribers) => { subscribers.add(mapper); listeners.add(subscribers); };
    prepare();
    this.observe = null;
    return () => { for (const subscribers of listeners) subscribers.delete(mapper); };
  }
  flushUI() { for (const job of this.ui.splice(0)) job(); }
  flushRN() { for (const { callback, args } of this.rn.splice(0)) callback(...args); }
  tick() {
    const jobs = [...this.raf.values()];
    this.raf.clear();
    for (const job of jobs) job(performance.now());
  }
  gesture(): ManualGesture {
    const handlers: ManualGesture["handlers"] = {};
    const gesture = { handlers } as ManualGesture;
    for (const name of ["onTouchesDown", "onTouchesMove", "onTouchesUp", "onTouchesCancelled", "onFinalize"] as const) {
      gesture[name] = (callback: GestureHandler) => { handlers[name] = callback; return gesture; };
    }
    gesture.shouldCancelWhenOutside = () => gesture;
    this.gestures.push(gesture);
    return gesture;
  }
}

declare global {
  var __browserCanvasScheduler: Scheduler;
  var __browserCanvasReact: { useEffect: typeof useEffect; useState: typeof useState };
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.__browserCanvasScheduler = new Scheduler();
globalThis.__browserCanvasReact = { useEffect, useState };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Real React effects and real BrowserStream; only platform render, mapper and runtime queues
// are substituted. A tick models the UI rAF after shared-value submission, not GPU completion.
const nativeModules: Record<string, string> = {
  "@shopify/react-native-skia": `export const Canvas = 'Canvas'; export const Image = 'SkiaImage'; export const Path = 'SkiaPath';`,
  "react-native": `export const View = 'View';`,
  "react-native-worklets": `export function scheduleOnUI(callback, ...args) { globalThis.__browserCanvasScheduler.ui.push(() => callback(...args)); }
    export function scheduleOnRN(callback, ...args) { globalThis.__browserCanvasScheduler.rn.push({ callback, args }); }`,
  "react-native-reanimated": `const { useEffect, useState } = globalThis.__browserCanvasReact;
    export function useSharedValue(initial) { return useState(() => globalThis.__browserCanvasScheduler.shared(initial))[0]; }
    export function useAnimatedReaction(prepare, react) {
      useEffect(() => globalThis.__browserCanvasScheduler.watch(prepare, react), [prepare, react]);
    }`,
  "react-native-gesture-handler": `export const Gesture = { Manual: () => globalThis.__browserCanvasScheduler.gesture() };`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in nativeModules) return { url: `data:text/javascript,${encodeURIComponent(nativeModules[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const source = readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", shortCircuit: true, source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});

// Native-module hooks must register before importing the TSX component/hook under test.
const { FrameCanvas, FrameViewport, CursorCanvas } = await import("../src/browser/frame-canvas.tsx");
const { useRegionGesture } = await import("../src/browser/use-region-gesture.ts");
const { BrowserStream } = await import("../src/browser/stream.ts");

const baseFrame: Frame = { t: "frame", seq: 1, page: "a", epoch: 3, vp: 7, css: [100, 50], dpr: 1,
  scroll: [0, 0], pageScale: 1, offsetTop: 0, max_in_flight: 2, in_flight: 1,
  in_flight_bytes: 1024, byte_budget: 4096, delivery_rate_bps: null, stop_reason: "none",
  frame_age_ms: null, credit_wait_ms: 0, send_lock_ms: null, ack_baseline_ms: null, ack_smoothed_ms: null, queue_delay_ms: null };
const pages = (epoch: number): Pages => ({ t: "pages", current: "a", epoch, vp: 7, state: "human",
  max_pages: 8, css: [100, 50], dpr: 1, pages: [{ id: "a", title: "Page a", url: "https://a.example/" }] });
function packet(frame: Frame): ArrayBuffer {
  const header = new TextEncoder().encode(JSON.stringify(frame));
  const bytes = new Uint8Array(4 + header.length + 4);
  new DataView(bytes.buffer).setUint32(0, header.length, false);
  bytes.set(header, 4);
  bytes.set([0xff, 0xd8, 0xff, 0xd9], 4 + header.length);
  return bytes.buffer;
}
class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 0;
  binaryType = "blob";
  sent: object[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string, _protocols: string[], _options: object) { Socket.latest = this; }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(value: object | ArrayBuffer) { this.onmessage?.({ data: value instanceof ArrayBuffer ? value : JSON.stringify(value) }); }
}

function renderFrame(candidate: FrameCandidate, onDisplayed: (candidate: FrameCandidate) => void) {
  return createElement(FrameCanvas, { key: `${candidate.connectionId}:${candidate.frame.page}:${candidate.frame.epoch}:${candidate.frame.vp}`,
    candidate, containerWidth: 200, containerHeight: 100,
    x: 0, y: 0, width: 200, height: 100, onDisplayed });
}


// Recording lifetime only; native pixel clipping requires Android visual evidence.
test("first zoom, pan, successive frames and viewport resizing preserve canvas recordings", async () => {
  const scheduler = globalThis.__browserCanvasScheduler = new Scheduler();
  const original = { raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = (callback) => { const id = scheduler.nextHandle++; scheduler.raf.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => { if (id != null) scheduler.raf.delete(id); };
  const root = createRoot();
  const source = { isOpen: false } as FrameCandidate["source"];
  const displayed: number[] = [];
  const onDisplayed = (candidate: FrameCandidate) => { displayed.push(candidate.frame.seq); };
  function draw(seq: number, size: { w: number; h: number }, view: { z: number; tx: number; ty: number }) {
    const candidate = { frame: { ...baseFrame, seq }, image: { seq } as unknown as SkImage, source, connectionId: "socket" };
    const frame = createElement(FrameCanvas, { key: "socket:a:3:7", candidate,
      containerWidth: size.w, containerHeight: size.h,
      x: 0, y: 0, width: size.w, height: size.h, onDisplayed });
    const cursor = createElement("View", { style: { position: "absolute", left: -8, top: -4, width: 20, height: 28 } },
      createElement(CursorCanvas, { source }));
    return createElement(FrameViewport, { size, view, frame,
      style: { width: size.w, height: size.h } }, cursor);
  }
  try {
    await act(async () => { root.render(draw(1, { w: 200, h: 100 }, { z: 1, tx: 0, ty: 0 })); });
    const canvases = root.container.queryAll((node) => node.type === "Canvas");
    const recordings = canvases.map((node) => node.props.children);
    scheduler.flushUI(); scheduler.tick(); scheduler.flushRN();
    // Capture both identities at 1x, before the first zoom or frame replacement.
    const updates = [
      { seq: 2, size: { w: 200, h: 100 }, view: { z: 3.6, tx: -300, ty: -120 } },
      { seq: 3, size: { w: 200, h: 100 }, view: { z: 3.6, tx: -600, ty: -120 } },
      { seq: 4, size: { w: 200, h: 60 }, view: { z: 3.6, tx: -600, ty: -120 } },
      { seq: 5, size: { w: 100, h: 200 }, view: { z: 1, tx: 0, ty: 0 } },
      { seq: 6, size: { w: 100, h: 200 }, view: { z: 3.6, tx: 400, ty: 400 } },
    ];
    for (const { seq, size, view } of updates) {
      await act(async () => { root.render(draw(seq, size, view)); });
      const nextCanvases = root.container.queryAll((node) => node.type === "Canvas");
      assert.equal(nextCanvases[0], canvases[0], "main Canvas must survive the first zoom and subsequent updates");
      assert.equal(nextCanvases[1], canvases[1], "cursor Canvas must survive ordinary layout updates");
      assert.equal(nextCanvases[0].props.children, recordings[0]);
      assert.equal(nextCanvases[1].props.children, recordings[1]);
      scheduler.flushUI(); scheduler.tick(); scheduler.flushRN();
      const image = root.container.queryAll((node) => node.type === "SkiaImage")[0];
      // The host renderer erases the shared-value prop types supplied by FrameCanvas.
      const submittedImage = image.props.image as { value: { seq: number } };
      const submittedWidth = image.props.width as { value: number };
      const submittedHeight = image.props.height as { value: number };
      assert.equal(submittedImage.value.seq, seq);
      assert.equal(submittedWidth.value, size.w);
      assert.equal(submittedHeight.value, size.h);
    }
    assert.deepEqual(displayed, [1, 2, 3, 4, 5, 6], "retaining recordings must not freeze frame presentation");
  } finally {
    await act(async () => { root.unmount(); });
    scheduler.flushUI();
    globalThis.requestAnimationFrame = original.raf;
    globalThis.cancelAnimationFrame = original.cancel;
  }
});

test("actual canvas submission ACKs after the next UI callback, rejects stale/unmounted confirmations and never duplicates credit", async () => {
  const scheduler = globalThis.__browserCanvasScheduler = new Scheduler();
  const original = { socket: globalThis.WebSocket, raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.requestAnimationFrame = (callback) => { const id = scheduler.nextHandle++; scheduler.raf.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => { if (id != null) scheduler.raf.delete(id); };
  const candidates: FrameCandidate[] = [];
  const api = new GatewayApi({ baseUrl: "http://test", token: "dev", computerId: "canvas-test" });
  const stream = new BrowserStream(api, "lease", true, {
    state: () => {}, pages: () => {}, reply: () => {}, ended: () => {}, error: (message) => assert.fail(message),
    frame: ({ frame }) => candidates.push({ frame, image: { seq: frame.seq } as unknown as SkImage, source: stream, connectionId: "socket" }),
  });
  const root = createRoot();
  try {
    const socket = Socket.latest;
    socket.open(); socket.emit(pages(3));
    socket.emit(packet(baseFrame)); scheduler.tick();
    const received: number[] = [];
    const displayed = (candidate: FrameCandidate) => { if (candidate.source.displayedFrame(candidate.frame)) received.push(candidate.frame.seq); };
    await act(async () => { root.render(renderFrame(candidates[0], displayed)); });
    const child = root.container.queryAll((node) => node.type === "Canvas")[0].props.children;
    assert.deepEqual(socket.sent, [], "React commit and submission cannot pre-ACK");
    scheduler.flushUI();
    assert.deepEqual(socket.sent, [], "shared value update cannot pre-ACK");
    scheduler.tick();
    assert.deepEqual(socket.sent, [], "UI rAF queues RN confirmation rather than synchronously ACKing");
    const duplicate = scheduler.rn[0];
    scheduler.flushRN();
    duplicate.callback(...duplicate.args);
    assert.deepEqual(received, [1]);
    assert.deepEqual(socket.sent, [{ t: "ack", seq: 1, displayed: true }]);

    socket.emit(packet({ ...baseFrame, seq: 2 })); scheduler.tick();
    await act(async () => { root.render(renderFrame(candidates[1], displayed)); });
    assert.equal(root.container.queryAll((node) => node.type === "Canvas")[0].props.children, child, "new image cannot replace the recorded Skia child element");
    scheduler.flushUI(); scheduler.tick();
    socket.emit(pages(4));
    scheduler.flushRN();
    assert.deepEqual(received, [1], "an old generation cannot gain display credit");
    assert.deepEqual(socket.sent, [
      { t: "ack", seq: 1, displayed: true }, { t: "ack", seq: 2, displayed: false },
    ]);

    socket.emit(packet({ ...baseFrame, seq: 3, epoch: 4 })); scheduler.tick();
    await act(async () => { root.render(renderFrame(candidates[2], displayed)); });
    scheduler.flushUI(); scheduler.tick();
    const late = scheduler.rn[0];
    await act(async () => { root.unmount(); });
    scheduler.flushUI(); scheduler.flushRN();
    late.callback(...late.args);
    assert.deepEqual(received, [1], "queued RN callback after unmount cannot confirm");
    assert.deepEqual(socket.sent, [
      { t: "ack", seq: 1, displayed: true }, { t: "ack", seq: 2, displayed: false },
    ]);
  } finally {
    await act(async () => { root.unmount(); });
    stream.close();
    globalThis.WebSocket = original.socket;
    globalThis.requestAnimationFrame = original.raf;
    globalThis.cancelAnimationFrame = original.cancel;
  }
});

test("a candidate awaiting UI confirmation survives control state changes and later frames receive credit", async () => {
  const scheduler = globalThis.__browserCanvasScheduler = new Scheduler();
  const original = { socket: globalThis.WebSocket, raf: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.requestAnimationFrame = (callback) => { const id = scheduler.nextHandle++; scheduler.raf.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = (id) => { if (id != null) scheduler.raf.delete(id); };
  const candidates: FrameCandidate[] = [];
  const api = new GatewayApi({ baseUrl: "http://test", token: "dev", computerId: "canvas-state-test" });
  const stream = new BrowserStream(api, "lease", false, {
    state: () => {}, pages: () => {}, reply: () => {}, ended: () => {}, error: (message) => assert.fail(message),
    frame: ({ frame }) => candidates.push({ frame, image: { seq: frame.seq } as unknown as SkImage, source: stream, connectionId: "socket" }),
  });
  const root = createRoot();
  try {
    const socket = Socket.latest;
    socket.open(); socket.emit({ ...pages(3), state: "agent" });
    socket.emit(packet(baseFrame)); scheduler.tick();
    await act(async () => root.render(renderFrame(candidates[0], (candidate) => { candidate.source.displayedFrame(candidate.frame); })));
    scheduler.flushUI(); scheduler.tick();
    assert.deepEqual(socket.sent, [], "UI confirmation has not reached RN yet");
    socket.emit({ ...pages(3), state: "requested" });
    scheduler.flushRN();
    assert.deepEqual(socket.sent, [{ t: "ack", seq: 1, displayed: true }], "control change cannot strand the ACK slot");
    socket.emit(packet({ ...baseFrame, seq: 2 })); scheduler.tick();
    await act(async () => root.render(renderFrame(candidates[1], (candidate) => { candidate.source.displayedFrame(candidate.frame); })));
    scheduler.flushUI(); scheduler.tick(); scheduler.flushRN();
    assert.deepEqual(socket.sent, [{ t: "ack", seq: 1, displayed: true }, { t: "ack", seq: 2, displayed: true }]);
    socket.emit(packet({ ...baseFrame, seq: 3 })); scheduler.tick();
    await act(async () => root.render(renderFrame(candidates[2], (candidate) => { candidate.source.displayedFrame(candidate.frame); })));
    scheduler.flushUI(); scheduler.tick();
    socket.emit({ ...pages(4), state: "requested" });
    scheduler.flushRN();
    assert.deepEqual(socket.sent, [
      { t: "ack", seq: 1, displayed: true }, { t: "ack", seq: 2, displayed: true }, { t: "ack", seq: 3, displayed: false },
    ], "a genuine picture identity change settles an invalid candidate as discarded");
  } finally {
    await act(async () => root.unmount());
    stream.close();
    globalThis.WebSocket = original.socket;
    globalThis.requestAnimationFrame = original.raf;
    globalThis.cancelAnimationFrame = original.cancel;
  }
});

test("four real region gestures retain native identity while each receives its latest committed handler", async () => {
  const scheduler = globalThis.__browserCanvasScheduler = new Scheduler();
  const history: string[] = [];
  function Regions({ label }: { label: string }) {
    const log = (region: string) => (event: TouchEvent) => history.push(`${label}:${region}:${event.type}:${event.touches.length}`);
    useRegionGesture(log("surface"));
    useRegionGesture(log("wheel"));
    useRegionGesture(log("left"));
    useRegionGesture(log("right"));
    return null;
  }
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(Regions, { label: "before" })); });
    const originalGestures = [...scheduler.gestures];
    assert.equal(originalGestures.length, 4);
    const touch = { allTouches: [{ id: 7, x: 12, y: 34 }], changedTouches: [{ id: 7, x: 12, y: 34 }], numberOfTouches: 1 };
    const manager = { activate() {}, end() {}, fail() {} };
    for (const gesture of originalGestures) gesture.handlers.onTouchesDown(touch, manager);
    await act(async () => { root.render(createElement(Regions, { label: "after" })); });
    assert.deepEqual(scheduler.gestures, originalGestures);
    scheduler.flushRN();
    assert.deepEqual(history, ["surface", "wheel", "left", "right"].map((region) => `after:${region}:start:1`));
    for (const gesture of originalGestures) gesture.handlers.onFinalize(touch, false);
    scheduler.flushRN();
    assert.deepEqual(history.slice(4), ["surface", "wheel", "left", "right"].map((region) => `after:${region}:cancel:0`));
    for (const gesture of originalGestures) gesture.handlers.onTouchesDown(touch, manager);
    await act(async () => { root.unmount(); });
    scheduler.flushRN();
    assert.equal(history.length, 8, "unmounted handlers cannot receive queued gestures");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

// Capture even attempted renders so the tests prove suspension occurred after the hook,
// rather than passing because React never started the pending update.
function callbackFixture() {
  const history: string[] = [];
  const entries = new Map<string, (event: string) => void>();
  const gate = Promise.withResolvers<void>();
  let blocked = true;
  function Receiver({ label, suspend }: { label: string; suspend: boolean }) {
    const receive = useRuntimeCallback((event: string) => history.push(`${label}:${event}`));
    entries.set(label, receive);
    if (suspend && blocked) throw gate.promise;
    return createElement("receiver", { label });
  }
  return {
    history, entries,
    view: (label: string, suspend = false) => createElement(Suspense, {
      fallback: createElement("fallback"),
    }, createElement(Receiver, { label, suspend })),
    release() { blocked = false; gate.resolve(); },
  };
}

test("a suspended transition cannot replace the committed runtime handler", async () => {
  const fixture = callbackFixture();
  const root = createRoot();
  try {
    await act(async () => { root.render(fixture.view("committed")); });
    const receive = fixture.entries.get("committed")!;
    await act(async () => {
      startTransition(() => { root.render(fixture.view("pending", true)); });
    });
    assert.equal(fixture.entries.get("pending"), receive, "the pending render reached the hook");
    assert.equal(root.container.queryAll((node) => node.type === "receiver")[0].props.label, "committed");
    assert.equal(root.container.queryAll((node) => node.type === "fallback").length, 0);
    receive("while-pending");
    assert.deepEqual(fixture.history, ["committed:while-pending"]);

    await act(async () => { fixture.release(); });
    assert.equal(root.container.queryAll((node) => node.type === "receiver")[0].props.label, "pending");
    assert.equal(fixture.entries.get("pending"), receive);
    receive("after-commit");
    assert.deepEqual(fixture.history, ["committed:while-pending", "pending:after-commit"]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("Suspense hiding disables the runtime entry and revealing restores it", async () => {
  const fixture = callbackFixture();
  const root = createRoot();
  try {
    await act(async () => { root.render(fixture.view("visible")); });
    const receive = fixture.entries.get("visible")!;
    receive("before-hide");
    await act(async () => { root.render(fixture.view("restored", true)); });
    assert.equal(fixture.entries.get("restored"), receive);
    assert.equal(root.container.queryAll((node) => node.type === "receiver").length, 0);
    assert.equal(root.container.queryAll((node) => node.type === "fallback").length, 1);
    receive("while-hidden");
    assert.deepEqual(fixture.history, ["visible:before-hide"]);

    await act(async () => { fixture.release(); });
    assert.equal(root.container.queryAll((node) => node.type === "fallback").length, 0);
    assert.equal(root.container.queryAll((node) => node.type === "receiver")[0].props.label, "restored");
    assert.equal(fixture.entries.get("restored"), receive);
    receive("after-reveal");
    assert.deepEqual(fixture.history, ["visible:before-hide", "restored:after-reveal"]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("remounting creates an independent runtime entry without reviving the unmounted entry", async () => {
  const fixture = callbackFixture();
  const original = createRoot();
  const remounted = createRoot();
  try {
    await act(async () => { original.render(fixture.view("original")); });
    const oldEntry = fixture.entries.get("original")!;
    oldEntry("before-unmount");
    await act(async () => { original.unmount(); });
    oldEntry("after-unmount");
    assert.deepEqual(fixture.history, ["original:before-unmount"]);

    await act(async () => { remounted.render(fixture.view("remounted")); });
    const newEntry = fixture.entries.get("remounted")!;
    assert.notEqual(newEntry, oldEntry);
    oldEntry("after-remount");
    newEntry("new-event");
    assert.deepEqual(fixture.history, ["original:before-unmount", "remounted:new-event"]);
  } finally {
    await act(async () => { original.unmount(); remounted.unmount(); });
  }
});
