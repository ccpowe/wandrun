import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import { GatewayApi } from "../src/gateway/api.ts";
import { EventStream, type StreamOptions, type StreamState } from "../src/gateway/stream.ts";
import { setNetworkDiagnosticSink } from "../src/gateway/network-diagnostics.ts";

async function fixture(t: TestContext, options: StreamOptions = {}, initial: "open" | "failed" | "connecting" | "http-error" | "missing-body" = "open") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Match RN's abort-controller: abort(reason) is ignored and signal.reason is absent.
  const abort = AbortController.prototype.abort;
  t.mock.method(AbortController.prototype, "abort", function (this: AbortController) { abort.call(this); });
  t.mock.getter(AbortSignal.prototype, "reason", () => undefined);
  const requests: { cursor: string | null; signal: AbortSignal; body?: ReadableStreamDefaultController<Uint8Array> }[] = [];
  const states: StreamState[] = [];
  const events: number[] = [];
  const diagnostics: { event: string; generation: number; reason?: string; received?: boolean }[] = [];
  setNetworkDiagnosticSink(message => diagnostics.push(JSON.parse(message)));
  const api = new GatewayApi({ baseUrl: "http://resume", token: "dev" }, async (url, init) => {
    assert.equal(String(url), "http://resume/events");
    assert.equal(new Headers(init?.headers).get("Accept-Encoding"), "identity");
    const request: typeof requests[number] = { cursor: new Headers(init?.headers).get("Last-Event-ID"), signal: init!.signal! };
    requests.push(request);
    if (requests.length === 1 && initial === "failed") throw new TypeError("offline");
    if (requests.length === 1 && initial === "connecting") return new Promise<Response>(() => {});
    if (requests.length === 1 && initial === "http-error") return new Response("unavailable", { status: 503 });
    if (requests.length === 1 && initial === "missing-body") return new Response(null, { status: 204 });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { request.body = controller; } }));
  });
  const stream = new EventStream(api, 7, {
    event(event) { events.push(event.seq); }, transient() {}, resync() {}, state(state) { states.push(state); },
  }, { retryDelays: [60_000], ...options });
  t.after(async () => { api.close(); await stream.close(); setNetworkDiagnosticSink(undefined); });
  await setImmediate();
  return {
    api, stream, requests, states, events, diagnostics,
    async send(text = ": heartbeat\n\n") {
      requests.at(-1)!.body!.enqueue(new TextEncoder().encode(text));
      await setImmediate();
    },
    async tick(milliseconds: number) {
      t.mock.timers.tick(milliseconds);
      await setImmediate();
      t.mock.timers.tick(0); // Run the zero-delay retry after asynchronous reader cancellation.
      await setImmediate();
    },
  };
}

test("replacement opens immediately even after fresh bytes and replays each durable seq once", async (t) => {
  const f = await fixture(t);
  await f.send('event: message.user\ndata: {"seq":42,"type":"message.user","data":{}}\n\n');
  f.stream.reconnectNow();
  assert.equal(f.requests[0].signal.aborted, true);
  await f.tick(0);
  assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason, "recover");
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].cursor, "42");
  await f.send('event: message.user\ndata: {"seq":42,"type":"message.user","data":{}}\n\nevent: message.user\ndata: {"seq":43,"type":"message.user","data":{}}\n\n');
  assert.deepEqual(f.events, [42, 43]);
  assert.equal(f.states.at(-1), "open");
});

test("idle deadline still replaces a connection with no bytes", async (t) => {
  const f = await fixture(t, { idleTimeout: 45 });
  await f.tick(44);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.states.at(-1), "reconnecting");
  assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason, "idle_timeout");
  await f.tick(60_000); // A stream that never delivered bytes retains its failure backoff.
  assert.equal(f.requests.length, 2);
});

for (const initial of ["failed", "connecting"] as const) {
  test(`recovery skips backoff while ${initial}`, async (t) => {
    const f = await fixture(t, {}, initial);
    assert.equal(f.states.at(-1), initial === "failed" ? "reconnecting" : "connecting");
    f.stream.reconnectNow();
    await f.tick(0);
    assert.equal(f.requests.length, 2);
    assert.equal(f.states.at(-1), "open");
    assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason,
      initial === "connecting" ? "recover" : "request_error");
  });
}

test("an open response without bytes is replaced rather than treated as healthy", async (t) => {
  const f = await fixture(t);
  f.stream.reconnectNow();
  await f.tick(0);
  assert.equal(f.requests.length, 2);
});

test("close prevents a pending replacement from resurrecting the stream", async (t) => {
  const f = await fixture(t);
  f.stream.reconnectNow();
  await f.stream.close();
  await f.tick(60_000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.states.at(-1), "stopped");
  assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason, "recover");
});

test("explicit close records a stopped end reason", async (t) => {
  const f = await fixture(t);
  await f.stream.close();
  assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason, "stopped");
});

test("network failure is redacted and keeps failure backoff; bytes then EOF retry immediately", async (t) => {
  const f = await fixture(t, { retryDelays: [1000] }, "failed");
  assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason, "request_error");
  await f.tick(999);
  assert.equal(f.requests.length, 1);
  await f.tick(1);
  assert.equal(f.requests.length, 2);
  await f.send();
  await f.send();
  const generation = f.diagnostics.filter(log => log.event === "sse_start").at(-1)!.generation;
  assert.deepEqual(f.diagnostics.filter(log => log.generation === generation).map(log => log.event),
    ["sse_start", "sse_headers", "sse_first_byte"]);
  f.requests.at(-1)!.body!.close();
  await f.tick(0);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.diagnostics.find(log => log.generation === generation && log.event === "sse_end"),
    { event: "sse_end", generation, reason: "stream_closed", received: true });
  assert.equal(JSON.stringify(f.diagnostics).includes("offline"), false, "exception messages must not enter diagnostics");
});

test("reader error after bytes retains successful-stream retry and close ends without resurrection", async (t) => {
  const f = await fixture(t);
  await f.send();
  f.requests[0].body!.error(new Error("https://private.test/events?token=secret"));
  await f.tick(0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason, "request_error");
  await f.stream.close();
  assert.equal(f.diagnostics.filter(log => log.event === "sse_end").at(-1)?.reason, "stopped");
  await f.tick(60_000);
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.stringify(f.diagnostics).includes("secret"), false);
});

for (const initial of ["http-error", "missing-body"] as const) {
  test(`${initial} records a controlled reason and retains backoff`, async (t) => {
    const f = await fixture(t, { retryDelays: [100] }, initial);
    assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason,
      initial === "http-error" ? "http_error" : "missing_body");
    await f.tick(99);
    assert.equal(f.requests.length, 1);
    await f.tick(1);
    assert.equal(f.requests.length, 2);
  });
}

test("invalid event records its category and session close stops the replacement", async (t) => {
  const f = await fixture(t);
  await f.send("event: message.user\ndata: invalid-json\n\n");
  await f.tick(0);
  assert.equal(f.diagnostics.find(log => log.event === "sse_end")?.reason, "invalid_event");
  assert.equal(f.requests.length, 2);
  f.api.close();
  await f.stream.done;
  assert.equal(f.diagnostics.filter(log => log.event === "sse_end").at(-1)?.reason, "stopped");
  await f.tick(60_000);
  assert.equal(f.requests.length, 2);
});
