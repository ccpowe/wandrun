import { z } from 'zod';
import type { AgentMemory } from '../../gateway/api.ts';
import type { Context, Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

const memory = ({ gateway, url }: Context) => gateway.state.memories.get(url.pathname);
const saveMemory: Handler = ({ gateway, url, body: raw, params, init }) => {
  const body = z.object({ content: z.string(), version: z.string(), index_content: z.string().optional() }).parse(raw);
  const base = url.pathname.split('/details/')[0];
  const current = gateway.state.memories.get(base);
  if (!current) return missing('记忆不存在');
  if (body.version !== current.version) return jsonResponse({ error: { code: 'conflict', message: '记忆已在别处更新', details: { current } } }, 409);
  const next: AgentMemory = { ...current, version: `${current.version}-saved`, updated_at: Date.now() / 1000, updated_by: 'user', details: { ...current.details } };
  if (!params.slug) next.content = body.content;
  else if (init.method === 'DELETE') {
    delete next.details[params.slug]; gateway.state.memoryBodies.delete(url.pathname); next.content = body.content;
  } else {
    gateway.state.memoryBodies.set(url.pathname, body.content);
    // Deliberately stable synthetic digest: scenes model memory CAS, not filesystem hashing.
    const path = `/.wandrun/memory/${current.scope}/details/${params.slug}/${'a'.repeat(64)}.md`;
    next.details[params.slug] = { path, sha256: 'a'.repeat(64) };
    if (body.index_content !== undefined) next.content = body.index_content.replace(`/.wandrun/memory/${current.scope}/details/${params.slug}.md`, path);
  }
  gateway.state.memories.set(base, next);
  return jsonResponse(next);
};
const memoryDetail: Handler = ({ gateway, url, params }) => {
  const current = gateway.state.memories.get(url.pathname.split('/details/')[0]);
  const detail = current?.details[params.slug];
  return detail ? jsonResponse({ scope: current!.scope, agent_id: current!.agent_id, slug: params.slug, content: gateway.state.memoryBodies.get(url.pathname), ...detail, version: current!.version, limit: 65536 }) : missing('详情已删除');
};

export const memoryRoutes = {
  'GET /agents/:id/memory': context => memory(context) ? jsonResponse(memory(context)) : missing('记忆不存在'),
  'GET /memory/profile': context => memory(context) ? jsonResponse(memory(context)) : missing('记忆不存在'),
  'PUT /memory/profile': saveMemory,
  'PUT /agents/:id/memory': saveMemory,
  'GET /memory/profile/details/:slug': memoryDetail,
  'GET /agents/:id/memory/details/:slug': memoryDetail,
  'PUT /memory/profile/details/:slug': saveMemory,
  'PUT /agents/:id/memory/details/:slug': saveMemory,
  'DELETE /memory/profile/details/:slug': saveMemory,
  'DELETE /agents/:id/memory/details/:slug': saveMemory,
} satisfies Record<string, Handler>;
