import { z } from 'zod';
import type { Conversation } from '../../gateway/api.ts';
import { splitAgentMessage } from '../../lib/agent-message.ts';
import { parseRichSpec } from '../../components/rich-message/spec.ts';
import type { Handler } from './types.ts';
import { jsonResponse, missing, unavailable } from './response.ts';

const history: Handler = ({ gateway, url, params }) => jsonResponse({ events: url.searchParams.has('before') ? [] : gateway.state.histories.get(params.id) ?? [], as_of_seq: gateway.state.seq });
const sendMessage: Handler = ({ gateway, params, body: raw, url }) => {
  const body = z.object({ text: z.string(), client_id: z.string(), attachments: z.array(z.string()).optional() }).parse(raw);
  if (gateway.state.conversationCreations.has(body.client_id)) return jsonResponse({ error: { code: 'client_id_reused', message: '请求标识已用于其他操作' } }, 409);
  const existing = [...gateway.state.histories.values()].flat().find(event => event.client_id === body.client_id);
  if (existing) return existing.conversation_id === params.id && existing.type === 'message.user'
    ? jsonResponse({ event: existing, replayed: true })
    : jsonResponse({ error: { code: 'client_id_reused', message: '请求标识已用于其他操作' } }, 409);
  const task = url.pathname.startsWith('/tasks/') ? gateway.state.tasks.find(row => row.id === params.id) : undefined;
  const attachments = body.attachments?.map(id => gateway.state.files.get(id)).filter(row => row !== undefined) ?? [];
  const event = gateway.event('message.user', { text: body.text, ...(attachments.length ? { attachments } : {}), ...(task ? { timeline_ids: [params.id] } : {}) }, task?.root_id ?? params.id);
  event.client_id = body.client_id;
  gateway.state.histories.get(params.id)?.push(event);
  const conversation = gateway.state.conversations.find(row => row.id === params.id);
  if (conversation) conversation.last_text = body.text;
  gateway.emit(event);
  return jsonResponse({ event, replayed: false });
};

export const conversationsRoutes = {
  'GET /agents/:id/conversations': ({ gateway, params }) => jsonResponse({ conversations: gateway.state.tasks.filter(row => row.agent_id === params.id), as_of_seq: gateway.state.seq }),
  'GET /agents/:id/collaborations': ({ gateway, params }) => jsonResponse({ conversations: gateway.state.tasks.filter(row => row.creator_agent_id === params.id), as_of_seq: gateway.state.seq }),
  'GET /conversations': ({ gateway }) => jsonResponse({ conversations: gateway.state.conversations, as_of_seq: gateway.state.seq }),
  'POST /conversations': ({ gateway, body: raw }) => {
    const body = z.object({ agent_id: z.string(), client_id: z.string().min(1).max(128), title: z.string().optional() }).parse(raw);
    const title = (body.title || '新对话').trim();
    const previous = gateway.state.conversationCreations.get(body.client_id);
    if (previous) return previous.agentId === body.agent_id && previous.title === title
      ? jsonResponse(previous.conversation, 200)
      : jsonResponse({ error: { code: 'client_id_reused', message: '请求标识已用于其他操作' } }, 409);
    if ([...gateway.state.histories.values()].some(events => events.some(event => event.client_id === body.client_id))) {
      return jsonResponse({ error: { code: 'client_id_reused', message: '请求标识已用于其他操作' } }, 409);
    }
    if (!gateway.state.agents.some(agent => agent.id === body.agent_id)) return missing('Agent 不存在');
    const now = Date.now() / 1000;
    const conversation: Conversation = { ...gateway.state.conversationTemplate, id: `conversation-${++gateway.state.seq}`, agent_id: body.agent_id, title, last_text: null, last_agent_seq: 0, read_seq: 0, last_activity_seq: null, last_activity_at: null, created_at: now, updated_at: now, status: 'idle', unread: false, source: 'user', schedule_origin: null };
    gateway.state.conversations.push(conversation);
    gateway.state.histories.set(conversation.id, []);
    const event = gateway.event('conversation.created', { agent_id: body.agent_id, title: conversation.title, source: conversation.source }, conversation.id);
    event.client_id = body.client_id;
    gateway.state.conversationCreations.set(body.client_id, { agentId: body.agent_id, title, conversation: { ...conversation } });
    gateway.state.histories.get(conversation.id)!.push(event);
    gateway.emit(event);
    return jsonResponse(conversation, 201);
  },
  'PATCH /conversations/:id': ({ gateway, params, body: raw }) => {
    const body = z.object({ title: z.string() }).parse(raw);
    const conversation = gateway.state.conversations.find(row => row.id === params.id);
    if (!conversation) return missing('对话已删除');
    conversation.title = body.title;
    const event = gateway.event('conversation.updated', { id: conversation.id, title: body.title }, conversation.id);
    gateway.emit(event);
    return jsonResponse({ conversation, event });
  },
  'DELETE /conversations/:id': ({ gateway, params }) => {
    const index = gateway.state.conversations.findIndex(row => row.id === params.id);
    if (index < 0) return missing('对话已删除');
    const [conversation] = gateway.state.conversations.splice(index, 1);
    const event = gateway.event('conversation.deleted', { id: conversation.id }, conversation.id);
    gateway.emit(event);
    return jsonResponse({ conversation, event });
  },
  'GET /tasks/:id': ({ gateway, params }) => {
    const task = gateway.state.tasks.find(row => row.id === params.id);
    return task ? jsonResponse(task) : missing('子对话不存在');
  },
  'GET /conversations/:id/events': history,
  'GET /tasks/:id/events': history,
  'GET /conversations/:id/drafts': ({ gateway }) => jsonResponse({ drafts: [], as_of_seq: gateway.state.seq }),
  'POST /conversations/:id/read': () => jsonResponse({}),
  'POST /tasks/:id/read': () => jsonResponse({}),
  'POST /conversations/:id/messages': sendMessage,
  'POST /tasks/:id/messages': sendMessage,
  'GET /conversations/:id/ui-submissions': ({ gateway, params, url }) => {
    const events = gateway.state.histories.get(params.id);
    if (!events) return missing('对话不存在');
    const messageSeq = Number(url.searchParams.get('message_seq'));
    const block = Number(url.searchParams.get('block'));
    const event = events.find(event => event.type === 'message.user' && event.data.ui_submission?.message_seq === messageSeq && event.data.ui_submission?.block === block);
    return jsonResponse({ event: event ?? null });
  },
  'POST /conversations/:id/ui-submissions': ({ gateway, params, body: raw }) => {
    const body = z.strictObject({ client_id: z.string(), message_seq: z.number().int().positive(), block: z.number().int().nonnegative(), values: z.record(z.string(), z.unknown()), action_id: z.string().optional() }).parse(raw);
    const events = gateway.state.histories.get(params.id);
    if (!events) return missing('对话不存在');
    const previous = events.find(event => event.type === 'message.user' && event.data.ui_submission?.message_seq === body.message_seq && event.data.ui_submission?.block === body.block);
    if (previous) return previous.client_id === body.client_id && previous.data.ui_submission?.action_id === body.action_id ? jsonResponse({ event: previous, replayed: true })
      : jsonResponse({ error: { code: 'ui_already_submitted', message: '这个界面已在其他设备提交。', details: { event: previous } } }, 409);
    const target = events.find(event => event.seq === body.message_seq && event.type === 'message.agent');
    if (!target?.data.ui?.some((block: { block: number; valid: boolean }) => block.block === body.block && block.valid)) {
      return jsonResponse({ error: { code: 'invalid_ui_submission', message: '这条消息没有可提交的界面' } }, 400);
    }
    const part = splitAgentMessage(target.data.text).find(part => part.kind === 'ui' && part.block === body.block);
    const spec = part?.kind === 'ui' ? parseRichSpec(part.source) : null;
    let text = '已提交表单';
    if (body.action_id) {
      const [elementId, index] = body.action_id.split('/');
      const node = spec?.elements[elementId];
      const declared = node?.type === 'FollowUps' && index !== undefined && String(Number(index)) === index
        ? node.props.items[Number(index)]?.text : index === undefined ? node?.props.send?.text : undefined;
      if (typeof declared !== 'string' || Object.keys(body.values).length) {
        return jsonResponse({ error: { code: 'ui_invalid_values', message: '发送动作无效' } }, 400);
      }
      text = declared;
    }
    const event = gateway.event('message.user', { text, ui_submission: { message_seq: body.message_seq, block: body.block, values: body.values,
      ...(body.action_id ? { action_id: body.action_id } : {}) } }, params.id);
    event.client_id = body.client_id;
    events.push(event); gateway.emit(event);
    return jsonResponse({ event, replayed: false });
  },
  'POST /conversations/:id/stop': () => unavailable('停止回执未取得'),
  'POST /tasks/:id/stop': () => unavailable('停止回执未取得'),
  'GET /events': ({ gateway, init }) => gateway.openStream(init.signal),
} satisfies Record<string, Handler>;
