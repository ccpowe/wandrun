import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { InfiniteQueryObserver, QueryObserver } from '@tanstack/react-query';
import { ChatSession } from '../src/gateway/session.ts';
import type { Fetch, ScheduleRun } from '../src/gateway/api.ts';
import { attachSessionQueries, createGatewayQueryClient, readScheduleForReload, scheduleDetailOptions, scheduleRunsOptions } from '../src/lib/gateway-queries.ts';

const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
function fixture(fetch: Fetch) {
  const client = createGatewayQueryClient(); client.mount();
  const session = new ChatSession({ baseUrl: 'http://schedules.test', token: 'test' }, fetch);
  attachSessionQueries(session, client);
  return { client, session, async close() { await session.close(); client.unmount(); client.clear(); } };
}
const run = (id: number): ScheduleRun => ({ id, schedule_id: 'timer', scheduled_at: id, started_at: null, finished_at: null, status: 'completed', reason: null, conversation_id: null, name: '日报', content: '新闻', missed_before: null });

test('schedule-editor.C6 T3 同游标去重，六页后 revision 从最新页刷新且保留已加载历史', async () => {
  const cursors: (number | undefined)[] = [];
  let latest = 160;
  const f = fixture(async input => {
    const url = new URL(String(input));
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
    cursors.push(before);
    const start = before === undefined ? latest : before - 1;
    return Response.json({ runs: Array.from({ length: 20 }, (_, index) => run(start - index)), as_of_seq: 0 });
  });
  const observer = new InfiniteQueryObserver(f.client, scheduleRunsOptions(f.session, 'timer'));
  const stop = observer.subscribe(() => {});
  try {
    await flush();
    for (let page = 0; page < 5; page++) await Promise.all([observer.fetchNextPage({ cancelRefetch: false }), observer.fetchNextPage({ cancelRefetch: false })]);
    const data = observer.getCurrentResult().data!;
    assert.equal(data.pages.length, 6);
    assert.equal(data.pages[0].runs[0].id, 160);
    assert.equal(data.pages.at(-1)!.runs.at(-1)!.id, 41);
    assert.deepEqual(cursors, [undefined, 141, 121, 101, 81, 61]);
    latest = 161;
    cursors.length = 0;
    f.session.api.cancelReads(); await flush();
    assert.equal(observer.getCurrentResult().data!.pages[0].runs[0].id, 161);
    assert.equal(cursors[0], undefined);
    assert.equal(observer.getCurrentResult().data!.pages.flatMap(page => page.runs).some(row => row.id === 60), true);
  } finally { stop(); await f.close(); }
});

test('schedule-editor.T1 同 key 共享详情传输，取消后迟到旧快照不能覆盖当前详情', async () => {
  const old = Promise.withResolvers<Response>();
  let reads = 0;
  const signals: AbortSignal[] = [];
  const f = fixture(async (_input, init) => { signals.push(init!.signal!); return ++reads === 1 ? old.promise : Response.json({ id: 'timer', name: '当前' }); });
  const one = new QueryObserver(f.client, scheduleDetailOptions(f.session, 'timer'));
  const two = new QueryObserver(f.client, scheduleDetailOptions(f.session, 'timer'));
  const stopOne = one.subscribe(() => {}), stopTwo = two.subscribe(() => {});
  try {
    assert.equal(reads, 1);
    f.session.api.cancelReads(); await flush();
    assert.equal(signals[0].aborted, true);
    assert.equal(two.getCurrentResult().data?.name, '当前');
    old.resolve(Response.json({ id: 'timer', name: '旧' })); await flush();
    assert.equal(one.getCurrentResult().data?.name, '当前');
  } finally { stopOne(); stopTwo(); await f.close(); }
});

test('schedule-editor.B7 显式重载第一次失败后普通 Query 继续退避读取，不等待外部事件', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let available = true, reads = 0;
  const f = fixture(async () => {
    reads++;
    return available ? Response.json({ id: 'timer', name: '实际内容' }) : Response.json({ error: { code: 'unavailable', message: '读取失败' } }, { status: 503 });
  });
  const options = { ...scheduleDetailOptions(f.session, 'timer'), retryDelay: 10 };
  f.client.setQueryDefaults(options.queryKey, { retryDelay: 10 });
  const observer = new QueryObserver(f.client, options);
  const stop = observer.subscribe(() => {});
  try {
    await flush();
    available = false;
    await assert.rejects(readScheduleForReload(f.session, 'timer'));
    observer.setOptions(options);
    await flush();
    const afterFailure = reads;
    available = true;
    t.mock.timers.tick(1000); await flush();
    assert.ok(reads > afterFailure, 'ordinary read must retry automatically');
    assert.equal(observer.getCurrentResult().status, 'success');
    assert.equal(observer.getCurrentResult().data?.name, '实际内容');
  } finally { stop(); await f.close(); }
});
