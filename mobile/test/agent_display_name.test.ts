import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentList } from "../src/gateway/agents.ts";
import { GatewayApi, type AgentSummary } from "../src/gateway/api.ts";
import { agentDisplayName } from "../src/lib/agent-display-name.ts";

const id = "a_8f4e0034aa684ee0bb067dc29cfba782";
const agent: AgentSummary = { id, name: "当前名字", avatar: 0, description: "", workers: [],
  home: true, latest_conversation: null, unread: false };

test("名字优先级与占位：不把加载失败当删除，也不展示快照中的随机 ID", () => {
  const directory = { agents: [agent], loaded: true, error: null as string | null, deletedIds: new Set<string>() };
  assert.equal(agentDisplayName(directory, id, "旧名字"), "当前名字");
  directory.agents = [{ ...agent, name: "  " }];
  assert.equal(agentDisplayName(directory, id, "快照名字"), "快照名字");
  assert.equal(agentDisplayName(directory, id), "Agent");
  directory.agents = [{ ...agent, name: id }];
  assert.equal(agentDisplayName(directory, id, "快照名字"), "快照名字");
  assert.equal(agentDisplayName(directory, id, id), "Agent");
  directory.agents = [];
  assert.equal(agentDisplayName(directory, id), "已删除的 Agent");
  assert.equal(agentDisplayName(directory, id, "历史名字"), "历史名字");
  directory.error = "刷新失败";
  assert.equal(agentDisplayName(directory, id), "Agent");
  directory.deletedIds.add(id);
  assert.equal(agentDisplayName(directory, id, id), "已删除的 Agent");
  assert.equal(agentDisplayName(undefined, id), "Agent");
  assert.equal(agentDisplayName(undefined, id, id), "Agent");
  assert.equal(agentDisplayName(undefined, undefined), "Agent");
  assert.equal(agentDisplayName(undefined, "browser_agent", "browser_agent"), "browser_agent",
    "human-readable imported names are not generated identities");
});

test("真实目录请求失败、恢复、改名、删除后，历史名字仍可识别且缺失名字不会泄露 ID", { timeout: 3000 }, async () => {
  let response = () => new Response("unavailable", { status: 503 });
  const api = new GatewayApi({ baseUrl: "http://agent-name", token: "test" }, async () => response());
  let changed = () => {};
  const directory = new AgentList(api, () => changed(), { debounceMs: 0, retryDelays: [60_000] });
  const refresh = () => new Promise<void>(resolve => { changed = resolve; directory.refresh(); });
  try {
    assert.equal(agentDisplayName(directory, id), "Agent");
    await refresh();
    assert.ok(directory.error);
    assert.equal(agentDisplayName(directory, id), "Agent");
    assert.equal(agentDisplayName(directory, id, "历史名字"), "历史名字");
    response = () => Response.json({ agents: [agent], as_of_seq: 1 });
    await refresh();
    assert.equal(agentDisplayName(directory, id, "历史名字"), "当前名字");
    response = () => Response.json({ agents: [{ ...agent, name: "改名后" }], as_of_seq: 2 });
    await refresh();
    assert.equal(agentDisplayName(directory, id, "历史名字"), "改名后");
    directory.observe({ seq: 3, at: 3, type: "resource.changed", data: { kind: "agent", id, op: "deleted" } });
    assert.equal(agentDisplayName(directory, id, "历史名字"), "历史名字");
    assert.equal(agentDisplayName(directory, id), "已删除的 Agent");
  } finally {
    directory.close();
    api.close();
  }
});
