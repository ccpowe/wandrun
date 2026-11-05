import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DrawerOverlayOwner, drawerOverlayReducer as reduce, selectDrawerOverlay, validDrawerTitle, type DrawerOverlay } from '../src/lib/drawer-overlay.ts';

const closed: DrawerOverlay = { status: 'closed' };
const drawerVisit = {};
const target = { id: 'same', title: 'Original', drawerVisit };
const menuVisit = {};
const external = { open: true, connected: true, hasTarget: true, menuVisit, drawerVisit };
const menu = reduce(closed, { type: 'open-menu', target, point: { pageX: 44, pageY: 300 }, menuVisit });
const renaming = reduce(menu, { type: 'rename' });
const deleting = reduce(menu, { type: 'delete' });
const saving = reduce(reduce(renaming, { type: 'change', title: 'Edited' }), { type: 'submit', operationId: 'write-1' });

test('conversation-drawer.T8 T9 长按采纳目标，再进入重命名或删除确认', () => {
  assert.deepEqual(menu, { status: 'menu', target, point: { pageX: 44, pageY: 300 }, menuVisit });
  assert.deepEqual(renaming, { status: 'renaming', target, title: 'Original', error: '' });
  assert.deepEqual(deleting, { status: 'delete-confirm', target, error: '' });
});
test('conversation-drawer.T10 名称 Unicode 边界、修改清错、非法输入不能提交', () => {
  assert.equal(validDrawerTitle(' '), false);
  assert.equal(validDrawerTitle('😀'.repeat(200)), true);
  assert.equal(validDrawerTitle('😀'.repeat(201)), false);
  const invalid = reduce(renaming, { type: 'change', title: ' ' });
  assert.equal(reduce(invalid, { type: 'submit', operationId: 'x' }), invalid);
  const failure = reduce(saving, { type: 'failed', operationId: 'write-1', message: 'Failed' });
  assert.deepEqual(reduce(failure, { type: 'change', title: 'Next' }), { status: 'renaming', target, title: 'Next', error: '' });
});
test('conversation-drawer.T11 T12 删除在途防取消、防重复；匹配失败保留确认，成功关闭', () => {
  const pending = reduce(deleting, { type: 'submit', operationId: 'delete-1' });
  assert.equal(reduce(pending, { type: 'cancel' }), pending);
  assert.equal(reduce(pending, { type: 'submit', operationId: 'duplicate' }), pending);
  assert.equal(reduce(pending, { type: 'succeeded', operationId: 'stale' }), pending);
  assert.deepEqual(reduce(pending, { type: 'failed', operationId: 'delete-1', message: 'Refused' }), { status: 'delete-confirm', target, error: 'Refused' });
  assert.deepEqual(reduce(pending, { type: 'succeeded', operationId: 'delete-1' }), closed);
});
test('conversation-drawer.T12 重命名在途只接受自己的结果，失败保留草稿，成功不复活', () => {
  assert.equal(reduce(saving, { type: 'submit', operationId: 'duplicate' }), saving);
  assert.equal(reduce(saving, { type: 'failed', operationId: 'stale', message: 'Old' }), saving);
  assert.deepEqual(reduce(saving, { type: 'failed', operationId: 'write-1', message: 'Failed' }), { status: 'renaming', target, title: 'Edited', error: 'Failed' });
  const done = reduce(saving, { type: 'succeeded', operationId: 'write-1' });
  assert.equal(done.status, 'rename-closing');
  assert.equal(selectDrawerOverlay(done, external).busy, true);
  const unmounted = reduce(done, { type: 'rename-closed', target });
  assert.deepEqual(unmounted, closed);
  assert.equal(reduce(unmounted, { type: 'failed', operationId: 'write-1', message: 'Late' }), unmounted);
});
test('conversation-drawer.T13 取消只结束可交互的浮层，菜单迟到关闭不能关闭重命名', () => {
  for (const state of [menu, deleting]) assert.deepEqual(reduce(state, { type: 'cancel' }), closed);
  const closing = reduce(renaming, { type: 'cancel' });
  assert.equal(closing.status, 'rename-closing');
  assert.deepEqual(reduce(closing, { type: 'rename-closed', target }), closed);
  assert.equal(reduce(saving, { type: 'cancel' }), saving);
  assert.equal(reduce(renaming, { type: 'dismiss-menu' }), renaming);
});
test('conversation-drawer.C8 T4 外部删除优先，迟到同 id 响应不能重现浮层或开放写入', () => {
  for (const state of [menu, renaming, saving, deleting]) {
    const gone = { ...external, hasTarget: false };
    assert.deepEqual(selectDrawerOverlay(state, gone), { overlay: null, busy: false, canSubmit: false });
    assert.equal(selectDrawerOverlay(reduce(state, { type: 'failed', operationId: 'write-1', message: 'Late' }), gone).overlay, null);
  }
});
test('conversation-drawer.E5 普通离线不覆盖草稿，禁提交但允许取消', () => {
  const selection = selectDrawerOverlay(renaming, { ...external, connected: false });
  assert.equal(selection.overlay, renaming);
  assert.equal(selection.canSubmit, false);
  assert.equal(selection.busy, false);
  const closing = reduce(renaming, { type: 'cancel' });
  assert.equal(closing.status, 'rename-closing');
  assert.deepEqual(reduce(closing, { type: 'rename-closed', target }), closed);
});

test('conversation-drawer.T4 删除旧目标后可管理另一行，旧结果不能污染新浮层', () => {
  const next = reduce(saving, { type: 'open-menu', target: { id: 'other', title: 'Another', drawerVisit }, point: { pageX: 44, pageY: 400 }, replacesMissing: 'same', menuVisit });
  assert.equal(next.status, 'menu');
  const nextDraft = reduce(next, { type: 'rename' });
  assert.equal(reduce(nextDraft, { type: 'failed', operationId: 'write-1', message: 'Old' }), nextDraft);
});

test('conversation-drawer.T13 旧原生退出回调不能关闭同 id 的新访问', () => {
  const nextMenu = reduce(closed, { type: 'open-menu', target: { ...target }, point: { pageX: 44, pageY: 300 }, menuVisit });
  const nextForm = reduce(nextMenu, { type: 'rename' });
  assert.equal(reduce(nextForm, { type: 'rename-closed', target }), nextForm);
  assert.equal(reduce(nextForm, { type: 'rename-closing', target }), nextForm);
});

test('conversation-drawer.E5 断线结束菜单访问，重连不复活旧菜单且不影响重命名草稿', () => {
  const offline = { ...external, connected: false, menuVisit: {} };
  const reconnected = { ...offline, connected: true, menuVisit: {} };
  assert.equal(selectDrawerOverlay(menu, offline).overlay, null);
  assert.equal(selectDrawerOverlay(menu, reconnected).overlay, null);
  assert.equal(selectDrawerOverlay(renaming, reconnected).overlay, renaming);
  const next = reduce(menu, { type: 'open-menu', target, point: { pageX: 44, pageY: 300 }, menuVisit: reconnected.menuVisit });
  assert.equal(selectDrawerOverlay(next, reconnected).overlay, next);
});

test('conversation-drawer.T13 原生关闭开始立刻禁写，只有匹配目标的真实完成才关闭', () => {
  const closing = reduce(renaming, { type: 'rename-closing', target });
  assert.equal(closing.status, 'rename-closing');
  assert.deepEqual(selectDrawerOverlay(closing, external), { overlay: closing, busy: true, canSubmit: false });
  for (const event of [
    { type: 'submit', operationId: 'too-late' },
    { type: 'change', title: 'Too late' },
    { type: 'rename-closing', target },
    { type: 'rename-closed', target: { ...target } },
  ] as const) assert.equal(reduce(closing, event), closing);
  assert.deepEqual(reduce(closing, { type: 'rename-closed', target }), closed);
});

test('conversation-drawer.T4 新访问纯投影隐藏所有旧阶段，显式长按采纳新访问', () => {
  const nextVisit = {};
  for (const previous of [menu, renaming, saving, deleting, reduce(renaming, { type: 'cancel' })]) {
    const nextExternal = { ...external, drawerVisit: nextVisit };
    assert.deepEqual(selectDrawerOverlay(previous, { ...external, open: false }), { overlay: null, busy: false, canSubmit: false });
    assert.deepEqual(selectDrawerOverlay(previous, nextExternal), { overlay: null, busy: false, canSubmit: false });
    const nextTarget = { ...target, drawerVisit: nextVisit };
    const adopted = reduce(previous, { type: 'open-menu', target: nextTarget, point: { pageX: 44, pageY: 300 }, menuVisit });
    assert.equal(adopted.status, 'menu');
    assert.equal(selectDrawerOverlay(adopted, nextExternal).overlay, adopted);
    const nextForm = reduce(adopted, { type: 'rename' });
    assert.equal(reduce(nextForm, { type: 'rename-closing', target }), nextForm);
    assert.equal(reduce(nextForm, { type: 'rename-closed', target }), nextForm);
    assert.equal(reduce(nextForm, { type: 'failed', operationId: 'write-1', message: 'Old visit' }), nextForm);
  }
});

test('conversation-drawer.T12 同步 owner 只准入一次，失败后由新的 reducer 阶段显式重试', () => {
  for (const intent of ['rename', 'delete'] as const) {
    const owner = new DrawerOverlayOwner();
    let notifications = 0;
    const unsubscribe = owner.subscribe(() => { notifications++; });
    owner.send({ type: 'open-menu', target, point: { pageX: 44, pageY: 300 }, menuVisit });
    owner.send({ type: intent });
    assert.equal(owner.send({ type: 'submit', operationId: 'first' }), true);
    const pending = owner.getSnapshot();
    assert.equal(owner.send({ type: 'submit', operationId: 'duplicate' }), false);
    assert.equal(owner.getSnapshot(), pending);
    assert.equal(notifications, 3);
    assert.equal(owner.send({ type: 'failed', operationId: 'wrong', message: 'Wrong' }), false);
    assert.equal(owner.send({ type: 'failed', operationId: 'first', message: 'Retry' }), true);
    assert.equal(owner.send({ type: 'submit', operationId: 'retry' }), true);
    assert.equal(owner.send({ type: 'succeeded', operationId: 'first' }), false);
    assert.equal(owner.send({ type: 'succeeded', operationId: 'retry' }), true);
    unsubscribe();
  }
});

test('conversation-drawer.T13 同步 owner 先接收关闭开始便拒绝同窗口 submit', () => {
  const owner = new DrawerOverlayOwner();
  owner.send({ type: 'open-menu', target, point: { pageX: 44, pageY: 300 }, menuVisit });
  owner.send({ type: 'rename' });
  assert.equal(owner.send({ type: 'rename-closing', target }), true);
  assert.equal(owner.send({ type: 'submit', operationId: 'too-late' }), false);
  assert.equal(owner.send({ type: 'rename-closed', target }), true);
  assert.deepEqual(owner.getSnapshot(), closed);
});
