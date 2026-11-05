import type { AgentDetail, AgentSummary, Conversation, Schedule } from "../gateway/api.ts";
import type { EditorOperation } from "../gateway/editor-operation.ts";
import { t } from "./i18n.ts";

export type ProfileTab = "computer" | "schedules" | "members" | "memory";
export const DEFAULT_PROFILE_TAB: ProfileTab = "computer";

/** 只按详情的直接委派顺序取列表资料，不递归、不受首页隐藏状态影响。缺失项单独报告，不能伪装成无成员。 */
export function profileMembers(detail: Pick<AgentDetail, "workers">, agents: readonly AgentSummary[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const members: AgentSummary[] = [];
  const missing: string[] = [];
  for (const id of detail.workers) {
    const agent = byId.get(id);
    if (agent) members.push(agent);
    else missing.push(id);
  }
  return { members, missing };
}

/** 网关没有全局 Agent 执行状态：只描述其作为入口的直接对话，不推断被委派工作的状态。 */
export function profileStatus(id: string, conversations: Iterable<Pick<Conversation, "agent_id" | "status">>): string {
  for (const conversation of conversations) {
    if (conversation.agent_id === id && conversation.status === "working") return t("对话中");
  }
  return t("无进行中对话");
}

export type AgentProfileState =
  /** A toggle failure is the page visit's one-time result (useVisitNotice), not reducer state. */
  | { status: "viewing"; tab: ProfileTab }
  | { status: "updating-schedule" | "awaiting-schedules"; tab: ProfileTab; operationId: string; scheduleId: string };
export type AgentProfileEvent =
  | { type: "tab"; tab: ProfileTab }
  | { type: "toggle-started"; operationId: string; scheduleId: string }
  | { type: "toggle-succeeded"; operationId: string }
  | { type: "toggle-failed"; operationId: string }
  | { type: "toggle-adopted" | "toggle-superseded"; operationId: string };

export function agentProfileReducer(state: AgentProfileState, event: AgentProfileEvent): AgentProfileState {
  switch (state.status) {
    case "viewing":
      if (event.type === "tab") return { ...state, tab: event.tab };
      if (event.type === "toggle-started") return { status: "updating-schedule", tab: state.tab, operationId: event.operationId, scheduleId: event.scheduleId };
      return state;
    case "updating-schedule":
      if (event.type === "tab") return { ...state, tab: event.tab };
      if (event.type === "toggle-succeeded" && event.operationId === state.operationId) return { ...state, status: "awaiting-schedules" };
      if (event.type === "toggle-failed" && event.operationId === state.operationId) return { status: "viewing", tab: state.tab };
      return state;
    case "awaiting-schedules":
      if (event.type === "tab") return { ...state, tab: event.tab };
      if ((event.type === "toggle-adopted" || event.type === "toggle-superseded") && event.operationId === state.operationId) return { status: "viewing", tab: state.tab };
      return state;
  }
}

export type AgentProfileExternal = {
  id: string; detail?: AgentDetail; detailFailed: boolean; gone: boolean;
  agents: AgentSummary[]; listLoaded: boolean; listFailed: boolean; offline: boolean;
  schedules?: Schedule[]; scheduleFailed: boolean; schedulePaused: boolean;
  scheduleReceiptRevision: number; scheduleReadRevision: number | undefined;
  memoryFailed: boolean; browserFailed: boolean; operations: (EditorOperation | undefined)[];
};
export type AgentProfileSelection = {
  tab: ProfileTab; agent: AgentSummary | AgentDetail | undefined; gone: boolean; canEdit: boolean;
  members: AgentSummary[]; membersLoading: boolean; membersEmpty: boolean; missingMembers: boolean;
  schedules: Schedule[]; schedulesLoading: boolean; schedulesEmpty: boolean;
  scheduleLocked: boolean; scheduleUnknown: boolean;
  feedback: string | null;
  adoption: Extract<AgentProfileEvent, { type: "toggle-adopted" | "toggle-superseded" }> | null;
};

/** External read/operation facts are projected, never mirrored into the page reducer. */
export function selectAgentProfile(state: AgentProfileState, external: AgentProfileExternal): AgentProfileSelection {
  const { detail, id, agents } = external;
  const facts = external;
  const { members, missing } = detail ? profileMembers(detail, agents) : { members: [], missing: [] };
  const membersFailed = state.tab === "members" && (facts.listFailed || facts.listLoaded && missing.length > 0);
  const unknown = facts.operations.some(operation => operation?.status === "unknown");
  const pending = facts.operations.some(operation => operation?.status === "pending");
  const currentRead = facts.scheduleReadRevision !== undefined && facts.scheduleReadRevision >= facts.scheduleReceiptRevision;
  let adoption: AgentProfileSelection["adoption"] = null;
  if (state.status === "awaiting-schedules") {
    const owner = facts.operations.find(operation => operation?.resource === "schedule" && operation.id === state.scheduleId);
    if (owner?.operationId !== state.operationId) adoption = { type: "toggle-superseded", operationId: state.operationId };
    else if ((owner.status === "confirmed" || owner.status === "synced") && currentRead) adoption = { type: "toggle-adopted", operationId: state.operationId };
  }
  const feedback = facts.detailFailed ? "无法加载资料，正在重试…" : membersFailed ? "无法加载成员，正在重试…"
    : state.tab === "computer" && facts.browserFailed ? "无法加载浏览器页面，正在重试…"
    : state.tab === "memory" && facts.memoryFailed ? "无法加载记忆，正在重试…"
    : state.tab === "schedules" && facts.scheduleFailed ? "无法加载定时，正在重试…" : null;
  return {
    tab: state.tab, agent: agents.find(agent => agent.id === id) ?? detail,
    gone: facts.gone, canEdit: !facts.gone && !facts.offline && !!detail,
    members, membersLoading: !detail || !facts.listLoaded,
    membersEmpty: !!detail && facts.listLoaded && detail.workers.length === 0 && !facts.listFailed,
    missingMembers: membersFailed,
    schedules: facts.schedules ?? [], schedulesLoading: facts.schedules === undefined && !facts.scheduleFailed,
    schedulesEmpty: facts.schedules?.length === 0 && !facts.scheduleFailed && !facts.schedulePaused,
    scheduleLocked: facts.gone || facts.offline || unknown || pending || !currentRead && facts.scheduleReceiptRevision > 0 || state.status !== "viewing",
    scheduleUnknown: unknown, feedback, adoption,
  };
}
