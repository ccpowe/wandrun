import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../src/gateway/api.ts';
import { NewConversationStore, newChatReducer, type NewChatHost, type NewChatSaved, type NewChatAttempt } from '../src/lib/new-conversation.ts';

function fixture() {
  let saved: NewChatSaved | null = null;
  const store = new NewConversationStore({ read: () => saved, write: value => { saved = structuredClone(value); } });
  const conversations = new Map<string, { id: string; agent: string }>();
  const bound: NewChatAttempt[] = [];
  let online = true;
  let current = true;
  let version = 0;
  let loseReceipt = false;
  let reject = false;
  let bindFailure = false;
  let gate: Promise<void> | null = null;
  let requests = 0;
  let messages = 0;
  const host: NewChatHost = {
    computerId: 'server-a', online: () => online, current: () => current, storeVersion: () => version,
    create: async (agent, key) => {
      requests++;
      if (gate) await gate;
      if (reject) throw new GatewayError(404, 'not_found', 'Agent 不存在');
      if (!conversations.has(key)) conversations.set(key, { id: `root-${conversations.size + 1}`, agent });
      if (loseReceipt) throw new GatewayError(503, 'unavailable', 'response lost');
      return conversations.get(key)!.id;
    },
    bind: (_id, attempt, send) => {
      if (bindFailure) throw new Error('local disk full');
      bound.push(attempt);
      return send ? { preserveDraft: false, send: async () => { messages++; } } : { preserveDraft: false };
    },
  };
  store.select('server-a', 'agent-a');
  store.setText('保留原文');
  return { store, host, conversations, bound, saved: () => saved,
    requests: () => requests, messages: () => messages,
    offline: () => { online = false; }, online: () => { online = true; },
    close: () => { current = false; }, replaceStore: () => { version++; },
    lose: () => { loseReceipt = true; }, recover: () => { loseReceipt = false; reject = false; bindFailure = false; },
    reject: () => { reject = true; }, failBind: () => { bindFailure = true; }, gate: (value: Promise<void>) => { gate = value; },
  };
}
const ids = { create: 'creation-key', message: 'message-key' };

test('chat.N1 N2 N3 selecting and editing remain local and survive leaving/reopening', () => {
  const h = fixture();
  h.store.select('server-a', 'agent-b');
  assert.equal(h.requests(), 0);
  const restored = new NewConversationStore({ read: h.saved, write() { throw new Error('read only fixture'); } });
  restored.restore();
  const state = restored.getSnapshot();
  assert.ok(state.status === 'editing');
  assert.equal(state.saved.text, '保留原文');
  assert.equal(state.saved.selection?.agentId, 'agent-b');
});

test('chat.N4 T13 offline send preserves editable text, does not create or queue, reconnect alone sends nothing', async () => {
  const h = fixture();
  h.offline();
  await h.store.submit(h.host, ids);
  assert.equal(h.requests(), 0);
  assert.equal(h.messages(), 0);
  const state = h.store.getSnapshot();
  assert.equal(state.status, 'editing');
  assert.equal(state.error, '发送失败');
  h.online();
  assert.equal(h.requests(), 0);
  assert.equal(h.store.select('server-a', 'agent-b'), true);
  await h.store.submit(h.host, ids);
  assert.equal(h.messages(), 1);
  assert.equal([...h.conversations.values()][0].agent, 'agent-b');
  assert.equal(h.bound[0].text, '保留原文');
});

test('chat.T14 duplicate sends during creation cannot create or send twice; selected Agent is immutable', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>();
  h.gate(gate.promise);
  const first = h.store.submit(h.host, ids);
  await h.store.submit(h.host, { create: 'second', message: 'second-message' });
  assert.equal(h.store.select('server-a', 'agent-b'), false);
  h.store.setText('不同内容');
  gate.resolve();
  await first;
  assert.equal(h.requests(), 1);
  assert.equal(h.messages(), 1);
  assert.equal(h.bound[0].text, '保留原文');
});

test('chat.N6 N10 T15 T17 lost creation receipt survives restart and retries the same intent, never reconnect replay', async () => {
  const h = fixture();
  h.lose();
  await h.store.submit(h.host, ids);
  assert.equal(h.store.getSnapshot().status, 'unknown');
  assert.equal(h.conversations.size, 1);
  assert.equal(h.messages(), 0);
  const restored = new NewConversationStore({ read: h.saved, write() {} });
  restored.restore();
  h.recover();
  assert.equal(h.requests(), 1);
  await restored.submit(h.host, { create: 'wrong-new-key', message: 'wrong-new-message' });
  assert.deepEqual([...h.conversations.keys()], ['creation-key']);
  assert.equal(h.bound[0].messageClientId, 'message-key');
  assert.equal(h.messages(), 1);
});

test('chat.N11 unknown creation belongs to its original server; another server cannot replace or submit it', async () => {
  const h = fixture();
  h.lose();
  await h.store.submit(h.host, ids);
  assert.equal(h.store.select('server-b', 'agent-b'), false);
  await h.store.submit({ ...h.host, computerId: 'server-b' }, { create: 'other', message: 'other' });
  assert.equal(h.requests(), 1);
  assert.equal(h.saved()!.attempt!.computerId, 'server-a');
});

test('chat.O5 rejection retains the failed first intent separately from the editable next draft', async () => {
  const h = fixture();
  h.reject();
  await h.store.submit(h.host, ids);
  assert.equal(h.store.getSnapshot().status, 'editing');
  assert.equal(h.saved()!.text, '');
  assert.equal(h.saved()!.failure?.attempt.text, '保留原文');
  assert.equal(h.saved()!.attempt, undefined);
  assert.equal(h.store.select('server-a', 'agent-b'), true);
});

test('chat.N8 attachment bytes are staged before creation; binding does not submit a message', async () => {
  const h = fixture();
  const stage = Promise.withResolvers<{ id: string; uri: string; name: string; mediaType: string; size: number }[]>();
  const running = h.store.submit(h.host, ids, () => stage.promise);
  assert.equal(h.requests(), 0);
  stage.resolve([{ id: 'local-1', uri: 'file:///owned-1', name: 'photo.png', mediaType: 'image/png', size: 12 }]);
  await running;
  assert.equal(h.conversations.size, 1);
  assert.equal(h.bound[0].files[0].uri, 'file:///owned-1');
  assert.equal(h.messages(), 0);
});

test('chat.T19 closing the original session prevents the message stage without losing the creation identity', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>();
  h.gate(gate.promise);
  const running = h.store.submit(h.host, ids);
  h.close(); gate.resolve(); await running;
  assert.equal(h.messages(), 0);
  assert.equal(h.saved()!.attempt!.clientId, 'creation-key');
  assert.equal(h.saved()!.attempt!.text, '保留原文');
  assert.equal(h.saved()!.text, '');
});

test('chat.O17 store replacement retains the first intent as failed and revokes the old command', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>();
  h.gate(gate.promise);
  const running = h.store.submit(h.host, ids);
  h.replaceStore(); gate.resolve(); await running;
  assert.equal(h.messages(), 0);
  assert.equal(h.saved()!.attempt, undefined);
  assert.equal(h.saved()!.failure?.attempt.text, '保留原文');
  assert.equal(h.saved()!.text, '');
});

test('chat.T16 a stale or duplicate handoff result cannot clear a later draft', () => {
  const saved = { text: 'later draft', selection: { computerId: 'a', agentId: 'a' } };
  const state = { status: 'editing', saved, error: null } as const;
  assert.equal(newChatReducer(state, { type: 'ended', operation: 'old', keepText: false }), state);
  assert.equal(newChatReducer(state, { type: 'created', operation: 'old', id: 'old-id' }), state);
});

test('chat.T16 a failed durable handoff keeps the confirmed id for manual retry rather than creating another conversation', async () => {
  const h = fixture();
  h.failBind();
  await h.store.submit(h.host, ids);
  assert.equal(h.store.getSnapshot().status, 'unknown');
  assert.equal(h.saved()!.attempt!.conversationId, 'root-1');
  assert.equal(h.messages(), 0);
  h.recover();
  await h.store.submit(h.host, { create: 'wrong-new-key', message: 'wrong-new-message' });
  assert.equal(h.requests(), 1);
  assert.equal(h.conversations.size, 1);
  assert.equal(h.messages(), 1);
});

test('chat.O8 creation confirmed before disconnect binds locally without submitting or replaying the message', async () => {
  const h = fixture();
  const create = h.host.create;
  h.host.create = async (agent, key) => { const id = await create(agent, key); h.offline(); return id; };
  await h.store.submit(h.host, ids);
  assert.equal(h.store.getSnapshot().status, 'editing');
  assert.equal(h.saved()!.attempt, undefined);
  assert.equal(h.bound[0].conversationId, 'root-1');
  assert.equal(h.bound[0].deferred, true);
  assert.equal(h.messages(), 0);
  h.online();
  await h.store.attach(h.host);
  assert.equal(h.requests(), 1);
  assert.equal(h.messages(), 0, 'reconnection and local attach must not send the retained first message');
});

test('chat.O12 attachment confirmation completes durable handoff without requiring the initiating page to refocus', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>();
  h.gate(gate.promise);
  const running = h.store.submit(h.host, ids, async () => [{ id: 'local', uri: 'file:///owned', name: 'notes.txt', mediaType: 'text/plain', size: 5 }]);
  gate.resolve(); await running;
  assert.equal(h.store.getSnapshot().status, 'editing');
  assert.equal(h.saved()!.attempt, undefined);
  assert.equal(h.requests(), 1);
  assert.equal(h.bound[0].files[0].uri, 'file:///owned');
  assert.equal(h.messages(), 0);
});

test('G1 作废的首次动作返回后不能接管、发送或清空后来编辑的草稿', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>();
  h.gate(gate.promise);
  const pending = h.store.submit(h.host, ids);
  h.store.invalidateAttempt('server-a');
  h.store.setText('换库后编辑的新草稿');
  gate.resolve(); await pending;
  assert.equal(h.bound.length, 0);
  assert.equal(h.messages(), 0);
  const state = h.store.getSnapshot();
  assert.equal(state.status, 'editing');
  assert.equal(state.saved.text, '换库后编辑的新草稿');
});

test('G2 已知离线的首次附件不暂存、不创建、不锁 Agent，文字仍可编辑', async () => {
  const h = fixture();
  h.offline();
  let staged = false;
  await h.store.submit(h.host, ids, async () => { staged = true; return []; });
  assert.equal(staged, false);
  assert.equal(h.requests(), 0);
  const state = h.store.getSnapshot();
  assert.equal(state.status, 'editing');
  assert.equal(state.error, '添加附件失败');
  assert.equal(h.store.select('server-a', 'agent-b'), true);
  h.store.setText('离线也能继续编辑');
  assert.equal(h.store.getSnapshot().status !== 'loading' && h.saved()?.text, '离线也能继续编辑');
});

test('G2 暂存期间才断线但尚未 POST：明确失败并释放目标，重连不自动发', async () => {
  const h = fixture();
  await h.store.submit(h.host, ids, async () => { h.offline(); return []; });
  assert.equal(h.requests(), 0);
  const state = h.store.getSnapshot();
  assert.equal(state.status, 'editing');
  assert.equal(state.error, '添加附件失败');
  assert.equal(h.store.select('server-a', 'agent-b'), true);
  h.online();
  assert.equal(h.requests(), 0);
});

test('chat.N4 N7 G7 发送前离线带结构化 offline 标记（字段内显示），本地准备失败与创建失败不带', () => {
  const saved = { text: '原文', selection: { computerId: 'c', agentId: 'a' } };
  const editing = { status: 'editing' as const, saved, error: null };
  const offline = newChatReducer(editing, { type: 'changed', saved, error: '发送失败', offline: true });
  assert.equal(offline.error, '发送失败');
  assert.equal(offline.offline, true);
  // Editing clears both the hint and its placement.
  const edited = newChatReducer(offline, { type: 'changed', saved: { ...saved, text: '原文。' } });
  assert.equal(edited.error, null);
  assert.equal(edited.offline, undefined);
  const preparing = newChatReducer(editing, { type: 'prepare', operation: 'op', kind: 'send' });
  const prepareFailed = newChatReducer(preparing, { type: 'ended', operation: 'op', keepText: true, error: '发送失败' });
  assert.equal(prepareFailed.error, '发送失败');
  assert.equal(prepareFailed.offline, undefined);
});

test('chat.O3 O6 the pending first message is immutable while the next editable draft survives unknown and restart', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>();
  h.gate(gate.promise);
  h.lose();
  const running = h.store.submit(h.host, ids);
  assert.equal(h.saved()!.text, '');
  h.store.setText('下一段，不属于已提交首文');
  await h.store.submit(h.host, { create: 'duplicate', message: 'duplicate-message' });
  gate.resolve(); await running;
  assert.equal(h.requests(), 1);
  assert.equal(h.saved()!.attempt!.text, '保留原文');
  assert.equal(h.saved()!.text, '下一段，不属于已提交首文');
  h.store.discardFailure('message-key');
  assert.equal(h.store.getSnapshot().status, 'unknown', 'unknown cannot be discarded to unlock another creation');
  const restored = new NewConversationStore({ read: h.saved, write() {} });
  restored.restore();
  const state = restored.getSnapshot();
  assert.ok(state.status === 'unknown');
  assert.equal(state.saved.attempt.clientId, 'creation-key');
  assert.equal(state.saved.attempt.text, '保留原文');
  assert.equal(state.saved.text, '下一段，不属于已提交首文');
});

test('chat.O5 deleting a failed first message protects the next draft and ignores an obsolete message identity', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>();
  h.gate(gate.promise);
  h.reject();
  const running = h.store.submit(h.host, ids);
  h.store.setText('已经写好的下一段');
  gate.resolve(); await running;
  assert.equal(h.saved()!.failure?.attempt.text, '保留原文');
  assert.equal(h.saved()!.text, '已经写好的下一段');
  await h.store.submit(h.host, { create: 'retry-creation', message: 'retry-message' });
  h.store.discardFailure('message-key');
  assert.equal(h.saved()!.failure?.attempt.messageClientId, 'retry-message');
  h.store.discardFailure('retry-message');
  assert.equal(h.saved()!.failure, undefined);
  assert.equal(h.saved()!.text, '已经写好的下一段');
});

test('chat.O15 completed original binding cannot consume a later visit’s editable next draft', async () => {
  const h = fixture();
  const gate = Promise.withResolvers<void>(); h.gate(gate.promise);
  const originalBind = h.host.bind;
  h.host.bind = (...args) => ({ ...originalBind(...args), preserveDraft: true });
  const running = h.store.submit(h.host, ids);
  h.store.setText('后来访问的独立草稿');
  gate.resolve(); await running;
  assert.equal(h.saved()!.attempt, undefined);
  assert.equal(h.saved()!.failure, undefined);
  assert.equal(h.saved()!.text, '后来访问的独立草稿');
  assert.equal(h.messages(), 1);
});

test('chat.O5 failed attachment removal drops only the selected bytes and preserves editable text', async () => {
  const h = fixture(); h.reject();
  await h.store.submit(h.host, ids, async () => [
    { id: 'a', uri: 'file:///owned-a', name: 'a.txt', mediaType: 'text/plain', size: 1 },
    { id: 'b', uri: 'file:///owned-b', name: 'b.txt', mediaType: 'text/plain', size: 2 },
  ]);
  h.store.setText('失败期间修改过的正文');
  h.store.removeFailedAttachment('a');
  assert.deepEqual(h.saved()!.failure?.attempt.files.map(item => item.id), ['b']);
  assert.equal(h.saved()!.text, '失败期间修改过的正文');
  h.store.removeFailedAttachment('b');
  assert.equal(h.saved()!.failure, undefined);
  assert.equal(h.saved()!.text, '失败期间修改过的正文');
  assert.equal(h.messages(), 0);
});

test('chat.O15 restored known unsent intent waits for an explicit retry; that retry sends once without a second creation', async () => {
  const h = fixture();
  const create = h.host.create;
  h.host.create = async (agent, key) => { const id = await create(agent, key); h.offline(); return id; };
  h.failBind();
  await h.store.submit(h.host, ids);
  assert.equal(h.store.getSnapshot().status, 'awaiting');
  let persisted = h.saved();
  const restored = new NewConversationStore({ read: () => persisted, write: saved => { persisted = structuredClone(saved); } });
  restored.restore();
  h.online(); h.recover();
  assert.equal(h.messages(), 0);
  assert.equal(h.requests(), 1);
  await restored.submit(h.host, { create: 'different-new-action', message: 'different-message' });
  assert.equal(h.requests(), 1);
  assert.equal(h.conversations.size, 1);
  assert.equal(h.messages(), 1);
  assert.equal(h.bound[0].messageClientId, ids.message);
  assert.equal(restored.getSnapshot().status, 'editing');
});
