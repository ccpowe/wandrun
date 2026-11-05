import type { SearchResult } from "../gateway/api.ts";
import type { ChatSession, ConversationView } from "../gateway/session.ts";
import { searchDestination } from "./file-delivery.ts";
import { conversationActivityOrder } from "./conversation-activity.ts";
import { recentAgentOrder } from "./new-chat-agents.ts";

/** A conversation switch replaces the whole chat intent: an old message target never follows a new id. */
export function switchConversation(id: string, setParams: (params: { id: string; message_seq: undefined }) => void): void {
  setParams({ id, message_seq: undefined });
}

/** A tombstone is authoritative even if this route never observed its Agent ownership. */
export function missingConversationAction(
  session: ChatSession, id: string, agentId: string | undefined,
): { type: "wait" } | { type: "leave" } {
  if (session.isDeleted(id)) return { type: "leave" };
  return { type: agentId && session.connection !== "listing" ? "leave" : "wait" };
}

/** The chat route leaves when its Agent was deleted, or its missing conversation will not come back. */
export function chatExitAction(
  session: ChatSession, id: string, conversation: unknown, agentId: string | undefined,
): "stay" | "leave" {
  if (agentId !== undefined && session.agents.deletedIds.has(agentId)) return "leave";
  if (conversation) return "stay";
  return missingConversationAction(session, id, agentId).type === "leave" ? "leave" : "stay";
}

export type ChatEntryTarget =
  | { type: "conversation"; id: string }
  | { type: "new"; agentId: string }
  | { type: "empty" | "wait" | "unavailable" };

/** Resolve every entry/deletion through the same root-only policy, retaining usable cached data. */
export function chatEntryTarget(session: ChatSession, lastConversationId?: string, startNew = false): ChatEntryTarget {
  if (!startNew) {
    let recent: ConversationView | undefined;
    for (const conversation of session.conversations.values()) {
      if (session.agents.deletedIds.has(conversation.agent_id)) continue;
      if (conversation.id === lastConversationId) return { type: "conversation", id: conversation.id };
      if (conversation.last_text === null && session.pendingFor(conversation.id).length === 0) continue;
      if (!recent || conversationActivityOrder(conversation, recent) < 0) recent = conversation;
    }
    if (recent) return { type: "conversation", id: recent.id };
  }
  const first = recentAgentOrder(session.agents.agents, session.conversations.values()).find((agent) => !session.agents.deletedIds.has(agent.id));
  if (first && session.agents.loaded) return { type: "new", agentId: first.id };
  if (session.connection === "error" || session.agents.error && !session.agents.agents.length) return { type: "unavailable" };
  if (session.connection !== "open" || !session.agents.loaded) return { type: "wait" };
  return { type: "empty" };
}

/** A confirmed deletion invalidates chat search hits, not independently registered files. */
export function liveSearchDestination(result: SearchResult, session: ChatSession | null) {
  if ((result.kind === "conversation" && session?.isDeleted(result.id)) ||
    (result.kind === "message" && session?.isDeleted(result.conversation_id))) return null;
  return searchDestination(result);
}
