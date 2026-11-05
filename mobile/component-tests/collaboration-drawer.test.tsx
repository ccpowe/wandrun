import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { BrowserTask, Conversation } from '../src/gateway/api';
import { ChatSession } from '../src/gateway/session';
import { SceneProviders } from '../src/dev/scene-providers';
import { useConversationDrawer } from '../src/lib/use-conversation-drawer';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));

function Wrapper({ children }: { children: ReactNode }) {
  return <SceneProviders path="/chat" location="/chat?id=root">{children}</SceneProviders>;
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function conversation(id: string, agentId: string, fields: Partial<Conversation> = {}): Conversation {
  return { id, agent_id: agentId, title: id, status: 'idle', unread: false, read_seq: 0, last_agent_seq: 0,
    last_activity_seq: 1, last_activity_at: 1,
    created_at: 1, updated_at: 1, last_text: 'Existing message', source: 'user', schedule_origin: null, ...fields };
}
async function fixture(conversations: Conversation[]) {
  const session = new ChatSession({ baseUrl: 'http://drawer', token: 'test' }, async () => new Response('{}'));
  session.agents.close();
  session['reset'](conversations, 1);
  const mounted = await renderHook<ReturnType<typeof useConversationDrawer>, { currentId: string }>(({ currentId }) => useConversationDrawer(session, currentId, 'parent', false), {
    wrapper: Wrapper, initialProps: { currentId: 'other' },
  });
  return { session,
    async rows(currentId = 'other') {
      await mounted.rerender({ currentId });
      return mounted.result.current.drawerProps.conversations;
    },
    async close() { await mounted.unmount(); await session.close(); },
  };
}

test('conversation-drawer.E1 当前行隐藏红点，其他主对话继续聚合协作提醒', async () => {
  const f = await fixture([conversation('root', 'parent'), conversation('another', 'member')]);
  await apply(f.session, { seq: 2, at: 2, type: 'task.created', conversation_id: 'root', data: {
    task_id: 'child', creator_task_id: 'root', creator_agent_id: 'parent', agent_id: 'member', title: 'Child', status: 'waiting', timeline_ids: ['root', 'child'],
  } });
  f.session.tasks.get('child')!.unread = false;
  const lease: BrowserTask = { id: 'lease', task_id: 'child', root_id: 'root', agent_id: 'member', entry_agent_id: 'parent',
    conversation_title: 'Root', entry_agent_name: 'Parent', state: 'requested', epoch: 1, pages: [], current: null,
    environment_id: 'local', environment_name: 'Local', capacity: { pages_used: 0, pages_registered: 0, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 3 },
    capacity_rejection: null, reason: null, requested_reason: '需要确认' };
  f.session.browserTasks.set(lease.id, lease);
  try {
    let rows = await f.rows('root');
    expect(rows.map(row => row.id)).toEqual(['root', 'another']);
    expect(rows[0].collaborationCount).toBe(1);
    expect(rows[0].unread).toBe(false);
    expect(rows[1].unread).toBe(false);
    expect((await f.rows('another'))[0].unread).toBe(true);
    lease.state = 'human';
    rows = await f.rows();
    expect(rows[0].unread).toBe(false);
    f.session.tasks.get('child')!.unread = true;
    expect((await f.rows('root'))[0].unread).toBe(false);
    expect((await f.rows())[0].unread).toBe(false);
    f.session.tasks.get('child')!.unread = false;
    f.session.tasks.get('child')!.status = 'failed';
    expect((await f.rows('root'))[0].unread).toBe(false);
    expect((await f.rows())[0].unread).toBe(true);
    f.session.tasks.get('child')!.status = 'completed';
    f.session.conversations.get('another')!.status = 'failed';
    expect((await f.rows())[1].unread).toBe(true);
    expect((await f.rows('another'))[1].unread).toBe(false);
  } finally { await f.close(); }
});

test('conversation-drawer.E6 空白不占列表，只有 Agent 回复的定时对话照常出现', async () => {
  const f = await fixture([conversation('blank', 'parent', { last_text: null, last_activity_seq: null, last_activity_at: null }), conversation('schedule', 'member', { source: 'schedule', last_text: 'Daily result' })]);
  try {
    expect((await f.rows()).map(row => row.id)).toEqual(['schedule']);
    f.session.pending.set('pending-id', { clientId: 'pending-id', conversationId: 'blank', text: 'Unconfirmed user message', attachments: [], error: 'offline', status: 'failed', retryable: true });
    expect((await f.rows()).map(row => row.id)).toEqual(['schedule', 'blank']);
  } finally { await f.close(); }
});

test('conversation-drawer.E1 产品活动顺序不被重命名时间或目录缺失覆盖', async () => {
  const parent = 'a_11111111111111111111111111111111';
  const f = await fixture([
    conversation('recent', parent, { last_activity_seq: 9, last_activity_at: 9, updated_at: 9 }),
    conversation('renamed', 'member', { last_activity_seq: 8, last_activity_at: 8, updated_at: 100 }),
  ]);
  try {
    const rows = await f.rows();
    expect(rows.map(row => row.id)).toEqual(['recent', 'renamed']);
    expect(rows[0].agent.name).toBe('Agent');
  } finally { await f.close(); }
});

async function apply(session: ChatSession, event: Record<string, unknown>) {
  await act(async () => { session['apply'](event as never); });
}

test('conversation-drawer.P6 P7 P8 AI 未读回复亮红点不移动行；注入 conversation.read 与本机打开页面后红点消失；换 currentId 验证当前行不亮；失败不被已读清除', async () => {
  const f = await fixture([
    conversation('high', 'parent', { last_activity_seq: 10, last_activity_at: 10 }),
    conversation('low', 'member', { last_activity_seq: 5, last_activity_at: 5 }),
  ]);
  try {
    expect((await f.rows()).map(row => [row.id, row.unread])).toEqual([['high', false], ['low', false]]);
    // AI 在较旧的 low 上回复（事件 seq 晚于快照水位）：亮红点，次序和时间不变。
    await apply(f.session, { seq: 20, at: 20, type: 'message.agent', conversation_id: 'low', data: { text: 'AI 回复', attachments: [] } });
    let rows = await f.rows();
    expect(rows.map(row => [row.id, row.unread, row.activityAt])).toEqual([['high', false, 10], ['low', true, 5]]);
    // 当前打开的那一行不亮。
    expect((await f.rows('low'))[1].unread).toBe(false);
    // 另一设备看过：conversation.read 事件追上最后一条 AI 回复，红点消失。
    await apply(f.session, { seq: 21, at: 21, type: 'conversation.read', conversation_id: 'low', data: { seq: 20 } });
    rows = await f.rows();
    expect(rows.map(row => [row.id, row.unread])).toEqual([['high', false], ['low', false]]);
    // 本机打开该页面（session.view）会写已读，红点同样消失。
    await apply(f.session, { seq: 25, at: 25, type: 'message.agent', conversation_id: 'low', data: { text: '又一条', attachments: [] } });
    expect((await f.rows())[1].unread).toBe(true);
    let stop = () => {};
    f.session.connection = 'open';
    await act(async () => { stop = f.session.view('low'); for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect((await f.rows()).find(row => row.id === 'low')!.unread).toBe(false);
    stop();
    // 用户发送才把 low 移到最上，时间随之更新。
    await apply(f.session, { seq: 22, at: 22, type: 'message.user', conversation_id: 'low', data: { text: '我发的', attachments: [] } });
    expect((await f.rows()).map(row => [row.id, row.activityAt])).toEqual([['low', 22], ['high', 10]]);
    // 需要处理类红点与未读叠加：已读不能清除失败。
    await apply(f.session, { seq: 23, at: 23, type: 'message.agent', conversation_id: 'high', data: { text: '失败前回复', attachments: [] } });
    f.session.conversations.get('high')!.status = 'failed';
    await apply(f.session, { seq: 24, at: 24, type: 'conversation.read', conversation_id: 'high', data: { seq: 23 } });
    expect((await f.rows()).find(row => row.id === 'high')!.unread).toBe(true);
  } finally { await f.close(); }
});

test('conversation-drawer.P9 只有 AI 回复、没有用户发送的根排在最后并标记 unranked，未确认行不标记', async () => {
  const f = await fixture([
    conversation('reply-only', 'parent', { last_activity_seq: null, last_activity_at: null, last_text: 'AI says', unread: true, last_agent_seq: 3 }),
    conversation('ranked', 'member', { last_activity_seq: 4, last_activity_at: 4 }),
    conversation('blank', 'member', { last_text: null, last_activity_seq: null, last_activity_at: null }),
  ]);
  try {
    f.session.pending.set('p', { clientId: 'p', conversationId: 'blank', text: 'Unconfirmed', attachments: [], error: 'offline', status: 'failed', retryable: true });
    const rows = await f.rows();
    // 两类“无时间”行相对次序无关紧要：分组时未确认行置今天最前，unranked 行归更早。
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    expect(rows[0].id).toBe('ranked');
    expect([byId.blank.unranked, byId.blank.activityAt]).toEqual([false, null]);
    expect([byId['reply-only'].unranked, byId['reply-only'].activityAt, byId['reply-only'].unread]).toEqual([true, null, true]);
  } finally { await f.close(); }
});

test('conversation-drawer.P9 E7 只有 AI 回复的根上出现未确认首发时，按未确认行处理而不是 unranked', async () => {
  const f = await fixture([
    conversation('reply-only', 'parent', { last_activity_seq: null, last_activity_at: null, last_text: 'AI says' }),
  ]);
  try {
    expect((await f.rows())[0].unranked).toBe(true);
    f.session.pending.set('p', { clientId: 'p', conversationId: 'reply-only', text: 'Unconfirmed', attachments: [], error: null, status: 'sending', retryable: false });
    expect((await f.rows())[0].unranked).toBe(false);
  } finally { await f.close(); }
});
