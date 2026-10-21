import type { GatewayApi } from "../gateway/api.ts";
import { decodeFrameEnvelope, decodeHello, decodeInputDone, inputFrame, jpegBytes, type FrameEnvelope, type FramePacket, type Input, type Pages, type Reply } from "./protocol.ts";
import { StreamMeter } from "./measurements.ts";

export type StreamState = "connecting" | "open" | "closed";
type Events = {
  state(state: StreamState): void;
  frame(packet: FramePacket): void;
  pages(pages: Pages): void;
  reply(reply: Reply): void;
  ended(reason: string | null): void;
  error(message: string): void;
};

/** One visible lease page. One delivered image stays active until commit or invalidation,
 * while a single raw pending slot coalesces arrivals. Every seq is ACKed once:
 * false on pending replacement/invalidation, true only after UI commit. No retry here:
 * screen focus or explicit reconnect opens a fresh socket; inputs are never replayed.
 */
export class BrowserStream {
  private socket!: WebSocket;
  private pages: Pages | null = null;
  private displayed: FramePacket["frame"] | null = null;
  private pending: FrameEnvelope | null = null;
  private active: FramePacket["frame"] | null = null;
  private frameHandle: number | null = null;
  private lastSeenSeq = -1;
  private nextId = 1;
  private closed = false;
  private awaitingPage: string | null = null;
  private awaitingPageId: number | null = null;
  readonly control: boolean;
  private events: Events;
  readonly measurements: StreamMeter;
  private stopPing: (() => void) | null = null;
  private stopMetrics: (() => void) | null = null;
  private nextPingId = 1;
  private pingSent = new Map<number, number>();
  private readonly leaseId: string;
  private readonly api: GatewayApi;
  private readonly stopForApi = () => this.close();

  constructor(api: GatewayApi, leaseId: string, control: boolean, events: Events) {
    this.control = control;
    this.api = api;
    this.leaseId = leaseId;
    this.events = events;
    this.measurements = new StreamMeter((outcome) => {
      console.log("[stream-click] " + JSON.stringify({
        lease: leaseId, connectionId: this.measurements.connectionId,
        gatewayConnectionId: this.measurements.gatewayId, ...outcome,
      }));
    });
    this.events.state("connecting");
    if (api.signal.aborted) {
      this.closed = true;
      this.events.state("closed");
      return;
    }
    // DOM typings omit React Native 0.86's native Authorization-header option.
    const NativeSocket = WebSocket as unknown as {
      new(url: string, protocols: string[], options: { headers: Record<string, string> }): WebSocket;
    };
    this.socket = new NativeSocket(api.browserStreamUrl(leaseId, control ? "control" : "view"), [], { headers: api.headers() });
    api.signal.addEventListener("abort", this.stopForApi, { once: true });
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => {
      if (this.closed) return;
      const timer = setInterval(() => this.logInterval(), 5000);
      this.stopMetrics = () => clearInterval(timer);
      console.log("[stream-connection] " + JSON.stringify({
        lease: leaseId, connectionId: this.measurements.connectionId,
        gatewayConnectionId: this.measurements.gatewayId,
        startMonoMs: this.measurements.startMonoMs,
        startWallMs: this.measurements.startWallMs, phase: "start",
      }));
      this.events.state("open");
    };
    this.socket.onmessage = (event) => {
      if (this.closed) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          const now = performance.now();
          this.measurements.receivedBinary(event.data.byteLength, now);
          const envelope = decodeFrameEnvelope(event.data);
          const { frame } = envelope;
          if (frame.connection_id && this.measurements.gatewayId && frame.connection_id !== this.measurements.gatewayId)
            throw new Error("frame-connection-id-mismatch");
          this.measurements.receivedFrame(frame, event.data.byteLength - envelope.jpegOffset, now);
          if (frame.seq <= this.lastSeenSeq) return;
          this.lastSeenSeq = frame.seq;
          if (this.accepts(frame)) {
            if (this.pending) this.skip(this.pending.frame.seq);
            this.pending = envelope;
            this.schedulePending();
          } else {
            this.measurements.discarded(frame.seq);
            this.ack(frame.seq, false);
          }
          return;
        }
        const message = JSON.parse(String(event.data));
        if (message.t === "hello") {
          const hello = decodeHello(message);
          if (hello.connection_id && this.measurements.gatewayId && hello.connection_id !== this.measurements.gatewayId)
            throw new Error("hello-connection-id-mismatch");
          this.measurements.hello(hello);
          if (hello.ping_supported && !this.stopPing) {
            this.ping();
            const timer = setInterval(() => this.ping(), 2000);
            this.stopPing = () => { clearInterval(timer); this.pingSent.clear(); };
          }
        }
        if (message.t === "pages") {
          if (this.awaitingPage === message.current || this.awaitingPage === "" && message.current !== this.pages?.current) {
            this.awaitingPage = null;
            this.awaitingPageId = null;
          }
          this.pages = message;
          if (this.pending && !this.accepts(this.pending.frame) || this.active && !this.accepts(this.active)) this.skipFrames();
          this.measurements.select(message);
          if (!this.displayed || this.displayed.page !== message.current || this.displayed.epoch !== message.epoch || this.displayed.vp !== message.vp || message.state !== "human") this.displayed = null;
          this.events.pages(message);
        } else if (message.t === "ended") {
          this.skipFrames();
          this.displayed = null;
          console.warn("[browser-stream] ended", { lease: this.leaseId, reason: message.reason });
          this.events.ended(message.reason ?? null);
          this.close();
        } else if (message.t === "pong") {
          const startedAt = this.pingSent.get(message.id);
          if (startedAt !== undefined) {
            this.measurements.pong(performance.now() - startedAt);
            this.pingSent.delete(message.id);
          }
        } else if (message.t === "reject" || message.t === "input_done" || message.t === "input_pending" || message.t === "page_done") {
          if (message.t === "reject" && message.id === this.awaitingPageId) {
            this.awaitingPage = null;
            this.awaitingPageId = null;
          }
          const reply = message.t === "input_done" ? decodeInputDone(message) : message as Reply;
          this.measurements.reply(reply, performance.now());
          this.events.reply(reply);
        }
      } catch (error) {
        console.warn("[browser-stream] invalid message", { lease: this.leaseId, error: error instanceof Error ? error.name : typeof error, size: event.data instanceof ArrayBuffer ? event.data.byteLength : String(event.data).length });
        this.events.error("画面数据无法读取，请重新打开浏览器连接");
      }
    };
    this.socket.onerror = () => {
      if (!this.closed) {
        this.events.error("画面连接失败");
        void api.checkUnauthorized();
      }
    };
    this.socket.onclose = (event) => {
      if (this.closed) return;
      this.closed = true;
      this.api.signal.removeEventListener("abort", this.stopForApi);
      this.cancelFrames();
      this.stopPing?.();
      this.finishMeasurements();
      this.displayed = null;
      this.events.state("closed");
      if (event.code === 4401) api.handleRevoked();
      else void api.checkUnauthorized();
    };
  }

  get isOpen(): boolean { return !this.closed && this.socket.readyState === WebSocket.OPEN; }
  /** Accept only the current image candidate after its React/Skia view has committed. */
  displayedFrame(frame: FramePacket["frame"]): boolean {
    if (this.closed || this.active?.seq !== frame.seq) return false;
    this.active = null;
    if (!this.accepts(frame)) {
      this.skip(frame.seq);
      this.schedulePending();
      return false;
    }
    this.displayed = frame;
    this.measurements.displayed(frame, performance.now());
    this.ack(frame.seq, true);
    this.schedulePending();
    return true;
  }
  /** The current image could not be created; release its slot without promoting input. */
  discardFrame(seq: number): void {
    if (this.active?.seq !== seq) return;
    this.active = null;
    this.skip(seq);
    this.schedulePending();
  }

  private accepts(frame: FramePacket["frame"]): boolean {
    return this.pages !== null && this.awaitingPage === null && frame.page === this.pages.current
      && frame.epoch === this.pages.epoch && frame.vp === this.pages.vp;
  }
  private schedulePending(): void {
    if (this.pending && !this.active && this.frameHandle === null) {
      this.frameHandle = requestAnimationFrame(() => this.deliverFrame());
    }
  }
  private deliverFrame(): void {
    this.frameHandle = null;
    const envelope = this.pending;
    this.pending = null;
    if (this.closed || !envelope) return;
    if (!this.accepts(envelope.frame)) { this.skip(envelope.frame.seq); return; }
    this.active = envelope.frame;
    this.measurements.offered(envelope.frame);
    try {
      this.events.frame({ frame: envelope.frame, jpeg: jpegBytes(envelope) });
    } catch (error) {
      this.discardFrame(envelope.frame.seq);
      console.warn("[browser-stream] frame delivery failed", { lease: this.leaseId, seq: envelope.frame.seq, error });
      this.events.error("画面无法显示，请重新打开浏览器连接");
    }
  }
  private skipFrames(): void {
    if (this.pending) { this.skip(this.pending.frame.seq); this.pending = null; }
    if (this.active) { this.skip(this.active.seq); this.active = null; }
  }
  private skip(seq: number): void { this.measurements.discarded(seq); this.ack(seq, false); }
  private cancelFrames(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.pending = null;
    this.active = null;
  }

  private logInterval(now = performance.now()): void {
    console.log("[stream-interval] " + JSON.stringify({
      lease: this.leaseId, ...this.measurements.takeInterval(now),
    }));
  }

  /** Flush the final interval and cutoff while pending clicks still exist. */
  private finishMeasurements(): void {
    this.stopMetrics?.();
    this.stopMetrics = null;
    const now = performance.now();
    this.logInterval(now);
    const stats = this.measurements.snapshot(now);
    const pending = this.measurements.close();
    console.log("[stream-cutoff] " + JSON.stringify({
      lease: this.leaseId, connectionId: this.measurements.connectionId,
      gatewayConnectionId: this.measurements.gatewayId,
      startMonoMs: this.measurements.startMonoMs, startWallMs: this.measurements.startWallMs,
      endMonoMs: now, endWallMs: Date.now(), ...pending,
      framesTotal: stats.framesTotal, shownTotal: stats.shownTotal, jpegBytesTotal: stats.jpegBytesTotal,
    }));
  }
  private ping(): void {
    const id = this.nextPingId++;
    const startedAt = performance.now();
    if (this.sendRaw({ t: "ping", id })) {
      // Keep slow replies across probe intervals; bound sockets whose peer never answers.
      this.pingSent.set(id, startedAt);
      if (this.pingSent.size > 256) this.pingSent.delete(this.pingSent.keys().next().value!);
    }
  }
  private ack(seq: number, displayed: boolean): void { this.sendRaw({ t: "ack", seq, displayed }); }
  private sendRaw(message: object): boolean {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** Input is gated by the displayed frame, the selected page and the human control epoch. */
  input(input: Input): number | null {
    const frame = inputFrame(this.displayed, this.pages, this.control);
    if (!frame || this.awaitingPage !== null) return null;
    let payload: Input = input;
    if ("x" in input) {
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.y < 0 || input.x > frame.css[0] || input.y > frame.css[1]) return null;
      payload = { ...input, x: Math.min(input.x, frame.css[0] - 0.001), y: Math.min(input.y, frame.css[1] - 0.001) };
    }
    const id = this.nextId++;
    if (!this.sendRaw({ ...payload, id, epoch: frame.epoch, vp: frame.vp, frame: frame.seq })) return null;
    this.measurements.sent(id, input, performance.now());
    return id;
  }

  switchPage(target: string): number | null {
    if (this.awaitingPage !== null || target === this.pages?.current || !this.pages?.pages.some((page) => page.id === target)) return null;
    const id = this.nextId++;
    if (!this.sendRaw({ t: "switch_page", id, target })) return null;
    this.awaitingPage = target;
    this.awaitingPageId = id;
    this.skipFrames();
    return id;
  }

  newPage(): number | null {
    if (!this.control || this.pages?.state !== "human" || this.awaitingPage !== null) return null;
    const id = this.nextId++;
    if (!this.sendRaw({ t: "new_page", id, epoch: this.pages.epoch })) return null;
    this.awaitingPage = "";
    this.awaitingPageId = id;
    this.skipFrames();
    return id;
  }

  close(): void {
    if (this.closed) return;
    this.api.signal.removeEventListener("abort", this.stopForApi);
    this.skipFrames();
    this.closed = true;
    this.cancelFrames();
    this.stopPing?.();
    this.finishMeasurements();
    this.displayed = null;
    this.socket.close();
    this.events.state("closed");
  }
}
