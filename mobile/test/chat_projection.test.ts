import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectChatRows } from '../src/lib/chat-timeline.ts';
import { memoryNewConversation, newChatReducer, type NewChatAttempt, type NewChatState } from '../src/lib/new-conversation.ts';
import type { DraftPreview, GatewayEvent } from '../src/gateway/api.ts';
import { ChatSession, type Pending } from '../src/gateway/session.ts';
import { Drafts } from '../src/gateway/drafts.ts';
import { chatEntryTarget } from '../src/lib/conversation-navigation.ts';
import { chatDisplay } from './fixtures/chat-projection.ts';

const attempt: NewChatAttempt = { computerId: 'computer', agentId: 'writer', clientId: 'create',
  messageClientId: 'first', kind: 'send', text: '首文', files: [] };

test('chat.O3 O5 O6 同一个首发 attempt 只改变 reducer 阶段，同行发送状态与重试随之改变', () => {
  const creating: NewChatState = { status: 'creating', operation: 'create', error: null,
    saved: { text: '下一段', selection: null, attempt } };
  const unknown = newChatReducer(creating, { type: 'unknown', operation: 'create', error: '结果未知' });
  assert.equal(unknown.status === 'unknown' && unknown.saved.attempt, attempt);
  const resumed = newChatReducer(unknown, { type: 'retry' });
  const failed = newChatReducer(creating, { type: 'ended', operation: 'create', error: '拒绝', keepText: true });
  for (const [state, delivery, retryable] of [
    [{ ...creating, status: 'preparing', kind: 'send' }, 'sending', false],
    [creating, 'sending', false], [unknown, 'unconfirmed', true],
    [resumed, 'sending', false], [failed, 'failed', true],
  ] as const) {
    const rows = projectChatRows({ events: [], pending: [], firstIntent: {
      attempt, status: state.status, error: state.error, belongsToServer: true,
    } }).rows;
    assert.deepEqual(rows.map(row => [row.key, row.kind === 'user' && row.delivery, row.kind === 'user' && row.retryable]),
      [['pfirst', delivery, retryable]]);
    assert.equal(rows[0].pending?.text, '首文');
  }
  const foreign = projectChatRows({ events: [], pending: [], firstIntent: {
    attempt, status: 'unknown', error: null, belongsToServer: false,
  } }).rows[0];
  assert.equal(foreign.kind === 'user' && foreign.retryable, false);
  assert.deepEqual(projectChatRows({ timelineId: 'bound', events: [], pending: [], firstIntent: {
    attempt, status: 'unknown', error: null, belongsToServer: true,
  } }).rows, []);
});

const question: GatewayEvent = { seq: 1, at: 1, conversation_id: 'root', type: 'message.user',
  client_id: 'first', data: { text: '首文' } };
const preview: DraftPreview = { draft_id: 'reply', conversation_id: 'root', sender: 'root', agent: 'writer', text: '正文', phase: null };
const facts = { working: true, stopping: false, activity: null, waitingForMembers: false };

test('chat.D1 D2 T5 T6 快速/慢速发送、超时、同键重试与迟到确认只改变同行 delivery', () => {
  const pending: Pending = { conversationId: 'root', clientId: 'first', text: '首文', status: 'sending', retryable: true, error: null };
  const sending = projectChatRows({ events: [], pending: [pending] }).rows[0];
  for (const reason of ['timeout', 'offline', 'rejected', 'recovered', 'deferred'] as const) {
    const failed = projectChatRows({ events: [], pending: [{ ...pending, status: 'failed', reason, error: '不以此文案分类' }] }).rows[0];
    assert.equal(failed.key, sending.key);
    assert.equal(failed.kind === 'user' && failed.delivery,
      reason === 'timeout' || reason === 'recovered' || reason === 'deferred' ? 'unconfirmed' : 'failed');
  }
  const accepted = projectChatRows({ events: [question], pending: [pending] }).rows;
  assert.deepEqual(accepted.map(row => [row.key, row.kind === 'user' && row.delivery]), [['pfirst', 'sent']]);
  pending.status = 'failed';
  pending.reason = 'timeout';
  const unknown = projectChatRows({ events: [], pending: [pending] }).rows[0];
  pending.status = 'sending'; pending.reason = undefined;
  const retrying = projectChatRows({ events: [], pending: [pending] }).rows[0];
  assert.deepEqual([unknown, retrying].map(row => [row.key, row.kind === 'user' && row.delivery]),
    [['pfirst', 'unconfirmed'], ['pfirst', 'sending']]);
  assert.equal(sending.pending?.status, 'sending', 'old display rows do not alias mutable Pending');
});

test('chat.O3 O4 O8 首发从意图到 pending 到确认保持身份，awaiting 未绑定仍是普通失败', () => {
  const firstIntent = { attempt, status: 'creating' as const, error: null, belongsToServer: true };
  const before = projectChatRows({ events: [], pending: [], firstIntent }).rows[0];
  const pending: Pending = { conversationId: 'root', clientId: 'first', text: attempt.text, status: 'sending', retryable: true, error: null };
  const bound = projectChatRows({ timelineId: 'root', events: [], pending: [pending], firstIntent }).rows[0];
  const accepted = projectChatRows({ timelineId: 'root', events: [question], pending: [], firstIntent }).rows[0];
  assert.deepEqual([before, bound, accepted].map(row => [row.key, row.kind === 'user' && row.delivery]),
    [['pfirst', 'sending'], ['pfirst', 'sending'], ['pfirst', 'sent']]);
  const awaiting = projectChatRows({ events: [], pending: [], firstIntent: { ...firstIntent, status: 'awaiting' } }).rows[0];
  assert.equal(awaiting.kind === 'user' && awaiting.delivery, 'failed');
});

test('chat.D6 B3 B5 停止 > 活动 > 等待成员 > 工作中；执行状态不从草稿或传输状态推断', () => {
  for (const [turnFacts, label] of [
    [{ ...facts, stopping: true, activity: '正在读网页', waitingForMembers: true }, '正在停止…'],
    [{ ...facts, activity: '正在读网页', waitingForMembers: true }, '正在读网页'],
    [{ ...facts, waitingForMembers: true }, '等待成员结果'],
    [facts, '工作中…'],
  ] as const) {
    const { rows, turn } = projectChatRows({ events: [], pending: [], turnFacts });
    assert.deepEqual(turn, { working: true, stopping: turnFacts.stopping, label });
    assert.deepEqual(rows, [{ kind: 'working', key: 'working', label }]);
  }
  const idle = projectChatRows({ events: [], pending: [], drafts: [preview], turnFacts: { ...facts, working: false } });
  assert.equal(idle.turn.working, false);
  assert.deepEqual(idle.rows.map(row => row.key), ['dreply']);
});

test('chat.D3 T8 流式增长、定稿与覆盖快照维持同 key；t4 定稿不提前结束 t5 的工作状态', () => {
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [preview] }, () => 1);
  const input = { timelineId: 'root', events: [question], pending: [], drafts: state.forConversation('root'), draftOrder: state.order, turnFacts: facts };
  const streaming = projectChatRows(input);
  const growing = projectChatRows({ ...input, drafts: [{ ...preview, text: '正文继续增长' }] });
  const final: GatewayEvent = { seq: 2, at: 2, conversation_id: 'root', type: 'message.agent',
    data: { draft_id: 'reply', agent: 'writer', text: '正文继续增长', status: 'completed' } };
  const completed = projectChatRows({ ...input, events: [question, final] });
  const covered = projectChatRows({ ...input, events: [question, final], drafts: [] });
  assert.deepEqual(streaming.rows.map(row => row.key), ['pfirst', 'dreply', 'working']);
  assert.equal(growing.rows[1].draft?.text, '正文继续增长');
  assert.deepEqual([streaming, growing, completed].map(result => {
    const row = result.rows[1]; return [row.key, row.kind === 'agent' && row.phase];
  }), [['dreply', 'streaming'], ['dreply', 'streaming'], ['dreply', 'final']]);
  assert.deepEqual(covered, completed);
  const ended = projectChatRows({ ...input, events: [question, final], drafts: [], turnFacts: { ...facts, working: false } });
  assert.deepEqual(ended.rows.map(row => row.key), ['pfirst', 'dreply']);
});

test('chat.T7 T8 停止、插话、运行失败和权威撤销分别如实投影，不遗留 working 或重复预览', () => {
  const interrupted: GatewayEvent = { seq: 2, at: 2, conversation_id: 'root', type: 'message.agent',
    data: { draft_id: 'reply', agent: 'writer', text: '正文', status: 'interrupted' } };
  const stopped: GatewayEvent = { seq: 3, at: 3, conversation_id: 'root', type: 'turn.stopped', data: { was_working: true } };
  const stopRows = projectChatRows({ events: [question, interrupted, stopped], pending: [], drafts: [preview], turnFacts: { ...facts, working: false } }).rows;
  assert.deepEqual(stopRows.map(row => [row.key, row.kind === 'agent' ? row.phase : row.kind]),
    [['pfirst', 'user'], ['dreply', 'interrupted'], ['e3', 'event']]);
  const interjection = { ...question, seq: 4, client_id: 'next', data: { text: '新要求' } };
  const interruptedRows = projectChatRows({ events: [question, interrupted, interjection], pending: [], drafts: [preview], turnFacts: facts }).rows;
  assert.deepEqual(interruptedRows.map(row => row.key), ['pfirst', 'dreply', 'pnext', 'working']);
  const failed: GatewayEvent = { seq: 3, at: 3, conversation_id: 'root', type: 'turn.failed', data: { error: '未完成' } };
  assert.deepEqual(projectChatRows({ events: [question, interrupted, failed], pending: [], turnFacts: { ...facts, working: false } }).rows.map(row => row.key),
    ['pfirst', 'dreply', 'e3']);
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [preview] });
  assert.deepEqual(projectChatRows({ events: [question], pending: [], drafts: state.forConversation('root') }).rows.map(row => row.key), ['pfirst', 'dreply']);
  state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 1, drafts: [] });
  assert.deepEqual(projectChatRows({ events: [question], pending: [], drafts: state.forConversation('root') }).rows.map(row => row.key), ['pfirst']);
  state.reset();
  assert.deepEqual(projectChatRows({ events: [], pending: [], drafts: state.forConversation('root') }).rows, []);
});

test('chat.O8 deferred 离线重试不发请求、不改状态，在线同键发送后变 sent', async () => {
  const requests: unknown[] = [];
  const session = new ChatSession({ baseUrl: 'http://deferred', token: 'test' }, async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ event: question });
  });
  session.agents.close();
  try {
    session.restoreFirstSend('root', 'first', '首文', [], 'deferred');
    const before = projectChatRows({ timelineId: 'root', events: [], pending: session.pendingFor('root') });
    const version = session.getVersion();
    await session.retry('first'); await session.retry('first');
    assert.equal(session.getVersion(), version);
    assert.deepEqual(projectChatRows({ timelineId: 'root', events: [], pending: session.pendingFor('root') }), before);
    assert.deepEqual(requests, []);
    session.connection = 'open';
    await session.retry('first');
    assert.deepEqual(requests, [{ client_id: 'first', text: '首文', attachments: [] }]);
    assert.deepEqual(projectChatRows({ timelineId: 'root', events: session.timeline('root').events, pending: session.pendingFor('root') }).rows.map(row =>
      [row.key, row.kind === 'user' && row.delivery]), [['pfirst', 'sent']]);
  } finally { await session.close(); }
});

test('chat.N10 recovered 首屏未到或失败都显示未确认，重复恢复、迟到确认与删除不重建行', async () => {
  const session = new ChatSession({ baseUrl: 'http://recovered', token: 'test' }, async () => Response.json({}));
  session.agents.close();
  try {
    session['apply']({ seq: 1, at: 0, conversation_id: 'root', type: 'conversation.created', data: { agent_id: 'writer', title: '尚无正式消息' } });
    session.restoreFirstSend('root', 'first', '首文', []);
    session.restoreFirstSend('root', 'first', '首文', []);
    assert.equal(session.pendingFor('root')[0].reason, 'recovered');
    assert.deepEqual(chatEntryTarget(session), { type: 'conversation', id: 'root' });
    for (const historyError of [undefined, '首屏失败']) {
      const rows = projectChatRows({ timelineId: 'root', events: [], pending: session.pendingFor('root'), timelineLoaded: false, historyError }).rows;
      assert.deepEqual(rows.map(row => [row.key, row.kind === 'user' && row.delivery]), [['pfirst', 'unconfirmed']]);
    }
    session['apply']({ ...question, seq: 2 });
    session.restoreFirstSend('root', 'first', '首文', []);
    assert.deepEqual(session.pendingFor('root'), []);
    assert.deepEqual(projectChatRows({ timelineId: 'root', events: session.timeline('root').events, pending: session.pendingFor('root') }).rows.map(row =>
      [row.key, row.kind === 'user' && row.delivery]), [['pfirst', 'sent']]);
    session['apply']({ seq: 4, at: 4, conversation_id: 'root', type: 'conversation.deleted', data: { id: 'root' } });
    session.restoreFirstSend('root', 'first', '首文', []);
    assert.deepEqual(projectChatRows({ timelineId: 'root', events: session.timeline('root').events, pending: session.pendingFor('root') }).rows, []);
  } finally { await session.close(); }
});

test('chat.D4 E5 行显示值和提交记录为当前投影快照，原 Map 后续变化不会偷偷改变旧行', async () => {
  const session = new ChatSession({ baseUrl: 'http://display', token: 'test' }, async () => Response.json({}));
  session.agents.close();
  try {
    const message: GatewayEvent = { seq: 2, at: 2, conversation_id: 'root', type: 'message.agent',
      data: { agent: 'helper', agent_name: '历史名称', text: '正文' } };
    const display = chatDisplay(session, 'root');
    const row = projectChatRows({ timelineId: 'root', events: [message], pending: [], display }).rows[0];
    assert.equal(row.senderName, '历史名称');
    const submission = { createdAt: '2026-11-02T00:00:00Z', values: { answer: 'yes' } };
    const submissions = new Map([[0, submission]]);
    const input = { timelineId: 'root', events: [message], pending: [], display: { ...display, submissionsFor: () => submissions } };
    const before = projectChatRows(input).rows[0];
    submissions.set(1, { createdAt: '2026-11-02T00:00:01Z', values: { answer: 'no' } });
    assert.deepEqual([...before.submissions!.keys()], [0]);
    assert.deepEqual([...projectChatRows(input).rows[0].submissions!.keys()], [0, 1]);
  } finally { await session.close(); }
});

test('chat.G3 O7 发送前已知离线保留字段，没有首发显示行或网络命令', async () => {
  const store = memoryNewConversation();
  store.select('computer', 'writer');
  store.setText('仍在字段中');
  let creates = 0;
  await store.submit({ computerId: 'computer', online: () => false, current: () => true, storeVersion: () => 0,
    create: async () => { creates++; return 'unexpected'; },
    bind: () => { throw Error('offline must not bind'); },
  }, { create: 'create', message: 'first' });
  const state = store.getSnapshot();
  assert.equal(state.status, 'editing');
  assert.equal(state.offline, true);
  assert.equal(state.saved.text, '仍在字段中');
  assert.equal(creates, 0);
  const first = state.saved.attempt ?? state.saved.failure?.attempt;
  assert.deepEqual(projectChatRows({ events: [], pending: [], firstIntent: first
    ? { attempt: first, status: state.status, error: state.error, belongsToServer: true } : undefined }).rows, []);
});

test('chat.N11 换库及关闭清掉 pending、预览与工作状态，旧行不进入新投影', async () => {
  const session = new ChatSession({ baseUrl: 'http://store-reset', token: 'test' }, async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/conversations') return Response.json({ as_of_seq: 0, conversations: [] });
    if (path === '/agents') return Response.json({ as_of_seq: 0, agents: [], order_revision: 0 });
    if (path === '/browser-tasks') return Response.json({ as_of_seq: 0, browser_tasks: [] });
    if (path === '/events') return new Response(new ReadableStream({ start() {} }));
    throw Error(`unexpected path: ${path}`);
  });
  session.agents.close();
  const projection = () => projectChatRows({ timelineId: 'root', events: session.timeline('root').events,
    pending: session.pendingFor('root'), drafts: session.draftsFor('root'), draftOrder: session.drafts.order,
    turnFacts: { ...facts, working: session.isWorking('root'), stopping: session.stopping.has('root') } });
  try {
    session.restoreFirstSend('root', 'first', '首文', []);
    session.drafts.snapshot({ epoch: 'old', revision: 1, as_of_seq: 0, drafts: [preview] });
    assert.deepEqual(projection().rows.map(row => row.key), ['dreply', 'pfirst']);
    const version = session.storeVersion;
    await session['resync']();
    assert.equal(session.storeVersion, version + 1);
    assert.deepEqual(projection().rows, []);
    assert.equal(projection().turn.working, false);
    session.restoreFirstSend('root', 'new', '新库首文', [], 'deferred');
    await session.close();
    assert.deepEqual(projection().rows, []);
    session.restoreFirstSend('root', 'late', '迟到结果', []);
    assert.deepEqual(projection().rows, []);
  } finally { await session.close(); }
});
