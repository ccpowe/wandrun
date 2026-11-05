import type { Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

export const computerRoutes = {
  'GET /execution-environments': ({ gateway }) => jsonResponse({ environments: gateway.state.environments, next_cursor: null }),
  'GET /computer': ({ gateway }) => gateway.state.computer ? jsonResponse(gateway.state.computer) : missing('服务器状态不可用'),
  'GET /connection': ({ gateway }) => jsonResponse(gateway.state.connection),
  'DELETE /devices/current': () => new Response(null, { status: 204 }),
  'POST /pairing/exchange': ({ gateway, body }) => {
    const input = body as { code?: string; method?: string };
    const pairing = gateway.state.pairing;
    if (!pairing || input.code !== pairing.code || !['manual', 'qr'].includes(input.method ?? '')) {
      return jsonResponse({ error: { code: 'pairing_invalid', message: '配对码不正确' } }, 400);
    }
    if (pairing.consumed) return jsonResponse({ error: { code: 'pairing_used', message: '配对码已使用' } }, 400);
    pairing.consumed = true;
    return jsonResponse({ ...gateway.state.connection, token: pairing.token, device_id: pairing.deviceId, pairing_method: input.method });
  },
} satisfies Record<string, Handler>;

export const computerUnsupportedRoutes: Record<string, string> = {};
