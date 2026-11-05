import { Skia } from '@shopify/react-native-skia';
import type { TextInput } from 'react-native';
import { Vibration } from 'react-native';
import type { GatewayApi } from '../gateway/api.ts';
import { t } from '../lib/i18n.ts';
import { clampView, IDENTITY_VIEW, movePointer, pointerForViewport, type Point, type Size, toRemote, toRemoteClamped, type View, wheelAnchor, zoomPan } from '../takeover-lab/geometry.ts';
import { type Action, DEFAULT_OPTIONS, type TouchEvent, TouchModeRecognizer } from '../takeover-lab/gestures.ts';
import { COMMIT, InputBuffer, type InputOp } from '../takeover-lab/input-buffer.ts';
import { KEYS, type KeyName } from '../takeover-lab/keys.ts';
import { type MouseAction, MouseModeRecognizer, WheelControl } from '../takeover-lab/mouse-gestures.ts';
import { feedbackPoint } from './feedback.ts';
import type { FrameCandidate } from './frame-canvas.tsx';
import type { StreamDiagnostics } from './measurements.ts';
import { applyPages, collapseNotices, dismissNotice, EMPTY_PAGE_STATE, initialPageSelection, observePageSelection, rejectPageRestoration, resumePageSelection, type PageSelection, type PageState } from './pages.ts';
import { endedReason, rejectReason, type Frame, type Input, type Pages } from './protocol.ts';
import { BrowserStream } from './stream.ts';
import { browserVideoReducer, initialVideoState, videoInputReady, type VideoEvent, type VideoMessage, type VideoState } from '../lib/browser-video.ts';
import type { BrowserVideoConnection, RenderedVideoFrame, VideoPlayerEvents } from './video-player.tsx';
import { browserConnectionReducer, browserConnectionWakeAt, type BrowserConnectionEvent, type BrowserConnectionState } from '../lib/browser-connection.ts';

type RuntimeOptions = {
  createVideoPlayer?(events: VideoPlayerEvents): BrowserVideoConnection | null;
  isLeaseEnded?(): boolean;
  subscribeTask?(notify: () => void): () => void;
};

const VIDEO_JOIN_TIMEOUT_MS = 10_000;
const VIDEO_FIRST_FRAME_TIMEOUT_MS = 5_000;
const VIDEO_RECONNECT_TIMEOUT_MS = 15_000;

export type BrowserRuntimeSnapshot = {
  streamState: BrowserConnectionState['status']; pages: PageState; shown: FrameCandidate | null; inputReady: boolean;
  /** design.md 提醒规则：each notice text lives with the state it describes and leaves with it.
   * `error`: one-time results (rejected input / popup, invalid URL), cleared by the next accepted command or ×;
   * `streamError`: diagnostic transport detail; suppresses stale one-time errors until open.
   * Retry/manual connection notices are projected from streamState, not this text;
   * `endedReason`: the lease ended, permanent for this runtime. */
  ended: boolean; endedReason: string | null; error: string | null; streamError: string | null; decodeFailed: boolean; decodeFailures: number;
  mode: 'mouse' | 'touch'; view: View; container: Size; pointer: Point | null; feedback: Point | null;
  wheelOffset: number; pressed: { left: boolean; right: boolean }; keyboard: number;
  keyboardTarget: 'url' | 'remote' | null; typingNotice: 'pending' | 'discarded' | null;
  stats: StreamDiagnostics | null;
  video: VideoState; inputUnknown: boolean;
};

/** Continuous resource owner. Constructor has no side effects; attach() grants one visible
 * subscription. Page commands live outside this owner. Gesture recognizers and input buffers
 * retain their existing algorithms and never pass through React's render/event ordering. */
export class BrowserRuntime {
  private snapshot: BrowserRuntimeSnapshot = {
    streamState: 'connecting', pages: EMPTY_PAGE_STATE, shown: null, inputReady: false, ended: false, endedReason: null,
    error: null, streamError: null, decodeFailed: false, decodeFailures: 0, mode: 'mouse', view: IDENTITY_VIEW,
    container: { w: 0, h: 0 }, pointer: null, feedback: null, wheelOffset: 0,
    pressed: { left: false, right: false }, keyboard: 0, keyboardTarget: null, typingNotice: null, stats: null,
    video: initialVideoState, inputUnknown: false,
  };
  private listeners = new Set<() => void>();
  private client: BrowserStream | null = null;
  private selection: PageSelection;
  private restoreRequestId: number | null = null;
  private displayed: Frame | null = null;
  private lastTouch: Point | null = null;
  private mouse = new MouseModeRecognizer();
  private pointerButtons = 0;
  private touch = new TouchModeRecognizer();
  private wheel = new WheelControl();
  private buffer = new InputBuffer();
  private typingActive = false;
  private longPress: ReturnType<typeof setTimeout> | undefined;
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  private wheelTimer: ReturnType<typeof setInterval> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  input: TextInput | null = null;
  urlInput: TextInput | null = null;
  attachInput = (node: TextInput | null) => { this.input = node; };
  attachUrlInput = (node: TextInput | null) => { this.urlInput = node; };
  readonly api: GatewayApi;
  readonly id: string;
  readonly control: boolean;
  private controlAllowed: () => boolean;
  private options: RuntimeOptions;
  readonly videoPlayer: BrowserVideoConnection | null;
  private unknownInputWatermark = 0;
  private sentInputs = new Set<number>();
  private videoDeadline: ReturnType<typeof setTimeout> | undefined;
  private videoDeadlineStage: 'join' | 'frame' | 'reconnect' | null = null;
  private retryId: string | null = null;
  constructor(api: GatewayApi, id: string, control: boolean, page: string | undefined, controlAllowed: () => boolean, options: RuntimeOptions = {}) {
    this.api = api; this.id = id; this.control = control; this.controlAllowed = controlAllowed; this.options = options;
    this.selection = initialPageSelection(page, api.config.computerId);
    this.videoPlayer = options.createVideoPlayer?.({
      connected: () => this.videoEvent({ type: 'connected' }),
      subscribed: source => {
        if (this.snapshot.video.source !== source || this.videoDeadlineStage !== 'join') return;
        this.clearVideoDeadline(); this.videoDeadlineStage = 'frame';
        this.videoDeadline = setTimeout(() => this.failVideo('first-frame-timeout'), VIDEO_FIRST_FRAME_TIMEOUT_MS);
      },
      reconnecting: () => this.videoEvent({ type: 'reconnecting', origin: 'player' }),
      failed: () => this.failVideo('sfu-unreachable'),
      rendered: frame => this.videoDisplayed(frame),
    }) ?? null;
    if (!this.videoPlayer) this.snapshot = { ...this.snapshot, video: { ...initialVideoState, supportReason: 'player-unavailable' } };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(change: Partial<BrowserRuntimeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  private get human() { return this.control && this.snapshot.pages.snapshot?.state === 'human' && !this.snapshot.ended && this.controlAllowed(); }
  get stream() { return this.client; }
  setError = (error: string | null) => this.update({ error });
  dismissTypingNotice = () => this.update({ typingNotice: null });
  setStats = (stats: StreamDiagnostics | null) => this.update({ stats });
  retryVideo = () => {
    if (this.snapshot.video.phase !== 'failed') return;
    const id = this.client?.retryVideo();
    if (id) { this.retryId = id; this.videoEvent({ type: 'retry' }); }
  };
  private videoEvent(event: VideoEvent) {
    const previous = this.snapshot.video;
    const video = browserVideoReducer(previous, event, this.snapshot.pages.snapshot);
    if (video === previous) return;
    const ready = this.snapshot.streamState === 'open' && !!this.client?.isOpen && (video.transport === 'video'
      ? videoInputReady(video, this.snapshot.pages.snapshot) : video.phase === 'playing' && !!this.displayed);
    const resumed = ready && !this.snapshot.inputReady;
    this.update({ video, inputReady: ready });
    this.videoPlayer?.setContext(`${this.client?.measurements.connectionId ?? ''}:${video.generation}`);
    if (resumed && video.transport === 'video') this.reportPointer();
    if (event.type === 'reconnecting' && previous.phase !== 'reconnecting') {
      this.clearVideoDeadline(); this.videoDeadlineStage = 'reconnect';
      this.videoDeadline = setTimeout(() => this.failVideo('sfu-unreachable'), VIDEO_RECONNECT_TIMEOUT_MS);
    }
    if (event.type === 'ready' && !event.value.renew && previous.phase !== 'reconnecting'
      && video.generation !== previous.generation) {
      this.clearVideoDeadline(); this.videoDeadlineStage = 'join';
      this.videoDeadline = setTimeout(() => this.failVideo('join-timeout'), VIDEO_JOIN_TIMEOUT_MS);
    }
    if (event.type === 'frame' && (video.phase === 'playing' || previous.phase !== 'reconnecting')
      || video.phase === 'failed' || video.phase === 'ended' || video.transport === 'jpeg') {
      this.clearVideoDeadline();
    }
    if (video.phase === 'failed' || video.phase === 'ended' || video.transport === 'jpeg' && !video.source) this.videoPlayer?.stop();
    if (!ready && video.transport === 'video') this.client?.pauseInputs();
  }
  private clearVideoDeadline() {
    clearTimeout(this.videoDeadline); this.videoDeadline = undefined; this.videoDeadlineStage = null;
  }
  private failVideo(reason: NonNullable<VideoState['reason']>) {
    if (this.snapshot.video.transport !== 'video' || this.snapshot.video.phase === 'failed' || this.snapshot.video.phase === 'ended') return;
    this.videoEvent({ type: 'failed', reason }); this.clearFrame(); this.endTyping(); this.stopGestures();
  }
  private onVideo(message: VideoMessage) {
    if (message.t === 'video_failed') { this.retryId = null; this.failVideo(message.reason); }
    else if (message.state === 'reconnecting') this.videoEvent({ type: 'reconnecting', origin: 'gateway' });
    else {
      const previous = this.snapshot.video;
      this.videoEvent({ type: 'ready', value: message });
      if (this.snapshot.video.source === message && this.snapshot.video !== previous) {
        this.retryId = null; this.videoPlayer?.watch(message);
      }
    }
  }
  private videoDisplayed(frame: RenderedVideoFrame) {
    const video = this.snapshot.video, generation = video.generation;
    if (video.transport !== 'video' || video.phase === 'failed' || video.phase === 'ended'
      || frame.context !== `${this.client?.measurements.connectionId ?? ''}:${generation}` || !this.client?.isOpen) return;
    this.videoEvent({ type: 'frame', generation, width: frame.width, height: frame.height });
    if (this.snapshot.video.phase === 'playing') {
      if (this.snapshot.shown) this.update({ shown: null });
      const css = this.snapshot.pages.snapshot?.css;
      if (css) {
        const pointer = pointerForViewport(this.snapshot.pointer, css[0], css[1]);
        if (pointer !== this.snapshot.pointer) this.setPointer(pointer);
      }
    }
  }
  private markInputUnknown() {
    this.unknownInputWatermark = this.client?.inputWatermark ?? 0;
    this.update({ inputUnknown: true });
  }
  private get geometry(): Pick<Frame, 'css'> | null {
    return this.snapshot.video.picture ? this.snapshot.pages.snapshot : this.displayed;
  }
  keyboardShow = (height: number) => this.update({ keyboard: height });
  keyboardHide = () => {
    this.update({ keyboard: 0 });
    if (this.flushTyping()) this.endTyping(); else this.input?.blur();
    this.urlInput?.blur(); this.update({ keyboardTarget: null });
  };
  blurInputs = () => {
    this.flushTyping(); this.urlInput?.blur(); this.input?.blur(); this.update({ keyboardTarget: null });
  };
  editUrl = () => { this.flushTyping(); this.input?.blur(); this.update({ keyboardTarget: 'url' }); };
  endUrl = () => { this.urlInput?.blur(); this.update({ keyboardTarget: null }); };
  private clearTypingTimer() { clearTimeout(this.settleTimer); this.settleTimer = undefined; }
  endTyping = () => {
    this.typingActive = false;
    this.clearTypingTimer();
    if (this.buffer.reset()) this.update({ typingNotice: 'discarded' });
    this.input?.clear(); this.input?.blur();
    if (this.snapshot.keyboardTarget === 'remote') this.update({ keyboardTarget: null });
  };
  private sendOp = (op: InputOp): boolean => {
    if (!this.typingActive) return false;
    const accepted = this.send(op.kind === 'text' ? { t: 'text', text: op.text } : { t: 'key', ...KEYS[op.key] }) != null;
    if (!accepted) this.update({ typingNotice: this.buffer.hasPending ? 'pending' : 'discarded' });
    return accepted;
  };
  flushTyping = (submit = false) => {
    this.clearTypingTimer();
    if (!this.typingActive) return true;
    const sent = submit ? this.buffer.enter(this.sendOp) : this.buffer.flush(this.sendOp);
    if (this.buffer.needsClear) { this.buffer.needsClear = false; this.input?.clear(); }
    if (sent && this.snapshot.typingNotice === 'pending') this.update({ typingNotice: null });
    return sent;
  };
  focusInput = () => {
    if (!this.human || !this.snapshot.inputReady || !this.client?.isOpen) { this.endTyping(); return; }
    if (!this.typingActive) this.input?.clear();
    this.typingActive = true; this.update({ keyboardTarget: 'remote' });
  };
  blurInput = () => { this.flushTyping(); if (this.snapshot.keyboardTarget === 'remote') this.update({ keyboardTarget: null }); };
  typed = (text: string) => {
    if (!this.human || !this.typingActive) return;
    if (!this.buffer.change(text)) return this.clearTypingTimer();
    this.clearTypingTimer();
    if (COMMIT.mode === 'immediate') this.flushTyping();
    else this.settleTimer = setTimeout(this.flushTyping, COMMIT.settleMs);
  };
  backspace = () => { if (this.typingActive) this.buffer.backspace(this.sendOp); };
  sendKey = (key: KeyName) => { if (this.flushTyping()) this.sendOp({ kind: 'key', key }); };
  send = (message: Input) => this.human && this.snapshot.inputReady && this.snapshot.streamState === 'open'
    ? this.client?.input(message, this.snapshot.video.transport === 'video' ? this.snapshot.pages.snapshot : null) : null;
  switchPage = (id: string) => this.snapshot.streamState === 'open' ? this.client?.switchPage(id) : null;
  newPage = () => this.snapshot.streamState === 'open' ? this.client?.newPage() : null;
  dismissNotice = (id: string) => this.update({ pages: { ...this.snapshot.pages, ...dismissNotice(this.snapshot.pages, id) } });
  private reportPointer = (ts?: number, count?: number) => {
    const css = this.geometry?.css;
    if (!css) return;
    const pointer = pointerForViewport(this.snapshot.pointer, css[0], css[1]) ?? { x: css[0] / 2, y: css[1] / 2 };
    if (pointer !== this.snapshot.pointer) this.setPointer(pointer);
    this.send({ t: 'pointer', ...pointer, buttons: this.pointerButtons, ts, count });
  };
  private setPointerButtons(buttons: number, ts?: number, count?: number): boolean {
    if (buttons === this.pointerButtons) return false;
    this.pointerButtons = buttons;
    this.reportPointer(ts, count);
    return true;
  }
  private setView(view: View) { this.update({ view }); }
  private setPointer(pointer: Point | null) { this.update({ pointer }); }
  private stopWheel() { clearInterval(this.wheelTimer); this.wheelTimer = undefined; }
  private stopGestures() {
    clearTimeout(this.longPress); this.longPress = undefined;
    clearTimeout(this.feedbackTimer);
    this.stopWheel(); this.wheel = new WheelControl();
    this.mouse = new MouseModeRecognizer(); this.touch = new TouchModeRecognizer();
    this.setPointerButtons(0);
    this.update({ feedback: null, wheelOffset: 0, pressed: { left: false, right: false } });
  }
  private clearFrame() { this.displayed = null; this.lastTouch = null; this.update({ shown: null, inputReady: false }); }
  private onPages(next: Pages) {
    const previous = this.snapshot.pages.snapshot;
    this.update({ pages: applyPages(this.snapshot.pages, next, Date.now()) });
    if (next.capacity_rejection && next.capacity_rejection.id !== previous?.capacity_rejection?.id)
      this.setError(t('弹出页面因本环境页面总数达到上限而被拒绝'));
    const identityChanged = previous?.current !== next.current || previous?.epoch !== next.epoch || previous?.vp !== next.vp;
    if (identityChanged || next.state !== 'human' || next.pages.length === 0) this.endTyping();
    if (identityChanged) {
      if (this.snapshot.video.transport === 'video' || this.snapshot.video.source) {
        this.displayed = null; this.update({ inputReady: false }); this.videoEvent({ type: 'pages' });
      } else this.clearFrame();
      this.setView(IDENTITY_VIEW);
    }
    const restored = observePageSelection(this.selection, next);
    this.selection = restored.selection;
    if (!this.selection.pending) this.restoreRequestId = null;
    if (restored.switchTo) {
      const request = this.client?.switchPage(restored.switchTo);
      if (request == null) this.selection = rejectPageRestoration(this.selection, next.current);
      else this.restoreRequestId = request;
    }
    if (next.state !== 'human' || next.pages.length === 0) this.stopGestures();
    if (next.state === 'released') { this.videoEvent({ type: 'ended' }); this.update({ ended: true }); }
    if (!next.current) this.videoPlayer?.stop();
  }
  attach = () => {
    let subscribed = true;
    let connection: BrowserConnectionState = { status: 'stopped' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retire = () => {};
    const scheduleWake = () => {
      clearTimeout(timer); timer = undefined;
      const wakeAt = browserConnectionWakeAt(connection);
      if (wakeAt !== null) timer = setTimeout(() => transition({ type: 'wake', now: Date.now(), jitter: Math.random() }), Math.max(0, wakeAt - Date.now()));
    };
    const transition = (event: BrowserConnectionEvent) => {
      if (!subscribed) return;
      if (this.api.signal.aborted || this.snapshot.ended || this.options.isLeaseEnded?.()) event = { type: 'stop' };
      const previous = connection;
      connection = browserConnectionReducer(connection, event);
      if (connection === previous) { if (event.type === 'wake') scheduleWake(); return; }
      clearTimeout(timer);
      this.update({ streamState: connection.status, stats: null, ...(connection.status === 'open' ? { streamError: null } : {}) });
      if (connection.status === 'closed' || connection.status === 'stopped') {
        retire(); this.clearVideoDeadline(); this.videoPlayer?.stop(); this.videoEvent({ type: 'closed' });
        this.clearFrame(); this.endTyping(); this.stopGestures();
      } else if (connection.status === 'reconnecting' && connection.retryAt !== null) {
        retire(); this.displayed = null; this.update({ inputReady: false });
        this.clearVideoDeadline(); this.videoEvent({ type: 'suspended' }); this.videoPlayer?.stop();
        this.stopWheel(); this.flushTyping();
      } else if (connection.status === 'connecting' || connection.status === 'reconnecting' && connection.retryAt === null) {
        startAttempt();
      }
      // Constructors/callbacks can settle synchronously; arm only the resulting state's deadline.
      scheduleWake();
    };
    const startAttempt = () => {
      let connected = true, hello = false, pages = false;
      this.selection = resumePageSelection(this.selection, this.api.config.computerId ?? null);
      this.restoreRequestId = null; this.unknownInputWatermark = 0; this.sentInputs.clear();
      const ready = () => { if (hello && pages) transition({ type: 'ready', now: Date.now() }); };
      let client: BrowserStream;
      try { client = new BrowserStream(this.api, this.id, this.control, {
      state: (state, code = 1006) => {
        if (!connected || state !== 'closed') return;
        if (code === 4404) this.update({ ended: true, endedReason: endedReason(null) });
        transition({ type: 'failed', code, now: Date.now(), jitter: Math.random() });
      },
      frame: packet => {
        if (!connected || !hello || !pages) return;
        try {
          const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(packet.jpeg));
          if (!image) throw new Error('画面解码失败');
          this.update({ shown: { frame: packet.frame, image, source: client, connectionId: client.measurements.connectionId }, decodeFailed: false });
        } catch { client.discardFrame(packet.frame.seq); this.update({ decodeFailures: this.snapshot.decodeFailures + 1, decodeFailed: true }); }
      },
      pages: next => {
        if (!connected) return;
        this.onPages(next);
        if (this.snapshot.ended || next.state === 'stopping') transition({ type: 'stop' });
        else { pages = true; ready(); }
      },
      reply: result => {
        if (!connected) return;
        const matched = (result.t === 'input_done' || result.t === 'reject') && result.id !== null && this.sentInputs.delete(result.id);
        if (result.t === 'input_done' && matched) {
          if (result.outcome === 'unknown') { this.markInputUnknown(); this.reportPointer(); }
          else if (result.id > this.unknownInputWatermark) this.update({ inputUnknown: false });
        }
        if (result.t === 'reject') {
          if (result.id === this.restoreRequestId && result.id !== null) {
            this.restoreRequestId = null;
            this.selection = rejectPageRestoration(this.selection, this.snapshot.pages.snapshot?.current ?? null);
          }
          console.warn('[browser-stream] rejected', { lease: this.id, id: result.id, reason: result.why });
          this.setError(rejectReason(result.why));
          this.reportPointer();
        } else if (result.t === 'input_done' || result.t === 'page_done') this.setError(null);
      },
      ended: reason => { if (connected) { this.videoEvent({ type: 'ended' }); this.update({ ended: true, endedReason: endedReason(reason) }); transition({ type: 'stop' }); } },
      error: message => { if (connected) this.update({ streamError: message }); },
      hello: value => { if (connected) {
        hello = true;
        this.videoEvent({ type: 'hello', transport: value.transport,
          supportReason: !this.videoPlayer ? 'player-unavailable' : value.video_support.available ? null : value.video_support.reason });
        ready();
      } },
      controlReject: id => {
        if (!connected) return;
        if (id === this.retryId) { this.retryId = null; this.failVideo('sfu-unreachable'); }
      },
      video: message => { if (connected) this.onVideo(message); },
      inputResumed: () => { if (connected) this.reportPointer(); },
      sent: id => {
        if (!connected) return;
        this.sentInputs.add(id);
        if (this.sentInputs.size > 512) this.sentInputs.delete(this.sentInputs.values().next().value!);
      },
    }, !!this.videoPlayer); }
      catch {
        connected = false;
        transition({ type: 'failed', code: 1006, now: Date.now(), jitter: Math.random() });
        return;
      }
      this.client = client;
      retire = () => {
        connected = false;
        if (this.client === client) this.client = null;
        client.close();
      };
    };
    this.selection = resumePageSelection(this.selection, this.api.config.computerId ?? null);
    this.update({ pages: EMPTY_PAGE_STATE }); this.clearFrame(); this.stopGestures();
    const stop = () => transition({ type: 'stop' });
    this.api.signal.addEventListener('abort', stop, { once: true });
    const releaseTask = this.options.subscribeTask?.(() => {
      if (this.options.isLeaseEnded?.()) transition({ type: 'stop' });
    });
    transition({ type: 'start', now: Date.now() });
    const notices = setInterval(() => {
      if (this.snapshot.pages.notices.length) this.update({ pages: { ...this.snapshot.pages, ...collapseNotices(this.snapshot.pages, Date.now()) } });
    }, 1000);
    return () => {
      releaseTask?.();
      transition({ type: 'stop' }); subscribed = false;
      this.api.signal.removeEventListener('abort', stop); clearInterval(notices);
      this.update({ stats: null, inputUnknown: false });
    };
  };
  onDisplayed = ({ frame, source }: FrameCandidate) => {
    if (this.snapshot.streamState !== 'open' || this.client !== source || !source.displayedFrame(frame)) return;
    const previous = this.displayed; this.displayed = frame;
    this.videoEvent({ type: 'jpeg' });
    this.update({ inputReady: true });
    const next = pointerForViewport(this.snapshot.pointer, frame.css[0], frame.css[1]);
    if (next !== this.snapshot.pointer) this.setPointer(next);
    if (!previous) this.reportPointer();
    if (previous && (previous.vp !== frame.vp || previous.page !== frame.page)) this.setView(IDENTITY_VIEW);
  };
  layout = (next: Size) => {
    const { container: old, view } = this.snapshot;
    if (old.w !== next.w) this.setView(IDENTITY_VIEW);
    else if (old.h !== next.h && this.geometry) this.setView(clampView(view, next, { w: this.geometry.css[0], h: this.geometry.css[1] }));
    this.update({ container: next });
  };
  private apply = (action: Action | MouseAction, ts: number) => {
    if (action.kind === 'press' || action.kind === 'release') {
      this.setPointerButtons(action.kind === 'press' ? 1 : 0, ts, action.count);
      return;
    }
    const frame = this.geometry;
    const { container: box, view } = this.snapshot;
    if (!frame || !this.human || !box.w || !box.h) {
      if (action.kind === 'move') this.setPointerButtons(action.dragging ? 1 : 0, ts);
      return;
    }
    const size = { w: frame.css[0], h: frame.css[1] };
    const at = () => { const point = this.snapshot.pointer ?? { x: size.w / 2, y: size.h / 2 }; if (!this.snapshot.pointer) this.setPointer(point); return point; };
    if (action.kind === 'pinch') this.setView(zoomPan(view, action.from, action.to, action.scale, box, size));
    else if (action.kind === 'pan') this.setView(zoomPan(view, { x: 0, y: 0 }, { x: action.dx, y: action.dy }, 1, box, size));
    else if (action.kind === 'move') {
      const next = movePointer(at(), action.dx, action.dy, box, size, view); this.setPointer(next);
      if (!this.setPointerButtons(action.dragging ? 1 : 0, ts)) this.reportPointer(ts);
    } else if (action.kind === 'click') {
      const remote = 'count' in action ? at() : toRemote(action, box, size, view);
      if (remote) {
        this.send({ t: 'pointer', ...remote, buttons: this.pointerButtons | (action.button === 'left' ? 1 : 2), ...('count' in action ? { count: action.count } : {}), ts });
        this.send({ t: 'pointer', ...remote, buttons: this.pointerButtons, ts });
      }
    }
  };
  setMode = (mode: 'mouse' | 'touch') => { if (mode !== this.snapshot.mode) { this.stopGestures(); this.update({ mode }); } };
  private markContact(contact: Point, mode = this.snapshot.mode) {
    const frame = this.geometry;
    if (!this.human || !frame || !this.client) return;
    const point = feedbackPoint(mode, contact, this.snapshot.pointer, this.snapshot.container, { w: frame.css[0], h: frame.css[1] }, this.snapshot.view);
    if (!point) return;
    clearTimeout(this.feedbackTimer); this.update({ feedback: point });
    this.feedbackTimer = setTimeout(() => this.update({ feedback: null }), 280);
  }
  touchEvent = ({ type, touches, t: time }: TouchEvent, canTap = true) => {
    if (this.control && !this.human) return;
    if (type === 'start' && touches.length === 1) this.markContact(touches[0]);
    if (this.control && this.snapshot.mode === 'mouse') return this.mouse.handle({ type, touches, t: time }, canTap).forEach(action => this.apply(action, time));
    if (type === 'start' && touches.length) {
      const frame = this.geometry;
      if (this.control && frame) this.lastTouch = toRemoteClamped(touches[touches.length - 1], this.snapshot.container, { w: frame.css[0], h: frame.css[1] }, this.snapshot.view);
    }
    if (!(type === 'move' || type === 'start' && touches.length === 1)) { clearTimeout(this.longPress); this.longPress = undefined; }
    if (this.control && type === 'start' && touches.length === 1) this.longPress = setTimeout(() => {
      this.longPress = undefined; const actions = this.touch.tick(); if (actions.length) Vibration.vibrate(15);
      actions.forEach(action => this.apply(action, performance.now()));
    }, DEFAULT_OPTIONS.longPressMs);
    const actions = this.touch.handle({ type, touches, t: time });
    if (this.control) actions.forEach(action => this.apply(action, time));
    else actions.forEach(action => {
      const frame = this.geometry; if (!frame) return;
      const size = { w: frame.css[0], h: frame.css[1] };
      if (action.kind === 'pinch') this.setView(zoomPan(this.snapshot.view, action.from, action.to, action.scale, this.snapshot.container, size));
      if (action.kind === 'pan') this.setView(zoomPan(this.snapshot.view, { x: 0, y: 0 }, { x: action.dx, y: action.dy }, 1, this.snapshot.container, size));
    });
  };
  wheelEvent = (event: TouchEvent) => {
    if (!this.human) return;
    this.wheel.handle(event); this.update({ wheelOffset: this.wheel.offset });
    if (this.wheel.active && !this.wheelTimer) this.wheelTimer = setInterval(() => {
      const dy = this.wheel.tick(Date.now()), frame = this.geometry;
      if (dy && frame) this.send({ t: 'wheel', ...wheelAnchor(this.snapshot.mode, this.snapshot.pointer, this.lastTouch, { w: frame.css[0], h: frame.css[1] }), dx: 0, dy });
    }, 16);
    else if (!this.wheel.active) this.stopWheel();
  };
  buttonEvent = (button: 'left' | 'right', event: TouchEvent) => {
    if (!this.human) return;
    if (event.type === 'start' && event.touches.length === 1) this.markContact(event.touches[0], 'mouse');
    this.mouse.handleButton(button, event).forEach(action => this.apply(action, event.t));
    this.update({ pressed: { ...this.snapshot.pressed, [button]: event.touches.length > 0 } });
  };
}
