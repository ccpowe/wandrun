import type { Token } from "markdown-it";

import { splitAgentMessage } from "./agent-message.ts";
import { parseMessageMarkdown } from "./agent-message-markdown.ts";
import { t } from "./i18n.ts";

function previewTokens(tokens: readonly Token[]): string {
  let text = "";
  for (const token of tokens) {
    if (token.type === "fence" || token.type === "code_block") text += ` ${t("[代码]")} `;
    else if (token.type === "image") text += previewTokens(token.children ?? []).trim() || t("[图片]");
    else if (token.type === "footnote_anchor") continue;
    else if (token.children) text += previewTokens(token.children);
    else if (token.type === "softbreak" || token.type === "hardbreak" || token.block && token.nesting === -1) text += " ";
    else if (token.type === "td_close" || token.type === "th_close") text += " ";
    else if (token.nesting === 0) text += token.content;
  }
  return text;
}

/** Single-line display only: Markdown labels/alt text without destination URLs, code placeholders,
 * and literal formula source. UI JSON (including incomplete blocks) is never projected;
 * outside text wins, otherwise use a localized card label. Attachments contribute names only.
 * Does not truncate, translate message text, or modify the stored/chat-rendered source.
 */
export function messagePreview(text: string | null | undefined, attachments: readonly { name: string }[] = []): string {
  const segments = splitAgentMessage(text ?? "");
  const parsed = parseMessageMarkdown(segments);
  const body = [...parsed.chunks.values(), parsed.tail].map(previewTokens).join(" ").replace(/\s+/g, " ").trim();
  const content = body || (segments.some((part) => part.kind === "ui") ? t("[交互卡片]") : "");
  return [content, ...attachments.map((file) => file.name)].join(" ").replace(/\s+/g, " ").trim();
}
