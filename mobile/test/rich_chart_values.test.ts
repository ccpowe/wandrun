import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartValueAxis } from '../src/components/rich-message/chart-values.ts';

test('both chart types use original signed units, zero baseline, and finite display coordinates', () => {
  for (const values of [
    [10, 12, 11], [-17.2, -9.6, -10.6], [-3, 9, 1],
    [0, 0, 0], [42, 42], [-42, -42],
    [0.00001, 0.00003], [-0.00001, 0, 0.00003],
  ]) {
    const original = [...values];
    const axis = chartValueAxis(values);
    assert.ok(axis.below + axis.above >= 4 && axis.below + axis.above <= 5);
    assert.equal(axis.ticks.length, axis.below + axis.above + 1);
    assert.equal(axis.ticks[axis.below], '0');
    assert.ok(Number(axis.ticks[0]) <= Math.min(...values));
    assert.ok(Number(axis.ticks.at(-1)) >= Math.max(...values));
    for (let index = 1; index < axis.ticks.length; index++) {
      assert.ok(Number(axis.ticks[index - 1]) < Number(axis.ticks[index]), `${values}: ${axis.ticks.join(', ')}`);
    }
    if (values.every((value) => value >= 0)) {
      assert.equal(axis.below, 0);
      assert.equal(axis.ticks[0], '0');
    }
    if (values.every((value) => value <= 0) && values.some((value) => value < 0)) {
      assert.equal(axis.above, 0);
      assert.equal(axis.ticks.at(-1), '0');
    }
    for (const [index, coordinate] of axis.values.entries()) {
      assert.ok(Number.isFinite(coordinate));
      assert.ok(coordinate >= -axis.below * 25 && coordinate <= axis.above * 25);
      if (values[index] < 0) assert.ok(coordinate < 0);
      if (values[index] > 0) assert.ok(coordinate > 0);
    }
    assert.deepEqual(values, original);
  }
});

test('nice grid intervals are 1, 2, or 5 times a decimal power', () => {
  for (const values of [[1.1], [12], [190], [0.00012], [-17.2], [-3, 9], [-1, 1000]]) {
    const axis = chartValueAxis(values);
    const absoluteTicks = axis.ticks.map(Number);
    const oneBand = absoluteTicks[1] - absoluteTicks[0];
    const normalized = oneBand / 10 ** Math.floor(Math.log10(oneBand));
    assert.ok([1, 2, 5].some((factor) => Math.abs(normalized - factor) < 1e-9), `${values}: ${oneBand}`);
    assert.ok(absoluteTicks.every(Number.isFinite));
  }
});

test('tiny, maximum and close decimal inputs keep finite, distinguishable geometry and finite labels', () => {
  for (const values of [
    [Number.MIN_VALUE, 2 * Number.MIN_VALUE],
    [-Number.MIN_VALUE, Number.MIN_VALUE],
    [-Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE, Number.MAX_VALUE],
    [-Number.MAX_VALUE, -Number.MAX_VALUE],
    [1e308, 1.1e308], [1000, 1000.001],
  ]) {
    const axis = chartValueAxis(values);
    assert.ok(axis.values.every(Number.isFinite), String(values));
    assert.ok(axis.ticks.every((label) => Number.isFinite(Number(label))), axis.ticks.join(', '));
    assert.ok(Number(axis.ticks[0]) <= Math.min(...values));
    assert.ok(Number(axis.ticks.at(-1)) >= Math.max(...values));
    if (values[0] !== values[1]) assert.notEqual(axis.values[0], axis.values[1]);
  }
  // The true endpoint would be 2e308, so only this last tick is capped at MAX_VALUE.
  const extreme = chartValueAxis([Number.MAX_VALUE]);
  assert.equal(extreme.ticks.at(-1), String(Number.MAX_VALUE));
  assert.equal(extreme.ticks.at(-2), '1.5e+308');
});

test('asymmetric extremes never repeat capped ticks on either side of zero', () => {
  for (const values of [
    [-1e308, Number.MAX_VALUE], [-Number.MAX_VALUE, 1e308],
    [-Number.MAX_VALUE, Number.MAX_VALUE], [-Number.MAX_VALUE], [Number.MAX_VALUE],
    [-Number.MAX_VALUE, -1e308], [1e308, Number.MAX_VALUE],
  ]) {
    const axis = chartValueAxis(values);
    const numbers = axis.ticks.map(Number);
    assert.ok(numbers.every(Number.isFinite));
    assert.ok(numbers[0] <= Math.min(...values));
    assert.ok(numbers.at(-1)! >= Math.max(...values));
    assert.ok(numbers.slice(1).every((value, index) => value > numbers[index]), `${values}: ${axis.ticks}`);
    assert.ok(axis.below + axis.above >= 4 && axis.below + axis.above <= 5);
    assert.equal(axis.labels.length, axis.ticks.length);
    assert.ok(axis.labels.every((label) => label.length <= 9 && !label.includes('Infinity')));
    if (values.every((value) => value >= 0)) assert.equal(axis.below, 0);
    if (values.every((value) => value <= 0)) assert.equal(axis.above, 0);
  }
});
