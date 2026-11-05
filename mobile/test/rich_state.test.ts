import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRichSpec } from '../src/components/rich-message/spec.ts';
import { resolveRichBindings, richVisible } from '../src/lib/rich-state.ts';

function form(binding: unknown) {
  return {
    root: 'root', state: { plan: '' }, elements: {
      root: { type: 'Stack', props: {}, children: ['choice', 'text', 'submit'] },
      choice: { type: 'Select', props: { stateKey: 'plan', options: [{ value: 'basic', label: '基础方案' }, { value: 'pro', label: '专业方案' }] }, children: [] },
      text: { type: 'Text', props: { text: binding }, children: [] },
      submit: { type: 'Submit', props: { label: '提交' }, children: [] },
    },
  };
}

test('Bound.value 空值显示破折号；选项显示 label，不能读块外或伪造表达式', () => {
  const spec = parseRichSpec(JSON.stringify(form({ $state: '/plan' })))!;
  assert.equal(resolveRichBindings(spec, { plan: '' }).elements.text.props.text, '—');
  assert.equal(resolveRichBindings(spec, { plan: 'pro' }).elements.text.props.text, '专业方案');
  for (const binding of [{ $state: '/missing' }, { $state: '/plan/child' }, { $state: '/constructor' }, { $state: '/plan', extra: true }, { $item: 'plan' }, { $cond: ['/plan', 'a', 'b'] }]) {
    assert.equal(parseRichSpec(JSON.stringify(form(binding))), null);
  }
  const badge = form({ $state: '/plan' });
  badge.elements.text.type = 'Badge';
  assert.equal(parseRichSpec(JSON.stringify(badge)), null);
});

test('Bound.visible / rich.T8 空数组、false、0、空串隐藏；比较按值且 not 反转', () => {
  for (const value of [[], false, 0, '']) {
    assert.equal(richVisible({ $state: '/key' }, { key: value }), false);
    assert.equal(richVisible({ $state: '/key', not: true }, { key: value }), true);
  }
  assert.equal(richVisible({ $state: '/key', eq: ['a', 'b'] }, { key: ['a', 'b'] }), true);
  assert.equal(richVisible({ $state: '/key', eq: 1 }, { key: true }), false);
  assert.equal(richVisible({ $state: '/key', neq: 'a', not: true }, { key: 'a' }), true);
  for (const condition of [{ $state: '/missing' }, { $state: '/plan', eq: 'a', neq: 'b' },
    { $state: '/plan', gt: 2 }, { $and: [{ $state: '/plan' }] }, { $state: '/plan', eq: { $state: '/plan' } }]) {
    const spec = form('结果');
    assert.equal(parseRichSpec(JSON.stringify({ ...spec, elements: { ...spec.elements, text: { ...spec.elements.text, visible: condition } } })), null);
  }
});

test('Bound.visible 隐藏的布局子项不占位，Tabs 保持原始标签/面板位置', () => {
  const wire = form('条件内容');
  const spec = parseRichSpec(JSON.stringify({ ...wire, elements: {
    ...wire.elements, text: { ...wire.elements.text, visible: { $state: '/plan' } },
  } }))!;
  assert.deepEqual(resolveRichBindings(spec, { plan: '' }).elements.root.children, ['choice', 'submit']);
  assert.equal(resolveRichBindings(spec, { plan: 'pro' }).elements.text.visible, true);
  const tabs = parseRichSpec(JSON.stringify({ ...wire, elements: {
    ...wire.elements,
    root: { ...wire.elements.root, children: ['choice', 'tabs', 'submit'] },
    tabs: { type: 'Tabs', props: { tabs: [{ label: '首项' }, { label: '次项' }] }, children: ['text', 'other'] },
    text: { ...wire.elements.text, visible: { $state: '/plan' } },
    other: { type: 'Text', props: { text: '次项内容' }, children: [] },
  } }))!;
  const rendered = resolveRichBindings(tabs, { plan: '' });
  assert.deepEqual(rendered.elements.tabs.children, ['text', 'other']);
  assert.equal(rendered.elements.text.visible, false);
});
