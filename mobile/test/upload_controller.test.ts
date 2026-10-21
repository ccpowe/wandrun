import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { GatewayApi } from "../src/gateway/api.ts";
import { LocalUploadError } from "../src/lib/upload-error.ts";

type UploadSpy = { started: boolean; aborted: boolean; options: {
  onError(error: unknown): void;
  onSuccess(event: { lastResponse: { getHeader(name: string): string | null } }): void;
  onProgress(sent: number): void;
  onUploadUrlAvailable(): void;
} };
type UploadTestState = {
  root: string;
  sources: Map<string, Buffer>;
  uploads: UploadSpy[];
  pickerOptions: { copyToCacheDirectory: boolean; multiple: boolean } | null;
  pickerResult: { canceled: boolean; assets: { uri: string; name: string; size: number; mimeType: string }[] };
  mediaPermissionGranted: boolean;
  mediaPermissionRequests: number;
  videoPickerCalls: number;
  videoPickerResult: { canceled: boolean; assets: { uri: string; fileName: string; mimeType: string; fileSize: number; type: "video" }[] };
  copyBarrier: Promise<void> | null;
  abortBarrier: Promise<void> | null;
  abortError: Error | null;
  writeError: Error | null;
};
declare global {
  var __uploadTest: UploadTestState;
}

// The Node runner has no Expo native modules. Only the native boundary is replaced:
// the real picker, draft controller, snapshot code and lease registry run unchanged.
const root = mkdtempSync(join(tmpdir(), "mobile-upload-controller-"));
after(() => rmSync(root, { recursive: true, force: true }));
globalThis.__uploadTest = {
  root, sources: new Map<string, Buffer>(), uploads: [], pickerOptions: null,
  pickerResult: { canceled: true, assets: [] }, copyBarrier: null, abortBarrier: null, abortError: null,
  writeError: null,
  mediaPermissionGranted: false, mediaPermissionRequests: 0, videoPickerCalls: 0,
  videoPickerResult: { canceled: true, assets: [] },
};

const modules: Record<string, string> = {
  "expo-file-system": `
    import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    const test = globalThis.__uploadTest;
    export const Paths = { document: test.root };
    export const FileMode = { ReadOnly: 'read' };
    export class Directory {
      constructor(...parts) { this.uri = join(...parts.map(part => part.uri ?? part)); }
      get exists() { return existsSync(this.uri); }
      get name() { return this.uri.split('/').at(-1); }
      create() { mkdirSync(this.uri, { recursive: true }); }
      list() { return readdirSync(this.uri).filter(name => statSync(join(this.uri, name)).isDirectory()).map(name => new Directory(this, name)); }
      delete() { rmSync(this.uri, { recursive: true }); }
    }
    export class File {
      constructor(...parts) { this.uri = parts.length === 1 ? parts[0].uri ?? parts[0] : join(...parts.map(part => part.uri ?? part)); }
      get exists() { return existsSync(this.uri); }
      get size() {
        if (this.uri.startsWith('content://')) throw new Error('content URI size cannot be read before copy');
        return readFileSync(this.uri).length;
      }
      get name() { return this.uri.split('/').at(-1); }
      textSync() { return readFileSync(this.uri, 'utf8'); }
      write(value) { if (test.writeError) throw test.writeError; writeFileSync(this.uri, value); }
      moveSync(destination) { renameSync(this.uri, destination.uri); }
      delete() { rmSync(this.uri); }
      async copy(destination) {
        if (test.copyBarrier) await test.copyBarrier;
        mkdirSync(dirname(destination.uri), { recursive: true });
        const bytes = test.sources.get(this.uri) ?? readFileSync(this.uri);
        writeFileSync(destination.uri, bytes);
      }
    }
  `,
  "tus-js-client": `
    export class Upload {
      constructor(file, options) { this.file = file; this.options = options; this.aborted = false; globalThis.__uploadTest.uploads.push(this); }
      start() { this.started = true; }
      async abort() { this.aborted = true; if (globalThis.__uploadTest.abortBarrier) await globalThis.__uploadTest.abortBarrier; if (globalThis.__uploadTest.abortError) throw globalThis.__uploadTest.abortError; }
      static async terminate() {}
    }
  `,
  "react-native": `export const Platform = { OS: 'android' };`,
  "expo-document-picker": `export async function getDocumentAsync(options) {
    const test = globalThis.__uploadTest;
    test.pickerOptions = options;
    return test.pickerResult;
  }`,
  "expo-image-picker": `
    export async function requestMediaLibraryPermissionsAsync() {
      const test = globalThis.__uploadTest;
      test.mediaPermissionRequests++;
      return { granted: test.mediaPermissionGranted };
    }
    export async function launchImageLibraryAsync() {
      const test = globalThis.__uploadTest;
      test.videoPickerCalls++;
      return test.videoPickerResult;
    }
  `,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in modules) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// These imports must follow hook registration because the native modules do not load in Node.
const { acquireUploadDraft, suspendComputerUploads, pruneConversationDrafts, discardConversationDraft } = await import("../src/lib/upload-drafts.ts");
const { pickUploads } = await import("../src/lib/pick-upload.ts");
const { Platform } = await import("react-native");
// Only the network boundary of this controller is exercised by the tus spy.
function gateway(computerId: string, baseUrl = "http://gateway") {
  const connection = new AbortController();
  let revoked = 0;
  const api = { config: { computerId, baseUrl }, headers: () => ({}),
    signal: connection.signal, handleUnauthorized: () => { revoked++; } } as unknown as GatewayApi;
  return { api, connection, revoked: () => revoked };
}
const { api } = gateway("computer-a");
test("Android picker retains the original content URI and stages it before tus starts", async () => {
  const testState = globalThis.__uploadTest;
  const bytes = Buffer.from("original selected bytes, not a cache copy");
  const uri = "content://documents/selected";
  testState.sources.set(uri, bytes);
  const otherUri = "content://documents/other";
  testState.sources.set(otherUri, Buffer.from("second"));
  testState.pickerResult = { canceled: false, assets: [
    { uri, name: "selected.txt", size: bytes.length, mimeType: "text/plain" },
    { uri: otherUri, name: "other.txt", size: 6, mimeType: "text/plain" },
  ] };
  const selected = await pickUploads("file");
  assert.equal(testState.pickerOptions?.copyToCacheDirectory, false);
  assert.equal(testState.pickerOptions?.multiple, true);
  assert.deepEqual(selected.map(({ uri }) => uri), [uri, otherUri]);
  const lease = acquireUploadDraft(api, "picked", () => {});
  await lease.controller.add(selected[0]);
  const item = lease.controller.draft.items[0];
  assert.equal(item.size, bytes.length);
  assert.deepEqual(readFileSync(join(lease.controller.directory.uri, `${item.id}.bin`)), bytes);
  assert.equal(testState.uploads.at(-1)?.started, true);
  lease.release();
  testState.pickerResult = { canceled: true, assets: [] };
  assert.deepEqual(await pickUploads("file"), []);
  Object.assign(Platform, { OS: "ios" });
  await pickUploads("file");
  assert.equal(testState.pickerOptions?.copyToCacheDirectory, true);
  Object.assign(Platform, { OS: "android" });
});

test("video picker proceeds on Android without full-library permission, but iOS requires preauthorization", async () => {
  const state = globalThis.__uploadTest;
  state.videoPickerResult = { canceled: false, assets: [{
    uri: "content://media/video/1", fileName: "clip.mp4", mimeType: "video/mp4", fileSize: 256, type: "video",
  }] };
  state.mediaPermissionGranted = false;
  state.mediaPermissionRequests = 0;
  state.videoPickerCalls = 0;
  try {
    Object.assign(Platform, { OS: "android" });
    assert.deepEqual(await pickUploads("video"), [{
      uri: "content://media/video/1", name: "clip.mp4", mimeType: "video/mp4", size: 256,
    }]);
    assert.equal(state.mediaPermissionRequests, 0);
    assert.equal(state.videoPickerCalls, 1);

    Object.assign(Platform, { OS: "ios" });
    await assert.rejects(pickUploads("video"), /允许访问视频/);
    assert.equal(state.mediaPermissionRequests, 1);
    assert.equal(state.videoPickerCalls, 1, "permission denial must prevent iOS passthrough export");
    state.mediaPermissionGranted = true;
    assert.equal((await pickUploads("video"))[0].name, "clip.mp4");
    assert.equal(state.mediaPermissionRequests, 2);
    assert.equal(state.videoPickerCalls, 2);
  } finally {
    Object.assign(Platform, { OS: "android" });
  }
});

test("two screens share text, attachments, notifications and the sole upload until final release", async () => {
  let seenA = 0;
  let seenB = 0;
  const first = acquireUploadDraft(api, "shared", () => { seenA++; });
  const second = acquireUploadDraft(api, "shared", () => { seenB++; });
  assert.equal(first.controller, second.controller);
  first.controller.setText("first screen");
  assert.equal(seenB, 2);
  assert.equal(second.controller.draft.text, "first screen");
  second.controller.setText("second screen");
  assert.equal(seenA, 3);
  assert.equal(first.controller.draft.text, "second screen");
  const uri = "content://documents/shared";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("attachment"));
  await first.controller.add({ uri, name: "shared.txt" });
  assert.equal(second.controller.items[0].name, "shared.txt");
  const transfer = globalThis.__uploadTest.uploads.at(-1);
  const transfersBefore = globalThis.__uploadTest.uploads.length;
  const third = acquireUploadDraft(api, "shared", () => {});
  assert.equal(third.controller, first.controller);
  assert.equal(globalThis.__uploadTest.uploads.length, transfersBefore);
  third.release();
  first.release();
  const notificationsAfterRelease = seenA;
  second.controller.setText("still mounted");
  assert.equal(seenA, notificationsAfterRelease);
  assert.equal(transfer?.aborted, false);
  second.release();
  assert.equal(transfer?.aborted, true);
  const reopened = acquireUploadDraft(api, "shared", () => {});
  assert.notEqual(reopened.controller, first.controller);
  assert.equal(reopened.controller.draft.text, "still mounted");
  assert.equal(reopened.controller.items[0].name, "shared.txt");
  assert.equal(globalThis.__uploadTest.uploads.at(-1)?.started, true);
  reopened.release();
});

test("a pending native copy stays owned by the remaining subscriber after its initiating screen leaves", async () => {
  let finishCopy!: () => void;
  globalThis.__uploadTest.copyBarrier = new Promise<void>((resolve) => { finishCopy = resolve; });
  const uri = "content://documents/pending";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("pending bytes"));
  const first = acquireUploadDraft(api, "pending", () => {});
  const second = acquireUploadDraft(api, "pending", () => {});
  const adding = first.controller.add({ uri, name: "pending.txt" });
  assert.equal(second.controller.items[0].name, "pending.txt");
  first.release();
  finishCopy();
  await adding;
  globalThis.__uploadTest.copyBarrier = null;
  assert.equal(second.controller.draft.items[0].size, Buffer.byteLength("pending bytes"));
  second.release();
});

test("late native copy from an unmounted screen cannot restore its attachment into a new lease", async () => {
  let finishCopy!: () => void;
  globalThis.__uploadTest.copyBarrier = new Promise<void>((resolve) => { finishCopy = resolve; });
  const uri = "content://documents/late";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("late"));
  const old = acquireUploadDraft(api, "late", () => {});
  const adding = old.controller.add({ uri, name: "late.txt" });
  old.release();
  const current = acquireUploadDraft(api, "late", () => {});
  current.controller.setText("new owner");
  finishCopy();
  await adding;
  globalThis.__uploadTest.copyBarrier = null;
  assert.equal(current.controller.draft.text, "new owner");
  assert.deepEqual(current.controller.draft.items, []);
  current.release();
});

test("upload failures persist only the classified reason across reopening", async () => {
  const uri = "content://documents/failing";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("bytes"));
  const lease = acquireUploadDraft(api, "failing", () => {});
  await lease.controller.add({ uri, name: "failing.txt" });
  const raw = Object.assign(new Error("private tus request details"), {
    originalRequest: {}, originalResponse: { getStatus: () => 507 },
  });
  globalThis.__uploadTest.uploads.at(-1)!.options.onError(raw);
  assert.equal(lease.controller.items[0].error, "电脑磁盘空间不足");
  const snapshot = readFileSync(join(lease.controller.directory.uri, "draft-a.json"), "utf8");
  assert.equal(JSON.parse(snapshot).draft.items[0].error, "电脑磁盘空间不足");
  assert.equal(snapshot.includes(raw.message), false);
  lease.release();
  const reopened = acquireUploadDraft(api, "failing", () => {});
  assert.equal(reopened.controller.items[0].error, "电脑磁盘空间不足");
  reopened.release();
});

test("unreadable selected files reject with a safe reason instead of a native path", async () => {
  const lease = acquireUploadDraft(api, "unreadable", () => {});
  await assert.rejects(lease.controller.add({ uri: "content://private/missing", name: "missing.txt" }), {
    message: "无法读取所选文件",
  });
  assert.deepEqual(lease.controller.items, []);
  lease.release();
});

test("adding an attachment preserves draft-save failures instead of misclassifying them as file-read failures", async () => {
  const lease = acquireUploadDraft(api, "draft-write-failure", () => {});
  lease.controller.setText("保留原草稿");
  const uri = "content://documents/draft-write";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("attachment"));
  const uploadsBefore = globalThis.__uploadTest.uploads.length;
  const cause = new Error("native write failure: private path");
  globalThis.__uploadTest.writeError = cause;
  try {
    await assert.rejects(lease.controller.add({ uri, name: "draft.txt" }), (error: unknown) => {
      assert.ok(error instanceof LocalUploadError);
      assert.equal(error.kind, "draft-write");
      assert.ok(!error.message.includes(cause.message));
      return true;
    });
    assert.equal(lease.controller.draft.text, "保留原草稿");
    assert.deepEqual(lease.controller.items, []);
    assert.equal(globalThis.__uploadTest.uploads.length, uploadsBefore);
  } finally {
    globalThis.__uploadTest.writeError = null;
    lease.release();
  }
});

test("two local computers with the same URL and conversation id retain separate durable drafts and staged bytes", async () => {
  const firstApi = gateway("computer-one").api;
  const secondApi = gateway("computer-two").api;
  const first = acquireUploadDraft(firstApi, "same-server-id", () => {});
  const second = acquireUploadDraft(secondApi, "same-server-id", () => {});
  assert.notEqual(first.controller, second.controller);
  assert.notEqual(first.controller.directory.uri, second.controller.directory.uri);
  const uri = "content://documents/identical";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("computer one"));
  first.controller.setText("private to one");
  await first.controller.add({ uri, name: "same.txt" });
  globalThis.__uploadTest.sources.set(uri, Buffer.from("computer two"));
  second.controller.setText("private to two");
  await second.controller.add({ uri, name: "same.txt" });
  assert.deepEqual(readFileSync(join(first.controller.directory.uri, `${first.controller.items[0].id}.bin`)), Buffer.from("computer one"));
  assert.deepEqual(readFileSync(join(second.controller.directory.uri, `${second.controller.items[0].id}.bin`)), Buffer.from("computer two"));
  first.release();
  second.release();
  const reopened = acquireUploadDraft(secondApi, "same-server-id", () => {});
  assert.equal(reopened.controller.draft.text, "private to two");
  reopened.release();
  pruneConversationDrafts("computer-one", new Set());
  assert.equal(first.controller.directory.exists, false);
  assert.equal(second.controller.directory.exists, true);
  discardConversationDraft("computer-two", "same-server-id");
  assert.equal(second.controller.directory.exists, false);
});

test("member text drafts survive a root-only refresh and root deletion removes mounted and closed member drafts", () => {
  const api = gateway("collaboration-drafts").api;
  const first = acquireUploadDraft(api, "child", () => {}, "root");
  const second = acquireUploadDraft(api, "nested", () => {}, "root");
  first.controller.setText("correction");
  second.controller.setText("nested correction");
  second.release();
  pruneConversationDrafts("collaboration-drafts", new Set(["root"]));
  assert.equal(first.controller.draft.text, "correction");
  const reopened = acquireUploadDraft(api, "nested", () => {}, "root");
  assert.equal(reopened.controller.draft.text, "nested correction");
  reopened.release();
  discardConversationDraft("collaboration-drafts", "root");
  assert.equal(first.controller.directory.exists, false);
  assert.equal(second.controller.directory.exists, false);
  first.controller.setText("late edit");
  assert.equal(first.controller.directory.exists, false);
  first.release();
});

test("switch waits for paused tus upload; old callbacks cannot mutate drafts or revoke, and a fresh API resumes", async () => {
  const old = gateway("switching");
  const lease = acquireUploadDraft(old.api, "same-id", () => {});
  lease.controller.setText("unsent");
  const uri = "content://documents/switching";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("resume bytes"));
  await lease.controller.add({ uri, name: "switch.txt" });
  const transfer = globalThis.__uploadTest.uploads.at(-1)!;
  const item = lease.controller.items[0];
  let finishAbort!: () => void;
  globalThis.__uploadTest.abortBarrier = new Promise<void>((resolve) => { finishAbort = resolve; });
  try {
    let stopped = false;
    const suspending = suspendComputerUploads("switching").then(() => { stopped = true; });
    assert.equal(transfer.aborted, true);
    await Promise.resolve();
    assert.equal(stopped, false);
    const snapshot = readFileSync(join(lease.controller.directory.uri, "draft-a.json"), "utf8");
    transfer.options.onProgress(item.size);
    transfer.options.onUploadUrlAvailable();
    transfer.options.onSuccess({ lastResponse: { getHeader: () => "foreign-id" } });
    transfer.options.onError({ originalResponse: { getStatus: () => 401 } });
    assert.equal(old.revoked(), 0);
    assert.equal(lease.controller.items[0].fileId, null);
    assert.equal(readFileSync(join(lease.controller.directory.uri, "draft-a.json"), "utf8"), snapshot);
    finishAbort();
    await suspending;
    old.connection.abort();
    assert.throws(() => acquireUploadDraft(old.api, "same-id", () => {}), /有效的电脑连接/);
    const fresh = gateway("switching");
    const resumed = acquireUploadDraft(fresh.api, "same-id", () => {});
    assert.notEqual(resumed.controller, lease.controller);
    assert.equal(resumed.controller.draft.text, "unsent");
    assert.equal(resumed.controller.items[0].id, item.id);
    assert.equal(globalThis.__uploadTest.uploads.at(-1)?.started, true);
    resumed.release();
  } finally {
    finishAbort();
    globalThis.__uploadTest.abortBarrier = null;
    lease.release();
  }
});

test("switch also waits for a tus abort started by a prior screen release", async () => {
  const first = acquireUploadDraft(gateway("released").api, "conversation", () => {});
  const uri = "content://documents/released";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("bytes"));
  await first.controller.add({ uri, name: "bytes.txt" });
  let finishAbort!: () => void;
  globalThis.__uploadTest.abortBarrier = new Promise<void>((resolve) => { finishAbort = resolve; });
  try {
    first.release();
    let stopped = false;
    const suspending = suspendComputerUploads("released").then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    finishAbort();
    await suspending;
    assert.equal(stopped, true);
  } finally {
    finishAbort();
    globalThis.__uploadTest.abortBarrier = null;
    first.release();
  }
});

test("a removed active attachment's local upload abort finishes before switching computers", async () => {
  const lease = acquireUploadDraft(gateway("removing").api, "conversation", () => {});
  const uri = "content://documents/removing";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("bytes"));
  await lease.controller.add({ uri, name: "bytes.txt" });
  let finishAbort!: () => void;
  globalThis.__uploadTest.abortBarrier = new Promise<void>((resolve) => { finishAbort = resolve; });
  try {
    lease.controller.remove(lease.controller.items[0].id);
    let stopped = false;
    const suspending = suspendComputerUploads("removing").then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    finishAbort();
    await suspending;
    assert.equal(stopped, true);
  } finally {
    finishAbort();
    globalThis.__uploadTest.abortBarrier = null;
    lease.release();
  }
});

test("failed tus abort remains a failed switch barrier even after the screen released its controller", async () => {
  const lease = acquireUploadDraft(gateway("abort-failure").api, "conversation", () => {});
  const uri = "content://documents/abort-failure";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("bytes"));
  await lease.controller.add({ uri, name: "bytes.txt" });
  globalThis.__uploadTest.abortError = new Error("native abort failed");
  try {
    lease.release();
    await assert.rejects(suspendComputerUploads("abort-failure"), /native abort failed/);
    await assert.rejects(suspendComputerUploads("abort-failure"), /native abort failed/);
  } finally {
    globalThis.__uploadTest.abortError = null;
    lease.release();
  }
});

test("failed local abort of a removed upload remains a failed computer handoff", async () => {
  const lease = acquireUploadDraft(gateway("remove-abort-failure").api, "conversation", () => {});
  const uri = "content://documents/remove-abort-failure";
  globalThis.__uploadTest.sources.set(uri, Buffer.from("bytes"));
  await lease.controller.add({ uri, name: "bytes.txt" });
  globalThis.__uploadTest.abortError = new Error("native abort failed");
  try {
    lease.controller.remove(lease.controller.items[0].id);
    await assert.rejects(suspendComputerUploads("remove-abort-failure"), /native abort failed/);
    await assert.rejects(suspendComputerUploads("remove-abort-failure"), /native abort failed/);
  } finally {
    globalThis.__uploadTest.abortError = null;
    lease.release();
  }
});
