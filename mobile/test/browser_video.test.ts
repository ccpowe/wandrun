import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserVideoReducer as reduce, initialVideoState, videoInputReady, type VideoReady, type VideoState } from '../src/lib/browser-video.ts';
import type { Pages } from '../src/browser/protocol.ts';

const pages: Pages = { t: 'pages', current: 'a', pages: [{ id: 'a', title: 'A', url: 'https://example.com' }],
  state: 'human', environment_id: 'sandbox', environment_name: 'Sandbox', epoch: 2, vp: 3, css: [800, 600], dpr: 1,
  capacity: { pages_used: 1, pages_limit: 8, pages_registered: 1, pages_creating: 0, pages_pending_cleanup: 0 }, capacity_rejection: null };
const ready: VideoReady = { t: 'video', state: 'ready', url: 'wss://video.invalid', room: 'lease', token: 'test-only',
  track: 'a-track', page: 'a', vp: 3, expires_in_s: 600, renew: false };
function joining(): VideoState {
  return reduce(reduce(initialVideoState, { type: 'hello', transport: 'video', supportReason: null }, pages), { type: 'ready', value: ready }, pages);
}
function playing(): VideoState {
  const state = reduce(joining(), { type: 'connected' }, pages);
  return reduce(state, { type: 'frame', generation: state.generation, width: 1280, height: 960 }, pages);
}

test('browser.V1: a supported video hello waits for a real displayed frame', () => {
  const s = reduce(initialVideoState, { type: 'hello', transport: 'video', supportReason: null }, pages);
  assert.equal(s.phase, 'connecting'); assert.equal(videoInputReady(s, pages), false);
});
test('browser.V2: unavailable video opens JPEG and keeps the disabling reason', () => {
  const s = reduce(initialVideoState, { type: 'hello', transport: 'jpeg', supportReason: 'player-unavailable' }, pages);
  assert.equal(s.transport, 'jpeg');
  assert.equal(s.supportReason, 'player-unavailable');
});
test('browser.V6: ready joins the exact page/view, renewal does not reset playing or frame identity', () => {
  assert.equal(joining().phase, 'joining');
  const s = playing(), next = reduce(s, { type: 'ready', value: { ...ready, renew: true, token: 'replacement-test-only' } }, pages);
  assert.equal(next.phase, 'playing'); assert.equal(next.generation, s.generation); assert.equal(next.source?.token, 'replacement-test-only');
});
test('duplicate current-source readiness preserves a playing frame and native generation', () => {
  const before = playing(), next = reduce(before, { type: 'ready', value: { ...ready } }, pages);
  assert.equal(videoInputReady(next, pages), true);
  assert.equal(next.generation, before.generation);
  assert.equal(next.picture, before.picture);
});
test('browser.V7 / D9: first displayed frame needs connected SDK and a ratio within 1%', () => {
  const s = reduce(joining(), { type: 'connected' }, pages);
  const wrong = reduce(s, { type: 'frame', generation: s.generation, width: 1920, height: 1080 }, pages);
  assert.equal(videoInputReady(wrong, pages), false); assert.equal(wrong.phase, 'switching');
  const next = reduce(wrong, { type: 'frame', generation: s.generation, width: 1280, height: 960 }, pages);
  assert.equal(next.phase, 'playing'); assert.equal(videoInputReady(next, pages), true);
});
test('browser.V8: all startup failures remain video failures, never silently fallback', () => {
  for (const reason of ['publisher-exited', 'sfu-unreachable', 'join-timeout', 'first-frame-timeout'] as const) {
    const s = reduce(joining(), { type: 'failed', reason }, pages);
    assert.equal(s.transport, 'video'); assert.equal(s.phase, 'failed'); assert.equal(s.reason, reason); assert.equal(s.source, null);
  }
});
test('browser.V9: upstream and SDK reconnect pause input while retaining the last displayed picture', () => {
  const s = playing();
  for (const origin of ['gateway', 'player'] as const) {
    const next = reduce(s, { type: 'reconnecting', origin }, pages);
    assert.equal(next.phase, 'reconnecting'); assert.equal(next.picture, s.picture); assert.equal(next.source, s.source);
    assert.equal(videoInputReady(next, pages), false);
  }
});
test('browser.V10: upstream recovery requires ready and a new displayed frame; old queued frame cannot unlock', () => {
  const before = playing(), reconnecting = reduce(before, { type: 'reconnecting', origin: 'gateway' }, pages);
  assert.equal(reduce(reconnecting, { type: 'frame', generation: before.generation, width: 1280, height: 960 }, pages), reconnecting);
  const readyAgain = reduce(reconnecting, { type: 'ready', value: ready }, pages);
  assert.equal(videoInputReady(readyAgain, pages), false);
  const recovered = reduce(readyAgain, { type: 'frame', generation: readyAgain.generation, width: 1280, height: 960 }, pages);
  assert.equal(videoInputReady(recovered, pages), true);
});
test('browser.V11: a reconnect deadline clears the failed surface and rejects late ready', () => {
  const s = reduce(reduce(playing(), { type: 'reconnecting', origin: 'gateway' }, pages), { type: 'failed', reason: 'sfu-unreachable' }, pages);
  assert.equal(s.picture, null); assert.equal(s.source, null); assert.equal(reduce(s, { type: 'ready', value: ready }, pages), s);
});
test('browser.V12: explicit retry alone leaves terminal failure and invalidates old player callbacks', () => {
  const failed = reduce(joining(), { type: 'failed', reason: 'first-frame-timeout' }, pages);
  const s = reduce(failed, { type: 'retry' }, pages);
  assert.equal(s.phase, 'connecting'); assert.ok(s.generation > failed.generation);
  assert.equal(reduce(s, { type: 'frame', generation: failed.generation, width: 1280, height: 960 }, pages), s);
});
test('browser.V14: page or viewport changes wait for a newly displayed matching image', () => {
  const before = playing(), nextPages: Pages = { ...pages, vp: 4, css: [900, 600] };
  const s = reduce(before, { type: 'pages' }, nextPages);
  assert.equal(s.picture, before.picture); assert.equal(videoInputReady(s, nextPages), false);
  const oldRatio = reduce(s, { type: 'frame', generation: s.generation, width: 1280, height: 960 }, nextPages);
  assert.equal(videoInputReady(oldRatio, nextPages), false);
  assert.equal(videoInputReady(reduce(oldRatio, { type: 'frame', generation: s.generation, width: 1350, height: 900 }, nextPages), nextPages), true);
});
test('browser.V15: stale view and wrong request acknowledgments cannot replace the current video', () => {
  const s = playing();
  assert.equal(reduce(s, { type: 'ready', value: { ...ready, vp: 2 } }, pages), s);
});
test('browser.V16: ended dominates every late network/player event and clears subscription data', () => {
  const s = reduce(playing(), { type: 'ended' }, pages);
  assert.equal(s.source, null); assert.equal(s.picture, null); assert.equal(videoInputReady(s, pages), false);
  for (const event of [{ type: 'ready', value: ready }, { type: 'hello', transport: 'video', supportReason: null }, { type: 'retry' }] as const)
    assert.equal(reduce(s, event, pages), s);
});

