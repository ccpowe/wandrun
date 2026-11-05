// Agent directory: read generations, retry recovery, retained summaries and activity labels.

import assert from "node:assert/strict";
import { test } from "node:test";

import { affectsAgentList, AgentList } from "../src/gateway/agents.ts";
import { type AgentSummary, type GatewayEvent } from "../src/gateway/api.ts";
import { formatActivityTime } from "../src/lib/agent-list.ts";

function agent(id: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return { id, name: id, avatar: 1, description: "", workers: [], environment: "local", latest_conversation: null, unread: false, ...over }
}

function event(type: string, data: Record<string, any> = {}, conversation_id?: string): GatewayEvent {
  return { seq: 1, type, conversation_id, at: 0, data };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 有界等待条件成立；超时抛出（清理由 t.after 负责，超时不能代替清理）。 */
async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await sleep(5);
  }
}

test("目录、排序与对话摘要的事件触发重拉", () => {
  assert.equal(affectsAgentList(event("resource.changed", { kind: "agent" })), true);
  assert.equal(affectsAgentList(event("resource.changed", { kind: "agent_order" })), true);
  assert.equal(affectsAgentList(event("resource.changed", { kind: "skill" })), false);
  for (const type of ["conversation.created", "conversation.updated", "conversation.deleted", "conversation.status", "conversation.read", "message.user", "message.agent", "schedule.triggered"]) {
    assert.equal(affectsAgentList(event(type, {}, "c")), true, type);
  }
  // 浏览器请求不再是排序活动，不触发重拉；子对话里的用户插话推进根，成员 Agent 回复不影响。
  assert.equal(affectsAgentList(event("browser_task.updated", { state: "requested" }, "c")), false);
  assert.equal(affectsAgentList(event("message.user", { timeline_ids: ["t"] }, "c")), true);
  assert.equal(affectsAgentList(event("message.agent", { timeline_ids: ["t"] }, "c")), false);
  assert.equal(affectsAgentList(event("turn.failed", {}, "c")), false);
  assert.equal(affectsAgentList(event("turn.stopped", {}, "c")), false);
});


test("重命名与删除即时修正摘要；在途旧列表不能把已删除对话带回来", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = 0;
  const api = fakeApi([
    async () => {
      started++;
      await held;
      return [agent("a", { latest_conversation: {
        id: "c", title: "旧标题", last_text: "内容", last_activity_seq: 1, last_activity_at: 1, status: "idle",
      } })];
    },
    async () => {
      started++;
      return [agent("a", { latest_conversation: null })];
    },
  ]);
  const list = new AgentList(api, () => {}, { debounceMs: 5, retryDelays: [20] });
  t.after(() => { release(); list.close(); });
  list.agents = [agent("a", { latest_conversation: {
    id: "c", title: "旧标题", last_text: "内容", last_activity_seq: 1, last_activity_at: 1, status: "idle",
  } })];
  list.refresh();
  await waitFor(() => started === 1);
  list.conversationChanged(event("conversation.updated", { title: "新标题" }, "c"));
  assert.equal(list.agents[0].latest_conversation?.title, "新标题");
  list.conversationChanged(event("conversation.deleted", { id: "c", agent_id: "a" }));
  assert.equal(list.agents[0].latest_conversation, null);
  release();
  await waitFor(() => started === 2);
  assert.equal(list.agents[0].latest_conversation, null);
  await waitFor(() => api.calls === 2);
});

test("Agent created 续传使在途旧快照失效，补拉前不回滚列表", async (t) => {
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
  const newGate = new Promise<void>((resolve) => (releaseNew = resolve));
  let started = 0;
  const api = fakeApi([
    async () => {
      started++;
      await oldGate;
      return [agent("a")];
    },
    async () => {
      started++;
      await newGate;
      return [agent("a"), agent("new")];
    },
  ]);
  const list = new AgentList(api, () => {}, { debounceMs: 5 });
  t.after(() => { releaseOld(); releaseNew(); list.close(); });
  list.agents = [agent("a")];
  list.loaded = true;
  list.refresh();
  await waitFor(() => started === 1);
  list.observe({ ...event("resource.changed", { kind: "agent", id: "new", op: "created" }), seq: 2 });
  assert.equal(list.definitionVersion, 1);
  releaseOld();
  await waitFor(() => started === 2);
  assert.deepEqual(list.agents.map((a) => a.id), ["a"]);
  releaseNew();
  await waitFor(() => list.agents.some((a) => a.id === "new"));
  assert.equal(api.calls, 2);
});

test("Agent deleted 续传立即移除，并阻止在途旧快照带回已删除项", async (t) => {
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  const oldGate = new Promise<void>((resolve) => (releaseOld = resolve));
  const newGate = new Promise<void>((resolve) => (releaseNew = resolve));
  let started = 0;
  const api = fakeApi([
    async () => {
      started++;
      await oldGate;
      return [agent("a"), agent("b")];
    },
    async () => {
      started++;
      await newGate;
      return [agent("b")];
    },
  ]);
  const list = new AgentList(api, () => {}, { debounceMs: 5 });
  t.after(() => { releaseOld(); releaseNew(); list.close(); });
  list.agents = [agent("a"), agent("b")];
  list.loaded = true;
  list.refresh();
  await waitFor(() => started === 1);
  list.observe({ ...event("resource.changed", { kind: "agent", id: "a", op: "deleted" }), seq: 3 });
  assert.deepEqual(list.agents.map((a) => a.id), ["b"]);
  assert.equal(list.deletedIds.has("a"), true, "打开的页面可在补拉之前确认删除");
  assert.equal(list.deletedIds.has("b"), false);
  releaseOld();
  await waitFor(() => started === 2);
  assert.deepEqual(list.agents.map((a) => a.id), ["b"], "旧快照不能带回 a");
  releaseNew();
  await waitFor(() => api.calls === 2 && list.loaded);
  assert.deepEqual(list.agents.map((a) => a.id), ["b"]);
});

test("较新 Agent 列表快照不被迟到的旧标题事件回滚", async (t) => {
  const current = agent("a", { latest_conversation: {
    id: "c", title: "新标题", last_text: "消息", last_activity_seq: 50, last_activity_at: 50, status: "idle",
  } });
  const api = {
    listAgents: async () => ({ agents: [current], as_of_seq: 50, order_revision: 1 }),
  };
  const list = new AgentList(api, () => {}, { debounceMs: 5 });
  t.after(() => list.close());
  list.refresh();
  await waitFor(() => list.loaded);
  list.conversationChanged({ ...event("conversation.updated", { title: "旧标题" }, "c"), seq: 49 });
  assert.equal(list.agents[0].latest_conversation?.title, "新标题");
});

test("先到的列表快照覆盖 created / updated / deleted，迟到资源事件仍通知详情而不回滚列表", async (t) => {
  const cases = [
    { op: "created", id: "b", before: [agent("a")], after: [agent("a"), agent("b")] },
    { op: "updated", id: "a", before: [agent("a")], after: [agent("a", { workers: ["b"] })] },
    { op: "deleted", id: "a", before: [agent("a")], after: [] },
  ];
  for (const { op, id, before, after } of cases) {
    await t.test(op, async (t) => {
      let snapshot = { agents: before, as_of_seq: 1, order_revision: 1 }
      let calls = 0;
      const api = {
        listAgents: async () => { calls++; return snapshot; },
      };
      const list = new AgentList(api, () => {}, { debounceMs: 0 });
      t.after(() => list.close());
      list.refresh();
      await waitFor(() => list.loaded);
      snapshot = { agents: after, as_of_seq: 2, order_revision: 1 };
      list.refresh();
      await waitFor(() => calls === 2 && list.agents === after);
      assert.equal(list.deletedIds.has(id), op === "deleted", "重连快照可确认消失，但新增或编辑不算删除");

      const previousVersion = list.definitionVersion;
      const changed = { ...event("resource.changed", { kind: "agent", id, op }), seq: 2 };
      list.observe(changed);
      assert.equal(list.definitionVersion, previousVersion + 1, "详情请求必须重新执行");
      assert.deepEqual(list.agents, after, "已到的列表快照不应回滚");
      list.observe(changed);
      assert.equal(list.definitionVersion, previousVersion + 1, "重复事件不重复失效详情");
    });
  }
});

test("乱序 Agent 事件按各自资源去重，不让旧删除回滚同一 Agent，也不漏另一个 Agent 的详情失效", async (t) => {
  const list = new AgentList({
    listAgents: async () => ({ agents: [agent("a"), agent("b")], as_of_seq: 1, order_revision: 1 }),
  }, () => {}, { debounceMs: 0 });
  t.after(() => list.close());
  list.refresh();
  await waitFor(() => list.loaded);
  list.observe({ ...event("resource.changed", { kind: "agent", id: "b", op: "updated" }), seq: 4 });
  list.observe({ ...event("resource.changed", { kind: "agent", id: "a", op: "deleted" }), seq: 3 });
  assert.deepEqual(list.agents.map((a) => a.id), ["b"]);
  assert.equal(list.definitionVersion, 2, "较旧的另一资源事件仍使详情失效");
  list.observe({ ...event("resource.changed", { kind: "agent", id: "b", op: "deleted" }), seq: 2 });
  list.observe({ ...event("resource.changed", { kind: "agent", id: "a", op: "deleted" }), seq: 3 });
  assert.deepEqual(list.agents.map((a) => a.id), ["b"], "同一资源的旧删除不能撤销较新更新");
  assert.equal(list.definitionVersion, 2);
});

function fakeApi(responses: (() => Promise<AgentSummary[]>)[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    listAgents: async () => ({ agents: await responses[Math.min(calls++, responses.length - 1)](), as_of_seq: 0, order_revision: 1 }),
  };
}

test("短时间内的多次触发合并成一次请求", async (t) => {
  const api = fakeApi([async () => [agent("a")]]);
  const list = new AgentList(api, () => {}, { debounceMs: 10, retryDelays: [20] });
  t.after(() => list.close()); // 断言失败时也要清掉计时器，否则进程不退出
  list.observe(event("message.user", {}, "c"));
  list.observe(event("message.agent", {}, "c"));
  list.refresh();
  await sleep(60);
  assert.equal(api.calls, 1);
  assert.equal(list.loaded, true);
  assert.deepEqual(list.agents.map((a) => a.id), ["a"]);
});

test("请求进行中又有触发：结束后再拉一次，最终是最新结果", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const api = fakeApi([
    async () => {
      await gate;
      return [agent("old")];
    },
    async () => [agent("new")],
  ]);
  const list = new AgentList(api, () => {}, { debounceMs: 5, retryDelays: [20] });
  t.after(() => list.close()); // 断言失败时也要清掉计时器，否则进程不退出
  list.refresh();
  await sleep(30); // 第一次请求已发出并卡住
  list.observe(event("message.agent", {}, "c"));
  release();
  await sleep(60);
  assert.equal(api.calls, 2);
  assert.deepEqual(list.agents.map((a) => a.id), ["new"]);
});

test("拉取失败保留旧列表并记录原因，之后自动退避重试直到恢复", async (t) => {
  let fail = false;
  const api = fakeApi([
    async () => {
      if (fail) throw new Error("down");
      return [agent("a")];
    },
  ]);
  const list = new AgentList(api, () => {}, { debounceMs: 5, retryDelays: [20] });
  t.after(() => list.close()); // 断言失败时也要清掉计时器，否则进程不退出
  list.refresh();
  await sleep(40);
  fail = true;
  list.refresh();
  await sleep(40);
  assert.deepEqual(list.agents.map((a) => a.id), ["a"]);
  assert.match(list.error ?? "", /down/);
  const callsWhileDown = api.calls;
  await sleep(100);
  assert.ok(api.calls > callsWhileDown, "失败后自动重试");
  fail = false;
  await sleep(80);
  assert.equal(list.error, null);
});

test("首次加载失败：loaded 保持 false 并持续重试，一次性故障后恢复", async (t) => {
  let attempts = 0;
  const api = fakeApi([
    async () => {
      if (attempts++ < 2) throw new Error("503");
      return [agent("a")];
    },
  ]);
  const list = new AgentList(api, () => {}, { debounceMs: 5, retryDelays: [10] });
  t.after(() => list.close()); // 断言失败时也要清掉计时器，否则进程不退出
  list.refresh();
  await sleep(20);
  assert.equal(list.loaded, false);
  assert.match(list.error ?? "", /503/);
  await sleep(150);
  assert.equal(list.loaded, true);
  assert.equal(list.error, null);
});

test("重连 / 聚焦刷新不等退避，立即重拉", async (t) => {
  let fail = true;
  const api = fakeApi([
    async () => {
      if (fail) throw new Error("x");
      return [agent("a")];
    },
  ]);
  const list = new AgentList(api, () => {}, { debounceMs: 5, retryDelays: [10_000] });
  t.after(() => list.close()); // 断言失败时也要清掉计时器，否则进程不退出
  list.refresh();
  await sleep(30);
  assert.equal(list.loaded, false);
  fail = false;
  list.refresh();
  await sleep(40);
  assert.equal(list.loaded, true);
});

test("关闭后不再请求、不再通知，也不写入在途的列表和命令响应", async (t) => {
  let release!: (agents: AgentSummary[]) => void;
  const pending = new Promise<AgentSummary[]>((resolve) => (release = resolve));
  let notified = 0;
  const api = fakeApi([() => pending]);
  const list = new AgentList(api, () => notified++, { debounceMs: 5, retryDelays: [10] });
  t.after(() => list.close()); // 断言失败时也要清掉计时器，否则进程不退出
  list.agents = [agent("a")];
  list.refresh();
  await sleep(20); // 列表请求在途
  list.close();
  release([agent("zzz")]);
  await sleep(40);
  assert.deepEqual(list.agents, []);
  assert.equal(list.loaded, false);
  assert.equal(notified, 0);
  assert.equal(api.calls, 1);
});


test("时间格式：刚刚 / 分钟前 / 今天时刻 / 昨天 / 周X / 日期", () => {
  const now = new Date(2026, 9, 9, 15, 30); // 2026-10-09 周五
  const at = (...parts: [number, number, number, number?, number?]) => new Date(...parts).getTime() / 1000;
  assert.equal(formatActivityTime(now.getTime() / 1000 - 20, now), "刚刚");
  assert.equal(formatActivityTime(now.getTime() / 1000 + 300, now), "刚刚");
  assert.equal(formatActivityTime(now.getTime() / 1000 - 120, now), "2 分钟前");
  assert.equal(formatActivityTime(at(2026, 9, 9, 9, 5), now), "09:05");
  assert.equal(formatActivityTime(at(2026, 9, 8, 23, 59), now), "昨天");
  assert.equal(formatActivityTime(at(2026, 9, 5, 10), now), "周一");
  assert.equal(formatActivityTime(at(2026, 8, 20, 10), now), "9月20日");
  assert.equal(formatActivityTime(at(2025, 11, 31, 10), now), "2025/12/31");
});

