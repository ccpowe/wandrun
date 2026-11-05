import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AbortController as NativeAbortController } from 'abort-controller';
import { ChatSession } from '../src/gateway/session.ts';
import { attachSessionQueries, createGatewayQueryClient, memoryDetailOptions, memoryIndexOptions, searchOptions } from '../src/lib/gateway-queries.ts';

function nativeSignal() {
  const controller = new NativeAbortController();
  // RN 0.86 setUpXHR installs this package, whose signal has no throwIfAborted/reason.
  const signal = controller.signal as unknown as AbortSignal;
  assert.equal(typeof signal.throwIfAborted, 'undefined');
  return { controller, signal };
}
function fixture() {
  const client = createGatewayQueryClient();
  const session = new ChatSession({ baseUrl: 'http://native-query.test', token: 'test' }, async input => {
    if (String(input).includes('/search?')) return Response.json({ results: [{ kind: 'agent', id: 'found', title: '命中', text: '搜索命中' }], total: 1, as_of_seq: 0 });
    if (String(input).includes('/details/topic')) return Response.json({ scope: 'work', agent_id: 'agent', slug: 'topic', content: '新详情', version: 'v2', sha256: 'a'.repeat(64), path: 'topic.md', limit: 1000 });
    return Response.json({ scope: 'work', agent_id: 'agent', content: '新索引', version: 'v2', details: {}, limit: 1000, updated_at: null, updated_by: null });
  });
  attachSessionQueries(session, client);
  return { client, session, async close() { await session.close(); client.clear(); } };
}

test('search.A2 RN signal without throwIfAborted reaches search results after debounce', async () => {
  const f = fixture(); const { signal } = nativeSignal();
  const options = searchOptions(f.session, '命中');
  assert.equal(typeof options.queryFn, 'function');
  if (typeof options.queryFn !== 'function') throw new Error('Missing search query');
  try {
    const result = await options.queryFn({ client: f.client, queryKey: options.queryKey, signal, pageParam: 0, direction: 'forward', meta: undefined });
    assert.equal(result.total, 1);
    assert.equal(result.results[0].id, 'found');
  } finally { await f.close(); }
});

test('search.A8 RN signal aborts before and during debounce without starting transport', async () => {
  const f = fixture(); let calls = 0;
  f.session.api.search = async () => { calls++; throw new Error('Transport should not start'); };
  const options = searchOptions(f.session, '取消');
  if (typeof options.queryFn !== 'function') throw new Error('Missing search query');
  try {
    for (const alreadyAborted of [true, false]) {
      const { signal, controller } = nativeSignal();
      if (alreadyAborted) controller.abort();
      const pending = options.queryFn({ client: f.client, queryKey: options.queryKey, signal, pageParam: 0, direction: 'forward', meta: undefined });
      const rejected = assert.rejects(Promise.resolve(pending), { name: 'AbortError' });
      if (!alreadyAborted) controller.abort();
      await rejected;
    }
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('agent-profile.T7 RN signal reports version change rather than missing native method', async () => {
  const f = fixture(); const { signal } = nativeSignal();
  const index = { scope: 'work' as const, agent_id: 'agent', content: '旧索引', version: 'v1', details: { topic: { path: 'topic.md', sha256: 'a'.repeat(64) } }, limit: 1000, updated_at: null, updated_by: null };
  f.client.setQueryData(memoryIndexOptions(f.session, 'work', 'agent').queryKey, index);
  const options = memoryDetailOptions(f.session, 'work', 'agent', 'topic');
  if (typeof options.queryFn !== 'function') throw new Error('Missing detail query');
  try {
    await assert.rejects(Promise.resolve(options.queryFn({ client: f.client, queryKey: options.queryKey, signal, meta: undefined })), /详情已变化，请重试/);
    assert.equal(f.client.getQueryData(memoryIndexOptions(f.session, 'work', 'agent').queryKey)?.version, 'v2');
  } finally { await f.close(); }
});
