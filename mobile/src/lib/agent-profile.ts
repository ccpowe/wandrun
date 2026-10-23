import { GatewayError, type AgentDetail, type AgentSummary, type Conversation } from "../gateway/api.ts";
import { t } from "./i18n.ts";

export type ProfileTab = "computer" | "schedules" | "members" | "memory";
export const DEFAULT_PROFILE_TAB: ProfileTab = "members";

export type ProfileState =
  | { status: "available"; detail: AgentDetail | null; error: Error | null }
  | { status: "not-found"; detail: null; error: GatewayError };

/** 404 撤销缓存；临时失败保留缓存和原始错误。已确认不存在时，网络失败不能恢复旧资料。 */
export function profileLoadFailed(state: ProfileState, reason: unknown): ProfileState {
  if (reason instanceof GatewayError && reason.status === 404) {
    return { status: "not-found", detail: null, error: reason };
  }
  if (state.status === "not-found") return state;
  return { ...state, error: reason instanceof Error ? reason : new Error(String(reason)) };
}

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
