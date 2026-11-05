// L3：真实 HTTP/SSE、进程重启与多网关路由；pnpm run test:protocol。
import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { Upload } from "tus-js-client";

import { exchangePairingCode, GatewayApi, GatewayError } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { SseParser } from "../src/gateway/sse.ts";
import { projectChatRows } from "../src/lib/chat-timeline.ts";
import { chatEntryTarget } from "../src/lib/conversation-navigation.ts";
import { selectableSkills, skillMarkdown } from "../src/lib/skills.ts";
import { uploadMetadata } from "../src/lib/upload-draft-state.ts";
import { memoryNewConversation, NewConversationStore, type NewChatSaved } from "../src/lib/new-conversation.ts";
import { directory, sessions, sharedGateway, started, StubGateway, texts, serverHistory, until } from "./protocol-fixture.ts";
import { BrowserStream } from "../src/browser/stream.ts";
import type { Hello, Pages, Reply } from "../src/browser/protocol.ts";
import type { VideoMessage } from "../src/lib/browser-video.ts";
test("Agent 列表与详情；对话带入口 Agent，可按它过滤；不存在的 Agent 被拒绝", async () => {
  const gateway = await sharedGateway();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const { agents, as_of_seq } = await api.listAgents();
  assert.equal(typeof as_of_seq, "number");
  assert.deepEqual(agents.map((a) => [a.id, a.name, a.workers]), [["assistant", "assistant", ["helper"]], ["helper", "helper", []]]);
  const helper = await api.getAgent("helper");
  assert.deepEqual(helper.member_of, ["assistant"]);
  assert.equal(helper.model, "offline");
  await assert.rejects(api.getAgent("nobody"), (error: any) => error instanceof GatewayError && error.status === 404);
  const mine = await api.createConversation("assistant", "甲", globalThis.crypto.randomUUID());
  const other = await api.createConversation("helper", undefined, globalThis.crypto.randomUUID());
  assert.equal(mine.agent_id, "assistant");
  assert.deepEqual((await api.listConversations("helper")).conversations.map((c) => c.id), [other.id]);
  assert.equal((await api.listConversations()).conversations.length, 2);
  await assert.rejects(api.createConversation("nobody", undefined, globalThis.crypto.randomUUID()), (error: any) => error.status === 404 && error.code === "not_found");
});

test("Agent 重名协议：去空白忽略大小写，拒绝新建和改名，原 client_id 回执优先", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  try {
    const fields = { name: " Test ", description: "协议验证", system_prompt: "按要求回答", model: "offline" };
    const first = await api.createAgent("unique-first", fields);
    assert.equal(first.agent.name, "Test");
    const conflict = (error: unknown) => error instanceof GatewayError && error.status === 409 && error.code === "agent_name_conflict";
    await assert.rejects(api.createAgent("unique-second", { ...fields, name: "test" }), conflict);
    await assert.rejects(api.updateAgent("helper", { name: " TEST " }), conflict);
    assert.equal((await api.getAgent("helper")).name, "helper");
    assert.equal((await api.updateAgent(first.agent.id, { name: " Test " })).event, null);
    await api.updateAgent(first.agent.id, { name: "Different" });
    await api.createAgent("unique-second", fields);
    assert.deepEqual(await api.createAgent("unique-first", fields), { ...first, replayed: true });
  } finally {
    api.close();
    await gateway.kill();
  }
});

test("首次创建回执丢失：真实网关同键重试只建一个对话，首消息用独立身份且只提交一次", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  let loseReceipt = true;
  const creationKeys: string[] = [];
  const config = { baseUrl: gateway.url, token: "dev", computerId: "lazy-l3" };
  const transport: typeof fetch = async (input, init) => {
    const creating = new URL(String(input)).pathname === "/conversations" && init?.method === "POST";
    if (creating) creationKeys.push(JSON.parse(String(init.body)).client_id);
    const response = await fetch(input, init);
    if (creating && loseReceipt) { loseReceipt = false; await response.text(); throw new TypeError("receipt lost"); }
    return response;
  };
  const api = new GatewayApi(config, transport);
  const session = await started(gateway);
  const draft = memoryNewConversation();
  draft.select("lazy-l3", "helper");
  draft.setText("首次消息原文");
  const host = {
    computerId: "lazy-l3", online: () => true, current: () => true, storeVersion: () => session.storeVersion,
    create: async (agent: string, client: string) => (await api.createConversation(agent, undefined, client)).id,
    bind: (id: string, attempt: { text: string; messageClientId: string }) => ({ preserveDraft: true, send: () => session.send(id, attempt.text, [], attempt.messageClientId) }),
  };
  await draft.submit(host, { create: "creation", message: "first-message" });
  assert.equal(draft.getSnapshot().status, "unknown");
  assert.equal((await api.listConversations()).conversations.length, 1);
  const id = await draft.submit(host, { create: "must-not-replace", message: "must-not-replace" });
  assert.ok(id);
  assert.deepEqual(creationKeys, ["creation", "creation"]);
  const history = await serverHistory(gateway, id);
  const creations = history.filter(event => event.type === "conversation.created");
  const messages = history.filter(event => event.type === "message.user");
  assert.equal(creations.length, 1);
  assert.equal(creations[0].client_id, "creation");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].client_id, "first-message");
  assert.equal(messages[0].data.text, "首次消息原文");
  await until(() => session.conversations.has(id));
  await assert.rejects(session.createConversation("assistant", undefined, "creation"), (error: unknown) => error instanceof GatewayError && error.status === 409);
  await session.close(); api.close();
});

test("ADR-0079 F3 冷启动无墓碑时，同键历史回执不能复活已删除对话或发出首消息", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const config = { baseUrl: gateway.url, token: "dev", computerId: "cold-replay" };
  let saved: NewChatSaved | null = null;
  const storage = { read: () => saved, write: (value: NewChatSaved) => { saved = structuredClone(value); } };
  const api = new GatewayApi(config, async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method === "POST" && new URL(String(input)).pathname === "/conversations") {
      await response.text(); throw new TypeError("creation receipt lost before app exits");
    }
    return response;
  });
  const beforeExit = new NewConversationStore(storage);
  beforeExit.select("cold-replay", "assistant"); beforeExit.setText("删除后仍保留的未发送文字");
  await beforeExit.submit({
    computerId: "cold-replay", online: () => true, current: () => true, storeVersion: () => 0,
    create: async (agent, key) => (await api.createConversation(agent, undefined, key)).id,
    bind: () => { throw new Error("lost receipt cannot bind"); },
  }, { create: "deleted-creation", message: "unsent-first-message" });
  assert.equal(beforeExit.getSnapshot().status, "unknown");
  beforeExit.setText("删除期间编辑的下一段");
  const deletedId = (await api.listConversations()).conversations[0].id;
  await api.deleteConversation(deletedId); api.close();
  let messageRequests = 0, bindings = 0;
  const session = new ChatSession(config, async (input, init) => {
    if (init?.method === "POST" && new URL(String(input)).pathname.endsWith("/messages")) messageRequests++;
    return fetch(input, init);
  });
  sessions.add(session);
  await session.start(); await until(() => session.connection === "open");
  assert.equal(session["deleted"].size, 0, "a fresh app has never observed the deletion event");
  const afterRestart = new NewConversationStore(storage);
  afterRestart.restore();
  await afterRestart.submit({
    computerId: "cold-replay", online: () => session.connection === "open", current: () => true,
    storeVersion: () => session.storeVersion,
    create: (agent, key) => session.createConversation(agent, undefined, key),
    bind: (id, attempt) => {
      bindings++;
      return { preserveDraft: true, send: () => session.send(id, attempt.text, [], attempt.messageClientId) };
    },
  }, { create: "do-not-change-key", message: "do-not-change-message-key" });
  assert.equal(bindings, 0);
  assert.equal(messageRequests, 0);
  assert.equal(session.conversations.has(deletedId), false);
  assert.equal(session.pending.size, 0);
  assert.deepEqual((await session.api.listConversations()).conversations, []);
  const state = afterRestart.getSnapshot();
  assert.equal(state.status, "editing");
  assert.equal(state.saved.text, "删除期间编辑的下一段");
  assert.equal(state.saved.failure?.attempt.text, "删除后仍保留的未发送文字");
  assert.equal(state.saved.failure?.attempt.messageClientId, "unsent-first-message");
  assert.equal(state.saved.attempt, undefined);
});

test("网关崩溃重启：同一个库，按 Last-Event-ID 续传", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const id = await session.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  session.view(id);
  await session.send(id, "重启前");
  await until(() => texts(session, id, "message.agent").length === 1);
  await gateway.kill();
  await until(() => session.connection === "reconnecting");
  const failed = session.send(id, "网关不在时发的");
  await failed;
  const pending = session.pendingFor(id)[0];
  assert.equal(pending.status, "failed");
  assert.equal(pending.retryable, true);

  await gateway.start();
  await until(() => session.connection === "open", 10_000);
  await session.retry(pending.clientId);
  await until(() => texts(session, id, "message.agent").length === 2
    && session.conversations.get(id)!.status === "idle");
  assert.deepEqual(texts(session, id, "message.user"), ["重启前", "网关不在时发的"]);
  // 已读事件仍可能增长；固定服务端水位并等待 SSE 追上，再比较完整序列。
  const final = await serverHistory(gateway, id);
  const bound = final[final.length - 1].seq;
  await until(() => session.timeline(id).events.some((event) => event.seq >= bound));
  assert.deepEqual(session.timeline(id).events.filter((event) => event.seq <= bound), final);
  await session.close();
  await gateway.kill();
});
test("空浏览器资源的未知租约画面接入受控拒绝，而不是 500", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  try {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const connection = request(`${gateway.url}/browser-tasks/missing/stream`, {
      headers: {
        Authorization: "Bearer dev", Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64"),
      },
    }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    });
    connection.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("不存在的租约不能建立画面通道"));
    });
    connection.on("error", reject);
    // Real child/HTTP I/O deadline, not a sleep used to guess application state.
    connection.setTimeout(5000, () => connection.destroy(new Error("画面接入未结算")));
    connection.end();
    assert.equal(await promise, 403);
    const computer = await fetch(`${gateway.url}/computer`, { headers: { Authorization: "Bearer dev" } });
    assert.equal(computer.status, 200);
    assert.deepEqual((await computer.json()).environments, []);
  } finally {
    await gateway.kill();
  }
});
test("搜索按名称与消息正文匹配、按入口 Agent 限定，LIKE 通配符必须是字面字符；删除来源后退出结果", async () => {
  const gateway = await sharedGateway();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const mine = await api.createConversation("assistant", "独有标题_%", globalThis.crypto.randomUUID());
  const other = await api.createConversation("helper", "对照标题", globalThis.crypto.randomUUID());
  await api.sendMessage(mine.id, "search-" + mine.id, "正文特殊_%路径");
  await until(async () => (await serverHistory(gateway, mine.id)).some((event) => event.type === "message.agent"));

  const title = await api.search("标题_%");
  assert.deepEqual(title.results.filter((result) => result.kind === "conversation").map((result) => result.id), [mine.id]);
  assert.equal((await api.search("标题_%", "helper")).total, 0);
  assert.equal((await api.search("标题")).results.filter((result) => result.kind === "conversation").length, 2);
  const message = await api.search("正文特殊_%", "assistant");
  assert.ok(message.results.some((result) => result.kind === "message" && result.conversation_id === mine.id && result.text.includes("正文特殊_%")));
  assert.equal((await api.search("   ")).total, 0);
  assert.ok((await api.search("标题", undefined, 1, 1)).results.length <= 1);

  await api.deleteConversation(mine.id);
  assert.equal((await api.search("标题_%")).total, 0);
  assert.equal((await api.search("正文特殊_%")).total, 0);
  await api.deleteConversation(other.id);
});
test("真实登记原文件：消息附件、认证 Range、修改后新字节与删对话保留独立搜索；原文件消失则不可用", async () => {
  const gateway = await sharedGateway();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const conversation = await api.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  const name = "handoff_%_file.txt";
  await api.sendMessage(conversation.id, "file-" + conversation.id, `FILE_DELIVERY:${name}`);
  await until(async () => (await serverHistory(gateway, conversation.id))
    .some((event) => event.type === "message.agent" && event.data.attachments?.length));
  const event = (await serverHistory(gateway, conversation.id))
    .find((entry) => entry.type === "message.agent" && entry.data.attachments?.length)!;
  const [file] = event.data.attachments;
  assert.equal(file.name, name);
  assert.equal(file.conversation_id, conversation.id);
  assert.equal(file.path, undefined);
  assert.equal((await api.getFile(file.id)).available, true);
  const url = api.fileContentUrl(file.id);
  assert.ok(!url.includes("dev"), "Authentication token must not be embedded in content URL");
  assert.equal((await fetch(url)).status, 401);
  const range = await fetch(url, { headers: api.headers({ Range: "bytes=0-7" }) });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "original");

  const original = path.join(gateway.database + ".workspace", "conversations", conversation.id, name);
  writeFileSync(original, "changed-original");
  assert.equal(await (await fetch(url, { headers: api.headers() })).text(), "changed-original");
  assert.ok((await api.search("handoff_%_file")).results.some((result) => result.kind === "file" && result.id === file.id));
  await api.deleteConversation(conversation.id);
  const retained = await api.getFile(file.id);
  assert.equal(retained.conversation_id, null);
  assert.equal(retained.available, true);
  assert.ok((await api.search("handoff_%_file")).results.some((result) => result.kind === "file" && result.id === file.id));
  unlinkSync(original);
  assert.equal((await api.getFile(file.id)).available, false);
  assert.equal((await fetch(url, { headers: api.headers() })).status, 410);
});
test("技能列表读工作区目录与 SKILL.md 说明；凭据不可省略，游标对齐网关事件", async () => {
  const gateway = new StubGateway();
  const skillDir = `${gateway.database}.workspace/.wandrun/skills/research-tool`;
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"),
    "---\nname: research-tool\ndescription: 交叉核对资料来源\n---\n# 流程\n");
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  await assert.rejects(new GatewayApi({ baseUrl: gateway.url, token: "bad" }).listSkills(),
    (error: unknown) => error instanceof GatewayError && error.status === 401 && error.code === "unauthorized");
  await api.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  const listed = await api.listSkills();
  assert.deepEqual(listed.skills.map(({ name, description, status, used_by }) => ({ name, description, status, used_by })), [
    { name: "research-tool", description: "交叉核对资料来源", status: "ok", used_by: [] },
  ]);
  assert.equal(listed.default_agent_id, "assistant");
  assert.equal(listed.as_of_seq, (await api.listAgents()).as_of_seq);
  await gateway.kill();
});

test("技能引用与删除经真实客户端重读，断线游标续传删除资源事件", async () => {
  const gateway = new StubGateway();
  const skillDir = `${gateway.database}.workspace/.wandrun/skills/research-contract`;
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: research-contract\ndescription: 原始资料核对\n---\n# 核对流程\n");
  await gateway.start();
  const session = await started(gateway);
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  await api.updateAgent("assistant", { skills: ["research-contract"] });
  assert.deepEqual((await api.getSkill("research-contract")).used_by, [{ id: "assistant", name: "assistant" }]);
  await assert.rejects(api.deleteSkill("research-contract"), (error: unknown) =>
    error instanceof GatewayError && error.status === 409);
  await api.updateAgent("assistant", { skills: [] });
  assert.deepEqual((await api.getSkill("research-contract")).used_by, []);
  const cursor = (await api.listSkills()).as_of_seq;
  await session.close();
  const deleted = await api.deleteSkill("research-contract");
  assert.equal((await api.listSkills()).skills.some(skill => skill.name === "research-contract"), false);
  const replay = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  try {
    const event = await replay.consumeResponse(`/events?after=${cursor}`, {
      headers: replay.headers(), signal: AbortSignal.timeout(5000),
    }, async response => {
      const reader = response.body!.getReader();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          if (frame.event !== "resource.changed") continue;
          const event = JSON.parse(frame.data);
          if (event.data.kind === "skill" && event.data.op === "deleted") return event;
        }
      }
    });
    assert.equal(event.seq, deleted.event!.seq);
    assert.equal(event.data.id, "research-contract");
  } finally { api.close(); replay.close(); await gateway.kill(); }
});
test("内置同名用户技能经真实 API 标为错误，选择器不可新选且已有选择仅可移除", async () => {
  const gateway = new StubGateway();
  const skillDir = `${gateway.database}.workspace/.wandrun/skills/wandrun-ui`;
  const content = "---\nname: wandrun-ui\ndescription: User-selected policy\n---\n# 用户规则\n";
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), content);
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const { skills } = await api.listSkills();
  const detail = await api.getSkill("wandrun-ui");
  assert.equal(skills[0].status, "error");
  assert.equal(detail.status, "error");
  assert.match(detail.error!, /内置技能.*不生效/);
  assert.equal(skillMarkdown(detail), content);
  assert.deepEqual(selectableSkills(skills, []), []);
  const selected = selectableSkills(skills, ["wandrun-ui"]);
  assert.deepEqual(selected.map(({ skill, removableOnly }) => [skill.name, removableOnly]), [
    ["wandrun-ui", true],
  ]);
  await assert.rejects(api.updateAgent("assistant", { skills: ["wandrun-ui"] }),
    (error: unknown) => error instanceof GatewayError && error.status === 400);
  assert.deepEqual((await api.getAgent("assistant")).skills, []);
  await gateway.kill();
});
test("系统能力与内置技能独立于同名工作区技能，Agent 更新后返回已提交快照", async () => {
  const gateway = new StubGateway();
  const skillDir = `${gateway.database}.workspace/.wandrun/skills/wandrun-ui`;
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: wandrun-ui\ndescription: 用户同名目录\n---\n# 不是内置内容\n");
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  await assert.rejects(new GatewayApi({ baseUrl: gateway.url, token: "bad" }).getAgentCapabilities("assistant"),
    (error: unknown) => error instanceof GatewayError && error.status === 401);
  await api.updateAgent("assistant", { code_mode: false });
  const before = (await api.getAgentCapabilities("assistant")).capabilities;
  assert.deepEqual(before.map((capability) => capability.id),
    ["memory", "tool_search", "files", "processes", "browser", "code_mode", "schedule", "image_generation", "uploads", "ui_blocks"]);
  assert.deepEqual(before.find((item) => item.id === "files")?.tools,
    ["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep"]);
  assert.deepEqual(before.find((item) => item.id === "uploads")?.tools, ["fetch_upload"]);
  assert.equal(before.find((item) => item.id === "files")?.reason, "所有 Agent 都有");
  assert.equal(before.find((item) => item.id === "tool_search")?.reason, "没有按需连接器");
  assert.equal(before.find((item) => item.id === "code_mode")?.status, "disabled");
  assert.deepEqual(before.find((item) => item.id === "code_mode")?.tools, []);
  assert.equal(before.find((item) => item.id === "browser")?.status, "not_applicable");
  assert.deepEqual(before.find((item) => item.id === "ui_blocks")?.skills, ["wandrun-ui"]);
  assert.ok(before.every((item) => item.name && item.summary && item.description));
  const listed = (await api.listBuiltinSkills()).skills;
  assert.deepEqual(listed.map((skill) => [skill.name, skill.capability.id, skill.used_by.map((agent) => agent.id)]),
    [["wandrun-ui", "ui_blocks", ["assistant", "helper"]]]);
  const builtin = await api.getBuiltinSkill("wandrun-ui");
  assert.match(builtin.content, /wandrun-ui/);
  assert.doesNotMatch(builtin.content, /不是内置内容/);
  assert.equal((await api.getSkill("wandrun-ui")).status, "error");
  const immutable = await fetch(`${gateway.url}/builtin-skills/wandrun-ui`, { method: "DELETE", headers: api.headers() });
  assert.equal(immutable.status, 405);

  const connector = await api.createConnector("capability-search", {
    name: "搜索资料", description: "按需找资料", url: "https://mcp.example/tools",
  });
  const updated = await api.updateAgent("assistant", { name: "改名助手", searchable_mcp_servers: [connector.connector.id], code_mode: true });
  assert.equal(updated.event?.type, "resource.changed");
  const after = (await api.getAgentCapabilities("assistant")).capabilities;
  assert.equal(after.find((item) => item.id === "code_mode")?.status, "enabled");
  assert.equal(after.find((item) => item.id === "tool_search")?.status, "enabled");
  assert.equal(after.find((item) => item.id === "tool_search")?.reason, "已选择按需连接器");
  assert.deepEqual((await api.listBuiltinSkills()).skills[0].used_by.map((agent) => agent.name), ["改名助手", "helper"]);
  await assert.rejects(api.updateAgent("assistant", { searchable_mcp_servers: ["unknown"] }),
    (error: unknown) => error instanceof GatewayError && error.status === 400);
  assert.deepEqual((await api.getAgentCapabilities("assistant")).capabilities, after);
  await api.deleteSkill("wandrun-ui");
  assert.equal((await api.getBuiltinSkill("wandrun-ui")).name, "wandrun-ui");
  await assert.rejects(api.getAgentCapabilities("missing"), (error: unknown) => error instanceof GatewayError && error.status === 404);
  await assert.rejects(api.getBuiltinSkill("absent"), (error: unknown) => error instanceof GatewayError && error.status === 404);
  await gateway.kill();
});
test("模型目录过滤 ultra、默认设置与用量经过真实网关；空白创建沿用默认值", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const catalog = await api.listModels(true);
  assert.deepEqual(catalog.models.map(({ id }) => id), ["offline"]);
  assert.deepEqual(catalog.models[0].supported_reasoning_efforts.map(({ effort }) => effort), ["medium", "high", "max"]);
  assert.equal(typeof catalog.fetched_at, "number");
  assert.equal(catalog.capabilities?.fast_mode, true);
  assert.equal((await api.connection()).capabilities?.fast_mode, true);
  const previous = await api.getSettings();
  assert.ok(previous.default_model === null || typeof previous.default_model === "string");
  assert.deepEqual(await api.updateSettings({ default_model: "offline", default_reasoning_effort: "max" }), {
    default_model: "offline", default_reasoning_effort: "max",
  });
  assert.deepEqual(await api.getSettings(), { default_model: "offline", default_reasoning_effort: "max" });
  await assert.rejects(
    api.updateSettings({ default_model: "offline", default_reasoning_effort: "ultra" }),
    (error: unknown) => error instanceof GatewayError && error.status === 400,
  );
  assert.deepEqual(await api.getSettings(), { default_model: "offline", default_reasoning_effort: "max" });
  const created = await api.createAgent("default-model-create", {
    name: "默认模型测试", description: "验证默认模型", system_prompt: "按用户要求回答",
  });
  assert.equal(created.agent.model, "offline");
  assert.equal(created.agent.reasoning_effort, "max");
  assert.equal(created.agent.fast_mode, false);
  const fast = await api.updateAgent(created.agent.id, { fast_mode: true });
  assert.equal(fast.agent.fast_mode, true);
  assert.equal(fast.agent.reasoning_effort, "max");
  assert.equal((await api.getAgent(created.agent.id)).fast_mode, true);
  const reasoningOnly = await api.updateAgent(created.agent.id, { reasoning_effort: "medium" });
  assert.equal(reasoningOnly.agent.fast_mode, true);
  assert.equal(reasoningOnly.agent.reasoning_effort, "medium");
  const standard = await api.updateAgent(created.agent.id, { fast_mode: false, reasoning_effort: "max" });
  assert.equal(standard.agent.fast_mode, false);
  assert.equal(standard.agent.reasoning_effort, "max");
  await assert.rejects(
    api.updateAgent(created.agent.id, { reasoning_effort: "ultra" }),
    (error: unknown) => error instanceof GatewayError && error.status === 400,
  );
  assert.equal((await api.getAgent(created.agent.id)).reasoning_effort, "max");
  await assert.rejects(
    api.createAgent("rejected-ultra-create", {
      name: "不可用档位", description: "", system_prompt: "", model: "offline", reasoning_effort: "ultra",
    }),
    (error: unknown) => error instanceof GatewayError && error.status === 400,
  );
  const subscription = await api.getSubscriptionUsage(true);
  assert.equal(subscription.auth.status, "ready");
  assert.equal(typeof subscription.auth.checked_at, "number");
  assert.equal(subscription.auth.reason, null);
  assert.ok(subscription.auth.codex_home.startsWith("/"));
  assert.ok(subscription.auth.login_command.includes("login --device-auth"));
  assert.deepEqual(subscription.usage?.windows, [{
    name: "primary", used_percent: 25, window_seconds: 604800, reset_at: 1_760_604_800,
  }]);
  assert.equal(subscription.usage?.allowed, true);
  const report = await api.getAgentUsage();
  assert.equal(report.days, 7);
  assert.deepEqual(report.agents.find((entry) => entry.agent_id === created.agent.id), {
    agent_id: created.agent.id, input_tokens: 0, cached_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, daily: [],
  });
  await gateway.kill();
});
test("Agent CRUD：创建重放、只编辑允许字段、共享引用校验、删除冲突与事件续传", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const phone = await started(gateway);

  await assert.rejects(
    api.createAgent("incomplete-agent-command", { description: "缺名称", system_prompt: "回答", model: "offline" } as any),
    (error: any) => error instanceof GatewayError && error.status === 400,
  );
  const fields = { name: "新朋友", description: "研究问题", system_prompt: "回答时给依据", model: "offline", fast_mode: true };
  const created = await api.createAgent("new-agent-command", fields);
  const id = created.agent.id;
  assert.equal(created.replayed, false);
  assert.equal(created.agent.name, fields.name);
  assert.equal(created.agent.reasoning_effort, null);
  assert.equal(created.agent.fast_mode, true);
  assert.deepEqual(created.agent.skills, []);
  assert.deepEqual(created.agent.workers, []);
  assert.deepEqual(created.event.data, { kind: "agent", id, op: "created" });
  const replayed = await api.createAgent("new-agent-command", fields);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.agent.id, id);
  assert.equal(replayed.event.seq, created.event.seq);
  assert.equal(replayed.agent.fast_mode, true);
  await until(() => phone.agents.agents.some((item) => item.id === id));

  const changed = await api.updateAgent(id, { name: "改名后", avatar: 3, workers: ["helper"], reasoning_effort: "medium" });
  assert.equal(changed.agent.id, id);
  assert.equal(changed.agent.name, "改名后");
  assert.equal(changed.agent.avatar, 3);
  assert.equal(changed.agent.fast_mode, true);
  assert.deepEqual(changed.agent.workers, ["helper"]);
  assert.equal(changed.event?.data.op, "updated");
  assert.equal((await api.updateAgent(id, { name: "改名后" })).event, null);
  await until(() => phone.agents.agents.find((item) => item.id === id)?.name === "改名后");
  await assert.rejects(api.updateAgent(id, { workers: ["missing"] }), (error: any) =>
    error instanceof GatewayError && error.status === 400);
  await assert.rejects(api.updateAgent(id, { environment: "remote" } as any), (error: any) =>
    error instanceof GatewayError && error.status === 400);
  assert.deepEqual((await api.getAgent(id)).workers, ["helper"]);

  await assert.rejects(api.deleteAgent("helper"), (error: unknown) =>
    error instanceof GatewayError && error.status === 409 &&
    typeof error.details === "object" && error.details !== null &&
    "member_of" in error.details && Array.isArray(error.details.member_of) &&
    error.details.member_of.some((member: unknown) => member !== null && typeof member === "object" &&
      "id" in member && member.id === "assistant" && "name" in member && member.name === "assistant") &&
    "running_conversations" in error.details && error.details.running_conversations === 0 &&
    "running_tasks" in error.details && error.details.running_tasks === 0);
  const conversation = await api.createConversation(id, "待删的会话", globalThis.crypto.randomUUID());
  await api.sendMessage(conversation.id, "slow-agent-command", "慢");
  await until(async () => (await api.listConversations(id)).conversations.some((item) => item.id === conversation.id && item.status === "working"));
  await assert.rejects(api.deleteAgent(id), (error: unknown) =>
    error instanceof GatewayError && error.status === 409 &&
    typeof error.details === "object" && error.details !== null &&
    "running_conversations" in error.details && error.details.running_conversations === 1 &&
    "running_tasks" in error.details && error.details.running_tasks === 1 &&
    "member_of" in error.details && Array.isArray(error.details.member_of) && error.details.member_of.length === 0);
  await api.stop(conversation.id, "stop-agent-command");
  await until(async () => (await api.listConversations(id)).conversations.every((item) => item.status !== "working"));
  const deleted = await api.deleteAgent(id);
  assert.equal(deleted.event.data.op, "deleted");
  assert.equal(deleted.event.data.id, id);
  await until(() => !phone.agents.agents.some((item) => item.id === id));
  assert.equal((await api.deleteAgent(id)).event.seq, deleted.event.seq);
  await assert.rejects(api.getAgent(id), (error: any) => error instanceof GatewayError && error.status === 404);
  await assert.rejects(api.listConversations(id), (error: any) => error instanceof GatewayError && error.status === 404);
  assert.equal((await api.listConversations()).conversations.some((item) => item.id === conversation.id), false);
  await gateway.kill();
});
test("连接器密钥只写、补丁、按需状态、Agent 引用、级联删除与资源事件", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const before = await api.listConnectors();
  assert.deepEqual(before.connectors, []);

  const created = await api.createConnector("connector-create", {
    name: "资料库", description: "按需检索资料", url: "https://mcp.example/tools",
    headers: { Authorization: "Bearer initial-secret", "X-Region": "east-secret" },
  });
  const id = created.connector.id;
  assert.equal(created.replayed, false);
  assert.match(id, /^c_[0-9a-f-]+$/);
  assert.deepEqual(created.event.data, { kind: "connector", id, op: "created" });
  assert.equal(created.event.type, "resource.changed");
  assert.deepEqual(created.connector.headers, { Authorization: true, "X-Region": true });
  assert.deepEqual(created.connector.used_by, []);
  assert.equal(JSON.stringify(created).includes("initial-secret"), false);
  assert.deepEqual((await api.getConnector(id)).headers, { Authorization: true, "X-Region": true });
  const listed = await api.listConnectors();
  assert.equal(listed.as_of_seq, created.event.seq);
  assert.deepEqual(listed.connectors.map((connector) => connector.id), [id]);

  const patched = await api.updateConnector(id, {
    name: "改名资料库", headers: { Authorization: "Bearer rotated-secret", "X-Region": null },
  });
  assert.deepEqual(patched.event?.data, { kind: "connector", id, op: "updated" });
  assert.deepEqual(patched.connector.headers, { Authorization: true });
  assert.equal(patched.connector.url, "https://mcp.example/tools");
  assert.equal(JSON.stringify(patched).includes("rotated-secret"), false);
  assert.deepEqual((await api.getConnector(id)).headers, { Authorization: true });
  const unchangedSecret = await api.updateConnector(id, { description: "可查最新资料" });
  assert.deepEqual(unchangedSecret.connector.headers, { Authorization: true });
  const removedSecret = await api.updateConnector(id, { headers: { Authorization: "" } });
  assert.deepEqual(removedSecret.connector.headers, {});

  const agent = await api.createAgent("connector-agent", {
    name: "检索者", description: "按需查询", system_prompt: "根据资料回答", model: "offline",
    mcp_servers: [id],
  });
  assert.deepEqual(agent.agent.mcp_servers, [id]);
  assert.deepEqual((await api.getConnector(id)).used_by.map((user) => user.id), [agent.agent.id]);

  const tested = await api.testConnector(id);
  assert.equal(tested.success, true);
  assert.equal(tested.error, null);
  assert.equal((await api.getConnector(id)).status, "connected");
  assert.equal((await api.getConnector(id)).tool_count, 1);
  const pending = await api.updateConnector(id, { url: "https://mcp.example/new" });
  assert.equal(pending.connector.pending_restart, true);
  assert.equal(pending.connector.status, "connected");
  assert.equal(pending.connector.tool_count, 1);
  // success 与 pending_restart 可以同时为 true：通过探测的是旧参数的当前连接。
  assert.deepEqual(await api.testConnector(id),
    { success: true, tool_count: 1, error: null, pending_restart: true });
  assert.equal((await api.listConnectors()).as_of_seq, pending.event!.seq);
  const replayed = await api.createConnector("connector-create", {
    name: "资料库", description: "按需检索资料", url: "https://mcp.example/tools",
    headers: { Authorization: "Bearer initial-secret", "X-Region": "east-secret" },
  });
  assert.equal(replayed.event.seq, created.event.seq);
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.connector, created.connector);
  assert.equal(JSON.stringify(replayed).includes("initial-secret"), false);

  const selected = await api.updateAgent(agent.agent.id, {
    mcp_servers: [], searchable_mcp_servers: [id],
  });
  assert.deepEqual(selected.agent.mcp_servers, []);
  assert.deepEqual(selected.agent.searchable_mcp_servers, [id]);
  assert.deepEqual((await api.getConnector(id)).used_by.map((user) => user.id), [agent.agent.id]);
  await assert.rejects(api.updateAgent(agent.agent.id, {
    mcp_servers: [id], searchable_mcp_servers: [id],
  }), (error: unknown) => error instanceof GatewayError && error.status === 400);
  await assert.rejects(api.updateAgent(agent.agent.id, {
    searchable_mcp_servers: ["missing"],
  }), (error: unknown) => error instanceof GatewayError && error.status === 400);

  await assert.rejects(api.createConnector("connector-fail", {
    name: "失联", description: "连接失败", url: "https://mcp.example/fail",
    headers: { Authorization: "Bearer forbidden-secret" },
  }), (error: unknown) => error instanceof GatewayError && error.status === 502
    && error.code === "connection_failed" && !JSON.stringify(error).includes("forbidden-secret"));
  assert.equal((await api.listConnectors()).connectors.some((connector) => connector.name === "失联"), false);

  const local = await api.createConnector("connector-local", {
    name: "本地进程", command: "fixture-mcp", args: ["line one\nline two", "", "--serve"],
    env: { ACCESS_TOKEN: "local-secret", REGION: "east" },
  });
  assert.deepEqual(local.connector.env, { ACCESS_TOKEN: true, REGION: true });
  assert.deepEqual((await api.getConnector(local.connector.id)).env, { ACCESS_TOKEN: true, REGION: true });
  assert.deepEqual((await api.getConnector(local.connector.id)).args, ["line one\nline two", "", "--serve"]);
  assert.deepEqual((await api.updateConnector(local.connector.id, {
    env: { ACCESS_TOKEN: null },
  })).connector.env, { REGION: true });
  assert.equal(JSON.stringify((await api.listConnectors()).connectors).includes("local-secret"), false);

  const deleted = await api.deleteConnector(id);
  assert.deepEqual(deleted.event.data, { kind: "connector", id, op: "deleted" });
  const detached = await api.getAgent(agent.agent.id);
  assert.deepEqual(detached.mcp_servers, []);
  assert.deepEqual(detached.searchable_mcp_servers, []);
  assert.equal((await api.listConnectors()).connectors.some((connector) => connector.id === id), false);
  await assert.rejects(api.getConnector(id), (error: unknown) =>
    error instanceof GatewayError && error.status === 404);
  await gateway.kill();
});
test("双设备改名、删除当前对话：标题即时同步，删除续传不进时间线且资源幂等", async () => {
  const gateway = await sharedGateway();
  const phone = await started(gateway);
  const tablet = await started(gateway);
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const automaticallyTitled = await phone.createConversation("helper", undefined, globalThis.crypto.randomUUID());
  await phone.send(automaticallyTitled, "  第一行\n第二行  ");
  await until(() => phone.conversations.get(automaticallyTitled)?.title === "第一行 第二行");
  await until(() => tablet.conversations.get(automaticallyTitled)?.title === "第一行 第二行");
  const remaining = await phone.createConversation("assistant", "留下的对话", globalThis.crypto.randomUUID());
  const current = await phone.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  await until(() => tablet.conversations.has(current));
  const leave = tablet.view(current);
  assert.equal(await phone.renameConversation(current, "手动标题"), true);
  await until(() => tablet.conversations.get(current)?.title === "手动标题");
  await until(() => phone.agents.agents.find((a) => a.id === "assistant")?.latest_conversation?.title === "手动标题");
  const before = (await serverHistory(gateway, current)).filter((e) => e.type === "conversation.updated").length;
  assert.equal((await api.renameConversation(current, "手动标题")).event, null);
  assert.equal((await serverHistory(gateway, current)).filter((e) => e.type === "conversation.updated").length, before);
  assert.equal(await phone.deleteConversation(current), true);
  await until(() => !tablet.conversations.has(current));
  assert.deepEqual(chatEntryTarget(tablet, current), { type: "conversation", id: automaticallyTitled });
  assert.equal(tablet.timelines.has(current), false);
  assert.equal(tablet.pendingFor(current).length, 0);
  await until(() => tablet.agents.agents.find((a) => a.id === "assistant")?.latest_conversation?.id === remaining);
  const replay = await api.deleteConversation(current);
  assert.equal(replay.event.type, "conversation.deleted");
  assert.equal(replay.event.conversation_id, undefined);
  assert.deepEqual(replay.event.data, { id: current, agent_id: "assistant" });
  assert.equal((await phone.api.deleteConversation(current)).event.seq, replay.event.seq);
  assert.equal(phone.timelines.has(current), false);
  assert.deepEqual((await api.listConversations("assistant")).conversations.map((c) => c.id), [remaining]);
  await assert.rejects(api.history(current), (error: unknown) => error instanceof GatewayError && error.status === 404);
  await assert.rejects(api.deleteConversation("never-existed"), (error: unknown) => error instanceof GatewayError && error.status === 404);
  leave();
});
test("发消息：先本地显示，经事件流收到工作中、回复、空闲；同一 client_id 重试只执行一次", async () => {
  const gateway = await sharedGateway();
  const session = await started(gateway);
  const id = await session.createConversation("assistant", "测试", globalThis.crypto.randomUUID());
  const leave = session.view(id);
  const sending = session.send(id, "你好");
  assert.equal(session.pendingFor(id)[0].status, "sending");
  await sending;
  await until(() => session.conversations.get(id)!.status === "idle" && texts(session, id, "message.agent").length === 1);
  assert.deepEqual(texts(session, id, "message.agent"), ["收到：你好"]);
  assert.deepEqual(
    session.timeline(id).events.filter((e) => e.type === "conversation.status").map((e) => e.data.status),
    ["working", "idle"],
  );
  assert.equal(session.pendingFor(id).length, 0);
  assert.equal(session.conversations.get(id)!.last_text, "收到：你好");
  await until(() => session.conversations.get(id)!.unread === false); // 正在看，自动已读

  const clientId = session.timeline(id).events.find((e) => e.type === "message.user")!.client_id!;
  const replay = await session.api.sendMessage(id, clientId, "你好");
  assert.equal(replay.replayed, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(texts(session, id, "message.agent").length, 1);
  leave();
  await session.close();
});
test("反复断线重连：时间线与网关历史一致，不漏不重", async () => {
  const gateway = await sharedGateway();
  const session = await started(gateway);
  const id = await session.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  session.view(id);
  const other = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  for (let index = 0; index < 8; index++) {
    session.reconnectNow(); // 每条消息前后都打断一次连接
    await other.sendMessage(id, `m${index}`, `第 ${index} 条`);
    session.reconnectNow();
  }
  // 先等网关处理完全部消息（8 条回复、回到空闲），再等客户端追上；否则可能在中间状态上“恰好相等”。
  await until(async () => {
    const events = await serverHistory(gateway, id);
    const { conversations } = await other.listConversations();
    return events.filter((e) => e.type === "message.agent").length === 8 && conversations[0].status === "idle";
  });
  // 固定快照的上界：session.view(id) 仍会异步上报已读，之后还会出现 conversation.read，
  // 时间线会继续增长；只比较上界以内的完整事件序列。
  const final = await serverHistory(gateway, id);
  const bound = final[final.length - 1].seq;
  await until(() => session.timeline(id).events.some((e) => e.seq >= bound));
  assert.deepEqual(
    session.timeline(id).events.filter((e) => e.seq <= bound),
    final,
  );
  assert.equal(texts(session, id, "message.agent").length, 8);
  await session.close();
});
test("根与成员压缩系统行经 SSE 和历史恢复，摘要完整且失败原因可见", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const id = await session.createConversation("assistant", "压缩", globalThis.crypto.randomUUID());
  session.view(id);
  await session.send(id, "CONTEXT_COMPACT_ROOT");
  await until(() => session.timeline(id).events.some((event) => event.type === "context.compacted"));
  await session.send(id, "CONTEXT_COMPACT_CHILD");
  await until(() => session.timeline(id).events.some((event) => event.type === "context.compaction_failed"));
  const notifications = session.timeline(id).events.filter((event) => event.type.startsWith("context."));
  assert.deepEqual(notifications.map((event) => event.type),
    ["context.compacted", "context.compacted", "context.compaction_failed"]);
  assert.deepEqual(notifications.map((event) => event.data.agent_id), ["assistant", "helper", "helper"]);
  assert.ok(notifications[0].data.summary_text.endsWith("末尾事实 42"));
  assert.equal(notifications[1].data.retained_tokens, 2048);
  assert.equal(notifications[1].data.archive_path, "/workspace/.wandrun/artifacts/compaction/index.md");
  assert.deepEqual(projectChatRows({ events: session.timeline(id).events, pending: [] }).rows.filter((item) => item.event?.type.startsWith("context."))
    .map((item) => item.event!.seq), notifications.map((event) => event.seq));
  await session.close();
  await gateway.kill();
  await gateway.start();
  const reopened = await started(gateway);
  reopened.view(id);
  await until(() => reopened.timeline(id).loaded);
  assert.deepEqual(reopened.timeline(id).events.filter((event) => event.type.startsWith("context.")), notifications);
  await gateway.kill();
});
test("网关换库：旧摘要失效，迟到列表被丢弃，补拉失败仍选择新库对话", async (t) => {
  const gateway = new StubGateway();
  await gateway.start();
  let mode: "pass" | "hold" | "fail" = "pass";
  let captured = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const controlled: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/agents") {
      if (mode === "fail") throw new TypeError("换库后列表不可用");
      if (mode === "hold") {
        const response = await fetch(input, init);
        const body = await response.text();
        captured = true;
        await held;
        return new Response(body, { status: response.status, headers: response.headers });
      }
    }
    return fetch(input, init);
  };
  const session = new ChatSession({ baseUrl: gateway.url, token: "dev" }, controlled, { retryDelays: [100, 200] });
  sessions.add(session);
  await session.start();
  // start() 只等列表；SSE 尚未 open 时 send() 会留在本地失败，不会发给网关。
  await until(() => session.connection === "open");
  const id = await session.createConversation("assistant", "旧库里的对话", globalThis.crypto.randomUUID());
  // HTTP acceptance is not one reply per send; this fixture replies to the last prompt in a batch.
  for (let index = 0; index < 3; index++) await session.send(id, `x${index}`);
  await until(() => session.agents.agents.find((a) => a.id === "assistant")?.latest_conversation?.last_text === "收到：x2");
  const oldSeq = session.agents.agents.find((a) => a.id === "assistant")!.latest_conversation!.last_activity_seq!;
  mode = "hold";
  session.agents.refresh();
  await until(() => captured);
  mode = "fail";
  await gateway.kill();
  await gateway.start(path.join(directory, `fresh-${gateway.port}.sqlite`));
  session.reconnectNow();
  await until(() => session.connection === "open" && !session.conversations.has(id), 10_000);
  assert.equal(session.conversations.size, 0);
  assert.equal(session.agents.agents.find((a) => a.id === "assistant")!.latest_conversation, null);
  const fresh = await session.createConversation("assistant", "新库", globalThis.crypto.randomUUID());
  await session.send(fresh, "新的");
  await until(() => texts(session, fresh, "message.agent").length === 1);
  assert.ok(session.conversations.get(fresh)!.lastTextSeq < oldSeq);
  assert.equal(await session.conversationFor(session.agents.agents.find((a) => a.id === "assistant")!), fresh);
  release();
  await until(() => session.agents.error !== null); // 旧响应已处理，补拉失败
  assert.equal(session.agents.agents.find((a) => a.id === "assistant")!.latest_conversation, null);
  assert.equal(await session.conversationFor(session.agents.agents.find((a) => a.id === "assistant")!), fresh);
  mode = "pass";
  session.agents.refresh();
  await until(() => session.agents.agents.find((a) => a.id === "assistant")?.latest_conversation?.id === fresh);
  assert.equal(await session.conversationFor(session.agents.agents.find((a) => a.id === "assistant")!), fresh);
  await session.close();
  await gateway.kill();
});
test("停止：工作中显示正在做什么，停止后记录 was_working 并回到空闲", async () => {
  const gateway = await sharedGateway();
  const session = await started(gateway);
  const id = await session.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  session.view(id);
  await session.send(id, "慢慢做");
  await until(() => session.conversations.get(id)!.activity === "正在运行命令");
  assert.equal(session.conversations.get(id)!.status, "working");
  await session.stop(id);
  const stopped = session.timeline(id).events.find((e) => e.type === "turn.stopped")!;
  assert.deepEqual(stopped.data, { was_working: true });
  await until(() => session.conversations.get(id)!.status === "idle");
  assert.equal(session.conversations.get(id)!.activity, null);
  await session.close();
});
test("历史分页：新打开的会话一页页往前翻，与网关全部历史一致", async () => {
  const gateway = await sharedGateway();
  const writer = await started(gateway);
  const id = await writer.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  for (let index = 0; index < 20; index++) await writer.send(id, `n${index}`);
  await until(() => texts(writer, id, "message.agent").length === 20, 10_000);
  await until(() => writer.conversations.get(id)!.status === "idle");

  const reader = await started(gateway);
  reader.view(id);
  await until(() => reader.timeline(id).loaded);
  assert.equal(reader.timeline(id).complete, false); // 第一页 50 条之外还有；打开时的已读事件会经事件流另外进来
  while (!reader.timeline(id).complete) await reader.loadOlder(id);
  const seqs = () => reader.timeline(id).events.map((e) => e.seq).join();
  // 打开时自己产生的已读事件经事件流稍后到达，等它一下再逐条比对。
  await until(async () => seqs() === (await serverHistory(gateway, id)).map((e) => e.seq).join());
  assert.ok(reader.timeline(id).events.length > 80);
  await writer.close();
  await reader.close();
});
test("历史先于 SSE：补录不挡住当前字段推进，列表失败仍选择新活动且时间线不重复", async (t) => {
  const gateway = await sharedGateway();
  const config = { baseUrl: gateway.url, token: "dev" };
  const api = new GatewayApi(config);
  const a = await api.createConversation("helper", "A", globalThis.crypto.randomUUID());
  await api.sendMessage(a.id, `${a.id}-old-a`, "旧消息");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === a.id && c.status === "idle" && c.last_text === "收到：旧消息"));
  const b = await api.createConversation("helper", "B", globalThis.crypto.randomUUID());
  let failAgents = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const controlled: typeof fetch = async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/agents" && failAgents) throw new TypeError("列表不可用");
    const response = await fetch(input, init);
    if (pathname !== "/events") return response;
    const reader = response.body!.getReader();
    return new Response(new ReadableStream({
      async pull(controller) {
        const value = await reader.read();
        await held;
        if (value.done) controller.close();
        else controller.enqueue(value.value);
      },
      cancel() { return reader.cancel(); },
    }), { status: response.status, headers: response.headers });
  };
  const session = new ChatSession(config, controlled, { retryDelays: [100, 200] });
  sessions.add(session);
  await session.start();
  await until(() => session.connection === "open" && session.agents.loaded);
  const stale = session.agents.agents.find((agent) => agent.id === "helper")!;
  assert.equal(stale.latest_conversation!.id, a.id);
  failAgents = true;
  await api.sendMessage(b.id, `${b.id}-new-b`, "新消息");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === b.id && c.status === "idle" && c.last_text === "收到：新消息"));
  await api.sendMessage(b.id, `${b.id}-working-b`, "慢慢做");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === b.id && c.status === "working"));
  await session.loadOlder(b.id);
  const history = [...session.timeline(b.id).events];
  const reply = history.find((event) => event.type === "message.agent")!;
  assert.equal(reply.data.text, "收到：新消息");
  const lastMessage = history.findLast((event) => event.type === "message.user")!;
  assert.equal(session.conversations.get(b.id)!.last_text, null); // 历史只补时间线
  assert.equal(session.conversations.get(b.id)!.status, "idle"); // 历史也不能推进状态
  release();
  await until(() => session.lastSeq >= history.at(-1)!.seq && session.agents.error !== null);
  const current = session.conversations.get(b.id)!;
  assert.equal(current.last_text, lastMessage.data.text);
  assert.equal(current.lastTextSeq, lastMessage.seq);
  assert.equal(current.last_activity_at, lastMessage.at);
  assert.equal(current.lastAgentSeq, reply.seq);
  assert.equal(current.unread, true);
  assert.equal(current.status, "working");
  assert.deepEqual(session.timeline(b.id).events, history);
  assert.equal(await session.conversationFor(stale), b.id);
  assert.equal(session.connection, "open");
});
test("冷启动未读：其他对话推进全局水位后，本机和另一设备的已读都能清除旧回复红点", async (t) => {
  for (const reader of ["phone", "tablet"] as const) {
    await t.test(reader, async () => {
      const gateway = await sharedGateway();
      const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
      const a = await api.createConversation("assistant", "A", globalThis.crypto.randomUUID());
      await api.sendMessage(a.id, `${a.id}-cold-a`, "A");
      await until(async () => (await api.listConversations()).conversations
        .some((c) => c.id === a.id && c.status === "idle" && c.last_text === "收到：A"));
      const aLatest = (await serverHistory(gateway, a.id)).at(-1)!.seq;
      const b = await api.createConversation("assistant", "B", globalThis.crypto.randomUUID());
      await api.sendMessage(b.id, `${b.id}-cold-b`, "B");
      await until(async () => (await api.listConversations()).conversations
        .some((c) => c.id === b.id && c.status === "idle" && c.last_text === "收到：B"));
      const snapshot = await api.listConversations();
      assert.ok(snapshot.as_of_seq > aLatest);
      const phone = await started(gateway);
      assert.equal(phone.conversations.get(a.id)!.unread, true);
      const tablet = reader === "tablet" ? await started(gateway) : phone;
      const leave = tablet.view(a.id);
      await until(async () => !(await api.listConversations()).conversations.find((c) => c.id === a.id)!.unread);
      const readEvent = (await serverHistory(gateway, a.id)).findLast((event) => event.type === "conversation.read")!;
      await until(() => phone.lastSeq >= readEvent.seq);
      leave();
      assert.equal(phone.conversations.get(a.id)!.unread, false,
        `${reader}: read_seq=${phone.conversations.get(a.id)!.read_seq}, lastAgentSeq=${phone.conversations.get(a.id)!.lastAgentSeq}, snapshot=${snapshot.as_of_seq}`);
      // A truly later reply must restore unread even after the snapshot baseline was acknowledged.
      await api.sendMessage(a.id, `${a.id}-cold-a-later`, "later");
      await until(() => phone.timeline(a.id).events.some((event) =>
        event.type === "message.agent" && event.data.text === "收到：later"));
      assert.equal(phone.conversations.get(a.id)!.unread, true);
      await phone.close();
      if (tablet !== phone) await tablet.close();
    });
  }
});
test("未读：另一台设备看过之后，红点经 conversation.read 同步消失", async () => {
  const gateway = await sharedGateway();
  const phone = await started(gateway);
  const tablet = await started(gateway);
  const id = await phone.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  await phone.send(id, "在吗");
  await until(() => phone.conversations.get(id)?.unread === true && tablet.conversations.get(id)?.unread === true);
  tablet.view(id);
  await until(() => phone.conversations.get(id)!.unread === false);
  await phone.close();
  await tablet.close();
});
test("令牌错误：报告错误，不反复重试", async () => {
  const gateway = await sharedGateway();
  const session = new ChatSession({ baseUrl: gateway.url, token: "wrong" });
  sessions.add(session);
  await session.start();
  assert.equal(session.connection, "error");
  assert.equal(session.notice, "令牌不对");
  await session.close();
});
test("非空摘要过期：列表阻塞或失败时仍进入最新产品活动的对话，空对话不抢占", async (t) => {
  const gateway = await sharedGateway();
  const config = { baseUrl: gateway.url, token: "dev" };
  const api = new GatewayApi(config);
  const a = await api.createConversation("helper", "A", globalThis.crypto.randomUUID());
  await api.sendMessage(a.id, `${a.id}-old-a`, "旧消息");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === a.id && c.status === "idle" && c.last_text === "收到：旧消息"));
  const b = await api.createConversation("helper", "B", globalThis.crypto.randomUUID());
  let mode: "pass" | "hold" | "fail" = "pass";
  let captured = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const controlled: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/agents") {
      if (mode === "fail") throw new TypeError("列表不可用");
      if (mode === "hold") {
        const response = await fetch(input, init);
        const body = await response.text();
        captured = true;
        await held;
        return new Response(body, { status: response.status, headers: response.headers });
      }
    }
    return fetch(input, init);
  };
  const session = new ChatSession(config, controlled, { retryDelays: [100, 200] });
  sessions.add(session);
  await session.start();
  await until(() => session.connection === "open" && session.agents.loaded);
  const stale = session.agents.agents.find((agent) => agent.id === "helper")!;
  assert.equal(stale.latest_conversation!.id, a.id);
  // B 比 A 新建，但尚无产品活动，不能抢占 A。
  assert.equal(await session.conversationFor(stale), a.id);
  mode = "hold";
  session.agents.refresh();
  await until(() => captured);
  await session.send(b.id, "新消息");
  assert.equal(await session.conversationFor(stale), b.id); // 已确认的用户消息就算活动，不必等回复
  await until(() => session.conversations.get(b.id)?.last_text === "收到：新消息" && session.conversations.get(b.id)?.status === "idle");
  assert.equal(await session.conversationFor(stale), b.id);
  await session.createConversation("helper", "空对话", globalThis.crypto.randomUUID());
  assert.equal(await session.conversationFor(stale), b.id);
  mode = "fail";
  release();
  await until(() => session.agents.error !== null);
  assert.equal(session.connection, "open");
  assert.equal(session.agents.agents.find((agent) => agent.id === "helper")!.latest_conversation!.id, a.id);
  assert.equal(await session.conversationFor(stale), b.id);
  mode = "pass";
  session.agents.refresh();
  await until(() => session.agents.agents.find((agent) => agent.id === "helper")?.latest_conversation?.id === b.id);
  assert.equal(await session.conversationFor(session.agents.agents.find((agent) => agent.id === "helper")!), b.id);
});
test("Agent 记忆 API 的版本冲突、长度、删除与资源事件；成员更新归根对话", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const session = await started(gateway);
  const empty = await api.getMemory("work", "helper");
  const profile = await api.getMemory("profile");
  assert.equal(empty.content, "");
  assert.equal(empty.scope, "work");
  assert.equal(profile.scope, "profile");
  assert.equal(profile.agent_id, undefined);
  assert.equal(empty.updated_at, null);
  assert.equal(empty.updated_by, null);
  assert.equal(empty.limit, 1000);

  const saved = await api.updateMemory("work", "helper", "# 成员\r\n😀", empty.version);
  assert.equal(saved.content, "# 成员\n😀");
  assert.equal(saved.updated_by, "user");
  await until(() => session.memoryRevisionFor("work", "helper") > 0);
  assert.equal(session.memoryRevisionFor("work", "assistant"), 0);
  const revision = session.memoryRevisionFor("work", "helper");
  await api.updateMemory("work", "helper", "# 成员\n😀", saved.version);
  assert.equal(session.memoryRevisionFor("work", "helper"), revision);
  await assert.rejects(api.updateMemory("work", "helper", "x".repeat(1001), saved.version),
    (error: unknown) => error instanceof GatewayError && error.status === 400);
  assert.equal((await api.getMemory("work", "helper")).content, saved.content);
  await assert.rejects(api.updateMemory("work", "helper", "竞争写入", empty.version),
    (error: unknown) => {
      if (!(error instanceof GatewayError) || error.status !== 409 ||
          !error.details || typeof error.details !== "object" || !("current" in error.details)) return false;
      const current = error.details.current;
      return !!current && typeof current === "object" && "version" in current && current.version === saved.version;
    });

  const root = await api.createConversation("assistant", undefined, globalThis.crypto.randomUUID());
  const unrelated = await api.createConversation("assistant", "不相关的根", globalThis.crypto.randomUUID());
  const rootMemory = await api.getMemory("work", "assistant");
  await api.sendMessage(root.id, "memory-e2e", "MEMORY_UPDATE_MEMBER:helper:# 委派成员自己的记忆");
  await until(() => session.timeline(root.id).events.some((event) => event.type === "memory.updated"));
  const event = session.timeline(root.id).events.find((entry) => entry.type === "memory.updated")!;
  assert.equal(event.conversation_id, root.id);
  assert.deepEqual([event.data.agent_id, event.data.scope, event.data.summary], ["helper", "work", "已记住"]);
  assert.equal(projectChatRows({ events: session.timeline(root.id).events, pending: [] }).rows.some((item) => item.event?.seq === event.seq), true);
  assert.equal((await api.getMemory("work", "helper")).updated_by, "agent");
  assert.equal((await api.getMemory("work", "helper")).content, "# 委派成员自己的记忆");
  assert.deepEqual(await api.getMemory("work", "assistant"), rootMemory);
  assert.deepEqual(await api.getMemory("profile"), profile);
  const delegated = (await api.collaborations("assistant")).conversations;
  assert.equal(delegated.length, 1);
  assert.deepEqual([delegated[0].root_id, delegated[0].agent_id, delegated[0].creator_agent_id],
    [root.id, "helper", "assistant"]);
  const memberHistory = (await api.taskHistory(delegated[0].id)).events;
  assert.ok(memberHistory.some((entry) => entry.type === "message.task" &&
    entry.data.text.includes("MEMORY_UPDATE_MEMBER:helper:")));
  assert.equal(memberHistory.some((entry) => entry.type === "memory.updated"), false);
  assert.deepEqual((await api.history(root.id)).events.filter((entry) => entry.type === "memory.updated"), [event]);
  assert.equal((await api.history(unrelated.id)).events.some((entry) => entry.type === "memory.updated"), false);
  assert.equal(session.memoryRevisionFor("work", "assistant"), 0);
  assert.equal(session.memoryRevisionFor("profile"), 0);
  assert.equal((await api.listConversations("helper")).conversations.length, 0);
  await until(() => session.memoryRevisionFor("work", "helper") > revision);
  const shared = await api.updateMemory("profile", undefined, "Shared profile", profile.version);
  await until(() => session.memoryRevisionFor("profile", "assistant") > 0);
  assert.equal(session.memoryRevisionFor("profile", "helper"), session.memoryRevisionFor("profile", "assistant"));
  assert.equal((await api.getMemory("work", "helper")).content.includes("Shared profile"), false);
  assert.equal(shared.content, "Shared profile");
  const created = await api.updateMemoryDetail("profile", undefined, "topic", "First 😀", shared.version,
    "Shared profile\n- [topic](/.wandrun/memory/profile/details/topic.md)\n");
  assert.equal(created.scope, "profile");
  assert.ok(created.details.topic.path.startsWith("/.wandrun/memory/profile/details/topic/"));
  const detail = await api.getMemoryDetail("profile", undefined, "topic");
  assert.equal(detail.content, "First 😀");
  assert.equal(detail.version, created.version);
  assert.equal(detail.path, created.details.topic.path);
  await assert.rejects(api.updateMemoryDetail("profile", undefined, "topic", "Outdated", shared.version),
    (error: unknown) => error instanceof GatewayError && error.status === 409);
  const changed = await api.updateMemoryDetail("profile", undefined, "topic", "New detail", created.version);
  assert.notEqual(changed.version, created.version);
  const removed = await api.deleteMemoryDetail("profile", undefined, "topic", "Shared profile\n", changed.version);
  assert.deepEqual(removed.details, {});
  await assert.rejects(api.getMemoryDetail("profile", undefined, "topic"),
    (error: unknown) => error instanceof GatewayError && error.status === 400);


  await api.updateAgent("assistant", { workers: [] });
  await api.deleteAgent("helper");
  await assert.rejects(api.getMemory("work", "helper"), (error: unknown) =>
    error instanceof GatewayError && error.status === 404);
  await assert.rejects(api.updateMemory("work", "helper", "复活", saved.version), (error: unknown) =>
    error instanceof GatewayError && error.status === 404);
  assert.equal((await api.getMemory("profile")).content, "Shared profile\n");
});
test("two real gateway instances isolate identical agent IDs, event sequences, files and device revocation", async () => {
  const first = new StubGateway();
  const second = new StubGateway();
  await Promise.all([first.start(), second.start()]);
  async function pair(gateway: StubGateway) {
    const challenge = await fetch(`${gateway.url}/admin/pairing-codes`, {
      method: "POST", headers: { Authorization: "Bearer mobile-test-management", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Protocol phone" }),
    });
    assert.equal(challenge.status, 200);
    const { code } = await challenge.json();
    return exchangePairingCode(gateway.url, code, "manual");
  }
  const [firstDevice, secondDevice] = await Promise.all([pair(first), pair(second)]);
  const firstApi = new GatewayApi({ baseUrl: first.url, token: firstDevice.token, computerId: "first" });
  const secondApi = new GatewayApi({ baseUrl: second.url, token: secondDevice.token, computerId: "second" });
  assert.deepEqual((await firstApi.listAgents()).agents.map(({ id }) => id),
    (await secondApi.listAgents()).agents.map(({ id }) => id));
  const firstConversation = await firstApi.createConversation("assistant", "same title", globalThis.crypto.randomUUID());
  const secondConversation = await secondApi.createConversation("assistant", "same title", globalThis.crypto.randomUUID());
  await Promise.all([
    firstApi.sendMessage(firstConversation.id, "first-file", "FILE_DELIVERY:same.txt"),
    secondApi.sendMessage(secondConversation.id, "second-file", "FILE_DELIVERY:same.txt"),
  ]);
  await until(async () => (await firstApi.history(firstConversation.id)).events.some((event) => event.type === "message.agent"));
  await until(async () => (await secondApi.history(secondConversation.id)).events.some((event) => event.type === "message.agent"));
  const firstHistory = (await firstApi.history(firstConversation.id)).events;
  const secondHistory = (await secondApi.history(secondConversation.id)).events;
  const firstFile = firstHistory.find((event) => event.type === "message.agent")!.data.attachments[0];
  const secondFile = secondHistory.find((event) => event.type === "message.agent")!.data.attachments[0];
  assert.equal(firstHistory.find((event) => event.type === "message.user")?.seq,
    secondHistory.find((event) => event.type === "message.user")?.seq);
  assert.notEqual(firstConversation.id, secondConversation.id);
  assert.notEqual(firstFile.id, secondFile.id);
  assert.equal((await secondApi.listConversations()).conversations.some(({ id }) => id === firstConversation.id), false);
  assert.equal((await firstApi.getFile(firstFile.id)).available, true);
  await assert.rejects(secondApi.getFile(firstFile.id), (error: unknown) => error instanceof GatewayError && error.status === 404);
  const firstMemory = await firstApi.getMemory("work", "assistant");
  await firstApi.updateMemory("work", "assistant", "first computer", firstMemory.version);
  assert.equal((await firstApi.getMemory("work", "assistant")).content, "first computer");
  assert.equal((await secondApi.getMemory("work", "assistant")).content, "");
  await firstApi.revokeCurrent();
  await assert.rejects(firstApi.listConversations(), (error: unknown) => error instanceof GatewayError && error.status === 401);
  assert.equal((await secondApi.getFile(secondFile.id)).available, true);
  assert.equal((await secondApi.listConversations()).conversations[0].id, secondConversation.id);
  assert.equal((await secondApi.getMemory("work", "assistant")).content, "");
  firstApi.close();
  secondApi.close();
});

test("协作 L3：委派、成员插话、完成后续聊与删除根清成员", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const observer = await started(gateway);
  const api = session.api;
  const root = await session.createConversation("assistant", "协作归属", globalThis.crypto.randomUUID());
  session.view(root);
  await session.send(root, "COLLAB_DELEGATE");
  await until(() => [...session.tasks.values()].some((task) => task.root_id === root && task.status === "running"));
  const [member] = (await api.collaborations("assistant")).conversations;
  assert.deepEqual([member.root_id, member.agent_id, member.creator_task_id, member.creator_agent_id],
    [root, "helper", root, "assistant"]);
  assert.deepEqual((await api.receivedConversations("helper")).conversations.map((item) => item.id), [member.id]);
  assert.deepEqual((await api.listConversations("helper")).conversations, []);
  session.view(member.id);
  await until(() => session.timeline(member.id).loaded);
  assert.ok(session.timeline(member.id).events.some((event) =>
    event.type === "message.task" && event.data.text === "COLLAB_MEMBER_WAIT"));

  for (const result of ["323", "667"]) {
    // 第二轮必须在同一成员已完成之后续聊，不能新委派一个看似相同的任务。
    await session.send(member.id, `COLLAB_RESULT:${result}`);
    await until(() => session.tasks.get(member.id)?.status === "completed" &&
      texts(session, root, "message.agent").includes(`收到协作结果：${result}`));
    await until(() => texts(observer, member.id, "message.agent").includes(`成员私有正文：${result}`));
    assert.equal(session.pendingFor(member.id).length, 0);
    const interjection = session.timeline(member.id).events.find((event) =>
      event.type === "message.user" && event.data.text === `COLLAB_RESULT:${result}`)!;
    assert.deepEqual(interjection.data.timeline_ids, [member.id]);
    const replay = await api.sendTaskMessage(member.id, interjection.client_id!, `COLLAB_RESULT:${result}`);
    assert.equal(replay.replayed, true);
    assert.equal(replay.event.seq, interjection.seq);
    const privateMessage = session.timeline(member.id).events.find((event) =>
      event.type === "message.agent" && event.data.text === `成员私有正文：${result}`)!;
    assert.equal(privateMessage.data.task_id, member.id);
    assert.equal(privateMessage.data.agent, "helper");
    assert.deepEqual(privateMessage.data.timeline_ids, [member.id]);
    assert.ok(session.timeline(member.id).events.some((event) =>
      event.type === "message.task" && event.data.text === `COLLAB_PARENT:${result}`));
    assert.equal(session.timeline(root).events.some((event) =>
      event.seq === interjection.seq || event.seq === privateMessage.seq || event.type === "message.task"), false);
    assert.equal((await api.collaborations("assistant")).conversations.length, 1);
  }
  assert.deepEqual(texts(session, member.id, "message.user"), ["COLLAB_RESULT:323", "COLLAB_RESULT:667"]);
  assert.deepEqual(texts(session, root, "message.agent"), ["收到协作结果：323", "收到协作结果：667"]);
  await session.refreshCollaborations("assistant");
  await observer.refreshCollaborations("helper");
  assert.equal(await session.deleteConversation(root), true);
  await until(() => !observer.conversations.has(root) && !observer.tasks.has(member.id));
  assert.equal(session.tasks.has(member.id), false);
  assert.equal(session.timelines.has(member.id), false);
  assert.equal(observer.timelines.has(member.id), false);
  assert.deepEqual((await api.collaborations("assistant")).conversations, []);
  assert.deepEqual((await api.receivedConversations("helper")).conversations, []);
  await assert.rejects(api.task(member.id), (error: unknown) => error instanceof GatewayError && error.status === 404);
  await assert.rejects(api.taskHistory(member.id), (error: unknown) => error instanceof GatewayError && error.status === 404);
});

test("调度 L3：资源事件、确定性触发、runs 与删除后来源贯通", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const api = session.api;
  const before = session.scheduleRevision;
  const fields = {
    name: "客户端定时", content: "确定性定时执行", timezone: "Etc/UTC",
    rule: { kind: "once" as const, local_at: "2099-01-01T00:00" },
  };
  const created = await api.createSchedule("assistant", "schedule-l3-create", fields);
  const id = created.schedule.id;
  await until(() => session.lastSeq >= created.event.seq);
  assert.ok(session.scheduleRevision > before);
  assert.deepEqual(created.event.data, { kind: "schedule", id, op: "created" });
  assert.deepEqual((await api.listSchedules("assistant")).schedules, [created.schedule]);
  assert.deepEqual((await api.scheduleRuns(id)).runs, []);
  const renamed = await api.updateSchedule(id, { name: "已改名的定时" });
  await until(() => session.lastSeq >= renamed.event!.seq);
  assert.equal((await api.getSchedule(id)).name, "已改名的定时");
  assert.equal((await api.updateSchedule(id, { name: "已改名的定时" })).event, null);

  const fired = await fetch(`${gateway.url}/__protocol/schedules/${id}/fire`, {
    method: "POST", headers: api.headers(),
  });
  assert.equal(fired.status, 204);
  await until(async () => (await api.scheduleRuns(id)).runs[0]?.status === "completed");
  const { runs, as_of_seq } = await api.scheduleRuns(id);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.deepEqual([run.schedule_id, run.scheduled_at, run.name, run.content],
    [id, created.schedule.next_run_at, "已改名的定时", fields.content]);
  assert.ok(run.started_at !== null && run.finished_at !== null);
  assert.equal(run.reason, null);
  const conversationId = run.conversation_id!;
  await until(() => session.conversations.get(conversationId)?.status === "idle" &&
    texts(session, conversationId, "message.agent").length === 1);
  assert.ok(as_of_seq >= session.timeline(conversationId).events.find((event) => event.type === "message.agent")!.seq);
  const origin = { schedule_id: id, run_id: run.id, name: run.name, scheduled_at: run.scheduled_at };
  assert.equal(session.conversations.get(conversationId)!.source, "schedule");
  assert.deepEqual(session.conversations.get(conversationId)!.schedule_origin, origin);
  assert.deepEqual(texts(session, conversationId, "message.agent"), [`收到：${fields.content}`]);
  const history = (await api.history(conversationId)).events;
  assert.deepEqual(history.find((event) => event.type === "conversation.created")!.data.schedule_origin, origin);
  assert.deepEqual(history.filter((event) => event.type === "schedule.triggered").map((event) => event.data), [origin]);
  assert.deepEqual(session.timeline(conversationId).events.filter((event) => event.type === "schedule.triggered"),
    history.filter((event) => event.type === "schedule.triggered"));
  const exhausted = await api.getSchedule(id);
  assert.equal(exhausted.enabled, false);
  assert.equal(exhausted.next_run_at, null);
  assert.equal((await fetch(`${gateway.url}/__protocol/schedules/${id}/fire`, {
    method: "POST", headers: api.headers(),
  })).status, 204);
  assert.equal((await api.scheduleRuns(id)).runs.length, 1);
  const removed = await api.deleteSchedule(id);
  await until(() => session.deletedScheduleIds.has(id) && session.lastSeq >= removed.event.seq);
  assert.deepEqual((await api.listSchedules("assistant")).schedules, []);
  assert.equal(session.conversations.has(conversationId), true);
  assert.deepEqual((await api.listConversations()).conversations.find((item) => item.id === conversationId)!.schedule_origin, origin);
  assert.deepEqual((await api.history(conversationId)).events, history);
  await session.close();
  await gateway.kill();
  await gateway.start();
  const reopened = await started(gateway);
  reopened.view(conversationId);
  await until(() => reopened.timeline(conversationId).loaded);
  assert.equal(reopened.conversations.get(conversationId)!.source, "schedule");
  assert.deepEqual(reopened.conversations.get(conversationId)!.schedule_origin, origin);
  assert.deepEqual(reopened.timeline(conversationId).events.filter((event) => event.type === "schedule.triggered"),
    history.filter((event) => event.type === "schedule.triggered"));
});

test("上传 L3：真实 tus 分块、纯附件发送、SSE 与原始字节闭环", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const observer = await started(gateway);
  const api = session.api;
  const id = await session.createConversation("assistant", "上传原字节", globalThis.crypto.randomUUID());
  const bytes = Buffer.from([0, 255, 1, 13, 10, ...Buffer.from("中文附件_%\n未在提示词提供的正文")]);
  const name = "original_%_中文.bin";
  const offsets: number[] = [];
  let fileId: string | null = null;
  const completed = Promise.withResolvers<void>();
  const upload = new Upload(bytes, {
    endpoint: `${gateway.url}/uploads`, chunkSize: 7,
    headers: api.headers(), metadata: uploadMetadata(id, { name, mediaType: "application/octet-stream" }),
    retryDelays: null, storeFingerprintForResuming: false,
    onAfterResponse(req, response) {
      if (req.getMethod() === "PATCH") offsets.push(Number(response.getHeader("Upload-Offset")));
      fileId = response.getHeader("Upload-File-Id") ?? fileId;
    },
    onSuccess: () => completed.resolve(),
    onError: completed.reject,
  });
  upload.start();
  await completed.promise;
  assert.ok(fileId);
  assert.ok(offsets.length > 1);
  assert.equal(offsets.at(-1), bytes.length);
  assert.ok(offsets.every((offset, index) => offset === Math.min((index + 1) * 7, bytes.length)));
  const file = await api.getFile(fileId);
  assert.deepEqual([file.name, file.size, file.media_type, file.conversation_id, file.source, file.available],
    [name, bytes.length, "application/octet-stream", id, "user_upload", true]);
  assert.deepEqual(Buffer.from(await (await fetch(api.fileContentUrl(fileId), { headers: api.headers() })).arrayBuffer()), bytes);
  await session.send(id, "", [file]);
  await until(() => texts(observer, id, "message.agent").length === 1);
  const [message] = observer.timeline(id).events.filter((event) => event.type === "message.user");
  assert.equal(message.data.text, "");
  assert.equal(message.data.attachments.length, 1);
  assert.deepEqual([message.data.attachments[0].id, message.data.attachments[0].source], [fileId, "user_upload"]);
  assert.equal(session.pendingFor(id).length, 0);
  const replay = await api.sendMessage(id, message.client_id!, "", [fileId]);
  assert.equal(replay.replayed, true);
  assert.equal(replay.event.seq, message.seq);
  const persisted = (await api.history(id)).events.filter((event) => event.type === "message.user");
  assert.deepEqual(persisted, [message]);
  const downloaded = await fetch(observer.api.fileContentUrl(message.data.attachments[0].id), { headers: observer.api.headers() });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
});

test("富表单 L3：submitUi 经 SSE、重启恢复与单次持久化", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const observer = await started(gateway);
  const id = await session.createConversation("assistant", "提交恢复", globalThis.crypto.randomUUID());
  await session.send(id, "UI_FORM");
  await until(() => texts(session, id, "message.agent").length === 1);
  const source = session.timeline(id).events.find((event) => event.type === "message.agent")!;
  assert.deepEqual(source.data.ui, [{ block: 0, valid: true }]);
  const values = { plan: "B", note: "按期完成" };
  await session.submitUi(id, source.seq, 0, values, "ui-l3-submit");
  await until(() => observer.submissionsFor(id, source.seq).has(0) &&
    texts(observer, id, "message.agent").length === 2 && observer.conversations.get(id)?.status === "idle");
  const submitted = observer.timeline(id).events.find((event) => event.data.ui_submission)!;
  assert.deepEqual(submitted.data.ui_submission, { message_seq: source.seq, block: 0, values });
  assert.match(submitted.data.text, /方案乙/);
  assert.deepEqual(observer.submissionsFor(id, source.seq).get(0)!.values, values);
  assert.deepEqual(session.submissionsFor(id, source.seq), observer.submissionsFor(id, source.seq));
  const replay = await session.api.submitUi(id, "ui-l3-submit", source.seq, 0, { plan: "A", note: "不应覆盖" });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.event, submitted);
  await assert.rejects(observer.submitUi(id, source.seq, 0, { plan: "A", note: "不应再写" }, "ui-l3-other"),
    (error: unknown) => error instanceof GatewayError && error.status === 409 && error.code === "ui_already_submitted");
  assert.deepEqual(observer.submissionsFor(id, source.seq).get(0)!.values, values);
  await session.close();
  await observer.close();
  await gateway.kill();
  await gateway.start();
  const reopened = await started(gateway);
  reopened.view(id);
  await until(() => reopened.timeline(id).loaded);
  assert.deepEqual(reopened.submissionsFor(id, source.seq).get(0)!.values, values);
  assert.deepEqual(reopened.timeline(id).events.filter((event) => event.data.ui_submission), [submitted]);
  assert.deepEqual(reopened.timeline(id).events.find((event) => event.seq === source.seq), source);
  const restoredReplay = await reopened.api.submitUi(id, "ui-l3-submit", source.seq, 0, { plan: "A", note: "" });
  assert.equal(restoredReplay.replayed, true);
  assert.deepEqual(restoredReplay.event, submitted);
  const history = (await reopened.api.history(id)).events;
  assert.deepEqual(history.filter((event) => event.data.ui_submission), [submitted]);
  assert.equal(history.filter((event) => event.type === "message.agent").length, 2);
});

test("富动作 L3：spec 固定文本、跨设备单次发送、重启后 action 只读恢复", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const observer = await started(gateway);
  const id = await session.createConversation("assistant", "追问恢复", globalThis.crypto.randomUUID());
  await session.send(id, "UI_SEND");
  await until(() => texts(session, id, "message.agent").length === 1);
  const source = session.timeline(id).events.find(event => event.type === "message.agent")!;
  assert.deepEqual(source.data.ui, [{ block: 0, valid: true }]);
  session.saveUiDraft(id, source.seq, 0, { values: {}, flow: { status: 'unknown',
    attempt: { clientId: 'ui-send-l3', actionId: 'follow/1', values: {} } } });
  await session.recoverUiSubmissions();
  assert.equal(session.uiDraftFor(id, source.seq, 0)?.flow.status, 'failed');
  assert.deepEqual((await serverHistory(gateway, id)).filter(event => event.data.ui_submission), []);
  await session.submitUi(id, source.seq, 0, {}, "ui-send-l3", "follow/1");
  await until(() => observer.submissionsFor(id, source.seq).has(0) &&
    observer.conversations.get(id)?.status === "idle" && texts(observer, id, "message.agent").length === 2);
  const submitted = observer.timeline(id).events.find(event => event.data.ui_submission)!;
  assert.equal(submitted.data.text, "请继续展开上一条结论。");
  assert.equal(observer.submissionsFor(id, source.seq).get(0)?.actionId, "follow/1");
  assert.equal((await session.api.submitUi(id, "ui-send-l3", source.seq, 0, {}, "follow/1")).replayed, true);
  await assert.rejects(observer.submitUi(id, source.seq, 0, {}, "ui-send-other", "follow/0"),
    (error: unknown) => error instanceof GatewayError && error.code === "ui_already_submitted");
  assert.equal(observer.submissionsFor(id, source.seq).get(0)?.actionId, "follow/1");
  await session.close();
  await observer.close();
  await gateway.kill();
  await gateway.start();
  const reopened = await started(gateway);
  reopened.view(id);
  await until(() => reopened.timeline(id).loaded);
  assert.equal(reopened.submissionsFor(id, source.seq).get(0)?.actionId, "follow/1");
  assert.deepEqual((await reopened.api.uiSubmissionResult(id, source.seq, 0)).event, submitted);
  assert.deepEqual(reopened.timeline(id).events.filter(event => event.data.ui_submission), [submitted]);
});

test("browser.V1/V7/D9 L3：真实 v3 WebSocket 解析、视频状态输入与切页凭据", async () => {
  const gateway = new StubGateway(true);
  const previousSocket = globalThis.WebSocket;
  // ws implements RN's Authorization-header constructor; Node's built-in socket does not.
  globalThis.WebSocket = createRequire(import.meta.url)("ws");
  let stream: BrowserStream | undefined;
  try {
    await gateway.start();
    const connectedApi = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
    const hellos: Hello[] = [], pages: Pages[] = [], replies: Reply[] = [], videos: VideoMessage[] = [];
    const errors: string[] = [];
    stream = new BrowserStream(connectedApi, "video-contract", true, {
      state() {}, frame() { assert.fail("video stream must not emit JPEG"); },
      pages: value => pages.push(value), reply: value => replies.push(value),
      hello: value => hellos.push(value), video: value => videos.push(value),
      ended() {},
      error: value => errors.push(value),
    }, true);
    try {
      await until(() => videos.some(value => value.t === "video" && value.state === "ready") || errors.length > 0);
      assert.deepEqual(errors, []);
      assert.equal(hellos[0].protocol, 3);
      assert.equal(hellos[0].transport, "video");
      assert.equal("input_mode" in hellos[0], false);
      const initial = pages.at(-1)!;
      const id = stream.input({ t: "pointer", x: 20, y: 30, buttons: 0 }, initial);
      assert.notEqual(id, null);
      await until(() => replies.some(reply => reply.id === id));
      assert.equal(replies.find(reply => reply.id === id)?.t, "input_done");

      const pressed = stream.input({ t: "pointer", x: 20, y: 30, buttons: 1 }, initial);
      const released = stream.input({ t: "pointer", x: 20, y: 30, buttons: 0 }, initial);
      await until(() => replies.some(reply => reply.id === pressed) && replies.some(reply => reply.id === released));
      assert.equal(replies.find(reply => reply.id === released)?.t, "input_done");
      assert.equal(stream.input({ t: "text", text: "stale-video-view" }, { ...initial, vp: initial.vp - 1 }), null);
      const resumed = stream.input({ t: "text", text: "v3-video-contract" }, initial);
      assert.notEqual(resumed, null);
      await until(() => replies.some(reply => reply.id === resumed));
      assert.equal(replies.find(reply => reply.id === resumed)?.t, "input_done");
      assert.deepEqual(errors, []);
    } finally {
      stream.close();
      connectedApi.close();
    }
  } finally {
    stream?.close();
    await gateway.kill();
    globalThis.WebSocket = previousSocket;
  }
});
