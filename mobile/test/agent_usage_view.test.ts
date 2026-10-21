import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentUsageReport } from "../src/gateway/api.ts";
import { agentUsageView } from "../src/lib/agent-usage-view.ts";

const alice = { id: "alice", name: "Alice", avatar: 1 };
const bob = { id: "bob", name: "Bob", avatar: 2 };
const aliceUsage = {
  agent_id: "alice", input_tokens: 120, cached_input_tokens: 10,
  output_tokens: 40, reasoning_output_tokens: 5, daily: [],
};
const report: AgentUsageReport = { days: 7, agents: [aliceUsage] };

test("用量面板跟随当前 Agent 列表删除最后一个 Agent，而非历史用量", () => {
  assert.equal(agentUsageView(false, [], report, false).kind, "loading-agents");
  const withAgent = agentUsageView(true, [alice], report, false);
  assert.equal(withAgent.kind, "rows");
  if (withAgent.kind !== "rows") return;
  assert.deepEqual(withAgent.rows, [{ item: aliceUsage, agent: alice }]);

  // SSE deletion updates the list while the already fetched weekly report still contains Alice.
  assert.equal(agentUsageView(true, [], report, false).kind, "no-agents");
  assert.equal(agentUsageView(true, [], null, true).kind, "no-agents");

  // A new Agent does not inherit the deleted Agent's usage row.
  assert.equal(agentUsageView(true, [bob], report, false).kind, "no-usage");
  const withBoth = agentUsageView(true, [bob, alice], report, false);
  assert.equal(withBoth.kind, "rows");
  if (withBoth.kind !== "rows") return;
  assert.deepEqual(withBoth.rows.map(({ agent }) => agent.id), ["alice"]);
});

test("有 Agent 时区分请求加载、失败和最近 7 天确实无用量；失败时保留已取回的用量", () => {
  assert.equal(agentUsageView(true, [alice], null, false).kind, "loading-usage");
  assert.equal(agentUsageView(true, [alice], null, true).kind, "usage-error");
  const retained = agentUsageView(true, [alice], report, true);
  assert.equal(retained.kind, "rows");
  if (retained.kind !== "rows") return;
  assert.deepEqual(retained.rows, [{ item: aliceUsage, agent: alice }]);
  assert.equal(agentUsageView(true, [alice], { days: 7, agents: [] }, false).kind, "no-usage");
  assert.equal(agentUsageView(false, [alice], report, true).kind, "loading-agents");
});
