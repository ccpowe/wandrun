import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryObserver, focusManager, onlineManager } from '@tanstack/react-query';
import { ChatSession } from '../src/gateway/session.ts';
import type { Fetch } from '../src/gateway/api.ts';
import { attachSessionQueries, connectorDetailOptions, connectorListOptions, createGatewayQueryClient, sessionQueryKey } from '../src/lib/gateway-queries.ts';

const row = (name: string) => ({ id: 'docs', name });
const response = (name: string) => Response.json({ connectors: [row(name)], as_of_seq: 0 });
const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
function fixture(fetch: Fetch) {
  const client = createGatewayQueryClient();
  client.mount();
  const session = new ChatSession({ baseUrl: 'http://gateway.test', token: 'test' }, fetch);
  attachSessionQueries(session, client);
  return { client, session, async close() { await session.close(); client.unmount(); client.clear(); } };
}

test('initial revision cancels headers/body even if native transport ignores abort; late old result cannot publish', async () => {
  const body = Promise.withResolvers<unknown>();
  const signals: AbortSignal[] = [];
  const f = fixture(async (_input, init) => {
    signals.push(init!.signal!);
    if (signals.length === 1) return { ok: true, status: 200, json: () => body.promise } as Response;
    return response('current');
  });
  const observer = new QueryObserver(f.client, connectorListOptions(f.session));
  const stop = observer.subscribe(() => {});
  try {
    await flush();
    f.session.refreshConnectors();
    assert.equal(signals[0].aborted, true);
    await flush();
    assert.equal(observer.getCurrentResult().data?.connectors[0].name, 'current');
    body.resolve({ connectors: [row('obsolete')], as_of_seq: 0 });
    await flush();
    assert.equal(observer.getCurrentResult().data?.connectors[0].name, 'current');
  } finally { stop(); await f.close(); }
});

test('same key shares a pending transport; only final observer removal cancels, session retains data until close', async () => {
  const gate = Promise.withResolvers<Response>();
  let signal!: AbortSignal;
  let reads = 0;
  const f = fixture(async (_input, init) => { reads++; signal = init!.signal!; return gate.promise; });
  const one = new QueryObserver(f.client, connectorListOptions(f.session));
  const two = new QueryObserver(f.client, connectorListOptions(f.session));
  const stopOne = one.subscribe(() => {});
  const stopTwo = two.subscribe(() => {});
  try {
    await flush();
    assert.equal(reads, 1);
    stopOne();
    assert.equal(signal.aborted, false);
    gate.resolve(response('shared'));
    await flush();
    assert.equal(two.getCurrentResult().data?.connectors[0].name, 'shared');
    stopTwo();
    assert.equal(f.client.getQueryData(connectorListOptions(f.session).queryKey)?.connectors[0].name, 'shared');
    await f.session.close();
    assert.deepEqual(f.client.getQueryCache().findAll({ queryKey: sessionQueryKey(f.session) }), []);
  } finally { stopOne(); stopTwo(); await f.close(); }
});

test('session identity isolates equal endpoints; final unsubscribe aborts and a queued revision cannot revive closed cache', async () => {
  const pending = Promise.withResolvers<Response>();
  let signal!: AbortSignal;
  const f = fixture(async (_input, init) => { signal = init!.signal!; return pending.promise; });
  const other = new ChatSession({ baseUrl: 'http://gateway.test', token: 'test' });
  attachSessionQueries(other, f.client);
  f.client.setQueryData(connectorListOptions(other).queryKey, { connectors: [], as_of_seq: 99 });
  const observer = new QueryObserver(f.client, connectorListOptions(f.session));
  const stop = observer.subscribe(() => {});
  try {
    assert.equal(observer.getCurrentResult().data, undefined);
    stop();
    assert.equal(signal.aborted, true);
    const stopAgain = observer.subscribe(() => {});
    f.session.refreshConnectors();
    await f.session.close();
    pending.resolve(response('too late'));
    await flush();
    assert.equal(f.client.getQueryData(connectorListOptions(f.session).queryKey), undefined);
    assert.deepEqual(f.client.getQueryData(connectorListOptions(other).queryKey), { connectors: [], as_of_seq: 99 });
    stopAgain();
  } finally { stop(); await other.close(); await f.close(); }
});

test('first failure and refresh failure stay visible during 500/1000ms backoff, refresh retains old data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  onlineManager.setOnline(true); focusManager.setFocused(true);
  let reads = 0;
  let failing = true;
  const f = fixture(async () => { reads++; return failing ? new Response('{}', { status: 500 }) : response('saved'); });
  const observer = new QueryObserver(f.client, connectorListOptions(f.session));
  const stop = observer.subscribe(() => {});
  try {
    await flush();
    assert.equal(observer.getCurrentResult().data, undefined);
    assert.ok(observer.getCurrentResult().failureReason);
    t.mock.timers.tick(499); await flush(); assert.equal(reads, 1);
    t.mock.timers.tick(1); await flush(); assert.equal(reads, 2);
    t.mock.timers.tick(999); await flush(); assert.equal(reads, 2);
    failing = false;
    t.mock.timers.tick(1); await flush();
    assert.equal(observer.getCurrentResult().data?.connectors[0].name, 'saved');
    failing = true;
    void observer.refetch({ cancelRefetch: false });
    await flush();
    assert.equal(observer.getCurrentResult().data?.connectors[0].name, 'saved');
    assert.ok(observer.getCurrentResult().failureReason);
    failing = false;
    t.mock.timers.tick(500); await flush();
    assert.equal(observer.getCurrentResult().failureReason, null);
  } finally { stop(); await f.close(); focusManager.setFocused(undefined); }
});

test('offline pauses instead of failing; LAN online resumes; background pauses retries until foreground', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  onlineManager.setOnline(false); focusManager.setFocused(true);
  let reads = 0;
  let failing = false;
  const f = fixture(async () => { reads++; return failing ? new Response('{}', { status: 500 }) : response('online'); });
  const observer = new QueryObserver(f.client, connectorListOptions(f.session));
  const stop = observer.subscribe(() => {});
  try {
    await flush();
    assert.equal(reads, 0);
    assert.equal(observer.getCurrentResult().fetchStatus, 'paused');
    assert.equal(observer.getCurrentResult().failureReason, null);
    onlineManager.setOnline(true); await flush();
    assert.equal(observer.getCurrentResult().data?.connectors[0].name, 'online');
    failing = true;
    void observer.refetch({ cancelRefetch: false }); await flush();
    focusManager.setFocused(false);
    const before = reads;
    t.mock.timers.tick(500); await flush();
    assert.equal(observer.getCurrentResult().fetchStatus, 'paused');
    assert.equal(reads, before);
    failing = false;
    focusManager.setFocused(true); await flush();
    assert.equal(observer.getCurrentResult().failureReason, null);
  } finally { stop(); await f.close(); onlineManager.setOnline(true); focusManager.setFocused(undefined); }
});

test('cancelReads silently cancels Query before a legacy snapshot API abort and restarts without a transient failure', async () => {
  const old = Promise.withResolvers<Response>();
  let reads = 0;
  const snapshot = () => Response.json({ agents: [{ id: 'new', name: 'recovered' }], as_of_seq: 0, order_revision: 1 });
  const f = fixture(async () => ++reads === 1 ? old.promise : snapshot());
  // Cancellation contract probe only, not a migration of the AgentList-owned projection.
  const observer = new QueryObserver(f.client, { queryKey: [...sessionQueryKey(f.session), 'snapshot-probe'],
    queryFn: ({ signal }) => { signal.throwIfAborted(); return f.session.api.listAgents(); } });
  const failures: unknown[] = [];
  const stop = observer.subscribe(result => { if (result.error ?? result.failureReason) failures.push(result.error ?? result.failureReason); });
  try {
    f.session.api.cancelReads();
    await flush();
    assert.equal(observer.getCurrentResult().data?.agents[0].name, 'recovered');
    assert.deepEqual(failures, []);
    old.resolve(snapshot()); await flush();
    assert.equal(observer.getCurrentResult().data?.agents[0].name, 'recovered');
  } finally { stop(); await f.close(); }
});

test('same-stack cancelReads + open coalesce; asynchronous recovery may read twice; detail 404 terminates', async () => {
  // Mutable-store seam: publish connection transitions without simulating unrelated SSE projections.
  const listeners = new Set<() => void>();
  let reads = 0;
  const client = createGatewayQueryClient(); client.mount();
  const session = new ChatSession({ baseUrl: 'http://gateway.test', token: 'test' }, async input => {
    reads++;
    return String(input).endsWith('/missing') ? new Response('{}', { status: 404 }) : response(`read-${reads}`);
  });
  session.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  attachSessionQueries(session, client);
  const observer = new QueryObserver(client, connectorListOptions(session));
  const stop = observer.subscribe(() => {});
  try {
    await flush();
    for (const state of ['connecting', 'reconnecting', 'listing', 'connecting'] as const) {
      session.connection = state;
      for (const listener of listeners) listener();
      await flush();
      assert.equal(reads, 1);
    }
    session.api.cancelReads();
    session.connection = 'open'; for (const listener of listeners) listener(); await flush();
    assert.equal(reads, 2);
    for (const listener of listeners) listener(); await flush(); assert.equal(reads, 2);
    const detail = new QueryObserver(client, connectorDetailOptions(session, 'missing'));
    const stopDetail = detail.subscribe(() => {});
    await flush();
    assert.equal(detail.getCurrentResult().isError, true);
    assert.equal(detail.getCurrentResult().failureCount, 1);
    stopDetail();
  } finally { stop(); await session.close(); client.unmount(); client.clear(); }
});

test('parameter switch cancels the previous detail and never publishes it into the new resource', async () => {
  const old = Promise.withResolvers<Response>();
  const current = Promise.withResolvers<Response>();
  const signals: AbortSignal[] = [];
  const f = fixture(async (input, init) => {
    signals.push(init!.signal!);
    return String(input).endsWith('/old') ? old.promise : current.promise;
  });
  const observer = new QueryObserver(f.client, connectorDetailOptions(f.session, 'old'));
  const stop = observer.subscribe(() => {});
  try {
    observer.setOptions(connectorDetailOptions(f.session, 'current'));
    assert.equal(signals[0].aborted, true);
    assert.equal(observer.getCurrentResult().data, undefined);
    old.resolve(Response.json({ id: 'old', name: 'obsolete' })); await flush();
    assert.equal(observer.getCurrentResult().data, undefined);
    current.resolve(Response.json({ id: 'current', name: 'current' })); await flush();
    assert.equal(observer.getCurrentResult().data?.id, 'current');
  } finally { stop(); await f.close(); }
});

test('a session holder that omitted the query bridge fails immediately instead of silently missing invalidation/close', async () => {
  const session = new ChatSession({ baseUrl: 'http://unowned.test', token: 'test' });
  try {
    assert.throws(() => connectorListOptions(session), /attachSessionQueries/);
  } finally { await session.close(); }
});
