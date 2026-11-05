import type { Conversation } from '../gateway/api.ts';
import { conversationActivityOrder } from './conversation-activity.ts';

/** chat.N2: at most this many recent Agents sit in the chip row; more Agents add the “all” sheet. */
export const NEW_CHAT_CHIP_LIMIT = 5;

type Ranked = Pick<Conversation, 'agent_id' | 'last_activity_seq'>;

/**
 * Agent list and chat.N2 share one ranking: most recent root conversation activity first, then unused Agents in
 * gateway catalog order (the creation-order baseline; new Agents append). A root without activity still counts as used.
 * Existing catalog order is retained without migrating historical manual ordering. Deleted/unknown ids are ignored.
 */
export function recentAgentOrder<A extends { id: string }>(agents: readonly A[], conversations: Iterable<Ranked>): A[] {
  const latest = new Map<string, Ranked>();
  for (const conversation of conversations) {
    const current = latest.get(conversation.agent_id);
    if (!current || conversationActivityOrder(conversation, current) < 0) latest.set(conversation.agent_id, conversation);
  }
  const used = agents.filter(agent => latest.has(agent.id));
  // Array.prototype.sort is stable: equal activity keeps catalog order.
  used.sort((a, b) => conversationActivityOrder(latest.get(a.id)!, latest.get(b.id)!));
  return [...used, ...agents.filter(agent => !latest.has(agent.id))];
}

/**
 * The chips shown above the composer: the first recent Agents, the selected one highlighted in place;
 * when the selection is not among them it leads the row (picked from the “all” sheet), as in sketch C.
 */
export function newChatChips<A extends { id: string }>(recent: readonly A[], selectedId: string, limit = NEW_CHAT_CHIP_LIMIT): A[] {
  const head = recent.slice(0, limit);
  if (head.some(agent => agent.id === selectedId)) return head;
  const selected = recent.find(agent => agent.id === selectedId);
  return selected ? [selected, ...recent.filter(agent => agent.id !== selectedId).slice(0, limit - 1)] : head;
}
