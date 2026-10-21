import type { Conversation } from "../gateway/api.ts";

/** 删除当前对话后选同一 Agent 最近更新的剩余对话；没有时调用方复用 blankConversation。 */
export function nextConversationAfterDeletion(
  conversations: readonly Pick<Conversation, "id" | "agent_id" | "updated_at">[],
  agentId: string,
  deletedId: string,
): string | null {
  let next: (typeof conversations)[number] | undefined;
  for (const conversation of conversations) {
    if (conversation.agent_id !== agentId || conversation.id === deletedId) continue;
    if (!next || conversation.updated_at > next.updated_at ||
      (conversation.updated_at === next.updated_at && conversation.id > next.id)) next = conversation;
  }
  return next?.id ?? null;
}
