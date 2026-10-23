import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React, { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import ts from 'typescript';
import type { GatewayApi } from '../src/gateway/api.ts';

const opened: string[] = [];
Object.assign(globalThis, { __linkReact: React, __linkOpened: opened, __linkPlatform: 'web' });
const hosts: Record<string, string> = {
  'react-native': `export const View='View', Pressable='Pressable'; export const Platform={get OS(){return globalThis.__linkPlatform}};
    export const useWindowDimensions=()=>({fontScale:1});
    export const Linking={openURL:url=>{globalThis.__linkOpened.push(url);}};`,
  'uniwind': `export const useCSSVariable=()=> '#737373';`,
  '@/components/ui/text.tsx': `export const Text='Text';`,
  './media.tsx': `export const LinkThumbnail='LinkThumbnail';`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts && (specifier !== './media.tsx' || context.parentURL?.endsWith('/rich-message/link-card.tsx'))) {
      return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    }
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
// Native host resolution must precede loading this RN component.
const { LinkCardDisplay, groupLinks } = await import('../src/components/rich-message/link-card.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cards = [
  { title: '第一条', url: 'https://www.example.com/one', tags: ['官方'], description: '内容一', image: 'https://cdn.example.com/image.png' },
  { title: '第二条', url: 'https://docs.expo.dev/two', description: '内容二' },
  { title: '第三条', url: 'https://www.example.org/three' },
];
function TestElement({ element }: { element: { type: string; props?: typeof cards[number] } }) {
  return element.type === 'LinkCard' ? createElement(LinkCardDisplay, { props: element.props!,
    api: { config: { computerId: 'c' } } as unknown as GatewayApi,
    location: { conversationId: 'conv', messageSeq: 4, block: 0, element: 'l', index: 0 } })
    : createElement('Text', {}, '间隔文字');
}

test('consecutive links share only internal dividers and preserve intervening child content', async () => {
  const root = createRoot();
  try {
    const elements = [cards[0], cards[1], null, cards[2]].map((item, index) => createElement(TestElement,
      { key: index, element: item ? { type: 'LinkCard', props: item } : { type: 'Text' } }));
    await act(async () => { root.render(createElement('View', {}, groupLinks(elements))); });
    await act(async () => {
      for (const link of root.container.queryAll(node => node.props.testID === 'rich-link-card'))
        link.props.onLayout({ nativeEvent: { layout: { width: 358 } } });
    });
    const lists = root.container.queryAll(node => node.props.testID === 'rich-link-list');
    assert.equal(lists.length, 2);
    const links = root.container.queryAll(node => node.props.testID === 'rich-link-card');
    assert.equal(links.length, 3);
    assert.equal(links[0].props.className, undefined);
    assert.equal(links[1].props.className, 'border-border border-t');
    assert.equal(links[2].props.className, undefined);
    assert.ok(root.container.queryAll(node => node.type === 'Text' && node.children.includes('间隔文字')).length);
    assert.equal(links[0].props.accessibilityLabel, '第一条，www.example.com');
    const titles = root.container.queryAll(node => node.type === 'Text' && node.props.numberOfLines === 3);
    assert.equal(titles.length, 3);
    assert.equal(root.container.queryAll(node => node.type === 'Text' && node.props.numberOfLines === 4).length, 2);
    await act(async () => { links[1].props.onPress(); });
    assert.deepEqual(opened, [cards[1].url]);
  } finally { await act(async () => root.unmount()); }
});

test('Chinese and Latin title endings share one text run with a nonbreaking, non-underlined arrow', async () => {
  const root = createRoot();
  try {
    for (const platform of ['android', 'ios', 'web']) {
      Object.assign(globalThis, { __linkPlatform: platform });
      for (const caption of ['Expo 入门教程', 'React Native 核心组件与 API', 'Expo Notifications']) {
        await act(async () => root.render(createElement(LinkCardDisplay, {
          props: { title: caption, url: 'https://example.org/' },
        })));
        const title = root.container.queryAll(node => node.type === 'Text' && node.props.numberOfLines === 3)[0];
        assert.ok(title.queryAll(node => node.type !== 'Text').length === 0,
          `${platform}: embedded views/icons must not introduce their own baseline`);
        const underlined = title.queryAll(node => node.props.style?.textDecorationLine === 'underline');
        assert.equal(underlined.length, 1);
        assert.deepEqual(underlined[0].children, [caption], 'the complete title, including its last character, stays in one span');
        assert.equal(underlined[0].props.style.textDecorationStyle, platform === 'android' ? 'solid' : 'dotted');
        assert.equal(underlined[0].props.style.textDecorationColor, '#737373');
        assert.ok(title.children.includes('\u2060\u00a0↗\ufe0e'), 'nonbreaking text suffix stays outside the underlined title span');
      }
    }
  } finally {
    Object.assign(globalThis, { __linkPlatform: 'web' });
    await act(async () => root.unmount());
  }
});
