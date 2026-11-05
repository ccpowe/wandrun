import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation } from '../src/gateway/api.ts';
import { ChatSession } from '../src/gateway/session.ts';
import { chatEntryTarget } from '../src/lib/conversation-navigation.ts';

function conversation(id: string, agentId: string, activity: number, fields: Partial<Conversation> = {}): Conversation {
  return { id, agent_id: agentId, title: id, created_at: 1, updated_at: activity, last_activity_seq: activity,
    last_activity_at: activity, read_seq: 0, last_agent_seq: 0, status: 'idle', unread: false,
    last_text: 'A message', source: 'user', schedule_origin: null, ...fields };
}
function fixture(conversations: Conversation[], agentIds = ['a', 'b'], fetchImpl: typeof fetch = async () => new Response('{}')) {
  const session = new ChatSession({ baseUrl: 'http://entry', token: 'test' }, fetchImpl);
  session.agents.close();
  session.agents.agents = agentIds.map((id) => ({ id, name: id, avatar: 0, description: '', workers: [], environment: "local", latest_conversation: null, unread: false }));
  session.agents.loaded = true;
  session.connection = 'open';
  session['reset'](conversations, 100);
  return session;
}

test('chat.J1 恢复上次主对话，包括空白；子对话记录不能成为入口', async () => {
  const session = fixture([conversation('blank', 'a', 1, { last_text: null, last_activity_seq: null, last_activity_at: null }), conversation('recent', 'b', 20)]);
  try {
    assert.deepEqual(chatEntryTarget(session, 'blank'), { type: 'conversation', id: 'blank' });
    session['apply']({ seq: 101, at: 21, type: 'task.created', conversation_id: 'recent', data: {
      task_id: 'child', creator_task_id: 'recent', creator_agent_id: 'b', agent_id: 'a', title: 'Child', status: 'waiting', timeline_ids: ['recent', 'child'],
    } });
    assert.deepEqual(chatEntryTarget(session, 'child'), { type: 'conversation', id: 'recent' });
  } finally { await session.close(); }
});

test('chat.J2 删除后按跨 Agent 产品活动落点，不受重命名时间影响', async () => {
  const session = fixture([conversation('gone', 'a', 30), conversation('same-agent', 'a', 5, { updated_at: 1000 }), conversation('other-agent', 'b', 20)]);
  try {
    session['apply']({ seq: 101, at: 40, type: 'conversation.deleted', data: { id: 'gone', agent_id: 'a' } });
    assert.deepEqual(chatEntryTarget(session, 'gone'), { type: 'conversation', id: 'other-agent' });
  } finally { await session.close(); }
});

test('chat.J2 已删除 Agent 的缓存对话不能被上次记录恢复', async () => {
  const session = fixture([conversation('orphan', 'a', 30), conversation('remaining', 'b', 20)]);
  try {
    session.agents.deletedIds.add('a');
    assert.deepEqual(chatEntryTarget(session, 'orphan'), { type: 'conversation', id: 'remaining' });
  } finally { await session.close(); }
});

test('chat.J3 无可恢复内容时按统一顺序选 Agent，不误把空白根对话当最近内容', async () => {
  const session = fixture([conversation('other-blank', 'b', 30, { last_text: null, last_activity_seq: null, last_activity_at: null })]);
  try {
    assert.deepEqual(chatEntryTarget(session), { type: 'new', agentId: 'b' });
    session.pending.set('pending', { clientId: 'pending', conversationId: 'other-blank', text: 'Unconfirmed', attachments: [], status: 'failed', error: 'offline', retryable: true });
    assert.deepEqual(chatEntryTarget(session), { type: 'conversation', id: 'other-blank' });
  } finally { await session.close(); }
});

test('chat.J4/J6 只有成功确认的零 Agent 才显示新建，不把初次读取当空列表', async () => {
  const session = fixture([], []);
  try {
    session.agents.loaded = false;
    assert.deepEqual(chatEntryTarget(session), { type: 'wait' });
    session.agents.loaded = true;
    session.connection = 'listing';
    assert.deepEqual(chatEntryTarget(session), { type: 'wait' });
    session.connection = 'open';
    assert.deepEqual(chatEntryTarget(session), { type: 'empty' });
    session.agents.error = 'offline';
    assert.deepEqual(chatEntryTarget(session), { type: 'unavailable' });
  } finally { await session.close(); }
});

test('chat.J5 列表失败仍使用缓存主对话；缓存 Agent 可打开本地新对话', async () => {
  const session = fixture([conversation('cached', 'a', 10)]);
  try {
    session.connection = 'error';
    assert.deepEqual(chatEntryTarget(session), { type: 'conversation', id: 'cached' });
    session.conversations.clear();
    assert.deepEqual(chatEntryTarget(session), { type: 'new', agentId: 'a' });
  } finally { await session.close(); }
});

test('chat.J9 首次连接按统一顺序开新对话，不被已有远端历史取代', async () => {
  const session = fixture([conversation('remote-history', 'b', 20)]);
  try {
    assert.deepEqual(chatEntryTarget(session), { type: 'conversation', id: 'remote-history' });
    assert.deepEqual(chatEntryTarget(session, undefined, true), { type: 'new', agentId: 'b' });
    session.agents.loaded = false;
    assert.deepEqual(chatEntryTarget(session, undefined, true), { type: 'wait' });
  } finally { await session.close(); }
});

