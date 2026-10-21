import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React, { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import type { Root } from 'test-renderer';
import type { GatewayApi } from '../src/gateway/api.ts';
import { richGeometry, richRadius, richSpace } from '../src/components/rich-message/tokens.ts';
import ts from 'typescript';

const navigation: unknown[] = [];
Object.assign(globalThis, { __galleryReact: React, __galleryNavigation: navigation, __galleryPlatform: 'android', __DEV__: true, IS_REACT_ACT_ENVIRONMENT: true });
const hosts: Record<string, string> = {
  'react-native': `const React=globalThis.__galleryReact;
    export const View='View', Pressable='Pressable', ActivityIndicator='ActivityIndicator';
    export const Platform={get OS(){return globalThis.__galleryPlatform}};
    export function FlatList({data,renderItem,ItemSeparatorComponent,ref,...props}) {
      React.useImperativeHandle(ref,()=>({scrollToIndex:({index})=>{globalThis.__galleryScrolls.push(index)}}));
      return React.createElement('FlatList',props,data.flatMap((item,index)=>[
        ...(index && ItemSeparatorComponent ? [React.createElement(ItemSeparatorComponent,{key:'separator-'+index})] : []),
        React.createElement(React.Fragment,{key:index},renderItem({item,index}))]));
    }`,
  'expo-image': "export const Image='Image';",
  'expo-router': 'export const router={push:route=>globalThis.__galleryNavigation.push(route)};',
  '@/components/ui/text.tsx': "export const Text='Text';",
  '@/components/rich-message/math.tsx': "export const RichText='RichText';",
  '@/gateway/api.ts': 'export class GatewayError extends Error {}',
  '@/lib/local-image.ts': 'export const loadLocalImage=async()=>({uri:"file:///image.png",dispose:()=>{}});',
  '@/lib/i18n.ts': 'export const t=value=>value; export const useTranslation=()=>({t:value=>value});',
};
Object.assign(globalThis, { __galleryScrolls: [] as number[] });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(hosts, specifier)) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
// Import after host registration so this test exercises the native component against platform hosts.
const { MediaGallery, MediaPicture } = await import('../src/components/rich-message/media.tsx');
const byId = (root: Root, id: string) => root.container.queryAll(node => node.props.testID === id);
const items = ['一', '二', '三', '四'].map((alt, index) => ({ alt, caption: `说明${index + 1}`, attachment: `image-${index}` }));
const measuredWidth = 318;
const contentWidth = measuredWidth - 2 * richSpace.sm - 2; // The gallery's two borders and horizontal padding.
async function gallery(count: number) {
  const root = createRoot();
  await act(async () => { root.render(createElement(MediaGallery, {
    items: items.slice(0, count), api: { config: { computerId: 'test' }, signal: { aborted: false } } as unknown as GatewayApi,
    locate: (index: number) => ({ conversationId: 'conversation', messageSeq: 7, block: 0, element: 'gallery', index }),
    fileFor: (item: { attachment?: string }) => item.attachment,
  })); });
  await act(async () => { byId(root, 'rich-gallery')[0].props.onLayout({ nativeEvent: { layout: { width: measuredWidth } } }); });
  return root;
}

test('two images occupy equal halves without carousel controls', async () => {
  const root = await gallery(2);
  try {
    assert.equal(root.container.queryAll(node => node.type === 'FlatList').length, 0);
    assert.equal(byId(root, 'media-image').length, 2);
    const widths = byId(root, 'media-image').map(node => node.parent?.props.style.width);
    assert.deepEqual(widths, [(contentWidth - richSpace.sm) / 2, (contentWidth - richSpace.sm) / 2]);
    assert.deepEqual(root.container.queryAll(node => node.type === 'RichText').map(node => node.props.children), ['说明1', '说明2']);
    assert.equal(root.container.queryAll(node => node.props.accessibilityLabel === '下一张图片').length, 0);
  } finally { await act(async () => { root.unmount(); }); }
});

test('a single gallery image fills the content width', async () => {
  const root = await gallery(1);
  try {
    assert.equal(byId(root, 'media-image')[0].parent?.props.style.width, contentWidth);
    assert.equal(byId(root, 'media-image')[0].props.style.borderRadius, richRadius.small);
  } finally { await act(async () => { root.unmount(); }); }
});

test('single-picture radius override remains available to embedding callers', async () => {
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MediaPicture, { alt: '封面', radius: richRadius.large })); });
    assert.equal(byId(root, 'media-image')[0].props.style.borderRadius, richRadius.large);
  } finally { await act(async () => { root.unmount(); }); }
});

test('three or more images reveal next tile, snap by tile and retain original-image route', async () => {
  const scrolls = (globalThis as typeof globalThis & { __galleryScrolls: number[] }).__galleryScrolls;
  scrolls.length = 0;
  const root = await gallery(4);
  try {
    const list = root.container.queryAll(node => node.type === 'FlatList')[0];
    const interval = Math.round(contentWidth * 0.46) + richSpace.sm;
    assert.equal(scrolls.length, 0, 'the native list must initially remain at offset zero');
    assert.equal(list.props.horizontal, true);
    assert.equal(list.props.pagingEnabled, undefined);
    assert.equal(list.props.snapToInterval, interval);
    assert.equal(byId(root, 'media-image')[0].parent?.props.style.width, interval - richSpace.sm);
    assert.equal(list.props.style.height, richGeometry.galleryHeight);
    assert.ok(2 * interval < contentWidth && contentWidth < 3 * interval, 'two full tiles and a peek remain visible');
    assert.equal(list.props.contentContainerStyle.paddingRight, contentWidth - (interval - richSpace.sm));
    assert.equal(byId(root, 'media-image').length, 4);
    await act(async () => { list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 2 * interval } } }); });
    assert.equal(byId(root, 'rich-gallery-caption')[0].props.children, '说明3');
    assert.equal(scrolls.length, 0, 'observing a swipe must not command another scroll');
    await act(async () => { root.container.queryAll(node => node.props.accessibilityLabel === '下一张图片')[0].props.onPress(); });
    assert.deepEqual(scrolls, [3]);
    assert.equal(byId(root, 'rich-gallery-caption')[0].props.children, '说明4');
    await act(async () => { byId(root, 'rich-gallery')[0].props.onLayout({ nativeEvent: { layout: { width: measuredWidth + 80 } } }); });
    assert.deepEqual(scrolls, [3, 3], 'resizing retains the selected image');
    await act(async () => { byId(root, 'media-image-open')[0].props.onPress(); });
    assert.deepEqual(navigation.at(-1), { pathname: '/media-viewer', params: {
      id: 'conversation', seq: '7', block: '0', element: 'gallery', index: '0', alt: '一',
    } });
  } finally { await act(async () => { root.unmount(); }); }
});

test('web gallery observes physical scroll independently of navigation and applies snap to the scrolling surface and cells', async () => {
  const platform = globalThis as typeof globalThis & { __galleryPlatform: string; __galleryScrolls: number[] };
  platform.__galleryPlatform = 'web';
  platform.__galleryScrolls.length = 0;
  const root = await gallery(4);
  try {
    const list = root.container.queryAll(node => node.type === 'FlatList')[0];
    const interval = list.props.snapToInterval;
    assert.equal(list.props.style.scrollSnapType, 'x mandatory');
    assert.deepEqual(byId(root, 'media-image').map(node => node.parent?.props.style.scrollSnapAlign),
      ['start', 'start', 'start', 'start']);
    assert.equal(list.props.contentContainerStyle.paddingRight + (interval - richSpace.sm), contentWidth,
      'last tile can reach the start snap position');
    assert.equal(list.props.getItemLayout(null, 3).offset,
      4 * (interval - richSpace.sm) + 3 * richSpace.sm + list.props.contentContainerStyle.paddingRight - contentWidth,
      'the last tile start is the maximum scroll offset');
    assert.equal(platform.__galleryScrolls.length, 0);
    await act(async () => { list.props.onScroll({ nativeEvent: { contentOffset: { x: interval * 1.2 } } }); });
    assert.equal(byId(root, 'rich-gallery-caption')[0].props.children, '说明2');
    assert.equal(platform.__galleryScrolls.length, 0, 'scroll observation cannot reset an in-progress swipe');
    await act(async () => { list.props.onScroll({ nativeEvent: { contentOffset: { x: interval * 3 } } }); });
    assert.equal(byId(root, 'rich-gallery-caption')[0].props.children, '说明4');
    assert.equal(platform.__galleryScrolls.length, 0);
    await act(async () => { byId(root, 'rich-gallery')[0].props.onLayout({ nativeEvent: { layout: { width: measuredWidth + 50 } } }); });
    assert.deepEqual(platform.__galleryScrolls, [3], 'web resize keeps the physically selected tile');
    assert.equal(byId(root, 'rich-gallery-caption')[0].props.children, '说明4');
    await act(async () => { root.container.queryAll(node => node.props.accessibilityLabel === '上一张图片')[0].props.onPress(); });
    assert.deepEqual(platform.__galleryScrolls, [3, 2]);
    assert.equal(byId(root, 'rich-gallery-caption')[0].props.children, '说明3');
  } finally {
    await act(async () => { root.unmount(); });
    platform.__galleryPlatform = 'android';
  }
});
