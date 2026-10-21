import type { FileRecord, GatewayEvent } from "../gateway/api.ts";

export type AgentMessageSegment =
  | { kind: "markdown"; text: string }
  | { kind: "ui"; source: string; block: number; closed: boolean };

export type UiSubmission = { values: Record<string, unknown>; createdAt: string };
/** UI metadata may grant only exact paths belonging to image attachments in this same message. */
export function authorizedImageFiles(
  status: { valid: boolean; files?: Record<string, string> } | undefined,
  attachments: readonly Pick<FileRecord, "id" | "media_type">[] | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!status?.valid || !status.files || typeof status.files !== "object" || Array.isArray(status.files) || !attachments) return undefined;
  const images = new Set(attachments.filter((file) =>
    typeof file?.id === "string" && typeof file.media_type === "string" &&
    file.media_type.split(";", 1)[0].trim().toLowerCase().startsWith("image/")).map((file) => file.id));
  const files: Record<string, string> = Object.create(null);
  for (const [path, id] of Object.entries(status.files)) if (typeof id === "string" && images.has(id)) files[path] = id;
  return files;
}
/** In-memory, message-local UI state; an attempt remains frozen across unknown network results. */
export type UiDraft = {
  values: Record<string, unknown>;
  attempt: { values: Record<string, unknown>; clientId: string } | null;
  pending: boolean;
  completed: boolean;
  error: { message: string; retryable: boolean; editable: boolean } | null;
};

/**
 * Mirror the gateway's line fence scanner: <=3 literal leading spaces, >=3 identical backticks
 * or tildes; only ASCII spaces/tabs may surround the exact `wandrun-ui` info or trail a
 * same-character closer of at least the opening length. Ordinary fences shield UI markers.
 * Even an unclosed UI fence consumes a block number, but callers must display its raw fallback.
 */
export function splitAgentMessage(text: string): AgentMessageSegment[] {
  const parts: AgentMessageSegment[] = [];
  let cursor = 0;
  let markdownStart = 0;
  let fence: { character: string; length: number; ui: boolean; start: number; bodyStart: number } | null = null;
  let block = 0;
  // Python splitlines(keepends=True) in the gateway also recognizes CR, CRLF and Unicode line separators.
  const lineBreak = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g;
  while (cursor < text.length) {
    lineBreak.lastIndex = cursor;
    const breakMatch = lineBreak.exec(text);
    const end = breakMatch?.index ?? text.length;
    const next = breakMatch ? end + breakMatch[0].length : end;
    const line = text.slice(cursor, end);
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (closer && closer[1][0] === fence.character && closer[1].length >= fence.length && /^[ \t]*$/.test(closer[2])) {
        if (fence.ui) {
          if (markdownStart < fence.start) parts.push({ kind: "markdown", text: text.slice(markdownStart, fence.start) });
          parts.push({ kind: "ui", source: text.slice(fence.bodyStart, cursor), block: block++, closed: true });
          markdownStart = next;
        }
        fence = null;
      }
    } else {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener) {
        fence = {
          character: opener[1][0], length: opener[1].length,
          ui: /^[ \t]*wandrun-ui[ \t]*$/.test(opener[2]),
          start: cursor, bodyStart: next,
        };
      }
    }
    cursor = next;
  }
  if (fence?.ui) {
    if (markdownStart < fence.start) parts.push({ kind: "markdown", text: text.slice(markdownStart, fence.start) });
    parts.push({ kind: "ui", source: text.slice(fence.bodyStart), block, closed: false });
  } else if (markdownStart < text.length) {
    parts.push({ kind: "markdown", text: text.slice(markdownStart) });
  }
  return parts;
}

/** Read only a user's submission of a prior message; the timeline owns conversation isolation and earliest seq. */
export function uiSubmissionFromEvent(event: GatewayEvent): { messageSeq: number; block: number; submission: UiSubmission } | null {
  if (event.type !== "message.user") return null;
  const raw: unknown = event.data?.ui_submission;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { message_seq, block, values } = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(message_seq) || (message_seq as number) <= 0 || (message_seq as number) >= event.seq ||
    !Number.isSafeInteger(block) || (block as number) < 0 ||
    typeof values !== "object" || values === null || Array.isArray(values) || !Number.isFinite(event.at)) return null;
  const submittedAt = new Date(event.at * 1000);
  if (!Number.isFinite(submittedAt.getTime())) return null;
  return {
    messageSeq: message_seq as number, block: block as number,
    submission: { values: values as Record<string, unknown>, createdAt: submittedAt.toISOString() },
  };
}
