import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Connector, SubscriptionStatus } from '../src/gateway/api.ts';
import { connectorSettingsSummary, modelSettingsSummary } from '../src/lib/settings-summary.ts';

const subscription: SubscriptionStatus & { networkError: boolean } = {
  auth: { status: 'ready', reason: null, checked_at: 1, codex_home: '/settings-test', login_command: 'codex login' },
  usage: { plan_type: 'Pro', allowed: true, limit_reached: false, windows: [{ name: 'primary', window_seconds: 18000, used_percent: 99.99, reset_at: 2000000000 }], fetched_at: 1 },
  networkError: false,
};
const connector: Connector = { id: 'docs', name: 'Docs', description: '', auth_type: 'none', app_id: null, auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] }, status: 'connected', error: null, tool_count: 3, used_by: [], pending_restart: false };

test('settings.B1 四舍五入满额不等于额度受限，只有明确拒绝标红', () => {
  assert.equal(modelSettingsSummary(subscription).danger, false);
  assert.equal(modelSettingsSummary({ ...subscription, usage: { ...subscription.usage!, allowed: null, limit_reached: null } }).danger, false);
  assert.equal(modelSettingsSummary({ ...subscription, usage: { ...subscription.usage!, allowed: false, windows: [] } }).danger, true);
  assert.equal(modelSettingsSummary({ ...subscription, usage: { ...subscription.usage!, limit_reached: true } }).danger, true);
});

test('settings.B1 登录需处理与正常续期分开，不把续期当失败', () => {
  for (const status of ['login_required', 'reauth_required', 'relogin_required'] as const) {
    assert.equal(modelSettingsSummary({ ...subscription, auth: { ...subscription.auth, status } }).danger, true);
  }
  for (const status of ['ready', 'refresh_due', 'refreshing'] as const) {
    assert.equal(modelSettingsSummary({ ...subscription, auth: { ...subscription.auth, status } }).danger, false);
  }
});

test('settings.B2 连接失败或需重授权才提醒，正常未连接不标红', () => {
  assert.equal(connectorSettingsSummary([{ ...connector, status: 'disconnected' }]).danger, false);
  const failed: Connector = { ...connector, id: 'failed', status: 'failed' };
  assert.deepEqual(connectorSettingsSummary([connector, failed]), { text: '1 个失败 · 共 2', danger: true });
  const reauthorize: Connector = { ...connector, auth_type: 'oauth', auth: { ...connector.auth, status: 'reauthorization_required' } };
  assert.deepEqual(connectorSettingsSummary([reauthorize, connector]), { text: '1 个需重新授权 · 共 2', danger: true });
  assert.deepEqual(connectorSettingsSummary([]), { text: '0', danger: false });
});

