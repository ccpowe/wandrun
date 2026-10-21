// App 端协议层对真实网关（桩执行）的验证：node --test test/
// 每个用例自己起一个网关进程，可以随意杀掉、重启或换库。

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

import { exchangePairingCode, GatewayApi, GatewayError, type GatewayEvent } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { SseParser } from "../src/gateway/sse.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";
import { nextConversationAfterDeletion } from "../src/lib/conversation-management.ts";
import { selectableSkills, skillMarkdown } from "../src/lib/skills.ts";

const root = path.resolve(import.meta.dirname, "..");
const directory = mkdtempSync(path.join(tmpdir(), "wandrun-mobile-"));
let nextPort = 18900 + Math.floor(Math.random() * 500);
const running = new Set<ChildProcess>();

const sessions = new Set<ChatSession>();

// 失败的用例也要关掉连接（否则重连循环让进程一直不退出）并杀掉网关。
afterEach(async () => {
  await Promise.all([...sessions].map((session) => session.close()));
  sessions.clear();
  for (const child of running) child.kill("SIGKILL");
});

after(() => {
  for (const child of running) child.kill("SIGKILL");
  rmSync(directory, { recursive: true, force: true });
});

class StubGateway {
  readonly port = nextPort++;
  readonly url = `http://127.0.0.1:${this.port}`;
  database = path.join(directory, `gateway-${this.port}.sqlite`);
  private child: ChildProcess | null = null;

  async start(database = this.database): Promise<void> {
    this.database = database;
    // 直接用项目虚拟环境的 Python：经 uv run 启动时 SIGKILL 只杀到 uv，网关进程会留下来占着端口。
    const child = spawn(path.join(root, "../.venv/bin/python"), ["test/stub_gateway.py", database, String(this.port)], {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    });
    this.child = child;
    running.add(child);
    child.on("exit", () => running.delete(child));
    const api = new GatewayApi({ baseUrl: this.url, token: "dev" });
    await until(() => api.listConversations().then(() => true, () => false), 30_000);
  }

  /** 模拟崩溃：不给网关收尾的机会。 */
  async kill(): Promise<void> {
    const child = this.child!;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
  }
}

async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function started(gateway: StubGateway, token = "dev"): Promise<ChatSession> {
  const session = new ChatSession({ baseUrl: gateway.url, token }, undefined, { retryDelays: [100, 200] });
  sessions.add(session);
  await session.start();
  await until(() => session.connection === "open");
  return session;
}

function texts(session: ChatSession, id: string, type: string): string[] {
  return session.timeline(id).events.filter((e) => e.type === type).map((e) => e.data.text);
}

async function serverHistory(gateway: StubGateway, id: string): Promise<GatewayEvent[]> {
  const { events } = await new GatewayApi({ baseUrl: gateway.url, token: "dev" }).history(id, undefined, 200);
  return events;
}

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

test("删除当前对话选同一 Agent 最新剩余项；其它 Agent 与被删项不可被选中", () => {
  const rows = [
    { id: "other", agent_id: "helper", updated_at: 900 },
    { id: "current", agent_id: "assistant", updated_at: 800 },
    { id: "old", agent_id: "assistant", updated_at: 10 },
    { id: "recent", agent_id: "assistant", updated_at: 20 },
  ];
  assert.equal(nextConversationAfterDeletion(rows, "assistant", "current"), "recent");
  assert.equal(nextConversationAfterDeletion(rows, "helper", "other"), null);
  assert.equal(nextConversationAfterDeletion(rows.slice(0, 2), "assistant", "current"), null);
});

test("Agent 列表与详情；对话带入口 Agent，可按它过滤；不存在的 Agent 被拒绝", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const { agents, as_of_seq } = await api.listAgents();
  assert.equal(typeof as_of_seq, "number");
  assert.deepEqual(agents.map((a) => [a.id, a.name, a.workers]), [["assistant", "assistant", ["helper"]], ["helper", "helper", []]]);
  const helper = await api.getAgent("helper");
  assert.deepEqual(helper.member_of, ["assistant"]);
  assert.equal(helper.model, "offline");
  await assert.rejects(api.getAgent("nobody"), (error: any) => error instanceof GatewayError && error.status === 404);
  const mine = await api.createConversation("assistant", "甲");
  const other = await api.createConversation("helper");
  assert.equal(mine.agent_id, "assistant");
  assert.deepEqual((await api.listConversations("helper")).conversations.map((c) => c.id), [other.id]);
  assert.equal((await api.listConversations()).conversations.length, 2);
  await assert.rejects(api.createConversation("nobody"), (error: any) => error.status === 404 && error.code === "not_found");
  await gateway.kill();
});

test("搜索按名称与消息正文匹配、按入口 Agent 限定，LIKE 通配符必须是字面字符；删除来源后退出结果", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const mine = await api.createConversation("assistant", "独有标题_%");
  const other = await api.createConversation("helper", "对照标题");
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
  await gateway.kill();
});

test("真实登记原文件：消息附件、认证 Range、修改后新字节与删对话保留独立搜索；原文件消失则不可用", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const conversation = await api.createConversation("assistant");
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
  await gateway.kill();
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
  await api.createConversation("assistant");
  const listed = await api.listSkills();
  assert.deepEqual(listed.skills.map(({ name, description, status, used_by }) => ({ name, description, status, used_by })), [
    { name: "research-tool", description: "交叉核对资料来源", status: "ok", used_by: [] },
  ]);
  assert.equal(listed.default_agent_id, "assistant");
  assert.equal(listed.as_of_seq, (await api.listAgents()).as_of_seq);
  await gateway.kill();
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
    ["memory", "tool_search", "files", "processes", "browser", "code_mode", "schedule", "image_generation", "ui_blocks"]);
  assert.deepEqual(before.find((item) => item.id === "files")?.tools,
    ["ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep"]);
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
  const fields = { name: "新朋友", description: "研究问题", system_prompt: "回答时给依据", model: "offline" };
  const created = await api.createAgent("new-agent-command", fields);
  const id = created.agent.id;
  assert.equal(created.replayed, false);
  assert.equal(created.agent.name, fields.name);
  assert.equal(created.agent.reasoning_effort, null);
  assert.deepEqual(created.agent.skills, []);
  assert.deepEqual(created.agent.workers, []);
  assert.deepEqual(created.event.data, { kind: "agent", id, op: "created" });
  const replayed = await api.createAgent("new-agent-command", fields);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.agent.id, id);
  assert.equal(replayed.event.seq, created.event.seq);
  await until(() => phone.agents.agents.some((item) => item.id === id));

  const changed = await api.updateAgent(id, { name: "改名后", avatar: 3, workers: ["helper"], reasoning_effort: "medium" });
  assert.equal(changed.agent.id, id);
  assert.equal(changed.agent.name, "改名后");
  assert.equal(changed.agent.avatar, 3);
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
  const conversation = await api.createConversation(id, "待删的会话");
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

test("连接器密钥只写、补丁、按需状态、Agent 引用、删除冲突与资源事件", async () => {
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
  assert.equal(created.connector.status, "disconnected");
  assert.equal(created.connector.tool_count, 0);
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

  const statusCursor = (await api.listConnectors()).as_of_seq;
  const agent = await api.createAgent("connector-agent", {
    name: "检索者", description: "按需查询", system_prompt: "根据资料回答", model: "offline",
    mcp_servers: [id],
  });
  assert.deepEqual(agent.agent.mcp_servers, [id]);
  assert.deepEqual((await api.getConnector(id)).used_by, [{ id: agent.agent.id, name: "检索者" }]);
  await assert.rejects(api.deleteConnector(id), (error: unknown) =>
    error instanceof GatewayError && error.status === 409 &&
    typeof error.details === "object" && error.details !== null &&
    "used_by" in error.details && Array.isArray(error.details.used_by) &&
    error.details.used_by.some((user: { id: string }) => user.id === agent.agent.id));

  const tested = await api.testConnector(id);
  assert.deepEqual(tested, { success: true, tool_count: 1, error: null, pending_restart: false });
  assert.equal((await api.getConnector(id)).status, "connected");
  assert.equal((await api.getConnector(id)).tool_count, 1);
  const statusSeq = await api.consumeResponse(`/events?after=${statusCursor}`, {
    headers: api.headers(), signal: AbortSignal.timeout(5000),
  }, async (response) => {
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const parser = new SseParser();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
        if (message.event !== "resource.changed") continue;
        const event: unknown = JSON.parse(message.data);
        if (event === null || typeof event !== "object" || !("data" in event)) continue;
        const data = event.data;
        if (data === null || typeof data !== "object" || !("kind" in data) || !("id" in data) || !("op" in data)) continue;
        if (data.kind === "connector" && data.id === id && data.op === "status" && "seq" in event && typeof event.seq === "number") {
          return event.seq;
        }
      }
    }
  });
  // Agent 准备时已打开连接；测试探测同一连接，健康未变时不发布状态变化。
  assert.ok(statusSeq > statusCursor && statusSeq < agent.event.seq);
  assert.equal((await api.listConnectors()).as_of_seq, agent.event.seq);
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
  assert.deepEqual((await api.getConnector(id)).used_by, [{ id: agent.agent.id, name: "检索者" }]);
  await assert.rejects(api.updateAgent(agent.agent.id, {
    mcp_servers: [id], searchable_mcp_servers: [id],
  }), (error: unknown) => error instanceof GatewayError && error.status === 400);
  await assert.rejects(api.updateAgent(agent.agent.id, {
    searchable_mcp_servers: ["missing"],
  }), (error: unknown) => error instanceof GatewayError && error.status === 400);

  const failed = await api.createConnector("connector-fail", {
    name: "失联", description: "连接失败", url: "https://mcp.example/fail",
    headers: { Authorization: "Bearer forbidden-secret" },
  });
  const result = await api.testConnector(failed.connector.id);
  assert.equal(result.success, false);
  assert.equal(result.tool_count, 0);
  assert.equal(typeof result.error, "string");
  assert.equal(JSON.stringify(result).includes("forbidden-secret"), false);
  const failure = await api.getConnector(failed.connector.id);
  assert.equal(failure.status, "failed");
  assert.equal(JSON.stringify(failure).includes("forbidden-secret"), false);
  assert.equal((await api.listConnectors()).as_of_seq > failed.event.seq, true);

  const local = await api.createConnector("connector-local", {
    name: "本地进程", command: "fixture-mcp", args: ["--serve"],
    env: { ACCESS_TOKEN: "local-secret", REGION: "east" },
  });
  assert.deepEqual(local.connector.env, { ACCESS_TOKEN: true, REGION: true });
  assert.deepEqual((await api.getConnector(local.connector.id)).env, { ACCESS_TOKEN: true, REGION: true });
  assert.deepEqual((await api.updateConnector(local.connector.id, {
    env: { ACCESS_TOKEN: null },
  })).connector.env, { REGION: true });
  assert.equal(JSON.stringify((await api.listConnectors()).connectors).includes("local-secret"), false);

  const removed = await api.updateAgent(agent.agent.id, { searchable_mcp_servers: [] });
  assert.deepEqual(removed.agent.searchable_mcp_servers, []);
  const afterRemoval = (await api.listConnectors()).as_of_seq;
  const sameRemoval = await api.updateAgent(agent.agent.id, { searchable_mcp_servers: [] });
  assert.equal(sameRemoval.event, null);
  assert.equal((await api.listConnectors()).as_of_seq, afterRemoval);
  assert.deepEqual((await api.getConnector(id)).used_by, []);
  const deleted = await api.deleteConnector(id);
  assert.deepEqual(deleted.event.data, { kind: "connector", id, op: "deleted" });
  assert.equal((await api.listConnectors()).connectors.some((connector) => connector.id === id), false);
  await assert.rejects(api.getConnector(id), (error: unknown) =>
    error instanceof GatewayError && error.status === 404);
  await gateway.kill();
});

test("双设备改名、删除当前对话：标题即时同步，删除续传不进时间线且资源幂等", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const phone = await started(gateway);
  const tablet = await started(gateway);
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const automaticallyTitled = await phone.createConversation("helper");
  await phone.send(automaticallyTitled, "  第一行\n第二行  ");
  await until(() => phone.conversations.get(automaticallyTitled)?.title === "第一行 第二行");
  await until(() => tablet.conversations.get(automaticallyTitled)?.title === "第一行 第二行");
  const remaining = await phone.createConversation("assistant", "留下的对话");
  const current = await phone.createConversation("assistant");
  await until(() => tablet.conversations.has(current));
  const leave = tablet.view(current);
  assert.equal(await phone.renameConversation(current, "手动标题"), true);
  await until(() => tablet.conversations.get(current)?.title === "手动标题");
  await until(() => phone.agents.agents.find((a) => a.id === "assistant")?.latest_conversation?.title === "手动标题");
  const before = (await serverHistory(gateway, current)).filter((e) => e.type === "conversation.updated").length;
  assert.equal((await api.renameConversation(current, "手动标题")).event, null);
  assert.equal((await serverHistory(gateway, current)).filter((e) => e.type === "conversation.updated").length, before);
  const previous = [...tablet.conversations.values()];
  assert.equal(await phone.deleteConversation(current), true);
  await until(() => !tablet.conversations.has(current));
  assert.equal(nextConversationAfterDeletion(previous, "assistant", current), remaining);
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
  await gateway.kill();
});

test("首页字段与移出：幂等；离线期间的回到首页重连后按游标补到并让 Agent 列表收敛，且不进任何时间线", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  // 可以让事件流连不上的 fetch：模拟 App 断网，命令仍由另一个客户端发出。
  let offline = false;
  const flaky: typeof fetch = (input, init) =>
    offline && String(input).includes("/events") ? Promise.reject(new TypeError("offline")) : fetch(input, init);
  const session = new ChatSession({ baseUrl: gateway.url, token: "dev" }, flaky, { retryDelays: [50, 100] });
  sessions.add(session);
  await session.start();
  await until(() => session.connection === "open");
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });

  const before = (await api.listAgents()).agents;
  assert.ok(before.every((a) => a.home && a.latest_conversation === null && a.unread === false));
  const id = await session.createConversation("helper", "甲");
  // 刚新建、还没发消息的对话：摘要指向它，但没有活动时间和文字。
  const created = (await api.listAgents()).agents.find((a) => a.id === "helper")!;
  assert.deepEqual(created.latest_conversation, {
    id, title: "甲", last_text: null, last_activity_seq: null, last_activity_at: null, status: "idle",
  });
  assert.equal((await api.hideAgent("helper")).home, false);
  assert.equal((await api.hideAgent("helper")).home, false); // 幂等

  // 会话自己的列表已反映移出（由事件触发的重拉，条件满足即继续，不靠固定等待）。
  await until(() => session.agents.agents.find((a) => a.id === "helper")?.home === false);

  // 断网：事件流连不上，期间回到首页一次（会话看不到这条持久事件）。
  const cursor = session.lastSeq;
  offline = true;
  session.reconnectNow();
  await until(() => session.connection === "reconnecting");
  assert.equal((await api.unhideAgent("helper")).home, true);
  const { as_of_seq } = await api.listAgents();
  assert.ok(as_of_seq > cursor);
  assert.equal(session.lastSeq, cursor); // 事件流被拒绝，游标没有前进
  assert.equal(session.agents.agents.find((a) => a.id === "helper")!.home, false); // 会话的副本仍是断网前的

  offline = false; // 恢复：按游标补发，补到的资源事件让 Agent 列表收敛到网关状态
  session.reconnectNow();
  await until(() => session.lastSeq === as_of_seq);
  await until(() => session.agents.agents.find((a) => a.id === "helper")?.home === true);

  // 资源事件不属于任何对话：所有时间线里都没有，也没有以 undefined 为键的时间线。
  const timelines = (session as any).timelines as Map<string | undefined, { events: { type: string }[] }>;
  assert.deepEqual([...timelines.keys()], [id]);
  assert.ok([...timelines.values()].every((t) => t.events.every((e) => e.type !== "resource.changed")));
  assert.equal((await api.listAgents()).agents.find((a) => a.id === "helper")!.home, true);
  await assert.rejects(api.hideAgent("nobody"), (error: any) => error instanceof GatewayError && error.status === 404);
  await session.close();
  await gateway.kill();
});

test("详情接口只含定义字段和 member_of，不含首页派生字段", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const detail = await api.getAgent("helper");
  assert.deepEqual(Object.keys(detail).sort(), [
    "avatar", "code_mode", "compaction_keep_tokens", "compaction_model", "context_window",
    "description", "environment", "id", "mcp_servers", "member_of", "model", "name",
    "reasoning_effort", "searchable_mcp_servers", "skills", "system_prompt", "workers",
  ]);
  for (const derived of ["home", "latest_conversation", "unread"]) assert.equal(derived in detail, false);
  const [item] = (await api.listAgents()).agents;
  assert.deepEqual(Object.keys(item).sort(), [
    "avatar", "description", "home", "id", "latest_conversation", "name", "unread", "workers",
  ]);
  await gateway.kill();
});

test("发消息：先本地显示，经事件流收到工作中、回复、空闲；同一 client_id 重试只执行一次", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const id = await session.createConversation("assistant", "测试");
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
  await gateway.kill();
});

test("反复断线重连：时间线与网关历史一致，不漏不重", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const id = await session.createConversation("assistant");
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
  await gateway.kill();
});

test("根与成员压缩系统行经 SSE 和历史恢复，摘要完整且失败原因可见", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const id = await session.createConversation("assistant", "压缩");
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
  assert.deepEqual(buildItems(session.timeline(id).events, []).filter((item) => item.event?.type.startsWith("context."))
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

test("网关崩溃重启：同一个库，按 Last-Event-ID 续传", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const id = await session.createConversation("assistant");
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
  await until(() => texts(session, id, "message.agent").length === 2);
  assert.deepEqual(texts(session, id, "message.user"), ["重启前", "网关不在时发的"]);
  assert.deepEqual(session.timeline(id).events.map((e) => e.seq), (await serverHistory(gateway, id)).map((e) => e.seq));
  await session.close();
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
  const id = await session.createConversation("assistant", "旧库里的对话");
  for (let index = 0; index < 3; index++) await session.send(id, `x${index}`);
  await until(() => texts(session, id, "message.agent").length === 3);
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
  const fresh = await session.createConversation("assistant", "新库");
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
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const id = await session.createConversation("assistant");
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
  await gateway.kill();
});

test("历史分页：新打开的会话一页页往前翻，与网关全部历史一致", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const writer = await started(gateway);
  const id = await writer.createConversation("assistant");
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
  await gateway.kill();
});

test("历史先于 SSE：补录不挡住当前字段推进，列表失败仍选择新活动且时间线不重复", async (t) => {
  const gateway = new StubGateway();
  await gateway.start();
  const config = { baseUrl: gateway.url, token: "dev" };
  const api = new GatewayApi(config);
  const a = await api.createConversation("helper", "A");
  await api.sendMessage(a.id, "old-a", "旧消息");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === a.id && c.status === "idle" && c.last_text === "收到：旧消息"));
  const b = await api.createConversation("helper", "B");
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
  await api.sendMessage(b.id, "new-b", "新消息");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === b.id && c.status === "idle" && c.last_text === "收到：新消息"));
  await api.sendMessage(b.id, "working-b", "慢慢做");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === b.id && c.status === "working"));
  await session.loadOlder(b.id);
  const history = [...session.timeline(b.id).events];
  const reply = history.find((event) => event.type === "message.agent")!;
  assert.equal(reply.data.text, "收到：新消息");
  const lastMessage = history.findLast((event) => event.type === "message.user")!;
  assert.equal(session.conversations.get(b.id)!.last_text, null); // 历史只补时间线
  assert.equal(session.conversations.get(b.id)!.status, "idle"); // 历史也不能推进状态
  const blank = await session.blankConversation("helper");
  assert.notEqual(blank, b.id, "历史已经证明 B 非空，SSE 放行前也不能复用");
  assert.notEqual(blank, a.id);
  assert.equal(session.conversations.get(blank)!.last_text, null);
  release();
  await until(() => session.lastSeq >= history.at(-1)!.seq && session.agents.error !== null);
  const current = session.conversations.get(b.id)!;
  assert.equal(current.last_text, lastMessage.data.text);
  assert.equal(current.lastTextSeq, lastMessage.seq);
  assert.equal(current.lastActivityAt, lastMessage.at);
  assert.equal(current.lastAgentSeq, reply.seq);
  assert.equal(current.unread, true);
  assert.equal(current.status, "working");
  assert.deepEqual(session.timeline(b.id).events, history);
  assert.equal(await session.conversationFor(stale), b.id);
  assert.equal(session.connection, "open");
});

test("当前字段水位独立：快照前的重放不回滚，乱序命令响应不挡住状态和未读", () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  sessions.add(session);
  session.agents.close();
  session["reset"]([{
    id: "c", agent_id: "helper", title: "C", created_at: 1, updated_at: 20,
    status: "idle", read_seq: 20, unread: false, last_text: "快照消息",
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
  assert.equal(current.lastActivityAt, 30);
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
  session["reset"]([{
    id: "c", agent_id: "helper", title: "快照标题", created_at: 1, updated_at: 20,
    status: "idle", read_seq: 0, unread: false, last_text: null,
    source: "user", schedule_origin: null,
  }], 20);
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
    status: "idle" as const, read_seq: 0, unread: false, last_text: null,
    source: "user" as const, schedule_origin: null,
  });
  session["reset"]([row("gone"), row("survivor")], 5);
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
    status: "idle" as const, read_seq: 0, unread: false, last_text: null,
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
    status: "idle" as const, read_seq: 0, unread: false, last_text: null,
    source: "user" as const, schedule_origin: null,
  });
  session["reset"]([row("old")], 40);
  const stale = {
    id: "helper",
    latest_conversation: { id: "old", title: "旧库", last_text: null, last_activity_seq: null, last_activity_at: null, status: "idle" as const },
  };
  session.agents.agents = [{
    id: "helper", name: "helper", avatar: 1, description: "", workers: [],
    home: true, latest_conversation: null, unread: false,
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
  session["reset"]([{
    id: "c", agent_id: "helper", title: "保留", created_at: 1, updated_at: 1,
    status: "idle", read_seq: 0, unread: false, last_text: null,
    source: "user", schedule_origin: null,
  }], 1);
  assert.equal(await session.renameConversation("c", "失败"), false);
  assert.equal(session.conversations.get("c")?.title, "保留");
  assert.equal(await session.deleteConversation("c"), false);
  assert.equal(session.conversations.has("c"), true);
  assert.equal(session.notice, "连不上网关");
});

test("未读：另一台设备看过之后，红点经 conversation.read 同步消失", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const phone = await started(gateway);
  const tablet = await started(gateway);
  const id = await phone.createConversation("assistant");
  await phone.send(id, "在吗");
  await until(() => phone.conversations.get(id)?.unread === true && tablet.conversations.get(id)?.unread === true);
  tablet.view(id);
  await until(() => phone.conversations.get(id)!.unread === false);
  await phone.close();
  await tablet.close();
  await gateway.kill();
});

test("令牌错误：报告错误，不反复重试", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = new ChatSession({ baseUrl: gateway.url, token: "wrong" });
  sessions.add(session);
  await session.start();
  assert.equal(session.connection, "error");
  assert.equal(session.notice, "令牌不对");
  await session.close();
  await gateway.kill();
});

test("进入 Agent 聊天：创建后立即复用，重复点击和列表未刷新时都不会建出第二个空对话", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const session = await started(gateway);
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  // 列表里该 Agent 还没有对话（latest_conversation 为 null），即使列表一直没刷新也要复用刚建的。
  const stale = { id: "helper", latest_conversation: null };
  const [first, second] = await Promise.all([session.conversationFor(stale), session.conversationFor(stale)]);
  assert.equal(first, second);
  assert.equal(await session.conversationFor(stale), first);
  assert.equal((await api.listConversations("helper")).conversations.length, 1);
  // “新对话”：已有空对话就直接用，不堆空对话
  assert.equal(await session.blankConversation("helper"), first);
  // 发过消息后“新对话”才新建，且新建同样共用一次请求
  await session.send(first, "你好");
  await until(() => session.conversations.get(first)?.last_text === "你好");
  const [a, b] = await Promise.all([session.blankConversation("helper"), session.blankConversation("helper")]);
  assert.notEqual(a, first);
  assert.equal(a, b);
  assert.equal((await api.listConversations("helper")).conversations.length, 2);
  assert.deepEqual(session.conversationsOf("helper").map((c) => c.id).sort(), [first, a].sort());
  await session.close();
  await gateway.kill();
});

test("非空摘要过期：列表阻塞或失败时仍进入最新产品活动的对话，空对话不抢占", async (t) => {
  const gateway = new StubGateway();
  await gateway.start();
  const config = { baseUrl: gateway.url, token: "dev" };
  const api = new GatewayApi(config);
  const a = await api.createConversation("helper", "A");
  await api.sendMessage(a.id, "old-a", "旧消息");
  await until(async () => (await api.listConversations("helper")).conversations.some((c) => c.id === a.id && c.status === "idle" && c.last_text === "收到：旧消息"));
  const b = await api.createConversation("helper", "B");
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
  await session.createConversation("helper", "空对话");
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
      activity: null, lastTextSeq: seq, lastActivityAt: activityAt, lastAgentSeq: 0,
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
  const empty = {
    id: "helper",
    latest_conversation: { id: "blank", title: "空", status: "idle" as const, last_text: null, last_activity_seq: null, last_activity_at: null },
  };
  assert.equal(await session.conversationFor(empty), "b");
  session.conversations.delete("a");
  session.conversations.delete("b");
  assert.equal(await session.conversationFor(empty), "blank");
  assert.equal(await session.conversationFor({ id: "helper", latest_conversation: null }), "blank");
  assert.equal(await session.blankConversation("helper"), "blank");
  session.conversations.delete("blank");
  assert.equal(await session.conversationFor({ id: "helper", latest_conversation: null }), "older-blank");
});

for (const type of ["message.user", "message.agent"]) {
  test(`空对话选择排除只有历史 ${type} 的候选，但不排除只有状态事件的候选`, async () => {
    const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
    sessions.add(session);
    session["reset"](["empty", "nonempty"].map((id, index) => ({
      id, agent_id: "helper", title: id, created_at: index, updated_at: index,
      status: "idle" as const, read_seq: 0, unread: false, last_text: null,
      source: "user" as const, schedule_origin: null,
    })), 0);
    session["insert"]({ seq: 1, type: "conversation.status", conversation_id: "empty", at: 1, data: { status: "idle" } });
    session["insert"]({ seq: 2, type, conversation_id: "nonempty", at: 2, data: { text: "历史消息" } });
    assert.equal(await session.blankConversation("helper"), "empty");
    assert.equal(session.conversations.get("nonempty")!.last_text, null);
  });
}

test("“新对话”不把有待发送 / 发送失败消息的对话当成空对话", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  // 消息发送可以被卡住（进行中）或拒绝（失败）；其余请求照常。
  let messages: "pass" | "hold" | "fail" = "hold";
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => (releaseHeld = resolve));
  const controlled: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/messages") && init?.method === "POST") {
      if (messages === "fail") throw new TypeError("offline");
      if (messages === "hold") await held;
    }
    return fetch(input, init);
  };
  const session = new ChatSession({ baseUrl: gateway.url, token: "dev" }, controlled, { retryDelays: [100, 200] });
  sessions.add(session);
  await session.start();
  await until(() => session.connection === "open");

  const first = await session.conversationFor({ id: "helper", latest_conversation: null });
  assert.equal(await session.blankConversation("helper"), first); // 真正的空对话可复用

  const sending = session.send(first, "你好"); // 进行中：网关还没有这条消息
  assert.equal(session.pendingFor(first)[0].status, "sending");
  const second = await session.blankConversation("helper");
  assert.notEqual(second, first);

  releaseHeld();
  await sending;
  messages = "fail";
  await session.send(second, "再见"); // 失败：留在本地，网关仍没有消息
  assert.equal(session.pendingFor(second)[0].status, "failed");
  assert.equal(session.conversations.get(second)!.last_text, null);
  const third = await session.blankConversation("helper");
  assert.notEqual(third, second);
  assert.notEqual(third, first);
  await session.close();
  await gateway.kill();
});

test("Agent 记忆 API 的版本冲突、长度、删除与资源事件；成员更新归根对话", async () => {
  const gateway = new StubGateway();
  await gateway.start();
  const api = new GatewayApi({ baseUrl: gateway.url, token: "dev" });
  const session = await started(gateway);
  const empty = await api.getAgentMemory("helper");
  assert.equal(empty.content, "");
  assert.equal(empty.updated_at, null);
  assert.equal(empty.updated_by, null);
  assert.equal(empty.limit, 1000);

  const saved = await api.updateAgentMemory("helper", "# 成员\r\n😀", empty.version);
  assert.equal(saved.content, "# 成员\n😀");
  assert.equal(saved.updated_by, "user");
  await until(() => session.memoryRevisionFor("helper") > 0);
  assert.equal(session.memoryRevisionFor("assistant"), 0);
  const revision = session.memoryRevisionFor("helper");
  await api.updateAgentMemory("helper", "# 成员\n😀", saved.version);
  assert.equal(session.memoryRevisionFor("helper"), revision);
  await assert.rejects(api.updateAgentMemory("helper", "x".repeat(1001), saved.version),
    (error: unknown) => error instanceof GatewayError && error.status === 400);
  assert.equal((await api.getAgentMemory("helper")).content, saved.content);
  await assert.rejects(api.updateAgentMemory("helper", "竞争写入", empty.version),
    (error: unknown) => {
      if (!(error instanceof GatewayError) || error.status !== 409 ||
          !error.details || typeof error.details !== "object" || !("current" in error.details)) return false;
      const current = error.details.current;
      return !!current && typeof current === "object" && "version" in current && current.version === saved.version;
    });

  const root = await api.createConversation("assistant");
  await api.sendMessage(root.id, "memory-e2e", "MEMORY_UPDATE_MEMBER:helper:# 委派成员自己的记忆");
  await until(() => session.timeline(root.id).events.some((event) => event.type === "memory.updated"));
  const event = session.timeline(root.id).events.find((entry) => entry.type === "memory.updated")!;
  assert.equal(event.conversation_id, root.id);
  assert.deepEqual([event.data.agent_id, event.data.summary], ["helper", "已记住"]);
  assert.equal(buildItems(session.timeline(root.id).events, []).some((item) => item.event?.seq === event.seq), true);
  assert.equal((await api.getAgentMemory("helper")).updated_by, "agent");
  assert.equal((await api.listConversations("helper")).conversations.length, 0);
  await until(() => session.memoryRevisionFor("helper") > revision);
  const revisionAfterAgent = session.memoryRevisionFor("helper");
  writeFileSync(path.join(gateway.database + ".memory", "helper.md"), "# 外部文件改动");
  const external = await api.getAgentMemory("helper");
  assert.equal(external.content, "# 外部文件改动");
  assert.equal(external.updated_by, "external");
  assert.equal(session.memoryRevisionFor("helper"), revisionAfterAgent, "外部文件修改没有伪造资源事件");


  await api.updateAgent("assistant", { workers: [] });
  await api.deleteAgent("helper");
  await assert.rejects(api.getAgentMemory("helper"), (error: unknown) =>
    error instanceof GatewayError && error.status === 404);
  await assert.rejects(api.updateAgentMemory("helper", "复活", saved.version), (error: unknown) =>
    error instanceof GatewayError && error.status === 404);
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
  const firstConversation = await firstApi.createConversation("assistant", "same title");
  const secondConversation = await secondApi.createConversation("assistant", "same title");
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
  const firstMemory = await firstApi.getAgentMemory("assistant");
  await firstApi.updateAgentMemory("assistant", "first computer", firstMemory.version);
  assert.equal((await firstApi.getAgentMemory("assistant")).content, "first computer");
  assert.equal((await secondApi.getAgentMemory("assistant")).content, "");
  await firstApi.revokeCurrent();
  await assert.rejects(firstApi.listConversations(), (error: unknown) => error instanceof GatewayError && error.status === 401);
  assert.equal((await secondApi.getFile(secondFile.id)).available, true);
  assert.equal((await secondApi.listConversations()).conversations[0].id, secondConversation.id);
  assert.equal((await secondApi.getAgentMemory("assistant")).content, "");
  firstApi.close();
  secondApi.close();
});
