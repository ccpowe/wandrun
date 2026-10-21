import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentList } from "../src/gateway/agents.ts";
import { GatewayError, type AgentDetail, type AgentSummary } from "../src/gateway/api.ts";
import { profileLoadFailed, profileMembers, profileStatus, type ProfileState } from "../src/lib/agent-profile.ts";

function agent(id: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return { id, name: id, avatar: 1, description: "", workers: [], home: true, latest_conversation: null, unread: false, ...over };
}

const detail: AgentDetail = {
  ...agent("planner", { workers: ["writer"] }),
  system_prompt: "", model: "test", reasoning_effort: null,
  mcp_servers: [], searchable_mcp_servers: [], skills: [],
  code_mode: false, environment: "local", member_of: [],
};

test("首次详情 404 进入不存在终态，保留网关状态", () => {
  const error = new GatewayError(404, "not_found", "Agent 不存在");
  const state = profileLoadFailed({ status: "available", detail: null, error: null }, error);
  assert.equal(state.status, "not-found");
  assert.equal(state.detail, null);
  assert.equal(state.error, error);
});

test("成功后刷新 404 撤销旧详情，之后网络失败不恢复缓存", () => {
  const loaded: ProfileState = { status: "available", detail, error: null };
  const error = new GatewayError(404, "not_found", "Agent 不存在");
  const state = profileLoadFailed(loaded, error);
  assert.equal(state.status, "not-found");
  assert.equal(state.detail, null);
  assert.equal(state.error, error);
  assert.equal(profileLoadFailed(state, new GatewayError(0, "network", "离线")), state);
});

test("网络失败保留已加载资料和成员，保留错误供重试提示", () => {
  const loaded: ProfileState = { status: "available", detail, error: null };
  for (const error of [new GatewayError(0, "network", "离线"), new TypeError("Failed to fetch")]) {
    const state = profileLoadFailed(loaded, error);
    assert.equal(state.status, "available");
    assert.equal(state.detail, detail);
    assert.equal(state.error, error);
    const writer = agent("writer");
    assert.deepEqual(profileMembers(state.detail!, [writer]), { members: [writer], missing: [] });
  }
});

test("成员按直接委派顺序取实时资料，包含隐藏成员而不展开下属或反向关系", () => {
  const writer = agent("writer", { name: "写作者", avatar: 4, description: "写稿", home: false, workers: ["child"] });
  const search = agent("search", { name: "资料搜索", description: "核实来源" });
  const rows = profileMembers({ workers: ["writer", "search"] }, [search, agent("child"), writer, agent("parent", { workers: ["planner"] })]);
  assert.deepEqual(rows, { members: [writer, search], missing: [] });
  assert.deepEqual(profileMembers({ workers: [] }, [writer, search]), { members: [], missing: [] });
});

test("缺失成员不能被解释为没有委派关系，列表补齐后恢复该行", () => {
  const detail = { workers: ["writer"] };
  assert.deepEqual(profileMembers(detail, []), { members: [], missing: ["writer"] });
  const writer = agent("writer", { name: "更新后的名字", avatar: 6 });
  assert.deepEqual(profileMembers(detail, [writer]), { members: [writer], missing: [] });
});

test("资料状态只聚合该 Agent 的直接对话，不误用其他 Agent 或最近已停止对话", () => {
  assert.equal(profileStatus("a", [{ agent_id: "a", status: "idle" }, { agent_id: "a", status: "working" }]), "对话进行中");
  assert.equal(profileStatus("a", [{ agent_id: "b", status: "working" }, { agent_id: "a", status: "failed" }]), "暂无进行中的对话");
});

test("列表快照先到、资料仍旧时，迟到的更新和删除事件让成员与不存在状态收敛", async (t) => {
  let snapshot = { agents: [agent("planner"), agent("writer"), agent("editor")], as_of_seq: 1 };
  let serverDetail: AgentDetail | null = detail;
  const getAgent = async (): Promise<AgentDetail> => {
    if (serverDetail === null) throw new GatewayError(404, "not_found", "Agent 不存在");
    return serverDetail;
  };
  let list!: AgentList;
  let snapshotApplied: (() => void) | null = null;
  list = new AgentList({
    listAgents: async () => snapshot,
    hideAgent: async (id) => agent(id), unhideAgent: async (id) => agent(id),
  }, () => {
    if (list.agents === snapshot.agents) {
      snapshotApplied?.();
      snapshotApplied = null;
    }
  }, { debounceMs: 0 });
  t.after(() => list.close());
  const refresh = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    snapshotApplied = resolve;
    list.refresh();
    return promise;
  };
  await refresh();
  let shown: ProfileState = { status: "available", detail: await getAgent(), error: null };
  assert.deepEqual(profileMembers(shown.detail!, list.agents).members.map((a) => a.id), ["writer"]);

  serverDetail = { ...detail, workers: ["editor"] };
  snapshot = { agents: [agent("planner", { workers: ["editor"] }), agent("writer"), agent("editor")], as_of_seq: 2 };
  await refresh();
  assert.deepEqual(profileMembers(shown.detail!, list.agents).members.map((a) => a.id), ["writer"], "列表不能代替旧资料");
  const beforeUpdate = list.definitionVersion;
  list.observe({ seq: 2, at: 0, type: "resource.changed", data: { kind: "agent", id: "planner", op: "updated" } });
  assert.equal(list.definitionVersion, beforeUpdate + 1);
  shown = { status: "available", detail: await getAgent(), error: null };
  assert.deepEqual(profileMembers(shown.detail!, list.agents).members.map((a) => a.id), ["editor"]);

  serverDetail = null;
  snapshot = { agents: [agent("writer"), agent("editor")], as_of_seq: 3 };
  await refresh();
  const beforeDelete = list.definitionVersion;
  list.observe({ seq: 3, at: 0, type: "resource.changed", data: { kind: "agent", id: "planner", op: "deleted" } });
  assert.equal(list.definitionVersion, beforeDelete + 1);
  shown = await getAgent().then(
    () => assert.fail("删除后详情应返回 404"),
    (error: unknown) => {
      assert.ok(error instanceof GatewayError && error.status === 404);
      return profileLoadFailed(shown, error);
    },
  );
  assert.equal(shown.status, "not-found");
  assert.equal(shown.detail, null);
});

test("Agent 资源变化立即使详情失效，聊天事件和其他资源不触发；换库也使详情失效", (t) => {
  const list = new AgentList({
    listAgents: async () => ({ agents: [], as_of_seq: 0 }),
    hideAgent: async (id) => agent(id), unhideAgent: async (id) => agent(id),
  }, () => {});
  t.after(() => list.close());
  const initial = list.definitionVersion;
  list.observe({ seq: 1, at: 0, type: "message.agent", conversation_id: "c", data: {} });
  list.observe({ seq: 2, at: 0, type: "resource.changed", data: { kind: "skill" } });
  assert.equal(list.definitionVersion, initial);
  list.observe({ seq: 3, at: 0, type: "resource.changed", data: { kind: "agent", id: "planner", op: "updated" } });
  assert.equal(list.definitionVersion, initial + 1);
  list.invalidate();
  assert.equal(list.definitionVersion, initial + 2);
  list.observe({ seq: 3, at: 0, type: "resource.changed", data: { kind: "agent", id: "planner", op: "updated" } });
  assert.equal(list.definitionVersion, initial + 3, "换库后复用的 seq 属于新事件");
  list.close();
  const closedVersion = list.definitionVersion;
  list.observe({ seq: 4, at: 0, type: "resource.changed", data: { kind: "agent", id: "planner", op: "updated" } });
  assert.equal(list.definitionVersion, closedVersion);
});
