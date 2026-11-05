import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayError, createResultUnknown, type Connector } from '../src/gateway/api.ts';
import { ChatSession } from '../src/gateway/session.ts';
import { blankConnectorParameters, connectorParameterFields, keyParametersFromConnector, parametersFromConnector, parseConnectorCommand } from '../src/lib/connector-add.ts';
import { connectorMetadataFields } from '../src/lib/connector-detail.ts';
import { connectorListRowState } from '../src/lib/connector-list-state.ts';
import { connectorStatus } from '../src/lib/connectors.ts';
import { connectorSettingsSummary } from '../src/lib/settings-summary.ts';
const remote: Connector = { id: 'docs', name: '资料库', description: '说明', url: 'https://example.com/mcp', transport: 'streamable-http',
  headers: { Authorization: true }, auth_type: 'key', app_id: null, auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] },
  status: 'connected', error: null, tool_count: 2, used_by: [], pending_restart: false };
test('connector-add.N2 N9 添加不提交名称说明、Agent 或隐藏 OAuth 请求头', () => {
  const draft = { ...blankConnectorParameters('remote'), url: remote.url!, auth: 'oauth' as const };
  draft.headers.push({ key: '', value: '', existing: false, deleted: false });
  assert.deepEqual(connectorParameterFields(draft), { url: remote.url, auth_type: 'oauth' });
  assert.deepEqual(connectorParameterFields({ ...draft, auth: 'none' }), { url: remote.url, auth_type: 'none' });
  assert.deepEqual(connectorParameterFields({ ...draft, auth: 'key', headers: [{ key: 'Authorization', value: 'Bearer key', existing: false, deleted: false }] }), { url: remote.url, auth_type: 'key', headers: { Authorization: 'Bearer key' } });
});
test('connector-add.N3 引号转义和空参数不经 shell，未闭合拒绝', () => {
  assert.deepEqual(parseConnectorCommand(`npx -y 'with space' "" escaped\\ space 'a'\\''b'`), ['npx', '-y', 'with space', '', 'escaped space', "a'b"]);
  assert.throws(() => parseConnectorCommand(`npx 'unfinished`), /未结束/);
  assert.throws(() => parseConnectorCommand('npx trailing\\'), /未结束/);
  const original = { ...remote, auth_type: 'none' as const, url: undefined, headers: undefined, command: 'npx', args: ['line\nbreak', 'literal\r', '', "a'b", 'end\r\n'] };
  const draft = parametersFromConnector(original);
  assert.deepEqual(connectorParameterFields(draft, original), {});
  const fields = connectorParameterFields({ ...draft, commandLine: `${draft.commandLine} new` }, original);
  assert.deepEqual(fields, { args: [...original.args, 'new'] });
});
test('connector-detail.D12 密钥只写，保留原始键名，显式删除才提交 null', () => {
  const original: Connector = { ...remote, headers: { ' X-Region ': true, Authorization: true } };
  const draft = parametersFromConnector(original);
  assert.deepEqual(connectorParameterFields(draft, original), {});
  draft.headers[0].value = 'rotated'; draft.headers[1].deleted = true;
  draft.headers.push({ key: ' X-New ', value: 'new-secret', existing: false, deleted: false });
  assert.deepEqual(connectorParameterFields(draft, original), { headers: { ' X-Region ': 'rotated', Authorization: null, 'X-New': 'new-secret' } });
});
test('connector-detail.D12 改为无需认证时删除原密钥，不提交隐藏的未完成输入', () => {
  const draft = parametersFromConnector(remote);
  draft.auth = 'none'; draft.headers.push({ key: '', value: '', existing: false, deleted: false });
  assert.deepEqual(connectorParameterFields(draft, remote), { auth_type: 'none', headers: { Authorization: null } });
});
test('connector-detail.D5 DT2 资料增量提交，独立修改合并，同字段冲突拒绝', () => {
  assert.deepEqual(connectorMetadataFields(remote, '本地名称', remote.description, { ...remote, description: '外部说明' }), { name: '本地名称' });
  assert.throws(() => connectorMetadataFields(remote, '本地名称', remote.description, { ...remote, name: '外部名称' }), /重新打开/);
  assert.deepEqual(connectorMetadataFields(remote, remote.name, remote.description, remote), {});
});
test('connector-detail.D12 同方式独立字段安全合并，只检查改动的密钥键', () => {
  const draft = parametersFromConnector(remote); draft.url = 'https://example.com/new';
  assert.deepEqual(connectorParameterFields(draft, remote, { ...remote, headers: { Authorization: true, REMOTE: true } }), { url: draft.url });
  assert.throws(() => connectorParameterFields(draft, remote, { ...remote, url: 'https://other.example/mcp' }), /重新打开/);
  const secret = parametersFromConnector(remote); secret.headers.push({ key: 'LOCAL', value: 'new', existing: false, deleted: false });
  assert.deepEqual(connectorParameterFields(secret, remote, { ...remote, headers: { Authorization: true, REMOTE: true } }), { headers: { LOCAL: 'new' } });
  assert.throws(() => connectorParameterFields(secret, remote, { ...remote, headers: { Authorization: true, LOCAL: true } }), /重新打开/);
});
test('connector-add.N5 不含账号密码的地址、重复键和空命令均拒绝', () => {
  assert.throws(() => connectorParameterFields({ ...blankConnectorParameters('remote'), url: 'https://user:pass@example.com' }), /HTTP/);
  assert.throws(() => connectorParameterFields(blankConnectorParameters('local')), /命令/);
  const draft = { ...blankConnectorParameters('remote'), url: remote.url!, auth: 'key' as const };
  draft.headers[0].value = 'Bearer valid-key';
  draft.headers.push({ ...draft.headers[0] });
  assert.throws(() => connectorParameterFields(draft), /不重复/);
});
test('网络和不确定响应区别于明确字段拒绝', () => {
  assert.equal(createResultUnknown(new GatewayError(0, 'offline', '断线')), true);
  assert.equal(createResultUnknown(new GatewayError(503, 'unavailable', '不可用')), true);
  assert.equal(createResultUnknown(new GatewayError(400, 'invalid_request', '非法字段')), false);
});
test('connectors-home.HT5 资源与 Agent 引用事件更新连接器 revision、删除可观察', async () => {
  const session = new ChatSession({ baseUrl: 'http://unused', token: 'dev' });
  try {
    session.connectorChanged({ seq: 1, type: 'resource.changed', at: 1, data: { kind: 'connector', id: 'docs', op: 'created' } });
    session.connectorChanged({ seq: 2, type: 'resource.changed', at: 2, data: { kind: 'agent', id: 'agent', op: 'updated' } });
    session.connectorChanged({ seq: 3, type: 'resource.changed', at: 3, data: { kind: 'connector', id: 'docs', op: 'deleted' } });
    assert.equal(session.connectorRevision, 3); assert.equal(session.deletedConnectorIds.has('docs'), true);
  } finally { await session.close(); }
});

test('重启后未使用连接器为中性未连接，明确失败才进入列表和设置失败计数', () => {
  const dormant: Connector = { ...remote, status: 'disconnected', error: null };
  const failed: Connector = { ...dormant, id: 'failed', error: '连接超时' };
  assert.deepEqual(connectorListRowState(dormant), { kind: 'disconnected', label: '未连接', failed: false });
  assert.deepEqual(connectorListRowState(failed), { kind: 'failure', label: '连接失败', failed: true });
  assert.deepEqual(connectorSettingsSummary([dormant]), { text: '1', danger: false });
  assert.deepEqual(connectorSettingsSummary([dormant, failed]), { text: '1 个失败 · 共 2', danger: true });
});

test('Agent 选择保留连接失败原因与无人使用说明，显式错误不被 disconnected 隐藏', () => {
  assert.deepEqual(connectorStatus({ ...remote, status: 'failed', error: '连接超时' }), { label: '连接失败：连接超时', failed: true });
  assert.deepEqual(connectorStatus({ ...remote, status: 'disconnected', error: '连接超时' }), { label: '连接失败：连接超时', failed: true });
  assert.deepEqual(connectorStatus({ ...remote, status: 'disconnected', error: null }), { label: '没有 Agent 使用，不会连接', failed: false });
  assert.deepEqual(connectorStatus({ ...remote, status: 'disconnected', used_by: [{ id: 'agent', name: '助手' }] }), { label: '未连接', failed: false });
});

test('参数编辑按来源显示自动，重设自动明确提交 null，不能用省略假装恢复自动', () => {
  const automatic = { ...remote, transport_source: 'auto' as const };
  assert.equal(parametersFromConnector(automatic).transport, 'auto');
  assert.deepEqual(connectorParameterFields(parametersFromConnector(automatic), automatic), {});
  const fixed = { ...remote, transport_source: 'user' as const, transport: 'sse' };
  const reset = { ...parametersFromConnector(fixed), transport: 'auto' };
  assert.deepEqual(connectorParameterFields(reset, fixed), { transport: null });
  assert.deepEqual(connectorParameterFields({ ...reset, url: 'https://example.com/other' }, fixed), { url: 'https://example.com/other', transport: null });
  const remoteFixed = { ...automatic, transport_source: 'user' as const };
  assert.throws(() => connectorParameterFields({ ...parametersFromConnector(automatic), transport: 'sse' }, automatic, remoteFixed), /重新打开/);
});

test('添加密钥不能只有 Bearer 模板；OAuth 自动推断 SSE 时在发请求前拒绝', () => {
  const draft = { ...blankConnectorParameters('remote'), url: remote.url!, auth: 'key' as const };
  assert.throws(() => connectorParameterFields(draft));
  assert.throws(() => connectorParameterFields({ ...draft, auth: 'oauth', url: 'https://example.com/events/sse' }));
  assert.deepEqual(connectorParameterFields({ ...draft, auth: 'oauth', url: 'https://example.com/events/sse', transport: 'streamable-http' }), {
    url: 'https://example.com/events/sse', auth_type: 'oauth', transport: 'streamable-http',
  });
});
test('connector-auth.AU10 目录 key 连接器只写目录声明的 Key，不提交网址、认证方式或传输', () => {
  const bound: Connector = { ...remote, app_id: 'amap', url: 'https://mcp.amap.com/mcp', transport_source: 'auto', headers: {} };
  const draft = keyParametersFromConnector(bound, 'key');
  assert.deepEqual(draft.headers, [{ key: 'key', value: '', existing: false, deleted: false }]);
  assert.throws(() => connectorParameterFields(draft, bound), /请填写密钥值/);
  assert.deepEqual(connectorParameterFields({ ...draft, headers: [{ ...draft.headers[0], value: 'amap-secret' }] }, bound), { headers: { key: 'amap-secret' } });
  const saved: Connector = { ...bound, headers: { key: true } };
  const existing = keyParametersFromConnector(saved, 'key');
  assert.equal(existing.headers[0].existing, true);
  assert.deepEqual(connectorParameterFields(existing, saved), {});
});
