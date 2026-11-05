import assert from "node:assert/strict";
import { test } from "node:test";

import { exchangePairingCode, GatewayApi, GatewayError } from "../src/gateway/api.ts";
import { Credentials } from "../src/lib/credentials.ts";
import { PairingScanScope, normalizeGatewayAddress, normalizePairingCode, parsePairingQr } from "../src/lib/pairing.ts";

function storage() {
  let saved: string | null = null;
  return {
    async getItemAsync() { return saved; },
    async setItemAsync(_key: string, value: string) { saved = value; },
    async deleteItemAsync() { saved = null; },
    value: () => saved,
  };
}

test("QR encodes an address/code only; malformed and credential-bearing URLs cannot be paired", () => {
  const qr = `wandrun://pair?url=${encodeURIComponent("https://remote.example:8443")}&code=${encodeURIComponent("AB12CD34")}`;
  assert.deepEqual(parsePairingQr(qr), { baseUrl: "https://remote.example:8443", code: "AB12CD34" });
  assert.deepEqual(parsePairingQr(`wandrun://pair?url=${encodeURIComponent("https://remote.example/proxy/pair/")}&code=AB12CD34`),
    { baseUrl: "https://remote.example/proxy/pair", code: "AB12CD34" });
  for (const value of ["https://example.com", "wandrun://else?url=http://localhost&code=AB12CD34", "wandrun://evil@pair?url=http://host&code=AB12CD34", "wandrun://pair?url=http://host&code=AB12CD34#secret", "wandrun://pair?url=http://user:secret@host&code=AB12CD34", "wandrun://pair?url=javascript:alert(1)&code=AB12CD34", "wandrun://pair?url=http://host&code=AB12CD34&token=secret", "wandrun://pair?url=http://host&url=http://attacker&code=AB12CD34"]) {
    assert.equal(parsePairingQr(value), null);
  }
  assert.equal(normalizeGatewayAddress("127.0.0.1:8765/"), "http://127.0.0.1:8765");
  assert.equal(normalizePairingCode("ab12 cd34"), "AB12CD34");
  assert.throws(() => normalizePairingCode("AB12"));
});

test("exchange sends only the one-time code and never an existing credential", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const exchange = await exchangePairingCode("http://computer", "AB12CD34", "manual", undefined, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ token: "device-secret", device_id: "d1", computer_name: "电脑", gateway_version: "1.0", paired_at: "2026-10-11T00:00:00Z", pairing_method: "manual" }));
  });
  assert.equal(exchange.device_id, "d1");
  assert.equal(requests[0].url, "http://computer/pairing/exchange");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { code: "AB12CD34", method: "manual" });
  assert.equal(JSON.stringify(requests[0].init?.headers).includes("Authorization"), false);
});

test("pairing deadline covers a hanging fetch and a hanging response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new PairingScanScope();
  scope.focus();
  const first = scope.start("qr-hung")!;
  const hanging = exchangePairingCode("http://computer", "AB12CD34", "qr", first,
    () => new Promise<Response>(() => {}));
  t.mock.timers.tick(15_000);
  await assert.rejects(hanging, (error: GatewayError) => error.code === "timeout");
  scope.finish(first);
  assert.equal(scope.start("qr-hung"), null);
  const retry = scope.start("new-qr");
  assert.ok(retry);
  scope.finish(retry);

  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  let transportSignal: AbortSignal | undefined;
  const pending = exchangePairingCode("http://computer", "AB12CD34", "qr", undefined, (_url, init) => {
    transportSignal = init?.signal ?? undefined;
    return Promise.resolve({ ok: true, json: () => {
      started();
      return new Promise<unknown>(() => {});
    } } as Response);
  });
  await reading;
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, (error: GatewayError) => error.code === "timeout");
  assert.equal(transportSignal?.aborted, true);
});

test("connection probe also times out while its body is unreadable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal: AbortSignal | undefined;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const api = new GatewayApi({ baseUrl: "http://computer", token: "dev" }, async (_url, init) => {
    requestSignal = init?.signal ?? undefined;
    return { status: 200, ok: true, json: () => {
      started();
      return new Promise<unknown>(() => {});
    } } as Response;
  });
  const pending = api.connection();
  await reading;
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, (error: GatewayError) => error.code === "timeout");
  assert.equal(requestSignal?.aborted, true);
});

test("device revocation does not leave the confirmation permanently working", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestSignal: AbortSignal | undefined;
  const api = new GatewayApi({ baseUrl: "http://computer", token: "paired" }, async (_url, init) => {
    assert.equal(init?.method, "DELETE");
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  const pending = api.revokeCurrent();
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, (error: GatewayError) => error.code === "timeout");
  assert.equal(requestSignal?.aborted, true);
});

test("cancel releases a hanging scan, and late old transport results cannot replace its successor", async () => {
  const scope = new PairingScanScope();
  scope.focus();
  const first = scope.start("qr-one")!;
  let completeOld!: (response: Response) => void;
  const old = exchangePairingCode("http://computer", "AB12CD34", "qr", first,
    () => new Promise<Response>((resolve) => { completeOld = resolve; }));
  assert.equal(scope.start("qr-two"), null);
  scope.cancel();
  assert.equal(scope.current(first), false);
  await assert.rejects(old, (error: GatewayError) => error.code === "cancelled");
  assert.equal(scope.start("qr-one"), null); // Still in view: suppress the same code.
  const second = scope.start("qr-two")!;
  assert.equal(scope.current(second), true);
  completeOld(new Response(JSON.stringify({ token: "late-secret", device_id: "old" })));
  await Promise.resolve();
  assert.equal(scope.current(first), false);
  assert.equal(scope.current(second), true);
  scope.finish(first);
  assert.equal(scope.start("qr-three"), null); // Old completion cannot release the new request.
  scope.finish(second);
  scope.retryQr();
  assert.ok(scope.start("qr-two")); // Explicit retry, not a camera callback loop.
});

test("screen blur aborts a pending scan; focus restores scanning without accepting old results", async () => {
  const scope = new PairingScanScope();
  scope.focus();
  const previous = scope.start("same-qr")!;
  scope.blur();
  assert.equal(previous.aborted, true);
  assert.equal(scope.start("other"), null);
  scope.focus();
  const current = scope.start("same-qr")!;
  assert.equal(scope.current(previous), false);
  scope.finish(previous);
  assert.equal(scope.current(current), true);
  scope.finish(current);
  assert.equal(scope.start("same-qr"), null);
  scope.retryQr();
  assert.ok(scope.start("same-qr"));
});

test("computer list persists selection, notes and distinct pairing identities; old key is never read", async () => {
  const values = new Map([["wandrun.gateway", JSON.stringify({ baseUrl: "http://legacy", token: "legacy" })]]);
  const durable = {
    async getItemAsync(key: string) { return values.get(key) ?? null; },
    async setItemAsync(key: string, value: string) { values.set(key, value); },
    async deleteItemAsync(key: string) { values.delete(key); },
  };
  const credentials = new Credentials(durable);
  await credentials.restore();
  assert.equal(credentials.snapshot().config, null);
  await credentials.install({ baseUrl: "http://a/", token: "a", deviceId: "device-a", computerName: "same-host" });
  const a = credentials.snapshot().config!;
  await credentials.renameComputer(a.computerId, "  工作电脑  ");
  await credentials.install({ baseUrl: "http://b", token: "b", deviceId: "device-b", computerName: "same-host" });
  const b = credentials.snapshot().config!;
  assert.notEqual(a.computerId, b.computerId);
  await credentials.switchComputer(a.computerId);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().currentId, a.computerId);
  assert.deepEqual(restored.snapshot().computers.map((item) => [item.baseUrl, item.localName]), [["http://a", "工作电脑"], ["http://b", undefined]]);
  assert.equal(restored.snapshot().config?.connectionId, a.connectionId);
  await assert.rejects(restored.switchComputer("missing"), /已移除/);
  await assert.rejects(restored.renameComputer(a.computerId, "two\nlines"), /单行/);
});

test("chat.J1 每台电脑保存自己的主对话；记录和重命名不改变连接身份", async () => {
  const durable = storage();
  const credentials = new Credentials(durable);
  await credentials.install({ baseUrl: "http://a", token: "a", deviceId: "a" });
  const a = credentials.snapshot().config!;
  await Promise.all([
    credentials.rememberConversation(a.connectionId, "root-a"),
    credentials.renameComputer(a.computerId, "Work"),
  ]);
  await credentials.install({ baseUrl: "http://b", token: "b", deviceId: "b" });
  const b = credentials.snapshot().config!;
  await credentials.rememberConversation(b.connectionId, "root-b");
  await credentials.switchComputer(a.computerId);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().config?.lastConversationId, "root-a");
  assert.equal(restored.snapshot().config?.connectionId, a.connectionId);
  assert.equal(restored.snapshot().config?.localName, "Work");
  await restored.switchComputer(b.computerId);
  assert.equal(restored.snapshot().config?.lastConversationId, "root-b");
});

test("chat.J1 重新配对保留打开记录；旧连接的迟到记录不能覆盖它", async () => {
  const credentials = new Credentials(storage());
  await credentials.install({ baseUrl: "http://a", token: "old", deviceId: "a" });
  const old = credentials.snapshot().config!;
  await credentials.rememberConversation(old.connectionId, "root");
  await credentials.install({ baseUrl: "http://a", token: "new", deviceId: "a" });
  await credentials.rememberConversation(old.connectionId, "stale");
  assert.notEqual(credentials.snapshot().config?.connectionId, old.connectionId);
  assert.equal(credentials.snapshot().config?.lastConversationId, "root");
});

test("chat.J8 记录写入失败保留最后成功记录，后续凭据写入仍可使用", async () => {
  const durable = storage();
  let fail = false;
  const credentials = new Credentials({ ...durable, async setItemAsync(key, value) {
    if (fail) throw new Error("disk unavailable");
    await durable.setItemAsync(key, value);
  } });
  await credentials.install({ baseUrl: "http://a", token: "a", deviceId: "a" });
  const owner = credentials.snapshot().config!;
  await credentials.rememberConversation(owner.connectionId, "saved");
  fail = true;
  await assert.rejects(credentials.rememberConversation(owner.connectionId, "not-saved"), /disk unavailable/);
  assert.equal(credentials.snapshot().config?.lastConversationId, "saved");
  fail = false;
  await credentials.renameComputer(owner.computerId, "Work");
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().config?.lastConversationId, "saved");
  assert.equal(restored.snapshot().config?.connectionId, owner.connectionId);
  assert.equal(restored.snapshot().config?.localName, "Work");
});

test("only a proven repeated pairing deduplicates; a hostname, endpoint or fresh device does not", async () => {
  const credentials = new Credentials(storage());
  await credentials.install({ baseUrl: "http://same/", token: "one", deviceId: "d1", computerName: "host" });
  const first = credentials.snapshot().config!;
  await credentials.renameComputer(first.computerId, "Note");
  await credentials.install({ baseUrl: "http://same", token: "replacement", deviceId: "d1", computerName: "renamed" });
  const updated = credentials.snapshot().config!;
  assert.equal(updated.computerId, first.computerId);
  assert.equal(updated.localName, "Note");
  assert.notEqual(updated.connectionId, first.connectionId);
  assert.equal(await credentials.clear(first, true), false);
  await credentials.install({ baseUrl: "http://same", token: "fresh", deviceId: "d2", computerName: "renamed" });
  await credentials.install({ baseUrl: "http://other", token: "other", deviceId: "d1", computerName: "renamed" });
  assert.equal(credentials.snapshot().computers.length, 3);
  await credentials.install({ baseUrl: "http://dev", token: "dev", pairingMethod: "development" });
  const dev = credentials.snapshot().config!;
  await credentials.install({ baseUrl: "http://dev/", token: "dev", pairingMethod: "development" });
  assert.equal(credentials.snapshot().config?.computerId, dev.computerId);
  assert.equal(credentials.snapshot().computers.length, 4);
});

test("a failed upload with a valid saved credential fails alone; concurrent 401s share one trusted confirmation", async () => {
  const durable = storage();
  const credentials = new Credentials(durable);
  await credentials.install({ baseUrl: "https://computer", token: "secret", deviceId: "device" });
  const owner = credentials.snapshot().config!;
  let confirm!: (response: Response) => void;
  const seen: string[] = [];
  let invalidation = 0;
  const api = new GatewayApi(owner, async (url, init) => {
    seen.push(String(url));
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer secret");
    if (String(url).endsWith("/connection")) return new Promise<Response>((resolve) => { confirm = resolve; });
    return new Response("", { status: 401 });
  }, (reason) => { if (reason === "invalid") { invalidation++; void credentials.markInvalid(owner); } });
  const first = api.listAgents();
  const second = api.listConversations();
  api.handleUnauthorized(); // Upload's native transport also reports 401.
  const verification = api.checkUnauthorized();
  await assert.rejects(first, (error: GatewayError) => error.status === 401);
  await assert.rejects(second, (error: GatewayError) => error.status === 401);
  assert.deepEqual(seen, ["https://computer/agents", "https://computer/conversations", "https://computer/connection"]);
  confirm(Response.json({ device_id: "device" }));
  await verification;
  assert.equal(invalidation, 0);
  assert.equal(credentials.snapshot().config?.connectionId, owner.connectionId);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().config?.token, "secret");
});

test("confirmed invalid credentials persist for repair without removing either computer", async () => {
  const durable = storage();
  const credentials = new Credentials(durable);
  await credentials.install({ baseUrl: "http://a", token: "a" });
  const a = credentials.snapshot().config!;
  await credentials.install({ baseUrl: "http://b", token: "b", deviceId: "same-device" });
  const b = credentials.snapshot().config!;
  let marking: Promise<boolean> | null = null;
  const api = new GatewayApi(b, async () => new Response("", { status: 401 }),
    (reason) => { if (reason === "invalid") marking = credentials.markInvalid(b); });
  const request = api.listAgents();
  const verification = api.checkUnauthorized();
  await assert.rejects(request, (error: GatewayError) => error.status === 401);
  await verification;
  assert.equal(await marking, true);
  assert.deepEqual(credentials.snapshot().computers.map((item) => [item.computerId, item.authStatus ?? "valid"]), [[a.computerId, "valid"], [b.computerId, "invalid"]]);
  assert.equal(credentials.snapshot().config?.computerId, b.computerId);
  assert.equal(credentials.snapshot().revoked, false);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().config?.authStatus, "invalid");
  await restored.install({ baseUrl: "http://b", token: "new", deviceId: "newly-issued-device" }, b.connectionId);
  assert.equal(restored.snapshot().config?.authStatus, undefined);
  assert.equal(restored.snapshot().config?.computerId, b.computerId, "repair retains the upload draft namespace");
  assert.equal(restored.snapshot().config?.deviceId, "newly-issued-device");
  assert.equal(restored.snapshot().computers.length, 2);
  assert.equal(await restored.markInvalid(b), false, "old credentials cannot invalidate the repaired installation");
  await assert.rejects(restored.install({ baseUrl: "http://b", token: "late" }, b.connectionId));
  assert.equal(restored.snapshot().config?.token, "new");
});

test("explicit repair cannot replace a different endpoint or a healthy installation", async () => {
  const credentials = new Credentials(storage());
  await credentials.install({ baseUrl: "https://computer", token: "old", deviceId: "old" });
  const owner = credentials.snapshot().config!;
  await assert.rejects(credentials.install({ baseUrl: owner.baseUrl, token: "new" }, owner.connectionId));
  await credentials.markInvalid(owner);
  await assert.rejects(credentials.install({ baseUrl: "https://other", token: "new" }, owner.connectionId));
  assert.equal(credentials.snapshot().config?.token, "old");
  assert.equal(credentials.snapshot().config?.authStatus, "invalid");
});

test("synchronous confirmation failure preserves credentials and permits a later confirmation", async () => {
  let attempts = 0;
  const reasons: string[] = [];
  const api = new GatewayApi({ baseUrl: "https://computer", token: "secret" }, () => {
    if (++attempts === 1) throw new Error("native transport unavailable");
    return Promise.resolve(new Response("", { status: 401 }));
  }, (reason) => reasons.push(reason));
  await api.checkUnauthorized();
  assert.deepEqual(reasons, []);
  await api.checkUnauthorized();
  assert.deepEqual(reasons, ["invalid"]);
  api.close();
});

test("a timed-out confirmation preserves the saved computer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const credentials = new Credentials(storage());
  await credentials.install({ baseUrl: "https://computer", token: "secret" });
  const owner = credentials.snapshot().config!;
  let probeSignal: AbortSignal | undefined;
  const api = new GatewayApi(owner, async (_url, init) => {
    probeSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }, (reason) => { if (reason === "invalid") void credentials.markInvalid(owner); });
  api.handleUnauthorized();
  const verification = api.checkUnauthorized();
  t.mock.timers.tick(5000);
  await verification;
  assert.equal(probeSignal?.aborted, true);
  assert.equal(credentials.snapshot().config?.authStatus, undefined);
  assert.equal(credentials.snapshot().computers.length, 1);
});

test("explicit 4401 revocation removes only its saved installation", async () => {
  const durable = storage();
  const credentials = new Credentials(durable);
  await credentials.install({ baseUrl: "http://a", token: "a" });
  const a = credentials.snapshot().config!;
  await credentials.install({ baseUrl: "http://b", token: "b" });
  const b = credentials.snapshot().config!;
  let removal: Promise<boolean> | null = null;
  const api = new GatewayApi(b, async () => { throw new Error("4401 must not probe HTTP"); },
    (reason) => { if (reason === "revoked") removal = credentials.clear(b, true); });
  api.handleRevoked();
  assert.equal(await removal, true);
  assert.deepEqual(credentials.snapshot().computers.map((item) => item.computerId), [a.computerId]);
  assert.equal(credentials.snapshot().config?.computerId, a.computerId);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.deepEqual(restored.snapshot().computers.map((item) => item.computerId), [a.computerId]);
});

test("local disconnect racing with SSE refusal never marks the fallback revoked", async () => {
  const credentials = new Credentials(storage());
  await credentials.install({ baseUrl: "http://a", token: "a" });
  const a = credentials.snapshot().config!;
  await credentials.install({ baseUrl: "http://b", token: "b" });
  const b = credentials.snapshot().config!;
  credentials.beginDisconnect(b);
  await credentials.clear(b, true);
  assert.equal(credentials.snapshot().config?.computerId, a.computerId);
  assert.equal(credentials.snapshot().revoked, false);
  await credentials.finishDisconnect(b);
  credentials.endDisconnect(b);
  assert.equal(credentials.snapshot().config?.computerId, a.computerId);
  await credentials.finishDisconnect(a);
  assert.equal(credentials.snapshot().config, null);
  assert.equal(credentials.snapshot().computers.length, 0);
});

test("a refusal during a pending write cannot resurrect that computer; subsequent install survives", async () => {
  let saved: string | null = null;
  let hold = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const credentials = new Credentials({
    async getItemAsync() { return saved; },
    async setItemAsync(_key, value) {
      if (hold) { hold = false; entered.resolve(); await release.promise; }
      saved = value;
    },
    async deleteItemAsync() { saved = null; },
  });
  await credentials.install({ baseUrl: "http://a", token: "a" });
  const a = credentials.snapshot().config!;
  hold = true;
  const renaming = credentials.renameComputer(a.computerId, "new note");
  await entered.promise;
  const refusing = credentials.clear(a, true);
  assert.equal(credentials.snapshot().config, null);
  const installing = credentials.install({ baseUrl: "http://b", token: "b" });
  release.resolve();
  await Promise.all([renaming, refusing, installing]);
  assert.deepEqual(credentials.snapshot().computers.map((item) => item.baseUrl), ["http://b"]);
  const restored = new Credentials({
    async getItemAsync() { return saved; }, async setItemAsync() {}, async deleteItemAsync() {},
  });
  await restored.restore();
  assert.deepEqual(restored.snapshot().computers.map((item) => item.baseUrl), ["http://b"]);
});

test("failed secure writes preserve last committed selection and failed deletion can be retried", async () => {
  let saved: string | null = null;
  let fail = false;
  const credentials = new Credentials({
    async getItemAsync() { return saved; },
    async setItemAsync(_key, value) { if (fail) throw new Error("keychain unavailable"); saved = value; },
    async deleteItemAsync() { if (fail) throw new Error("keychain unavailable"); saved = null; },
  });
  await credentials.install({ baseUrl: "http://a", token: "a" });
  const a = credentials.snapshot().config!;
  await credentials.install({ baseUrl: "http://b", token: "b" });
  const b = credentials.snapshot().config!;
  fail = true;
  await assert.rejects(credentials.switchComputer(a.computerId), /keychain/);
  await assert.rejects(credentials.finishDisconnect(b), /keychain/);
  assert.equal(credentials.snapshot().currentId, b.computerId);
  fail = false;
  await credentials.finishDisconnect(b);
  fail = true;
  await assert.rejects(credentials.finishDisconnect(a), /keychain/);
  assert.equal(credentials.snapshot().currentId, a.computerId);
  fail = false;
  await credentials.finishDisconnect(a);
  assert.equal(credentials.snapshot().config, null);
});

test("late confirmation from an old API cannot invalidate a newly paired installation", async () => {
  const durable = storage();
  const credentials = new Credentials(durable);
  await credentials.install({ baseUrl: "http://computer", token: "old", deviceId: "d" });
  const old = credentials.snapshot().config!;
  let respond!: (response: Response) => void;
  const api = new GatewayApi(old, async () => new Promise<Response>((resolve) => { respond = resolve; }),
    (reason) => { if (reason === "invalid") void credentials.markInvalid(old); });
  const probe = api.checkUnauthorized();
  await credentials.install({ baseUrl: "http://computer", token: "new", deviceId: "d" });
  const replacement = credentials.snapshot().config!;
  respond(new Response("", { status: 401 }));
  await probe;
  assert.notEqual(replacement.connectionId, old.connectionId);
  assert.equal(credentials.snapshot().config?.authStatus, undefined);
  assert.equal(credentials.snapshot().config?.token, "new");
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().config?.token, "new");
});

test("an aborted hidden-status probe cannot invalidate a replacement installation", async () => {
  const credentials = new Credentials(storage());
  await credentials.install({ baseUrl: "http://computer", token: "old", deviceId: "d" });
  const old = credentials.snapshot().config!;
  let respond!: (response: Response) => void;
  const api = new GatewayApi(old, async () => new Promise<Response>((resolve) => { respond = resolve; }),
    (reason) => { if (reason === "invalid") void credentials.markInvalid(old); });
  const page = new AbortController();
  const probe = api.checkUnauthorized(page.signal);
  page.abort();
  await probe;
  await credentials.install({ baseUrl: "http://computer", token: "new", deviceId: "d" });
  const replacement = credentials.snapshot().config!;
  respond(new Response("", { status: 401 }));
  await Promise.resolve();
  assert.equal(credentials.snapshot().config, replacement);
});

test("a cancelled page probe cannot cancel request-level 401 confirmation", async () => {
  const credentials = new Credentials(storage());
  await credentials.install({ baseUrl: "https://computer", token: "old" });
  const owner = credentials.snapshot().config!;
  const responses: ((value: Response) => void)[] = [];
  const api = new GatewayApi(owner, async () => new Promise<Response>((resolve) => { responses.push(resolve); }),
    (reason) => { if (reason === "invalid") void credentials.markInvalid(owner); });
  const page = new AbortController();
  const hidden = api.checkUnauthorized(page.signal);
  api.handleUnauthorized();
  const confirmation = api.checkUnauthorized();
  page.abort();
  await hidden;
  responses[0](new Response("", { status: 401 }));
  responses[1](new Response("", { status: 401 }));
  await confirmation;
  assert.equal(credentials.snapshot().config?.authStatus, "invalid");
  assert.equal(credentials.snapshot().computers.length, 1);
});

test("hidden-status probe times out and aborts an unresponsive transport", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let transportSignal: AbortSignal | undefined;
  const transport = Promise.withResolvers<Response>();
  const api = new GatewayApi({ baseUrl: "http://computer", token: "old" }, async (_url, init) => {
    transportSignal = init?.signal ?? undefined;
    return transport.promise;
  });
  let ended = false;
  const pending = api.checkUnauthorized().finally(() => { ended = true; });
  try {
    t.mock.timers.tick(4_999);
    await Promise.resolve();
    assert.equal(ended, false);
    assert.equal(transportSignal?.aborted, false);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(ended, true);
    assert.equal(transportSignal?.aborted, true);
  } finally {
    transport.resolve(new Response("", { status: 200 }));
    t.mock.timers.tick(5_000);
    await pending;
  }
});

test("hidden-status probe marks a real 401 invalid without deleting the computer", async () => {
  const durable = storage();
  const credentials = new Credentials(durable);
  await credentials.restore();
  await credentials.install({ baseUrl: "http://computer", token: "current" });
  const current = credentials.snapshot().config!;
  let marking: Promise<boolean> | null = null;
  const api = new GatewayApi(current, async () => new Response("", { status: 401 }),
    (reason) => { if (reason === "invalid") marking = credentials.markInvalid(current); });
  await api.checkUnauthorized();
  assert.equal(await marking, true);
  assert.equal(credentials.snapshot().config?.authStatus, "invalid");
  assert.equal(credentials.snapshot().revoked, false);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().config?.authStatus, "invalid");
});

test("chat.J9 首次连接意图按连接归属消费，冷启与重复配对不重新开新对话", async () => {
  const durable = storage();
  const credentials = new Credentials(durable);
  await credentials.install({ baseUrl: "http://a", token: "a", deviceId: "a" });
  const a = credentials.snapshot().config!;
  assert.equal(credentials.snapshot().newChatConnectionId, a.connectionId);
  await credentials.install({ baseUrl: "http://b", token: "b", deviceId: "b" });
  const b = credentials.snapshot().config!;
  await credentials.rememberConversation(a.connectionId, "late-root-a");
  assert.equal(credentials.snapshot().newChatConnectionId, b.connectionId);
  await credentials.rememberConversation(b.connectionId, "root-b");
  assert.equal(credentials.snapshot().newChatConnectionId, null);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().newChatConnectionId, null);
  assert.equal(restored.snapshot().config?.lastConversationId, "root-b");
  await credentials.install({ baseUrl: "http://b", token: "replacement", deviceId: "b" });
  assert.equal(credentials.snapshot().newChatConnectionId, null);
  assert.equal(credentials.snapshot().config?.lastConversationId, "root-b");
});

test("chat.J8/J9 首次打开记录写失败也消费导航意图，不在下次入口自动重放", async () => {
  const durable = storage();
  let fail = false;
  const credentials = new Credentials({ ...durable, async setItemAsync(key, value) {
    if (fail) throw new Error("disk unavailable");
    await durable.setItemAsync(key, value);
  } });
  await credentials.install({ baseUrl: "http://a", token: "a", deviceId: "a" });
  const owner = credentials.snapshot().config!;
  fail = true;
  await assert.rejects(credentials.rememberConversation(owner.connectionId, "not-saved"), /disk unavailable/);
  assert.equal(credentials.snapshot().newChatConnectionId, null);
  assert.equal(credentials.snapshot().config?.lastConversationId, undefined);
  const restored = new Credentials(durable);
  await restored.restore();
  assert.equal(restored.snapshot().newChatConnectionId, null);
  assert.equal(restored.snapshot().config?.lastConversationId, undefined);
});
