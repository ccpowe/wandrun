import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayError, type Connector } from '../src/gateway/api.ts';
import type { EditorOperation } from '../src/gateway/editor-operation.ts';
import { blankConnectorParameters, connectorAddReducer, connectorCreateFailure, selectConnectorAdd, type ConnectorAddEvent, type ConnectorAddState } from '../src/lib/connector-add.ts';
import { connectorDetailReducer, initialConnectorDetail, selectConnectorDetail, type ConnectorDetailState } from '../src/lib/connector-detail.ts';
const row: Connector = { id: 'docs', name: 'Notes', description: 'Original', url: 'https://example.com', auth_type: 'none', app_id: null, auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] }, status: 'connected', error: null, tool_count: 1, used_by: [], pending_restart: false };
const editing: ConnectorAddState = { status: 'editing', draft: { ...blankConnectorParameters('remote'), url: row.url! }, authTouched: false, error: '' };
const external = { deleted: false, offline: false, authorizing: false };
const operation = (status: EditorOperation['status'], extra: Partial<EditorOperation> = {}): EditorOperation => ({ operationId: 'current', resource: 'connector', id: 'docs', action: 'save', status, error: '', reconciled: false, ...extra });
test('connector-add.NT1 修改认证隐藏头但保留本页输入，清旧错误', () => {
  const next = connectorAddReducer({ ...editing, error: 'old' }, { type: 'change', fields: { auth: 'oauth' }, authTouched: true });
  assert.equal(next.status === 'editing' && next.draft.auth, 'oauth'); assert.equal(next.status === 'editing' && next.authTouched, true);
});
test('connector-add.NT2 探测旧响应和重复响应不盖用户选择', () => {
  let state = connectorAddReducer(editing, { type: 'probe-started', id: 'one', key: 'url' });
  assert.equal(connectorAddReducer(state, { type: 'probe-finished', id: 'old', key: 'url', result: { result: 'key', transport: 'http' } }), state);
  state = connectorAddReducer(state, { type: 'change', fields: { auth: 'none' }, authTouched: true });
  state = connectorAddReducer(state, { type: 'probe-finished', id: 'one', key: 'url', result: { result: 'key', transport: 'http' } });
  assert.equal(state.status === 'editing' && state.draft.auth, 'none');
  assert.equal(connectorAddReducer(state, { type: 'probe-finished', id: 'one', key: 'url', result: { result: 'oauth', transport: 'http' } }), state);
});
test('connector-add.NT3 连接中重复命令和草稿修改无效', () => {
  const state = connectorAddReducer(editing, { type: 'connect', operationId: 'current' });
  assert.equal(connectorAddReducer(state, { type: 'connect', operationId: 'second' }), state);
  assert.equal(connectorAddReducer(state, { type: 'change', fields: { url: 'other' } }), state);
});
test('connector-add.NT4 只有当前创建成功能进入真实详情，失败保留输入', () => {
  const state = connectorAddReducer(editing, { type: 'connect', operationId: 'current' });
  assert.equal(connectorAddReducer(state, { type: 'created', operationId: 'old', id: 'old' }), state);
  assert.deepEqual(connectorAddReducer(state, { type: 'created', operationId: 'current', id: 'new' }), { status: 'created', id: 'new' });
  const failed = connectorAddReducer(state, { type: 'failed', operationId: 'current', message: 'failed' });
  assert.equal(failed.status === 'editing' && failed.draft.url, row.url);
});
test('connector-add.NT5 NT6 unknown 禁重提但不是 busy，核对只接精确 id', () => {
  const connecting = connectorAddReducer(editing, { type: 'connect', operationId: 'current' });
  const selected = selectConnectorAdd(connecting, operation('unknown', { id: undefined }), false);
  assert.equal(selected.canSubmit, false); assert.equal(selected.pending, false); assert.equal(selected.recoveredId, undefined);
  assert.equal(selectConnectorAdd(connecting, operation('confirmed', { reconciled: true, id: 'exact', value: row }), false).recoveredId, 'exact');
  assert.equal(selectConnectorAdd(editing, undefined, true).canSubmit, false);
});
test('connector-add.N5 N8 认证不符提供切换方式，写前连接失败只公开探测的安全原因', () => {
  const mismatch = connectorCreateFailure(new GatewayError(409, 'authentication_mismatch', 'private', { probe: { result: 'oauth' } }));
  assert.equal(mismatch.suggestion, 'oauth');
  const failure = connectorCreateFailure(new GatewayError(502, 'connection_failed', 'private', { probe: { result: 'failed', error: { code: 'connection_failed', message: '请求超时' } } }));
  assert.equal(failure.reason, '请求超时'); assert.equal(failure.suggestion, undefined);
});
test('connector-detail.DT1 普通外部快照不盖资料草稿', () => {
  const state = connectorDetailReducer(initialConnectorDetail, { type: 'metadata', connector: row });
  const edited = connectorDetailReducer(state, { type: 'change-metadata', name: 'Local' });
  assert.equal(connectorDetailReducer(edited, { type: 'metadata', connector: { ...row, name: 'External' } }), edited);
});
test('connector-detail.DT2 取消不写，保存携带操作身份且禁重复', () => {
  const state = connectorDetailReducer(initialConnectorDetail, { type: 'metadata', connector: row });
  assert.equal(connectorDetailReducer(state, { type: 'cancel' }).status, 'ready');
  const pending = connectorDetailReducer(state, { type: 'command', action: 'save', operationId: 'current' });
  assert.equal(connectorDetailReducer(pending, { type: 'command', action: 'save', operationId: 'other' }), pending);
});
test('connector-detail.DT3 迟到结果不关闭新操作，明确失败保留资料', () => {
  const editing = connectorDetailReducer(initialConnectorDetail, { type: 'metadata', connector: row });
  const pending = connectorDetailReducer(editing, { type: 'command', action: 'save', operationId: 'current' });
  assert.equal(connectorDetailReducer(pending, { type: 'finished', operationId: 'old' }), pending);
  assert.equal(connectorDetailReducer(pending, { type: 'failed', operationId: 'current', message: 'failed' }).status, 'metadata');
});
test('connector-detail.DT4 核对采纳一次收敛，不把旧草稿重新显示', () => {
  const state = connectorDetailReducer(initialConnectorDetail, { type: 'metadata', connector: row });
  const outcome = operation('synced', { reconciled: true, value: { ...row, name: 'Actual' } });
  const selected = selectConnectorDetail(state, { ...external, outcome });
  assert.ok(selected.recovery); assert.equal(selected.canWrite, false);
  const next = connectorDetailReducer(state, selected.recovery!);
  assert.equal(next.status, 'ready'); assert.equal(selectConnectorDetail(next, { ...external, outcome }).recovery, undefined);
});
test('connector-detail.DT5 删除检查失败不打开空影响确认', () => {
  const checking = connectorDetailReducer(initialConnectorDetail, { type: 'check-delete', operationId: 'current' });
  const failed = connectorDetailReducer(checking, { type: 'failed', operationId: 'current', message: 'failed' });
  assert.equal(failed.status, 'ready');
  const confirmed = connectorDetailReducer(checking, { type: 'checked-delete', operationId: 'current', agents: [{ id: 'a', name: 'Agent' }] });
  assert.equal(confirmed.status === 'confirm-delete' && confirmed.agents[0].name, 'Agent');
});
test('connector-detail.DT6 删除单飞，未知隐藏旧确认且恢复不重放', () => {
  const confirm: ConnectorDetailState = { ...initialConnectorDetail, status: 'confirm-delete', agents: [], error: '' };
  const pending = connectorDetailReducer(confirm, { type: 'command', action: 'delete', operationId: 'current' });
  const selected = selectConnectorDetail(pending, { ...external, outcome: operation('unknown') });
  assert.equal(selected.unknown, true); assert.equal(selected.busy, false); assert.equal(selected.canDelete, false);
  assert.equal(connectorDetailReducer(pending, { type: 'finished', operationId: 'current', deleted: true }).status, 'closed');
});
test('connector-detail.DT7 墓碑优先 unknown，closed 不被迟到结果复活', () => {
  assert.equal(selectConnectorDetail(initialConnectorDetail, { ...external, deleted: true, outcome: operation('unknown') }).gone, true);
  const editing = connectorDetailReducer(initialConnectorDetail, { type: 'metadata', connector: row });
  assert.equal(selectConnectorDetail(editing, { ...external, deleted: true }).display.status, 'closed');
  const closed: ConnectorDetailState = { ...initialConnectorDetail, status: 'closed' };
  assert.equal(connectorDetailReducer(closed, { type: 'adopt-recovery', operationId: 'later', exists: true }), closed);
});
test('connector-detail.DT8 工具展开和 Agent 子页只有本地转换，离线仍能返回', () => {
  const expanded = connectorDetailReducer(initialConnectorDetail, { type: 'toggle-tools' });
  assert.equal(expanded.expanded, true);
  const agents = connectorDetailReducer(expanded, { type: 'panel', panel: 'agents' });
  assert.equal(agents.status === 'ready' && agents.panel, 'agents');
  assert.equal(selectConnectorDetail(agents, { ...external, offline: true }).busy, false);
});
test('connector-detail.D11 DT9 断开只在 ready 接受，不能越过保存或删除确认的状态门', () => {
  assert.equal(connectorDetailReducer(initialConnectorDetail, { type: 'command', action: 'save', operationId: 'save' }), initialConnectorDetail);
  assert.equal(connectorDetailReducer(initialConnectorDetail, { type: 'command', action: 'delete', operationId: 'delete' }), initialConnectorDetail);
  const pending = connectorDetailReducer(initialConnectorDetail, { type: 'command', action: 'disconnect', operationId: 'clear-key' });
  assert.equal(pending.status, 'command');
  assert.equal(connectorDetailReducer(pending, { type: 'command', action: 'disconnect', operationId: 'repeat' }), pending);
  assert.equal(connectorDetailReducer(pending, { type: 'finished', operationId: 'old' }), pending);
  assert.equal(connectorDetailReducer(pending, { type: 'finished', operationId: 'clear-key' }).status, 'ready');
});

for (const result of ['not-created', 'created-then-missing'] as const) {
  test(`connector-add.S1 核对${result}后采纳结果回到可编辑表单，不永久留在connecting`, () => {
    const connecting = connectorAddReducer(editing, { type: 'connect', operationId: 'current' });
    const outcome = operation(result === 'not-created' ? 'failed' : 'synced', {
      id: result === 'not-created' ? undefined : 'docs', reconciled: true, value: null,
    });
    // Match the existing detail selector contract: a named, identity-checked adoption event.
    // The selector must not turn "no resource" into a successful navigation target.
    type Selection = { unknown: boolean; pending: boolean; canSubmit: boolean; canEdit: boolean; recoveredId?: string; recovery?: ConnectorAddEvent };
    const selected: Selection = selectConnectorAdd(connecting, outcome, false);
    assert.equal(selected.unknown, false);
    assert.equal(selected.pending, false);
    assert.equal(selected.recoveredId, undefined);
    assert.ok(selected.recovery, '核对不存在必须提供当前创建的表单恢复事件');
    const next = connectorAddReducer(connecting, selected.recovery);
    assert.equal(next.status, 'editing', '明确不存在不是connecting，也不是created');
    assert.equal(next.status === 'editing' && next.draft, editing.status === 'editing' && editing.draft);
    assert.ok(next.status === 'editing' && next.error.length > 0, '应如实说明未创建或已不存在，而非假报成功');
    const ready: Selection = selectConnectorAdd(next, outcome, false);
    assert.equal(ready.canEdit, true);
    assert.equal(ready.canSubmit, true);
    assert.equal(ready.recovery, undefined, '同一终态只采纳一次，不重复覆盖用户修改');
    const newer = connectorAddReducer(editing, { type: 'connect', operationId: 'newer' });
    const stale: Selection = selectConnectorAdd(newer, outcome, false);
    assert.equal(stale.recovery, undefined, '旧核对不得终止较新的connecting');
    assert.equal(stale.canSubmit, false);
    const blank: Selection = selectConnectorAdd(editing, outcome, false);
    assert.equal(blank.recovery, undefined, '旧核对不得把新访问的空白表单当原操作恢复');
    assert.equal(blank.canSubmit, true);
  });
}

test('connector-add.NT2 密钥输入不清探测建议，地址或传输变化才作废探测', () => {
  let state = connectorAddReducer(editing, { type: 'probe-started', id: 'probe', key: 'url:auto' });
  state = connectorAddReducer(state, { type: 'probe-finished', id: 'probe', key: 'url:auto', result: { result: 'key', transport: 'streamable-http' } });
  const typed = connectorAddReducer(state, { type: 'change', fields: { headers: [{ key: 'Authorization', value: 'Bearer key', existing: false, deleted: false }] } });
  assert.equal(typed.status === 'editing' && typed.suggestion, 'key');
  for (const fields of [{ url: 'https://other.invalid' }, { transport: 'sse' }]) {
    const changed = connectorAddReducer(typed, { type: 'change', fields });
    assert.equal(changed.status === 'editing' && changed.suggestion, undefined);
    assert.equal(changed.status === 'editing' && changed.probedKey, undefined);
  }
});

test('connector-add.N9 已创建后的授权预读失败可重试，不接受其他资源的迟到结果', () => {
  const created: ConnectorAddState = { status: 'created', id: row.id };
  const checking = connectorAddReducer(created, { type: 'authorization-check', id: row.id });
  assert.equal(checking.status === 'created' && checking.authorization?.status, 'checking');
  assert.equal(connectorAddReducer(checking, { type: 'authorization-failed', id: 'old', message: 'old' }), checking);
  const failed = connectorAddReducer(checking, { type: 'authorization-failed', id: row.id, message: '读取失败' });
  assert.deepEqual(failed, { ...created, authorization: { status: 'failed', error: '读取失败' } });
  const retry = connectorAddReducer(failed, { type: 'authorization-check', id: row.id });
  assert.deepEqual(connectorAddReducer(retry, { type: 'authorization-ready', id: row.id }), { ...created, authorization: undefined });
});
test('connector-detail.DT-result 页面级失败不存进 reducer（由页面访问发布），弹层失败留在弹层', () => {
  const parameters = connectorDetailReducer(initialConnectorDetail, { type: 'parameters', connector: row, draft: blankConnectorParameters('remote') });
  const saving = connectorDetailReducer(parameters, { type: 'command', operationId: 'save', action: 'save' });
  const failed = connectorDetailReducer(saving, { type: 'failed', operationId: 'save', message: '保存未完成' });
  assert.equal(failed.status, 'parameters');
  assert.equal('error' in failed && failed.error, '');
  const metadata = connectorDetailReducer(initialConnectorDetail, { type: 'metadata', connector: row });
  const metaFailed = connectorDetailReducer(connectorDetailReducer(metadata, { type: 'command', operationId: 'm', action: 'save' }), { type: 'failed', operationId: 'm', message: '保存未完成' });
  assert.equal(metaFailed.status, 'metadata');
  assert.equal('error' in metaFailed && metaFailed.error, '保存未完成');
  const checking = connectorDetailReducer(initialConnectorDetail, { type: 'check-delete', operationId: 'c' });
  assert.deepEqual(connectorDetailReducer(checking, { type: 'failed', operationId: 'c', message: 'x' }), initialConnectorDetail);
});
