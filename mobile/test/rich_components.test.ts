import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayFieldValue, fieldSummaries, parseRichSpec, submissionValues } from '../src/components/rich-message/spec.ts';

const node = (type: string, props: Record<string, unknown>, children: string[] = []) => ({ type, props, children });
const parse = (type: string, props: Record<string, unknown>) => parseRichSpec(JSON.stringify({ root: 'r', elements: { r: node(type, props) }, state: {} }));

test('source host URLs and LinkCard destinations reject unsafe browser links', () => {
  const safe = ['https://www.iana.org/domains/reserved', 'http://example.com/path?q=a'];
  assert.ok(parse('Source', { items: safe.map((url) => ({ url })) }));
  assert.ok(parse('LinkCard', { title: '原文', url: safe[0] }));
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.com/', 'https://example.com\\evil',
    'https://example.com\nextra', 'https://', 'https://example.com:99999', 'https://%65xample.com']) {
    assert.equal(parse('Source', { items: [{ url }] }), null, url);
    assert.equal(parse('LinkCard', { title: '原文', url }), null, url);
  }
  assert.equal(parse('Source', { items: [] }), null);
  assert.equal(parse('Source', { items: safe.map((url) => ({ url })).concat(Array(7).fill({ url: safe[0] })) }), null);
});

test('curated names validate both standalone and list icons without loading lucide wholesale', () => {
  assert.ok(parse('Icon', { name: 'circle-check', label: '成功' }));
  assert.ok(parse('List', { ordered: true, items: [{ text: '完成', icon: 'circle-check' }] }));
  assert.equal(parse('Icon', { name: 'unlisted-icon' }), null);
  assert.equal(parse('List', { items: [{ text: '完成', icon: 'unlisted-icon' }] }), null);
});

test('Select retains machine values across empty and read-only summaries', () => {
  const options = [{ value: 'alpha', label: '方案甲', disabled: true }, { value: 'beta', label: '方案乙' }];
  const elements = {
    r: node('Card', {}, ['f', 's']),
    f: node('Select', { stateKey: 'choice', label: '方案', options }),
    s: node('Submit', { label: '确认' }),
  };
  const spec = parseRichSpec(JSON.stringify({ root: 'r', elements, state: { choice: 'beta' } }));
  assert.ok(spec);
  assert.deepEqual({ ...submissionValues(spec, { choice: 'beta', extra: 'ignored' }) }, { choice: 'beta' });
  assert.deepEqual(fieldSummaries(spec, { choice: 'beta' }), [{ label: '方案', value: '方案乙' }]);
  assert.equal(displayFieldValue('Select', options, ''), '未填写');
  assert.ok(parseRichSpec(JSON.stringify({ root: 'r', elements, state: { choice: '' } })));
  assert.ok(parseRichSpec(JSON.stringify({ root: 'r', elements, state: { choice: 'alpha' } })));
  assert.equal(parseRichSpec(JSON.stringify({ root: 'r', elements, state: { choice: '方案乙' } })), null);
  assert.equal(parseRichSpec(JSON.stringify({ root: 'r', elements: {
    ...elements, f: node('Select', { stateKey: 'choice', options: [options[0], { value: 'alpha', label: '重复' }] }),
  }, state: { choice: '' } })), null);
});

test('semantic badges, responsive grid topology, and bounded math are parsed', () => {
  for (const tone of ['neutral', 'active', 'success', 'warning', 'error', 'info']) {
    assert.ok(parse('Badge', { text: '状态', tone }));
    assert.ok(parse('Status', { title: '状态', badge: { text: '完成', tone } }));
    assert.ok(parse('Table', { columns: ['状态'], rows: [[{ badge: { text: '完成', tone } }]] }));
  }
  assert.equal(parse('Badge', { text: '状态', tone: 'purple' }), null);
  assert.ok(parse('Math', { tex: 'x^2+y^2', display: true }));
  assert.equal(parse('Math', { tex: '🧪'.repeat(2049) }), null);
  const grid = { root: 'r', elements: { r: node('Grid', { columns: 2 }, ['a']), a: node('Text', { text: 'A' }) }, state: {} };
  assert.ok(parseRichSpec(JSON.stringify(grid)));
  assert.equal(parseRichSpec(JSON.stringify({ ...grid, elements: { r: node('Grid', { columns: 4 }, ['a']), a: grid.elements.a } })), null);
});
