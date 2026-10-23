import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRichSpec } from '../src/components/rich-message/spec.ts';
import { messageText } from '../src/lib/message-actions.ts';

const spec = (type: string, props: Record<string, unknown>) => ({
  root: 'root', elements: { root: { type, props, children: [] } }, state: {},
});
const parseTree = (nodes: unknown[], title?: string) => parseRichSpec(JSON.stringify(spec('FileTree', { nodes, ...(title === undefined ? {} : { title }) })));
const message = (value: unknown) => `\`\`\`wandrun-ui\n${JSON.stringify(value)}\n\`\`\``;

test('FileTree accepts inferred and missing parents, explicit empty folders, Unicode and all limits', () => {
  for (const nodes of [
    [{ path: 'src/features/file.ts' }],
    [{ path: 'src/file.ts' }, { path: 'src', note: 'late parent' }, { path: 'empty/' }],
    [{ path: 'a/b/c/d/e/f/g/h' }],
    [{ path: '🧪'.repeat(64) }],
    [{ path: `${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}/12345` }],
    Array.from({ length: 80 }, (_, index) => ({ path: `file${index}`, note: '🧪'.repeat(60), collapsed: false })),
  ]) assert.ok(parseTree(nodes, '🧪'.repeat(40)), JSON.stringify(nodes));
});

test('FileTree rejects path aliases, invalid segments and explicit file ancestors in either input order', () => {
  const invalid = [
    [{ path: 'src' }, { path: 'src/' }],
    [{ path: 'same' }, { path: 'same' }],
    [{ path: 'src', kind: 'file' }, { path: 'src/child.ts' }],
    [{ path: 'src/child.ts' }, { path: 'src', kind: 'file' }],
    [{ path: 'src/', kind: 'file' }],
    ...['', '/', '/src', 'src//child', 'src//', '.', '..', 'src/./child', 'src/../child', 'src\\child', 'src\u0000child', 'src\nchild', 'a/b/c/d/e/f/g/h/i', '🧪'.repeat(65)].map(path => [{ path }]),
    [{ path: 'x', note: '🧪'.repeat(61) }],
    [{ path: 'x', collapsed: 'yes' }],
    [{ path: 'x', kind: 'directory' }],
    [{ path: 'x', unexpected: true }],
    [],
    Array.from({ length: 81 }, (_, index) => ({ path: `file${index}` })),
    [{ path: `${'a'.repeat(64)}/${'b'.repeat(64)}/${'c'.repeat(64)}/123456` }],
  ];
  for (const nodes of invalid) assert.equal(parseTree(nodes), null, JSON.stringify(nodes));
  assert.equal(parseTree([{ path: 'x' }], '🧪'.repeat(41)), null);
});

test('LinkCard image and tags enforce URL policy and Unicode bounds independently of destination', () => {
  const parseLink = (extra: Record<string, unknown>) => parseRichSpec(JSON.stringify(spec('LinkCard', {
    title: 'Reference', url: 'https://example.com/article', ...extra,
  })));
  assert.ok(parseLink({ image: 'https://images.example.com/p.png', tags: ['🧪'.repeat(12), '官方', '参考'] }));
  assert.ok(parseLink({ tags: [] }));
  for (const extra of [
    { image: 'file:///private.png' }, { image: 'https://user:secret@example.com/p.png' },
    { image: `https://example.com/${'x'.repeat(2048)}` },
    { tags: ['🧪'.repeat(13)] }, { tags: ['a', 'b', 'c', 'd'] }, { tags: [1] },
  ]) assert.equal(parseLink(extra), null, JSON.stringify(extra));
});

test('FileTree copy and quote share ordered complete tree text regardless of collapsed overrides', () => {
  const nodes = [
    { path: 'src/z.ts', note: '入口' },
    { path: 'README.md', note: '说明' },
    { path: 'src/deep/b.ts' },
    { path: 'src/', note: '源码', collapsed: true },
    { path: 'src/a.ts' },
    { path: 'empty/', collapsed: true },
  ];
  const expected = '项目结构\nsrc/  # 源码\n  z.ts  # 入口\n  deep/\n    b.ts\n  a.ts\nREADME.md  # 说明\nempty/';
  for (const collapsed of [true, false]) {
    const result = messageText(message(spec('FileTree', { title: '项目结构', nodes: nodes.map(node => ({ ...node, collapsed })) })));
    assert.equal(result.copy.trim(), expected);
    assert.equal(result.quote, expected);
  }
  assert.equal(messageText(message(spec('FileTree', { nodes: [{ path: 'a/b.ts' }] }))).quote, '目录结构\na/\n  b.ts');
});

test('LinkCard summary exposes only title, visible hostname and description, not image or destination path', () => {
  const result = messageText(message(spec('LinkCard', { title: '官方文档', url: 'https://www.example.com/private?token=secret',
    description: '使用说明', image: 'https://images.example.com/private.png', tags: ['官方'] })));
  assert.equal(result.copy.trim(), '官方文档 — example.com\n使用说明');
  assert.equal(result.quote, '官方文档 — example.com\n使用说明');
});

test('invalid historical FileTree never leaks raw node data into message copy', () => {
  const result = messageText(message(spec('FileTree', { nodes: [{ path: '../secret' }] })));
  assert.equal(result.copy, '');
  assert.equal(result.quote, '');
});
