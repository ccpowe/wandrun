import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorOperation } from '../src/gateway/editor-operation.ts';
import { settingsSwitchReducer, selectSettingsPage } from '../src/lib/settings.ts';
import { modelSettingsReducer as models, selectModelSettings, type ModelSettingsState } from '../src/lib/settings-models.ts';
import { connectReducer as connect, initialConnectState, selectConnect } from '../src/lib/connect.ts';
import { skillDetailInteractionReducer as skill, selectSkillDetail } from '../src/lib/skill-detail.ts';

const defaults = { default_model: 'one', default_reasoning_effort: 'medium' };
const changed = { default_model: 'two', default_reasoning_effort: 'high' };
const editing = (): ModelSettingsState => models({ status: 'overview' }, { type: 'opened', current: defaults });
const operation = (status: EditorOperation['status'], values: Partial<EditorOperation> = {}): EditorOperation => ({ operationId: 'save', resource: 'settings', action: 'save', status, error: '', reconciled: false, ...values });

test('settings.S1 显式切换防重、旧结果无效，确认后结束忙态', () => {
  const idle = { status: 'idle' as const };
  const switching = settingsSwitchReducer(idle, { type: 'switch-started', operationId: 'new' });
  assert.equal(selectSettingsPage(switching, true, null, []).busy, true);
  assert.strictEqual(settingsSwitchReducer(switching, { type: 'switch-started', operationId: 'duplicate' }), switching);
  assert.strictEqual(settingsSwitchReducer(switching, { type: 'switch-succeeded', operationId: 'old' }), switching);
  assert.deepEqual(settingsSwitchReducer(switching, { type: 'switch-succeeded', operationId: 'new' }), idle);
});
test('settings.S2 切换失败结束忙态并允许再次切换', () => {
  const failed = settingsSwitchReducer({ status: 'switching', operationId: 'write' }, { type: 'switch-failed', operationId: 'write' });
  assert.equal(selectSettingsPage(failed, true, null, []).busy, false);
  assert.equal(settingsSwitchReducer(failed, { type: 'switch-started', operationId: 'retry' }).status, 'switching');
});
test('settings.S3 离线只影响联网入口，连接提示优先于读取失败；有旧内容才标过期', () => {
  const idle = { status: 'idle' as const };
  assert.deepEqual(selectSettingsPage(idle, false, 'reconnecting', [{ data: undefined, error: new Error() }]), { busy: false, disabled: true, message: 'reconnecting', dismissible: false, stale: true });
  assert.equal(selectSettingsPage(idle, true, null, [{ data: undefined, error: new Error() }]).stale, false);
  assert.equal(selectSettingsPage(idle, true, null, [{ data: {}, error: new Error() }]).stale, true);
});

test('settings-models.M1 打开时命名采纳当前实际设置；编辑不改原值；关闭丢弃本地选择', () => {
  const state = models(editing(), { type: 'changed', fields: changed });
  assert.equal(selectModelSettings(state, false).dirty, true);
  assert.deepEqual(state.status !== 'overview' && state.original, defaults);
  assert.deepEqual(models(state, { type: 'closed' }), { status: 'overview' });
});
test('settings-models.M2 保存中拒绝编辑、关闭和旧结果，匹配成功换基线并可返回', () => {
  const state = models(models(editing(), { type: 'changed', fields: changed }), { type: 'save-started', operationId: 'save' });
  assert.strictEqual(models(state, { type: 'changed', fields: defaults }), state);
  assert.strictEqual(models(state, { type: 'closed' }), state);
  assert.strictEqual(models(state, { type: 'save-succeeded', operationId: 'old', current: defaults }), state);
  const saved = models(state, { type: 'save-succeeded', operationId: 'save', current: changed });
  assert.equal(selectModelSettings(saved, false).dirty, false);
  assert.deepEqual(selectModelSettings(saved, false).draft, changed);
});
test('settings-models.M3 明确失败恢复原值，停留报错，下一次返回无修改', () => {
  const state = models(models(editing(), { type: 'changed', fields: changed }), { type: 'save-started', operationId: 'save' });
  const failed = models(state, { type: 'save-failed', operationId: 'save', message: 'rejected' });
  assert.equal(selectModelSettings(failed, false).error, 'rejected');
  assert.equal(selectModelSettings(failed, false).dirty, false);
  assert.deepEqual(selectModelSettings(failed, false).draft, defaults);
});
test('settings-models.M4 离线可改不能提交，返回校验失败恢复原值而不是锁住离开', () => {
  const changedState = models(editing(), { type: 'changed', fields: changed });
  const offline = selectModelSettings(changedState, true);
  assert.equal(offline.canEdit, true); assert.equal(offline.canSave, false);
  const rejected = models(changedState, { type: 'rejected', message: 'offline' });
  assert.equal(selectModelSettings(rejected, true).dirty, false);
  assert.deepEqual(models(rejected, { type: 'closed' }), { status: 'overview' });
});
test('settings-models.M5 unknown优先本地saving；只读、可离开；重入不恢复提交稿', () => {
  const saving = models(models(editing(), { type: 'changed', fields: changed }), { type: 'save-started', operationId: 'save' });
  const unknown = selectModelSettings(saving, false, operation('unknown'));
  assert.equal(unknown.busy, false); assert.equal(unknown.canSave, false); assert.equal(unknown.canEdit, false);
  const left = models(saving, { type: 'unknown-left', operationId: 'save' });
  assert.deepEqual(left, { status: 'overview' });
  assert.deepEqual(selectModelSettings(models(left, { type: 'opened', current: defaults }), false, operation('unknown')).draft, defaults);
});
test('settings-models.M6 核对实际值一次采纳闭环；不认同字段为提交成功，不重放或覆盖后续选择', () => {
  const saving = models(models(editing(), { type: 'changed', fields: changed }), { type: 'save-started', operationId: 'save' });
  const recovery = operation('synced', { reconciled: true, value: defaults });
  const pending = selectModelSettings(saving, false, recovery);
  assert.ok(pending.adoption); assert.equal(pending.canEdit, false);
  const adopted = models(saving, pending.adoption);
  assert.equal(selectModelSettings(adopted, false, recovery).adoption, undefined);
  assert.equal(selectModelSettings(adopted, false, recovery).dirty, false);
  assert.equal(selectModelSettings(adopted, false, recovery).notice, 'reconciled');
  const userChanged = models(adopted, { type: 'changed', fields: changed });
  assert.equal(selectModelSettings(userChanged, false, recovery).adoption, undefined);
  assert.deepEqual(selectModelSettings(userChanged, false, recovery).draft, changed);
  const nextVisit = models({ status: 'overview' }, { type: 'opened', current: defaults, seenRecoveryId: recovery.operationId });
  assert.equal(selectModelSettings(nextVisit, false, recovery).notice, undefined);
  assert.equal(selectModelSettings(nextVisit, false, recovery).adoption, undefined);
});
test('settings-models.M7 旧核对不能覆盖新操作；overview不接受迟到结果', () => {
  const saving = models(editing(), { type: 'save-started', operationId: 'current' });
  assert.equal(selectModelSettings(saving, false, operation('synced', { operationId: 'old', reconciled: true, value: changed })).adoption, undefined);
  const overview = { status: 'overview' as const };
  assert.strictEqual(models(overview, { type: 'save-failed', operationId: 'old', message: 'ignored' }), overview);
});

const idleExchange = { phase: 'idle' as const, error: '' };
test('settings-connect.P1 聚焦重置访问页面与临时错误，字段仍属本次访问', () => {
  const manual = connect(initialConnectState('server'), { type: 'page', page: 'manual' });
  const entered = connect(manual, { type: 'field', field: 'code', value: 'PAIRCODE' });
  const failed = connect(entered, { type: 'error', message: 'invalid' });
  const focused = connect(failed, { type: 'focused' });
  assert.equal(focused.page, 'landing'); assert.equal(focused.error, ''); assert.equal(focused.code, 'PAIRCODE');
});
test('settings-connect.P2 相机权限结果认操作身份，拒绝或相机失败转手动并说明恢复', () => {
  const pending = connect(initialConnectState(), { type: 'permission-started', operationId: 'permission' });
  assert.strictEqual(connect(pending, { type: 'permission-finished', operationId: 'old', granted: true, message: '' }), pending);
  assert.equal(connect(pending, { type: 'permission-finished', operationId: 'permission', granted: true, message: '' }).page, 'scan');
  const denied = connect(pending, { type: 'permission-finished', operationId: 'permission', granted: false, message: 'denied' });
  assert.equal(denied.page, 'manual'); assert.equal(denied.error, 'denied');
});
test('settings-connect.P3 本地停止等待不释放应用兑换槽，旧结果不能回写新访问', () => {
  const pending = connect(initialConnectState(), { type: 'connect-started', operationId: 'exchange' });
  const cancelled = connect(pending, { type: 'cancelled' });
  assert.equal(cancelled.status, 'ready');
  assert.equal(selectConnect(cancelled, { phase: 'exchanging', error: '' }).busy, true);
  assert.strictEqual(connect(cancelled, { type: 'finished', operationId: 'exchange' }), cancelled);
});
test('settings-connect.P4 开发连接探测可取消，开始持久化后不能取消或切页，焦点重放不丢保存结果', () => {
  const probing = connect(initialConnectState(), { type: 'development-started', operationId: 'dev' });
  assert.equal(selectConnect(probing, idleExchange).canCancel, true);
  const saving = connect(probing, { type: 'development-saving', operationId: 'dev' });
  assert.equal(selectConnect(saving, idleExchange).saving, true);
  assert.strictEqual(connect(saving, { type: 'cancelled' }), saving);
  assert.strictEqual(connect(saving, { type: 'page', page: 'manual' }), saving);
  const refocused = connect(saving, { type: 'focused' });
  assert.equal(refocused.status, 'development-save');
  assert.equal(connect(refocused, { type: 'finished', operationId: 'dev' }).status, 'ready');
});
test('settings-connect.P5 全局保存阶段优先本地ready，离屏错误从唯一owner呈现', () => {
  const state = initialConnectState();
  assert.equal(selectConnect(state, { phase: 'saving', error: '' }).canChangePage, false);
  assert.equal(selectConnect(state, { phase: 'idle', error: 'secure save failed' }).error, 'secure save failed');
});
test('settings-connect.P6 七次开发入口只改本地路由；重试扫描只清本地错误', () => {
  let state = initialConnectState();
  for (let index = 0; index < 6; index++) state = connect(state, { type: 'development-tapped' });
  assert.equal(state.page, 'landing');
  state = connect(state, { type: 'development-tapped' }); assert.equal(state.page, 'development');
  assert.equal(connect(connect(state, { type: 'error', message: 'bad' }), { type: 'scan-retried' }).error, '');
});

test('settings-skills.U1 使用者弹层开关只改本地交互，重复事件不改变状态', () => {
  const content = { status: 'content' as const };
  const users = skill(content, { type: 'users-opened' });
  assert.strictEqual(skill(users, { type: 'users-opened' }), users);
  assert.deepEqual(skill(users, { type: 'users-closed' }), content);
});
test('settings-skills.U2 删除/不存在优先弹层；unknown禁删但不妨碍返回，失焦不显示旧弹层', () => {
  const users = { status: 'users' as const };
  const input = { gone: false, online: true, focused: true, users: 2 };
  const unknown = selectSkillDetail(users, { phase: 'unknown', users: [], error: '' }, input);
  assert.equal(unknown.canDelete, false); assert.equal(unknown.gone, false);
  const gone = selectSkillDetail(users, { phase: 'deleted', users: [], error: '' }, input);
  assert.equal(gone.usersOpen, false); assert.equal(gone.dialog, null); assert.equal(gone.canDelete, false);
  assert.equal(selectSkillDetail(users, { phase: 'confirm', users: [], error: '' }, { ...input, focused: false }).dialog, null);
});
test('settings.S4 只有本页切换失败（访问内的一次性结果）可关闭；连接 / 读取提示不可关闭，切换失败优先显示', () => {
  const idle = { status: 'idle' as const };
  const failed = selectSettingsPage(idle, true, '连接断开，正在重连…', [], '切换服务器失败，请重试。');
  assert.equal(failed.message, '切换服务器失败，请重试。');
  assert.equal(failed.dismissible, true);
  assert.equal(failed.stale, false);
  assert.equal(selectSettingsPage(idle, false, '连接断开，正在重连…', []).dismissible, false);
  assert.equal(selectSettingsPage(idle, true, null, [{ error: new Error('x'), data: undefined }]).dismissible, false);
});
