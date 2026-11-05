import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { GatewayApi, type BrowserTask } from '../src/gateway/api.ts';
import { FakeBrowserStream, installFakeBrowserStreams } from '../src/dev/fake-gateway/browser-stream.ts';

registerHooks({ resolve(specifier, context, next) {
  const modules: Record<string, string> = {
    '@shopify/react-native-skia': 'export const Skia = { Image: { MakeImageFromEncoded: () => ({}) }, Data: { fromBytes: value => value } };',
    'react-native': 'export const Vibration = { vibrate() {} };',
  };
  return modules[specifier] ? { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true } : next(specifier, context);
} });
// Native resolver hooks must be installed before evaluating the platform-dependent runtime.
const { BrowserRuntime } = await import('../src/browser/runtime.ts');
const task: BrowserTask = { id: 'lease', task_id: 'root', root_id: 'root', agent_id: 'a', entry_agent_id: 'a', entry_agent_name: 'A',
  conversation_title: 'Test', state: 'human', epoch: 1, pages: [{ id: 'page', title: 'Page', url: 'https://example.test' }], current: 'page',
  environment_id: 'local', environment_name: 'Local', capacity_rejection: null, reason: null, requested_reason: null,
  capacity: { pages_used: 1, pages_registered: 1, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 } };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
async function mounted() {
  const raf = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>(); let serial = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  globalThis.cancelAnimationFrame = id => { if (id != null) frames.delete(id); };
  const sockets: FakeBrowserStream[] = [];
  const release = installFakeBrowserStreams('http://input.test', task, { jpeg: new Uint8Array([255, 216, 255, 217]) }, socket => {
    socket.holdInputs = true; sockets.push(socket);
  });
  const api = new GatewayApi({ baseUrl: 'http://input.test', token: 'test' }, async () => Response.json({}));
  const runtime = new BrowserRuntime(api, 'lease', true, undefined, () => true);
  let detach = runtime.attach();
  const tick = () => { const next = [...frames.values()]; frames.clear(); next.forEach(frame => frame(performance.now())); };
  const display = () => { tick(); const candidate = runtime.getSnapshot().shown; if (candidate) runtime.onDisplayed(candidate); };
  await flush(); display(); runtime.layout({ w: 800, h: 600 });
  return { runtime, tick, display, get socket() { return sockets.at(-1)!; },
    async reconnect() { detach(); detach = runtime.attach(); await flush(); display(); },
    close() { detach(); api.close(); release(); globalThis.requestAnimationFrame = raf; globalThis.cancelAnimationFrame = cancel; } };
}

test('browser.B1/D9 state boundaries are immediate; same-frame clicks survive and moves keep the latest state', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    assert.deepEqual(s.socket.inputs.map(row => [row.t, row.buttons]), [['pointer', 0]]);
    const offset = s.socket.inputs.length;
    s.runtime.send({ t: 'pointer', x: 10, y: 10, buttons: 0, ts: 10 });
    s.runtime.send({ t: 'pointer', x: 20, y: 10, buttons: 0, ts: 11 });
    assert.equal(s.socket.inputs.length, offset);
    s.tick(); assert.equal(s.socket.inputs.at(-1)?.x, 20);
    for (const buttons of [1, 0, 1, 0]) s.runtime.send({ t: 'pointer', x: 30, y: 40, buttons, ts: 12 });
    assert.deepEqual(s.socket.inputs.slice(-4).map(row => row.buttons), [1, 0, 1, 0]);
    s.tick(); assert.equal(s.socket.inputs.length, offset + 5);
    assert.ok(s.socket.inputs.every(row => row.page === 'page' && row.epoch === 1 && row.vp === 1 && typeof row.ts === 'number'));
  } finally { s.close(); }
});
test('browser.B6 original recognizer preserves button-area plus surface dragging and final position', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.runtime.touchEvent({ type: 'start', touches: [{ id: 'surface', x: 200, y: 200 }], t: 110 });
    s.runtime.touchEvent({ type: 'move', touches: [{ id: 'surface', x: 250, y: 200 }], t: 150 });
    s.tick();
    const drag = s.socket.inputs.at(-1)!; assert.equal(drag.buttons, 1); assert.ok((drag.x as number) > 400);
    s.runtime.touchEvent({ type: 'end', touches: [], t: 180 });
    s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 190 });
    assert.equal(s.socket.inputs.at(-1)?.buttons, 0); assert.equal(s.socket.inputs.at(-1)?.x, drag.x);
    assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 1, 0]);
  } finally { s.close(); }
});
test('browser.B6 touch-mode taps stay pointer clicks; pan/pinch never become remote touch gestures', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.setMode('touch');
    s.runtime.touchEvent({ type: 'start', touches: [{ id: 'tap', x: 80, y: 90 }], t: 100 });
    s.runtime.touchEvent({ type: 'end', touches: [], t: 150 });
    assert.deepEqual(s.socket.inputs.slice(-2).map(row => [row.t, row.buttons, row.x, row.y]), [['pointer', 1, 80, 90], ['pointer', 0, 80, 90]]);
    const count = s.socket.inputs.length;
    s.runtime.touchEvent({ type: 'start', touches: [{ id: 'pan', x: 80, y: 90 }], t: 200 });
    s.runtime.touchEvent({ type: 'move', touches: [{ id: 'pan', x: 180, y: 190 }], t: 250 });
    s.runtime.touchEvent({ type: 'end', touches: [], t: 280 }); s.tick();
    assert.equal(s.socket.inputs.length, count);
  } finally { s.close(); }
});
test('browser.D9 protocol touch snapshots preserve every ID-set boundary and coalesce only motion', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.send({ t: 'touch', touches: [], ts: 1 });
    s.runtime.send({ t: 'touch', touches: [{ id: 7, x: 10, y: 10 }], ts: 2 });
    s.runtime.send({ t: 'touch', touches: [{ id: 7, x: 20, y: 10 }], ts: 3 });
    s.runtime.send({ t: 'touch', touches: [{ id: 7, x: 30, y: 10 }], ts: 4 }); s.tick();
    s.runtime.send({ t: 'touch', touches: [{ id: 7, x: 30, y: 10 }, { id: 8, x: 40, y: 10 }], ts: 5 });
    s.runtime.send({ t: 'touch', touches: [], ts: 6 });
    const wire = s.socket.inputs.filter(row => row.t === 'touch');
    assert.deepEqual(wire.map(row => row.ts), [1, 2, 4, 5, 6]);
    assert.deepEqual(wire.at(-1)?.touches, []);
    assert.equal(s.runtime.send({ t: 'touch', touches: [{ id: 7, x: 10, y: 10 }, { id: 7, x: 20, y: 20 }] }), null);
  } finally { s.close(); }
});
test('browser.B1 wheel deltas merge at one anchor without losing reversals; text/key do not wait behind motion', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.send({ t: 'wheel', x: 20, y: 10, dx: 0, dy: 3 });
    s.runtime.send({ t: 'wheel', x: 20, y: 10, dx: 0, dy: 4 });
    s.runtime.send({ t: 'wheel', x: 20, y: 10, dx: 0, dy: -5 });
    s.runtime.send({ t: 'text', text: '输入' });
    s.runtime.send({ t: 'key', key: 'Enter', code: 'Enter', vk: 13, ts: 9 });
    assert.deepEqual(s.socket.inputs.slice(-2).map(row => row.t), ['text', 'key']);
    s.tick(); s.tick(); assert.deepEqual(s.socket.inputs.filter(row => row.t === 'wheel').map(row => row.dy), [7, -5]);
  } finally { s.close(); }
});
test('browser.B3 pending page requests only pause reports; matching rejection resumes current held state', async t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); const s = await mounted();
  try {
    const request = s.runtime.newPage();
    const before = s.socket.inputs.length;
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.runtime.touchEvent({ type: 'start', touches: [{ id: 'surface', x: 200, y: 200 }], t: 110 });
    s.runtime.touchEvent({ type: 'move', touches: [{ id: 'surface', x: 260, y: 200 }], t: 150 }); s.tick();
    assert.equal(s.socket.inputs.length, before);
    s.socket.reject(request!, 'page-limit');
    assert.equal(s.socket.inputs.at(-1)?.buttons, 1);
    assert.ok((s.socket.inputs.at(-1)?.x as number) > 400);
    s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 200 });
    assert.equal(s.socket.inputs.at(-1)?.buttons, 0);
  } finally { s.close(); }
});
test('browser.B3 viewport/disconnect drop only unsent samples and never replay into a new connection', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.send({ t: 'pointer', x: 30, y: 20, buttons: 0 });
    const count = s.socket.inputs.length;
    s.socket.emit({ ...s.socket.pages, vp: 2 }); s.tick(); assert.equal(s.socket.inputs.length, count);
    await s.reconnect(); assert.deepEqual(s.socket.inputs.map(row => [row.t, row.buttons]), [['pointer', 0]]);
    s.runtime.send({ t: 'pointer', x: 60, y: 20, buttons: 0 });
    const old = s.socket; old.close(); s.tick(); assert.equal(old.inputs.length, 1);
    await s.reconnect(); assert.deepEqual(s.socket.inputs.map(row => [row.t, row.buttons]), [['pointer', 0]]);
  } finally { s.close(); }
});
test('browser.D10 unknown uses actual sent identity and initiating watermark, never unmatched/duplicate replies', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    const first = s.runtime.send({ t: 'reload' })!, old = s.runtime.send({ t: 'back' })!;
    s.socket.done(first, 'unknown'); assert.equal(s.runtime.getSnapshot().inputUnknown, true);
    s.socket.done(old); s.socket.done(999); assert.equal(s.runtime.getSnapshot().inputUnknown, true);
    const next = s.runtime.send({ t: 'reload' })!; s.socket.done(next);
    assert.equal(s.runtime.getSnapshot().inputUnknown, false);
    s.socket.done(first, 'unknown'); assert.equal(s.runtime.getSnapshot().inputUnknown, false);
    assert.equal(s.socket.received.some(row => row.t === 'client_stats'), false);
  } finally { s.close(); }
});

test('browser.B6 right click while left remains held reports both buttons and preserves recognizer click count', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'left', x: 300, y: 500 }], t: 100 });
    s.runtime.buttonEvent('right', { type: 'start', touches: [{ id: 'right', x: 500, y: 500 }], t: 110 });
    s.runtime.buttonEvent('right', { type: 'end', touches: [], t: 120 });
    assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 3, 1]);
    assert.equal(s.socket.inputs.at(-2)?.count, 1);
    s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 130 });
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'again', x: 300, y: 500 }], t: 140 });
    assert.equal(s.socket.inputs.at(-1)?.count, 2);
    s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 150 });
    assert.equal(s.socket.inputs.at(-1)?.buttons, 0);
  } finally { s.close(); }
});

test('browser.B6 N1 mode reset immediately reports the recognizer current unpressed state', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.runtime.setMode('touch'); s.tick();
    assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 0]);
    assert.deepEqual(s.runtime.getSnapshot().pressed, { left: false, right: false });
  } finally { s.close(); }
});
test('browser.B6 N2 button mask changes report at the last pointer position even during zero-size layout', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    const held = s.socket.inputs.at(-1)!;
    s.runtime.layout({ w: 0, h: 0 });
    s.runtime.buttonEvent('left', { type: 'cancel', touches: [], t: 150 });
    assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 0]);
    assert.deepEqual([s.socket.inputs.at(-1)?.x, s.socket.inputs.at(-1)?.y], [held.x, held.y]);
    assert.equal(s.socket.inputs.at(-1)?.ts, 150);
  } finally { s.close(); }
});
test('browser.B6 N2 local-only layout restoration cannot retain a pressed state after mode reset', async t => {
  t.mock.method(console, 'log', () => {}); const s = await mounted();
  try {
    s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
    s.runtime.layout({ w: 0, h: 0 }); s.runtime.setMode('touch');
    s.runtime.layout({ w: 800, h: 600 }); s.tick();
    assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 0]);
    assert.equal(s.runtime.getSnapshot().inputReady, true);
  } finally { s.close(); }
});

for (const reply of ['unknown', 'reject'] as const) {
  test(`browser.D10 ${reply} reports neutral touch-pointer state before the next tap`, async t => {
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); const s = await mounted();
    try {
      s.runtime.setMode('touch');
      s.runtime.touchEvent({ type: 'start', touches: [{ id: 'first', x: 80, y: 90 }], t: 100 });
      s.runtime.touchEvent({ type: 'end', touches: [], t: 150 });
      const released = s.socket.inputs.at(-1)!;
      if (reply === 'unknown') s.socket.done(released.id as number, 'unknown');
      else s.socket.reject(released.id as number, 'sequence-rejected');
      s.tick();
      s.runtime.touchEvent({ type: 'start', touches: [{ id: 'next', x: 180, y: 190 }], t: 300 });
      s.runtime.touchEvent({ type: 'end', touches: [], t: 350 });
      assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 0, 0, 1, 0]);
    } finally { s.close(); }
  });
  test(`browser.D10 ${reply} reports the still-held mouse state without fabricating release`, async t => {
    t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); const s = await mounted();
    try {
      s.runtime.buttonEvent('left', { type: 'start', touches: [{ id: 'button', x: 300, y: 500 }], t: 100 });
      const held = s.socket.inputs.at(-1)!;
      if (reply === 'unknown') s.socket.done(held.id as number, 'unknown');
      else s.socket.reject(held.id as number, 'sequence-rejected');
      s.tick();
      assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 1]);
      assert.equal(s.runtime.getSnapshot().pressed.left, true);
      s.runtime.buttonEvent('left', { type: 'end', touches: [], t: 200 });
      assert.deepEqual(s.socket.inputs.map(row => row.buttons), [0, 1, 1, 0]);
    } finally { s.close(); }
  });
}

test('browser.B3 page controls pass shared peer field validation before browser operation failure', async t => {
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); const s = await mounted();
  try {
    const replies: Record<string, unknown>[] = [];
    const receive = s.socket.onmessage;
    s.socket.onmessage = event => {
      if (typeof event.data === 'string') replies.push(JSON.parse(event.data));
      receive?.(event);
    };
    s.socket.emit({ ...s.socket.pages, pages: [...s.socket.pages.pages, { id: 'other', title: 'Other', url: 'https://other.test' }] });
    const switched = s.runtime.switchPage('other');
    assert.notEqual(switched, null); await flush();
    assert.equal(replies.find(row => row.id === switched)?.why, 'browser-operation-failed');
    const created = s.runtime.newPage();
    assert.notEqual(created, null); await flush();
    assert.equal(replies.find(row => row.id === created)?.why, 'browser-operation-failed');
    s.socket.send(JSON.stringify({ t: 'switch_page', id: 900, page: 'other' }));
    s.socket.send(JSON.stringify({ t: 'new_page', id: 901 }));
    await flush();
    assert.equal(replies.find(row => row.id === 900)?.why, 'invalid-target');
    assert.equal(replies.find(row => row.id === 901)?.why, 'invalid-epoch');
  } finally { s.close(); }
});
