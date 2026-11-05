export function chatLocation(id?: string, messageSeq?: number) {
  return { pathname: '/chat' as const, params: { ...(id ? { id } : {}), ...(messageSeq !== undefined ? { message_seq: String(messageSeq) } : {}) } };
}
