import { z } from 'zod';
import { connectorEvent } from './connectors.ts';
import type { Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

export const appsRoutes = {
  'GET /apps': ({ gateway }) => jsonResponse({ apps: gateway.state.apps.map(app => ({
    ...app, connector: gateway.state.connectors.find(row => row.app_id === app.id) ?? app.connector,
  })) }),
  'POST /apps/:id/connect': ({ gateway, params, body: raw }) => {
    const app = gateway.state.apps.find(row => row.id === params.id);
    if (!app) return missing('应用不在目录中');
    const { client_id } = z.object({ client_id: z.string() }).parse(raw);
    let connector = gateway.state.connectors.find(row => row.app_id === app.id);
    if (!connector) {
      // Same shape as the gateway: a key entry binds as auth_type=key without its Key.
      const key = app.auth.type === 'key';
      connector = {
        id: `app-${app.id}`, name: app.name, description: app.description, url: `https://${app.id}.example.invalid/mcp`,
        transport: 'http', auth_type: key ? 'key' : 'oauth', app_id: app.id, ...(key ? { headers: {} } : {}),
        auth: { status: key ? 'not_required' : 'unauthorized', authorizing: false, transaction_id: null, scopes: [] },
        status: 'disconnected', error: null, tool_count: 0, used_by: [], pending_restart: false,
      };
      gateway.state.connectors.push(connector);
      connectorEvent(gateway, connector.id, 'created', client_id);
    }
    return jsonResponse({ connector });
  },
} satisfies Record<string, Handler>;
