import type { AgentSummary, AgentUsage, AgentUsageReport } from "../gateway/api.ts";

type DisplayAgent = Pick<AgentSummary, "id" | "name" | "avatar">;

type AgentUsageView =
  | { kind: "loading-agents" | "no-agents" | "loading-usage" | "usage-error" | "no-usage" }
  | { kind: "rows"; rows: { item: AgentUsage; agent: DisplayAgent }[] };

/** Resolve the usage panel against the current Agent list, never the historical report alone. */
export function agentUsageView(
  loaded: boolean,
  agents: readonly DisplayAgent[],
  report: AgentUsageReport | null,
  failed: boolean,
): AgentUsageView {
  if (!loaded) return { kind: "loading-agents" };
  if (!agents.length) return { kind: "no-agents" };
  if (!report) return { kind: failed ? "usage-error" : "loading-usage" };

  const agentsById = new Map<string, DisplayAgent>();
  for (const agent of agents) agentsById.set(agent.id, agent);
  const rows: { item: AgentUsage; agent: DisplayAgent }[] = [];
  for (const item of report.agents) {
    const agent = agentsById.get(item.agent_id);
    if (agent) rows.push({ item, agent });
  }
  return rows.length ? { kind: "rows", rows } : { kind: "no-usage" };
}
