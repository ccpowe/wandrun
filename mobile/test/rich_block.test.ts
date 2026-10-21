import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createStateStore } from '@json-render/core';
import { GatewayError } from '../src/gateway/api.ts';
import { alignedSliderValue, displayFieldValue, fieldSummaries, parseRichSpec, pointerForKey, richComponentNames, submissionError, submissionValues } from '../src/components/rich-message/spec.ts';
import { richScenarios } from '../src/dev/rich-scenarios.ts';

const form = {
  root: 'card',
  elements: {
    card: { type: 'Card', props: { title: '选项' }, children: ['choice', 'notes', 'submit'] },
    choice: { type: 'ChoiceGroup', props: { stateKey: 'plan', label: '方案', options: [{ value: 'city', label: '留在城里' }, { value: 'mountain', label: '去山里' }] }, children: [] },
    notes: { type: 'TextInput', props: { stateKey: 'note', label: '补充' }, children: [] },
    submit: { type: 'Submit', props: { label: '提交选择' }, children: [] },
  },
  state: { plan: 'city', note: '' },
};

function changed(mutate: (spec: typeof form) => void): string {
  const copy = structuredClone(form);
  mutate(copy);
  return JSON.stringify(copy);
}

test('有效 spec 的本地状态绑定、全部提交值与已提交可读标签', () => {
  const spec = parseRichSpec(JSON.stringify(form));
  assert.ok(spec);
  const snapshot = { ...spec.state, plan: 'mountain', note: '周六出发', extra: '不能提交' };
  assert.deepEqual({ ...submissionValues(spec, snapshot) }, { plan: 'mountain', note: '周六出发' });
  assert.deepEqual(fieldSummaries(spec, snapshot), [{ label: '方案', value: '去山里' }, { label: '补充', value: '周六出发' }]);
  assert.equal(pointerForKey('a/b~c'), '/a~1b~0c');
});

test('两个界面块的状态隔离，合法 stateKey 按原键提交；路径编码仍处理旧输入', () => {
  const original = structuredClone(form);
  original.elements.choice.props.stateKey = 'plan_2';
  const spec = parseRichSpec(JSON.stringify({ ...original, state: { plan_2: 'city', note: '' } }));
  assert.ok(spec);
  const first = createStateStore(spec.state);
  const second = createStateStore(spec.state);
  first.set(pointerForKey('plan_2'), 'mountain');
  first.set(pointerForKey('note'), '周六出发');
  assert.deepEqual({ ...submissionValues(spec, first.getSnapshot()) }, { plan_2: 'mountain', note: '周六出发' });
  assert.deepEqual({ ...submissionValues(spec, second.getSnapshot()) }, { plan_2: 'city', note: '' });
  assert.equal(pointerForKey('a/b~c'), '/a~1b~0c');
});

test('真实滑块回调浮点值按十进制步长归一，提交值仍由当前 state 快照组装', () => {
  assert.equal(alignedSliderValue(0, 1, 0.1, 0.30000001192092896), 0.3);
  assert.equal(alignedSliderValue(0.1, 1.1, 0.2, 0.699999988079071), 0.7);
  assert.equal(alignedSliderValue(0, 0, 0.1, 0), 0);
  const source = JSON.stringify({ root: 'card', elements: {
    card: { type: 'Card', props: {}, children: ['slider', 'submit'] },
    slider: { type: 'Slider', props: { stateKey: 'tone', label: '语气', min: 0, max: 1, step: 0.1 }, children: [] },
    submit: { type: 'Submit', props: { label: '确定' }, children: [] },
  }, state: { tone: 0.7 } });
  const spec = parseRichSpec(source);
  assert.ok(spec);
  assert.deepEqual({ ...submissionValues(spec, { tone: alignedSliderValue(0, 1, 0.1, 0.30000001192092896) }) }, { tone: 0.3 });
});

test('保留禁用初值和等值滑块范围；拒绝空 stateKey 与无效日历日期', () => {
  const source = JSON.stringify({
    ...form,
    elements: { ...form.elements, choice: { ...form.elements.choice, props: {
      ...form.elements.choice.props,
      options: [{ ...form.elements.choice.props.options[0], disabled: true }, form.elements.choice.props.options[1]],
    } } },
  });
  assert.ok(parseRichSpec(source));
  assert.equal(parseRichSpec(changed((s) => { s.elements.choice.props.stateKey = ''; })), null);
  const flat = JSON.stringify({ root: 'x', elements: {
    x: { type: 'Card', props: {}, children: ['slider', 'submit'] },
    slider: { type: 'Slider', props: { stateKey: 'one', label: '固定值', min: 1, max: 1, step: 0.1 }, children: [] },
    submit: { type: 'Submit', props: { label: '提交' }, children: [] },
  }, state: { one: 1 } });
  assert.ok(parseRichSpec(flat));
  const date = JSON.parse(flat);
  date.elements.slider = { type: 'DateInput', props: { stateKey: 'one', label: '日期' }, children: [] };
  date.state.one = '2026-02-30';
  assert.equal(parseRichSpec(JSON.stringify(date)), null);
});

test('拒绝未知组件、共享子树、循环、孤立节点、未定义子节点、非法表单结构及危险键', () => {
  assert.equal(parseRichSpec(changed((s) => { s.elements.choice.type = 'Other'; })), null);
  assert.equal(parseRichSpec(changed((s) => { s.elements.card.children.push('choice'); })), null);
  assert.equal(parseRichSpec(changed((s) => { s.elements.card.children.push('card'); })), null);
  assert.equal(parseRichSpec(changed((s) => { s.elements.card.children.splice(1, 1); })), null);
  assert.equal(parseRichSpec(changed((s) => { s.elements.card.children.push('missing'); })), null);
  assert.equal(parseRichSpec(changed((s) => { s.elements.card.children.pop(); })), null);
  assert.equal(parseRichSpec(changed((s) => { s.state.plan = 'invalid'; })), null);
  assert.equal(parseRichSpec(changed((s) => { s.elements.choice.props.stateKey = '__proto__'; })), null);
  assert.equal(parseRichSpec('{"root":"__proto__","elements":{"__proto__":{"type":"Text","props":{"text":"x"},"children":[]}},"state":{}}'), null);
});

test('限制深度和节点数，拒绝错误属性形状、错误列数和原型键', () => {
  const deep: { root: string; elements: Record<string, unknown>; state: Record<string, unknown> } = { root: 'n0', elements: {}, state: {} };
  for (let i = 0; i < 9; i++) deep.elements[`n${i}`] = { type: 'Stack', props: {}, children: i < 8 ? [`n${i + 1}`] : [] };
  assert.equal(parseRichSpec(JSON.stringify(deep)), null);
  deep.elements = {};
  for (let i = 0; i < 61; i++) deep.elements[`n${i}`] = { type: 'Stack', props: {}, children: i < 60 ? [`n${i + 1}`] : [] };
  assert.equal(parseRichSpec(JSON.stringify(deep)), null);
  assert.equal(parseRichSpec(JSON.stringify({ root: 'x', elements: { x: { type: 'Table', props: { columns: ['A', 'B'], rows: [['1']] }, children: [] } }, state: {} })), null);
  assert.equal(parseRichSpec('{"root":"x","elements":{"x":{"type":"Text","props":{"text":"x","__proto__":1},"children":[]}},"state":{}}'), null);
});

test('400 可修改、404/409 终止、网络未知结果可重试', () => {
  const invalid = submissionError(new GatewayError(400, 'ui_invalid_values', 'wrong', { note: '请检查输入内容' }));
  assert.equal(invalid.editable, true);
  assert.equal(invalid.retryable, false);
  for (const [status, code] of [[404, 'ui_block_not_found'], [409, 'ui_already_submitted']] as const) {
    const error = submissionError(new GatewayError(status, code, 'wrong'));
    assert.equal(error.retryable, false);
    assert.equal(error.editable, false);
  }
  assert.equal(submissionError(new GatewayError(0, 'network', 'offline')).retryable, true);
  assert.equal(submissionError(new GatewayError(503, 'unavailable', 'retry')).editable, false);
});

test('root、元素与 stateKey 只接受非保留的 1～64 位 ASCII 标识符', () => {
  const leaf = (id: string) => JSON.stringify({ root: id, elements: { [id]: { type: 'Text', props: { text: '可见' }, children: [] } }, state: {} });
  assert.ok(parseRichSpec(leaf('_' + 'a'.repeat(63))));
  for (const id of ['', '1bad', 'bad-key', '含汉字', 'valid\n', 'x'.repeat(65), 'constructor', 'prototype', '__proto__']) {
    assert.equal(parseRichSpec(leaf(id)), null, `root=${id}`);
    const invalidNode = JSON.stringify({ root: 'card', elements: {
      card: { type: 'Card', props: {}, children: [id] },
      [id]: { type: 'Text', props: { text: '可见' }, children: [] },
    }, state: {} });
    assert.equal(parseRichSpec(invalidNode), null, `element=${id}`);
    const control = JSON.parse(JSON.stringify(form));
    control.elements.choice.props.stateKey = id;
    control.state = { [id]: 'city', note: '' };
    assert.equal(parseRichSpec(JSON.stringify(control)), null, `stateKey=${id}`);
  }
});

test('空 option.value、重复选项与重复多选初值无效，旧只读值先匹配标签', () => {
  for (const type of ['ChoiceGroup', 'Select', 'Segmented', 'MultiSelect']) {
    const spec = JSON.parse(JSON.stringify(form));
    spec.elements.choice.type = type;
    spec.state.plan = type === 'MultiSelect' ? [] : '';
    assert.ok(parseRichSpec(JSON.stringify(spec)), type);
    spec.elements.choice.props.options[0].value = '';
    assert.equal(parseRichSpec(JSON.stringify(spec)), null, `${type}: empty option`);
    spec.elements.choice.props.options[0].value = 'city';
    spec.elements.choice.props.options[1].value = 'city';
    assert.equal(parseRichSpec(JSON.stringify(spec)), null, `${type}: duplicate options`);
  }
  const multi = JSON.parse(JSON.stringify(form));
  multi.elements.choice.type = 'MultiSelect';
  multi.state.plan = ['city', 'city'];
  assert.equal(parseRichSpec(JSON.stringify(multi)), null);
  multi.state.plan = ['city', 'mountain'];
  assert.ok(parseRichSpec(JSON.stringify(multi)));
  assert.equal(displayFieldValue('ChoiceGroup', [{ value: '', label: '无需' }], ''), '无需');
  assert.equal(displayFieldValue('Select', [{ value: '', label: '无需' }], ''), '无需');
  assert.equal(displayFieldValue('Segmented', [{ value: '', label: '无需' }], ''), '无需');
  assert.equal(displayFieldValue('ChoiceGroup', [{ value: 'yes', label: '需要' }], ''), '未填写');
});

const gatewayCatalog = new URL('../../src/wandrun/gateway/ui_catalog.json', import.meta.url);
test('App registry component names match the shared gateway catalog', { skip: !existsSync(gatewayCatalog) && 'gateway catalog not generated in this app worktree' }, () => {
  const document = JSON.parse(readFileSync(gatewayCatalog, 'utf8')) as { components: Record<string, unknown> };
  assert.deepEqual([...richComponentNames].sort(), Object.keys(document.components).sort());
});

test('media preview scenarios remain valid bounded specs', () => {
  for (const id of ['network-image', 'media-layout', 'mermaid']) {
    const scene = richScenarios.find((candidate) => candidate.id === id);
    assert.ok(scene);
    const match = /```wandrun-ui\n([^\n]+)\n```/.exec(scene.text);
    assert.ok(match);
    assert.ok(parseRichSpec(match[1]), id);
  }
});
