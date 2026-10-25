import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'test-renderer';
import ts from 'typescript';

const fixture = {
  files: new Map<string, { name: string; modified: number }>(),
  transfers: [] as { url: string; uri: string; headers: Record<string, string> }[],
  shares: [] as { uri: string; options: { mimeType: string; dialogTitle: string } }[],
  created: [] as { name: string; mime: string }[],
  picker: Promise.resolve(),
  transfer: Promise.resolve(),
  sharing: Promise.resolve(),
  started: () => {},
  shareStarted: () => {},
  focus: true,
  available: true,
};
Object.assign(globalThis, { __imageFixture: fixture, __imageReact: React, IS_REACT_ACT_ENVIRONMENT: true });
const hosts: Record<string, string> = {
  'expo-file-system': `
    const state = globalThis.__imageFixture;
    export const Paths = { cache: 'file:///cache' };
    export class Directory {
      constructor(...parts) { this.uri = parts.map(part => part.uri ?? part).join('/'); }
      static async pickDirectoryAsync() { await state.picker; return new Directory('content://picked'); }
      create() {}
      list() { return [...state.files.keys()].filter(uri => uri.startsWith(this.uri)).map(uri => new File(uri)); }
      createFile(name, mime) { state.created.push({ name, mime }); const file = new File(this, name); file.create(); return file; }
    }
    export class File {
      constructor(directory, name) { this.uri = name === undefined ? directory : directory.uri + '/' + name; this.name = this.uri.split('/').at(-1); }
      get exists() { return state.files.has(this.uri); }
      get modificationTime() { return state.files.get(this.uri)?.modified ?? null; }
      create() { state.files.set(this.uri, { name: this.name, modified: Date.now() }); }
      write() { this.create(); }
      delete() { state.files.delete(this.uri); }
      async text() { return ''; }
      static createDownloadTask(url, destination, { headers }) {
        state.transfers.push({ url, uri: destination.uri, headers });
        state.started();
        return { async downloadAsync() { await state.transfer; destination.create(); return destination; } };
      }
    }`,
  'expo-sharing': `
    const state = globalThis.__imageFixture;
    export async function isAvailableAsync() { return state.available; }
    export async function shareAsync(uri, options) { state.shares.push({ uri, options }); state.shareStarted(); await state.sharing; }`,
  'expo-router': `export function useIsFocused() { return globalThis.__imageFixture.focus; }`,
  'react-native': `export const View='View', ActivityIndicator='ActivityIndicator', Platform={OS:'android'};`,
  'lucide-react-native': `export const Download='Download', Share2='Share2';`,
  '@/components/rich-message/media.tsx': `export function mediaErrorMessage(error) { return '图片源站或网关暂不可用'; }`,
  '@/components/ui/button.tsx': `export function Button(props) { return globalThis.__imageReact.createElement('Button',props); }`,
  '@/components/ui/icon.tsx': `export const Icon='Icon';`,
  '@/components/ui/text.tsx': `export const Text='Text';`,
};
for (const path of ['rich-message/media.tsx', 'ui/button.tsx', 'ui/icon.tsx', 'ui/text.tsx']) {
  hosts[`./${path}`] = hosts[`@/components/${path}`];
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) {
      const url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      fileName: fileURLToPath(url), compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
// The hooks must be registered before importing the real component/native boundary.
const { GatewayApi } = await import('../src/gateway/api.ts');
const { deliverImage } = await import('../src/lib/image-delivery.ts');
const { ImageActions } = await import('../src/components/image-actions.tsx');
const image = { conversationId: 'conversation/1', messageSeq: 8, block: 'markdown' as const, element: 'image', index: 2 };
const file = { id: 'file/1', name: '真实附件.png', media_type: 'image/png', available: true };
const gateway = (answer: (path: string) => Promise<Response> | Response) => new GatewayApi({ baseUrl: 'https://gateway.test', token: 'secret', computerId: 'computer-a' },
  async (input) => answer(new URL(String(input)).pathname));
function reset() {
  fixture.files.clear(); fixture.transfers.length = 0; fixture.shares.length = 0; fixture.created.length = 0;
  fixture.picker = Promise.resolve(); fixture.transfer = Promise.resolve(); fixture.sharing = Promise.resolve();
  fixture.focus = true; fixture.available = true; fixture.started = () => {}; fixture.shareStarted = () => {};
}
const control = (root: Root, id: string) => root.container.queryAll(node => node.props.testID === id)[0];


test('an image outside the preview whitelist remains downloadable through the visible action', async () => {
  reset();
  const avif = { ...file, name: 'original.avif', media_type: 'image/avif' };
  const api = gateway(() => Response.json(avif));
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => root.render(createElement(ImageActions, { api, source: { fileId: avif.id } })));
    assert.equal(control(root, 'media-download').props.disabled, false);
    await act(async () => { control(root, 'media-download').props.onPress(); });
    assert.equal(fixture.transfers[0].uri, 'content://picked/original.avif');
    assert.ok(control(root, 'media-saved'), 'the original can be saved even if its format cannot be previewed');
    await act(async () => { control(root, 'media-share').props.onPress(); });
    assert.equal(fixture.shares[0].options.mimeType, 'image/avif');
    assert.equal(fixture.shares[0].options.dialogTitle, 'original.avif');
  } finally { await act(async () => root.unmount()); api.close(); }
});

test('remote image sharing uses authenticated message coordinates and retains the original after sheet closes', async () => {
  reset();
  const api = gateway(() => Response.json({ mime: 'image/jpeg', width: 20, height: 10 }));
  try {
    await deliverImage(api, { location: image }, 'share', () => true);
    assert.equal(fixture.transfers[0].url, 'https://gateway.test/conversations/conversation%2F1/messages/8/media/markdown/image/2/content');
    assert.equal(fixture.transfers[0].headers.Authorization, 'Bearer secret');
    assert.equal(fixture.shares[0].uri, fixture.transfers[0].uri);
    assert.equal(fixture.shares[0].options.mimeType, 'image/jpeg');
    assert.ok(fixture.shares[0].options.dialogTitle.endsWith('.jpg'));
    assert.equal(fixture.files.has(fixture.shares[0].uri), true, 'receiver must retain an original, not a released preview');
  } finally { api.close(); }
});

test('once the share sheet receives an image, switching computers keeps its original readable', async () => {
  reset();
  const sheet = Promise.withResolvers<void>();
  const accepted = Promise.withResolvers<void>();
  fixture.sharing = sheet.promise;
  fixture.shareStarted = accepted.resolve;
  const api = gateway(() => Response.json({ mime: 'image/png', width: 20, height: 10 }));
  let current = true;
  try {
    const sharing = deliverImage(api, { location: image }, 'share', () => current);
    await accepted.promise;
    current = false;
    api.close();
    assert.equal(fixture.files.has(fixture.shares[0].uri), true);
    sheet.resolve();
    await sharing;
    assert.equal(fixture.files.has(fixture.shares[0].uri), true);
  } finally { sheet.resolve(); api.close(); }
});

test('an expired image page never hands the late original to native sharing', async () => {
  reset();
  const pending = Promise.withResolvers<void>();
  fixture.transfer = pending.promise;
  const started = Promise.withResolvers<void>();
  fixture.started = started.resolve;
  const api = gateway(() => Response.json({ mime: 'image/png', width: 20, height: 10 }));
  let current = true;
  try {
    const sharing = deliverImage(api, { location: image }, 'share', () => current);
    await started.promise;
    current = false;
    pending.resolve();
    assert.equal(await sharing, false);
    assert.deepEqual(fixture.shares, []);
    assert.equal(fixture.files.has(fixture.transfers[0].uri), false);
  } finally { api.close(); }
});

test('unavailable attachment produces a visible error, duplicate taps do not open a picker, and switching page clears it', async () => {
  reset();
  const api = gateway(() => Response.json({ ...file, available: false }));
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => root.render(createElement(ImageActions, { api, source: { fileId: file.id } })));
    await act(async () => {
      control(root, 'media-download').props.onPress();
      control(root, 'media-share').props.onPress();
    });
    assert.equal(fixture.transfers.length, 0);
    assert.ok(control(root, 'media-action-error'), 'unavailable originals must show an error without opening native delivery');
    await act(async () => root.render(createElement(ImageActions, { api, key: 'another-page', source: { fileId: 'another' } })));
    assert.equal(control(root, 'media-action-error'), undefined);
  } finally { await act(async () => root.unmount()); api.close(); }
});

test('pending image action survives blur and does not block the new scope', async () => {
  reset();
  const oldMetadata = Promise.withResolvers<Response>();
  const picker = Promise.withResolvers<void>();
  fixture.picker = picker.promise;
  let calls = 0;
  const api = gateway(() => ++calls === 1 ? oldMetadata.promise : Response.json(file));
  const root = createRoot({ textComponentTypes: ['Text'] });
  const render = () => createElement(ImageActions, { api, source: { fileId: file.id } });
  try {
    await act(async () => root.render(render()));
    await act(async () => { control(root, 'media-download').props.onPress(); });
    assert.equal(control(root, 'media-download').props.disabled, true);
    fixture.focus = false;
    await act(async () => root.render(render()));
    assert.equal(control(root, 'media-download').props.disabled, true);
    fixture.focus = true;
    await act(async () => root.render(render()));
    assert.equal(control(root, 'media-download').props.disabled, false, 'the new scope should not inherit old busy state');
    await act(async () => { control(root, 'media-download').props.onPress(); });
    assert.equal(calls, 2);
    oldMetadata.resolve(Response.json(file));
    await act(async () => { await oldMetadata.promise; });
    assert.equal(control(root, 'media-download').props.disabled, true, 'old completion must not clear new work');
    assert.equal(fixture.transfers.length, 0, 'the old page must not create a document');
    picker.resolve();
    await act(async () => { await picker.promise; });
    assert.equal(fixture.transfers.length, 1);
    assert.equal(control(root, 'media-download').props.disabled, false);
  } finally {
    oldMetadata.resolve(Response.json(file)); picker.resolve();
    await act(async () => root.unmount()); api.close();
  }
});
