import type { Connector, Fetch } from '../gateway/api';
import { Credentials } from '../lib/credentials';
import { FakeGateway, jsonResponse, unavailable, type GatewayOverrides } from './fake-gateway';
import { installFakeGatewayHost } from './fake-gateway-host';

export type AppsConnectorScene = 'normal' | 'oauth-busy' | 'save-failure' | 'create-unknown' | 'save-unknown' | 'delete-unknown';
export type AppsConnectorScenario = {
  gateway: FakeGateway; runtime: { credentials: Credentials; fetch: Fetch }; readonly writeCount: number;
  recover(): void; start(): void; stop(): void;
};

/** Delays/failures are HTTP outcomes. Draft edits and sheets are reached through real controls. */
export function appsConnectorScenario(scene: AppsConnectorScene = 'normal'): AppsConnectorScenario {
  const oauth = scene === 'oauth-busy';
  const connector: Connector = {
    id: 'docs', name: oauth ? 'GitHub' : '资料检索', description: '检索项目资料并返回原始来源',
    url: 'https://docs.example.invalid/mcp', transport: 'streamable-http', auth_type: oauth ? 'oauth' : 'key', app_id: oauth ? 'github' : null,
    headers: oauth ? {} : { Authorization: true },
    auth: { status: oauth ? 'unauthorized' : 'not_required', authorizing: false, transaction_id: null, scopes: [], error: null },
    status: oauth ? 'disconnected' : 'connected', error: null, tool_count: oauth ? 0 : 2, used_by: [], pending_restart: false,
  };
  let recovered = false;
  let wrote = false;
  let writeCount = 0;
  let releaseHost: (() => void) | undefined;
  const gate = Promise.withResolvers<void>();
  const read: NonNullable<GatewayOverrides['GET /connectors/:id']> = () => {
    if (wrote && !recovered && scene.includes('unknown')) return unavailable();
  };
  const write: NonNullable<GatewayOverrides['PATCH /connectors/:id']> = async (_context, respond) => {
    wrote = true;
    writeCount++;
    if (scene === 'save-failure' && !recovered) return jsonResponse({ error: { code: 'invalid_request', message: '当前配置不能保存，请检查后重试。' } }, 400);
    if (scene.includes('unknown') && !recovered) { await respond(); return unavailable(); }
  };
  const gateway = new FakeGateway({
    connectors: [connector],
    connectorTools: new Map([['docs', [{ name: 'search', title: '搜索项目资料', description: '按关键词搜索原始文档' }, { name: 'read', title: '读取原始文档', description: '读取完整内容' }]]]),
    memories: new Map([['/memory/profile', { scope: 'profile', content: '', version: 'story-v1', limit: 1000, updated_at: 1, updated_by: 'user', details: {} }]]),
    subscription: { auth: { status: 'ready', reason: null, checked_at: 1, codex_home: '/fixture/codex', login_command: 'codex login' }, usage: { plan_type: 'Pro', allowed: true, limit_reached: false, windows: [], fetched_at: 1 } },
    apps: ['github', 'notion'].map(id => ({ id, name: id === 'github' ? 'GitHub' : 'Notion', description: id === 'github' ? '连接 GitHub 仓库、Issue 与 Pull Request' : '连接 Notion 工作区的 MCP 工具',
      url: `https://${id}.example.invalid/mcp`, transport: 'streamable-http', auth: { type: id === 'github' ? 'device' as const : 'oauth' as const }, connector: null })),
  }, {
    'GET /connectors/:id': read,
    'PATCH /connectors/:id': write, 'POST /connectors': write, 'DELETE /connectors/:id': write,
    'POST /connectors/:id/oauth/start': async () => { if (scene === 'oauth-busy' && !recovered) await gate.promise; },
  });
  const credentials = new Credentials({
    getItemAsync: async () => JSON.stringify({ computers: [{ computerId: 's5-story', connectionId: 's5-story-installation', deviceId: 's5-device', computerName: 'Storybook 电脑', baseUrl: 'https://apps-connector-story.invalid', token: 'story', pairingMethod: 'development' }], currentId: 's5-story' }),
    setItemAsync: async () => {}, deleteItemAsync: async () => {},
  });
  return {
    gateway, runtime: { credentials, fetch: gateway.fetch },
    get writeCount() { return writeCount; },
    start() { releaseHost ??= installFakeGatewayHost({ baseUrls: ['https://apps-connector-story.invalid'], fetch: gateway.fetch }); },
    recover() { recovered = true; gate.resolve(); gateway.disconnect(); },
    stop() { gate.resolve(); gateway.disconnect(); releaseHost?.(); releaseHost = undefined; },
  };
}
