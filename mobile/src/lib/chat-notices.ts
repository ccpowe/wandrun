export type ChatNoticeKind = "offline" | "history" | "stop" | "collaboration" | "target";
export type ChatNotice = { kind: ChatNoticeKind; message: string };

/** Connectivity first, then recoverable conversation errors, then collaboration/target details.
 * Missing notices leave no empty card or gap. Messages are translated by the screen. */
export function buildChatNotices(messages: Partial<Record<ChatNoticeKind, string | null | undefined>>): ChatNotice[] {
  const order: ChatNoticeKind[] = ["offline", "history", "stop", "collaboration", "target"];
  return order.flatMap((kind) => messages[kind] ? [{ kind, message: messages[kind]! }] : []);
}
