import { GatewayError, type AgentMemory, type MemoryScope } from "../gateway/api.ts";
import { getLanguage, getLocale, t } from "./i18n.ts";

/** The host normalizes LF and counts index Unicode code points without truncation. */
export function normalizeMemory(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

export function memoryLength(content: string): number {
  const normalized = normalizeMemory(content);
  let count = 0;
  for (let i = 0; i < normalized.length; i++, count++) {
    const unit = normalized.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < normalized.length &&
      normalized.charCodeAt(i + 1) >= 0xdc00 && normalized.charCodeAt(i + 1) <= 0xdfff) i++;
  }
  return count;
}

export function detailBytes(content: string): number {
  const normalized = normalizeMemory(content);
  let bytes = 0;
  for (let i = 0; i < normalized.length; i++) {
    const unit = normalized.charCodeAt(i);
    if (unit <= 0x7f) bytes++;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < normalized.length &&
      normalized.charCodeAt(i + 1) >= 0xdc00 && normalized.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Known gateway reasons are translated; unknown input errors use the safe local fallback. */
export function memoryError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason);
  const translated = t(raw);
  return reason instanceof GatewayError && reason.status === 400 && getLanguage() === "en" && translated === raw
    ? t("提交内容有误，请检查后重试") : translated;
}

/** Only active, scope-matching references may become internal navigation. */
export function managedMemorySlug(url: string, memory: AgentMemory): string | null {
  const match = /^\/.wandrun\/memory\/(profile|work)\/details\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/([a-f0-9]{64})\.md$/.exec(url);
  if (!match || match[1] !== memory.scope) return null;
  const ref = memory.details[match[2]];
  return ref?.path === url && ref.sha256 === match[3] ? match[2] : null;
}

export function newDetailIndex(content: string, scope: MemoryScope, slug: string): string {
  const link = `- [${slug}](/.wandrun/memory/${scope}/details/${slug}.md)`;
  return content ? `${content}${content.endsWith("\n") ? "" : "\n"}${link}\n` : `${link}\n`;
}

/** Suggest removal of simple inline links; the deletion screen reviews the entire index
 * because titled, reference-style and other host-accepted Markdown needs user editing. */
export function withoutDetailLink(content: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(`\\[([^\\]]+)\\]\\(${escaped}\\)`, "g");
  return content.split("\n").flatMap((line) => {
    if (new RegExp(`^\\s*(?:[-*+]\\s+)?\\[[^\\]]+\\]\\(${escaped}\\)\\s*$`).test(line)) return [];
    return [line.replace(link, "$1")];
  }).join("\n");
}

/** Ignore malformed or differently scoped 409 payloads; they must not replace a draft baseline. */
export function conflictMemory(details: unknown, scope: MemoryScope, id?: string): AgentMemory | null {
  if (!details || typeof details !== "object" || !("current" in details)) return null;
  const current = details.current;
  if (!current || typeof current !== "object" ||
      !("scope" in current) || current.scope !== scope ||
      (scope === "work" && (!("agent_id" in current) || current.agent_id !== id)) ||
      !("content" in current) || typeof current.content !== "string" ||
      !("version" in current) || typeof current.version !== "string" ||
      !("details" in current) || !current.details || typeof current.details !== "object" ||
      !("limit" in current) || typeof current.limit !== "number" ||
      !("updated_at" in current) || (current.updated_at !== null && typeof current.updated_at !== "number") ||
      !("updated_by" in current) || (current.updated_by !== null &&
        current.updated_by !== "user" && current.updated_by !== "agent" && current.updated_by !== "external")) return null;
  return current as AgentMemory;
}

export type MemoryDraft = {
  base: AgentMemory;
  content: string;
  /** Observation, never the CAS baseline until explicit reload. */
  remote: AgentMemory | null;
};

export function beginMemoryDraft(base: AgentMemory): MemoryDraft {
  return { base, content: base.content, remote: null };
}

export function observeMemory(state: MemoryDraft | null, incoming: AgentMemory): MemoryDraft {
  if (!state) return beginMemoryDraft(incoming);
  return { ...state, remote: incoming.version === state.base.version ? null : incoming };
}

/** Explicitly adopt the latest version while keeping local text for review. */
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

export function memoryModified(memory: AgentMemory, agentName?: string): string | null {
  if (memory.updated_at === null) return null;
  return t("{date} · {author}修改", { date: new Date(memory.updated_at * 1000).toLocaleString(getLocale()),
    author: memory.updated_by === "agent" && agentName ? agentName : memoryAuthor(memory.updated_by) });
}
