import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'test-renderer';
import ts from 'typescript';
import type { GatewayApi as GatewayApiType } from '../src/gateway/api.ts';

type Lease = { uri: string; dispose(): void };
let originalLoad: (id: string) => Promise<Lease>;
let thumbnailLoad: (path: string) => Promise<Lease>;
const hosts: Record<string, string> = {
  'react-native': `export const View='View', Pressable='Pressable', ActivityIndicator='ActivityIndicator';
    export const PixelRatio={get:()=>1};`,
  'expo-image': `export function Image(props) { return globalThis.__attachmentReact.createElement('ExpoImage',props); }`,
  'expo-router': `export const router={push:()=>{}};`,
  'lucide-react-native': `export const ChevronRight='ChevronRight';`,
  '@/components/file-type-icon.tsx': `export const FileTypeIcon='FileTypeIcon';`,
  '@/components/ui/icon.tsx': `export const Icon='Icon';`,
  '@/components/ui/text.tsx': `export const Text='Text';`,
  '@/lib/local-image.ts': `export const loadLocalImage=(_api,path)=>path.includes('/thumbnail?')?globalThis.__attachmentThumbnailLoad(path):globalThis.__attachmentOriginalLoad(path);`,
};
Object.assign(globalThis, {
  __attachmentReact: React, __attachmentOriginalLoad: (path: string) => originalLoad(path),
  __attachmentThumbnailLoad: (path: string) => thumbnailLoad(path),
  __DEV__: false, IS_REACT_ACT_ENVIRONMENT: true,
});
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier === '../lib/local-image.ts') return { url: `data:text/javascript,${encodeURIComponent(hosts['@/lib/local-image.ts'])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      fileName: 'attachment-media.tsx', compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
const { ThumbnailImage, PdfCard } = await import('../src/components/chat/attachment-media.tsx');
const { GatewayApi } = await import('../src/gateway/api.ts');
const { applyLanguage } = await import('../src/lib/locale-store.ts');
const file = (id: string) => ({ id, name: `${id}.png`, size: 42, media_type: 'image/png' });
const api = (computerId: string, load: (id: string) => Promise<Lease>) => ({
  config: { computerId }, signal: new AbortController().signal,
  loadFileThumbnail: (id: string) => load(id),
}) as unknown as GatewayApiType;
const cachedApi = () => new GatewayApi({ baseUrl: 'https://images.test', token: 'test', computerId: 'computer-a' });
const render = (root: Root, gateway: GatewayApiType, id = 'one') => createElement(ThumbnailImage, {
  file: file(id), api: gateway, width: 120, height: 90, onOpen: () => {},
});
const image = (root: Root) => root.container.queryAll(node => node.type === 'ExpoImage')[0];
const failure = (root: Root) => root.container.queryAll(node => node.props.testID === 'attachment-image-error')[0];
const retry = (root: Root) => root.container.queryAll(node => node.props.testID === 'attachment-image-retry')[0];
const lease = (uri: string, dispose: () => void = () => {}): Lease => ({ uri, dispose });
const nextTurn = async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
};

test('thumbnail and original fetch failures show a retry; retry downloads the thumbnail again', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  let originalAttempts = 0;
  let thumbnailAttempts = 0;
  const gateway = cachedApi();
  thumbnailLoad = async () => { if (++thumbnailAttempts === 1) throw new Error('offline'); return lease('thumbnail-ok'); };
  originalLoad = async () => { originalAttempts++; throw new Error('original failed'); };
  try {
    await act(async () => { root.render(render(root, gateway)); });
    assert.ok(failure(root), 'failed content should replace the spinner');
    assert.equal(retry(root)?.props.accessibilityLabel, '重试加载图片');
    assert.equal(root.container.queryAll(node => node.type === 'ActivityIndicator').length, 0);
    await act(async () => { retry(root).props.onPress(); });
    assert.equal(image(root)?.props.source.uri, 'thumbnail-ok');
    assert.equal(originalAttempts, 1);
    assert.equal(thumbnailAttempts, 2);
  } finally { await act(async () => root.unmount()); gateway.close(); }
});

test('thumbnail decoder failure invalidates the cached URI before retry', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const gateway = cachedApi();
  let thumbnailAttempts = 0;
  thumbnailLoad = async () => lease(++thumbnailAttempts === 1 ? 'thumbnail-corrupt' : 'thumbnail-fixed');
  originalLoad = async () => lease('original-corrupt');
  try {
    await act(async () => { root.render(render(root, gateway)); });
    assert.equal(image(root)?.props.source.uri, 'thumbnail-corrupt');
    await act(async () => image(root).props.onError({ error: 'decode' }));
    assert.equal(image(root)?.props.source.uri, 'original-corrupt');
    await act(async () => image(root).props.onError({ error: 'decode' }));
    assert.ok(failure(root));
    await act(async () => retry(root).props.onPress());
    assert.equal(image(root)?.props.source.uri, 'thumbnail-fixed');
    assert.equal(thumbnailAttempts, 2);
  } finally { await act(async () => root.unmount()); gateway.close(); }
});

test('thumbnail cache shares active leases and releases displaced and late downloads', async () => {
  const gateway = cachedApi();
  const downloads: Array<PromiseWithResolvers<Lease>> = [];
  const disposed: string[] = [];
  thumbnailLoad = () => {
    const pending = Promise.withResolvers<Lease>();
    downloads.push(pending);
    return pending.promise;
  };
  try {
    const first = gateway.loadFileThumbnail('same', 240);
    const second = gateway.loadFileThumbnail('same', 240);
    await nextTurn();
    assert.equal(downloads.length, 1);
    downloads[0].resolve(lease('shared', () => disposed.push('shared')));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.uri, b.uri);
    gateway.invalidateFileThumbnail('same', 240);
    assert.equal(disposed.length, 0, 'the prior entry remains alive for active viewers');
    const replacement = gateway.loadFileThumbnail('same', 240);
    await nextTurn();
    assert.equal(downloads.length, 2);
    downloads[1].resolve(lease('replacement', () => disposed.push('replacement')));
    const c = await replacement;
    a.dispose();
    assert.deepEqual(disposed, []);
    b.dispose();
    assert.deepEqual(disposed, ['shared']);
    c.dispose();
    gateway.close();
    assert.deepEqual(disposed, ['shared', 'replacement']);
  } finally { gateway.close(); }
});

test('retry evicts only the requested file and width', async () => {
  const gateway = cachedApi();
  const paths: string[] = [];
  const disposed: string[] = [];
  thumbnailLoad = async (path) => {
    paths.push(path);
    return lease(`${path}#${paths.length}`, () => disposed.push(path));
  };
  try {
    const first = await gateway.loadFileThumbnail('same', 240);
    const otherWidth = await gateway.loadFileThumbnail('same', 480);
    const otherFile = await gateway.loadFileThumbnail('other', 240);
    first.dispose();
    otherWidth.dispose();
    otherFile.dispose();
    gateway.invalidateFileThumbnail('same', 240);
    assert.deepEqual(disposed, ['/files/same/thumbnail?w=240']);
    const retainedWidth = await gateway.loadFileThumbnail('same', 480);
    const retainedFile = await gateway.loadFileThumbnail('other', 240);
    const replaced = await gateway.loadFileThumbnail('same', 240);
    assert.equal(retainedWidth.uri, otherWidth.uri);
    assert.equal(retainedFile.uri, otherFile.uri);
    assert.notEqual(replaced.uri, first.uri);
    assert.deepEqual(paths, ['/files/same/thumbnail?w=240', '/files/same/thumbnail?w=480',
      '/files/other/thumbnail?w=240', '/files/same/thumbnail?w=240']);
    retainedWidth.dispose();
    retainedFile.dispose();
    replaced.dispose();
  } finally { gateway.close(); }
});

test('invalidating an in-flight thumbnail releases its late result without replacing the new entry', async () => {
  const gateway = cachedApi();
  const downloads: Array<PromiseWithResolvers<Lease>> = [];
  const disposed: string[] = [];
  thumbnailLoad = () => {
    const pending = Promise.withResolvers<Lease>();
    downloads.push(pending);
    return pending.promise;
  };
  const abandoned = new AbortController();
  try {
    const old = gateway.loadFileThumbnail('same', 240, abandoned.signal);
    await nextTurn();
    abandoned.abort();
    await assert.rejects(old);
    gateway.invalidateFileThumbnail('same', 240);
    const current = gateway.loadFileThumbnail('same', 240);
    await nextTurn();
    assert.equal(downloads.length, 2);
    downloads[0].resolve(lease('late', () => disposed.push('late')));
    await nextTurn();
    assert.deepEqual(disposed, ['late']);
    downloads[1].resolve(lease('new', () => disposed.push('new')));
    const held = await current;
    assert.equal(held.uri, 'new');
    gateway.close();
    assert.deepEqual(disposed, ['late'], 'close cannot remove a still-leased URI');
    held.dispose();
    assert.deepEqual(disposed, ['late', 'new']);
  } finally { gateway.close(); }
});

test('a closed API never starts an unowned thumbnail download', async () => {
  const gateway = cachedApi();
  let downloads = 0;
  thumbnailLoad = async () => { downloads++; return lease('unowned'); };
  gateway.close();
  await assert.rejects(gateway.loadFileThumbnail('same', 240));
  await nextTurn();
  assert.equal(downloads, 0);
});

test('image and original fallback buttons interpolate the filename in both languages', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const gateway = cachedApi();
  thumbnailLoad = async () => lease('thumbnail-corrupt');
  originalLoad = async () => lease('original-ok');
  try {
    await act(async () => root.render(render(root, gateway)));
    for (const [language, expected] of [['zh', '查看图片 one.png'], ['en', 'View image one.png']] as const) {
      await act(async () => applyLanguage(language));
      const button = root.container.queryAll(node => node.type === 'Pressable')[0];
      assert.equal(button.props.accessibilityLabel, expected);
      assert.doesNotMatch(button.props.accessibilityLabel, /\{(?:name|alt)\}/);
    }
    await act(async () => image(root).props.onError({ error: 'decode' }));
    for (const [language, expected] of [['zh', '查看图片 one.png'], ['en', 'View image one.png']] as const) {
      await act(async () => applyLanguage(language));
      const button = root.container.queryAll(node => node.type === 'Pressable')[0];
      assert.equal(button.props.accessibilityLabel, expected);
      assert.doesNotMatch(button.props.accessibilityLabel, /\{(?:name|alt)\}/);
    }
  } finally { await act(async () => { root.unmount(); applyLanguage('zh'); }); gateway.close(); }
});

test('PDF thumbnail releases a response that arrives after unmount', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const pending = Promise.withResolvers<Lease>();
  let disposed = false;
  const gateway = api('computer-a', () => pending.promise);
  await act(async () => root.render(createElement(PdfCard, {
    file: file('pdf'), api: gateway,
    previewOverrides: { pdf: { kind: 'pdf', width: null, height: null, duration_ms: null, page_count: 1 } },
  })));
  await act(async () => root.unmount());
  await act(async () => pending.resolve(lease('late-pdf', () => { disposed = true; })));
  assert.equal(disposed, true);
});

test('late original responses after identity change or unmount are disposed without painting the next image', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const pending: Array<(value: Lease) => void> = [];
  const disposed: string[] = [];
  const gateway = api('computer-a', async () => { throw new Error('thumbnail failed'); });
  originalLoad = () => {
    const gate = Promise.withResolvers<Lease>();
    pending.push(gate.resolve);
    return gate.promise;
  };
  try {
    await act(async () => root.render(render(root, gateway, 'one')));
    await act(async () => root.render(render(root, gateway, 'two')));
    assert.equal(pending.length, 2);
    await act(async () => pending[0](lease('old', () => disposed.push('old'))));
    assert.equal(image(root), undefined);
    assert.equal(failure(root), undefined);
    await act(async () => pending[1](lease('current', () => disposed.push('current'))));
    assert.equal(image(root)?.props.source.uri, 'current');
    await act(async () => root.unmount());
    assert.deepEqual(disposed, ['old', 'current']);
  } finally { await act(async () => root.unmount()); }
});

test('same file on a new API identity hides old pixels and ignores its late response', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const pending: Array<(value: Lease) => void> = [];
  const disposed: string[] = [];
  originalLoad = () => {
    const gate = Promise.withResolvers<Lease>();
    pending.push(gate.resolve);
    return gate.promise;
  };
  const first = api('computer-a', async () => { throw new Error('thumbnail failed'); });
  const second = api('computer-a', async () => { throw new Error('thumbnail failed'); });
  try {
    await act(async () => root.render(render(root, first)));
    await act(async () => root.render(render(root, second)));
    await act(async () => pending[0](lease('stale', () => disposed.push('stale'))));
    assert.equal(image(root), undefined);
    assert.equal(failure(root), undefined);
    await act(async () => pending[1](lease('fresh', () => disposed.push('fresh'))));
    assert.equal(image(root)?.props.source.uri, 'fresh');
  } finally { await act(async () => root.unmount()); }
  assert.deepEqual(disposed, ['stale', 'fresh']);
});

test('unmount disposes an original image lease that completes late', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const gate = Promise.withResolvers<Lease>();
  let disposed = false;
  originalLoad = () => gate.promise;
  const gateway = api('computer-a', async () => { throw new Error('thumbnail failed'); });
  await act(async () => root.render(render(root, gateway)));
  await act(async () => root.unmount());
  await act(async () => gate.resolve(lease('late', () => { disposed = true; })));
  assert.equal(disposed, true);
});

