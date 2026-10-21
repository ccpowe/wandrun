import type { Frame, Hello, Input, Pages, Reply } from "./protocol.ts";

export type HermesMeasurements = {
  extBytes: number | null;
  heapBytes: number | null;
  gcCount: number | null;
};

/** Read this runtime's optional Hermes counters, never force GC or create Skia objects.
 * RN's HermesInternalType does not guarantee keys; unavailable/invalid values stay null.
 * Worklet callers must invoke this on UI, not capture RN's HermesInternal object.
 */
export function sampleHermes(): HermesMeasurements {
  "worklet";
  const result: HermesMeasurements = { extBytes: null, heapBytes: null, gcCount: null };
  try {
    const hermes = (globalThis as typeof globalThis & {
      HermesInternal?: { getInstrumentedStats?: () => Record<string, unknown> };
    }).HermesInternal;
    const stats = hermes?.getInstrumentedStats?.();
    const external = stats?.js_externalBytes;
    const heap = stats?.js_heapSize;
    const gc = stats?.js_numGCs;
    if (typeof external === "number" && Number.isFinite(external) && external >= 0) result.extBytes = external;
    if (typeof heap === "number" && Number.isFinite(heap) && heap >= 0) result.heapBytes = heap;
    if (typeof gc === "number" && Number.isFinite(gc) && gc >= 0) result.gcCount = gc;
  } catch {
    // Diagnostic API availability must not interrupt the stream.
  }
  return result;
}

export type StreamDiagnostics = StreamMeasurements & HermesMeasurements & {
  uiExtBytes: number | null;
  uiHeapBytes: number | null;
  uiGcCount: number | null;
};

// Unique within this JS module lifetime; the timestamp also distinguishes reloads in logs.
const measurementSession = Date.now();
let nextConnection = 0;

export type StreamMeasurements = {
  /** Gateway socket id, distinct from the App's per-JS-runtime identity. */
  gatewayConnectionId: string | null;
  connectionId: string;
  framesTotal: number;
  shownTotal: number;
  jpegBytesTotal: number;
  frameCanvasRenders: number;
  cursorCanvasRenders: number;
  receiveFps: number;
  displayFps: number;
  binaryKbps: number;
  jpegMeanKiB: number | null;
  jpegMaxKiB: number | null;
  gatewayDropped: number | null;
  localDiscarded: number;
  windowMode: Hello["window_mode"] | null;
  maxInFlight: number | null;
  maxInFlightLimit: number | null;
  inFlight: number | null;
  inFlightBytes: number | null;
  byteBudget: number | null;
  deliveryRateBps: number | null;
  stopReason: Frame["stop_reason"] | null;
  frameAgeMs: number | null;
  creditWaitMs: number | null;
  sendLockMs: number | null;
  ackBaselineMs: number | null;
  ackSmoothedMs: number | null;
  queueDelayMs: number | null;
  ackWaitMs: number | null;
  /** Maximum observed in the trailing five seconds; null if no valid sample remains. */
  inFlightPeak: number | null;
  inFlightBytesPeak: number | null;
  frameAgePeakMs: number | null;
  creditWaitPeakMs: number | null;
  sendLockPeakMs: number | null;
  queueDelayPeakMs: number | null;
  rttMs: number | null;
  inputMedianMs: number | null;
  inputP90Ms: number | null;
  inputSamples: number;
  /** Unfinished clicks retained online; overflowed flights require the raw trace. */
  pendingClicks: number;
  /** Number evicted from online click tracking; raw events remain in the click log. */
  clickTrackingOverflows: number;
  inputDoneSamples: number;
  inputLockWaitMs: number | null;
  inputDispatchMs: number | null;
  inputCdpMs: number | null;
  inputLockWaitMeanMs: number | null;
  inputDispatchMeanMs: number | null;
  inputCdpMeanMs: number | null;
  inputLockWaitPeakMs: number | null;
  inputDispatchPeakMs: number | null;
  inputCdpPeakMs: number | null;
};

type Flight = { startedAt: number; done: boolean; firstShownAt?: number };
const MAX_PENDING_CLICKS = 256;

/** Terminal online click outcome, never a substitute for the raw event trace. */
export type ClickOutcome = {
  id: number; status: "completed" | "rejected" | "invalidated";
  latencyMs?: number; reason?: string;
};

/** Logged in order under one connectionId; frame and selection events also cover evicted clicks. */
export type ClickEvent = ClickOutcome
  | { status: "started"; id: number; atMonoMs: number; page: string | null; epoch: number | null; vp: number | null }
  | { status: "input_pending"; id: number; atMonoMs: number }
  | { status: "input_done"; id: number; atMonoMs: number;
      inputLockWaitMs: number; inputDispatchMs: number; inputCdpMs: number }
  | { status: "reject"; id: number; atMonoMs: number; reason: string }
  | { status: "displayed"; appliedInputId: number; seq: number; atMonoMs: number; page: string; epoch: number; vp: number }
  | { status: "selection"; page: string | null; epoch: number; vp: number; state: Pages["state"] }
  | { status: "overflow"; id: number };

export type StreamInterval = {
  connectionId: string; gatewayConnectionId: string | null;
  startMonoMs: number; endMonoMs: number; startWallMs: number; endWallMs: number;
  firstSeq: number | null; lastSeq: number | null;
  receivedFrames: number; shownFrames: number; binaryBytes: number; jpegBytes: number;
  rttMs: { count: number; p50: number | null; p90: number | null };
  /** Distribution of frame-header-held ack_wait_ms observations; use server metrics for actual ACK statistics. */
  frameHeaderAckWaitMs: { count: number; p50: number | null; p90: number | null };
  arrivalIntervalMs: { count: number; p50: number | null; p90: number | null };
};

function quantiles(samples: number[]): { count: number; p50: number | null; p90: number | null } {
  if (!samples.length) return { count: 0, p50: null, p90: null };
  samples.sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return {
    count: samples.length,
    p50: samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2,
    p90: samples[Math.ceil(samples.length * 0.9) - 1],
  };
}

/** Monotone decreasing samples preserve earlier peaks until their own five-second expiry. */
class SlidingPeak {
  private samples: { at: number; value: number }[] = [];

  add(value: number | null, at: number): void {
    this.prune(at);
    if (value === null) return;
    while (this.samples.length && this.samples[this.samples.length - 1].value <= value) this.samples.pop();
    this.samples.push({ at, value });
  }

  at(now: number): number | null {
    this.prune(now);
    return this.samples[0]?.value ?? null;
  }

  private prune(now: number): void {
    while (this.samples.length && this.samples[0].at <= now - 5000) this.samples.shift();
  }
}

/** Per-socket, monotonic-time measurements. Gateway overwrites and client skips are separate;
 * the client increments localDiscarded once per false frame ACK. Binary throughput includes
 * the length/header/JPEG, while JPEG sizes count only the image. Rates use a trailing five seconds.
 * A click sample ends at the first displayed frame whose production-time applied id covers it.
 */
export class StreamMeter {
  /** Stable identity is available without sampling/pruning the measurement window. */
  readonly connectionId = `${measurementSession}-${++nextConnection}`;
  private gatewayConnectionId: string | null = null;
  readonly startMonoMs: number;
  readonly startWallMs: number;
  private intervalStartMonoMs: number;
  private intervalStartWallMs: number;
  private intervalBinaryBytes = 0;
  private intervalJpegBytes = 0;
  private intervalFrames = 0;
  private intervalShown = 0;
  private intervalFirstSeq: number | null = null;
  private intervalLastSeq: number | null = null;
  private lastArrivalAt: number | null = null;
  private intervalArrivals: number[] = [];
  private intervalFrameHeaderAckWait: number[] = [];
  private intervalRtt: number[] = [];
  private readonly onClick?: (event: ClickEvent) => void;

  constructor(onClick?: (event: ClickEvent) => void,
    startedMonoMs = performance.now(), startedWallMs = Date.now()) {
    this.onClick = onClick;
    this.startMonoMs = startedMonoMs;
    this.startWallMs = startedWallMs;
    this.intervalStartMonoMs = startedMonoMs;
    this.intervalStartWallMs = startedWallMs;
  }

  get gatewayId(): string | null { return this.gatewayConnectionId; }
  private framesTotal = 0;
  private shownTotal = 0;
  private jpegBytesTotal = 0;
  private frameCanvasRenders = 0;
  private cursorCanvasRenders = 0;

  /** Count committed Canvas children updates, not GPU draws or live native Recorders.
   * Keep scalar counters even with debug off, so toggling debug cannot reset a connection.
   */
  canvasRendered(canvas: "frame" | "cursor"): void {
    if (canvas === "frame") this.frameCanvasRenders++;
    else this.cursorCanvasRenders++;
  }

  private received: { at: number; bytes: number }[] = [];
  private receivedFrames: number[] = [];
  private shown: number[] = [];
  private jpegSizes: number[] = [];
  private latencies: number[] = [];
  private pending = new Map<number, Flight>();
  private clickTrackingOverflows = 0;
  private selected: { page: string | null; epoch: number; vp: number; state: Pages["state"] } | null = null;
  private pendingFrame: Frame | null = null;
  private lastShownSeq = -1;
  private gatewayDropped: number | null = null;
  private localDiscarded = 0;
  private ackWaitMs: number | null = null;
  private rttMs: number | null = null;
  private windowMode: Hello["window_mode"] | null = null;
  private maxInFlight: number | null = null;
  private maxInFlightLimit: number | null = null;
  private inFlight: number | null = null;
  private inFlightBytes: number | null = null;
  private byteBudget: number | null = null;
  private deliveryRateBps: number | null = null;
  private stopReason: Frame["stop_reason"] | null = null;
  private frameAgeMs: number | null = null;
  private creditWaitMs: number | null = null;
  private sendLockMs: number | null = null;
  private ackBaselineMs: number | null = null;
  private ackSmoothedMs: number | null = null;
  private queueDelayMs: number | null = null;
  private peaks = {
    inFlight: new SlidingPeak(),
    inFlightBytes: new SlidingPeak(),
    frameAgeMs: new SlidingPeak(),
    creditWaitMs: new SlidingPeak(),
    sendLockMs: new SlidingPeak(),
    queueDelayMs: new SlidingPeak(),
    inputLockWaitMs: new SlidingPeak(),
    inputDispatchMs: new SlidingPeak(),
    inputCdpMs: new SlidingPeak(),
  };
  private inputDoneSamples = 0;
  private inputLockWaitMs: number | null = null;
  private inputDispatchMs: number | null = null;
  private inputCdpMs: number | null = null;
  private inputLockWaitTotal = 0;
  private inputDispatchTotal = 0;
  private inputCdpTotal = 0;

  hello(hello: Hello): void {
    if (hello.connection_id !== undefined) this.gatewayConnectionId = hello.connection_id;
    this.windowMode = hello.window_mode;
    this.maxInFlight = hello.max_in_flight;
    this.maxInFlightLimit = hello.max_in_flight_limit;
  }

  select(pages: Pages): void {
    const before = this.selected;
    if (!before || before.page !== pages.current || before.epoch !== pages.epoch || before.vp !== pages.vp || before.state !== pages.state) {
      for (const id of this.pending.keys()) this.onClick?.({ id, status: "invalidated", reason: "selection" });
      this.pending.clear();
      // A new page/viewport invalidates unfinished click samples, including evicted flights offline.
      this.pendingFrame = null;
      this.lastShownSeq = -1;
      this.onClick?.({ status: "selection", page: pages.current, epoch: pages.epoch, vp: pages.vp, state: pages.state });
    }
    this.selected = { page: pages.current, epoch: pages.epoch, vp: pages.vp, state: pages.state };
  }

  receivedBinary(bytes: number, now: number): void {
    this.received.push({ at: now, bytes });
    this.intervalBinaryBytes += bytes;
    this.prune(now);
  }

  receivedFrame(frame: Frame, jpegBytes: number, now: number): void {
    this.framesTotal++;
    this.intervalFrames++;
    this.intervalJpegBytes += jpegBytes;
    this.intervalFirstSeq ??= frame.seq;
    this.intervalLastSeq = frame.seq;
    if (this.lastArrivalAt !== null && now >= this.lastArrivalAt) this.intervalArrivals.push(now - this.lastArrivalAt);
    this.lastArrivalAt = now;
    if (frame.connection_id !== undefined) this.gatewayConnectionId = frame.connection_id;
    if (typeof frame.ack_wait_ms === "number") this.intervalFrameHeaderAckWait.push(frame.ack_wait_ms);
    this.jpegBytesTotal += jpegBytes;
    this.receivedFrames.push(now);
    this.prune(now);
    this.jpegSizes.push(jpegBytes);
    if (this.jpegSizes.length > 60) this.jpegSizes.shift();
    if (frame.dropped_frames !== undefined) this.gatewayDropped = Math.max(this.gatewayDropped ?? 0, frame.dropped_frames);
    if (frame.ack_wait_ms !== undefined) this.ackWaitMs = frame.ack_wait_ms;
    this.maxInFlight = frame.max_in_flight;
    this.inFlight = frame.in_flight;
    this.inFlightBytes = frame.in_flight_bytes;
    this.byteBudget = frame.byte_budget;
    this.deliveryRateBps = frame.delivery_rate_bps;
    this.stopReason = frame.stop_reason;
    this.frameAgeMs = frame.frame_age_ms;
    this.creditWaitMs = frame.credit_wait_ms;
    this.sendLockMs = frame.send_lock_ms;
    this.ackBaselineMs = frame.ack_baseline_ms;
    this.ackSmoothedMs = frame.ack_smoothed_ms;
    this.queueDelayMs = frame.queue_delay_ms;
    this.peaks.inFlight.add(frame.in_flight, now);
    this.peaks.inFlightBytes.add(frame.in_flight_bytes, now);
    this.peaks.frameAgeMs.add(frame.frame_age_ms, now);
    this.peaks.creditWaitMs.add(frame.credit_wait_ms, now);
    this.peaks.sendLockMs.add(frame.send_lock_ms, now);
    this.peaks.queueDelayMs.add(frame.queue_delay_ms, now);
  }

  /** Track the one delivered image candidate awaiting a display decision. */
  offered(frame: Frame): void { this.pendingFrame = frame; }

  /** Called exactly once per skipped frame, independently of gateway overwrites. */
  discarded(seq: number): void {
    this.localDiscarded++;
    if (this.pendingFrame?.seq === seq) this.pendingFrame = null;
  }

  displayed(frame: Frame, now: number): void {
    const selected = this.selected;
    if (this.pendingFrame?.seq !== frame.seq || frame.seq <= this.lastShownSeq || !selected ||
      selected.page !== frame.page || selected.epoch !== frame.epoch || selected.vp !== frame.vp) return;
    this.pendingFrame = null;
    this.lastShownSeq = frame.seq;
    this.shownTotal++;
    this.intervalShown++;
    this.shown.push(now);
    this.prune(now);
    if (frame.applied_input_id !== undefined) this.onClick?.({
      status: "displayed", appliedInputId: frame.applied_input_id, seq: frame.seq, atMonoMs: now,
      page: frame.page, epoch: frame.epoch, vp: frame.vp,
    });
    if (frame.applied_input_id === undefined) return;
    for (const [id, flight] of this.pending) {
      if (id > frame.applied_input_id) continue;
      if (flight.done) this.complete(id, flight, now);
      else flight.firstShownAt ??= now; // A frame can commit before its input_done text reply arrives.
    }
  }

  sent(id: number, input: Input, now: number): void {
    // Held gestures (down/up and intermediate moves) are not direct clicks.
    if (input.t !== "click") return;
    this.onClick?.({ status: "started", id, atMonoMs: now,
      page: this.selected?.page ?? null, epoch: this.selected?.epoch ?? null, vp: this.selected?.vp ?? null });
    // Retain only a bounded set for online latency; the event trace preserves every flight.
    if (this.pending.size >= MAX_PENDING_CLICKS) {
      const oldest = this.pending.keys().next().value!;
      this.pending.delete(oldest);
      this.clickTrackingOverflows++;
      this.onClick?.({ status: "overflow", id: oldest });
    }
    this.pending.set(id, { startedAt: now, done: false });
  }

  reply(reply: Reply, now = performance.now()): void {
    if (reply.t === "reject") {
      if (reply.id !== null) {
        this.onClick?.({ id: reply.id, status: "reject", atMonoMs: now, reason: reply.why });
        if (this.pending.delete(reply.id))
          this.onClick?.({ id: reply.id, status: "rejected", reason: reply.why });
      }
      return;
    }
    if (reply.t === "input_pending") {
      this.onClick?.({ status: "input_pending", id: reply.id, atMonoMs: now });
      return;
    }
    if (reply.t !== "input_done") return;
    this.inputDoneSamples++;
    this.inputLockWaitMs = reply.input_lock_wait_ms;
    this.inputDispatchMs = reply.input_dispatch_ms;
    this.inputCdpMs = reply.input_cdp_ms;
    this.peaks.inputLockWaitMs.add(reply.input_lock_wait_ms, now);
    this.peaks.inputDispatchMs.add(reply.input_dispatch_ms, now);
    this.peaks.inputCdpMs.add(reply.input_cdp_ms, now);
    this.inputLockWaitTotal += reply.input_lock_wait_ms;
    this.inputDispatchTotal += reply.input_dispatch_ms;
    this.inputCdpTotal += reply.input_cdp_ms;
    this.onClick?.({ status: "input_done", id: reply.id, atMonoMs: now,
      inputLockWaitMs: reply.input_lock_wait_ms, inputDispatchMs: reply.input_dispatch_ms, inputCdpMs: reply.input_cdp_ms });
    const flight = this.pending.get(reply.id);
    if (!flight) return;
    flight.done = true;
    if (flight.firstShownAt !== undefined) this.complete(reply.id, flight, flight.firstShownAt);
  }

  pong(rttMs: number): void {
    this.rttMs = rttMs;
    if (Number.isFinite(rttMs) && rttMs >= 0) this.intervalRtt.push(rttMs);
  }
  /** Cutoff of online-retained clicks only; evicted flights remain reconstructable from the raw trace. */
  close(): { pendingCount: number; pendingIds: number[]; clickTrackingOverflows: number } {
    const pendingIds = [...this.pending.keys()];
    this.pending.clear();
    this.pendingFrame = null;
    return { pendingCount: pendingIds.length, pendingIds, clickTrackingOverflows: this.clickTrackingOverflows };
  }

  /** Disjoint connection intervals; delivery counts include binary envelopes, never inferred throughput. */
  takeInterval(now: number, wallNow = Date.now()): StreamInterval {
    const interval: StreamInterval = {
      connectionId: this.connectionId, gatewayConnectionId: this.gatewayConnectionId,
      startMonoMs: this.intervalStartMonoMs, endMonoMs: now,
      startWallMs: this.intervalStartWallMs, endWallMs: wallNow,
      firstSeq: this.intervalFirstSeq, lastSeq: this.intervalLastSeq,
      receivedFrames: this.intervalFrames, shownFrames: this.intervalShown,
      binaryBytes: this.intervalBinaryBytes, jpegBytes: this.intervalJpegBytes,
      rttMs: quantiles(this.intervalRtt), frameHeaderAckWaitMs: quantiles(this.intervalFrameHeaderAckWait),
      arrivalIntervalMs: quantiles(this.intervalArrivals),
    };
    this.intervalStartMonoMs = now;
    this.intervalStartWallMs = wallNow;
    this.intervalFrames = this.intervalShown = this.intervalBinaryBytes = this.intervalJpegBytes = 0;
    this.intervalFirstSeq = this.intervalLastSeq = null;
    this.intervalRtt = [];
    this.intervalFrameHeaderAckWait = [];
    this.intervalArrivals = [];
    return interval;
  }

  snapshot(now: number): StreamMeasurements {
    this.prune(now);
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return {
      gatewayConnectionId: this.gatewayConnectionId,
      connectionId: this.connectionId,
      framesTotal: this.framesTotal,
      shownTotal: this.shownTotal,
      jpegBytesTotal: this.jpegBytesTotal,
      frameCanvasRenders: this.frameCanvasRenders,
      cursorCanvasRenders: this.cursorCanvasRenders,
      receiveFps: this.receivedFrames.length / 5,
      displayFps: this.shown.length / 5,
      binaryKbps: this.received.reduce((total, item) => total + item.bytes, 0) * 8 / 5000,
      jpegMeanKiB: this.jpegSizes.length ? this.jpegSizes.reduce((sum, size) => sum + size, 0) / this.jpegSizes.length / 1024 : null,
      jpegMaxKiB: this.jpegSizes.length ? Math.max(...this.jpegSizes) / 1024 : null,
      gatewayDropped: this.gatewayDropped,
      localDiscarded: this.localDiscarded,
      ackWaitMs: this.ackWaitMs,
      windowMode: this.windowMode,
      maxInFlight: this.maxInFlight,
      maxInFlightLimit: this.maxInFlightLimit,
      inFlight: this.inFlight,
      inFlightBytes: this.inFlightBytes,
      byteBudget: this.byteBudget,
      deliveryRateBps: this.deliveryRateBps,
      stopReason: this.stopReason,
      frameAgeMs: this.frameAgeMs,
      creditWaitMs: this.creditWaitMs,
      sendLockMs: this.sendLockMs,
      ackBaselineMs: this.ackBaselineMs,
      ackSmoothedMs: this.ackSmoothedMs,
      queueDelayMs: this.queueDelayMs,
      inFlightPeak: this.peaks.inFlight.at(now),
      inFlightBytesPeak: this.peaks.inFlightBytes.at(now),
      frameAgePeakMs: this.peaks.frameAgeMs.at(now),
      creditWaitPeakMs: this.peaks.creditWaitMs.at(now),
      sendLockPeakMs: this.peaks.sendLockMs.at(now),
      queueDelayPeakMs: this.peaks.queueDelayMs.at(now),
      rttMs: this.rttMs,
      inputMedianMs: sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
      inputP90Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1] : null,
      inputSamples: sorted.length,
      pendingClicks: this.pending.size,
      clickTrackingOverflows: this.clickTrackingOverflows,
      inputDoneSamples: this.inputDoneSamples,
      inputLockWaitMs: this.inputLockWaitMs,
      inputDispatchMs: this.inputDispatchMs,
      inputCdpMs: this.inputCdpMs,
      inputLockWaitMeanMs: this.inputDoneSamples ? this.inputLockWaitTotal / this.inputDoneSamples : null,
      inputDispatchMeanMs: this.inputDoneSamples ? this.inputDispatchTotal / this.inputDoneSamples : null,
      inputCdpMeanMs: this.inputDoneSamples ? this.inputCdpTotal / this.inputDoneSamples : null,
      inputLockWaitPeakMs: this.peaks.inputLockWaitMs.at(now),
      inputDispatchPeakMs: this.peaks.inputDispatchMs.at(now),
      inputCdpPeakMs: this.peaks.inputCdpMs.at(now),
    };
  }

  private complete(id: number, flight: Flight, shownAt: number): void {
    this.pending.delete(id);
    const latency = shownAt - flight.startedAt;
    if (latency < 0) {
      this.onClick?.({ id, status: "invalidated", reason: "time-order" });
      return;
    }
    this.latencies.push(latency);
    this.onClick?.({ id, status: "completed", latencyMs: latency });
    if (this.latencies.length > 20) this.latencies.shift();
  }

  private prune(now: number): void {
    const cutoff = now - 5000;
    while (this.received.length && this.received[0].at <= cutoff) this.received.shift();
    while (this.receivedFrames.length && this.receivedFrames[0] <= cutoff) this.receivedFrames.shift();
    while (this.shown.length && this.shown[0] <= cutoff) this.shown.shift();
  }
}
