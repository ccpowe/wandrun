import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionActionReducer as reduce, selectConnectionAction, validLocalName, type ConnectionActionState } from '../src/lib/gateway-connection.ts';

const idle: ConnectionActionState = { status: 'idle', error: '' };
const rename = () => reduce(idle, { type: 'rename-opened', targetId: 'server', draft: 'old' });
const disconnect = () => reduce(idle, { type: 'disconnect-opened', targetId: 'server' });

test('settings.G1 空闲打开备注只采纳本地备注，修改后清除校验错误', () => {
  const opened = rename();
  assert.deepEqual(opened, { status: 'rename', targetId: 'server', draft: 'old', error: '' });
  const invalid = reduce(opened, { type: 'invalid-name' });
  assert.equal(selectConnectionAction(invalid).error, '备注名须为单行，最多 64 个字符');
  assert.deepEqual(reduce(invalid, { type: 'name-changed', draft: 'new' }), { status: 'rename', targetId: 'server', draft: 'new', error: '' });
});
test('settings.G2 备注与断开取消不发持久化，回空闲', () => {
  assert.deepEqual(reduce(rename(), { type: 'cancelled' }), idle);
  assert.deepEqual(reduce(disconnect(), { type: 'cancelled' }), idle);
});
test('settings.G3 备注校验以 Unicode 字符计数，空白恢复默认名，拒绝换行', () => {
  assert.equal(validLocalName('😀'.repeat(64)), true);
  assert.equal(validLocalName('😀'.repeat(65)), false);
  assert.equal(validLocalName('   '), true);
  assert.equal(validLocalName('a\nb'), false);
  const invalid = reduce(rename(), { type: 'name-changed', draft: 'a\nb' });
  assert.strictEqual(reduce(invalid, { type: 'confirmed', operationId: 'write' }), invalid);
});
test('settings.G4 备注保存防重、旧操作结果无效，成功关层', () => {
  const saving = reduce(rename(), { type: 'confirmed', operationId: 'write' });
  assert.equal(selectConnectionAction(saving).busy, true);
  assert.strictEqual(reduce(saving, { type: 'confirmed', operationId: 'duplicate' }), saving);
  assert.strictEqual(reduce(saving, { type: 'cancelled' }), saving);
  assert.strictEqual(reduce(saving, { type: 'succeeded', operationId: 'old' }), saving);
  assert.deepEqual(reduce(saving, { type: 'succeeded', operationId: 'write' }), idle);
});
test('settings.G5 备注保存失败保留目标与草稿，可改后重试', () => {
  const saving = reduce(rename(), { type: 'confirmed', operationId: 'write' });
  const failed = reduce(saving, { type: 'failed', operationId: 'write' });
  assert.deepEqual(failed, { status: 'rename', targetId: 'server', draft: 'old', error: '无法保存备注名，请重试。' });
  assert.equal(reduce(failed, { type: 'confirmed', operationId: 'retry' }).status, 'saving-name');
});
test('settings.G6 断开确认与移除忙态不接受重复提交，成功关层', () => {
  assert.equal(selectConnectionAction(disconnect()).dialog, 'disconnect');
  const removing = reduce(disconnect(), { type: 'confirmed', operationId: 'remove' });
  assert.equal(selectConnectionAction(removing).busy, true);
  assert.strictEqual(reduce(removing, { type: 'confirmed', operationId: 'duplicate' }), removing);
  assert.strictEqual(reduce(removing, { type: 'succeeded', operationId: 'old' }), removing);
  assert.deepEqual(reduce(removing, { type: 'succeeded', operationId: 'remove' }), idle);
});
test('settings.G7 本地移除失败保留确认目标，允许再次断开', () => {
  const failed = reduce(reduce(disconnect(), { type: 'confirmed', operationId: 'remove' }), { type: 'failed', operationId: 'remove' });
  assert.equal(failed.status, 'disconnect');
  assert.equal(selectConnectionAction(failed).targetId, 'server');
  assert.equal(reduce(failed, { type: 'confirmed', operationId: 'retry' }).status, 'disconnecting');
});
test('settings.G8 切换保存中不接受其他操作，失败可再次切换', () => {
  const switching = reduce(idle, { type: 'switch-started', targetId: 'next', operationId: 'switch' });
  assert.strictEqual(reduce(switching, { type: 'rename-opened', targetId: 'server', draft: '' }), switching);
  assert.strictEqual(reduce(switching, { type: 'failed', operationId: 'old' }), switching);
  assert.deepEqual(reduce(switching, { type: 'succeeded', operationId: 'switch' }), idle);
  const failed = reduce(switching, { type: 'failed', operationId: 'switch' });
  assert.equal(failed.status, 'idle');
  assert.equal(reduce(failed, { type: 'switch-started', targetId: 'next', operationId: 'retry' }).status, 'switching');
});
test('settings.G9 空闲迟到结果、编辑时其他命令不能改变当前流程', () => {
  assert.strictEqual(reduce(idle, { type: 'succeeded', operationId: 'old' }), idle);
  const editing = rename();
  assert.strictEqual(reduce(editing, { type: 'switch-started', targetId: 'next', operationId: 'switch' }), editing);
  assert.strictEqual(reduce(disconnect(), { type: 'name-changed', draft: 'ignored' }).status, 'disconnect');
});
test('settings.G10 切换失败只结束忙态；失败文字是页面访问的一次性结果，不存进 reducer', () => {
  const switching = reduce(idle, { type: 'switch-started', targetId: 'server', operationId: 'switch' });
  assert.deepEqual(reduce(switching, { type: 'failed', operationId: 'switch' }), idle);
  assert.strictEqual(reduce(switching, { type: 'failed', operationId: 'other' }), switching);
});
