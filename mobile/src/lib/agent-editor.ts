import { GatewayError, type AgentDeleteConflictDetails, type AgentDetail, type AgentEditableFields, type AgentSummary, type ModelSettings } from "../gateway/api.ts";
import { t } from "./i18n.ts";

export type AgentDraft = AgentEditableFields & { mcp_servers: string[]; searchable_mcp_servers: string[] };
export type CreateCommand = { clientId: string; fields: Omit<AgentDraft, "model"> & { model?: string } };

/** Once a create request could have reached the gateway, retries must replay both its id and exact payload. */
export function prepareCreateCommand(draft: AgentDraft, clientId: string, pending: CreateCommand | null): CreateCommand {
  if (pending) return pending;
  const { model, ...fields } = draft;
  return { clientId, fields: { ...fields, ...(model ? { model } : {}), skills: [...draft.skills], workers: [...draft.workers],
    mcp_servers: [...draft.mcp_servers], searchable_mcp_servers: [...draft.searchable_mcp_servers] } };
}

/** A later refusal cannot disprove a prior create whose result remains unknown. */
export function createResultUnknown(error: unknown, previouslyUnknown = false): boolean {
  return previouslyUnknown || !(error instanceof GatewayError) || error.retryable;
}

export function blankAgentDraft(settings: ModelSettings, agents: Pick<AgentSummary, "avatar">[]): AgentDraft {
  return {
    name: "", avatar: leastUsedAvatar(agents), description: "", system_prompt: "",
    model: settings.default_model ?? "", reasoning_effort: settings.default_reasoning_effort,
    code_mode: true, skills: [], workers: [], mcp_servers: [], searchable_mcp_servers: [],
  };
}

/** Mirror the gateway's display-name boundary, counting Unicode characters rather than UTF-16 units. */
export function validateAgentName(name: string): string | null {
  if (!name.trim()) return t("请填写 Agent 名字");
  if (name !== name.trim()) return t("名字不能包含首尾空白");
  if (Array.from(name).length > 64 || /[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u.test(name)) return t("名字必须是单行且不超过 64 个字符");
  return null;
}

/** Only mobile-editable fields participate in PATCH; arrays compare by sequence (their order is significant). */
export function draftFromAgent(agent: AgentDetail): AgentDraft {
  return {
    name: agent.name, avatar: agent.avatar, description: agent.description,
    system_prompt: agent.system_prompt, model: agent.model, reasoning_effort: agent.reasoning_effort,
    code_mode: agent.code_mode, skills: [...agent.skills], workers: [...agent.workers],
    mcp_servers: [...agent.mcp_servers], searchable_mcp_servers: [...agent.searchable_mcp_servers],
  };
}

export function changedAgentFields(before: AgentDraft, after: AgentDraft): Partial<AgentEditableFields> {
  const patch: Partial<AgentEditableFields> = {};
  for (const key of ["name", "avatar", "description", "system_prompt", "model", "reasoning_effort", "code_mode"] as const) {
    if (before[key] !== after[key]) (patch as Record<string, unknown>)[key] = after[key];
  }
  for (const key of ["skills", "workers", "mcp_servers", "searchable_mcp_servers"] as const) {
    if (before[key].length !== after[key].length || before[key].some((item, index) => item !== after[key][index])) patch[key] = after[key];
  }
  return patch;
}

/** Preselect the least-used of the eight bundled avatars; ties choose the smallest number. */
export function leastUsedAvatar(agents: Pick<AgentSummary, "avatar">[]): number {
  const counts = Array<number>(8).fill(0);
  for (const agent of agents) {
    if (Number.isInteger(agent.avatar) && agent.avatar >= 0 && agent.avatar < 8) counts[agent.avatar]++;
  }
  return counts.indexOf(Math.min(...counts));
}


export function toggleSelection(items: readonly string[], item: string): string[] {
  return items.includes(item) ? items.filter((value) => value !== item) : [...items, item];
}

/** Present each gateway deletion constraint as its own reason in the blocked sheet. */
export type DeletionReason = { kind: "members" | "work" | "other"; title: string; description: string };

export function deletionReasons(details: Partial<AgentDeleteConflictDetails>): DeletionReason[] {
  const reasons: DeletionReason[] = [];
  const members = details.member_of ?? [];
  if (members.length) reasons.push({
    kind: "members", title: t("它是 {count} 个团队的成员", { count: members.length }),
    description: t("{names}。先在它们的“团队成员”里移除它。", { names: members.map((member) => member.name).join("、") }),
  });
  if ((details.running_conversations ?? 0) > 0) reasons.push({
    kind: "work", title: t("它正在工作"),
    description: t("有 {count} 个对话还在运行{tasks}。等它结束或先停止。", { count: details.running_conversations!, tasks: (details.running_tasks ?? 0) > 0 ? t("（{count} 个任务）", { count: details.running_tasks! }) : "" }),
  });
  else if ((details.running_tasks ?? 0) > 0) reasons.push({
    kind: "work", title: t("它正在工作"), description: t("有 {count} 个任务还在运行。等它结束或先停止。", { count: details.running_tasks! }),
  });
  return reasons;
}

export function deletionConflictDetails(value: unknown): Partial<AgentDeleteConflictDetails> {
  if (!value || typeof value !== "object") return {};
  const details = value as Record<string, unknown>;
  const member_of = Array.isArray(details.member_of)
    ? details.member_of.filter((member): member is { id: string; name: string } => !!member && typeof member === "object" && typeof member.name === "string" && typeof member.id === "string")
    : [];
  return {
    member_of,
    running_conversations: typeof details.running_conversations === "number" ? details.running_conversations : 0,
    running_tasks: typeof details.running_tasks === "number" ? details.running_tasks : 0,
  };
}
