import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

type SaveFixture = {
  picker: Promise<void>;
  transfer: Promise<void>;
  started: () => void;
  files: Map<string, string>;
  requests: { url: string; destination: string; headers: Record<string, string>; signal?: AbortSignal }[];
  created: number;
  failure: Error | null;
};
declare global { var __nativeSaveFixture: SaveFixture; }

globalThis.__nativeSaveFixture = {
  picker: Promise.resolve(), transfer: Promise.resolve(), started: () => {},
  files: new Map(), requests: [], created: 0, failure: null,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "expo-file-system") return {
      url: `data:text/javascript,${encodeURIComponent(`
        const state = globalThis.__nativeSaveFixture;
        export class Directory {
          static async pickDirectoryAsync() { await state.picker; return new Directory(); }
          createFile(name) {
            const file = new File('content://picked/' + encodeURIComponent(name) + '-' + ++state.created);
            state.files.set(file.uri, '');
            return file;
          }
        }
        export class File {
          constructor(uri) { this.uri = uri; }
          get exists() { return state.files.has(this.uri); }
          delete() { state.files.delete(this.uri); }
          static createDownloadTask(url, destination, options) {
            state.requests.push({ url, destination: destination.uri, headers: options.headers, signal: options.signal });
            state.started();
            return { async downloadAsync() {
              await state.transfer;
              if (options.signal?.aborted) await Promise.withResolvers().promise;
              state.files.set(destination.uri, state.failure ? 'partial' : 'saved bytes');
              if (state.failure) throw state.failure;
              return destination;
            } };
          }
        }
      `)}`,
      shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});

// Import after installing the host mock: native Expo modules cannot load in Node.
const { saveNativeFile } = await import("../src/lib/native-file-save.ts");

const original = { name: "same-id.txt", media_type: "text/plain" };

test("confirmed native save finishes into the picked directory after the old computer closes", async () => {
  const picker = Promise.withResolvers<void>();
  const transfer = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const state = globalThis.__nativeSaveFixture;
  state.picker = picker.promise;
  state.transfer = transfer.promise;
  state.started = started.resolve;
  state.files.clear();
  state.requests.length = 0;
  state.created = 0;
  state.failure = null;
  const oldApi = new AbortController();
  let current = true;
  const saving = saveNativeFile("https://old-host/files/same-id/content", { Authorization: "Bearer old" },
    original, () => current, oldApi.signal);
  picker.resolve();
  await started.promise;
  current = false;
  oldApi.abort();
  assert.deepEqual(state.requests, [{
    url: "https://old-host/files/same-id/content", destination: "content://picked/same-id.txt-1",
    headers: { Authorization: "Bearer old" }, signal: undefined,
  }]);
  transfer.resolve();
  assert.equal(await saving, true);
  assert.equal(state.files.get("content://picked/same-id.txt-1"), "saved bytes");
});

test("a directory picker returning after its owner expires starts no native transfer or document", async () => {
  const picker = Promise.withResolvers<void>();
  const state = globalThis.__nativeSaveFixture;
  state.picker = picker.promise;
  state.transfer = Promise.resolve();
  state.files.clear();
  state.requests.length = 0;
  state.created = 0;
  const oldApi = new AbortController();
  let current = true;
  const saving = saveNativeFile("https://old-host/files/same-id/content", { Authorization: "Bearer old" },
    original, () => current, oldApi.signal);
  current = false;
  oldApi.abort();
  picker.resolve();
  assert.equal(await saving, false);
  assert.equal(state.created, 0);
  assert.deepEqual(state.requests, []);
  assert.equal(state.files.size, 0);
});

test("a failed accepted save removes only the partial document it created", async () => {
  const state = globalThis.__nativeSaveFixture;
  state.picker = Promise.resolve();
  state.transfer = Promise.resolve();
  state.files.clear();
  state.requests.length = 0;
  state.created = 0;
  state.failure = new Error("download failed");
  try {
    await assert.rejects(saveNativeFile("https://old-host/content", {}, original,
      () => true, new AbortController().signal), /download failed/);
    assert.equal(state.files.size, 0);
  } finally { state.failure = null; }
});
