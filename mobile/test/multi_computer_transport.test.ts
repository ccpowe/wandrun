import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

import { GatewayApi, GatewayError, type Fetch } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { EventStream, type StreamState } from "../src/gateway/stream.ts";

const cancelled = (error: unknown) => error instanceof GatewayError && error.code === "cancelled";

test("closing a credential aborts fetch and response-body work even if native fetch ignores abort", async () => {
  const fetchReady = Promise.withResolvers<Response>();
  const bodyReady = Promise.withResolvers<unknown>();
  const bodyStarted = Promise.withResolvers<void>();
  const seen: { url: string; signal: AbortSignal; authorization: string }[] = [];
  let revoked = 0;
  const fetchImpl: Fetch = async function(this: unknown, url, init) {
    assert.equal(this, undefined, "browser fetch must not receive the API object as its receiver");
    seen.push({ url: String(url), signal: init!.signal!, authorization: (init!.headers as Record<string, string>).Authorization });
    if (seen.length === 1) return fetchReady.promise;
    const response = Response.json({ conversations: [], as_of_seq: 0 });
    response.json = () => { bodyStarted.resolve(); return bodyReady.promise; };
    return response;
  };
  const input = { baseUrl: "http://first/", token: "one", computerId: "first" };
  const api = new GatewayApi(input, fetchImpl, () => { revoked++; });
  input.baseUrl = "http://second";
  input.token = "two";
  const pendingFetch = api.listConversations();
  assert.deepEqual([seen[0].url, seen[0].authorization], ["http://first/conversations", "Bearer one"]);
  const controller = new AbortController();
  const pendingBody = api.connection(controller.signal);
  await bodyStarted.promise;
  assert.deepEqual(seen.map(({ url, authorization }) => [url, authorization]), [
    ["http://first/conversations", "Bearer one"], ["http://first/connection", "Bearer one"],
  ]);
  api.close();
  assert.equal(api.signal.aborted, true);
  assert.equal(seen.every(({ signal }) => signal.aborted), true);
  await assert.rejects(pendingFetch, cancelled);
  await assert.rejects(pendingBody, cancelled);
  fetchReady.resolve(new Response(null, { status: 401 }));
  bodyReady.resolve({ device_id: "late" });
  await Promise.resolve();
  assert.equal(revoked, 0);
  await assert.rejects(api.listConversations(), cancelled);
  assert.equal(seen.length, 2, "closed API never sends another request");
});

test("authenticated image bytes stay cancellable throughout native body consumption", async () => {
  const body = Promise.withResolvers<ArrayBuffer>();
  const reading = Promise.withResolvers<void>();
  let signal!: AbortSignal;
  const api = new GatewayApi({ baseUrl: "http://first", token: "one" }, async (url, init) => {
    assert.equal(String(url), "http://first/browser-tasks/same/thumbnail");
    assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer one");
    signal = init!.signal!;
    const response = new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } });
    response.arrayBuffer = () => { reading.resolve(); return body.promise; };
    return response;
  });
  const pending = api.readBinary(api.browserThumbnailPath("same"));
  await reading.promise;
  api.close();
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, cancelled);
  body.resolve(new Uint8Array([1, 2, 3]).buffer);
});

test("caller abort cancels just that request; SSE close stops blocked reads and late events", async () => {
  const observed: StreamState[] = [];
  let bodyCancelled = 0;
  let requestSignal!: AbortSignal;
  const api = new GatewayApi({ baseUrl: "http://first", token: "one" }, async (url, init) => {
    requestSignal = init!.signal!;
    if (String(url).endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({
      cancel() { bodyCancelled++; },
    }), { headers: { "Content-Type": "text/event-stream" } });
    return new Promise<Response>(() => {});
  });
  const caller = new AbortController();
  const request = api.connection(caller.signal);
  caller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof GatewayError && (error.code === "cancelled" || error.code === "network"));
  assert.equal(requestSignal.aborted, true);
  const opened = Promise.withResolvers<void>();
  assert.equal(api.signal.aborted, false);
  const events: unknown[] = [];
  const stream = new EventStream(api, 0, {
    event: (event) => events.push(event), transient: (event) => events.push(event),
    resync: () => events.push("resync"), state: (state) => { observed.push(state); if (state === "open") opened.resolve(); },
  }, { retryDelays: [1000] });
  await opened.promise;
  assert.equal(observed.includes("open"), true);
  api.close();
  await stream.done;
  assert.equal(requestSignal.aborted, true, "closing SSE must abort fetch, not just cancel its reader");
  assert.equal(bodyCancelled, 1);
  assert.deepEqual(events, []);
  assert.equal(observed.at(-1), "stopped");
});

test("SSE reconnect and explicit close abort real HTTP requests after headers", { timeout: 5000 }, async () => {
  const closed: Promise<void>[] = [];
  const server = createServer((_request, response) => {
    closed.push(new Promise<void>((resolve) => response.once("close", resolve)));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.flushHeaders();
    // No body or EOF: cancellation cannot depend on the server making progress.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const signals: AbortSignal[] = [];
  const api = new GatewayApi({ baseUrl: `http://127.0.0.1:${address.port}`, token: "old" }, (url, init) => {
    signals.push(init!.signal!);
    return fetch(url, init);
  });
  let opened = Promise.withResolvers<void>();
  const stream = new EventStream(api, 0, {
    event() {}, transient() {}, resync() {},
    state(state) { if (state === "open") opened.resolve(); },
  }, { retryDelays: [0] });
  try {
    await opened.promise;
    assert.equal(signals[0].aborted, false, "headers do not finish the request lifetime");
    opened = Promise.withResolvers<void>();
    stream.reconnectNow();
    await opened.promise;
    assert.equal(signals[0].aborted, true);
    await closed[0];
    assert.equal(signals[1].aborted, false);
    await stream.close();
    assert.equal(signals[1].aborted, true);
    await closed[1];
    assert.equal(api.signal.aborted, false, "closing the stream does not close its API");
  } finally {
    api.close();
    await stream.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("response consumers release fetch on EOF and processing failure", async () => {
  const signals: AbortSignal[] = [];
  const api = new GatewayApi({ baseUrl: "http://old", token: "old" }, async (_url, init) => {
    signals.push(init!.signal!);
    return new Response("body");
  });
  assert.equal(await api.consumeResponse("/events", {}, async (response) => {
    assert.equal(signals[0].aborted, false);
    return response.text();
  }), "body");
  assert.equal(signals[0].aborted, true);
  const failure = new Error("consumer failed");
  await assert.rejects(api.consumeResponse("/events", {}, async () => { throw failure; }), failure);
  assert.equal(signals[1].aborted, true);
  api.close();
});

test("SSE ignores bytes delivered after closing even if its reader ignores cancellation", async () => {
  const opened = Promise.withResolvers<void>();
  const read = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
  let cancelledReads = 0;
  const response = {
    ok: true, status: 200,
    body: { getReader: () => ({ read: () => read.promise, cancel: () => { cancelledReads++; return Promise.resolve(); } }) },
  } as unknown as Response;
  const api = new GatewayApi({ baseUrl: "http://old", token: "old" }, async () => response);
  const events: unknown[] = [];
  const stream = new EventStream(api, 0, {
    event: (event) => events.push(event), transient: (event) => events.push(event),
    resync: () => events.push("resync"),
    state: (state) => { if (state === "open") opened.resolve(); },
  });
  await opened.promise;
  api.close();
  await stream.done;
  read.resolve({ done: false, value: new TextEncoder().encode("event: message.user\\ndata: {\\\"seq\\\":1}\\n\\n") });
  await Promise.resolve();
  assert.equal(cancelledReads > 0, true);
  assert.deepEqual(events, []);
});

test("closing a session clears old state and ignores a late command response", async () => {
  let respond!: (value: Response) => void;
  let revoked = 0;
  const fetchImpl: Fetch = async (url) => {
    if (String(url).endsWith("/conversations")) return new Promise<Response>((resolve) => { respond = resolve; });
    return Response.json({ conversations: [], as_of_seq: 0 });
  };
  const old = new ChatSession({ baseUrl: "http://first", token: "one", computerId: "first" }, fetchImpl, { retryDelays: [100] }, () => { revoked++; });
  old.conversations.set("same", {
    id: "same", agent_id: "assistant", title: "old", created_at: 1, updated_at: 1,
    status: "idle", unread: false, read_seq: 0, last_text: null, source: "user", schedule_origin: null,
    activity: null, lastTextSeq: 0, lastActivityAt: null, lastAgentSeq: 0,
  });
  const starting = old.start();
  await old.close();
  await starting;
  assert.equal(old.conversations.size, 0);
  assert.equal(old.timelines.size, 0);
  assert.equal(old.pending.size, 0);
  respond(new Response(null, { status: 401 }));
  await Promise.resolve();
  assert.equal(revoked, 0);
  await old.start();
  assert.equal(old.conversations.size, 0);
  const next = new GatewayApi({ baseUrl: "http://second", token: "two", computerId: "second" }, async () => Response.json({ conversations: [], as_of_seq: 0 }));
  assert.deepEqual((await next.listConversations()).conversations, []);
  next.close();
});

test("transport failures keep their cause out of display messages without changing retryability", async () => {
  const cause = new TypeError("fetch failed: private transport detail");
  const api = new GatewayApi({ baseUrl: "http://gateway", token: "test" }, async () => { throw cause; });
  try {
    for (const request of [() => api.createConversation("agent"), () => api.readBinary("/image")]) {
      await assert.rejects(request, (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.equal(error.status, 0);
        assert.equal(error.code, "network");
        assert.equal(error.retryable, true);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.match(error.message, /连接|网络/);
        return true;
      });
    }
  } finally { api.close(); }
});

test("HTTP refusals retain business details; absent or malformed messages use localized status fallbacks", async () => {
  const conflict = { current: { version: "new" } };
  const responses = [
    Response.json({ error: { code: "memory_conflict", message: "记忆已被修改，请重新载入", details: conflict } }, { status: 409 }),
    new Response("proxy diagnostic", { status: 502, statusText: "Bad Gateway" }),
    Response.json({ error: { message: { detail: "private parser detail" } } }, { status: 400 }),
    Response.json({ error: { message: "" } }, { status: 403 }),
  ];
  const api = new GatewayApi({ baseUrl: "http://gateway", token: "test" }, async () => responses.shift()!);
  try {
    await assert.rejects(api.listAgents(), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "memory_conflict");
      assert.deepEqual(error.details, conflict);
      assert.equal(error.retryable, false);
      return true;
    });
    await assert.rejects(api.readBinary("/image"), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, 502);
      assert.equal(error.retryable, true);
      assert.ok(!error.message.includes("Bad Gateway"));
      assert.match(error.message, /网关/);
      return true;
    });
    await assert.rejects(api.createConversation("agent"), (error: unknown) =>
      error instanceof GatewayError && error.status === 400 && !error.retryable && /提交内容/.test(error.message));
    await assert.rejects(api.listAgents(), (error: unknown) =>
      error instanceof GatewayError && error.status === 403 && !error.retryable && /权限/.test(error.message));
  } finally { api.close(); }
});
