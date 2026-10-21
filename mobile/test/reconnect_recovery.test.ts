import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

import { GatewayApi, GatewayError, type AgentSummary, type BrowserTask, type Conversation, type TaskConversation } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";

const root: Conversation = {
  id: "root", agent_id: "writer", title: "Before", created_at: 1, updated_at: 1,
  read_seq: 0, status: "working", unread: false, last_text: null, source: "user", schedule_origin: null,
};
const agent = (name: string): AgentSummary => ({
  id: "writer", name, avatar: 1, description: "", workers: [], home: true, latest_conversation: null, unread: false,
});
const browserTask = (title: string): BrowserTask => ({
  id: "lease", task_id: "task", root_id: "root", agent_id: "writer", entry_agent_id: "writer",
  conversation_title: title, entry_agent_name: "Writer", state: "agent", epoch: 1,
  pages: [], current: null, max_pages: 3, reason: null, requested_reason: null,
});
const collaboration = (title: string): TaskConversation => ({
  id: "task", task_id: "task", kind: "task", root_id: "root", root_title: "Before",
  creator_task_id: "root", creator_agent_id: "writer", agent_id: "writer", initiator: "human", recipient: "writer",
  title, status: "running", error: null, unread: false, read_seq: 0, created_at: 1, updated_at: 1,
  branch_working: true,
});
const json = (value: object) => Response.json(value);
async function until(check: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("recovery deadline expired");
    await setImmediate();
  }
}

// The native fetch/body can ignore abort entirely. The JS deadline must still release the caller.
test("finite JSON reads settle at the deadline through both headers and body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  let unauthorized = 0;
  const api = new GatewayApi({ baseUrl: "http://gateway", token: "dev" }, async (input, init) => {
    signals.push(init!.signal!);
    const path = new URL(String(input)).pathname;
    if (path === "/agents") return new Promise<Response>(() => {});
    if (path === "/browser-tasks") return new Response(new ReadableStream({ start() {} }));
    throw Error(`unexpected ${path}`);
  }, () => { unauthorized++; });
  t.after(() => api.close());
  for (const read of [() => api.listAgents(), () => api.listBrowserTasks()]) {
    const pending = read();
    await setImmediate();
    t.mock.timers.tick(15_000);
    await assert.rejects(pending, (error: unknown) => error instanceof GatewayError && error.code === "timeout" && /读取超时/.test(error.message));
    assert.equal(signals.at(-1)?.aborted, true);
  }
  assert.equal(unauthorized, 0);
});

for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
  test(`${method} survives the read deadline and recovery but remains bound to the session`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const response = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const api = new GatewayApi({ baseUrl: "http://gateway", token: "dev" }, async (_input, init) => {
      signals.push(init!.signal!);
      return signals.length === 1 ? response.promise : new Promise<Response>(() => {});
    });
    t.after(() => api.close());
    const command = () => {
      switch (method) {
        case "POST": return api.createConversation("writer");
        case "PATCH": return api.renameConversation("root", "Renamed");
        case "PUT": return api.updateAgentMemory("writer", "Remember this", "old-version");
        case "DELETE": return api.deleteConversation("root");
      }
    };
    let settled = false;
    const pending = command();
    void pending.then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(16_000);
    api.cancelReads();
    await setImmediate();
    assert.equal(settled, false, "read deadline and recovery cannot settle a command");
    assert.equal(signals[0].aborted, false);
    response.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } })));
    await setImmediate();
    t.mock.timers.tick(16_000);
    await setImmediate();
    assert.equal(settled, false, "the response body also has no new common deadline");
    body.enqueue(new TextEncoder().encode(JSON.stringify(root)));
    body.close();
    await pending;
    assert.equal(signals.length, 1, "a slow command is never replayed");

    const closing = command();
    api.close();
    await assert.rejects(closing, (error: unknown) => error instanceof GatewayError && error.code === "cancelled");
    assert.equal(signals[1].aborted, true);
    assert.equal(signals.length, 2, "closing the session does not replay the command");
  });
}

test("a reset generation marks an in-flight command unknown but leaves reads as network errors", async (t) => {
  const commandResponse = Promise.withResolvers<Response>();
  const readResponse = Promise.withResolvers<Response>();
  let request = 0;
  const api = new GatewayApi({ baseUrl: "http://gateway", token: "dev" }, async (_input, init) => {
    request++;
    return init?.method === "POST" ? commandResponse.promise : readResponse.promise;
  });
  t.after(() => api.close());

  const command = api.createConversation("writer");
  await setImmediate();
  api.resetConnections();
  commandResponse.reject(new Error("socket closed by reset"));
  await assert.rejects(command, (error: unknown) =>
    error instanceof GatewayError && error.code === "timeout" && error.message === "操作结果未确认。请重新加载核对结果。");

  const read = api.history("root");
  await setImmediate();
  api.resetConnections();
  readResponse.reject(new Error("socket closed by reset"));
  await assert.rejects(read, (error: unknown) =>
    error instanceof GatewayError && error.code === "network" && error.message === "连不上电脑，请检查网络和网关连接");
  const failedResponse = Promise.withResolvers<Response>();
  const failed = new GatewayApi({ baseUrl: "http://gateway", token: "dev" },
    async () => failedResponse.promise, undefined, () => { throw new Error("reset failed"); });
  t.after(() => failed.close());
  const failedCommand = failed.createConversation("writer");
  await setImmediate();
  assert.throws(() => failed.resetConnections(), /reset failed/);
  failedResponse.reject(new Error("socket closed by failed reset"));
  await assert.rejects(failedCommand, (error: unknown) =>
    error instanceof GatewayError && error.code === "timeout" && error.message === "操作结果未确认。请重新加载核对结果。");

  const offline = new GatewayApi({ baseUrl: "http://gateway", token: "dev" }, async () => {
    throw new Error("offline");
  });
  t.after(() => offline.close());
  await assert.rejects(offline.createConversation("writer"), (error: unknown) =>
    error instanceof GatewayError && error.code === "network" && error.message === "连不上电脑，请检查网络和网关连接");
});

for (const first of ["no-headers", "body", "backoff"] as const) {
  test(`initial list ${first} is restarted by resume without creating a second start loop`, async (t) => {
    let lists = 0;
    let stalledBody: ReadableStreamDefaultController<Uint8Array> | undefined;
    const session = new ChatSession({ baseUrl: "http://gateway", token: "dev" }, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/conversations") {
        if (++lists === 1) {
          if (first === "no-headers") return new Promise<Response>(() => {});
          if (first === "body") return new Response(new ReadableStream<Uint8Array>({
            start(controller) { stalledBody = controller; },
          }));
          return new Response("down", { status: 503 });
        }
        return json({ conversations: [root], as_of_seq: 0 });
      }
      if (path === "/events") return new Response(new ReadableStream({ start() {} }));
      if (path === "/agents") return json({ agents: [], as_of_seq: 0 });
      if (path === "/browser-tasks") return json({ browser_tasks: [], as_of_seq: 0 });
      throw Error(`unexpected ${path}`);
    });
    t.after(() => session.close());
    const starting = session.start();
    await until(() => lists === 1 && (first !== "backoff" || session.connection === "error"));
    session.resume();
    const sameStart = session.start();
    assert.equal(sameStart, starting);
    await starting;
    await until(() => session.connection === "open");
    assert.equal(lists, 2, "resume must not wait for the abandoned headers or list backoff");
    assert.equal(session.conversations.get("root")?.title, "Before");
    stalledBody?.enqueue(new TextEncoder().encode(JSON.stringify({ conversations: [{ ...root, title: "Stale" }], as_of_seq: 0 })));
    stalledBody?.close();
    await setImmediate();
    assert.equal(session.conversations.get("root")?.title, "Before", "the obsolete body cannot overwrite the new list");
  });
}

test("fresh-but-dead SSE recovery preserves a visible preview and pending send while replaying each durable event once", async (t) => {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const cursors: string[] = [];
  let sends = 0;
  const session = new ChatSession({ baseUrl: "http://gateway", token: "dev" }, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/conversations" && init?.method === "GET") return json({ conversations: [root], as_of_seq: 0 });
    if (path === "/events") {
      cursors.push(new Headers(init?.headers).get("Last-Event-ID")!);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }));
    }
    if (path === "/agents") return json({ agents: [], as_of_seq: 0 });
    if (path === "/browser-tasks") return json({ browser_tasks: [], as_of_seq: 0 });
    if (path.endsWith("/messages")) { sends++; return new Promise<Response>(() => {}); }
    throw Error(`unexpected ${path}`);
  });
  t.after(() => session.close());
  await session.start();
  await until(() => streams.length === 1 && session.connection === "open");
  const send = (index: number, payload: object) => {
    const type = "seq" in payload && "type" in payload ? String(payload.type) : "draft.snapshot";
    streams[index].enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  };
  send(0, { type: "draft.snapshot", data: { epoch: "one", revision: 1, as_of_seq: 0, drafts: [
    { draft_id: "preview", conversation_id: "root", sender: "task", agent: "writer", text: "Visible", phase: null },
  ] } });
  await until(() => session.draftsFor("root").length === 1);
  const sending = session.send("root", "pending");
  await until(() => sends === 1);
  session.resume();
  await until(() => streams.length === 2 && session.connection === "open");
  assert.deepEqual(cursors, ["0", "0"]);
  assert.equal(session.draftsFor("root")[0].text, "Visible");
  assert.equal(session.pendingFor("root")[0].text, "pending");
  const updated = { seq: 1, type: "conversation.updated", conversation_id: "root", at: 2, data: { title: "After" } };
  send(1, updated);
  send(1, updated);
  await until(() => session.conversations.get("root")?.title === "After");
  assert.deepEqual(session.timeline("root").events.map((event) => event.seq), [1]);
  assert.equal(session.pendingFor("root")[0].text, "pending");
  assert.equal(sends, 1, "reconnect never replays a command");
  send(1, { type: "draft.snapshot", data: { epoch: "two", revision: 0, as_of_seq: 1, drafts: [] } });
  await until(() => session.draftsFor("root").length === 0);
  await session.close();
  await sending;
});

test("SSE recovery detaches hung agents, browser and collaboration snapshots; late old bodies cannot roll back", async (t) => {
  const oldAgents = Promise.withResolvers<Response>();
  const oldBrowser = Promise.withResolvers<Response>();
  const oldScope = Promise.withResolvers<Response>();
  let agentReads = 0;
  let browserReads = 0;
  let scopeReads = 0;
  let sseReads = 0;
  const session = new ChatSession({ baseUrl: "http://gateway", token: "dev" }, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/conversations") return json({ conversations: [root], as_of_seq: 0 });
    if (path === "/events") { sseReads++; return new Response(new ReadableStream({ start() {} })); }
    if (path === "/agents") {
      agentReads++;
      return agentReads === 1 ? json({ agents: [agent("Before")], as_of_seq: 0 })
        : agentReads === 2 ? oldAgents.promise : json({ agents: [agent("After")], as_of_seq: 1 });
    }
    if (path === "/browser-tasks") {
      browserReads++;
      return browserReads === 1 ? json({ browser_tasks: [browserTask("Before")], as_of_seq: 0 })
        : browserReads === 2 ? oldBrowser.promise : json({ browser_tasks: [browserTask("After")], as_of_seq: 1 });
    }
    if (path === "/agents/writer/conversations") {
      scopeReads++;
      return scopeReads === 1 ? oldScope.promise : json({ conversations: [collaboration("After")], as_of_seq: 1 });
    }
    if (path === "/agents/writer/collaborations") return json({ conversations: [], as_of_seq: 1 });
    throw Error(`unexpected ${path}`);
  });
  t.after(() => { oldAgents.resolve(json({ agents: [], as_of_seq: 0 })); oldBrowser.resolve(json({ browser_tasks: [], as_of_seq: 0 })); oldScope.resolve(json({ conversations: [], as_of_seq: 0 })); return session.close(); });
  await session.start();
  await until(() => session.agents.loaded && session.browserTasks.has("lease"));
  session.agents.refresh();
  void session.refreshBrowserTasks();
  void session.refreshCollaborations("writer");
  await until(() => agentReads === 2 && browserReads === 2 && scopeReads === 1);
  session.resume();
  await until(() => sseReads === 2 && session.agents.agents[0]?.name === "After" &&
    session.browserTasks.get("lease")?.conversation_title === "After" && session.tasks.get("task")?.title === "After");
  oldAgents.resolve(json({ agents: [agent("Stale")], as_of_seq: 1 }));
  oldBrowser.resolve(json({ browser_tasks: [browserTask("Stale")], as_of_seq: 1 }));
  oldScope.resolve(json({ conversations: [collaboration("Stale")], as_of_seq: 1 }));
  await setImmediate();
  assert.equal(session.agents.agents[0].name, "After");
  assert.equal(session.browserTasks.get("lease")?.conversation_title, "After");
  assert.equal(session.tasks.get("task")?.title, "After");
});

test("a recovery hint during cooldown is delivered at the bound after an offline first attempt", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cursors: string[] = [];
  let offline = false;
  const session = new ChatSession({ baseUrl: "http://gateway", token: "dev" }, async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/conversations") return json({ conversations: [root], as_of_seq: 0 });
    if (path === "/events") {
      cursors.push(new Headers(init?.headers).get("Last-Event-ID")!);
      return offline ? new Response("down", { status: 503 }) : new Response(new ReadableStream({ start() {} }));
    }
    if (path === "/agents") return json({ agents: [], as_of_seq: 0 });
    if (path === "/browser-tasks") return json({ browser_tasks: [], as_of_seq: 0 });
    throw Error(`unexpected ${path}`);
  }, { retryDelays: [60_000] });
  t.after(() => session.close());
  await session.start();
  await setImmediate();
  offline = true;
  session.resume();
  t.mock.timers.tick(0);
  await setImmediate();
  t.mock.timers.tick(0);
  await setImmediate();
  for (let i = 0; i < 10 && cursors.length < 2; i++) await setImmediate();
  assert.equal(cursors.length, 2);
  now += 1000;
  offline = false;
  for (let i = 0; i < 20; i++) session.resume();
  t.mock.timers.tick(3999);
  await setImmediate();
  assert.equal(cursors.length, 2);
  now += 4000;
  t.mock.timers.tick(1);
  await setImmediate();
  t.mock.timers.tick(0);
  await setImmediate();
  assert.equal(cursors.length, 3, "the latest network hint does not wait for SSE's long backoff");
  assert.equal(session.connection, "open");
});

test("rapid active and network hints coalesce once the replacement stream delivers bytes", async (t) => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const session = new ChatSession({ baseUrl: "http://gateway", token: "dev" }, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/conversations") return json({ conversations: [root], as_of_seq: 0 });
    if (path === "/events") return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }));
    if (path === "/agents") return json({ agents: [], as_of_seq: 0 });
    if (path === "/browser-tasks") return json({ browser_tasks: [], as_of_seq: 0 });
    throw Error(`unexpected ${path}`);
  }, { retryDelays: [60_000] });
  t.after(() => session.close());
  await session.start();
  await setImmediate();
  session.resume();
  for (let i = 0; i < 20; i++) session.resume();
  t.mock.timers.tick(0);
  await setImmediate();
  t.mock.timers.tick(0);
  await setImmediate();
  assert.equal(streams.length, 2);
  streams[1].enqueue(new TextEncoder().encode(": heartbeat\n\n"));
  await setImmediate();
  now += 100;
  session.resume(); // same native notification burst after the first byte
  now += 4900;
  t.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(streams.length, 2, "a healthy replacement cancels the pending duplicate recovery");
});
