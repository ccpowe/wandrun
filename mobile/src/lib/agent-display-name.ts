import type { AgentList } from "../gateway/agents.ts";
import { t } from "./i18n.ts";

type AgentDirectory = Pick<AgentList, "agents" | "loaded" | "error" | "deletedIds">;

/** Current names override historical snapshots. Missing/failed directories do not prove deletion.
 * Some gateway snapshots use the generated identity as a name fallback; never expose that as a label. */
export function agentDisplayName(directory: AgentDirectory | null | undefined, agentId: string | null | undefined,
  snapshotName?: string | null): string {
  const agent = directory?.agents.find((entry) => entry.id === agentId);
  for (const candidate of [agent?.name, snapshotName]) {
    const name = candidate?.trim();
    if (name && !/^a_[0-9a-f]{32}$/i.test(name)) return name;
  }
  if (agentId && (directory?.deletedIds.has(agentId) || (directory?.loaded && !directory.error && !agent))) {
    return t("已删除的 Agent");
  }
  return "Agent";
}
