import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { QueryObserver, onlineManager } from '@tanstack/react-query';
import { ChatSession } from '../src/gateway/session.ts';
import type { FileDetail } from '../src/gateway/api.ts';
import { attachSessionQueries, createGatewayQueryClient, fileDetailOptions, readFileForDelivery } from '../src/lib/gateway-queries.ts';

const detail: FileDetail = { id: 'file', name: 'current.txt', size: 7, media_type: 'text/plain', available: true,
  conversation_id: null, agent_id: null, task_id: 'root', created_at: 1, remote_environment: null, error: null, error_message: null };
const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
test('files.A1/A2 同 key 共享；连接恢复中止响应体，迟到正文不能覆盖重读；关闭 session 清缓存', async () => {
  const body = Promise.withResolvers<unknown>();
  const signals: AbortSignal[] = [];
  const listeners = new Set<() => void>();
  const client = createGatewayQueryClient(); client.mount();
  const session = new ChatSession({ baseUrl: 'http://files.test', token: 'test' }, async (_input, init) => {
    signals.push(init!.signal!);
    return signals.length === 1 ? { ok: true, status: 200, json: () => body.promise } as Response : Response.json(detail);
  });
  session.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  attachSessionQueries(session, client);
  const options = fileDetailOptions(session, 'file');
  const first = new QueryObserver(client, options); const second = new QueryObserver(client, options);
  const stopFirst = first.subscribe(() => {}); const stopSecond = second.subscribe(() => {});
  try {
    await flush(); assert.equal(signals.length, 1);
    stopFirst(); assert.equal(signals[0].aborted, false, 'another active consumer still owns the read');
    session.connection = 'open'; for (const listener of listeners) listener();
    assert.equal(signals[0].aborted, true);
    await flush(); assert.equal(second.getCurrentResult().data?.name, 'current.txt');
    body.resolve({ ...detail, name: 'stale.txt' }); await flush();
    assert.equal(second.getCurrentResult().data?.name, 'current.txt');
    stopSecond(); await session.close();
    assert.equal(client.getQueryData(options.queryKey), undefined);
  } finally { body.resolve(detail); stopFirst(); stopSecond(); await session.close(); client.unmount(); client.clear(); }
});
test('files.A2 离线 paused 不等于空或失败，恢复后读取；刷新失败保留旧正文元数据', async () => {
  const client = createGatewayQueryClient(); client.mount();
  let fail = false;
  const session = new ChatSession({ baseUrl: 'http://offline-files.test', token: 'test' }, async () => fail
    ? Response.json({ error: { code: 'unavailable', message: 'offline' } }, { status: 503 }) : Response.json(detail));
  attachSessionQueries(session, client);
  onlineManager.setOnline(false);
  const options = fileDetailOptions(session, 'file');
  const observer = new QueryObserver(client, { ...options, retry: false });
  const stop = observer.subscribe(() => {});
  try {
    await flush(); assert.equal(observer.getCurrentResult().fetchStatus, 'paused');
    assert.equal(observer.getCurrentResult().data, undefined); assert.equal(observer.getCurrentResult().error, null);
    onlineManager.setOnline(true); await flush();
    assert.equal(observer.getCurrentResult().data?.name, 'current.txt');
    fail = true; await observer.refetch();
    assert.equal(observer.getCurrentResult().data?.name, 'current.txt'); assert.ok(observer.getCurrentResult().error);
  } finally { onlineManager.setOnline(true); stop(); await session.close(); client.unmount(); client.clear(); }
});
test('files.B1 交付前检查读取真实当前可用性，命令不等待后台自动退避或重放', async () => {
  const client = createGatewayQueryClient();
  let calls = 0;
  const session = new ChatSession({ baseUrl: 'http://delivery-files.test', token: 'test' }, async () => {
    calls++; return Response.json({ ...detail, available: false });
  });
  attachSessionQueries(session, client);
  client.setQueryData(fileDetailOptions(session, 'file').queryKey, detail);
  try {
    assert.equal((await readFileForDelivery(session.api, 'file')).available, false);
    assert.equal(calls, 1);
    assert.equal(client.getQueryData(fileDetailOptions(session, 'file').queryKey)?.available, false);
  } finally { await session.close(); client.clear(); }
});
