import type { BrowserTask } from '../../gateway/api.ts';
import type { Pages } from '../../browser/protocol.ts';
import { unhandled } from './strict.ts';

export type BrowserStreamFixtureOptions = {
  jpeg?: Uint8Array;
};
type Wire = Record<string, unknown>;

/** A socket boundary peer, shared by runtime stories and L1/L2. No product owner is mocked.
 * Explicit hold/confirm/reject methods model replies that are difficult to reach on demand. */
export class FakeBrowserStream {
  static OPEN = 1;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  readonly received: Wire[] = [];
  readonly inputs: Wire[] = [];
  readonly pages: Pages;
  readonly url: string;
  holdInputs = false;
  private seq = 0;
  private listeners = new Set<() => void>();
  private readonly options: BrowserStreamFixtureOptions;
  private version = 0;
  constructor(url: string, task: BrowserTask, options: BrowserStreamFixtureOptions = {}) {
    this.url = url; this.options = options;
    this.pages = { t: 'pages', current: task.current, pages: task.pages, epoch: task.epoch, vp: 1, state: task.state,
      environment_id: task.environment_id, environment_name: task.environment_name, capacity: task.capacity,
      capacity_rejection: null, css: [800, 600], dpr: 1 };
  }
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  getSnapshot = () => this.version;
  private changed() { this.version++; for (const notify of this.listeners) notify(); }
  open() {
    if (this.readyState !== 0) return;
    const params = new URL(this.url).searchParams;
    if (params.has('transport') || params.has('input_mode') || !['0', '1'].includes(params.get('video_player') ?? '0')) { this.close(4400); return; }
    this.readyState = 1; this.onopen?.();
    this.emit({ t: 'hello', protocol: 3, connection_id: 'fake-browser', ping_supported: false,
      window_mode: 'adaptive', max_in_flight: 2, max_in_flight_limit: 32, transport: 'jpeg',
      video_support: { available: false, reason: 'environment-unsupported' } });
    this.emit(this.pages); this.frame();
  }
  emit(message: object | ArrayBuffer) {
    if (this.readyState === 1) this.onmessage?.({ data: message instanceof ArrayBuffer ? message : JSON.stringify(message) });
  }
  send(raw: string) {
    if (this.readyState !== 1) throw new Error('fake-browser-socket-closed');
    const message = JSON.parse(raw) as Wire;
    this.received.push(message);
    if (message.t === 'ack') return;
    if (message.t === 'ping') { queueMicrotask(() => this.emit({ t: 'pong', id: message.id })); return; }
    if (message.t === 'switch_page' || message.t === 'new_page') {
      const why = message.t === 'switch_page'
        ? typeof message.target === 'string' && message.target.length > 0 ? 'browser-operation-failed' : 'invalid-target'
        : typeof message.epoch === 'number' && Number.isInteger(message.epoch) && message.epoch >= 0 && message.epoch <= 2 ** 53
          ? 'browser-operation-failed' : 'invalid-epoch';
      queueMicrotask(() => this.reject(message.id as number, why)); return;
    }
    if (!['pointer', 'touch', 'wheel', 'key', 'text', 'navigate', 'reload', 'back', 'forward'].includes(String(message.t)))
      return unhandled('WS', String(message.t), '假网关画面消息未实现');
    if (['pointer', 'touch', 'wheel', 'key'].includes(String(message.t))
      && (typeof message.ts !== 'number' || !Number.isFinite(message.ts))) {
      queueMicrotask(() => this.reject(message.id as number, 'invalid-input')); return;
    }
    this.inputs.push(message);
    if (!this.holdInputs) queueMicrotask(() => { this.done(message.id as number); this.frame(); });
    this.changed();
  }
  done(id: number, outcome: 'sent' | 'unknown' = 'sent') {
    this.emit({ t: 'input_done', id, outcome, input_lock_wait_ms: 0, input_dispatch_ms: 0, input_cdp_ms: 0 });
  }
  reject(id: number, why: string) { this.emit({ t: 'reject', id, why }); }
  frame() {
    if (!this.options.jpeg) return;
    const header = new TextEncoder().encode(JSON.stringify({ t: 'frame', connection_id: 'fake-browser', seq: ++this.seq,
      page: this.pages.current, epoch: this.pages.epoch, vp: this.pages.vp, css: this.pages.css, dpr: 1, scroll: [0, 0], pageScale: 1, offsetTop: 0,
      max_in_flight: 2, in_flight: 1, in_flight_bytes: this.options.jpeg.length, byte_budget: 1048576, stop_reason: 'none',
      frame_age_ms: null, credit_wait_ms: 0, send_lock_ms: null, ack_baseline_ms: null, ack_smoothed_ms: null, queue_delay_ms: null, delivery_rate_bps: null }));
    const wire = new Uint8Array(4 + header.length + this.options.jpeg.length);
    new DataView(wire.buffer).setUint32(0, header.length, false); wire.set(header, 4); wire.set(this.options.jpeg, header.length + 4);
    this.emit(wire.buffer);
  }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
}

/** Own the socket boundary for this isolated scene; unexpected origins enter the strict ledger. */
export function installFakeBrowserStreams(origin: string, task: BrowserTask, options: BrowserStreamFixtureOptions = {},
  connected?: (socket: FakeBrowserStream) => void): () => void {
  const Native = globalThis.WebSocket, sockets = new Set<FakeBrowserStream>();
  const target = new URL(origin); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  class Socket extends FakeBrowserStream {
    constructor(url: string) {
      if (new URL(url).origin !== target.origin) return unhandled('WS', new URL(url).pathname, '没有注册此服务器的画面通道');
      if (!new URL(url).pathname.endsWith(`/browser-tasks/${task.id}/stream`)) return unhandled('WS', new URL(url).pathname);
      super(url, task, options); sockets.add(this); connected?.(this);
      queueMicrotask(() => this.open());
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  return () => { for (const socket of sockets) socket.close(); globalThis.WebSocket = Native; };
}
