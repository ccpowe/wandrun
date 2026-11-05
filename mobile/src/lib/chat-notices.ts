export type ChatNoticeKind = "offline" | "history" | "stop" | "collaboration" | "target";
export type ChatNotice = { kind: ChatNoticeKind; message: string };

/** Only the highest-priority unresolved notice is visible; lower priorities retain their state. */
export function buildChatNotices(messages: Partial<Record<ChatNoticeKind, string | null | undefined>>): ChatNotice[] {
  const order: ChatNoticeKind[] = ["offline", "history", "stop", "collaboration", "target"];
  const kind = order.find((kind) => messages[kind]);
  return kind ? [{ kind, message: messages[kind]! }] : [];
}

/** One local hint below the banner: the result of this screen's own action (or target search).
 * It never replaces the single banner above and stays until dismissed or replaced. */
/** `send-offline`: a send blocked before any request; it lives in the composer field, not the banner (chat.N4 / N7 / G7). */
export type ChatLocalNotice = Readonly<{ kind: "send" | "send-offline" | "pick" | "remove" | "missing"; title: string; description: string }>;
