import assert from 'node:assert/strict';
import test from 'node:test';
import { NoticeDeadline } from '../src/lib/notice-deadline.ts';

function source(initial: string | null) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    change(next: string | null) { value = next; for (const listener of listeners) listener(); },
    listeners,
  };
}

test('notice 持续满 3 秒显示、恢复立即消失，短暂状态不显示', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = source(null);
  const notice = new NoticeDeadline(state.read, state.subscribe);
  const values: boolean[] = [];
  const detach = notice.subscribe(() => values.push(notice.snapshot()));
  state.change('offline');
  t.mock.timers.tick(2999);
  assert.equal(notice.snapshot(), false);
  state.change(null);
  t.mock.timers.tick(1);
  assert.deepEqual(values, []);
  state.change('offline');
  t.mock.timers.tick(2999);
  assert.equal(notice.snapshot(), false);
  t.mock.timers.tick(1);
  assert.equal(notice.snapshot(), true);
  state.change(null);
  assert.equal(notice.snapshot(), false);
  assert.deepEqual(values, [true, false]);
  detach();
});

test('notice 状态身份改变重新计时、同一状态更新不延长，反复抖动不闪现', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = source('first');
  const notice = new NoticeDeadline(state.read, state.subscribe);
  const values: boolean[] = [];
  const detach = notice.subscribe(() => values.push(notice.snapshot()));
  t.mock.timers.tick(2000);
  state.change('second');
  t.mock.timers.tick(2999);
  assert.equal(notice.snapshot(), false);
  state.change('second');
  t.mock.timers.tick(1);
  assert.equal(notice.snapshot(), true);
  state.change(null);
  values.length = 0;
  for (let index = 0; index < 5; index++) {
    state.change('offline');
    t.mock.timers.tick(2999);
    state.change(null);
    t.mock.timers.tick(1);
  }
  assert.deepEqual(values, []);
  detach();
});

test('notice 最后订阅卸载撤销来源与计时，重挂不继承期限', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = source('offline');
  const notice = new NoticeDeadline(state.read, state.subscribe);
  const values: boolean[] = [];
  const record = () => values.push(notice.snapshot());
  const detach = notice.subscribe(record);
  t.mock.timers.tick(2999);
  detach();
  assert.equal(state.listeners.size, 0);
  t.mock.timers.tick(3000);
  assert.deepEqual(values, []);
  const remount = notice.subscribe(record);
  t.mock.timers.tick(2999);
  assert.equal(notice.snapshot(), false);
  t.mock.timers.tick(1);
  assert.deepEqual(values, [true]);
  remount();
});
