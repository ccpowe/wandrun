import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { DraftDelta, DraftPreview, GatewayEvent } from '../src/gateway/api.ts';
import { Drafts } from '../src/gateway/drafts.ts';
import { ChatSession } from '../src/gateway/session.ts';

const draft = (text: string, id = 'd'): DraftPreview => ({
  draft_id: id, conversation_id: 'root', sender: 'task', agent: 'writer', text, phase: 'final_answer',
});
const snapshot = (revision: number, text: string) => ({ epoch: 'a', revision, as_of_seq: 0, drafts: [draft(text)] });
const delta = (base: number, revision: number, text: string, offset: number): DraftDelta => ({
  epoch: 'a', base_revision: base, revision, as_of_seq: 0, active_ids: ['d'], updates: [{ ...draft(text), offset }],
});
const terminal = (seq = 1): GatewayEvent => ({
  seq, type: 'message.agent', conversation_id: 'root', at: 1,
  data: { draft_id: 'd', text: 'Frozen', agent: 'writer', status: 'interrupted' },
});

test('append coordinates use UTF-16; coalesced revisions skip publications, never duplicate text', () => {
  const state = new Drafts();
  state.snapshot(snapshot(1, '中😀'));
  const update = delta(1, 5, '甲😀', 3);
  assert.equal(state.delta(update), 'changed');
  assert.equal(state.forConversation('root')[0].text, '中😀甲😀');
  assert.equal(state.delta(update), 'ignored');
  assert.equal(state.forConversation('root')[0].text, '中😀甲😀');
  assert.equal(state.delta(delta(5, 6, '乙', 6)), 'changed');
  assert.equal(state.forConversation('root')[0].text, '中😀甲😀乙');
});

test('a missing baseline, offset or revision gap rejects the entire batch until a snapshot recovers it', () => {
  const state = new Drafts();
  assert.equal(state.delta(delta(0, 1, 'first', 0)), 'gap');
  state.snapshot(snapshot(1, 'prefix'));
  assert.equal(state.delta(delta(0, 2, 'wrong revision', 6)), 'gap');
  assert.equal(state.delta(delta(1, 2, 'wrong offset', 5)), 'gap');
  const batch = delta(1, 3, ' valid', 6);
  batch.active_ids.push('missing');
  batch.updates.push({ ...draft('invalid', 'missing'), offset: 10 });
  assert.equal(state.delta(batch), 'gap');
  assert.equal(state.forConversation('root')[0].text, 'prefix');
  state.reconnect();
  assert.equal(state.delta(delta(1, 3, 'before snapshot', 0)), 'gap');
  state.snapshot(snapshot(3, 'authoritative'));
  assert.equal(state.delta(delta(3, 4, ' suffix', 13)), 'changed');
  assert.equal(state.forConversation('root')[0].text, 'authoritative suffix');
});

test('terminal-before-delta cannot revive; covering omission reclaims even unpublished identities', () => {
  const state = new Drafts();
  state.snapshot(snapshot(0, 'prefix'));
  for (let round = 0; round < 1000; round++) {
    const event = terminal(round + 1);
    state.terminalEvent(event);
    const inclusion = { ...delta(round * 2, round * 2 + 1, 'late', 123), as_of_seq: round };
    assert.equal(state.delta(inclusion), 'changed');
    assert.deepEqual(state.forConversation('root'), []);
    assert.equal(state['terminal'].size, 1);
    const omission = { ...delta(round * 2 + 1, round * 2 + 2, '', 0), as_of_seq: round + 1, active_ids: [], updates: [] };
    assert.equal(state.delta(omission), 'changed');
    assert.equal(state['terminal'].size, 0);
    assert.equal(state.order.size, 0);
    assert.equal(state.delta(inclusion), 'ignored');
  }
});

function openSession() {
  const connections: ReadableStreamDefaultController<Uint8Array>[] = [];
  let onConnect = () => {};
  const session = new ChatSession({ baseUrl: 'http://gateway', token: 'dev' }, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/events') return new Response(new ReadableStream({ start(controller) {
      connections.push(controller);
      onConnect();
    } }));
    if (path === '/conversations') return Response.json({ as_of_seq: 0, conversations: [{
      id: 'root', agent_id: 'writer', title: 'Chat', created_at: 1, updated_at: 1, read_seq: 0,
      status: 'working', unread: false, last_text: null, source: 'user', schedule_origin: null,
    }] });
    if (path === '/agents') return Response.json({ agents: [], as_of_seq: 0 });
    if (path === '/browser-tasks') return Response.json({ browser_tasks: [], as_of_seq: 0 });
    throw Error(`Unexpected request: ${path}`);
  }, { retryDelays: [0] });
  return {
    session,
    send(events: { type: string; data: object }[]) {
      connections.at(-1)!.enqueue(new TextEncoder().encode(events.map((event) =>
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')));
    },
    nextConnection() { return new Promise<void>((resolve) => { onConnect = resolve; }); },
  };
}

test('preview bursts coalesce React notifications; interruption publishes immediately and never revives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { session, send } = openSession();
  try {
    await session.start();
    await setImmediate();
    send([{ type: 'draft.snapshot', data: snapshot(0, '长'.repeat(20000)) }]);
    await setImmediate();
    const displayed: { text: string | undefined; status: unknown }[] = [];
    session.subscribe(() => displayed.push({
      text: session.draftsFor('root')[0]?.text,
      status: session.timeline('root').events.at(-1)?.data.status,
    }));
    send(Array.from({ length: 100 }, (_, i) => ({ type: 'draft.delta', data: delta(i, i + 1, '文', 20000 + i) })));
    await setImmediate();
    assert.deepEqual(displayed, []);
    t.mock.timers.tick(250);
    assert.deepEqual(displayed, [{ text: '长'.repeat(20000) + '文'.repeat(100), status: undefined }]);
    displayed.length = 0;
    send([{ type: 'draft.delta', data: delta(100, 101, '尾', 20100) }, terminal()]);
    await setImmediate();
    assert.deepEqual(displayed[0], { text: undefined, status: 'interrupted' });
    t.mock.timers.tick(250);
    // Agent-list refresh may also notify; every visible state must remain terminal.
    for (const state of displayed) assert.deepEqual(state, { text: undefined, status: 'interrupted' });
  } finally { await session.close(); }
});

test('an SSE delta gap reconnects for a full snapshot and then resumes appending', { timeout: 2000 }, async () => {
  const { session, send, nextConnection } = openSession();
  try {
    await session.start();
    await setImmediate();
    send([{ type: 'draft.snapshot', data: snapshot(0, 'a') }]);
    await setImmediate();
    const reconnected = nextConnection();
    send([{ type: 'draft.delta', data: delta(1, 2, 'missing base', 2) }]);
    await reconnected;
    await setImmediate();
    send([{ type: 'draft.snapshot', data: snapshot(2, 'abc') }, { type: 'draft.delta', data: delta(2, 3, 'd', 3) }]);
    await setImmediate();
    assert.equal(session.draftsFor('root')[0].text, 'abcd');
  } finally { await session.close(); }
});
