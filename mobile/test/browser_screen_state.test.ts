import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserScreenReducer as reduce, initialBrowserScreen as initial, selectBrowserScreen } from '../src/lib/browser-screen.ts';
import { EMPTY_PAGE_STATE } from '../src/browser/pages.ts';
import type { BrowserTask } from '../src/gateway/api.ts';
import { browserTaskCloseReducer as closeReducer, type BrowserTaskCloseState } from '../src/lib/browser-task-close.ts';
import type { EditorOperation } from '../src/gateway/editor-operation.ts';
const task = { id: 'lease', state: 'human' } as BrowserTask;
const external = { task, pages: EMPTY_PAGE_STATE, ended: false, online: true, control: true };
const running = () => reduce(initial, { type: 'start', operationId: 'op', command: 'takeover' });
test('browser.T1 idle starts one named command and clears the old failure', () => {
  const failed = reduce(running(), { type: 'failed', operationId: 'op', error: '拒绝' });
  const state = reduce(failed, { type: 'start', operationId: 'next', command: 'handback' });
  assert.equal(state.status, 'running'); assert.equal(state.error, '');
  assert.equal(selectBrowserScreen(state, external).canReturnControl, false);
});
test('browser.T2 matching success returns to idle and unlocks the command', () => {
  const state = reduce(running(), { type: 'succeeded', operationId: 'op' });
  assert.equal(state.status, 'idle'); assert.equal(selectBrowserScreen(state, external).canReturnControl, true);
});
test('browser.T3 matching explicit failure retains the error and permits a new command', () => {
  const state = reduce(running(), { type: 'failed', operationId: 'op', error: '无法接管' });
  assert.equal(state.status, 'idle'); assert.equal(state.error, '无法接管');
  assert.equal(selectBrowserScreen(state, external).canTakeover, true);
});
test('browser.T4 stale success and failure cannot settle the current command', () => {
  const state = running();
  assert.equal(reduce(state, { type: 'succeeded', operationId: 'old' }), state);
  assert.equal(reduce(state, { type: 'failed', operationId: 'old', error: '旧错误' }), state);
});
test('browser.T5 duplicate starts do not replace the in-flight operation identity', () => {
  const state = running();
  assert.equal(reduce(state, { type: 'start', operationId: 'duplicate', command: 'handback' }), state);
});
test('browser.T6 late terminal results cannot revive an idle command', () => {
  assert.equal(reduce(initial, { type: 'succeeded', operationId: 'old' }), initial);
  assert.equal(reduce(initial, { type: 'failed', operationId: 'old', error: '旧错误' }), initial);
});
test('browser.T7 session unknown and pending gate commands without entering the reducer', () => {
  const outcome: EditorOperation = { resource: 'browser', id: 'lease', operationId: 'op', action: 'save', status: 'unknown', error: '', reconciled: false };
  const unknown = selectBrowserScreen(initial, { ...external, outcome });
  assert.equal(unknown.canTakeover, false); assert.equal(unknown.canReturnControl, false); assert.match(unknown.error, /未确认/);
  const pending = selectBrowserScreen(initial, { ...external, outcome: { ...outcome, status: 'pending' } });
  assert.equal(pending.busy, true); assert.equal(pending.canTakeover, false);
  const offline = selectBrowserScreen(initial, { ...external, online: false });
  assert.equal(offline.canTakeover, false); assert.equal(offline.stopped, false);
});
test('browser.T8 URL adoption and edits remain independent of an in-flight command', () => {
  for (const start of [initial, running()]) {
    const state = reduce(start, { type: 'panel', panel: { kind: 'url', draft: 'https://first.example' } });
    const edited = reduce(state, { type: 'url', draft: 'https://draft.example' });
    assert.deepEqual(selectBrowserScreen(edited, external).panel, { kind: 'url', draft: 'https://draft.example' });
    assert.equal(edited.status, start.status);
    assert.equal(reduce(start, { type: 'url', draft: 'unexpected' }), start);
  }
});
test('browser.T9 pages and more each replace URL editing instead of coexisting', () => {
  const state = reduce(initial, { type: 'panel', panel: { kind: 'url', draft: 'draft' } });
  for (const kind of ['pages', 'more'] as const) assert.deepEqual(reduce(state, { type: 'panel', panel: { kind } }).panel, { kind });
});
test('browser.T10 closing a sheet returns to the stage', () => {
  const state = reduce(initial, { type: 'panel', panel: { kind: 'pages' } });
  assert.deepEqual(reduce(state, { type: 'panel', panel: { kind: 'stage' } }).panel, { kind: 'stage' });
});
test('browser.T11 stopped facts override panels and commands even during pending or unknown work', () => {
  for (const status of ['released', 'stopping'] as const) {
    const state = reduce(running(), { type: 'panel', panel: { kind: 'pages' } });
    const selection = selectBrowserScreen(state, { ...external, task: { ...task, state: status } });
    assert.equal(selection.stopped, true); assert.equal(selection.human, false);
    assert.equal(selection.canTakeover, false); assert.equal(selection.canClosePage, false);
    assert.deepEqual(selection.panel, { kind: 'stage' });
  }
});
test('browser.T12 idle starts a direct close and clears the previous failure', () => {
  const state = closeReducer({ status: 'idle', error: '旧错误' }, { type: 'start', taskId: 'lease', operationId: 'op' });
  assert.deepEqual(state, { status: 'running', taskId: 'lease', operationId: 'op' });
});
test('browser.T13 running rejects duplicate starts and stale results', () => {
  const state: BrowserTaskCloseState = { status: 'running', taskId: 'lease', operationId: 'op' };
  assert.equal(closeReducer(state, { type: 'start', taskId: 'other', operationId: 'duplicate' }), state);
  assert.equal(closeReducer(state, { type: 'settled', operationId: 'old', error: '旧错误' }), state);
});
test('browser.T14 settled success or unknown releases local command tracking, retaining identity for external projection', () => {
  const state: BrowserTaskCloseState = { status: 'running', taskId: 'lease', operationId: 'op' };
  assert.deepEqual(closeReducer(state, { type: 'settled', operationId: 'op', error: '' }), { status: 'idle', taskId: 'lease', error: '' });
});
test('browser.T15 explicit failure stays inline and permits an intentional close retry', () => {
  const state = closeReducer({ status: 'running', taskId: 'lease', operationId: 'op' }, { type: 'settled', operationId: 'op', error: '不可关闭' });
  assert.deepEqual(state, { status: 'idle', taskId: 'lease', error: '不可关闭' });
  assert.deepEqual(closeReducer(state, { type: 'start', taskId: 'lease', operationId: 'retry' }), { status: 'running', taskId: 'lease', operationId: 'retry' });
});
test('browser.T16 native keyboard hide ends URL editing without closing unrelated panels', () => {
  for (const state of [initial, running()]) {
    const editing = reduce(state, { type: 'panel', panel: { kind: 'url', draft: 'draft' } });
    assert.deepEqual(reduce(editing, { type: 'keyboard-hidden' }).panel, { kind: 'stage' });
    const sheet = reduce(state, { type: 'panel', panel: { kind: 'pages' } });
    assert.equal(reduce(sheet, { type: 'keyboard-hidden' }), sheet);
  }
});
test('browser.T17 reconnect rebuilds only the stream while preserving an in-flight command', () => {
  const state = running();
  const next = reduce(state, { type: 'reconnect' });
  assert.equal(next.reconnect, state.reconnect + 1);
  assert.equal(next.status, 'running');
  assert.equal(next.status === 'running' && next.operationId, 'op');
  assert.equal(selectBrowserScreen(next, external).canReturnControl, false);
});
test('browser.T18 close-page success keeps a nonempty list and returns from confirmation, but closes a zero-page list', () => {
  const closing = reduce(reduce(initial, { type: 'panel', panel: { kind: 'pages' } }),
    { type: 'start', operationId: 'close', command: 'close-page' });
  assert.deepEqual(reduce(closing, { type: 'succeeded', operationId: 'close', remainingPages: 1 }).panel, { kind: 'pages' });
  assert.deepEqual(reduce(closing, { type: 'succeeded', operationId: 'close', remainingPages: 0 }).panel, { kind: 'stage' });
  const confirming = reduce(closing, { type: 'panel', panel: { kind: 'close-page', target: 'last' } });
  assert.deepEqual(reduce(confirming, { type: 'succeeded', operationId: 'close', remainingPages: 1 }).panel, { kind: 'pages' });
  const editing = reduce(closing, { type: 'panel', panel: { kind: 'url', draft: 'https://draft.example' } });
  assert.deepEqual(reduce(editing, { type: 'succeeded', operationId: 'close', remainingPages: 1 }).panel, editing.panel);
});

