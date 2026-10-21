import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import type { BrowserTask, GatewayEvent } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";

const task: BrowserTask = {
  id: "lease", task_id: "child", root_id: "conversation", agent_id: "desktop", entry_agent_id: "writer",
  conversation_title: "Research", entry_agent_name: "Writer", state: "agent", epoch: 1,
  pages: [{ id: "page", title: "Research", url: "https://example.org" }], current: "page", max_pages: 8,
  reason: null, requested_reason: null,
};
function event(seq: number, type: string, data: Record<string, unknown>): GatewayEvent {
  return { seq, type, data, conversation_id: task.root_id, at: seq };
}

test("lease updates replace one anchored card and handback stays after it", () => {
  const events = [event(1, "message.user", { text: "research" }), event(2, "browser_task.updated", task),
    event(3, "browser_task.updated", { ...task, state: "human", epoch: 2 }),
    event(4, "takeover.ended", { id: task.id, duration_seconds: 80, text: "returned" }),
    event(5, "browser_task.updated", { ...task, epoch: 3 })];
  const live = { ...task, state: "released" as const, pages: [], reason: "用户关闭" };
  const items = buildItems(events, [], new Map([[task.id, live]]));
  assert.deepEqual(items.map((item) => item.key), ["e1", "blease", "e4"]);
  assert.equal(items[1].event?.seq, 2);
  assert.equal(items[1].browser?.state, "released");
  assert.equal(buildItems(events, [])[1].browser?.epoch, 3);
});

/** Drive the public HTTP/SSE boundaries; delayed snapshots model an actual response race. */
async function connected() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let resolveSnapshot!: (response: Response) => void;
  const session = new ChatSession({ baseUrl: "http://gateway", token: "dev" }, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/events") return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
    if (path === "/browser-tasks") return new Promise<Response>((resolve) => {
      resolveSnapshot = resolve;
    });
    if (path === "/agents") return Response.json({ agents: [], as_of_seq: 10 });
    if (path === "/conversations") return Response.json({ conversations: [], as_of_seq: 10 });
    throw new Error(`Unexpected request ${path}`);
  });
  await session.start();
  await setImmediate();
  return {
    session,
    snapshot(tasks: BrowserTask[], seq: number) { resolveSnapshot(Response.json({ browser_tasks: tasks, as_of_seq: seq })); },
    send(value: GatewayEvent) { stream.enqueue(new TextEncoder().encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)); },
  };
}

test("SSE requested attention survives an older snapshot and read receipt, clears on control change", async () => {
  const wire = await connected();
  try {
    wire.send(event(12, "browser_task.updated", { ...task, state: "requested" }));
    await setImmediate();
    const loading = wire.session.refreshBrowserTasks();
    wire.snapshot([task], 10);
    await loading;
    assert.equal(wire.session.requestedBrowser("writer")?.task_id, "child");
    assert.equal(wire.session.requestedBrowser("desktop"), undefined);
    wire.send(event(13, "conversation.read", { seq: 12 }));
    await setImmediate();
    assert.equal(wire.session.requestedBrowser("writer")?.id, task.id);
    wire.send(event(14, "browser_task.updated", { ...task, state: "human", epoch: 2 }));
    await setImmediate();
    assert.equal(wire.session.requestedBrowser("writer"), undefined);
    assert.equal(wire.session.browserTasks.get(task.id)?.epoch, 2);
  } finally { await wire.session.close(); }
});

test("deleted conversation cannot be resurrected by an in-flight browser list", async () => {
  const wire = await connected();
  try {
    wire.send(event(12, "browser_task.updated", task));
    wire.send(event(13, "conversation.deleted", { id: task.root_id, agent_id: task.entry_agent_id }));
    await setImmediate();
    const loading = wire.session.refreshBrowserTasks();
    wire.snapshot([task], 10);
    await loading;
    assert.equal(wire.session.browserTasks.has(task.id), false);
    assert.equal(wire.session.isDeleted(task.root_id), true);
  } finally { await wire.session.close(); }
});

test("browser list cannot roll back a newer conversation title", async () => {
  const wire = await connected();
  try {
    wire.send(event(11, "conversation.created", { agent_id: task.entry_agent_id, title: "Research" }));
    wire.send(event(12, "browser_task.updated", task));
    wire.send(event(14, "conversation.updated", { title: "Renamed research" }));
    await setImmediate();
    const loading = wire.session.refreshBrowserTasks();
    wire.snapshot([task], 13);
    await loading;
    assert.equal(wire.session.browserTasks.get(task.id)?.conversation_title, "Renamed research");
  } finally { await wire.session.close(); }
});

test("closed session ignores outstanding browser snapshot", async () => {
  const wire = await connected();
  const loading = wire.session.refreshBrowserTasks();
  await wire.session.close();
  wire.snapshot([task], 10);
  await loading;
  assert.equal(wire.session.browserTasks.has(task.id), false);
});
