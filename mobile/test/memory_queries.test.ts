import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryObserver } from '@tanstack/react-query';
import { ChatSession } from '../src/gateway/session.ts';
import type { AgentMemory } from '../src/gateway/api.ts';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway.ts';
import { attachSessionQueries, createGatewayQueryClient, memoryDetailOptions, memoryIndexOptions, sessionQueryKey } from '../src/lib/gateway-queries.ts';

const baseline: AgentMemory = { scope: 'work', agent_id: 'agent', content: '原记忆', version: 'v1', details: {}, limit: 1000, updated_at: null, updated_by: null };
const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
async function fixture() {
  const peer = new FakeGateway({ memories: new Map([['/agents/agent/memory', baseline], ['/memory/profile', { ...baseline, scope: 'profile', agent_id: undefined, content: '共享' }]]) });
  const client = createGatewayQueryClient(); client.mount();
  const session = new ChatSession({ baseUrl: 'http://memory.test', token: 'test' }, peer.fetch);
  attachSessionQueries(session, client);
  await session.start(); await flush();
  return { client, session, peer, async close() { await session.close(); peer.disconnect(); client.unmount(); client.clear(); } };
}

test('agent-profile.E5 T5 profile 从任意 Agent 入口共享一个 key/传输，work 独立，关闭清理 session', async () => {
  const f = await fixture();
  let sharedReads = 0;
  f.peer.overrides['GET /memory/profile'] = () => { sharedReads++; };
  const one = new QueryObserver(f.client, memoryIndexOptions(f.session, 'profile', 'agent-a'));
  const two = new QueryObserver(f.client, memoryIndexOptions(f.session, 'profile', 'agent-b'));
  const work = new QueryObserver(f.client, memoryIndexOptions(f.session, 'work', 'agent'));
  const stops = [one.subscribe(() => {}), two.subscribe(() => {}), work.subscribe(() => {})];
  try {
    await flush();
    assert.equal(sharedReads, 1);
    assert.equal(two.getCurrentResult().data?.content, '共享');
    assert.equal(work.getCurrentResult().data?.content, '原记忆');
    stops.forEach(stop => stop());
    await f.session.close();
    assert.deepEqual(f.client.getQueryCache().findAll({ queryKey: sessionQueryKey(f.session) }), []);
  } finally { stops.forEach(stop => stop()); await f.close(); }
});

test('agent-profile.T5 初读遇到 memory revision 先中止，再读最新；不失效无关 profile', async () => {
  const f = await fixture();
  const gate = Promise.withResolvers<void>();
  let reads = 0, sharedReads = 0;
  let firstSignal: AbortSignal | undefined;
  f.peer.overrides['GET /agents/:id/memory'] = async ({ init }, respond) => {
    if (++reads === 1) { firstSignal = init.signal ?? undefined; const old = await respond(); await gate.promise; return old; }
  };
  f.peer.overrides['GET /memory/profile'] = () => { sharedReads++; };
  const work = new QueryObserver(f.client, memoryIndexOptions(f.session, 'work', 'agent'));
  const shared = new QueryObserver(f.client, memoryIndexOptions(f.session, 'profile', 'profile'));
  const stopWork = work.subscribe(() => {}), stopShared = shared.subscribe(() => {});
  try {
    await flush();
    f.peer.state.memories.set('/agents/agent/memory', { ...baseline, version: 'v2', content: '最新' });
    f.peer.emit(f.peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'agent', op: 'updated' }));
    await flush();
    assert.equal(firstSignal?.aborted, true);
    assert.equal(work.getCurrentResult().data?.content, '最新');
    assert.equal(sharedReads, 1);
    gate.resolve(); await flush();
    assert.equal(work.getCurrentResult().data?.version, 'v2');
  } finally { gate.resolve(); stopWork(); stopShared(); await f.close(); }
});

test('agent-profile.T7 详情与索引版本不同时只更新原 index key，重试取得同版详情，不发布混合正文', async () => {
  const f = await fixture();
  const ref = { path: `/.wandrun/memory/work/details/topic/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
  const index = { ...baseline, details: { topic: ref } };
  f.peer.state.memories.set('/agents/agent/memory', index);
  f.peer.state.memoryBodies.set('/agents/agent/memory/details/topic', '详情正文');
  await f.client.fetchQuery(memoryIndexOptions(f.session, 'work', 'agent'));
  let reads = 0;
  f.peer.overrides['GET /agents/:id/memory/details/:slug'] = async (_context, respond) => {
    if (++reads === 1) { f.peer.state.memories.set('/agents/agent/memory', { ...index, version: 'v2' }); return jsonResponse({ ...(await (await respond()).json()), version: 'v2' }); }
  };
  const observer = new QueryObserver(f.client, memoryDetailOptions(f.session, 'work', 'agent', 'topic'));
  const accepted: string[] = [];
  const stop = observer.subscribe(result => { if (result.data) accepted.push(result.data.version); });
  try {
    await observer.refetch({ cancelRefetch: false });
    assert.equal(observer.getCurrentResult().data?.version, 'v2');
    assert.equal(f.client.getQueryData(memoryIndexOptions(f.session, 'work', 'agent').queryKey)?.version, 'v2');
    assert.deepEqual([...new Set(accepted)], ['v2']);
  } finally { stop(); await f.close(); }
});
