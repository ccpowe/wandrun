import type { AgentMemory } from "../gateway/api.ts";
import { getLocale, t } from "./i18n.ts";

/** 服务端按 LF 计 Unicode 码点，不裁剪正文或做 Unicode 归一化。 */
export function normalizeMemory(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

export function memoryLength(content: string): number {
  return Array.from(normalizeMemory(content)).length;
}

/** 409 错误详情可能来自不可用/旧版网关；只信经结构校验的当前快照。 */
export function conflictMemory(details: unknown, id: string): AgentMemory | null {
  if (!details || typeof details !== "object" || !("current" in details)) return null;
  const current = details.current;
  if (!current || typeof current !== "object" ||
      !("agent_id" in current) || current.agent_id !== id ||
      !("content" in current) || typeof current.content !== "string" ||
      !("version" in current) || typeof current.version !== "string" ||
      !("limit" in current) || typeof current.limit !== "number" ||
      !("updated_at" in current) || (current.updated_at !== null && typeof current.updated_at !== "number") ||
      !("updated_by" in current) || (current.updated_by !== null &&
        current.updated_by !== "user" && current.updated_by !== "agent" && current.updated_by !== "external")) return null;
  return current as AgentMemory;
}

export type MemoryDraft = {
  base: AgentMemory;
  content: string;
  /** 后台更新或 409 的当前版本；不能替换正在编辑的内容/期望版本。 */
  remote: AgentMemory | null;
};

export function beginMemoryDraft(base: AgentMemory): MemoryDraft {
  return { base, content: base.content, remote: null };
}

export function observeMemory(state: MemoryDraft | null, incoming: AgentMemory): MemoryDraft {
  if (!state) return beginMemoryDraft(incoming);
  return { ...state, remote: incoming.version === state.base.version ? null : incoming };
}

/** 用户显式确认拿最新版本作为保存基线；始终保留草稿，哪怕最新正文不同。 */
export function reloadMemoryBase(state: MemoryDraft, incoming: AgentMemory): MemoryDraft {
  return { base: incoming, content: state.content, remote: null };
}

export function memoryAuthor(author: AgentMemory["updated_by"]): string {
  switch (author) {
    case "user": return t("你");
    case "agent": return "Agent";
    case "external": return t("外部");
    default: return t("未知来源");
  }
}

export function memoryModified(memory: AgentMemory): string {
  if (memory.updated_at === null) return t("尚未修改");
  return t("{date} · {author}修改", { date: new Date(memory.updated_at * 1000).toLocaleString(getLocale()), author: memoryAuthor(memory.updated_by) });
}
