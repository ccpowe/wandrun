import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentList } from "../src/gateway/agents.ts";
import type { AgentSummary } from "../src/gateway/api.ts";
import { profileMembers, profileStatus } from "../src/lib/agent-profile.ts";

function agent(id: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return { id, name: id, avatar: 1, description: "", workers: [], environment: "local", latest_conversation: null, unread: false, ...over }
}

test("成员按直接委派顺序取实时资料，不展开下属或反向关系", () => {
  const writer = agent("writer", { name: "写作者", avatar: 4, description: "写稿", workers: ["child"] });
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
  const idle = profileStatus("a", []);
  const active = profileStatus("a", [{ agent_id: "a", status: "working" }]);
  assert.notEqual(active, idle);
  assert.equal(profileStatus("a", [{ agent_id: "a", status: "idle" }, { agent_id: "a", status: "working" }]), active);
  assert.equal(profileStatus("a", [{ agent_id: "b", status: "working" }, { agent_id: "a", status: "failed" }]), idle);
});

test("列表快照已覆盖事件水位时，更新和删除事件仍使详情失效", async (t) => {
  let snapshot = { agents: [agent("planner"), agent("writer"), agent("editor")], as_of_seq: 1, order_revision: 1 }
  let list!: AgentList;
  let snapshotApplied: (() => void) | null = null;
  list = new AgentList({
    listAgents: async () => snapshot,
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
  snapshot = { agents: [agent("planner", { workers: ["editor"] }), agent("writer"), agent("editor")], as_of_seq: 2, order_revision: 1 };
  await refresh();
  const beforeUpdate = list.definitionVersion;
  list.observe({ seq: 2, at: 0, type: "resource.changed", data: { kind: "agent", id: "planner", op: "updated" } });
  assert.equal(list.definitionVersion, beforeUpdate + 1);
  snapshot = { agents: [agent("writer"), agent("editor")], as_of_seq: 3, order_revision: 1 };
  await refresh();
  const beforeDelete = list.definitionVersion;
  list.observe({ seq: 3, at: 0, type: "resource.changed", data: { kind: "agent", id: "planner", op: "deleted" } });
  assert.equal(list.definitionVersion, beforeDelete + 1);
});

test("Agent 资源变化立即使详情失效，聊天事件和其他资源不触发；换库也使详情失效", (t) => {
  const list = new AgentList({
    listAgents: async () => ({ agents: [], as_of_seq: 0, order_revision: 1 }),
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
