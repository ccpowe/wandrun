import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFileTree } from '../src/components/rich-message/file-tree-model.ts';

test('missing parents are inserted at first occurrence, while late explicit parents preserve sibling order', () => {
  const tree = buildFileTree([
    { path: 'src/features/orders/view.tsx', note: 'screen' },
    { path: 'README.md' },
    { path: 'src/app.tsx' },
    { path: 'src/features/', note: 'group', collapsed: true },
    { path: 'src/' },
    { path: 'src/features/orders/index.ts', kind: 'file' },
  ]);
  assert.deepEqual(tree.map(node => node.path), ['src', 'README.md']);
  assert.deepEqual(tree[0].children.map(node => node.path), ['src/features', 'src/app.tsx']);
  assert.equal(tree[0].kind, 'folder');
  const features = tree[0].children[0];
  assert.equal(features.note, 'group');
  assert.equal(features.collapsed, true);
  assert.deepEqual(features.children[0].children.map(node => node.name), ['view.tsx', 'index.ts']);
  assert.equal(features.children[0].kind, 'folder');
  assert.equal(features.children[0].children[0].note, 'screen');
  assert.equal(tree[1].kind, 'file');
});

test('trailing slash and explicitly empty folders are kept as folders without changing canonical path', () => {
  const tree = buildFileTree([{ path: 'empty/' }, { path: 'src/module', kind: 'folder' }, { path: 'src/file' }]);
  assert.deepEqual(tree.map(node => [node.name, node.kind, node.path]), [
    ['empty', 'folder', 'empty'], ['src', 'folder', 'src'],
  ]);
  assert.deepEqual(tree[1].children.map(node => node.kind), ['folder', 'file']);
});
