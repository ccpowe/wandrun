import { z } from 'zod';
import type { Connector, GatewayEvent } from '../../gateway/api.ts';
import type { FakeGateway } from '../fake-gateway.ts';
import type { Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

// Connector definitions keep only public presence bits for secrets, as the HTTP API does.
const connectorFields = z.object({
  name: z.string(), description: z.string(), command: z.string(), args: z.array(z.string()),
  url: z.string(), transport: z.string().nullable(), auth_type: z.enum(['none', 'key', 'oauth']),
  headers: z.record(z.string(), z.string().nullable()), env: z.record(z.string(), z.string().nullable()),
}).partial();
function connectorSnapshot(gateway: FakeGateway, row: Connector): Connector {
  const known = gateway.state.agentDetails;
  const used_by = [
    ...row.used_by.filter(user => !known.has(user.id)),
    ...[...known.values()].filter(agent => [...agent.mcp_servers, ...agent.searchable_mcp_servers].includes(row.id))
      .map(agent => ({ id: agent.id, name: agent.name, avatar: agent.avatar })),
  ];
  return { ...row, used_by };
}
function connectorWrite(gateway: FakeGateway, row: Connector, raw: unknown): Connector {
  const { headers, env, transport, ...fields } = connectorFields.parse(raw);
  const next = { ...row, ...fields };
  if (next.url && (transport !== undefined || !row.transport || fields.url !== undefined && row.transport_source === 'auto')) {
    next.transport_source = transport == null ? 'auto' : 'user';
    next.transport = transport ?? (new URL(next.url).pathname.endsWith('/sse') ? 'sse' : 'streamable-http');
  }
  for (const [kind, patch] of [['headers', headers], ['env', env]] as const) {
    if (!patch) continue;
    const present = { ...row[kind] };
    for (const [key, value] of Object.entries(patch)) {
      if (value) present[key] = true; else delete present[key];
    }
    next[kind] = present;
  }
  gateway.state.connectors = gateway.state.connectors.map(item => item.id === row.id ? next : item);
  return connectorSnapshot(gateway, next);
}
export function connectorEvent(gateway: FakeGateway, id: string, op: string, clientId?: string): GatewayEvent {
  const event = gateway.event('resource.changed', { kind: 'connector', id, op });
  if (clientId) event.client_id = clientId;
  gateway.emit(event);
  return event;
}

export const connectorsRoutes = {
  'GET /connectors': ({ gateway }) => jsonResponse({ connectors: gateway.state.connectors.map(row => connectorSnapshot(gateway, row)), as_of_seq: gateway.state.seq }),
  // Unobserved attempts have no proof of failure; race fixtures provide explicit attempt outcomes.
  'GET /connectors/creation-result': () => jsonResponse({ status: 'unknown' }),
  'POST /connectors/probe': ({ body }) => {
    const { url, transport } = z.object({ url: z.string().url(), transport: z.string().optional() }).parse(body);
    return jsonResponse({ result: 'none', transport: transport ?? (new URL(url).pathname.endsWith('/sse') ? 'sse' : 'streamable-http') });
  },
  'GET /connectors/:id/agents': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    return row ? jsonResponse({ agents: connectorSnapshot(gateway, row).used_by, as_of_seq: gateway.state.seq }) : missing('连接器不存在');
  },
  'GET /connectors/:id/tools': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    return row ? jsonResponse({ status: row.status, tools: row.status === 'connected' ? gateway.state.connectorTools.get(row.id) ?? [] : [], as_of_seq: gateway.state.seq }) : missing('连接器不存在');
  },
  'GET /connectors/:id': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    return row ? jsonResponse(connectorSnapshot(gateway, row)) : missing('连接器不存在');
  },
  'POST /connectors': ({ gateway, body: raw }) => {
    const fields = connectorFields.extend({ client_id: z.string() }).parse(raw);
    const row: Connector = {
      id: `connector-${++gateway.state.seq}`, name: fields.name ?? (fields.url ? new URL(fields.url).hostname : fields.command ?? 'Notes'), description: fields.description ?? 'Search controlled notes',
      auth_type: fields.auth_type ?? 'none', app_id: null,
      auth: { status: fields.auth_type === 'oauth' ? 'unauthorized' : 'not_required', authorizing: false, transaction_id: null, scopes: [] },
      status: fields.auth_type === 'oauth' ? 'disconnected' : 'connected',
      error: null, tool_count: fields.auth_type === 'oauth' ? 0 : 2, used_by: [], pending_restart: false,
    };
    gateway.state.connectors.push(row);
    const connector = connectorWrite(gateway, row, raw);
    return jsonResponse({ connector, event: connectorEvent(gateway, row.id, 'created', fields.client_id), replayed: false }, 201);
  },
  'PATCH /connectors/:id': ({ gateway, params, body }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    const connector = connectorWrite(gateway, row, body);
    return jsonResponse({ connector, event: connectorEvent(gateway, row.id, 'updated') });
  },
  'DELETE /connectors/:id': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    for (const agent of gateway.state.agentDetails.values()) {
      if (![...agent.mcp_servers, ...agent.searchable_mcp_servers].includes(row.id)) continue;
      agent.mcp_servers = agent.mcp_servers.filter(id => id !== row.id);
      agent.searchable_mcp_servers = agent.searchable_mcp_servers.filter(id => id !== row.id);
      gateway.emit(gateway.event('resource.changed', { kind: 'agent', id: agent.id, op: 'updated' }));
    }
    gateway.state.connectors = gateway.state.connectors.filter(item => item.id !== row.id);
    gateway.state.apps = gateway.state.apps.map(app => app.connector?.id === row.id ? { ...app, connector: null } : app);
    return jsonResponse({ event: connectorEvent(gateway, row.id, 'deleted') });
  },
  'DELETE /connectors/:id/key': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    if (row.auth_type !== 'key') return jsonResponse({ error: { code: 'invalid_request', message: '不是密钥型连接器' } }, 400);
    row.headers = {}; row.status = 'disconnected'; row.tool_count = 0;
    return jsonResponse({ connector: connectorSnapshot(gateway, row), event: connectorEvent(gateway, row.id, 'updated') });
  },
  'POST /connectors/:id/test': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    row.status = 'connected'; row.tool_count = 2;
    connectorEvent(gateway, row.id, 'status');
    return jsonResponse({ success: true, tool_count: row.tool_count, error: null, pending_restart: row.pending_restart });
  },
  'POST /connectors/:id/oauth/start': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    const event = gateway.event('resource.changed', { kind: 'connector', id: row.id, op: 'status' });
    const transaction_id = `fake-authorization-${event.seq}`;
    row.auth = { ...row.auth, authorizing: true, transaction_id, error: null };
    gateway.emit(event);
    const shared = { transaction_id, expires_at: Date.now() / 1000 + 600, authorization_url: 'https://authorize.example.invalid/authorize' };
    return jsonResponse(row.app_id === 'github'
      ? { ...shared, flow: 'device_code', user_code: 'ABCD-EFGH' }
      : { ...shared, flow: 'authorization_code', redirect_uri: 'http://127.0.0.1:18815/oauth/callback', manual_callback: true });
  },
  'POST /connectors/:id/oauth/callback': ({ gateway, params, body: raw }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    const { url } = z.object({ url: z.string() }).parse(raw);
    if (!url.startsWith('http://127.0.0.1:18815/oauth/callback?')) return jsonResponse({ error: { code: 'invalid_callback', message: '回调网址不匹配' } }, 400);
    row.status = 'connected'; row.tool_count = 2;
    row.auth = { status: 'authorized', authorizing: false, transaction_id: null, scopes: ['read'], error: null };
    connectorEvent(gateway, row.id, 'status');
    return jsonResponse({ connector: connectorSnapshot(gateway, row) });
  },
  'DELETE /connectors/:id/oauth/pending': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    row.auth = { ...row.auth, authorizing: false, transaction_id: null };
    connectorEvent(gateway, row.id, 'status');
    return jsonResponse({ connector: connectorSnapshot(gateway, row) });
  },
  'DELETE /connectors/:id/oauth': ({ gateway, params }) => {
    const row = gateway.state.connectors.find(item => item.id === params.id);
    if (!row) return missing('连接器不存在');
    row.auth = { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [], error: null };
    connectorEvent(gateway, row.id, 'status');
    return jsonResponse({ connector: connectorSnapshot(gateway, row), remote_revoked: row.app_id === 'github' ? null : true });
  },
} satisfies Record<string, Handler>;
