import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { TextInput } from 'react-native';
import { GatewayApi } from '../src/gateway/api.ts';
import type { Frame, Input, Pages, Reply } from '../src/browser/protocol.ts';
import type { FrameCandidate } from '../src/browser/frame-canvas.tsx';

type Events = { state(value: string): void; pages(value: Pages): void; frame(value: { frame: Frame; jpeg: Uint8Array }): void; ended(reason: string): void; reply(value: Reply): void; error(message: string): void };
type Client = { events: Events; accepted: boolean; sent: Input[]; closed: boolean };
const clients: Client[] = [];
Object.assign(globalThis, { __browserRuntimeClients: clients });
// Only platform drawing and the socket boundary are substituted. Real stream protocol
// and Skia submission remain covered by browser_protocol/browser_canvas_lifecycle.
registerHooks({ resolve(specifier, context, nextResolve) {
  const modules: Record<string, string> = {
    '@shopify/react-native-skia': 'export const Skia = { Image: { MakeImageFromEncoded: () => ({}) }, Data: { fromBytes: value => value } };',
    'react-native': 'export const Vibration = { vibrate() {} };',
    './stream.ts': `export class BrowserStream {
      measurements = { connectionId: 'test' }; accepted = true; sent = []; closed = false;
      constructor(api, id, control, events) { this.events = events; globalThis.__browserRuntimeClients.push(this); events.state('connecting'); events.hello({ transport: 'jpeg', video_support: { available: false, reason: 'environment-unsupported' } }); }
      get isOpen() { return !this.closed; }
      input(value) { if (!this.accepted || this.closed) return null; if (value.t !== 'pointer') this.sent.push(value); return this.sent.length + 1; }
      displayedFrame() { return !this.closed; }
      switchPage() { return null; } close() { this.closed = true; }
    }`,
  };
  return specifier in modules ? { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true } : nextResolve(specifier, context);
} });
const { BrowserRuntime } = await import('../src/browser/runtime.ts');
const pages: Pages = { t: 'pages', current: 'page', epoch: 1, vp: 1, state: 'human', pages: [{ id: 'page', url: 'https://example.com', title: 'Example' }],
  environment_id: 'local', environment_name: 'Local', capacity: { pages_used: 1, pages_registered: 1, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 }, capacity_rejection: null, css: [800, 600], dpr: 1 };
function mounted(control = true) {
  let nativeText = '', allowed = true;
  const api = new GatewayApi({ baseUrl: 'https://runtime.invalid', token: 'test' });
  const runtime = new BrowserRuntime(api, 'lease', control, undefined, () => allowed);
  runtime.attachInput({ clear() { nativeText = ''; }, blur() { runtime.blurInput(); }, focus() { runtime.focusInput(); } } as unknown as TextInput);
  const detach = runtime.attach(), client = clients.at(-1)!;
  const show = (next = pages, seq = 1) => {
    client.events.state('open'); client.events.pages(next);
    client.events.frame({ frame: { seq, page: next.current, epoch: next.epoch, vp: next.vp, css: next.css } as Frame, jpeg: new Uint8Array() });
    runtime.onDisplayed(runtime.getSnapshot().shown as FrameCandidate);
  };
  return { api, runtime, client, show, detach,
    setAllowed(value: boolean) { allowed = value; },
    type(value: string) { nativeText = value; runtime.typed(value); }, get text() { return nativeText; },
    close() { detach(); api.close(); } };
}
for (const control of [false, true]) test(`browser.B3 ${control ? 'control' : 'viewer'} keeps a static candidate across control-only changes, but removes changed picture identities`, () => {
  const s = mounted(control);
  try {
    s.show(); const candidate = s.runtime.getSnapshot().shown;
    s.client.events.pages({ ...pages, state: 'agent' });
    assert.equal(s.runtime.getSnapshot().shown, candidate);
    assert.equal(s.client.closed, false);
    assert.equal(s.runtime.send({ t: 'reload' }), null);
    s.client.events.pages({ ...pages, state: 'requested' });
    assert.equal(s.runtime.getSnapshot().shown, candidate);
    s.client.events.pages({ ...pages, state: 'requested', vp: 2 });
    assert.equal(s.runtime.getSnapshot().shown, null);
  } finally { s.close(); }
});
test('browser.R1/B2 disconnect preserves the picture without input; leaving discards pending text rather than replaying it', () => {
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.type('pending');
    const picture = s.runtime.getSnapshot().shown;
    s.client.closed = true; s.client.events.state('closed');
    assert.equal(s.runtime.getSnapshot().shown, picture); assert.equal(s.runtime.getSnapshot().inputReady, false);
    assert.equal(s.runtime.getSnapshot().ended, false);
    s.detach(); const detachNext = s.runtime.attach();
    try {
      const next = clients.at(-1)!;
      assert.equal(s.runtime.getSnapshot().typingNotice, 'discarded');
      next.events.state('open'); next.events.pages(pages);
      s.runtime.flushTyping(true); assert.deepEqual(next.sent, []);
    } finally { detachNext(); }
  } finally { s.close(); }
});
test('browser.R1/B7 text kept during recovery is not sent on a new frame, only after the user continues typing', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.client.events.state('closed');
    s.type('kept'); s.runtime.flushTyping();
    assert.equal(s.runtime.getSnapshot().typingNotice, 'pending');
    t.mock.timers.tick(500); const replacement = clients.at(-1)!;
    replacement.events.pages(pages);
    replacement.events.frame({ frame: { seq: 1, page: pages.current, epoch: pages.epoch, vp: pages.vp, css: pages.css } as Frame, jpeg: new Uint8Array() });
    s.runtime.onDisplayed(s.runtime.getSnapshot().shown!);
    assert.deepEqual(replacement.sent, []);
    s.type('kept+fresh'); s.runtime.flushTyping();
    assert.deepEqual(replacement.sent, [{ t: 'text', text: 'kept+fresh' }]);
    assert.equal(s.runtime.getSnapshot().typingNotice, null);
  } finally { s.close(); }
});
test('browser.B2 rejected text remains pending until explicit successful submit', () => {
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.client.accepted = false; s.type('未发送'); s.runtime.flushTyping(true);
    assert.deepEqual(s.client.sent, []); assert.equal(s.runtime.getSnapshot().typingNotice, 'pending');
    s.client.accepted = true; s.runtime.flushTyping(true);
    assert.deepEqual(s.client.sent, [{ t: 'text', text: '未发送' }, { t: 'key', key: 'Enter', code: 'Enter', vk: 13, text: '\r' }]);
    assert.equal(s.runtime.getSnapshot().typingNotice, null);
  } finally { s.close(); }
});
for (const change of [
  { label: 'page', current: 'second' }, { label: 'document', vp: 2 },
  { label: 'control epoch', epoch: 2 },
]) test(`browser.B3 ${change.label} ends typing before blur, settle or late native events`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.type('old-page-secret'); s.client.accepted = false; s.runtime.flushTyping(true);
    const next = { ...pages, ...change };
    s.client.events.pages(next); t.mock.timers.tick(400);
    s.client.accepted = true; s.show({ ...next, state: 'human' });
    s.runtime.keyboardHide(); assert.deepEqual(s.client.sent, []); assert.equal(s.text, '');
    s.type('late-old-page-secret'); s.runtime.flushTyping(true); s.runtime.backspace(); t.mock.timers.tick(400);
    assert.deepEqual(s.client.sent, []);
    s.runtime.focusInput(); s.type('new-page-text'); s.runtime.flushTyping(true);
    assert.deepEqual(s.client.sent, [{ t: 'text', text: 'new-page-text' }, { t: 'key', key: 'Enter', code: 'Enter', vk: 13, text: '\r' }]);
  } finally { s.close(); }
});
test('browser.R6/B3 loss of control during recovery discards old typing and restores a view-only picture', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.type('old-control-text');
    s.client.events.state('closed'); t.mock.timers.tick(500);
    const replacement = clients.at(-1)!;
    const next = { ...pages, state: 'agent' as const };
    replacement.events.pages(next);
    replacement.events.frame({ frame: { seq: 1, page: next.current, epoch: next.epoch, vp: next.vp, css: next.css } as Frame, jpeg: new Uint8Array() });
    s.runtime.onDisplayed(s.runtime.getSnapshot().shown!);
    assert.equal(s.text, '');
    s.type('late-input'); s.runtime.flushTyping(true);
    assert.deepEqual(replacement.sent, []);
    assert.equal(s.runtime.send({ t: 'reload' }), null);
    assert.equal(s.runtime.getSnapshot().streamState, 'open');
  } finally { s.close(); }
});
test('browser.B2 background-style keyboard release clears space without a hide animation and permits a later keyboard session', () => {
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.runtime.keyboardShow(296); s.runtime.keyboardHide();
    assert.equal(s.runtime.getSnapshot().keyboard, 0); assert.equal(s.runtime.getSnapshot().keyboardTarget, null);
    s.runtime.focusInput(); s.runtime.keyboardShow(320); assert.equal(s.runtime.getSnapshot().keyboard, 320);
    s.runtime.keyboardHide(); assert.equal(s.runtime.getSnapshot().keyboard, 0);
    s.runtime.editUrl(); s.runtime.keyboardShow(296); s.runtime.keyboardHide(); assert.equal(s.runtime.getSnapshot().keyboardTarget, null);
  } finally { s.close(); }
});
test('browser.B2 unrelated stream replies do not erase pending or discarded input notices', () => {
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.client.accepted = false; s.type('kept'); s.runtime.flushTyping(true);
    s.client.events.reply({ t: 'page_done', id: 42 }); assert.equal(s.runtime.getSnapshot().typingNotice, 'pending');
    s.client.accepted = true; s.runtime.flushTyping(); assert.deepEqual(s.client.sent, [{ t: 'text', text: 'kept' }]);
    s.type('not-sent'); s.detach(); assert.equal(s.runtime.getSnapshot().typingNotice, 'discarded');
    s.client.events.reply({ t: 'page_done', id: 43 }); assert.equal(s.runtime.getSnapshot().typingNotice, 'discarded');
    s.runtime.dismissTypingNotice(); assert.equal(s.runtime.getSnapshot().typingNotice, null);
  } finally { s.close(); }
});
test('browser.B3 session revocation gates inputs before the next stream snapshot', () => {
  const s = mounted();
  try {
    s.show(); s.runtime.focusInput(); s.setAllowed(false); s.type('revoked'); s.runtime.flushTyping(true);
    s.runtime.send({ t: 'reload' }); assert.deepEqual(s.client.sent, []);
  } finally { s.close(); }
});
test('browser.B4 repeated capacity updates preserve a displayed frame and dismissals distinguish rejected popup identities', () => {
  const s = mounted();
  try {
    s.show(); const candidate = s.runtime.getSnapshot().shown;
    s.client.events.pages({ ...pages, capacity: { ...pages.capacity, pages_used: 8 } });
    assert.equal(s.runtime.getSnapshot().shown === candidate, true);
    const rejection = { id: 'first-popup', reason: 'same limit' };
    s.client.events.pages({ ...pages, capacity_rejection: rejection }); assert.match(s.runtime.getSnapshot().error!, /达到上限/);
    s.runtime.setError(null); s.client.events.pages({ ...pages, capacity_rejection: { ...rejection } }); assert.equal(s.runtime.getSnapshot().error, null);
    s.client.events.pages({ ...pages, capacity_rejection: { ...rejection, id: 'second-popup' } }); assert.match(s.runtime.getSnapshot().error!, /达到上限/);
  } finally { s.close(); }
});
test('browser.A4 detach closes transport and late callbacks cannot publish or acknowledge old frames', () => {
  const s = mounted();
  try {
    s.show(); const candidate = s.runtime.getSnapshot().shown!;
    s.detach(); const closed = s.runtime.getSnapshot();
    s.client.events.pages({ ...pages, vp: 2 }); s.client.events.ended('task_cancelled'); s.runtime.onDisplayed(candidate);
    assert.equal(s.client.closed, true); assert.equal(s.runtime.getSnapshot(), closed); assert.equal(closed.shown, null);
  } finally { s.close(); }
});

test('browser.A4 N2 an ended lease keeps its reason; accepted commands and reconnects do not clear it', () => {
  const s = mounted(false);
  try {
    s.show();
    s.client.events.ended('released');
    const reason = s.runtime.getSnapshot().endedReason;
    assert.ok(reason);
    s.client.events.reply({ t: 'page_done', id: 1 } as Reply);
    s.client.events.state('open');
    assert.equal(s.runtime.getSnapshot().endedReason, reason);
    assert.equal(s.runtime.getSnapshot().ended, true);
  } finally { s.close(); }
});
