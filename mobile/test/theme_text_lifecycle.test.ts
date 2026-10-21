import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { act, createElement, useEffect, useState } from 'react';
import { createRoot } from 'test-renderer';
import ts from 'typescript';

// Real Text, Slot and React reconciliation. Native hosts/theme notifications are
// substituted: these tests protect descendant state, not glyph layout or IME.
const themeState = { theme: 'light', listeners: new Set<() => void>() };
Object.assign(globalThis, { __uiThemeTest: themeState, IS_REACT_ACT_ENVIRONMENT: true });
const hosts: Record<string, string> = {
  'react-native': `export const Text='NativeText';
    export const Platform={OS:'android', select:x=>x.android ?? x.native ?? x.default};`,
  'uniwind': `import {useSyncExternalStore} from ${JSON.stringify(import.meta.resolve('react'))};
    const s=globalThis.__uiThemeTest;
    const subscribe=f=>{s.listeners.add(f);return ()=>s.listeners.delete(f)};
    export const useUniwind=()=>({theme:useSyncExternalStore(subscribe,()=>s.theme)});`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      return nextResolve(existsSync(fileURLToPath(url) + '.ts') ? url.href + '.ts' : url.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx') || url.endsWith('/@rn-primitives/slot/dist/index.mjs')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        fileName: 'component.tsx',
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});
// Native loader hooks must register before Text and its theme dependency load.
const { Text } = await import('../src/components/ui/text.tsx');
const { useUniwind } = await import('uniwind');

for (const asChild of [false, true]) {
  test(`Android theme changes preserve stateful ${asChild ? 'slotted' : 'nested'} text descendants`, async () => {
    themeState.theme = 'light';
    let mounts = 0;
    let unmounts = 0;
    function ExpandableText(props: Record<string, unknown>) {
      const [expanded, setExpanded] = useState(false);
      useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
      return createElement('NativeText', { ...props, testID: 'expandable', onPress: () => setExpanded(true) },
        expanded ? 'Expanded details' : 'Show details');
    }
    function Screen() {
      const { theme } = useUniwind();
      return createElement(Text, { asChild, style: { color: theme === 'dark' ? '#eee' : '#111' } },
        createElement(ExpandableText));
    }
    const root = createRoot();
    try {
      await act(async () => { root.render(createElement(Screen)); });
      const child = root.container.queryAll(node => node.props.testID === 'expandable')[0];
      await act(async () => { (child.props.onPress as () => void)(); });
      for (const theme of ['dark', 'light', 'dark']) {
        await act(async () => {
          themeState.theme = theme;
          for (const listener of themeState.listeners) listener();
        });
        const nextChild = root.container.queryAll(node => node.props.testID === 'expandable')[0];
        assert.equal(nextChild, child);
        assert.equal(nextChild.props.children, 'Expanded details');
        assert.equal(mounts, 1);
        assert.equal(unmounts, 0);
      }
    } finally {
      await act(async () => { root.unmount(); });
    }
    assert.equal(unmounts, 1);
  });
}
