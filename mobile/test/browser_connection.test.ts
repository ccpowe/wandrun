import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserConnectionReducer as reduce, browserConnectionWakeAt, browserRetryDelay, type BrowserConnectionState } from '../src/lib/browser-connection.ts';

const start = (now = 0) => reduce({ status: 'stopped' }, { type: 'start', now });
const lost = (state: BrowserConnectionState, now = 100, code = 1006) => reduce(state, { type: 'failed', now, code, jitter: 0.5 });
const wake = (state: BrowserConnectionState, now: number) => reduce(state, { type: 'wake', now, jitter: 0.5 });

test('browser.RT1/R4 retry jitter bounds and capped base waits prevent an unbounded rapid retry loop', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 100].map(count => browserRetryDelay(count, 0.5)), [250, 500, 1000, 2000, 5000, 10_000, 10_000, 10_000]);
  assert.equal(browserRetryDelay(0, 0), 0); assert.equal(browserRetryDelay(0, 1), 500);
  assert.equal(browserRetryDelay(5, 0), 5000); assert.equal(browserRetryDelay(5, 1), 15_000);
});
test('browser.RT1–RT4 a dropped connection retries once, requires a current handshake, and a later loss starts a fresh budget', () => {
  let state = lost({ status: 'open' });
  assert.deepEqual(state, { status: 'reconnecting', deadline: 30_100, retries: 0, retryAt: 350, attemptDeadline: null });
  assert.equal(wake(state, 349), state);
  assert.equal(reduce(state, { type: 'ready', now: 349 }), state);
  state = wake(state, 350);
  assert.equal(browserConnectionWakeAt(state), 10_350);
  state = lost(state, 400);
  assert.equal(browserConnectionWakeAt(state), 900);
  state = wake(state, 900);
  state = reduce(state, { type: 'ready', now: 950 });
  assert.deepEqual(state, { status: 'open' });
  assert.deepEqual(lost(state, 5000), { status: 'reconnecting', deadline: 35_000, retries: 0, retryAt: 5250, attemptDeadline: null });
});
test('browser.RT3/R4/R5 handshake timeouts and subsequent failures cannot extend the 30s recovery deadline', () => {
  let state = start();
  state = wake(state, 10_000);
  assert.equal(browserConnectionWakeAt(state), 10_250);
  state = wake(state, 10_250);
  state = wake(state, 20_250);
  assert.equal(state.status, 'reconnecting');
  state = wake(state, 20_750);
  state = lost(state, 21_000);
  state = wake(state, 22_000);
  state = wake(state, 32_000);
  state = wake(state, 34_000);
  assert.equal(browserConnectionWakeAt(state), 40_000);
  assert.deepEqual(wake(state, 40_000), { status: 'closed' });
  assert.deepEqual(reduce(state, { type: 'ready', now: 40_000 }), { status: 'closed' });
});
test('browser.RT5 protocol failures require manual recovery, while ordinary/server closures retry', () => {
  for (const code of [1002, 1003, 1007, 1008, 1009, 1010, 4400]) assert.deepEqual(lost(start(), 100, code), { status: 'closed' });
  for (const code of [1000, 1001, 1006, 1011, 1012, 1013]) assert.equal(lost(start(), 100, code).status, 'reconnecting');
});
test('browser.RT6 auth revocation and missing leases stop immediately instead of offering reconnect', () => {
  for (const code of [4401, 4404]) assert.deepEqual(lost({ status: 'open' }, 100, code), { status: 'stopped' });
});
test('browser.RT6/R7 stop cancels both a waiting retry and an in-flight attempt; late events cannot revive either', () => {
  const waiting = lost(start()), attempting = wake(waiting, 350);
  for (const state of [waiting, attempting, { status: 'open' } as const]) {
    const stopped = reduce(state, { type: 'stop' });
    assert.equal(browserConnectionWakeAt(stopped), null);
    assert.equal(wake(stopped, 60_000), stopped);
    assert.equal(reduce(stopped, { type: 'ready', now: 1000 }), stopped);
    assert.equal(lost(stopped), stopped);
  }
});
test('browser.RT8 manual recovery starts a new bounded attempt; duplicate starts never replace active work', () => {
  const closed = lost(start(), 100, 1002);
  const next = reduce(closed, { type: 'start', now: 5000 });
  assert.deepEqual(next, { status: 'connecting', attemptDeadline: 15_000 });
  assert.equal(reduce(next, { type: 'start', now: 6000 }), next);
});
