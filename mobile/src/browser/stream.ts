import type { GatewayApi } from "../gateway/api.ts";
import { decodeFrameEnvelope, decodeHello, decodeInputDone, inputFrame, jpegBytes, type FrameEnvelope, type FramePacket, type Hello, type Input, type Pages, type Reply } from "./protocol.ts";
import { StreamMeter } from "./measurements.ts";
import type { BrowserTransport, VideoMessage } from "../lib/browser-video.ts";

type Sample = { id: number; input: Input; epoch: number; vp: number; page: string; frame?: number };

export type StreamState = "connecting" | "open" | "closed";
type Events = {
  state(state: StreamState, closeCode?: number): void;
  frame(packet: FramePacket): void;
  pages(pages: Pages): void;
  reply(reply: Reply): void;
  ended(reason: string | null): void;
  error(message: string): void;
  hello?(hello: Hello): void;
  video?(message: VideoMessage): void;
  controlReject?(id: string): void;
  sent?(id: number, at: number): void;
  inputResumed?(): void;
};

/** One visible lease page. One delivered image stays active until commit or invalidation,
 * while a single raw pending slot coalesces arrivals. Every seq is ACKed once:
 * false on pending replacement/invalidation, true only after UI commit. BrowserRuntime
 * owns replacement sockets; this connection never retries or replays inputs.
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
  private transport: BrowserTransport = "jpeg";
  private nextControlId = 1;
  private samples: Sample[] = [];
  private inputFrameHandle: number | null = null;
  private buttons: number | null = null;
  private touchIds: string | null = null;

  constructor(api: GatewayApi, leaseId: string, control: boolean, events: Events, videoAvailable = false) {
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
    const url = new URL(api.browserStreamUrl(leaseId, control ? "control" : "view"));
    url.searchParams.set("video_player", videoAvailable ? "1" : "0");
    this.socket = new NativeSocket(url.toString(), [], { headers: api.headers() });
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
          this.transport = hello.transport;
          this.events.hello?.(hello);
          if (hello.ping_supported && !this.stopPing) {
            this.ping();
            const timer = setInterval(() => this.ping(), 2000);
            this.stopPing = () => { clearInterval(timer); this.pingSent.clear(); };
          }
        }
        if (message.t === "video" || message.t === "video_failed") {
          if (this.transport === "video") this.events.video?.(message as VideoMessage);
          return;
        }
        if (message.t === "reject" && typeof message.id === "string") {
          this.events.controlReject?.(message.id);
          return;
        }
        if (message.t === "pages") {
          if (this.awaitingPage === message.current || this.awaitingPage === "" && message.current !== this.pages?.current) {
            this.awaitingPage = null;
            this.awaitingPageId = null;
          }
          const previous = this.pages;
          if (previous && (previous.current !== message.current || previous.epoch !== message.epoch || previous.vp !== message.vp || message.state !== "human"))
            this.pauseInputs();
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
        } else if (message.t === "reject" || message.t === "input_done" || message.t === "page_done") {
          if (message.t === "reject" && message.id === this.awaitingPageId) {
            this.awaitingPage = null;
            this.awaitingPageId = null;
            this.events.inputResumed?.();
          }
          const reply = message.t === "input_done" ? decodeInputDone(message) : message as Reply;
          this.measurements.reply(reply, performance.now());
          this.events.reply(reply);
        }
      } catch (error) {
        console.warn("[browser-stream] invalid message", { lease: this.leaseId, error: error instanceof Error ? error.name : typeof error, size: event.data instanceof ArrayBuffer ? event.data.byteLength : String(event.data).length });
        this.events.error("画面数据无法读取，请重新打开浏览器连接");
        this.close(1002);
      }
    };
    this.socket.onerror = () => {
      if (!this.closed) {
        this.events.error("画面连接失败");
        // An error is terminal even if the platform delays its close callback.
        this.close(1006);
        void api.checkUnauthorized();
      }
    };
    this.socket.onclose = (event) => {
      // A native error can precede close; an explicit 4401 still revokes that session.
      if (event.code === 4401) api.handleRevoked();
      if (this.closed) return;
      this.closed = true;
      this.api.signal.removeEventListener("abort", this.stopForApi);
      this.cancelFrames();
      this.pauseInputs();
      this.stopPing?.();
      this.finishMeasurements();
      this.displayed = null;
      this.events.state("closed", event.code);
      if (event.code !== 4401) void api.checkUnauthorized();
    };
  }

  get isOpen(): boolean { return !this.closed && this.socket.readyState === WebSocket.OPEN; }
  /** Last allocated operation ID includes accepted samples still waiting for rAF. */
  get inputWatermark(): number { return this.nextId - 1; }
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
    return this.transport === "jpeg" && this.pages !== null && this.awaitingPage === null && frame.page === this.pages.current
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
  private inputCredential(videoPages?: Pages | null) {
    if (!this.isOpen || this.awaitingPage !== null) return null;
    if (this.transport === "jpeg") return inputFrame(this.displayed, this.pages, this.control);
    return this.control && this.pages?.state === "human" && videoPages?.current != null
      && videoPages.current === this.pages.current && videoPages.vp === this.pages.vp
      && videoPages.epoch === this.pages.epoch ? videoPages : null;
  }
  input(input: Input, videoPages?: Pages | null): number | null {
    const credential = this.inputCredential(videoPages);
    if (!credential || !this.pages?.current) return null;
    const point = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y)
      && x >= 0 && y >= 0 && x <= credential.css[0] && y <= credential.css[1];
    let payload: Input = { ...input, ts: input.ts ?? performance.now() };
    if ("x" in input) {
      if (!point(input.x, input.y)) return null;
      payload = { ...input, ts: payload.ts, x: Math.min(input.x, credential.css[0] - .001), y: Math.min(input.y, credential.css[1] - .001) };
    }
    if (input.t === "pointer" && (!Number.isInteger(input.buttons) || input.buttons < 0 || input.buttons > 31)) return null;
    if (input.t === "touch" && (input.touches.length > 10 || new Set(input.touches.map(touch => touch.id)).size !== input.touches.length
      || input.touches.some(touch => !Number.isInteger(touch.id) || touch.id < 0 || touch.id > 2147483647 || !point(touch.x, touch.y)))) return null;
    if (input.t === "touch") payload = { ...input, ts: payload.ts, touches: input.touches.map(touch => ({
      id: touch.id, x: Math.min(touch.x, credential.css[0] - .001), y: Math.min(touch.y, credential.css[1] - .001),
    })) };
    const id = this.nextId++;
    const sample: Sample = { id, input: payload, epoch: credential.epoch, vp: credential.vp,
      page: this.pages.current, ...(credential.t === "frame" ? { frame: credential.seq } : {}) };
    const ids = input.t === "touch" ? input.touches.map(touch => touch.id).sort((a, b) => a - b).join(",") : null;
    const boundary = input.t === "pointer" ? input.buttons !== this.buttons
      : input.t === "touch" ? ids !== this.touchIds : false;
    if (input.t === "pointer") this.buttons = input.buttons;
    if (input.t === "touch") this.touchIds = ids;
    if (boundary) {
      // This full state supersedes unsent motion, never another button/contact change.
      this.samples = this.samples.filter(entry => entry.input.t !== input.t);
      this.writeInput(sample);
    } else if (input.t === "pointer" || input.t === "touch" || input.t === "wheel") {
      if (input.t === "pointer" || input.t === "touch") {
        this.samples = this.samples.filter(entry => entry.input.t !== input.t);
        this.samples.push(sample);
      } else {
        const previous = this.samples.at(-1), a = previous?.input;
        if (previous && a?.t === "wheel" && payload.t === "wheel" && a.x === payload.x && a.y === payload.y
          && Math.sign(a.dx) === Math.sign(payload.dx) && Math.sign(a.dy) === Math.sign(payload.dy))
          this.samples[this.samples.length - 1] = { ...sample, input: { ...payload, dx: a.dx + payload.dx, dy: a.dy + payload.dy } };
        else this.samples.push(sample);
      }
      this.scheduleInput();
    } else this.writeInput(sample);
    return id;
  }
  private writeInput(entry: Sample) {
    if (!this.isOpen || this.awaitingPage !== null || this.pages?.state !== "human"
      || entry.page !== this.pages.current || entry.epoch !== this.pages.epoch || entry.vp !== this.pages.vp) return;
    const at = performance.now();
    if (this.sendRaw({ ...entry.input, id: entry.id, epoch: entry.epoch, vp: entry.vp, page: entry.page,
      ...(entry.frame !== undefined ? { frame: entry.frame } : {}), sent_ms: at })) {
      this.measurements.sent(entry.id, entry.input, at); this.events.sent?.(entry.id, at);
    }
  }
  private scheduleInput() {
    if (this.inputFrameHandle !== null || !this.samples.length) return;
    this.inputFrameHandle = requestAnimationFrame(() => {
      this.inputFrameHandle = null;
      const sample = this.samples.shift();
      if (sample) this.writeInput(sample);
      this.scheduleInput();
    });
  }
  pauseInputs() {
    if (this.inputFrameHandle !== null) cancelAnimationFrame(this.inputFrameHandle);
    this.inputFrameHandle = null; this.samples = []; this.buttons = null; this.touchIds = null;
  }

  retryVideo(): string | null {
    if (this.transport !== "video") return null;
    const id = `video-retry:${this.nextControlId++}`;
    return this.sendRaw({ t: "video_retry", id }) ? id : null;
  }

  switchPage(target: string): number | null {
    if (this.awaitingPage !== null || target === this.pages?.current || !this.pages?.pages.some((page) => page.id === target)) return null;
    const id = this.nextId++;
    if (!this.sendRaw({ t: "switch_page", id, target })) return null;
    this.pauseInputs();
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
    this.pauseInputs();
    this.awaitingPageId = id;
    this.skipFrames();
    return id;
  }

  close(closeCode = 1000): void {
    if (this.closed) return;
    this.api.signal.removeEventListener("abort", this.stopForApi);
    this.skipFrames();
    this.closed = true;
    this.pauseInputs();
    this.cancelFrames();
    this.stopPing?.();
    this.finishMeasurements();
    this.displayed = null;
    this.socket?.close();
    this.events.state("closed", closeCode);
  }
}
