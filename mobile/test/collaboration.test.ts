import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ChatSession } from "../src/gateway/session.ts";
import { type GatewayEvent, type TaskConversation } from "../src/gateway/api.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";
import { searchDestination } from "../src/lib/file-delivery.ts";
import { affectsAgentList } from "../src/gateway/agents.ts";
import { collaborationEvents } from "./fixtures/collaboration-timeline.ts";

const sessions: ChatSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); });
function setup(fetcher?: typeof fetch) {
  const session = new ChatSession({ baseUrl: "http://collaboration", token: "test" }, fetcher);
  sessions.push(session);
  session.agents.close();
  session["reset"]([{ id: "root", agent_id: "planner", title: "Root", status: "idle", unread: false,
    read_seq: 0, last_agent_seq: 0, created_at: 1, updated_at: 1, last_text: null, source: "user", schedule_origin: null }], 1);
  session.connection = "open";
  return session;
}
function event(seq: number, type: string, data: Record<string, unknown>): GatewayEvent {
  return { seq, type, conversation_id: "root", at: seq, data };
}
function create(session: ChatSession, id = "child", creator = "root", seq = 2) {
  session["apply"](event(seq, "task.created", { task_id: id, creator_task_id: creator,
    creator_agent_id: creator === "root" ? "planner" : "search", agent_id: id === "child" ? "search" : "browser",
    title: id, summary: id, status: "running", timeline_ids: [creator, id],
    branch_activity: { ...(creator === "root" ? {} : { [creator]: true }), [id]: true } }));
}
function task(): TaskConversation {
  return { id: "child", task_id: "child", kind: "task", root_id: "root", root_title: "Root", creator_task_id: "root",
    creator_agent_id: "planner", agent_id: "search", initiator: "planner", recipient: "search", title: "child",
    status: "running", error: null, unread: false, read_seq: 0, created_at: 2, updated_at: 2, branch_working: true };
}
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test("root history excludes Agent-to-Agent bodies between delegations while member history keeps both directions", () => {
  const session = setup();
  for (const entry of collaborationEvents) session["apply"](entry);
  const history = session.timeline("root").events;
  assert.ok(history.some((entry) => entry.seq === 11), "transport retains the shared root endpoint event");
  const rootItems = buildItems(history, [], undefined, [], undefined, "root", session.tasks);
  assert.deepEqual(rootItems.map((row) => [row.key, row.event?.seq, row.delegation?.status]), [
    ["tsearch-1", 10, "completed"], ["tsearch-2", 12, "running"],
  ], "invisible bodies, file notices and receipts must not create separator-bearing rows");
  assert.deepEqual(buildItems(history, []).map((row) => row.key), ["tsearch-1", "tsearch-2"],
    "omitting timelineId still means the envelope's root, not an arbitrary member");

  const memberItems = buildItems(session.timeline("search-1").events, [], undefined, [], undefined, "search-1", session.tasks);
  assert.deepEqual(memberItems.map((row) => row.event?.seq), [11, 32, 37, 38, 39, 67, 81]);
  assert.equal(memberItems[0].event?.data.recipient_task_id, "search-1", "parent instructions remain incoming");
  assert.equal(memberItems.at(-1)?.event?.data.sender_task_id, "search-1", "results to the parent remain outgoing");
});

test("member-to-member messages remain visible only to their endpoints, not to the root", () => {
  const entry = event(90, "message.task", {
    task_id: "nested", sender_task_id: "child", sender_agent_id: "search",
    recipient_task_id: "nested", recipient_agent_id: "browser", text: "Check the source",
    attachments: [], timeline_ids: ["child", "nested"],
  });
  for (const id of ["child", "nested"]) {
    assert.deepEqual(buildItems([entry], [], undefined, [], undefined, id).map((row) => row.key), ["e90"]);
  }
  for (const id of ["root", "other-member"]) {
    assert.deepEqual(buildItems([entry], [], undefined, [], undefined, id), []);
  }
});

test("nested delivery fans out once; interjections and member replies never become root messages or home activity", () => {
  const session = setup();
  create(session);
  create(session, "nested", "child", 3);
  const delivery = event(4, "message.task", { task_id: "child", sender_task_id: "nested", recipient_task_id: "child",
    text: "result", timeline_ids: ["nested", "child"], attachments: [{ id: "file", name: "result.md" }] });
  session["apply"](delivery);
  session["apply"](delivery);
  for (const type of ["message.user", "message.agent"]) {
    const message = event(type === "message.user" ? 5 : 6, type, { task_id: "child", text: type, timeline_ids: ["child"] });
    session["apply"](message);
    assert.equal(affectsAgentList(message), false);
  }
  assert.deepEqual(session.timeline("root").events.map((e) => e.seq), [2]);
  assert.deepEqual(session.timeline("nested").events.map((e) => e.seq), [3, 4]);
  assert.deepEqual(session.timeline("child").events.map((e) => e.seq), [2, 3, 4, 5, 6]);
  assert.equal(session.tasks.get("child")!.unread, true);
  assert.equal(session.conversations.get("root")!.unread, false);
  assert.equal(session.conversations.get("root")!.last_text, null);
  session["apply"](event(7, "task.read", { task_id: "child", seq: 6, timeline_ids: ["child"] }));
  assert.equal(session.tasks.get("child")!.unread, false);
  assert.equal(session.tasks.get("nested")!.unread, true);
  const rootItems = buildItems(session.timeline("root").events, [], undefined, [], undefined, "root", session.tasks);
  const childItems = buildItems(session.timeline("child").events, [], undefined, [], undefined, "child", session.tasks);
  assert.deepEqual(rootItems.map((row) => row.delegation?.taskId), ["child"]);
  assert.deepEqual(childItems.filter((row) => row.delegation).map((row) => row.delegation?.taskId), ["nested"]);
});

test("member media keeps root coordinates without leaking rows, and deletion invalidates the viewer source", () => {
  const session = setup();
  create(session);
  const image = event(3, "message.agent", { task_id: "child", text: "![chart](https://example.org/chart.png)", timeline_ids: ["child"] });
  session["apply"](image);
  assert.equal(session.messageAt("root", 3), image);
  assert.equal(session.messageAt("child", 3), undefined);
  assert.equal(session.messageAt("another-root", 3), undefined);
  assert.equal(session.timeline("root").events.some((e) => e.seq === 3), false);
  session["apply"](event(4, "conversation.deleted", { id: "root" }));
  assert.equal(session.messageAt("root", 3), undefined);
});

test("a settled parent remains stoppable while a nested descendant runs, but unrelated branches do not", () => {
  const session = setup();
  create(session);
  create(session, "nested", "child", 3);
  session.conversations.get("root")!.status = "working";
  session["apply"](event(4, "task.status", { task_id: "child", status: "completed", timeline_ids: ["root", "child"],
    branch_activity: { child: true } }));
  assert.equal(session.isWorking("root"), true);
  assert.equal(session.isWorking("child"), true);
  assert.equal(session.isWorking("other"), false);
  session["apply"](event(5, "task.status", { task_id: "nested", status: "cancelled", timeline_ids: ["child", "nested"],
    branch_activity: { child: false, nested: false } }));
  session.conversations.get("root")!.status = "idle";
  assert.equal(session.isWorking("root"), false);
  assert.equal(session.isWorking("child"), false);
});

test("stale list cannot roll back live status/read state or resurrect a deleted branch", async () => {
  const responses: ((response: Response) => void)[] = [];
  const session = setup(async () => new Promise<Response>((resolve) => responses.push(resolve)));
  create(session);
  const loading = session.refreshCollaborations("planner");
  session["apply"](event(20, "task.status", { task_id: "child", status: "failed", error: "failed", timeline_ids: ["root", "child"] }));
  session["apply"](event(21, "task.read", { task_id: "child", seq: 20, timeline_ids: ["child"] }));
  responses.splice(0).forEach((resolve) => resolve(json({ conversations: [task()], as_of_seq: 10 })));
  await loading;
  assert.equal(session.tasks.get("child")!.status, "failed");
  assert.equal(session.tasks.get("child")!.read_seq, 20);
  assert.equal(session.tasks.get("child")!.unread, false);
  const late = session.refreshCollaborations("planner");
  session["apply"](event(22, "conversation.deleted", { id: "root" }));
  responses.splice(0).forEach((resolve) => resolve(json({ conversations: [task()], as_of_seq: 21 })));
  await late;
  assert.equal(session.chat("child"), undefined);
  assert.equal(session.isDeleted("child"), true);
  assert.equal(session.timelines.has("child"), false);
});

test("draft ordering and terminal replacement are task-local; deleting root clears even preview-only children", () => {
  const session = setup();
  create(session);
  const drafts = ["child", "preview-only"].map((id) => ({ draft_id: `d-${id}`, conversation_id: "root", task_id: id,
    sender: id, agent: "search", phase: null, text: id }));
  session["applyTransient"]({ type: "draft.snapshot", data: { epoch: "e", revision: 1, as_of_seq: 2, drafts } });
  assert.deepEqual(session.draftsFor("root"), []);
  assert.deepEqual(session.draftsFor("child").map((d) => d.text), ["child"]);
  session["apply"](event(3, "message.agent", { task_id: "child", text: "complete", draft_id: "d-child", timeline_ids: ["child"] }));
  const items = buildItems(session.timeline("child").events, [], undefined, session.draftsFor("child"), session.drafts.order, "child");
  assert.deepEqual(items.map((row) => [row.key, row.event?.data.text]), [["dd-child", "complete"]]);
  session["apply"](event(4, "conversation.deleted", { id: "root" }));
  assert.deepEqual(session.draftsFor("preview-only"), []);
  assert.equal(session.drafts.order.size, 0);
});

test("task commands preserve failed input, use task read/stop, and submit forms through root without leaking the user event", async () => {
  const paths: string[] = [];
  let refusal = "collaboration_stopped";
  const session = setup(async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("/read")) return new Response(null, { status: 204 });
    if (path.endsWith("/ui-submissions")) return json({ event: event(12, "message.user", {
      task_id: "child", timeline_ids: ["child"], text: "submitted", ui_submission: { message_seq: 8, block: 0, values: { color: "blue" } },
    }), replayed: false });
    if (path.endsWith("/stop")) return json({ event: event(13, "turn.stopped", { task_id: "child", timeline_ids: ["child"], was_working: true }), replayed: false });
    assert.equal(JSON.parse(String(init?.body)).text, "keep my correction");
    return new Response(JSON.stringify({ error: { code: refusal, message: "请先从上级会话恢复。" } }), { status: 409 });
  });
  create(session);
  session["apply"](event(8, "message.agent", { task_id: "child", text: "form", timeline_ids: ["child"] }));
  await session["markRead"]("child");
  await session.send("child", "keep my correction");
  assert.equal(session.pendingFor("child")[0].text, "keep my correction");
  assert.equal(session.taskErrors.get("child"), "请先从上级会话恢复。");
  assert.equal(session.pendingFor("child")[0].retryable, false);
  session["apply"](event(9, "task.status", { task_id: "child", status: "running", timeline_ids: ["root", "child"] }));
  assert.equal(session.taskErrors.has("child"), false);
  await session.submitUi("child", 8, 0, { color: "blue" }, "submit");
  await session.stop("child");
  assert.deepEqual(paths, ["/tasks/child/read", "/tasks/child/messages", "/conversations/root/ui-submissions", "/tasks/child/stop"]);
  assert.equal(session.timeline("root").events.some((e) => e.type === "message.user"), false);
  refusal = "collaboration_unavailable";
  await session.send("child", "keep my correction");
  assert.equal(session.tasks.get("child")!.status, "unavailable");
  assert.equal(session.taskErrors.get("child"), "这个协作已无法继续");
});

test("member stop terminal branch before HTTP failure stays confirmed across new work", async () => {
  let failStop!: (response: Response) => void;
  const session = setup(async (input) => {
    assert.equal(new URL(String(input)).pathname, "/tasks/child/stop");
    return new Promise<Response>((resolve) => { failStop = resolve; });
  });
  create(session);
  const stopping = session.stop("child");
  session["apply"](event(3, "task.status", { task_id: "child", status: "cancelled",
    timeline_ids: ["child"], branch_activity: { child: false } }));
  session["apply"](event(4, "task.status", { task_id: "child", status: "running",
    timeline_ids: ["child"], branch_activity: { child: true } }));
  failStop(new Response(JSON.stringify({ error: { message: "stop unavailable" } }), { status: 503 }));
  await stopping;
  assert.equal(session.stopErrors.has("child"), false);
  assert.equal(session.tasks.get("child")!.branch_working, true);
});

test("a settled member with a running descendant does not confirm branch stop", async () => {
  let failStop!: (response: Response) => void;
  const session = setup(async (input) => {
    assert.equal(new URL(String(input)).pathname, "/tasks/child/stop");
    return new Promise<Response>((resolve) => { failStop = resolve; });
  });
  create(session);
  create(session, "nested", "child", 3);
  const stopping = session.stop("child");
  session["apply"](event(4, "task.status", { task_id: "child", status: "completed",
    timeline_ids: ["child"], branch_activity: { child: true } }));
  failStop(new Response(JSON.stringify({ error: { message: "stop unavailable" } }), { status: 503 }));
  await stopping;
  assert.equal(session.stopErrors.get("child"), "stop unavailable");
  assert.equal(session.tasks.get("child")!.branch_working, true);
});

test("only this member stop client_id receipt confirms before HTTP failure", async () => {
  let failStop!: (response: Response) => void;
  let stopClientId = "";
  const session = setup(async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/tasks/child/stop");
    stopClientId = JSON.parse(String(init?.body)).client_id;
    return new Promise<Response>((resolve) => { failStop = resolve; });
  });
  create(session);
  const stopping = session.stop("child");
  session["apply"]({ ...event(3, "turn.stopped", { task_id: "nested", timeline_ids: ["child", "nested"], was_working: true }),
    client_id: stopClientId });
  session["apply"]({ ...event(4, "turn.stopped", { task_id: "child", timeline_ids: ["child"], was_working: true }),
    client_id: stopClientId });
  failStop(new Response(JSON.stringify({ error: { message: "stop unavailable" } }), { status: 503 }));
  await stopping;
  assert.equal(session.stopErrors.has("child"), false);
});

test("member receipt after a failed stop clears only its own unresolved failure", async () => {
  let failStop!: (response: Response) => void;
  let stopClientId = "";
  const session = setup(async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/tasks/child/stop");
    stopClientId = JSON.parse(String(init?.body)).client_id;
    return new Promise<Response>((resolve) => { failStop = resolve; });
  });
  create(session);
  const stopping = session.stop("child");
  failStop(new Response(JSON.stringify({ error: { message: "stop unavailable" } }), { status: 503 }));
  await stopping;
  assert.equal(session.stopErrors.get("child"), "stop unavailable");
  session["apply"]({ ...event(3, "turn.stopped", { task_id: "child", timeline_ids: ["child"], was_working: true }),
    client_id: "unrelated-command" });
  assert.equal(session.stopErrors.get("child"), "stop unavailable");
  session["apply"]({ ...event(4, "turn.stopped", { task_id: "child", timeline_ids: ["child"], was_working: true }),
    client_id: stopClientId });
  assert.equal(session.stopErrors.has("child"), false);
  assert.equal(session["stopRequests"].has("child"), false);
});

test("search locates the member timeline rather than a root containing only its preview", () => {
  assert.deepEqual(searchDestination({ kind: "message", id: "8", title: "Result", text: "blue", conversation_id: "root", task_id: "child", agent_id: "search", seq: 8 }),
    { pathname: "/c/[id]", params: { id: "child", message_seq: "8" } });
});

test("a delayed unread snapshot cannot undo a later receipt whose read position is below its global watermark", async () => {
  const responses: ((response: Response) => void)[] = [];
  const session = setup(async () => new Promise<Response>((resolve) => responses.push(resolve)));
  create(session);
  session["apply"](event(5, "message.agent", { task_id: "child", text: "answer", timeline_ids: ["child"] }));
  const loading = session.refreshCollaborations("planner");
  session["apply"](event(11, "task.read", { task_id: "child", seq: 5, timeline_ids: ["child"] }));
  responses.splice(0).forEach((resolve) => resolve(json({ conversations: [{ ...task(), unread: true }], as_of_seq: 10 })));
  await loading;
  assert.equal(session.tasks.get("child")!.unread, false);
  session["apply"](event(11, "task.read", { task_id: "child", seq: 5, timeline_ids: ["child"] }));
  assert.equal(session.tasks.get("child")!.unread, false);
  session["apply"](event(12, "message.agent", { task_id: "child", text: "new answer", timeline_ids: ["child"] }));
  assert.equal(session.tasks.get("child")!.unread, true, "a real later message still needs attention");
});

test("late first detail invalidates an unknown child of a deleted root and prevents all further history requests", async () => {
  const paths: string[] = [];
  let resolve!: (response: Response) => void;
  const session = setup(async (input) => {
    paths.push(new URL(String(input)).pathname);
    return new Promise<Response>((done) => { resolve = done; });
  });
  const deleted: string[] = [];
  session.onConversationDeleted = (id) => deleted.push(id);
  const loading = session.loadOlder("child");
  session["apply"](event(10, "conversation.deleted", { id: "root" }));
  // Fail before the broken implementation starts a second, unresolved request.
  resolve(json(task()));
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(session.isDeleted("child"), true);
  await loading;
  assert.equal(session.timelines.has("child"), false);
  assert.equal(session.taskErrors.has("child"), false);
  assert.ok(deleted.includes("child"), "draft owner is notified even if identity was unknown at deletion");
  session.view("child")();
  await session.loadOlder("child");
  assert.deepEqual(paths, ["/tasks/child"]);
});

test("cold member branch activity includes uncached descendants and live ancestor updates beat delayed lists", async () => {
  const responses: ((response: Response) => void)[] = [];
  const session = setup(async (input) => new URL(String(input)).pathname === "/tasks/child"
    ? json({ ...task(), status: "completed", branch_working: true })
    : new URL(String(input)).pathname.endsWith("/events") ? json({ events: [], as_of_seq: 10 })
    : new Promise<Response>((resolve) => responses.push(resolve)));
  await session.loadOlder("child");
  assert.equal(session.tasks.size, 1, "no descendant detail was fetched");
  assert.equal(session.isWorking("child"), true);
  const loading = session.refreshCollaborations("planner");
  session["apply"](event(20, "task.status", { task_id: "deep", status: "completed", error: null,
    timeline_ids: ["middle", "deep"], branch_activity: { child: false, middle: false, deep: false } }));
  responses.splice(0).forEach((resolve) => resolve(json({ conversations: [
    { ...task(), status: "completed", branch_working: true },
  ], as_of_seq: 15 })));
  await loading;
  assert.equal(session.isWorking("child"), false);
  session["apply"](event(21, "task.status", { task_id: "deep", status: "running", error: null,
    timeline_ids: ["middle", "deep"], branch_activity: { child: true, middle: true, deep: true } }));
  assert.equal(session.isWorking("child"), true);
  assert.equal(session.tasks.get("child")!.unread, false, "branch activity is not a message to the ancestor");
});

test("unavailable needs attention in both member timelines, but never changes root unread", () => {
  const session = setup();
  create(session);
  create(session, "nested", "child", 3);
  session["apply"](event(4, "task.status", { task_id: "child", status: "completed", timeline_ids: ["root", "child"] }));
  session["apply"](event(5, "task.read", { task_id: "child", seq: 4, timeline_ids: ["child"] }));
  session["apply"](event(6, "task.status", { task_id: "nested", status: "unavailable", error: "identity mismatch",
    timeline_ids: ["child", "nested"] }));
  assert.equal(session.tasks.get("child")!.unread, true);
  assert.equal(session.tasks.get("nested")!.unread, true);
  assert.equal(session.conversations.get("root")!.unread, false);
  session["apply"](event(7, "task.read", { task_id: "child", seq: 6, timeline_ids: ["child"] }));
  assert.equal(session.tasks.get("child")!.unread, false);
});
