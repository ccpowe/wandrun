import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'test-renderer';
import ts from 'typescript';
import { parseRichSpec } from '../src/components/rich-message/spec.ts';
const copied: string[] = [];
Object.assign(globalThis, { __richTreeReact: React, __richTreeCopied: copied });
const hosts: Record<string, string> = {
  'react-native': `export const View='View', Pressable='Pressable'; export const Platform={OS:'web'};
    export const AccessibilityInfo={announceForAccessibility:()=>{}}; export const Alert={alert:()=>{}};`,
  'expo-clipboard': `export const setStringAsync=async path=>{globalThis.__richTreeCopied.push(path);return true;};`,
  'lucide-react-native': `export const ChevronDown='ChevronDown', ChevronRight='ChevronRight', File='File', FileCode2='FileCode2', Folder='Folder', FolderOpen='FolderOpen', FolderTree='FolderTree';`,
  '@/components/ui/icon.tsx': `export const Icon='Icon';`,
  '@/components/ui/text.tsx': `export const Text='Text';`,
  '@/lib/i18n.ts': `export const useTranslation=()=>({t:(message,values)=>message.replace('{count}',String(values?.count??''))});`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        fileName: 'component.tsx', compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    return nextLoad(url, context);
  },
});
// The native module hosts must be registered before importing the RN component under test.
const { FileTreeDisplay } = await import('../src/components/rich-message/file-tree.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const byId = (root: Root, id: string) => root.container.queryAll(node => node.props.testID === id)[0];

test('folder toggle and global action preserve explicit collapse and file long press copies full path', async () => {
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(FileTreeDisplay, { props: { nodes: [
      { path: 'src/deep/main.ts', note: 'entry' }, { path: 'src/', collapsed: true },
      { path: 'README.md' },
    ] } })); });
    assert.ok(byId(root, 'rich-tree-src'));
    assert.equal(byId(root, 'rich-tree-src/deep/main.ts'), undefined);
    await act(async () => { byId(root, 'rich-tree-src').props.onPress(); });
    assert.ok(byId(root, 'rich-tree-src/deep/main.ts'));
    assert.equal(byId(root, 'rich-tree-toggle-all').props.accessibilityLabel, '全部折叠');
    await act(async () => { byId(root, 'rich-tree-toggle-all').props.onPress(); });
    assert.equal(byId(root, 'rich-tree-src/deep/main.ts'), undefined);
    assert.equal(byId(root, 'rich-tree-toggle-all').props.accessibilityLabel, '全部展开');
    await act(async () => { byId(root, 'rich-tree-toggle-all').props.onPress(); });
    await act(async () => { byId(root, 'rich-tree-src/deep/main.ts').props.onLongPress(); });
    assert.deepEqual(copied, ['src/deep/main.ts']);
  } finally { await act(async () => root.unmount()); }
});
test('completed tree size controls deep default expansion and explicit overrides win', async () => {
  const root = createRoot();
  try {
    const nodes = [
      ...Array.from({ length: 25 }, (_, index) => ({ path: `src/features/f${index}/index.ts` })),
      { path: 'src/features/f1/', collapsed: false },
    ];
    await act(async () => { root.render(createElement(FileTreeDisplay, { props: { nodes } })); });
    assert.ok(byId(root, 'rich-tree-src/features/f0'));
    assert.equal(byId(root, 'rich-tree-src/features/f0/index.ts'), undefined);
    assert.ok(byId(root, 'rich-tree-src/features/f1/index.ts'));
    await act(async () => { byId(root, 'rich-tree-src/features/f0').props.onPress(); });
    assert.ok(byId(root, 'rich-tree-src/features/f0/index.ts'));
  } finally { await act(async () => root.unmount()); }
});

for (const path of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
  for (const explicit of [false, true]) {
    test(`legal ${path} folder supports default/explicit expansion and all toggles (${explicit})`, async () => {
      const parsed = parseRichSpec(JSON.stringify({
        root: 'tree', elements: { tree: { type: 'FileTree', children: [], props: { nodes: [
          { path: `${path}/a.ts` }, ...(explicit ? [{ path, collapsed: false }] : []),
        ] } } }, state: {},
      }));
      assert.ok(parsed, 'legal paths must survive protocol validation');
      const root = createRoot();
      try {
        await act(async () => root.render(createElement(FileTreeDisplay, { props: parsed.elements.tree.props as {
          nodes: { path: string; collapsed?: boolean }[];
        } })));
        const child = () => byId(root, `rich-tree-${path}/a.ts`);
        const toggleAll = () => byId(root, 'rich-tree-toggle-all');
        assert.ok(child(), 'small tree starts expanded');
        assert.equal(toggleAll().props.accessibilityLabel, '全部折叠');
        await act(async () => byId(root, `rich-tree-${path}`).props.onPress());
        assert.equal(child(), undefined);
        await act(async () => byId(root, `rich-tree-${path}`).props.onPress());
        assert.ok(child(), 'individual expansion restores child');
        await act(async () => toggleAll().props.onPress());
        assert.equal(child(), undefined);
        assert.equal(toggleAll().props.accessibilityLabel, '全部展开');
        await act(async () => toggleAll().props.onPress());
        assert.ok(child(), 'global expansion restores child');
      } finally { await act(async () => root.unmount()); }
    });
  }
}
