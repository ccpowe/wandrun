import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorLeaveOwner, editorLeaveReducer, type EditorLeaveState, type LeaveTarget } from '../src/lib/editor-leave.ts';
import { navigationAdmissionReducer } from '../src/lib/navigation-admission.ts';

const back: LeaveTarget = { kind: 'navigation', action: { type: 'GO_BACK', source: 'editor', target: 'root' } };
const other: LeaveTarget = { kind: 'navigation', action: { type: 'REPLACE', payload: { name: 'other' } } };

test('leave.T1 inactive 拒绝请求；聚焦后可请求；失焦撤销原导航', () => {
  const inactive: EditorLeaveState = { status: 'inactive' };
  const event = { type: 'intercept' as const, target: back, mode: 'ordinary' as const, operation: 1 };
  assert.equal(editorLeaveReducer(inactive, event), inactive);
  const active = editorLeaveReducer(inactive, { type: 'enter' });
  assert.equal(editorLeaveReducer(active, event).status, 'confirming');
  assert.deepEqual(editorLeaveReducer(editorLeaveReducer(active, event), { type: 'exit' }), inactive);
});
test('leave.T2 普通和未知确认各保存原因；取消清除目的地', () => {
  for (const reason of ['ordinary', 'unknown'] as const) {
    const state = editorLeaveReducer({ status: 'idle' }, { type: 'intercept', target: back, mode: reason, operation: 1 });
    assert.deepEqual(state, { status: 'confirming', target: back, reason });
    assert.deepEqual(editorLeaveReducer(state, { type: 'cancel' }), { status: 'idle' });
  }
});
test('leave.T3 确认期间第二个目的地使第一个作废；确认只消费最新原对象一次', async () => {
  const actions: unknown[] = []; const owner = new EditorLeaveOwner(action => actions.push(action)); owner.enter();
  await owner.intercept(back, 'ordinary'); await owner.intercept(other, 'ordinary');
  assert.equal(owner.confirm(), true); assert.equal(owner.confirm(), false);
  assert.equal(actions[0], other.kind === 'navigation' ? other.action : null); assert.equal(actions.length, 1);
});
test('leave.T4 保存防同帧重复，成功执行最新目的地，保留真实 action 身份', async () => {
  const actions: unknown[] = []; const owner = new EditorLeaveOwner(action => actions.push(action)); owner.enter();
  const gate = Promise.withResolvers<boolean>(); let writes = 0;
  const saving = owner.intercept(back, 'save', () => { writes++; return gate.promise; });
  await owner.intercept(other, 'save', async () => { writes++; return true; });
  assert.equal(writes, 1); gate.resolve(true); await saving;
  assert.deepEqual(actions, [other.kind === 'navigation' ? other.action : null]);
});
test('leave.T5 保存失败回 idle；迟到旧操作结果不接受，随后可以显式重试', async () => {
  const actions: unknown[] = []; const owner = new EditorLeaveOwner(action => actions.push(action)); owner.enter();
  await owner.intercept(back, 'save', async () => false);
  assert.deepEqual(owner.snapshot(), { status: 'idle' }); assert.deepEqual(actions, []);
  await owner.intercept(other, 'save', async () => true); assert.equal(actions.length, 1);
  const state: EditorLeaveState = { status: 'saving', target: other, operation: 2 };
  assert.equal(editorLeaveReducer(state, { type: 'saved', operation: 1, success: true }), state);
});
test('leave.T6 失焦期间完成保存不导航，重新聚焦不能复活旧目的地', async () => {
  const actions: unknown[] = []; const owner = new EditorLeaveOwner(action => actions.push(action)); owner.enter();
  const gate = Promise.withResolvers<boolean>(); const saving = owner.intercept(back, 'save', () => gate.promise);
  owner.exit(); owner.enter(); gate.resolve(true); await saving;
  assert.deepEqual(actions, []); assert.deepEqual(owner.snapshot(), { status: 'idle' });
});
test('leave.T7 显式保存模式由原生拦截接住；无改动完成路径仍只派发原 action 一次', async () => {
  const actions: unknown[] = []; const owner = new EditorLeaveOwner(action => actions.push(action)); owner.enter();
  owner.arm('save'); let writes = 0;
  await owner.intercept(back, 'ordinary', async () => { writes++; return true; });
  assert.equal(writes, 1); assert.equal(actions[0], back.kind === 'navigation' ? back.action : null);
  await owner.intercept(other, 'continue'); assert.equal(actions.length, 1);
});
test('leave.T8 页内 continuation 确认一次后恢复交互，不伪造原生 action', async () => {
  const owner = new EditorLeaveOwner(() => assert.fail('local continuation must not dispatch')); owner.enter();
  let calls = 0; await owner.intercept({ kind: 'local', run: () => { calls++; } }, 'ordinary');
  owner.confirm(); owner.confirm(); assert.equal(calls, 1); assert.deepEqual(owner.snapshot(), { status: 'idle' });
});
test('admission.T1 必须先收到旧历史清除，再确认新准入提交；重复与乱序不导航', () => {
  assert.equal(navigationAdmissionReducer('clearing', { type: 'admission-committed' }), 'clearing');
  const opening = navigationAdmissionReducer('clearing', { type: 'history-cleared' }); assert.equal(opening, 'opening');
  const ready = navigationAdmissionReducer(opening, { type: 'admission-committed' }); assert.equal(ready, 'ready');
  assert.equal(navigationAdmissionReducer(ready, { type: 'history-cleared' }), ready);
});

test('leave.T10 保存抛错与返回失败同样撤销目的地，不拒绝 Promise，后续显式保存仍可完成', async () => {
  const actions: unknown[] = []; const owner = new EditorLeaveOwner(action => actions.push(action)); owner.enter();
  await owner.intercept(back, 'save', async () => { throw new Error('save failed'); });
  assert.deepEqual(owner.snapshot(), { status: 'idle' }); assert.deepEqual(actions, []);
  await owner.intercept(other, 'save', async () => true);
  assert.deepEqual(actions, [other.kind === 'navigation' ? other.action : null]);
});

test('环境变更确认前零写入，取消保留页面；确认只保存一次并继续原导航', async () => {
  const actions: unknown[] = []; const owner = new EditorLeaveOwner(action => actions.push(action)); owner.enter();
  let writes = 0; const gate = Promise.withResolvers<boolean>();
  const save = () => { writes++; return gate.promise; };
  await owner.intercept(back, 'confirm-save', save);
  assert.equal(writes, 0); assert.deepEqual(actions, []);
  owner.cancel(); await owner.confirmSave(save);
  assert.equal(writes, 0); assert.deepEqual(actions, []);
  owner.arm('confirm-save'); await owner.intercept(other, 'ordinary', save);
  const saving = owner.confirmSave(save); await owner.confirmSave(save);
  assert.equal(writes, 1); assert.deepEqual(actions, []);
  gate.resolve(true); await saving;
  assert.deepEqual(actions, [other.kind === 'navigation' ? other.action : null]);
});
