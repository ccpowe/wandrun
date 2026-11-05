import type { Connector, Fetch } from '../gateway/api';
import { Credentials } from '../lib/credentials';
import { FakeGateway, jsonResponse } from './fake-gateway';
import { installFakeGatewayHost } from './fake-gateway-host';
import { newClientId } from '../gateway/session';

export const sampleConnector: Connector = {
  id: 'knowledge', name: '团队知识库', description: '搜索知识与项目文档', url: 'https://example.com/mcp',
  auth_type: 'oauth', app_id: null,
  auth: { status: 'authorized', authorizing: false, transaction_id: null, scopes: [] },
  status: 'connected', error: null, tool_count: 12,
  used_by: [{ id: 'research', name: '研究助手' }], pending_restart: false,
};
export type ConnectorListScene = 'ready' | 'loading' | 'empty' | 'failed' | 'stale' | 'many';
export type ConnectorListScenario = {
  identity: string; runtime: { credentials: Credentials; fetch: Fetch }; gateway: FakeGateway; readonly reads: number;
  fail(): void; recover(rows?: Connector[]): void; succeed(rows: Connector[], kind?: 'connector' | 'agent'): void;
  hold(): void; release(): void; disconnect(): void; reconnect(): void; start(): void; stop(): void;
};
export function connectorListScenario(scene: ConnectorListScene = 'ready'): ConnectorListScenario {
  const rows = scene === 'empty' ? [] : [sampleConnector,
    { ...sampleConnector, id: 'notion', name: 'Notion', app_id: 'notion', auth: { status: 'unauthorized' as const, authorizing: false, transaction_id: null, scopes: [] } },
    { ...sampleConnector, id: 'docs', name: '文档索引', auth_type: 'none' as const, status: 'failed' as const, used_by: [] },
    { ...sampleConnector, id: 'dormant', name: '备用资料库', auth_type: 'none' as const, status: 'disconnected' as const, tool_count: 0, used_by: [] },
  ];
  if (scene === 'many') for (let index = 0; index < 30; index++) rows.push({ ...sampleConnector, id: `extra-${index}`, name: `项目资料库 ${index + 1}` });
  let failure = scene === 'failed';
  let pending = scene === 'loading';
  let offline = false;
  let reads = 0;
  let transition: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<() => void>();
  const changed = (kind: 'connector' | 'agent' = 'connector') => gateway.emit(gateway.event('resource.changed', { kind, id: 'knowledge', op: 'updated' }));
  const gateway = new FakeGateway({ connectors: rows, apps: scene === 'empty' ? [] : [
    { id: 'notion', name: 'Notion', description: '查找页面、整理笔记与知识', url: 'https://notion.example.invalid/mcp', transport: 'streamable-http', auth: { type: 'oauth' }, connector: null },
    { id: 'github', name: 'GitHub', description: '查找代码、Issue 与 Pull Request', url: 'https://github.example.invalid/mcp', transport: 'streamable-http', auth: { type: 'device' }, connector: null },
    { id: 'amap', name: '高德地图', description: '地点搜索、路线规划、天气与地理编码', url: 'https://amap.example.invalid/mcp', transport: 'streamable-http',
      auth: { type: 'key', key_url: 'https://lbs.amap.com/api/mcp-server/create-project-and-key', headers: {}, key: { in: 'query', name: 'key' } }, connector: null },
  ] }, {
    'GET /connectors': async ({ init }, respond) => {
      reads++;
      if (pending) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        held.add(resolve);
        init.signal?.addEventListener('abort', () => { held.delete(resolve); reject(new Error('aborted')); }, { once: true });
        await promise;
      }
      if (failure) return jsonResponse({ error: { code: 'internal_error', message: 'private upstream detail' } }, 500);
      if (scene === 'stale' && !transition) transition = setTimeout(() => { failure = true; changed(); }, 100);
      return respond();
    },
    'GET /apps': async ({ init }, respond) => {
      if (pending) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        held.add(resolve);
        init.signal?.addEventListener('abort', () => { held.delete(resolve); reject(new Error('aborted')); }, { once: true });
        await promise;
      }
      return failure ? jsonResponse({ error: { code: 'internal_error', message: 'private upstream detail' } }, 500) : respond();
    },
    'GET /events': () => { if (offline) throw new TypeError('Network request failed'); },
  });
  let stored: string | null = JSON.stringify({ computers: [{ computerId: 'connector-gallery', connectionId: 'connector-gallery-installation', computerName: '连接器 Storybook', baseUrl: 'https://gallery.invalid', token: 'gallery', pairingMethod: 'development' }], currentId: 'connector-gallery' });
  const credentials = new Credentials({ getItemAsync: async () => stored, setItemAsync: async (_key, value) => { stored = value; }, deleteItemAsync: async () => { stored = null; } });
  let releaseHost: (() => void) | undefined;
  return {
    identity: newClientId(), runtime: { credentials, fetch: gateway.fetch }, gateway, get reads() { return reads; },
    fail() { failure = true; changed(); },
    recover(next = [sampleConnector]) { failure = false; gateway.state.connectors = next; },
    succeed(next, kind = 'connector') { failure = false; gateway.state.connectors = next; changed(kind); },
    hold() { pending = true; changed(); },
    release() { pending = false; for (const resolve of held) resolve(); held.clear(); },
    disconnect() { offline = true; gateway.disconnect(); }, reconnect() { offline = false; },
    start() { releaseHost ??= installFakeGatewayHost({ baseUrls: ['https://gallery.invalid'], fetch: gateway.fetch }); },
    stop() { clearTimeout(transition); gateway.disconnect(); releaseHost?.(); releaseHost = undefined; held.clear(); },
  };
}
