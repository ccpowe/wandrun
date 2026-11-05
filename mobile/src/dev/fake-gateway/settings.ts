import { z } from 'zod';
import type { Handler } from './types.ts';
import { jsonResponse } from './response.ts';

export const settingsRoutes = {
  'GET /settings': ({ gateway }) => jsonResponse(gateway.state.settings),
  'PUT /settings': ({ gateway, body }) => {
    gateway.state.settings = { ...gateway.state.settings, ...z.object({ default_model: z.string().nullable(), default_reasoning_effort: z.string().nullable() }).partial().parse(body) };
    return jsonResponse(gateway.state.settings);
  },
} satisfies Record<string, Handler>;
