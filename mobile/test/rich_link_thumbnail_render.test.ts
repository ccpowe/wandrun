import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React, { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import ts from 'typescript';
import type { GatewayApi } from '../src/gateway/api.ts';

const loadedPaths: string[] = [];
Object.assign(globalThis, { __thumbnailLoadedPaths: loadedPaths });
const hosts: Record<string, string> = {
  'react-native': `export const ActivityIndicator='ActivityIndicator',FlatList='FlatList',Pressable='Pressable',View='View';
    export const Platform={OS:'web'};
    class Value { constructor(value){this.value=value} setValue(value){this.value=value} }
    export const Animated={Value, View:'AnimatedView', timing:(value,options)=>({start:()=>value.setValue(options.toValue)})};`,
  'expo-image': `export const Image='ExpoImage';`,
  'expo-router': `export const router={push:()=>{}};`,
  '@/components/chat/drawer-horizontal-gesture.tsx': `export const DrawerHorizontalGesture='DrawerHorizontalGesture';`,
  '@/components/ui/text.tsx': `export const Text='Text';`,
  '@/components/rich-message/math.tsx': `export const RichText='Text';`,
  '@/gateway/api.ts': `export class GatewayError extends Error {}`, 
  '@/lib/local-image.ts': `export const loadLocalImage=async(_api,path)=>{
    globalThis.__thumbnailLoadedPaths.push(path);return {uri:'blob:gateway-image',dispose:()=>{}};
  };`,
  '@/lib/i18n.ts': `export const t=x=>x,useTranslation=()=>({t:x=>x});`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
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
// Register native and local-image test hosts before loading the actual media component.
const { LinkThumbnail } = await import('../src/components/rich-message/media.tsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const location = { conversationId: 'conversation', messageSeq: 9, block: 1, element: 'link-image', index: 0 };
test('decoded link thumbnails fade over their fallback and restore it on image failure', async () => {
  const api = {
    config: { computerId: 'computer' }, signal: new AbortController().signal,
    getMessageMedia: async () => ({ width: 64, height: 64, mime: 'image/png' }),
    mediaContentPath: (...args: unknown[]) => `/conversations/${args[0]}/messages/${args[1]}/media/${args[2]}/${args[3]}/${args[4]}/content`,
  } as unknown as GatewayApi;
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(LinkThumbnail, { api, location, letter: 'E', color: '#526477' })); });
    assert.ok(root.container.queryAll(node => node.type === 'Text' && node.children.includes('E')).length);
    const image = root.container.queryAll(node => node.type === 'ExpoImage')[0];
    const fade = root.container.queryAll(node => node.type === 'AnimatedView')[0];
    assert.equal(fade.props.style.opacity.value, 0);
    await act(async () => { image.props.onLoad(); });
    assert.equal(fade.props.style.opacity.value, 1);
    await act(async () => { image.props.onError(); });
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage').length, 0);
  } finally { await act(async () => root.unmount()); }
});

test('pending or failed metadata retains the source-site mark without downloading image bytes', async () => {
  const metadata = Promise.withResolvers<{ width: number; height: number; mime: string }>();
  const api = { config: { computerId: 'computer' }, signal: new AbortController().signal,
    getMessageMedia: () => metadata.promise, mediaContentPath: () => { throw Error('not reached'); },
  } as unknown as GatewayApi;
  const root = createRoot();
  try {
    const before = loadedPaths.length;
    await act(async () => { root.render(createElement(LinkThumbnail, { api, location, letter: 'E', color: '#526477' })); });
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage').length, 0);
    assert.ok(root.container.queryAll(node => node.type === 'Text' && node.children.includes('E')).length);
    await act(async () => { metadata.reject(new Error('metadata unavailable')); });
    assert.equal(loadedPaths.length, before);
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage').length, 0);
    assert.ok(root.container.queryAll(node => node.type === 'Text' && node.children.includes('E')).length);
  } finally { await act(async () => root.unmount()); }
});

