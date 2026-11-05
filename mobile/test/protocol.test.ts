// L1：协议解析、纯状态与 fetch 桩；真实网关见 protocol.l3.ts。
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { GatewayApi } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { SseParser } from "../src/gateway/sse.ts";

const sessions = new Set<ChatSession>();
afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.close()));
  sessions.clear();
});

test("SSE 解析：跨块切分、CRLF、多行 data、注释心跳", () => {
  const parser = new SseParser();
  const chunks = ["id: 3\r", "\nevent: message.user\r\ndata: {\"a\":", "1}\r\n\r\n: heart", "beat\n\ndata: x\ndata: y\n\n"];
  const messages = chunks.flatMap((chunk) => parser.feed(chunk));
  assert.deepEqual(messages, [
    { id: "3", event: "message.user", data: '{"a":1}' },
    { id: null, event: ":", data: "heartbeat" },
    { id: null, event: "message", data: "x\ny" },
  ]);
});

test("PATCH / DELETE 只发送所需字段：同标题无事件，DELETE 无 body/client_id", async () => {
  const requests: { path: string; init: RequestInit }[] = [];
  const fake: typeof fetch = async (input, init) => {
    requests.push({ path: String(input), init: init! });
    return Response.json(requests.length === 1
      ? { conversation: { id: "a/b", title: "新标题" }, event: null }
      : { event: { seq: 5, type: "conversation.deleted", at: 5, data: { id: "a/b", agent_id: "assistant" } } });
  };
  const api = new GatewayApi({ baseUrl: "http://unused/", token: "dev" }, fake);
  assert.equal((await api.renameConversation("a/b", "新标题")).event, null);
  assert.equal((await api.deleteConversation("a/b")).event.data.id, "a/b");
  assert.deepEqual(requests.map((r) => [r.path, r.init.method, r.init.body]), [
    ["http://unused/conversations/a%2Fb", "PATCH", JSON.stringify({ title: "新标题" })],
    ["http://unused/conversations/a%2Fb", "DELETE", undefined],
  ]);
  assert.equal((requests[1].init.headers as Record<string, string>).Authorization, "Bearer dev");
  assert.equal((requests[1].init.headers as Record<string, string>)["Content-Type"], undefined);
});

test("当前字段水位独立：快照前的重放不回滚，乱序命令响应不挡住状态和未读", () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  sessions.add(session);
  session.agents.close();
  session["reset"]([{
    id: "c", agent_id: "helper", title: "C", created_at: 1, updated_at: 20,
    status: "idle", read_seq: 20, last_agent_seq: 19, unread: false, last_text: "快照消息",
    last_activity_seq: 19, last_activity_at: 19,
    source: "user", schedule_origin: null,
  }], 20);
  const apply = (seq: number, type: string, data: object) =>
    session["apply"]({ seq, type, data, conversation_id: "c", at: seq });
  apply(19, "message.agent", { text: "旧回复" });
  apply(20, "conversation.status", { status: "working" });
  const current = session.conversations.get("c")!;
  assert.equal(current.last_text, "快照消息");
  assert.equal(current.status, "idle");
  assert.equal(current.unread, false);
  apply(30, "message.user", { text: "较早返回的命令响应" });
  apply(25, "conversation.status", { status: "working" });
  apply(24, "message.agent", { text: "流中较早的回复" });
  assert.equal(current.last_text, "较早返回的命令响应");
  assert.equal(current.lastTextSeq, 30);
  assert.equal(current.last_activity_at, 30);
  assert.equal(current.status, "working");
  assert.equal(current.unread, true);
  apply(31, "conversation.read", { seq: 30 });
  apply(32, "conversation.status", { status: "idle" });
  apply(24, "message.agent", { text: "流中较早的回复" });
  apply(25, "conversation.status", { status: "working" });
  apply(29, "conversation.read", { seq: 24 });
  assert.equal(current.last_text, "较早返回的命令响应");
  assert.equal(current.status, "idle");
  assert.equal(current.read_seq, 30);
  assert.equal(current.unread, false);
  assert.deepEqual(session.timeline("c").events.map((event) => event.seq), [19, 20, 24, 25, 29, 30, 31, 32]);
});

test("改名事件按 seq 覆盖快照，不受乱序命令响应或旧事件回滚", async () => {
  let complete!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => (complete = resolve));
  const fake: typeof fetch = () => held;
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" }, fake);
  sessions.add(session);
  session.agents.close();
  session["reset"]([{ id: "c", agent_id: "helper", title: "快照标题", created_at: 1, updated_at: 20,
  status: "idle", read_seq: 0, last_agent_seq: 0, unread: false, last_text: null, last_activity_seq: null, last_activity_at: null, source: "user", schedule_origin: null, }], 20);
  const renaming = session.renameConversation("c", "我提交的标题");
  const update = (seq: number, title: string) =>
    session["apply"]({ seq, type: "conversation.updated", conversation_id: "c", at: seq, data: { title } });
  update(19, "快照之前的标题");
  update(24, "另一设备的标题");
  update(23, "乱序到达的旧标题");
  complete(Response.json({ conversation: { id: "c", title: "我提交的标题", updated_at: 21 }, event: null }));
  assert.equal(await renaming, true);
  assert.equal(session.conversations.get("c")?.title, "另一设备的标题");
  assert.deepEqual(session.timeline("c").events.map((e) => e.seq), [19, 23, 24]);
});

test("删除墓碑清除本地状态：迟到的历史、在途发送与旧快照均不能复活对话", async () => {
  let finishHistory!: (response: Response) => void;
  let finishSend!: (response: Response) => void;
  const history = new Promise<Response>((resolve) => (finishHistory = resolve));
  const send = new Promise<Response>((resolve) => (finishSend = resolve));
  const fake: typeof fetch = (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/messages")) return send;
    if (path.endsWith("/events")) return history;
    throw new Error(`意外请求 ${path}`);
  };
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" }, fake);
  sessions.add(session);
  session.agents.close();
  const row = (id: string) => ({
    id, agent_id: "helper", title: id, created_at: 1, updated_at: 1,
    status: "idle" as const, read_seq: 0, last_agent_seq: 0, unread: false, last_text: null,
    last_activity_seq: null, last_activity_at: null,
    source: "user" as const, schedule_origin: null,
  });
  session["reset"]([row("gone"), row("survivor")], 5);
  session.connection = "open";
  const loading = session.loadOlder("gone");
  const sending = session.send("gone", "在途消息");
  assert.equal(session.pendingFor("gone").length, 1);
  session["apply"]({ seq: 10, type: "conversation.deleted", at: 10, data: { id: "gone", agent_id: "helper" } });
  assert.equal(session.conversations.has("gone"), false);
  assert.equal(session.pendingFor("gone").length, 0);
  assert.equal(session.timelines.has("gone"), false);
  assert.equal(await session.conversationFor({
    id: "helper",
    latest_conversation: { id: "gone", title: "gone", status: "idle", last_text: null, last_activity_seq: null, last_activity_at: null },
  }), "survivor");
  finishHistory(Response.json({ events: [{ seq: 3, type: "message.user", conversation_id: "gone", at: 3, data: { text: "旧历史" } }] }));
  finishSend(Response.json({ event: { seq: 8, type: "message.user", conversation_id: "gone", at: 8, data: { text: "在途消息" } } }));
  await Promise.all([loading, sending]);
  session["apply"]({ seq: 2, type: "conversation.created", conversation_id: "gone", at: 2, data: { agent_id: "helper", title: "旧标题" } });
  session["reset"]([row("gone"), row("survivor")], 9); // 请求删除前就生成的旧列表
  assert.equal(session.conversations.has("gone"), false);
  assert.equal(session.timelines.has("gone"), false);
  assert.equal(session.timeline("gone").events.length, 0);
  assert.equal(session.timelines.has("gone"), false);
});

test("初始列表迟到：命令事件优先于旧快照，删除与改名不会倒退", () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  sessions.add(session);
  session.agents.close();
  const row = (id: string) => ({
    id, agent_id: "helper", title: "旧标题", created_at: 1, updated_at: 1,
    status: "idle" as const, read_seq: 0, last_agent_seq: 0, unread: false, last_text: null,
    last_activity_seq: null, last_activity_at: null,
    source: "user" as const, schedule_origin: null,
  });
  session["apply"]({ seq: 11, type: "conversation.updated", conversation_id: "kept", at: 11, data: { title: "新标题" } });
  session["apply"]({ seq: 12, type: "conversation.deleted", at: 12, data: { id: "gone", agent_id: "helper" } });
  session["reset"]([row("kept"), row("gone")], 10);
  assert.equal(session.conversations.get("kept")?.title, "新标题");
  assert.equal(session.conversations.has("gone"), false);
});

test("换库后旧首页行不能把用户送回旧库对话", async () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  sessions.add(session);
  session.agents.close();
  const row = (id: string) => ({
    id, agent_id: "helper", title: id, created_at: 1, updated_at: 1,
    status: "idle" as const, read_seq: 0, last_agent_seq: 0, unread: false, last_text: null,
    last_activity_seq: null, last_activity_at: null,
    source: "user" as const, schedule_origin: null,
  });
  session["reset"]([row("old")], 40);
  const stale = {
    id: "helper",
    latest_conversation: { id: "old", title: "旧库", last_text: null, last_activity_seq: null, last_activity_at: null, status: "idle" as const },
  };
  session.agents.agents = [{
    id: "helper", name: "helper", avatar: 1, description: "", workers: [], environment: "local",
    latest_conversation: null, unread: false,
  }];
  session["reset"]([row("fresh")], 1);
  assert.equal(await session.conversationFor(stale), "fresh");
});

test("改名与删除请求失败保留旧状态，向用户报告失败", async () => {
  const fake: typeof fetch = async () => {
    throw new TypeError("offline");
  };
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" }, fake);
  sessions.add(session);
  session["reset"]([{ id: "c", agent_id: "helper", title: "保留", created_at: 1, updated_at: 1,
  status: "idle", read_seq: 0, last_agent_seq: 0, unread: false, last_text: null, last_activity_seq: null, last_activity_at: null, source: "user", schedule_origin: null, }], 1);
  assert.equal(await session.renameConversation("c", "失败"), false);
  assert.equal(session.conversations.get("c")?.title, "保留");
  assert.equal(await session.deleteConversation("c"), false);
  assert.equal(session.conversations.has("c"), true);
  assert.equal(session.notice, "连不上网关");
});

test("未读位置：较新回执只确认旧回复，迟到本机确认也不能吃掉后续回复", async () => {
  const confirmation = Promise.withResolvers<Response>();
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" }, async () => confirmation.promise);
  sessions.add(session);
  session.agents.close();
  session["reset"]([{
    id: "c", agent_id: "helper", title: "C", created_at: 1, updated_at: 5,
    status: "idle", read_seq: 0, last_agent_seq: 5, unread: true, last_text: "回复",
    last_activity_seq: 5, last_activity_at: 5,
    source: "user", schedule_origin: null,
  }], 10);
  session.connection = "open";
  const apply = (seq: number, type: string, data: object) =>
    session["apply"]({ seq, type, data, conversation_id: "c", at: seq });
  apply(11, "conversation.read", { seq: 3 });
  assert.equal(session.conversations.get("c")!.unread, true, "回执比快照新不等于已经读到最后回复");
  session["insert"]({ seq: 5, type: "message.agent", data: { text: "回复" }, conversation_id: "c", at: 5 });
  const reading = session["markRead"]("c");
  apply(12, "message.agent", { text: "确认在途时的新回复" });
  confirmation.resolve(new Response(null, { status: 204 }));
  await reading;
  assert.equal(session.conversations.get("c")!.read_seq, 11);
  assert.equal(session.conversations.get("c")!.unread, true);
  apply(13, "conversation.read", { seq: 12 });
  assert.equal(session.conversations.get("c")!.unread, false);
  apply(11, "conversation.read", { seq: 3 });
  assert.equal(session.conversations.get("c")!.unread, false);
});


test("最近对话按活动 seq 比较，时钟回拨或时间相同不改顺序，空对话按创建时间复用", async () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  sessions.add(session);
  for (const [id, createdAt, seq, activityAt] of [
    ["a", 1, 10, 200],
    ["b", 2, 20, 199],
    ["blank", 3, 0, null],
    ["older-blank", 0, 0, null],
  ] as const) {
    session.conversations.set(id, {
      id, agent_id: "helper", title: id, created_at: createdAt, updated_at: id === "a" ? 999 : createdAt,
      read_seq: 0, status: "idle", unread: false, last_text: activityAt === null ? null : id,
      source: "user", schedule_origin: null,
      activity: null, lastTextSeq: seq, lastAgentSeq: 0, last_activity_seq: seq || null, last_activity_at: activityAt,
    });
  }
  const summary = {
    id: "helper",
    latest_conversation: { id: "a", title: "A", status: "idle" as const, last_text: "A", last_activity_seq: 10, last_activity_at: 200 },
  };
  assert.equal(await session.conversationFor(summary), "b"); // B 的时间回拨，seq 仍较新
  summary.latest_conversation.last_activity_at = 199;
  assert.equal(await session.conversationFor(summary), "b"); // 相同时间也按 seq
  summary.latest_conversation.last_activity_seq = 30;
  summary.latest_conversation.last_activity_at = 198;
  assert.equal(await session.conversationFor(summary), "a"); // 较新摘要的时间可以更早
  assert.equal(await session.conversationFor({ id: "helper", latest_conversation: null }), "b");
  // conversation-drawer.P1：A 之后又来了 AI 回复（文字序更新），但排序活动仍是 B 更新。
  session.conversations.get("a")!.lastTextSeq = 50;
  assert.equal(await session.conversationFor({ id: "helper", latest_conversation: null }), "b");
  const empty = {
    id: "helper",
    latest_conversation: { id: "blank", title: "空", status: "idle" as const, last_text: null, last_activity_seq: null, last_activity_at: null },
  };
  assert.equal(await session.conversationFor(empty), "b");
  session.conversations.delete("a");
  session.conversations.delete("b");
  assert.equal(await session.conversationFor(empty), "blank");
  assert.equal(await session.conversationFor({ id: "helper", latest_conversation: null }), "blank");
  session.conversations.delete("blank");
  assert.equal(await session.conversationFor({ id: "helper", latest_conversation: null }), "older-blank");
});


