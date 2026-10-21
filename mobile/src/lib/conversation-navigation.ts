import type { SearchResult } from "../gateway/api.ts";
import type { ChatSession } from "../gateway/session.ts";
import { searchDestination } from "./file-delivery.ts";

/** A conversation switch replaces the whole chat intent: an old message target never follows a new id. */
export function switchConversation(id: string, setParams: (params: { id: string; message_seq: undefined }) => void): void {
  setParams({ id, message_seq: undefined });
}

/** A tombstone is authoritative even if this route never observed its Agent ownership. */
export function missingConversationAction(
  session: ChatSession, id: string, agentId: string | undefined,
): { type: "wait" } | { type: "leave" } | { type: "recover"; agentId: string } {
  if (!agentId) return { type: session.isDeleted(id) ? "leave" : "wait" };
  return session.connection === "listing" ? { type: "wait" } : { type: "recover", agentId };
}

/** A confirmed deletion invalidates chat search hits, not independently registered files. */
export function liveSearchDestination(result: SearchResult, session: ChatSession | null) {
  if ((result.kind === "conversation" && session?.isDeleted(result.id)) ||
    (result.kind === "message" && session?.isDeleted(result.conversation_id))) return null;
  return searchDestination(result);
}
