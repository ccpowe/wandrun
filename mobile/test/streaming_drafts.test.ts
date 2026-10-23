import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import type { DraftPreview, GatewayEvent } from '../src/gateway/api.ts';
import { Drafts } from '../src/gateway/drafts.ts';
import { ChatSession } from '../src/gateway/session.ts';
import { buildItems } from '../src/lib/chat-timeline.ts';
import { DraftMarkdown, draftTailText } from '../src/lib/draft-markdown.ts';

const draft = (id: string, conversation_id = 'root', agent = 'writer', text = 'Hello'): DraftPreview =>
  ({ draft_id: id, conversation_id, sender: `task-${id}`, agent, text, phase: 'commentary' });
const terminal = (id: string, seq = 2, status = 'completed'): GatewayEvent =>
  ({ seq, type: 'message.agent', conversation_id: 'root', at: seq, data: { draft_id: id, text: 'Final', agent: 'writer', status } });
const question = (seq: number, conversation_id = 'root'): GatewayEvent =>
  ({ seq, type: 'message.user', conversation_id, at: seq, data: { text: `Question ${seq}` } });

test('global snapshots replace rather than append; revision, epoch, reconnect and terminal tombstones', () => {
  const state = new Drafts();
  assert.equal(state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [draft('one'), draft('two', 'other', 'critic')] }), true);
  assert.deepEqual(state.forConversation('root').map((d) => d.draft_id), ['one']);
  assert.equal(state.snapshot({ epoch: 'a', revision: 0, as_of_seq: 1, drafts: [] }), false);
  assert.equal(state.terminalEvent(terminal('one')), true);
  assert.equal(state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 1, drafts: [draft('one'), draft('two', 'other')] }), true);
  assert.deepEqual(state.forConversation('root'), []);
  assert.deepEqual(state.forConversation('other').map((d) => d.draft_id), ['two']);
  state.terminalEvent(terminal('before', 3, 'interrupted'));
  state.reconnect();
  assert.equal(state.snapshot({ epoch: 'b', revision: 0, as_of_seq: 2, drafts: [draft('before'), draft('fresh')] }), true);
  assert.deepEqual(state.forConversation('root').map((d) => d.draft_id), ['fresh']);
  assert.equal(state.snapshot({ epoch: 'a', revision: 3, as_of_seq: 3, drafts: [draft('before')] }), false);
  assert.equal(state.snapshot({ epoch: 'b', revision: 1, as_of_seq: 3, drafts: [] }), true);
  assert.deepEqual(state.forConversation('root'), []);
  assert.equal(state['terminal'].size, 0);
  assert.equal(state.snapshot({ epoch: 'b', revision: 2, drafts: [draft('missing-watermark')] }), false);
});

test('separate sender messages retain separate rows; terminal replaces only its draft key', () => {
  const first = draft('one', 'root', 'writer');
  const second = { ...draft('two', 'root', 'critic'), phase: 'final_answer' };
  assert.deepEqual(buildItems([], [], new Map(), [first, second]).map((i) => i.key), ['done', 'dtwo']);
  const replaced = buildItems([terminal('one')], [], new Map(), [first, second]);
  assert.deepEqual(replaced.map((i) => i.key), ['done', 'dtwo']);
  assert.equal(replaced[0].event?.data.status, 'completed');
  assert.equal(replaced[1].draft?.agent, 'critic');
  assert.deepEqual(buildItems([terminal('one', 2, 'interrupted')], [], new Map(), [first]).map((i) => i.key), ['done']);
});

test('newer sibling completing first retains its row until the other draft terminates', () => {
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 0, drafts: [draft('a'), draft('b')] });
  const rows = (events: GatewayEvent[]) => buildItems(events, [], new Map(), state.forConversation('root'), state.order).map((item) => item.key);
  assert.deepEqual(rows([]), ['da', 'db']);
  const b = terminal('b', 1);
  state.terminalEvent(b);
  assert.deepEqual(rows([b]), ['da', 'db']);
  const a = terminal('a', 2, 'interrupted');
  state.terminalEvent(a);
  assert.deepEqual(rows([b, a]), ['db', 'da']); // Once both are final, seq is authoritative.
});

test('a second streaming round leaves the first formal reply at its historical seq', () => {
  const state = new Drafts();
  const first = question(1);
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [draft('old')] }, () => 1);
  const reply = terminal('old', 2);
  state.terminalEvent(reply);
  state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 2, drafts: [] });
  const second = question(3);
  state.snapshot({ epoch: 'a', revision: 3, as_of_seq: 3, drafts: [draft('new')] }, () => 3);
  assert.deepEqual(buildItems([first, reply, second], [], new Map(), state.forConversation('root'), state.order)
    .map((item) => item.key), ['e1', 'dold', 'e3', 'dnew']);
  assert.equal(state.order.has('old'), false);
});

test('old siblings retain their cohort before a newer question while another worker lingers', () => {
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [draft('a'), draft('b')] }, () => 1);
  const first = question(1);
  const b = terminal('b', 2);
  state.terminalEvent(b);
  const second = question(3);
  state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 3, drafts: [draft('a'), draft('c')] }, () => 3);
  const rows = (events: GatewayEvent[]) => buildItems(events, [], new Map(), state.forConversation('root'), state.order)
    .map((item) => item.key);
  assert.deepEqual(rows([first, b, second]), ['e1', 'da', 'db', 'e3', 'dc']);
  const a = terminal('a', 4);
  state.terminalEvent(a);
  assert.deepEqual(rows([first, b, second, a]), ['e1', 'db', 'e3', 'da', 'dc']);
  assert.equal(state.order.has('b'), false);
  assert.equal(state.order.has('a'), false);
  state.terminalEvent(terminal('c', 5));
  assert.equal(state.order.size, 0);
});

test('a question backfilled after a snapshot still groups later siblings in that round', () => {
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [draft('a')] });
  state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 1, drafts: [draft('a'), draft('b')] }, () => 1);
  const b = terminal('b', 2);
  state.terminalEvent(b);
  assert.equal(state.order.get('a')?.cohort, state.order.get('b')?.cohort);
  assert.deepEqual(buildItems([question(1), b, question(3)], [], new Map(), state.forConversation('root'), state.order)
    .map((item) => item.key), ['e1', 'da', 'db', 'e3']);
});

test('different conversations settle independently; deletion releases their live and terminal identities', () => {
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [draft('root-a'), draft('other-a', 'other')] });
  state.terminalEvent(terminal('root-a', 2));
  assert.equal(state.order.has('root-a'), false);
  assert.equal(state.order.has('other-a'), true);
  state.terminalEvent({ ...terminal('other-a', 3), conversation_id: 'other' });
  state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 3, drafts: [draft('root-live'), draft('other-live', 'other')] });
  state.terminalEvent({ ...terminal('other-pending', 4), conversation_id: 'other' });
  assert.equal(state.removeConversation('other'), true);
  assert.deepEqual(state.forConversation('other'), []);
  assert.equal(state.order.has('other-live'), false);
  assert.equal([...state['terminal'].values()].some((identity) => identity.conversationId === 'other'), false);
  assert.equal(state.order.has('root-live'), true);
});

test('one thousand settled rounds reclaim terminal and order maps without a capacity trim', () => {
  const state = new Drafts();
  for (let round = 0; round < 1000; round++) {
    const seq = round * 2 + 1;
    const id = `round-${round}`;
    assert.equal(state.snapshot({ epoch: 'a', revision: round * 2 + 1, as_of_seq: seq, drafts: [draft(id)] }), true);
    state.terminalEvent(terminal(id, seq + 1));
    assert.equal(state.snapshot({ epoch: 'a', revision: round * 2 + 2, as_of_seq: seq + 1, drafts: [] }), true);
    assert.equal(state.order.size, 0);
    assert.equal(state['terminal'].size, 0);
  }
  assert.equal(state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [draft('round-0')] }), false);
  assert.equal(state.snapshot({ epoch: 'a', revision: 2001, as_of_seq: 1, drafts: [draft('round-0')] }), false);
  assert.deepEqual(state.forConversation('root'), []);
});

test('terminal before a snapshot survives stale inclusions, then retires after covered omission', () => {
  const state = new Drafts();
  state.terminalEvent(terminal('ended', 7));
  assert.equal(state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 6, drafts: [draft('ended')] }), true);
  assert.deepEqual(state.forConversation('root'), []);
  assert.equal(state['terminal'].size, 1);
  assert.equal(state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 7, drafts: [] }), true);
  assert.equal(state['terminal'].size, 0);
  assert.equal(state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 6, drafts: [draft('ended')] }), false);
  state.reconnect();
  assert.equal(state.snapshot({ epoch: 'b', revision: 0, as_of_seq: 6, drafts: [draft('ended')] }), false);
  assert.equal(state.snapshot({ epoch: 'b', revision: 0, as_of_seq: 7, drafts: [] }), true);
  assert.deepEqual(state.forConversation('root'), []);
});

test('ASCII UI fence prefixes never expose JSON; ordinary code fences shield markers', () => {
  for (const fence of ['```', '~~~', '````', '~~~~']) {
    for (const indent of ['', '   ']) {
      const scanner = new DraftMarkdown();
      const prefix = indent + fence + 'wandrun-ui';
      for (let i = 1; i <= prefix.length; i++) {
        const parts = scanner.update(prefix.slice(0, i));
        if (i > indent.length) assert.equal(parts.at(-1)?.kind, 'ui', prefix.slice(0, i));
      }
      const body = scanner.update(`${prefix}\n{"elements":{"x":{"type":"Text"`);
      assert.equal(body.some((part) => part.text.includes('elements')), false);
      assert.equal(body.at(-1)?.kind, 'ui');
      const closed = scanner.update(`${prefix}\n{"secret":1}\n${indent}${fence}\nAfter`);
      assert.equal(closed.filter((part) => part.kind === 'ui').length, 1);
      assert.equal(closed.at(-1)?.text, 'After');
    }
  }
  const ordinary = new DraftMarkdown().update('```js\n```wandrun-ui\n{"visible":true}\n```\n');
  assert.equal(ordinary.some((part) => part.kind === 'ui'), false);
  assert.equal(ordinary[0].text.includes('wandrun-ui'), true);
  assert.equal(new DraftMarkdown().update('    ```wandrun-ui\n{"visible":true}').some((part) => part.kind === 'ui'), false);
  assert.equal(draftTailText('Before ![alt](https://example.org/a.png) and ![partial'), 'Before [图片生成中] and [图片生成中]');
  const splitCr = new DraftMarkdown();
  assert.equal(splitCr.update('```wandrun-ui\r').at(-1)?.kind, 'ui');
  assert.equal(splitCr.update('```wandrun-ui\r\n{\"secret\":1}').some((part) => part.text.includes('secret')), false);
});

test('completed Markdown blocks keep identity while only mutable tail changes; media remain placeholders', () => {
  const scanner = new DraftMarkdown();
  const a = scanner.update('# Title\n\nParagraph');
  assert.equal(a[0].stable, true);
  const title = a[0];
  const b = scanner.update('# Title\n\nParagraph grows');
  assert.equal(b[0], title);
  assert.equal(b[1].stable, undefined);
  const c = scanner.update('# Title\n\nParagraph grows\n\n```mermaid\ngraph LR\n');
  assert.equal(c[0], title);
  assert.equal(c[1].stable, true);
  assert.equal(c[2].kind, 'mermaid');
  assert.equal(c.some((part) => part.text.includes('graph LR')), false);
  const d = scanner.update('# Title\n\nReplacement');
  assert.equal(d[0].stable, true);
  assert.equal(d[1].text, 'Replacement');
});

test('CRLF split across snapshots is one line break, never a synthetic blank paragraph', () => {
  const scanner = new DraftMarkdown();
  const before = scanner.update('First\r');
  assert.equal(before[0].stable, undefined);
  const after = scanner.update('First\r\nSecond');
  assert.equal(after.length, 1);
  assert.equal(after[0].stable, undefined);
  assert.equal(after[0].text, 'First\r\nSecond');
  const pending = scanner.update('First\r\nSecond\r\n\r');
  assert.equal(pending[0].stable, undefined);
  const committed = scanner.update('First\r\nSecond\r\n\r\nNext');
  assert.equal(committed[0].stable, true);
  assert.equal(committed[0].text, 'First\r\nSecond\r\n\r\n');
  assert.equal(committed[1].text, 'Next');
});

/** Exercise SSE parsing and ChatSession, not just the isolated state reducer. */
test('SSE reconnect active set, formal-before-snapshot and interrupted historical winner', { timeout: 2000 }, async () => {
  const connections: ReadableStreamDefaultController<Uint8Array>[] = [];
  let notifyReconnected!: () => void;
  const reconnected = new Promise<void>((resolve) => { notifyReconnected = resolve; });
  const session = new ChatSession({ baseUrl: 'http://gateway', token: 'dev' }, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/events') return new Response(new ReadableStream({ start(controller) {
      connections.push(controller);
      if (connections.length === 2) notifyReconnected();
    } }));
    if (path === '/conversations') return Response.json({ as_of_seq: 0, conversations: [{
      id: 'root', agent_id: 'writer', title: 'Chat', created_at: 1, updated_at: 1, read_seq: 0, last_agent_seq: 0,
      status: 'working', unread: false, last_text: null, source: 'user', schedule_origin: null,
    }] });
    if (path === '/agents') return Response.json({ agents: [], as_of_seq: 0 });
    if (path === '/browser-tasks') return Response.json({ browser_tasks: [], as_of_seq: 0 });
    throw Error(`Unexpected request: ${path}`);
  }, { retryDelays: [0] });
  const send = (payload: object, index = connections.length - 1) => {
    const event = 'seq' in payload ? (payload as GatewayEvent).type : 'draft.snapshot';
    connections[index].enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
  };
  try {
    await session.start();
    await setImmediate();
    send({ type: 'draft.snapshot', data: { epoch: 'a', revision: 1, as_of_seq: 0, drafts: [draft('one'), draft('two', 'root', 'critic')] } });
    await setImmediate();
    assert.deepEqual(session.draftsFor('root').map((item) => item.draft_id), ['one', 'two']);
    send(terminal('one', 1));
    await setImmediate();
    assert.deepEqual(buildItems(session.timeline('root').events, [], new Map(), session.draftsFor('root')).map((i) => i.key), ['done', 'dtwo']);
    send({ type: 'draft.snapshot', data: { epoch: 'a', revision: 2, as_of_seq: 0, drafts: [draft('one'), draft('two')] } });
    await setImmediate();
    assert.deepEqual(session.draftsFor('root').map((item) => item.draft_id), ['two']);
    connections[0].close();
    await reconnected;
    await setImmediate();
    assert.equal(connections.length, 2);
    assert.deepEqual(session.draftsFor('root').map((item) => item.draft_id), ['two'], 'the visible preview remains until the new stream snapshot');
    send(terminal('three', 2, 'interrupted'));
    send({ type: 'draft.snapshot', data: { epoch: 'b', revision: 0, as_of_seq: 1, drafts: [draft('three'), draft('two')] } });
    await setImmediate();
    assert.deepEqual(session.draftsFor('root').map((item) => item.draft_id), ['two']);
    send({ type: 'draft.snapshot', data: { epoch: 'b', revision: 1, as_of_seq: 2, drafts: [] } });
    await setImmediate();
    assert.deepEqual(session.draftsFor('root'), []);
    send({ seq: 3, type: 'conversation.deleted', at: 3, data: { id: 'root' } });
    await setImmediate();
    send({ type: 'draft.snapshot', data: { epoch: 'b', revision: 2, as_of_seq: 2, drafts: [draft('late-after-delete')] } });
    await setImmediate();
    assert.deepEqual(session.draftsFor('root'), []);
    assert.equal(session.drafts.order.size, 0);
  } finally { await session.close(); }
});

test('SSE reconnect snapshot before question replay reanchors new replies and later siblings', { timeout: 2000 }, async () => {
  const connections: ReadableStreamDefaultController<Uint8Array>[] = [];
  let notifyReconnected!: () => void;
  const reconnected = new Promise<void>((resolve) => { notifyReconnected = resolve; });
  const session = new ChatSession({ baseUrl: 'http://gateway', token: 'dev' }, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/events') return new Response(new ReadableStream({ start(controller) {
      connections.push(controller);
      if (connections.length === 2) notifyReconnected();
    } }));
    if (path === '/conversations') return Response.json({ as_of_seq: 0, conversations: [{
      id: 'root', agent_id: 'writer', title: 'Chat', created_at: 1, updated_at: 1, read_seq: 0, last_agent_seq: 0,
      status: 'working', unread: false, last_text: null, source: 'user', schedule_origin: null,
    }] });
    if (path === '/agents') return Response.json({ agents: [], as_of_seq: 0 });
    if (path === '/browser-tasks') return Response.json({ browser_tasks: [], as_of_seq: 0 });
    throw Error(`Unexpected request: ${path}`);
  }, { retryDelays: [0] });
  const send = async (payload: object) => {
    const event = 'seq' in payload ? (payload as GatewayEvent).type : 'draft.snapshot';
    connections.at(-1)!.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
    await setImmediate();
  };
  const rows = () => buildItems(session.timeline('root').events, [], new Map(),
    session.draftsFor('root'), session.drafts.order).map((item) => item.key);
  try {
    await session.start();
    await setImmediate();
    await send(question(1));
    await send(terminal('old', 2));
    assert.deepEqual(rows(), ['e1', 'dold']);
    connections[0].close();
    await reconnected;
    await setImmediate();
    await send({ type: 'draft.snapshot', data: { epoch: 'a', revision: 1, as_of_seq: 3, drafts: [draft('new')] } });
    assert.deepEqual(rows(), ['e1', 'dold', 'dnew']);
    await send(question(3));
    assert.deepEqual(rows(), ['e1', 'dold', 'e3', 'dnew']);
    await send({ type: 'draft.snapshot', data: {
      epoch: 'a', revision: 2, as_of_seq: 3, drafts: [draft('new'), draft('member', 'root', 'critic')],
    } });
    assert.deepEqual(rows(), ['e1', 'dold', 'e3', 'dnew', 'dmember']);
    await send(terminal('member', 4));
    assert.deepEqual(rows(), ['e1', 'dold', 'e3', 'dnew', 'dmember']);
    // A later question outside the first snapshot's watermark must not move this cohort.
    await send(question(5));
    assert.deepEqual(rows(), ['e1', 'dold', 'e3', 'dnew', 'dmember', 'e5']);
    await send(terminal('new', 6));
    assert.deepEqual(rows(), ['e1', 'dold', 'e3', 'dmember', 'e5', 'dnew']);
    assert.equal(session.drafts.order.size, 0);
  } finally { await session.close(); }
});

test('replayed question splits a provisional cohort without moving a lingering older worker', () => {
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 1, drafts: [draft('old'), draft('linger')] }, () => 1);
  const old = terminal('old', 2);
  state.terminalEvent(old);
  state.reconnect();
  state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 3, drafts: [draft('linger'), draft('new')] }, () => 1);
  state.questionEvent(question(3));
  const rows = (events: GatewayEvent[]) => buildItems(events, [], new Map(), state.forConversation('root'), state.order)
    .map((item) => item.key);
  assert.deepEqual(rows([question(1), old, question(3)]), ['e1', 'dold', 'dlinger', 'e3', 'dnew']);
  const linger = terminal('linger', 4);
  state.terminalEvent(linger);
  assert.deepEqual(rows([question(1), old, question(3), linger]), ['e1', 'dold', 'e3', 'dlinger', 'dnew']);
});

test('history refinement while reconnect awaits its snapshot preserves the original watermark', () => {
  const state = new Drafts();
  state.snapshot({ epoch: 'a', revision: 1, as_of_seq: 3, drafts: [draft('reply')] }, () => 1);
  state.reconnect();
  state.questionEvent(question(3));
  state.questionEvent(question(5));
  state.snapshot({ epoch: 'a', revision: 2, as_of_seq: 5, drafts: [draft('reply')] }, () => 5);
  assert.deepEqual(buildItems([question(1), question(3), question(5)], [], new Map(),
    state.forConversation('root'), state.order).map((item) => item.key),
  ['e1', 'e3', 'dreply', 'e5']);
});
