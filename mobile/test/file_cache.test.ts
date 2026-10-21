import assert from "node:assert/strict";
import { test } from "node:test";

import { DeliveryCache, type CachedDownload } from "../src/lib/file-delivery.ts";

const original = { name: "报告".repeat(40) + ".txt", media_type: "text/plain" };
type MemoryFile = {
  readonly name: string;
  readonly uri: string;
  readonly exists: boolean;
  readonly modificationTime: number | null;
  create(): void;
  write(content: string): void;
  delete(): void;
  text(): Promise<string>;
};

class MemoryStorage {
  now = 1_000_000;
  readonly namespace: string;
  constructor(namespace = "computer-a") { this.namespace = namespace; }
  readonly files = new Map<string, { content: string; modified: number }>();
  downloadBody: (destination: MemoryFile) => Promise<void> = async (destination) => {
    destination.create();
    destination.write("original");
  };

  create(): void {}
  file(name: string): MemoryFile {
    const storage = this;
    return {
      name,
      uri: `file:///private/wandrun-delivery/${storage.namespace}/${name}`,
      get exists() { return storage.files.has(name); },
      get modificationTime() { return storage.files.get(name)?.modified ?? null; },
      create() { assert.ok(!storage.files.has(name)); storage.files.set(name, { content: "", modified: storage.now }); },
      write(content: string) { assert.ok(storage.files.has(name)); storage.files.set(name, { content, modified: storage.now }); },
      delete() { assert.ok(storage.files.delete(name)); },
      async text() { return storage.files.get(name)?.content ?? ""; },
    };
  }
  list() { return [...this.files.keys()].map((name) => this.file(name)); }
  download(_url: string, destination: MemoryFile, _headers: Record<string, string>) {
    return this.downloadBody(destination);
  }
}

const signal = new AbortController().signal;
function setup(namespace = "computer-a") {
  const storage = new MemoryStorage(namespace);
  return { storage, cache: new DeliveryCache(storage, () => storage.now) };
}

test("Android partial download failure removes its destination, not only completed previews", async () => {
  const { storage, cache } = setup();
  storage.downloadBody = async (destination) => {
    destination.create();
    destination.write("partial bytes");
    throw new Error("network stopped");
  };
  await assert.rejects(cache.download("/content", original, {}, signal), /network stopped/);
  assert.deepEqual(storage.list(), []);
});

test("share success, cancel and thrown share sheet retain bytes for a full hour after closing", async () => {
  const { storage, cache } = setup();
  const shared: CachedDownload[] = [];
  let closedAt = storage.now;
  for (const outcome of ["success", "cancel", "throw", "another success"]) {
    const lease = await cache.download("/content", original, {}, signal);
    // Native share may reject after handing the URI to a receiver.
    const handOff = async (uri: string) => {
      assert.equal(uri, lease.file.uri);
      if (outcome === "success") storage.now += 20 * 60 * 1000; // Sheet left open.
      if (outcome === "throw") throw new Error("native share failed");
    };
    if (outcome === "throw") await assert.rejects(lease.share(handOff), /native share failed/);
    else await lease.share(handOff); // Includes dismissal without sharing.
    closedAt = storage.now;
    assert.equal(lease.file.exists, true, outcome);
    shared.push(lease);
  }
  // Even a fourth valid large original cannot evict a receiver's one-hour lease.
  storage.now = closedAt + 60 * 60 * 1000 - 1;
  cache.prune();
  for (const lease of shared) assert.equal(lease.file.exists, true);
  storage.now++;
  cache.prune();
  for (const lease of shared) assert.equal(lease.file.exists, false);
});

test("original named export.keep stays readable for the whole receiver lease", async () => {
  const { storage, cache } = setup();
  const lease = await cache.download("/content", { name: "export.keep", media_type: "text/plain" }, {}, signal);
  await lease.share(async () => {});
  cache.prune();
  assert.equal(lease.file.exists, true);
  assert.equal(await lease.file.text(), "original");
  storage.now += 60 * 60 * 1000;
  cache.prune();
  assert.equal(lease.file.exists, false);
});

test("active preview, in-flight transfer and sharing remain protected while abandoned crash files are pruned", async () => {
  const { storage, cache } = setup();
  const preview = await cache.download("/preview", original, {}, signal);
  let finish!: () => void;
  storage.downloadBody = async (destination) => {
    destination.create();
    destination.write("partial");
    await new Promise<void>((resolve) => { finish = resolve; });
    destination.write("whole");
  };
  const pending = cache.download("/share", original, {}, signal);
  storage.file("abandoned.tmp").create();
  cache.prune();
  assert.equal(preview.file.exists, true);
  assert.equal(storage.list().some((file) => file.name === "abandoned.tmp"), false);
  const transfer = storage.list().find((file) => file.name !== preview.file.name);
  assert.equal(transfer?.exists, true);
  finish();
  const share = await pending;
  let settle!: () => void;
  const native = new Promise<void>((resolve) => { settle = resolve; });
  const sharing = share.share(async (uri) => {
    assert.equal(uri, share.file.uri);
    await native;
  });
  cache.prune();
  assert.equal(share.file.exists, true);
  preview.release();
  assert.equal(preview.file.exists, false);
  settle();
  await sharing;
  assert.equal(share.file.exists, true);
});

test("a changed original is fetched again rather than reusing the previous share by id or name", async () => {
  const { storage, cache } = setup();
  storage.downloadBody = async (destination) => { destination.create(); destination.write("before"); };
  const old = await cache.download("/files/id/content", original, {}, signal);
  await old.share(async () => {});
  storage.downloadBody = async (destination) => { destination.create(); destination.write("after"); };
  const fresh = await cache.download("/files/id/content", original, {}, signal);
  assert.notEqual(old.file.uri, fresh.file.uri);
  assert.equal(await fresh.file.text(), "after");
  assert.equal(await old.file.text(), "before");
  fresh.release();
});


test("cancelled or late-completing native download cannot publish a preview or partial file", async () => {
  const { storage, cache } = setup();
  const connection = new AbortController();
  let finish!: () => void;
  storage.downloadBody = async (destination) => {
    destination.create();
    destination.write("partial");
    await new Promise<void>((resolve) => { finish = resolve; });
    destination.write("completed after switch");
  };
  const pending = cache.download("/files/same-id/content", original, {}, connection.signal);
  connection.abort();
  finish();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(storage.list(), []);
});

test("an old transfer finishing after close deletes only its own target, not a reopened same-id cache or another computer", async () => {
  const { storage, cache } = setup();
  const other = setup("computer-b");
  const { promise, resolve: finishOld } = Promise.withResolvers<void>();
  storage.downloadBody = async (destination) => {
    destination.create();
    destination.write("old partial");
    await promise;
    destination.write("old completed");
  };
  const oldConnection = new AbortController();
  const old = cache.download("/files/same-id/content", original, { Authorization: "old" }, oldConnection.signal);
  oldConnection.abort();
  const oldTarget = storage.list()[0]!.uri;
  storage.downloadBody = async (destination) => { destination.create(); destination.write("reopened"); };
  const reopened = await cache.download("/files/same-id/content", original, { Authorization: "new" }, signal);
  const nextComputer = await other.cache.download("/files/same-id/content", original, { Authorization: "other" }, signal);
  assert.notEqual(reopened.file.uri, nextComputer.file.uri);
  assert.notEqual(reopened.file.uri, oldTarget);
  cache.prune();
  finishOld();
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(await reopened.file.text(), "reopened");
  assert.equal(await nextComputer.file.text(), "original");
  assert.equal(storage.files.size, 1);
  reopened.release();
  nextComputer.release();
});
