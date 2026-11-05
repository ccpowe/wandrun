import { z } from 'zod';
import type { AgentDetail } from '../../gateway/api.ts';
import type { FakeGateway } from '../fake-gateway.ts';
import type { Context, Handler } from './types.ts';
import { jsonResponse, missing } from './response.ts';

const snapshot = (gateway: FakeGateway) => ({ agents: gateway.state.agents, as_of_seq: gateway.state.seq, order_revision: gateway.state.orderRevision });
const agent = ({ gateway, params }: Context) => gateway.state.agents.find(row => row.id === params.id);

const agentFields = z.object({
  name: z.string(), avatar: z.number(), description: z.string(), system_prompt: z.string(),
  model: z.string(), reasoning_effort: z.string().nullable(), fast_mode: z.boolean(), code_mode: z.boolean(),
  environment: z.string(), skills: z.array(z.string()), workers: z.array(z.string()),
  mcp_servers: z.array(z.string()), searchable_mcp_servers: z.array(z.string()),
});

export const agentsRoutes = {
  'GET /agents': ({ gateway }) => jsonResponse(snapshot(gateway)),
  'GET /agents/:id': context => {
    const row = agent(context);
    return row ? jsonResponse(context.gateway.state.agentDetails.get(row.id) ?? { ...row, system_prompt: '', model: '', reasoning_effort: null, fast_mode: false, mcp_servers: [], searchable_mcp_servers: [], skills: [], code_mode: false, environment: 'local', member_of: [] }) : missing('Agent 不存在');
  },
  'POST /agents': ({ gateway, body: raw }) => {
    const { client_id, ...body } = agentFields.partial().extend({ name: z.string(), description: z.string(), system_prompt: z.string(), client_id: z.string() }).parse(raw);
    const detail: AgentDetail = { id: `created-${gateway.state.orderRevision}`, avatar: 0, workers: [], model: 'offline', reasoning_effort: null, fast_mode: false, mcp_servers: [], searchable_mcp_servers: [], skills: [], code_mode: true, environment: 'local', member_of: [], ...body };
    gateway.state.agentDetails.set(detail.id, detail);
    gateway.state.agents.push({ ...detail, latest_conversation: null, unread: false });
    gateway.state.orderRevision++;
    const event = gateway.event('resource.changed', { kind: 'agent', id: detail.id, op: 'created' });
    event.client_id = client_id; gateway.emit(event);
    return jsonResponse({ agent: detail, event, replayed: false }, 201);
  },
  'PATCH /agents/:id': ({ gateway, body: raw, params }) => {
    const detail = gateway.state.agentDetails.get(params.id);
    if (!detail) return missing('Agent 不存在');
    const updated = { ...detail, ...agentFields.partial().parse(raw) };
    gateway.state.agentDetails.set(params.id, updated);
    gateway.state.agents = gateway.state.agents.map(row => row.id === params.id ? { ...row, name: updated.name, description: updated.description, avatar: updated.avatar, workers: updated.workers, environment: updated.environment } : row);
    const event = gateway.event('resource.changed', { kind: 'agent', id: params.id, op: 'updated' }); gateway.emit(event);
    return jsonResponse({ agent: updated, event });
  },
  'DELETE /agents/:id': ({ gateway, params }) => {
    if (!gateway.state.agentDetails.has(params.id)) return missing('Agent 不存在');
    gateway.state.agents = gateway.state.agents.filter(row => row.id !== params.id); gateway.state.agentDetails.delete(params.id);
    gateway.state.orderRevision++;
    const event = gateway.event('resource.changed', { kind: 'agent', id: params.id, op: 'deleted' }); gateway.emit(event);
    return jsonResponse({ event });
  },
  'GET /agents/:id/capabilities': ({ gateway, params }) => jsonResponse({ capabilities: gateway.state.capabilities.get(params.id) ?? [] }),
} satisfies Record<string, Handler>;
