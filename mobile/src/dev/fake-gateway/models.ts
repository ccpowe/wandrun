import type { Handler } from './types.ts';
import { jsonResponse } from './response.ts';

export const modelsRoutes = {
  'GET /models': ({ gateway }) => jsonResponse(gateway.state.models),
  'GET /usage/subscription': ({ gateway }) => jsonResponse(gateway.state.subscription),
  'GET /usage/agents': ({ gateway }) => jsonResponse(gateway.state.usage),
} satisfies Record<string, Handler>;
