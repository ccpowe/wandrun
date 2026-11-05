import type { Conversation } from '../gateway/api.ts';

/** Confirmed activity orders roots; equal/absent activity preserves the existing local list order. */
export function conversationActivityOrder(a: Pick<Conversation, 'last_activity_seq'>, b: Pick<Conversation, 'last_activity_seq'>): number {
  return (b.last_activity_seq ?? 0) - (a.last_activity_seq ?? 0);
}
