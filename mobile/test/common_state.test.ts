import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../src/gateway/api.ts';
import { deferLoadingIndicator, LoadResource } from '../src/lib/load-state.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const refusal = (status: number) => new GatewayError(status, 'refused', '提交内容有误，请检查后重试');

test('LoadingState.pending 300ms 边界与快速完成取消', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let visible = false;
  const cancel = deferLoadingIndicator(() => { visible = true; });
  t.mock.timers.tick(299);
  assert.equal(visible, false);
  cancel();
  t.mock.timers.tick(1);
  assert.equal(visible, false);
  deferLoadingIndicator(() => { visible = true; });
  t.mock.timers.tick(299);
  assert.equal(visible, false);
  t.mock.timers.tick(1);
  assert.equal(visible, true);
});

test('LoadResource 失败更新原因，自动退避至成功并重置间隔', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const resource = new LoadResource(async () => {
    requests++;
    if (requests < 3 || requests === 4) throw refusal(requests === 1 ? 503 : 502);
    return ['Agent'];
  });
  await resource.retry();
  assert.equal(resource.getSnapshot().status, 'error');
  t.mock.timers.tick(499);
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal((resource.getSnapshot().error as GatewayError).status, 502);
  t.mock.timers.tick(999);
  assert.equal(requests, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(resource.getSnapshot(), { status: 'ready', data: ['Agent'], error: null });
  await resource.retry();
  t.mock.timers.tick(499);
  assert.equal(requests, 4);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(requests, 5);
  assert.equal(resource.getSnapshot().status, 'ready');
  resource.stop();
});

test('LoadResource 手动重试抢占等待，进行中重复触发不加请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const { promise, resolve: finish } = Promise.withResolvers<string[]>();
  const resource = new LoadResource(() => {
    requests++;
    return requests === 1 ? Promise.reject(refusal(503)) : promise;
  });
  await resource.retry();
  const retry = resource.retry();
  await resource.retry();
  t.mock.timers.tick(10_000);
  assert.equal(requests, 2);
  assert.equal(resource.getSnapshot().status, 'retrying');
  finish([]);
  await retry;
  assert.deepEqual(resource.getSnapshot().data, []);
  resource.stop();
});

test('LoadResource 刷新失败保留旧内容，停止后忽略迟到响应并取消重试', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const resource = new LoadResource(async () => {
    if (++requests > 1) throw refusal(503);
    return ['old'];
  });
  await resource.retry();
  await resource.retry();
  assert.deepEqual(resource.getSnapshot().data, ['old']);
  assert.equal(resource.getSnapshot().status, 'error');
  resource.stop();
  t.mock.timers.tick(100_000);
  assert.equal(requests, 2);
  const { promise, resolve: finish } = Promise.withResolvers<string[]>();
  const late = new LoadResource(() => promise);
  const pending = late.retry();
  late.stop();
  finish(['late']);
  await pending;
  assert.equal(late.getSnapshot().data, undefined);
});

