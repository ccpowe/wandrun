import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { GatewayApi } from '../src/gateway/api.ts';
import type { Pages } from '../src/browser/protocol.ts';
import type { BrowserVideoConnection, BrowserVideoSurfaceSnapshot, VideoPlayerEvents } from '../src/browser/video-player.tsx';
import type { VideoReady } from '../src/lib/browser-video.ts';

registerHooks({ resolve(specifier, context, next) {
  const modules: Record<string, string> = {
    '@shopify/react-native-skia': 'export const Skia = { Image: { MakeImageFromEncoded: () => ({}) }, Data: { fromBytes: value => value } };',
    'react-native': 'export const Vibration = { vibrate() {} };',
  };
  return modules[specifier] ? { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true } : next(specifier, context);
} });
// Install native-module boundaries before evaluating the otherwise-real runtime.
const { BrowserRuntime } = await import('../src/browser/runtime.ts');
class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 0;
  binaryType = '';
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  url: string;
  constructor(url: string) { this.url = url; Socket.latest = this; }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(value: object | ArrayBuffer) { this.onmessage?.({ data: value instanceof ArrayBuffer ? value : JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
class Player implements BrowserVideoConnection {
  events: VideoPlayerEvents;
  context = '';
  watches: VideoReady[] = [];
  stops = 0;
  readyImmediately = true;
  constructor(events: VideoPlayerEvents) { this.events = events; }
  setContext(context: string) { this.context = context; }
  watch(source: VideoReady) { this.watches.push(source); if (this.readyImmediately) this.join(source); }
  join(source = this.watches.at(-1)!) { this.events.connected(); this.events.subscribed(source); }
  stop() { this.stops++; }
  subscribe() { return () => {}; }
  getSnapshot(): BrowserVideoSurfaceSnapshot { return { trackRef: undefined, context: this.context }; }
  onRendered() {}
  frame(context = this.context, width = 800, height = 600) { this.events.rendered({ source: 'native', context, width, height, at_ms: performance.now() }); }
}
const pages: Pages = { t: 'pages', current: 'a', pages: [{ id: 'a', title: 'A', url: 'https://example.com' }, { id: 'b', title: 'B', url: 'https://example.com/b' }], state: 'human', epoch: 1, vp: 1, css: [800, 600], dpr: 1,
  environment_id: 'sandbox', environment_name: 'Sandbox', capacity: { pages_used: 2, pages_limit: 8, pages_registered: 2, pages_creating: 0, pages_pending_cleanup: 0 }, capacity_rejection: null };
const ready: VideoReady = { t: 'video', state: 'ready', page: 'a', vp: 1, url: 'wss://video.invalid', room: 'lease', track: 'track-a', token: 'test-only', expires_in_s: 600, renew: false };
function mounted() {
  const original = globalThis.WebSocket, raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = id => { if (id != null) frames.delete(id); };
  let player!: Player;
  const api = new GatewayApi({ baseUrl: 'http://video-runtime.invalid', token: 'test-only' });
  const runtime = new BrowserRuntime(api, 'lease', true, undefined, () => true, {
    createVideoPlayer: events => { player = new Player(events); return player; },
  });
  let detach = runtime.attach();
  function open(socket: Socket, connectionId: string) {
    socket.open();
    socket.emit({ t: 'hello', protocol: 3, connection_id: connectionId, ping_supported: false, window_mode: 'adaptive', max_in_flight: 2, max_in_flight_limit: 32,
      transport: 'video', video_support: { available: true, reason: null } });
    socket.emit(pages);
  }
  open(Socket.latest, 'test-connection');
  return { runtime, socket: Socket.latest, player, open,
    tick() { const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame(performance.now())); },
    reconnect() { detach(); detach = runtime.attach(); const next = Socket.latest; open(next, 'replacement-connection'); return next; },
    close() { detach(); api.close(); globalThis.WebSocket = original; globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = cancel; } };
}

test('browser.V1/V7/D9 actual draw ratio gates input; first ready frame reports current unpressed pointer', t => {
  t.mock.method(console, 'log', () => {}); const s = mounted();
  try {
    const query = new URL(s.socket.url).searchParams;
    assert.equal(query.get('video_player'), '1'); assert.equal(query.has('transport'), false); assert.equal(query.has('input_mode'), false);
    s.socket.emit(ready); assert.equal(s.runtime.send({ t: 'reload' }), null);
    s.player.frame(undefined, 1920, 1080); assert.equal(s.runtime.send({ t: 'reload' }), null);
    s.player.frame();
    assert.deepEqual(s.socket.sent.filter(row => row.t === 'pointer').map(row => [row.x, row.y, row.buttons]), [[400, 300, 0]]);
    const id = s.runtime.send({ t: 'pointer', x: 400, y: 300, buttons: 1 });
    const wire = s.socket.sent.at(-1)!;
    assert.equal(wire.id, id); assert.equal(wire.page, 'a'); assert.equal(wire.epoch, 1); assert.equal(wire.vp, 1); assert.equal('frame' in wire, false);
  } finally { s.close(); }
});
test('browser.V9/V10 upstream reconnect retains picture and rejects late draw contexts', t => {
  t.mock.method(console, 'log', () => {}); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); const before = s.runtime.getSnapshot().video.picture, old = s.player.context;
    s.socket.emit({ t: 'video', state: 'reconnecting' });
    assert.equal(s.runtime.getSnapshot().video.picture, before); assert.equal(s.runtime.send({ t: 'reload' }), null);
    s.player.frame(old); assert.equal(s.runtime.getSnapshot().inputReady, false);
    s.socket.emit(ready); assert.equal(s.runtime.getSnapshot().inputReady, false);
    s.player.frame(); assert.equal(s.runtime.getSnapshot().inputReady, true);
  } finally { s.close(); }
});
for (const release of ['paused', 'resumed'] as const) test(`browser.D9 ${release}: pause only suppresses sending, restored snapshot reports actual held state`, t => {
  t.mock.method(console, 'log', () => {}); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.runtime.layout({ w: 800, h: 600 });
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.runtime.touchEvent({ type: 'start', touches: [{ id: 'surface', x: 200, y: 200 }], t: 110 });
    s.runtime.touchEvent({ type: 'move', touches: [{ id: 'surface', x: 250, y: 200 }], t: 150 });
    s.socket.emit({ t: 'video', state: 'reconnecting' }); const count = s.socket.sent.length;
    s.runtime.touchEvent({ type: 'move', touches: [{ id: 'surface', x: 300, y: 200 }], t: 180 });
    if (release === 'paused') s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 190 });
    s.tick(); assert.equal(s.socket.sent.length, count);
    s.socket.emit(ready); s.player.frame();
    const resumed = s.socket.sent.at(-1)!;
    assert.equal(resumed.t, 'pointer'); assert.equal(resumed.buttons, release === 'paused' ? 0 : 1);
    assert.ok((resumed.x as number) > 400);
    if (release === 'resumed') s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 210 });
    assert.equal(s.socket.sent.at(-1)?.buttons, 0);
  } finally { s.close(); }
});
for (const outcome of ['rejected', 'changed-page'] as const) test(`browser.B3 ${outcome}: in-flight page request resumes current state without release ownership`, t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.runtime.layout({ w: 800, h: 600 });
    const id = s.runtime.switchPage('b'); const count = s.socket.sent.length;
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.runtime.touchEvent({ type: 'start', touches: [{ id: 'surface', x: 200, y: 200 }], t: 110 });
    s.runtime.touchEvent({ type: 'move', touches: [{ id: 'surface', x: 300, y: 200 }], t: 150 }); s.tick();
    assert.equal(s.socket.sent.length, count);
    if (outcome === 'rejected') s.socket.emit({ t: 'reject', id, why: 'page-limit' });
    else { s.socket.emit({ ...pages, current: 'b', vp: 2 }); s.socket.emit({ ...ready, page: 'b', vp: 2, track: 'track-b' }); s.player.frame(); }
    assert.equal(s.socket.sent.at(-1)?.buttons, 1);
    assert.equal(s.socket.sent.at(-1)?.page, outcome === 'rejected' ? 'a' : 'b');
    s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 200 }); assert.equal(s.socket.sent.at(-1)?.buttons, 0);
  } finally { s.close(); }
});
test('browser.D2 rebuilt WS allows a 4.5s join then a separate first-draw deadline', t => {
  t.mock.method(console, 'log', () => {}); t.mock.timers.enable({ apis: ['setTimeout'] }); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); const previous = s.player.context;
    const replacement = s.reconnect(); s.player.readyImmediately = false;
    replacement.emit(ready); t.mock.timers.tick(4500); s.player.join(); t.mock.timers.tick(1000);
    assert.equal(s.runtime.getSnapshot().video.phase, 'joining');
    s.player.frame(previous); assert.equal(s.runtime.getSnapshot().inputReady, false);
    s.player.frame(); assert.equal(s.runtime.getSnapshot().inputReady, true);
  } finally { s.close(); }
});
test('browser.D2/D4 SDK Connected alone and duplicate ready cannot extend the 10s subscription deadline', t => {
  t.mock.method(console, 'log', () => {}); t.mock.timers.enable({ apis: ['setTimeout'] }); const s = mounted(); s.player.readyImmediately = false;
  try {
    s.socket.emit(ready); t.mock.timers.tick(4500); s.player.events.connected(); t.mock.timers.tick(5499); s.socket.emit({ ...ready });
    assert.equal(s.runtime.getSnapshot().video.phase, 'joining'); t.mock.timers.tick(1);
    assert.equal(s.runtime.getSnapshot().video.reason, 'join-timeout'); assert.equal(s.runtime.getSnapshot().video.transport, 'video');
    s.player.join(); s.player.frame(); assert.equal(s.runtime.getSnapshot().video.phase, 'failed');
  } finally { s.close(); }
});
test('browser.D4/V12 first draw has 5s, duplicate notices cannot extend it, explicit retry recovers', t => {
  t.mock.method(console, 'log', () => {}); t.mock.timers.enable({ apis: ['setTimeout'] }); const s = mounted();
  try {
    s.socket.emit(ready); t.mock.timers.tick(4000); s.socket.emit({ ...ready }); s.player.join(); t.mock.timers.tick(1000);
    assert.equal(s.runtime.getSnapshot().video.reason, 'first-frame-timeout');
    assert.equal(s.socket.sent.some(message => message.t === 'transport'), false);
    s.player.frame(); assert.equal(s.runtime.getSnapshot().video.phase, 'failed');
    s.runtime.retryVideo(); assert.equal(s.socket.sent.at(-1)?.t, 'video_retry');
    s.socket.emit(ready); s.player.frame(); assert.equal(s.runtime.getSnapshot().inputReady, true);
  } finally { s.close(); }
});
test('browser.D6/V11 reconnect retains the 15s total budget even when ready and subscription return', t => {
  t.mock.method(console, 'log', () => {}); t.mock.timers.enable({ apis: ['setTimeout'] }); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.socket.emit({ t: 'video', state: 'reconnecting' }); t.mock.timers.tick(14000);
    s.socket.emit(ready); t.mock.timers.tick(1000);
    assert.equal(s.runtime.getSnapshot().video.reason, 'sfu-unreachable'); assert.equal(s.runtime.getSnapshot().video.picture, null);
  } finally { s.close(); }
});
test('browser.A4/V16 lease termination disposes video and ignores late callbacks', t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.socket.emit({ t: 'ended', reason: '任务结束' });
    assert.equal(s.runtime.getSnapshot().video.phase, 'ended'); assert.equal(s.runtime.getSnapshot().video.source, null);
    s.player.events.connected(); s.player.frame(); s.socket.emit(ready);
    assert.equal(s.runtime.getSnapshot().video.phase, 'ended'); assert.equal(s.runtime.send({ t: 'reload' }), null);
  } finally { s.close(); }
});
test('browser.R1/R3 automatic WS recovery restores video but waits for a fresh current-connection draw before sending', t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(Math, 'random', () => 0.5);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); const oldContext = s.player.context;
    s.socket.close();
    assert.equal(s.runtime.send({ t: 'reload' }), null);
    t.mock.timers.tick(500);
    const replacement = Socket.latest;
    assert.notEqual(replacement, s.socket);
    s.open(replacement, 'automatic-replacement'); replacement.emit(ready);
    s.player.frame(oldContext);
    assert.equal(s.runtime.send({ t: 'reload' }), null);
    s.player.frame();
    const id = s.runtime.send({ t: 'reload' });
    assert.equal(replacement.sent.at(-1)?.id, id);
    assert.equal(replacement.sent.at(-1)?.t, 'reload');
    assert.equal(replacement.sent.at(-1)?.page, 'a');
  } finally { s.close(); }
});
for (const held of [true, false]) test(`browser.R1/R3 WS recovery reports the physical ${held ? 'held' : 'released'} button state without replaying input`, t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(Math, 'random', () => 0.5);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.runtime.layout({ w: 800, h: 600 });
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    const picture = s.runtime.getSnapshot().video.picture;
    s.socket.close(); const before = s.socket.sent.length;
    assert.equal(s.runtime.getSnapshot().video.picture, picture);
    if (!held) s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 200 });
    assert.equal(s.socket.sent.length, before);
    t.mock.timers.tick(500); const replacement = Socket.latest;
    s.open(replacement, 'automatic-replacement'); replacement.emit(ready); s.player.frame();
    assert.deepEqual(replacement.sent.filter(row => row.t === 'pointer').map(row => row.buttons), [held ? 1 : 0]);
    if (held) {
      s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 300 });
      assert.equal(replacement.sent.at(-1)?.buttons, 0);
    }
  } finally { s.close(); }
});
for (const mode of ['mouse', 'touch'] as const) for (const release of ['end', 'cancel'] as const)
  test(`browser.R1 ${mode} surface ${release} during backoff leaves the first fresh tap usable`, t => {
    t.mock.method(console, 'log', () => {}); t.mock.method(Math, 'random', () => 0.5);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const s = mounted();
    try {
      s.socket.emit(ready); s.player.frame(); s.runtime.layout({ w: 800, h: 600 }); s.runtime.setMode(mode);
      s.runtime.touchEvent({ type: 'start', touches: [{ id: 'old', x: 80, y: 90 }], t: 100 });
      s.socket.close(); const oldSent = s.socket.sent.length;
      s.runtime.touchEvent({ type: release, touches: [], t: 150 });
      assert.equal(s.socket.sent.length, oldSent);
      t.mock.timers.tick(500); const replacement = Socket.latest;
      s.open(replacement, 'surface-recovery'); replacement.emit(ready); s.player.frame();
      const baseline = replacement.sent.length;
      s.runtime.touchEvent({ type: 'start', touches: [{ id: 'fresh', x: 80, y: 90 }], t: 1000 });
      s.runtime.touchEvent({ type: 'end', touches: [], t: 1050 }); s.tick();
      assert.deepEqual(replacement.sent.slice(baseline).filter(row => row.t === 'pointer').map(row => row.buttons), [1, 0]);
    } finally { s.close(); }
  });
test('browser.R4 an early wake after wall-clock rollback re-arms instead of stranding recovery', t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(Math, 'random', () => 0.5);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] }); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.socket.close();
    const clock = Date.now, failedAt = clock(); let rollback = true;
    t.mock.method(Date, 'now', () => rollback ? failedAt - 1000 : clock());
    t.mock.timers.tick(250); assert.equal(Socket.latest, s.socket);
    rollback = false; t.mock.timers.tick(1250);
    const replacement = Socket.latest; assert.notEqual(replacement, s.socket);
    s.open(replacement, 'clock-recovery'); replacement.emit(ready); s.player.frame();
    assert.notEqual(s.runtime.send({ t: 'reload' }), null);
  } finally { s.close(); }
});

test('browser.D9 restored snapshot observes release during zero-size layout and clamps to resized viewport', t => {
  t.mock.method(console, 'log', () => {}); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.runtime.layout({ w: 800, h: 600 });
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.socket.emit({ t: 'video', state: 'reconnecting' });
    s.runtime.layout({ w: 0, h: 0 });
    s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 150 });
    s.socket.emit({ ...pages, vp: 2, css: [200, 150] });
    s.socket.emit({ ...ready, vp: 2 }); s.player.frame(undefined, 200, 150);
    const state = s.socket.sent.at(-1)!;
    assert.equal(state.t, 'pointer'); assert.equal(state.buttons, 0); assert.equal(state.vp, 2);
    assert.ok((state.x as number) < 200 && (state.y as number) < 150);
  } finally { s.close(); }
});

test('browser.D9 N1 reset during video pause reports current state on recovery, not an owed release', t => {
  t.mock.method(console, 'log', () => {}); const s = mounted();
  try {
    s.socket.emit(ready); s.player.frame(); s.runtime.layout({ w: 800, h: 600 });
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.socket.emit({ t: 'video', state: 'reconnecting' });
    s.runtime.setMode('touch'); s.tick();
    assert.deepEqual(s.socket.sent.filter(row => row.t === 'pointer').map(row => row.buttons), [0, 1]);
    s.socket.emit(ready); s.player.frame();
    assert.deepEqual(s.socket.sent.filter(row => row.t === 'pointer').map(row => row.buttons), [0, 1, 0]);
  } finally { s.close(); }
});

for (const reply of ['unknown', 'reject'] as const) {
  test(`browser.D9 ${reply} during video pause leaves reporting to current-state recovery`, t => {
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); const s = mounted();
    try {
      s.socket.emit(ready); s.player.frame(); s.runtime.layout({ w: 800, h: 600 }); s.runtime.setMode('touch');
      s.runtime.touchEvent({ type: 'start', touches: [{ id: 'tap', x: 80, y: 90 }], t: 100 });
      s.runtime.touchEvent({ type: 'end', touches: [], t: 150 });
      const released = s.socket.sent.at(-1)!;
      s.socket.emit({ t: 'video', state: 'reconnecting' });
      s.socket.emit(reply === 'unknown'
        ? { t: 'input_done', id: released.id, outcome: 'unknown', input_lock_wait_ms: 0, input_dispatch_ms: 0, input_cdp_ms: 0 }
        : { t: 'reject', id: released.id, why: 'sequence-rejected' });
      s.tick();
      assert.deepEqual(s.socket.sent.filter(row => row.t === 'pointer').map(row => row.buttons), [0, 1, 0]);
      s.socket.emit(ready); s.player.frame();
      assert.deepEqual(s.socket.sent.filter(row => row.t === 'pointer').map(row => row.buttons), [0, 1, 0, 0]);
      assert.equal(s.runtime.getSnapshot().inputReady, true);
    } finally { s.close(); }
  });
}
