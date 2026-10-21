import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { GatewayApi } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import type { SavedComputer } from "../src/lib/credentials.ts";
import { assertUploadEndpoint, UploadEndpointError } from "../src/lib/upload-error.ts";
import type { UploadDraftController } from "../src/lib/upload-drafts.ts";
import type { SessionOwner as SessionOwnerType } from "../src/lib/session-owner.ts";

// Replace only Expo's native file boundary; requests use the installed tus-js-client.
const root = mkdtempSync(join(tmpdir(), "upload-termination-"));
after(() => rmSync(root, { recursive: true, force: true }));
(globalThis as typeof globalThis & { __uploadTerminationRoot: string }).__uploadTerminationRoot = root;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "expo-file-system") return { url: `data:text/javascript,${encodeURIComponent(`
      import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      export const Paths = { document: globalThis.__uploadTerminationRoot };
      export const FileMode = { ReadOnly: 'read' };
      export class Directory {
        constructor(...parts) { this.uri = join(...parts.map(part => part.uri ?? part)); }
        get exists() { return existsSync(this.uri); }
        create() { mkdirSync(this.uri, { recursive: true }); }
        delete() { rmSync(this.uri, { recursive: true }); }
      }
      export class File {
        constructor(...parts) { this.uri = parts.length === 1 ? parts[0].uri ?? parts[0] : join(...parts.map(part => part.uri ?? part)); }
        get exists() { return existsSync(this.uri); }
        get size() { return statSync(this.uri).size; }
        textSync() { return readFileSync(this.uri, 'utf8'); }
        write(value) { writeFileSync(this.uri, value); }
        moveSync(destination) { renameSync(this.uri, destination.uri); }
        delete() { rmSync(this.uri); }
        async copy(destination) { mkdirSync(dirname(destination.uri), { recursive: true }); copyFileSync(this.uri, destination.uri); }
        open() {
          const fd = openSync(this.uri, 'r');
          return {
            offset: 0,
            readBytes(count) {
              const buffer = Buffer.allocUnsafe(count);
              const length = readSync(fd, buffer, 0, count, this.offset);
              this.offset += length;
              return buffer.subarray(0, length);
            },
            close() { closeSync(fd); },
          };
        }
      }
    `)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// Dynamic imports are required after native-module hook registration.
const { acquireUploadDraft, suspendComputerUploads } = await import("../src/lib/upload-drafts.ts");

function uploadApi(baseUrl: string, computerId: string): GatewayApi {
  const controller = new AbortController();
  return {
    config: { baseUrl, computerId },
    signal: controller.signal,
    headers: () => ({ Authorization: "Bearer upload-test-token" }),
    handleUnauthorized: () => { throw new Error("Unexpected unauthorized upload"); },
  } as unknown as GatewayApi;
}
const { SessionOwner } = await import("../src/lib/session-owner.ts");

async function bounded<T>(operation: Promise<T>): Promise<T> {
  // This real-network test needs a failure deadline: a regression otherwise
  // leaves a server-side DELETE open and the test runner waiting indefinitely.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for local transport")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const state of ["active", "persisted"] as const) {
  test(`a hung tus DELETE from ${state} upload is cancelled before switching computers`, async () => {
    const posted = Promise.withResolvers<void>();
    const patched = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<void>();
    const deleteClosed = Promise.withResolvers<void>();
    const failed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      if (request.method === "POST") {
        response.writeHead(201, { Location: "/uploads/one", "Tus-Resumable": "1.0.0" });
        response.end();
        posted.resolve();
      } else if (request.method === "PATCH") {
        patched.resolve();
        if (state === "persisted") { response.writeHead(500); response.end(); }
      } else if (request.method === "DELETE") {
        response.on("close", () => deleteClosed.resolve());
        deleted.resolve(); // Deliberately never respond.
      } else {
        response.writeHead(405); response.end();
      }
    });
    let lease: { controller: UploadDraftController; release(): void } | undefined;
    let owner: SessionOwnerType | undefined;
    try {
      server.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const a: SavedComputer = { computerId: `termination-${state}-a`, connectionId: `termination-${state}-a`, baseUrl, token: "a" };
      const b: SavedComputer = { computerId: `termination-${state}-b`, connectionId: `termination-${state}-b`, baseUrl, token: "b" };
      class IdleSession extends ChatSession { override async start(): Promise<void> {} }
      owner = new SessionOwner((config) => new IdleSession(config), suspendComputerUploads);
      await owner.select(a);
      const source = join(root, `${state}.txt`);
      writeFileSync(source, "real tus transfer");
      lease = acquireUploadDraft(owner.snapshot()!.session.api, `conversation-${state}`, (controller) => {
        if (controller.items[0]?.error) failed.resolve();
      });
      await lease.controller.add({ uri: source, name: `${state}.txt` });
      await bounded(posted.promise);
      await bounded(patched.promise);
      if (state === "persisted") {
        await bounded(failed.promise);
        const savedUrl = lease.controller.items[0]?.uploadUrl;
        assert.ok(savedUrl);
        assert.ok(lease.controller.items[0]?.error);
        lease.release();
        lease = acquireUploadDraft(owner.snapshot()!.session.api, `conversation-${state}`, () => {});
        assert.equal(lease.controller.items[0]?.uploadUrl, savedUrl);
        assert.ok(lease.controller.items[0]?.error);
      } else {
        assert.ok(lease.controller.items[0]?.uploadUrl);
        assert.equal(lease.controller.items[0]?.error, null);
      }
      lease.controller.remove(lease.controller.items[0].id);
      await bounded(deleted.promise);
      await bounded(owner.select(b));
      assert.equal(owner.snapshot()?.owner.computerId, b.computerId);
      await bounded(deleteClosed.promise); // Network socket, not just the draft, was stopped.
    } finally {
      lease?.release();
      // Do not wait on a failed handoff before closing its sockets.
      if (owner) void owner.select(null).catch(() => {});
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  });
}

test("upload endpoint boundary rejects downgrade, credentials and other origins", () => {
  const connection = new URL("https://gateway.example:443");
  assert.doesNotThrow(() => assertUploadEndpoint("https://gateway.example/uploads/u", connection));
  for (const target of [
    "http://gateway.example/uploads/u",
    "https://other.example/uploads/u",
    "https://gateway.example:444/uploads/u",
    "https://name:password@gateway.example/uploads/u",
    "//gateway.example/uploads/u",
  ]) {
    assert.throws(() => assertUploadEndpoint(target, connection), UploadEndpointError);
  }
});

test("malicious tus Location never reaches its upload URL or persists it", async () => {
  const attempted: string[] = [];
  const foreign = createServer((request, response) => {
    attempted.push(`${request.method} ${request.headers.authorization ?? ""}`);
    response.writeHead(204); response.end();
  });
  const gateway = createServer((request, response) => {
    attempted.push(`${request.method} ${request.headers.authorization ?? ""}`);
    response.writeHead(201, { Location: location, "Tus-Resumable": "1.0.0" });
    response.end();
  });
  let lease: { controller: UploadDraftController; release(): void } | undefined;
  let location = "";
  try {
    foreign.listen(0, "127.0.0.1");
    gateway.listen(0, "127.0.0.1");
    await Promise.all([
      new Promise<void>((resolve) => foreign.once("listening", resolve)),
      new Promise<void>((resolve) => gateway.once("listening", resolve)),
    ]);
    const foreignAddress = foreign.address();
    const gatewayAddress = gateway.address();
    assert.ok(foreignAddress && typeof foreignAddress !== "string");
    assert.ok(gatewayAddress && typeof gatewayAddress !== "string");
    const baseUrl = `http://127.0.0.1:${gatewayAddress.port}`;
    for (const [suffix, target] of [
      ["other-origin", `http://127.0.0.1:${foreignAddress.port}/uploads/evil`],
      ["credentials", `http://name:password@127.0.0.1:${gatewayAddress.port}/uploads/evil`],
      ["malformed", "http://["],
    ]) {
      location = target;
      const failed = Promise.withResolvers<void>();
      lease = acquireUploadDraft(uploadApi(baseUrl, suffix), suffix, (controller) => {
        if (controller.items[0]?.error) failed.resolve();
      });
      const source = join(root, `${suffix}.txt`);
      writeFileSync(source, "attachment remains staged");
      await lease.controller.add({ uri: source, name: `${suffix}.txt` });
      await bounded(failed.promise);
      assert.match(lease.controller.items[0].error!, /上传地址不安全/);
      assert.equal(lease.controller.items[0].uploadUrl, null);
      assert.ok(existsSync(join(lease.controller.directory.uri, `${lease.controller.items[0].id}.bin`)));
      lease.release();
      lease = undefined;
    }
    assert.deepEqual(attempted, [
      "POST Bearer upload-test-token",
      "POST Bearer upload-test-token",
      "POST Bearer upload-test-token",
    ]);
  } finally {
    lease?.release();
    await Promise.all([foreign, gateway].map(async (server) => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }));
  }
});

async function exerciseSavedUpload(mode: "resume" | "unsafe" | "unsafe-delete"): Promise<void> {
  const bytes = Buffer.from("resume these local bytes");
  const requests: { method: string; url: string; authorization: string | undefined; body: Buffer }[] = [];
  let posts = 0;
  let patches = 0;
  const foreign = createServer((request, response) => {
    requests.push({ method: request.method!, url: "foreign", authorization: request.headers.authorization, body: Buffer.alloc(0) });
    response.writeHead(404); response.end();
  });
  const gateway = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body: Buffer.concat(chunks) });
      if (request.method === "POST") {
        posts++;
        response.writeHead(201, { Location: `/uploads/${posts}`, "Tus-Resumable": "1.0.0" });
      } else if (request.method === "HEAD") {
        response.writeHead(200, { "Upload-Offset": "0", "Upload-Length": `${bytes.length}` });
      } else if (request.method === "PATCH") {
        patches++;
        response.writeHead(patches === 1 ? 500 : 204, patches === 1
          ? {} : { "Upload-Offset": `${bytes.length}`, "Upload-File-Id": "uploaded-file-id" });
      } else {
        response.writeHead(405);
      }
      response.end();
    });
  });
  let lease: { controller: UploadDraftController; release(): void } | undefined;
  try {
    foreign.listen(0, "127.0.0.1");
    gateway.listen(0, "127.0.0.1");
    await Promise.all([
      new Promise<void>((resolve) => foreign.once("listening", resolve)),
      new Promise<void>((resolve) => gateway.once("listening", resolve)),
    ]);
    const address = gateway.address();
    const foreignAddress = foreign.address();
    assert.ok(address && typeof address !== "string");
    assert.ok(foreignAddress && typeof foreignAddress !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const api = uploadApi(baseUrl, `saved-${mode}`);
    const failed = Promise.withResolvers<void>();
    lease = acquireUploadDraft(api, `saved-${mode}`, (controller) => {
      if (controller.items[0]?.error) failed.resolve();
    });
    const source = join(root, `${mode}.txt`);
    writeFileSync(source, bytes);
    await lease.controller.add({ uri: source, name: `${mode}.txt` });
    await bounded(failed.promise);
    lease.controller.setText("unsent message");
    const localId = lease.controller.items[0].id;
    const directory = lease.controller.directory.uri;
    assert.equal(lease.controller.items[0].uploadUrl, `${baseUrl}/uploads/1`);
    lease.release();
    lease = undefined;

    if (mode !== "resume") {
      // An old committed snapshot may contain the HTTP/foreign URL from an older gateway.
      for (const slot of ["draft-a.json", "draft-b.json"]) {
        const path = join(directory, slot);
        if (!existsSync(path)) continue;
        const snapshot = JSON.parse(readFileSync(path, "utf8"));
        snapshot.draft.items[0].uploadUrl = `http://127.0.0.1:${foreignAddress.port}/uploads/stale`;
        if (mode === "unsafe") snapshot.draft.items[0].error = null;
        writeFileSync(path, JSON.stringify(snapshot));
      }
    }
    const completed = Promise.withResolvers<void>();
    lease = acquireUploadDraft(api, `saved-${mode}`, (controller) => {
      if (controller.items[0]?.fileId) completed.resolve();
    });
    assert.equal(lease.controller.items[0].id, localId);
    assert.equal(lease.controller.draft.text, "unsent message");
    assert.ok(existsSync(join(directory, `${localId}.bin`)));
    if (mode === "unsafe-delete") {
      lease.controller.remove(localId);
      // Real tus dispatches DELETE asynchronously; allow its HTTP turn to expose an accidental send.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.equal(lease.controller.items.length, 0);
      assert.deepEqual(requests.map(({ method }) => method), ["POST", "PATCH"]);
    } else {
      if (mode === "resume") lease.controller.retry(localId);
      await bounded(completed.promise);
      assert.equal(lease.controller.items[0].fileId, "uploaded-file-id");
      assert.equal(lease.controller.items[0].uploadUrl,
        mode === "resume" ? `${baseUrl}/uploads/1` : `${baseUrl}/uploads/2`);
      assert.ok(existsSync(join(directory, `${localId}.bin`)));
      assert.deepEqual(requests.map(({ method }) => method),
        mode === "resume" ? ["POST", "PATCH", "HEAD", "PATCH"] : ["POST", "PATCH", "POST", "PATCH"]);
      assert.deepEqual(requests.filter(({ method }) => method === "PATCH").map(({ body }) => body), [bytes, bytes]);
      assert.ok(requests.every(({ authorization }) => authorization === "Bearer upload-test-token"));
    }
    assert.equal(requests.some(({ url }) => url === "foreign"), false);
  } finally {
    lease?.release();
    await Promise.all([foreign, gateway].map(async (server) => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }));
  }
}

test("safe persisted upload resumes with authenticated HEAD and PATCH", () => exerciseSavedUpload("resume"));
test("unsafe persisted upload keeps local bytes and creates a fresh upload without HEAD to the old URL", () => exerciseSavedUpload("unsafe"));
test("removing an unsafe persisted upload does not send DELETE to the old URL", () => exerciseSavedUpload("unsafe-delete"));
