import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connector, OAuthStart } from '../src/gateway/api.ts';
import { connectorAuthorizationReducer, initialConnectorAuthorization, selectConnectorAuthorization } from '../src/lib/connector-authorization.ts';
const start: OAuthStart = { flow: 'authorization_code', transaction_id: 'current-gateway-transaction', authorization_url: 'https://authorize.invalid', expires_at: 100, redirect_uri: 'https://gateway.invalid/oauth/callback', manual_callback: false };
const connector: Connector = { id: 'notion', name: 'Notion', description: '', auth_type: 'oauth', app_id: 'notion', auth: { status: 'unauthorized', authorizing: true, transaction_id: 'current-gateway-transaction', scopes: [] }, status: 'disconnected', error: null, tool_count: 0, used_by: [], pending_restart: false };
const waiting = () => connectorAuthorizationReducer(connectorAuthorizationReducer(initialConnectorAuthorization, { type: 'start', operationId: 'current' }), { type: 'started', operationId: 'current', value: start });
test('connector-auth.AT1 AT3 授权请求单飞，旧 start 响应不能取得浏览器链接', () => {
  const busy = connectorAuthorizationReducer(initialConnectorAuthorization, { type: 'start', operationId: 'current' });
  assert.equal(connectorAuthorizationReducer(busy, { type: 'start', operationId: 'repeat' }), busy);
  assert.equal(connectorAuthorizationReducer(busy, { type: 'started', operationId: 'old', value: start }), busy);
  assert.equal(waiting().status, 'idle'); assert.equal(selectConnectorAuthorization(waiting(), connector).waiting, true);
  const restarting = connectorAuthorizationReducer(waiting(), { type: 'start', operationId: 'replacement' });
  assert.equal(restarting.flow, undefined);
  assert.equal(connectorAuthorizationReducer(restarting, { type: 'failed', operationId: 'replacement', message: 'unavailable' }).flow, undefined);
});
test('connector-auth.AT2 明确失败回 idle 保留当前错误，不造授权成功', () => {
  const busy = connectorAuthorizationReducer(initialConnectorAuthorization, { type: 'command', operationId: 'current' });
  const failed = connectorAuthorizationReducer(busy, { type: 'failed', operationId: 'current', message: 'denied' });
  assert.equal(failed.status === 'idle' && failed.error, 'denied'); assert.equal(selectConnectorAuthorization(failed, undefined).waiting, false);
});
test('connector-auth.AT4 浏览器返回不写授权事实，网关快照才结束等待', () => {
  const state = connectorAuthorizationReducer(waiting(), { type: 'native-result', flowId: 'current', notice: '' });
  assert.equal(selectConnectorAuthorization(state, connector).waiting, true);
  const complete = { ...connector, auth: { ...connector.auth, status: 'authorized' as const, authorizing: false, transaction_id: null }, status: 'connected' as const };
  assert.equal(selectConnectorAuthorization(state, complete).waiting, false);
});
test('connector-auth.AT5 已取消或新 flow 不接受旧复制/打开结果', () => {
  const state = waiting();
  assert.equal(connectorAuthorizationReducer(state, { type: 'native-result', flowId: 'old', error: 'late' }), state);
  const failed = connectorAuthorizationReducer(state, { type: 'native-result', flowId: 'current', error: 'clipboard' });
  assert.equal(failed.status === 'idle' && failed.error, 'clipboard');
});
test('connector-auth.AT6 当前取消命令才清本地链接，旧结果无效', () => {
  const busy = connectorAuthorizationReducer(waiting(), { type: 'command', operationId: 'cancel' });
  assert.equal(connectorAuthorizationReducer(busy, { type: 'finished', operationId: 'old', message: '', clearFlow: true }), busy);
  const finished = connectorAuthorizationReducer(busy, { type: 'finished', operationId: 'cancel', message: 'cancelled', clearFlow: true });
  assert.equal(finished.flow, undefined); assert.equal(finished.status === 'idle' && finished.notice, 'cancelled');
});
test('connector-auth.AT7 GitHub 到期短码不再可操作，当前过期事件清回调', () => {
  const pending = connectorAuthorizationReducer(initialConnectorAuthorization, { type: 'command', operationId: 'current' });
  const github = connectorAuthorizationReducer(pending, { type: 'started', operationId: 'current', value: { flow: 'device_code', transaction_id: 'current-gateway-transaction', user_code: 'ABCD-EFGH', authorization_url: 'https://github.com/login/device', expires_at: 100 } });
  const state = connectorAuthorizationReducer(github, { type: 'callback', value: 'private-callback' });
  const fact = { ...connector, id: 'github', app_id: 'github' };
  assert.equal(selectConnectorAuthorization(state, fact).flow?.value.flow, 'device_code');
  assert.equal(connectorAuthorizationReducer(state, { type: 'expired', flowId: 'previous' }), state);
  const expired = connectorAuthorizationReducer(state, { type: 'expired', flowId: 'current' });
  assert.equal(expired.callback, ''); assert.equal(expired.flow, undefined);
  assert.equal(selectConnectorAuthorization(expired, { ...fact, auth: { ...fact.auth, authorizing: false, transaction_id: null, status: 'authorized' } }).notice, '');
});
test('connector-auth.AT8 AT9 旧终态不能复活已清理 flow，核对不生成短码', () => {
  const state = connectorAuthorizationReducer(waiting(), { type: 'expired', flowId: 'current' });
  assert.equal(connectorAuthorizationReducer(state, { type: 'started', operationId: 'current', value: start }), state);
  assert.equal(selectConnectorAuthorization(initialConnectorAuthorization, connector).flow, undefined);
});
test('connector-auth.AT9 未确认命令清本机链接与回调，核对不恢复或接受迟到结果', () => {
  const edited = connectorAuthorizationReducer(waiting(), { type: 'callback', value: 'private-callback' });
  const command = connectorAuthorizationReducer(edited, { type: 'command', operationId: 'callback-write' });
  const cleared = connectorAuthorizationReducer(command, { type: 'unconfirmed', operationId: 'callback-write' });
  assert.equal(cleared.flow, undefined); assert.equal(cleared.callback, '');
  assert.equal(selectConnectorAuthorization(cleared, connector).flow, undefined);
  assert.equal(connectorAuthorizationReducer(cleared, { type: 'finished', operationId: 'callback-write', message: 'late', clearFlow: true }), cleared);
});

const deviceStart: OAuthStart = {
  flow: 'device_code', transaction_id: 'current-gateway-transaction', user_code: 'OLD-CODE', authorization_url: 'https://github.com/login/device', expires_at: 100,
};
for (const value of [start, deviceStart]) {
  test(`connector-auth.F1 ${value.flow} 已采纳网关终态后，其他设备授权和迟到本机结果不能恢复材料`, () => {
    const started = connectorAuthorizationReducer(
      connectorAuthorizationReducer(initialConnectorAuthorization, { type: 'start', operationId: 'current' }),
      { type: 'started', operationId: 'current', value },
    );
    const edited = connectorAuthorizationReducer(started, { type: 'callback', value: 'private-old-callback' });
    assert.equal(selectConnectorAuthorization(edited, connector).flow?.id, 'current');
    const terminal = { ...connector, auth: { status: 'unauthorized' as const, authorizing: false, transaction_id: null, scopes: [] } };
    assert.equal(selectConnectorAuthorization(edited, terminal).waiting, false);
    assert.equal(selectConnectorAuthorization(edited, terminal).flow, undefined);

    // This semantic event retires only the observed local challenge, not a mirror of the Query.
    const retired = connectorAuthorizationReducer(edited, { type: 'gateway-terminal', flowId: 'current' });
    assert.equal(retired.flow, undefined, '网关终态必须永久销毁本机材料，不能只在 selector 中暂时隐藏');
    assert.equal(retired.callback, '');
    assert.equal(selectConnectorAuthorization(retired, connector).waiting, true);
    assert.equal(selectConnectorAuthorization(retired, connector).flow, undefined);
    assert.equal(connectorAuthorizationReducer(retired, { type: 'native-result', flowId: 'current', notice: '已复制验证码' }), retired);
    assert.equal(connectorAuthorizationReducer(retired, { type: 'native-result', flowId: 'current', error: 'late browser failure' }), retired);
    assert.equal(connectorAuthorizationReducer(retired, { type: 'gateway-terminal', flowId: 'current' }), retired);

    const replacement = connectorAuthorizationReducer(
      connectorAuthorizationReducer(retired, { type: 'start', operationId: 'replacement' }),
      { type: 'started', operationId: 'replacement', value: { ...value, transaction_id: 'replacement-gateway-transaction' } },
    );
    assert.equal(connectorAuthorizationReducer(replacement, { type: 'gateway-terminal', flowId: 'current' }), replacement);
    assert.equal(connectorAuthorizationReducer(replacement, { type: 'native-result', flowId: 'current', error: 'late' }), replacement);
    assert.equal(selectConnectorAuthorization(replacement, { ...connector, auth: { ...connector.auth, transaction_id: 'replacement-gateway-transaction' } }).flow?.id, 'replacement');
  });
}
test('connector-auth.F1 未观察到中间终态也按另一设备事务身份退休旧材料', () => {
  const state = waiting();
  const remote = { ...connector, auth: { ...connector.auth, transaction_id: 'other-device-transaction' } };
  const external = selectConnectorAuthorization(state, remote);
  assert.equal(external.flow, undefined);
  assert.equal(external.waiting, true);
  assert.deepEqual(external.terminal, { type: 'gateway-terminal', flowId: 'current' });
  assert.ok(external.terminal);
  const retired = connectorAuthorizationReducer(state, external.terminal);
  assert.equal(selectConnectorAuthorization(retired, remote).flow, undefined);
  assert.equal(selectConnectorAuthorization(retired, remote).terminal, undefined);
});
