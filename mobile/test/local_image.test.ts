import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { after, test } from 'node:test';

import type { GatewayApi } from '../src/gateway/api.ts';
type ImageNativeState = {
  responses: Map<string, Buffer>;
  barriers: Map<string, Promise<void>>;
  failure: Error | null;
  requests: { url: string; authorization: string; signal?: AbortSignal }[];
};
declare global { var __imageNativeState: ImageNativeState; }
globalThis.__imageNativeState = { responses: new Map(), barriers: new Map(), failure: null, requests: [] };

const root = mkdtempSync(join(tmpdir(), 'mobile-image-leases-'));
after(() => rmSync(root, { recursive: true, force: true }));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const hosts: Record<string, string> = {
      'react-native': `export const Platform = { OS: 'android' };`,
      'expo-file-system': `
        import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const state = globalThis.__imageNativeState;
        export const Paths = { cache: ${JSON.stringify(root)} };
        export class Directory {
          constructor(...parts) { this.uri = join(...parts.map(part => part.uri ?? part)); }
          get exists() { return existsSync(this.uri); }
          create() { mkdirSync(this.uri, { recursive: true }); }
          delete() { rmSync(this.uri, { recursive: true }); }
        }
        export class File {
          constructor(...parts) { this.uri = join(...parts.map(part => part.uri ?? part)); }
          get exists() { return existsSync(this.uri); }
          delete() { rmSync(this.uri); }
          static createDownloadTask(url, destination, { headers, signal }) {
            state.requests.push({ url, authorization: headers.Authorization, signal });
            return { async downloadAsync() {
              if (signal?.aborted) await Promise.withResolvers().promise;
              if (state.barriers.has(headers.Authorization)) await state.barriers.get(headers.Authorization);
              if (signal?.aborted) await Promise.withResolvers().promise;
              writeFileSync(destination.uri, state.failure ? 'partial' : state.responses.get(headers.Authorization));
              if (state.failure) throw state.failure;
              return destination;
            } };
          }
        }
      `,
    };
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
// Only native hosts are replaced; the real lease code creates and removes files.
const { loadLocalImage } = await import('../src/lib/local-image.ts');

function gateway(computerId: string): { api: GatewayApi; close(): void; probes(): number } {
  const controller = new AbortController();
  let probes = 0;
  return {
    api: { config: { computerId, baseUrl: 'https://same-host' }, signal: controller.signal,
      headers: () => ({ Authorization: `Bearer ${computerId}` }),
      readBinary: () => { throw new Error('Native image must not buffer its body in JS'); },
      checkUnauthorized: async () => { probes++; } } as unknown as GatewayApi,
    close: () => controller.abort(),
    probes: () => probes,
  };
}

test('same image path and URL on two computers cannot share local bytes or an image decoder URI', async () => {
  const first = gateway('computer-a');
  const second = gateway('computer-b');
  globalThis.__imageNativeState.responses.set('Bearer computer-a', Buffer.from([1, 2, 3]));
  globalThis.__imageNativeState.responses.set('Bearer computer-b', Buffer.from([4, 5, 6]));
  const signal = new AbortController().signal;
  const a = await loadLocalImage(first.api, '/files/same-id/content', signal);
  const b = await loadLocalImage(second.api, '/files/same-id/content', signal);
  try {
    assert.notEqual(a.uri, b.uri);
    assert.deepEqual(readFileSync(a.uri), Buffer.from([1, 2, 3]));
    assert.deepEqual(readFileSync(b.uri), Buffer.from([4, 5, 6]));
    a.dispose();
    assert.equal(existsSync(a.uri), false);
    assert.equal(existsSync(b.uri), true);
  } finally { a.dispose(); b.dispose(); }
});

test('old API finishes without native cancellation after a switch, discards its bytes and preserves the new image with the same id', async () => {
  const { promise, resolve: complete } = Promise.withResolvers<void>();
  globalThis.__imageNativeState.barriers.set('Bearer computer-a', promise);
  const old = gateway('computer-a');
  const fresh = gateway('computer-b');
  globalThis.__imageNativeState.responses.set('Bearer computer-a', Buffer.from([1, 2, 3]));
  globalThis.__imageNativeState.responses.set('Bearer computer-b', Buffer.from([4, 5, 6]));
  let lease: { uri: string; dispose(): void } | undefined;
  try {
    const loading = loadLocalImage(old.api, '/files/same-id/content', new AbortController().signal);
    old.close();
    lease = await loadLocalImage(fresh.api, '/files/same-id/content', new AbortController().signal);
    assert.deepEqual(globalThis.__imageNativeState.requests.slice(-2).map(({ url, authorization, signal }) =>
      ({ url, authorization, signal })), [
      { url: 'https://same-host/files/same-id/content', authorization: 'Bearer computer-a', signal: undefined },
      { url: 'https://same-host/files/same-id/content', authorization: 'Bearer computer-b', signal: undefined },
    ]);
    complete();
    await assert.rejects(loading, { name: 'AbortError' });
    assert.deepEqual(readdirSync(join(root, 'wandrun-images', 'computer-a')), []);
    assert.deepEqual(readFileSync(lease.uri), Buffer.from([4, 5, 6]));
    assert.equal(old.probes(), 0);
  } finally {
    complete();
    globalThis.__imageNativeState.barriers.delete('Bearer computer-a');
    lease?.dispose();
  }
});

test('native download failure removes partial bytes and probes revocation on the owning API', async () => {
  const owner = gateway('computer-a');
  globalThis.__imageNativeState.failure = new Error('native transfer failed');
  try {
    await assert.rejects(loadLocalImage(owner.api, '/files/same-id/content', new AbortController().signal), /native transfer failed/);
    assert.equal(owner.probes(), 1);
    assert.deepEqual(readdirSync(join(root, 'wandrun-images', 'computer-a')), []);
  } finally { globalThis.__imageNativeState.failure = null; }
});
