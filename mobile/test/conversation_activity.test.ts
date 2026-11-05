import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserTask, Conversation, GatewayEvent } from '../src/gateway/api.ts';
import { ChatSession } from '../src/gateway/session.ts';
import { conversationActivityOrder } from '../src/lib/conversation-activity.ts';
import { chatEntryTarget } from '../src/lib/conversation-navigation.ts';

function root(id: string, seq: number, at: number, updatedAt: number): Conversation {
  return { id, agent_id: id, title: id, created_at: 1, updated_at: updatedAt, read_seq: 0, last_agent_seq: 0,
    status: 'idle', unread: false, last_text: 'Snapshot message', source: 'user', schedule_origin: null,
    last_activity_seq: seq, last_activity_at: at };
}

test('conversation-drawer.P1 排序活动：只有用户发送与定时触发推进，其余事件（含 AI 回复、浏览器请求）不改次序与时间', async () => {
  const session = new ChatSession({ baseUrl: 'http://activity', token: 'test' }, async () => new Response('{}'));
  session.agents.close();
  session['reset']([root('a', 10, 200, 9999), root('b', 20, 199, 199)], 20);
  session.connection = 'open';
  const apply = (seq: number, at: number, type: string, data: GatewayEvent['data']) =>
    session['apply']({ seq, at, type, conversation_id: 'a', data });
  try {
    assert.deepEqual(chatEntryTarget(session), { type: 'conversation', id: 'b' });
    apply(21, 197, 'task.created', { task_id: 'child', creator_task_id: 'a', creator_agent_id: 'a', agent_id: 'b',
      title: 'Child', status: 'running', timeline_ids: ['a', 'child'] });
    const lease: BrowserTask = { id: 'lease', task_id: 'child', root_id: 'a', agent_id: 'b', entry_agent_id: 'a',
      conversation_title: 'a', entry_agent_name: 'A', state: 'requested', epoch: 1, pages: [], current: null,
      environment_id: 'local', environment_name: 'Local', reason: null, requested_reason: '请确认', capacity_rejection: null,
      capacity: { pages_used: 0, pages_registered: 0, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 3 } };
    const current = session.conversations.get('a')!;
    // 浏览器请求、AI 回复（根与子对话）、重命名、状态、已读：次序和时间都不动。
    apply(30, 198, 'browser_task.updated', { ...lease });
    apply(29, 202, 'message.agent', { task_id: 'child', text: 'Private child reply', attachments: [], timeline_ids: ['child'] });
    apply(31, 10000, 'conversation.updated', { title: 'Renamed only' });
    apply(32, 10001, 'conversation.status', { status: 'working' });
    apply(33, 10002, 'conversation.read', { seq: 30 });
    apply(34, 10003, 'message.agent', { text: 'AI 回复', attachments: [] });
    assert.equal(current.last_activity_seq, 10);
    assert.equal(current.last_activity_at, 200);
    assert.equal(current.last_text, 'AI 回复');
    assert.equal(current.unread, true);
    assert.deepEqual(chatEntryTarget(session), { type: 'conversation', id: 'b' });
    // 用户发送推进；较早到达的旧事件不覆盖较新配对。
    apply(40, 300, 'message.user', { text: '我发的', attachments: [] });
    apply(36, 250, 'message.user', { text: '迟到的旧事件', attachments: [] });
    assert.equal(current.last_activity_seq, 40);
    assert.equal(current.last_activity_at, 300);
    assert.deepEqual(chatEntryTarget(session), { type: 'conversation', id: 'a' });
  } finally { await session.close(); }
});

test('conversation-drawer.P4 / P10 定时触发与子对话里的用户插话推进根', async () => {
  const session = new ChatSession({ baseUrl: 'http://activity', token: 'test' }, async () => new Response('{}'));
  session.agents.close();
  session['reset']([root('a', 10, 200, 200), root('b', 20, 199, 199)], 20);
  session.connection = 'open';
  const apply = (seq: number, at: number, conversation: string, type: string, data: GatewayEvent['data']) =>
    session['apply']({ seq, at, type, conversation_id: conversation, data });
  try {
    apply(21, 300, 'a', 'schedule.triggered', { schedule_id: 's', run_id: 'r', name: 'n' });
    assert.equal(session.conversations.get('a')!.last_activity_seq, 21);
    apply(22, 301, 'b', 'task.created', { task_id: 'child', creator_task_id: 'b', creator_agent_id: 'b', agent_id: 'a',
      title: 'Child', status: 'running', timeline_ids: ['b', 'child'] });
    apply(23, 302, 'b', 'message.user', { task_id: 'child', text: '插话', attachments: [], timeline_ids: ['child'] });
    assert.equal(session.conversations.get('b')!.last_activity_seq, 23);
    assert.equal(session.conversations.get('b')!.last_activity_at, 302);
  } finally { await session.close(); }
});

test('conversation-drawer.E7 无确认活动的行置后，同组保留本地顺序', () => {
  const rows = [
    { id: 'first-local', last_activity_seq: null },
    { id: 'confirmed', last_activity_seq: 10 },
    { id: 'second-local', last_activity_seq: null },
  ];
  assert.deepEqual(rows.sort(conversationActivityOrder).map((item) => item.id), ['confirmed', 'first-local', 'second-local']);
});
