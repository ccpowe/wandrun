import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { MermaidCache } from '../src/lib/mermaid-cache.ts';
import { MERMAID_OPTIONS, mermaidDocument, mermaidSourceError, parseMermaidEvent } from '../src/lib/mermaid-document.ts';
import type { MermaidInput, MermaidTheme, MermaidViewport } from '../src/lib/mermaid-document.ts';
import { prepareMermaidPage as prepareWebMermaidPage } from '../src/components/rich-message/mermaid-page.web.ts';

const theme: MermaidTheme = {
  background: '#ffffff', foreground: '#111111', muted: '#777777', surface: '#eeeeee',
  surfaceAlt: '#dddddd', border: '#cccccc', line: '#333333', accent: '#3377cc', error: '#cc3333',
};
const input: MermaidInput = { source: 'flowchart LR\n A --> B', width: 320, full: false, day: '2026-10-17' };
const svg = '<svg class="pele"></svg>';
const result = { svg, width: 200, height: 500 };
const resources = { pele: 'file:///cache/pele.js', renderer: 'file:///cache/renderer.js' };
const viewport: MermaidViewport = { zoom: 2, cx: 100, cy: 200, width: 320, height: 320 };

test('bridge accepts only bounded SVG and finite geometry; errors expose codes rather than source text', () => {
  assert.deepEqual(parseMermaidEvent(JSON.stringify({ kind: 'render', ...result, displayHeight: 330 })),
    { kind: 'render', ...result, displayHeight: 330 });
  for (const bad of [
    '{', JSON.stringify({ kind: 'render', ...result, width: 0, displayHeight: 330 }),
    JSON.stringify({ kind: 'render', ...result, height: '500', displayHeight: 330 }),
    JSON.stringify({ kind: 'render', ...result, displayHeight: NaN }),
    JSON.stringify({ kind: 'render', ...result, displayHeight: 100001 }),
    JSON.stringify({ kind: 'render', svg: '<svg>' + 'x'.repeat(1_000_001), width: 1, height: 1, displayHeight: 1 }),
    JSON.stringify({ kind: 'render', svg: '<img>', width: 1, height: 1, displayHeight: 1 }),
    JSON.stringify({ kind: 'error', code: 'syntax: ' + input.source }),
  ]) assert.equal(parseMermaidEvent(bad), null);
  assert.deepEqual(parseMermaidEvent(JSON.stringify({ kind: 'error', code: 'syntax', message: input.source })),
    { kind: 'error', code: 'syntax' });
  assert.deepEqual(parseMermaidEvent('{"kind":"error","code":"untrusted"}'), { kind: 'error', code: 'render' });
});

test('viewport reports contain only bounded geometry, independent of the cached SVG', () => {
  assert.deepEqual(parseMermaidEvent(JSON.stringify({ kind: 'viewport', viewport })),
    { kind: 'viewport', viewport });
  for (const bad of [
    { ...viewport, zoom: 0 }, { ...viewport, zoom: 32.01 }, { ...viewport, cx: Infinity },
    { ...viewport, cy: 1_000_001 }, { ...viewport, width: 0 }, { ...viewport, height: NaN },
  ]) assert.equal(parseMermaidEvent(JSON.stringify({ kind: 'viewport', viewport: bad })), null);
  assert.equal(parseMermaidEvent(JSON.stringify({ kind: 'viewport', viewport, svg })), null);
  assert.equal(parseMermaidEvent(JSON.stringify({ kind: 'viewport', viewport: { ...viewport, svg } })), null);
  assert.equal(parseMermaidEvent(JSON.stringify({ kind: 'viewport', viewport, extra: 'x'.repeat(513) })), null);
});

test('page keeps source and cached SVG inert, uses per-page nonce and only fixed scripts', () => {
  const malicious = { ...input, source: 'flowchart LR\n A["</script><script>alert(1)</script>\u2028"] --> B' };
  const first = mermaidDocument(malicious, theme, resources, result, viewport);
  const second = mermaidDocument(input, theme, resources);
  assert.match(first, /\\u003c\/script\\u003e/);
  assert.match(first, /\\u2028/);
  assert.ok(!first.includes('</script><script>alert(1)'));
  assert.match(first, /connect-src 'none'; img-src 'none'; font-src 'none'/);
  assert.match(first, /frame-src 'none'; child-src 'none'; worker-src 'none'/);
  assert.doesNotMatch(first, /script-src [^;]*file:/);
  assert.notEqual(first.match(/script-src 'nonce-([^']+)'/)?.[1], second.match(/script-src 'nonce-([^']+)'/)?.[1]);
  assert.match(first, /\"code\":\"resource\"/);
  assert.match(first, /\\u003csvg class=/);
  assert.match(first, /"viewport":\{"zoom":2,"cx":100,"cy":200,"width":320,"height":320\}/);
  assert.match(MERMAID_OPTIONS, /autoDirection=false/);
  assert.doesNotMatch(first, /"labels":/);
  assert.match(mermaidDocument(input, theme, resources, result, { ...viewport, zoom: 33 }), /"viewport":null/);
});

test('web page resolves fixed local public assets without importing the native bundle', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://app.example' } } });
  try {
    const page = await prepareWebMermaidPage(input, theme, 'computer-a', result, viewport);
    assert.ok('html' in page.source);
    assert.match(page.source.html, /src="https:\/\/app\.example\/pele\/pele-1\.6\.0\.js"/);
    assert.match(page.source.html, /src="https:\/\/app\.example\/pele\/mermaid-renderer-1\.6\.0\.js"/);
    assert.match(page.source.html, /"viewport":\{"zoom":2,"cx":100,"cy":200,"width":320,"height":320\}/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});


test('source policy rejects options overrides, URL loaders, and complexity before Pele', () => {
  for (const source of ['---\nconfig:\n---\nflowchart LR\n A-->B', '%%{init:{}}%%\nflowchart LR',
    'flowchart LR\n click A https://example.com', 'flowchart LR\n A[ftp://example.com]']) {
    assert.equal(mermaidSourceError(source), 'source');
  }
  assert.equal(mermaidSourceError('x'.repeat(10_001)), 'limit');
  assert.equal(mermaidSourceError('flowchart LR\n A --> B'), undefined);
});

test('a late SVG from the previous UTC day cannot populate or overwrite the next day cache', () => {
  const cache = new MermaidCache();
  const previousDay = { ...input, day: '2026-10-16' };
  const nextDay = { ...input, day: '2026-10-17' };
  cache.put(previousDay, 'a', result);
  assert.equal(cache.get(nextDay, 'a'), undefined);
  const current = { ...result, svg: '<svg><text>current day</text></svg>' };
  cache.put(nextDay, 'a', current);
  cache.put(previousDay, 'a', result);
  assert.deepEqual(cache.get(nextDay, 'a'), current);
});

test('cache partitions scope/width/full and evicts LRU by entry count and UTF-16 bytes', () => {
  const cache = new MermaidCache();
  cache.put(input, 'a', result);
  assert.deepEqual(cache.get(input, 'a'), result);
  assert.equal(cache.get(input, 'b'), undefined);
  assert.equal(cache.get({ ...input, width: 319 }, 'a'), undefined);
  assert.equal(cache.get({ ...input, full: true }, 'a'), undefined);
  for (let i = 0; i < 16; i++) cache.put({ ...input, source: `flowchart LR\n A --> B${i}` }, 'a', result);
  assert.equal(cache.get(input, 'a'), undefined);
  assert.ok(cache.get({ ...input, source: 'flowchart LR\n A --> B15' }, 'a'));
  const recentlyUsed = { ...input, source: 'flowchart LR\n A --> B0' };
  assert.ok(cache.get(recentlyUsed, 'a'));
  cache.put({ ...input, source: 'flowchart LR\n A --> B16' }, 'a', result);
  assert.ok(cache.get(recentlyUsed, 'a'));
  assert.equal(cache.get({ ...input, source: 'flowchart LR\n A --> B1' }, 'a'), undefined);
  const large = '<svg>' + 'x'.repeat(900_000) + '</svg>';
  const memory = new MermaidCache();
  for (let i = 0; i < 3; i++) memory.put({ ...input, source: `flowchart LR\n A --> B${i}` }, 'a', { ...result, svg: large });
  assert.equal(memory.get({ ...input, source: 'flowchart LR\n A --> B0' }, 'a'), undefined);
  assert.ok(memory.get({ ...input, source: 'flowchart LR\n A --> B2' }, 'a'));
  memory.put(input, 'a', { ...result, svg: '<svg>' + 'x'.repeat(1_000_001) + '</svg>' });
  assert.equal(memory.get(input, 'a'), undefined);
});

const cacheDir = mkdtempSync(join(tmpdir(), 'mermaid-resources-'));
class DiskPath {
  uri: string;
  constructor(parent: string | DiskPath, name = '') {
    this.uri = pathToFileURL(join(fileURLToPath(typeof parent === 'string' ? parent : parent.uri), name)).href;
  }
  get exists() { return existsSync(new URL(this.uri)); }
  delete() { rmSync(new URL(this.uri), { recursive: true }); }
}
class DiskFile extends DiskPath {
  async move(destination: DiskFile) { renameSync(new URL(this.uri), new URL(destination.uri)); this.uri = destination.uri; }
}
class DiskDirectory extends DiskPath {
  create(options?: { idempotent?: boolean }) { mkdirSync(new URL(this.uri), { recursive: options?.idempotent }); }
}
let beforeWrite: ((uri: string) => Promise<void>) | undefined;
const filesystem = {
  File: DiskFile, Directory: DiskDirectory, Paths: { cache: pathToFileURL(cacheDir).href },
  async writeAsStringAsync(uri: string, content: string) {
    await beforeWrite?.(uri);
    writeFileSync(new URL(uri), content);
  },
};
declare global { var __mermaidFilesystem: typeof filesystem; }
globalThis.__mermaidFilesystem = filesystem;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'expo-file-system') return { url: `data:text/javascript,${encodeURIComponent('export const {File,Directory,Paths}=globalThis.__mermaidFilesystem;')}`, shortCircuit: true };
  if (specifier === 'expo-file-system/legacy') return { url: `data:text/javascript,${encodeURIComponent('export const {writeAsStringAsync}=globalThis.__mermaidFilesystem;')}`, shortCircuit: true };
  return nextResolve(specifier, context);
} });
after(() => rmSync(cacheDir, { recursive: true, force: true }));
// The Expo filesystem host must be registered before loading the native module.
const { prepareMermaidPage } = await import('../src/components/rich-message/mermaid-page.ts');

test('native publication shares scripts within a scoped directory, publishes pages atomically, disposes only its page', async () => {
  // The registered host uses real files so the page URI can be read by a consumer.
  const pages = await Promise.all([prepareMermaidPage(input, theme, 'a', result, viewport), prepareMermaidPage(input, theme, 'a'), prepareMermaidPage(input, theme, 'b')]);
  try {
    const html = pages.map(page => 'uri' in page.source ? readFileSync(new URL(page.source.uri), 'utf8') : '');
    const scripts = html.map(doc => [...doc.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]));
    assert.deepEqual(scripts[0], scripts[1]);
    assert.match(html[0], /"viewport":\{"zoom":2,"cx":100,"cy":200,"width":320,"height":320\}/);
    assert.notDeepEqual(scripts[0], scripts[2]);
    assert.ok(pages[0].readAccessUrl && pages[0].readAccessUrl !== pages[2].readAccessUrl);
    assert.ok('uri' in pages[0].source && pages[0].source.uri.startsWith(pages[0].readAccessUrl!));
    assert.ok(html.every(doc => doc.length < 5000));
    assert.match(readFileSync(new URL(scripts[0][0]), 'utf8'), /MIT License/);
    pages[0].dispose?.();
    assert.ok('uri' in pages[0].source && !existsSync(new URL(pages[0].source.uri)));
    assert.ok('uri' in pages[1].source && existsSync(new URL(pages[1].source.uri)));
  } finally { pages.forEach(page => page.dispose?.()); }
  assert.deepEqual(readdirSync(join(cacheDir, 'wandrun-pele-1.6.0', 'computer-a')).sort(), ['mermaid-renderer.js', 'pele.js']);
});

test('interrupted page writes leave no published or temporary page', async () => {
  const initial = await prepareMermaidPage(input, theme, 'a');
  initial.dispose?.();
  beforeWrite = async uri => { if (uri.endsWith('.html.tmp')) throw new Error('disk full'); };
  try { await assert.rejects(prepareMermaidPage(input, theme, 'a'), /disk full/); }
  finally { beforeWrite = undefined; }
  assert.deepEqual(readdirSync(join(cacheDir, 'wandrun-pele-1.6.0', 'computer-a')).sort(), ['mermaid-renderer.js', 'pele.js']);
});

test('page is invisible until its temporary write completes and late caller disposal removes it', async () => {
  const first = await prepareMermaidPage(input, theme, 'a');
  first.dispose?.();
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeWrite = async uri => {
    if (!uri.endsWith('.html.tmp')) return;
    writeFileSync(new URL(uri), 'partial');
    writing.resolve();
    await release.promise;
  };
  const pending = prepareMermaidPage(input, theme, 'a');
  try {
    await writing.promise;
    const entries = readdirSync(join(cacheDir, 'wandrun-pele-1.6.0', 'computer-a'));
    assert.ok(entries.some(name => name.endsWith('.html.tmp')));
    assert.ok(!entries.some(name => name.endsWith('.html')));
    release.resolve();
    const page = await pending;
    assert.ok('uri' in page.source && readFileSync(new URL(page.source.uri), 'utf8').startsWith('<!doctype html>'));
    page.dispose?.();
    assert.ok('uri' in page.source && !existsSync(new URL(page.source.uri)));
  } finally {
    beforeWrite = undefined;
    release.resolve();
    (await pending).dispose?.();
  }
});

test('evicted shared script is published by rename; a previous reader never sees a partial rewrite', async () => {
  // Force an eviction of the already-published, shared bundle.
  const first = await prepareMermaidPage(input, theme, 'a');
  const script = pathToFileURL(join(cacheDir, 'wandrun-pele-1.6.0', 'computer-a', 'pele.js'));
  const old = readFileSync(script, 'utf8');
  const reader = openSync(script, 'r');
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  rmSync(script);
  beforeWrite = async uri => {
    if (!uri.endsWith('pele.js.tmp')) return;
    writeFileSync(new URL(uri), 'partial');
    writing.resolve();
    await release.promise;
  };
  const second = prepareMermaidPage(input, theme, 'a');
  try {
    await writing.promise;
    assert.ok(!existsSync(script));
    assert.equal(readFileSync(reader, 'utf8'), old);
    assert.ok('uri' in first.source && existsSync(new URL(first.source.uri)));
    release.resolve();
    (await second).dispose?.();
    assert.equal(readFileSync(script, 'utf8'), old);
  } finally {
    beforeWrite = undefined;
    release.resolve();
    closeSync(reader);
    first.dispose?.();
    (await second).dispose?.();
  }
});
