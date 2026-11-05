import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayError, type Connector } from '../src/gateway/api.ts';
import { catalogConnectHint, connectorAuthMethodLabel, connectorHomeReducer, connectorListReadFailed, connectorListRowState, connectorUrlHost, initialConnectorHome, selectConnectorHome } from '../src/lib/connector-list-state.ts';
const connector: Connector = {
  id: 'docs', name: '资料库', description: 'Search Notes', auth_type: 'oauth', app_id: null,
  auth: { status: 'authorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'connected', error: null,
  tool_count: 12, used_by: [{ id: 'agent', name: '助手' }], pending_restart: false,
};
const external = { apps: { data: { apps: [] }, error: null, fetchStatus: 'idle' as const },
  connectors: { data: { connectors: [connector] }, error: null, fetchStatus: 'idle' as const }, connectionBannerVisible: false };
test('connectors-home.HT1 分段切换保留搜索，不改变服务器快照', () => {
  const state = { ...initialConnectorHome, query: 'notes' };
  const next = connectorHomeReducer(state, { type: 'tab', tab: 'added' });
  assert.equal(next.query, 'notes'); assert.equal(next.tab, 'added');
  assert.deepEqual(selectConnectorHome(next, external).connectors, [connector]);
});
test('connectors-home.HT2 大小写搜索名称和说明，清空恢复全部', () => {
  const state = connectorHomeReducer({ ...initialConnectorHome, tab: 'added' }, { type: 'search', query: ' NOTES ' });
  assert.deepEqual(selectConnectorHome(state, external).connectors, [connector]);
  assert.equal(selectConnectorHome({ ...state, query: '不存在' }, external).emptyLabel, '没有找到连接器');
  assert.deepEqual(selectConnectorHome(connectorHomeReducer(state, { type: 'search', query: '' }), external).connectors, [connector]);
});
test('connectors-home.H3 授权优先于传输失败，摘要不透出原始错误', () => {
  assert.equal(connectorListRowState(connector).kind, 'connected');
  for (const status of ['unauthorized', 'reauthorization_required'] as const) {
    assert.equal(connectorListRowState({ ...connector, app_id: 'github', status: 'failed', error: 'private-token', auth: { ...connector.auth, status } }).label, '需要授权');
  }
  assert.equal(connectorListRowState({ ...connector, auth_type: 'none', auth: { ...connector.auth, status: 'unauthorized' } }).kind, 'connected');
  assert.equal(connectorListRowState({ ...connector, auth_type: 'key', headers: {}, status: 'disconnected' }).label, '需要授权');
  assert.equal(connectorListRowState({ ...connector, auth_type: 'key', headers: { Authorization: true }, status: 'failed' }).label, '连接失败');
});
test('connectors-home.HT3 首载不当空，刷新失败保留旧内容，paused 不当错误', () => {
  const state = { ...initialConnectorHome, tab: 'added' as const };
  assert.equal(selectConnectorHome(state, { ...external, connectors: { data: undefined, error: null, fetchStatus: 'fetching' } }).loading, true);
  const stale = selectConnectorHome(state, { ...external, connectors: { ...external.connectors, error: new Error('failed') } });
  assert.equal(stale.stale, true); assert.equal(stale.empty, false); assert.deepEqual(stale.connectors, [connector]);
  const paused = selectConnectorHome(state, { ...external, connectors: { data: undefined, error: null, fetchStatus: 'paused' } });
  assert.equal(paused.loading, false); assert.equal(paused.empty, false); assert.equal(paused.readFailed, false);
});
test('connectors-home.H5 H6 连接横幅实际可见前任何读取失败均有提示', () => {
  for (const error of [new TypeError('network'), ...[0, 408, 500, 502, 503, 504].map(status => new GatewayError(status, 'network', 'private'))]) {
    assert.equal(connectorListReadFailed(error, false), true); assert.equal(connectorListReadFailed(error, true), false);
  }
  assert.equal(connectorListReadFailed(null, false), false);
});

test('connector-auth.AU1 未绑定目录：授权方式与详情同一叫法，服务地址只显示主机名', () => {
  assert.deepEqual((['oauth', 'device', 'key', 'none'] as const).map(connectorAuthMethodLabel), ['OAuth', '短码授权', '密钥', '无需认证']);
  assert.equal(connectorUrlHost('https://mcp.notion.com/mcp'), 'mcp.notion.com');
  assert.equal(connectorUrlHost('https://api.githubcopilot.com/mcp/'), 'api.githubcopilot.com');
  assert.equal(connectorUrlHost('https://user:pw@example.invalid:8443/a?b#c'), 'example.invalid:8443');
});
test('connector-auth.AU1 / AU10 当前步骤提示：OAuth、短码与 key 可连接，none 未启用', () => {
  assert.deepEqual(catalogConnectHint('oauth'), { text: '将打开浏览器登录 {name} 并授权。', enabled: true });
  assert.deepEqual(catalogConnectHint('device'), { text: '将显示一个短码，在 {name} 网页上输入后完成授权。', enabled: true });
  assert.deepEqual(catalogConnectHint('key'), { text: '连接后填写 {name} 的 Key。', enabled: true });
  assert.equal(catalogConnectHint('none').enabled, false);
  assert.equal(catalogConnectHint('none').text, '目录暂未启用这种连接方式');
});
