import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeliveryAccess, deliveryReducer, initialDeliveryState, leaseReducer, type DeliveryState } from '../src/lib/delivery-action.ts';

const working: DeliveryState = { status: 'working', operationId: 'one', action: 'download' };
test('delivery.T1 开始操作原子清除旧提示', () => {
  assert.deepEqual(deliveryReducer({ status: 'idle', error: '失败', saved: true }, { type: 'start', operationId: 'one', action: 'download' }), working);
});
test('delivery.T2 只有实际保存完成才显示成功，取消与分享不显示保存成功', () => {
  for (const saved of [true, false]) assert.deepEqual(deliveryReducer(working, { type: 'finished', operationId: 'one', saved, error: null }), { status: 'idle', saved, error: null });
});
test('delivery.T3 失败回到可重试状态并保留错误', () => {
  const failed = deliveryReducer(working, { type: 'finished', operationId: 'one', saved: false, error: '存储空间不足' });
  assert.deepEqual(failed, { status: 'idle', saved: false, error: '存储空间不足' });
  assert.equal(deliveryReducer(failed, { type: 'start', operationId: 'two', action: 'share' }).status, 'working');
});
test('delivery.T4 同帧重复命令与迟到结果不能获得第二次 native handoff', () => {
  const access = new DeliveryAccess();
  assert.equal(access.send({ type: 'start', operationId: 'one', action: 'download' }), true);
  assert.equal(access.send({ type: 'start', operationId: 'two', action: 'share' }), false);
  assert.equal(access.send({ type: 'finished', operationId: 'two', error: null, saved: true }), false);
  assert.deepEqual(access.getSnapshot(), working);
  assert.equal(deliveryReducer(initialDeliveryState, { type: 'finished', operationId: 'one', error: null, saved: true }), initialDeliveryState);
});
test('delivery.T5 关闭访问拒绝迟到结果；重新聚焦不能接收前次操作结果', () => {
  const access = new DeliveryAccess();
  access.send({ type: 'start', operationId: 'one', action: 'download' });
  access.send({ type: 'close' });
  assert.equal(access.send({ type: 'finished', operationId: 'one', error: null, saved: true }), false);
  assert.equal(access.send({ type: 'start', operationId: 'two', action: 'share' }), false);
  access.open();
  assert.equal(access.send({ type: 'finished', operationId: 'one', error: null, saved: true }), false);
  assert.equal(access.getSnapshot(), initialDeliveryState);
});
test('lease.T1 ready 持有本次 URI，不接受重复完成覆盖原生已显示资源', () => {
  const ready = leaseReducer<string>({ status: 'loading' }, { type: 'ready', value: 'current-uri' });
  assert.deepEqual(ready, { status: 'ready', value: 'current-uri' });
  assert.equal(leaseReducer(ready, { type: 'ready', value: 'late-uri' }), ready);
});
test('lease.T2 读取或解码失败均进入 failed；失败不被迟到成功复活', () => {
  for (const state of [{ status: 'loading' } as const, { status: 'ready', value: 'bad-uri' } as const]) {
    const failed = leaseReducer<string>(state, { type: 'failed', error: 'decode' });
    assert.deepEqual(failed, { status: 'failed', error: 'decode' });
    assert.equal(leaseReducer(failed, { type: 'ready', value: 'late-uri' }), failed);
  }
});
