import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UiAttempt, UiDraft } from '../src/lib/agent-message.ts';
import { createUiDraftStore, uiDraftReducer, copyReducer } from '../src/lib/ui-draft.ts';

const first: UiAttempt = { clientId: 'first', actionId: 'follow/0', values: {} };
const second: UiAttempt = { clientId: 'second', actionId: 'follow/1', values: {} };
const initial: UiDraft = { values: {}, flow: { status: 'editing' } };
const retryFailure = { message: '暂不可用', retryable: true, editable: false };

test('rich.T1–T2 首次发送同步准入，重复点与迟到回执不能替换当前操作', () => {
  const store = createUiDraftStore(initial);
  assert.equal(store.dispatch({ type: 'start', attempt: first, retry: false }), true);
  assert.equal(store.dispatch({ type: 'start', attempt: second, retry: false }), false);
  assert.equal(store.dispatch({ type: 'accepted', clientId: 'old' }), false);
  assert.equal(store.getSnapshot().flow.status, 'sending');
  assert.equal(store.dispatch({ type: 'accepted', clientId: first.clientId }), true);
  assert.equal(store.getSnapshot().flow.status, 'awaiting');
  assert.equal(store.dispatch({ type: 'start', attempt: second, retry: true }), false);
  assert.equal(store.dispatch({ type: 'failed', clientId: first.clientId, failure: retryFailure, unknown: false }), false);
});

test('rich.T3 明确失败只能用相同 clientId 和 actionId 重试，不能改选', () => {
  let state = uiDraftReducer(initial, { type: 'start', attempt: first, retry: false });
  state = uiDraftReducer(state, { type: 'failed', clientId: first.clientId, failure: retryFailure, unknown: false });
  assert.equal(state.flow.status, 'failed');
  assert.equal(uiDraftReducer(state, { type: 'start', attempt: second, retry: true }), state);
  assert.equal(uiDraftReducer(state, { type: 'start', attempt: { ...first, actionId: second.actionId }, retry: true }), state);
  assert.equal(uiDraftReducer(state, { type: 'start', attempt: first, retry: false }), state);
  const retried = uiDraftReducer(state, { type: 'start', attempt: first, retry: true });
  assert.equal(retried.flow.status, 'sending');
  assert.deepEqual(retried.flow.status === 'sending' && retried.flow.attempt, first);
});

test('rich.T4 未知结果冻结操作；只读核对未送达后才可同项重试', () => {
  let state = uiDraftReducer(initial, { type: 'start', attempt: first, retry: false });
  state = uiDraftReducer(state, { type: 'failed', clientId: first.clientId, failure: retryFailure, unknown: true });
  assert.equal(state.flow.status, 'unknown');
  assert.equal(uiDraftReducer(state, { type: 'values', values: { changed: true } }), state);
  assert.equal(uiDraftReducer(state, { type: 'start', attempt: first, retry: true }), state);
  assert.equal(uiDraftReducer(state, { type: 'checked', clientId: 'stale', failure: retryFailure }), state);
  assert.equal(uiDraftReducer(state, { type: 'checked', clientId: first.clientId, failure: retryFailure }), state);
  const checking = uiDraftReducer(state, { type: 'check', clientId: first.clientId });
  assert.equal(checking.flow.status, 'checking');
  assert.equal(uiDraftReducer(checking, { type: 'start', attempt: first, retry: true }), checking);
  assert.equal(uiDraftReducer(checking, { type: 'check-failed', clientId: 'stale' }), checking);
  const failedRead = uiDraftReducer(checking, { type: 'check-failed', clientId: first.clientId });
  assert.equal(failedRead.flow.status, 'unknown');
  const rechecking = uiDraftReducer(failedRead, { type: 'check', clientId: first.clientId });
  const checked = uiDraftReducer(rechecking, { type: 'checked', clientId: first.clientId, failure: retryFailure });
  assert.equal(checked.flow.status, 'failed');
  assert.equal(uiDraftReducer(checked, { type: 'start', attempt: first, retry: true }).flow.status, 'sending');
});

test('表单值可在可编辑失败后修改；发送中与等待持久回执时不能改值', () => {
  let state = uiDraftReducer(initial, { type: 'values', values: { note: '原值' } });
  const attempt = { clientId: 'form', values: state.values };
  state = uiDraftReducer(state, { type: 'start', attempt, retry: false });
  assert.equal(uiDraftReducer(state, { type: 'values', values: { note: '新值' } }), state);
  state = uiDraftReducer(state, { type: 'failed', clientId: 'form', unknown: false, failure: { message: '输入无效', retryable: false, editable: true } });
  state = uiDraftReducer(state, { type: 'values', values: { note: '改正值' } });
  assert.equal(state.values.note, '改正值');
  assert.equal(uiDraftReducer(state, { type: 'start', attempt: { clientId: 'new', values: state.values }, retry: false }).flow.status, 'sending');
});

test('rich.T6 老复制结果和老两秒定时器不能覆盖新复制', () => {
  let state = copyReducer({ status: 'idle' }, { type: 'start', operation: 'a' });
  assert.equal(copyReducer(state, { type: 'done', operation: 'old' }), state);
  state = copyReducer(state, { type: 'done', operation: 'a' });
  assert.equal(state.status, 'done');
  state = copyReducer(state, { type: 'start', operation: 'b' });
  assert.equal(copyReducer(state, { type: 'reset', operation: 'a' }), state);
  state = copyReducer(state, { type: 'failed', operation: 'b' });
  assert.equal(state.status, 'failed');
});
