import type { Token } from "markdown-it";

import { splitAgentMessage } from "./agent-message.ts";
import { parseMessageMarkdown } from "./agent-message-markdown.ts";
import type { Item } from "./chat-timeline.ts";

export type MessageText = { copy: string; quote: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Only display text from reachable UI elements; never include state, bindings, URLs or raw JSON. */
function summarizeUi(source: string): string {
  let spec: Record<string, unknown> | null;
  try { spec = record(JSON.parse(source)); } catch { return ""; }
  const elements = record(spec?.elements);
  if (!elements || typeof spec?.root !== "string") return "";
  const result: string[] = [];
  const seen = new Set<string>();
  const stack = [spec.root];
  const displayFields = ["title", "text", "label", "description", "caption", "alt", "note", "hint"];
  const collect = (value: unknown) => {
    const props = record(value);
    if (!props) return;
    for (const key of displayFields) {
      const text = props[key];
      if (typeof text === "string" && text.trim()) result.push(text.trim());
    }
  };
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const element = record(elements[id]);
    const props = record(element?.props);
    collect(props);
    if (element?.type === "Table") {
      if (Array.isArray(props?.columns)) result.push(props.columns.filter((column): column is string => typeof column === "string").join("\t"));
      if (Array.isArray(props?.rows)) {
        for (const row of props.rows) {
          if (!Array.isArray(row)) continue;
          result.push(row.map((cell: unknown) => {
            if (typeof cell === "string") return cell;
            const badgeText = record(record(cell)?.badge)?.text;
            return typeof badgeText === "string" ? badgeText : "";
          }).join("\t"));
        }
      }
    } else if (element?.type === "Metrics" || element?.type === "KeyValue") {
      if (Array.isArray(props?.items)) {
        for (const entry of props.items) {
          const item = record(entry);
          if (typeof item?.label !== "string" || typeof item.value !== "string") continue;
          result.push(`${item.label}：${item.value}`);
          if (typeof item.hint === "string" && item.hint.trim()) result.push(item.hint);
        }
      }
    } else {
      // Form option values identify submissions, unlike Metrics/KeyValue display values.
      for (const key of ["options", "items", "tabs"]) {
        const entries = props?.[key];
        if (Array.isArray(entries)) entries.forEach(collect);
      }
    }
    collect(props?.badge);
    if (Array.isArray(element?.children)) {
      for (const child of [...element.children].reverse()) if (typeof child === "string") stack.push(child);
    }
  }
  return result.join("\n");
}

/** Quote projection retains blockquote nesting so attributed text stays distinct. */
function markdownText(tokens: readonly Token[]): string {
  const blocks = [""];
  for (const token of tokens) {
    if (token.type === "blockquote_open") {
      blocks.push("");
      continue;
    }
    if (token.type === "blockquote_close") {
      const content = blocks.pop()!.trim();
      const quoted = content.split("\n").map((line) => `> ${line}`).join("\n");
      blocks[blocks.length - 1] += `${quoted}\n\n`;
      continue;
    }
    let content = "";
    if (token.type === "softbreak" || token.type === "hardbreak") content = "\n";
    else if (token.type === "footnote_ref") content = `[${Number(token.meta?.id) + 1}]`;
    else if (token.type === "footnote_anchor") continue;
    else if (token.children) content = markdownText(token.children);
    else if (token.type === "fence" || token.type === "code_block" || token.type === "math_block") content = `${token.content}\n\n`;
    else if (token.type === "td_close" || token.type === "th_close") content = "\t";
    else if (token.block && token.nesting === -1) content = "\n\n";
    else if (token.nesting === 0) content = token.content;
    blocks[blocks.length - 1] += content;
  }
  return blocks.join("");
}

/**
 * Only Agent content is Markdown/UI. User and pending text stays literal.
 * UI summaries never re-enter the Markdown parser; attachments contribute names only.
 */
export function messageText(text: string, attachments: readonly { name: string }[] = [], markdown = true): MessageText {
  const names = attachments.map((file) => file.name).join("\n");
  const appendNames = (body: string) => [body, names].filter((value) => value.trim()).join("\n\n");
  if (!markdown) {
    const literal = appendNames(text);
    return { copy: literal, quote: literal };
  }
  const segments = splitAgentMessage(text);
  // Parse the original Markdown document together to retain cross-segment reference definitions.
  const parsed = parseMessageMarkdown(segments);
  const copy: string[] = [];
  const quote: string[] = [];
  for (const [index, part] of segments.entries()) {
    if (part.kind === "markdown") {
      const tokens = parsed.chunks.get(index) ?? [];
      copy.push(part.text);
      quote.push(markdownText(tokens).replace(/\n{3,}/g, "\n\n").trim());
    } else {
      const summary = part.closed ? summarizeUi(part.source) : "";
      if (summary) {
        copy.push(`\n\n${summary}\n\n`);
        quote.push(summary);
      }
    }
  }
  quote.push(markdownText(parsed.tail).trim());
  return {
    copy: appendNames(copy.join("")),
    quote: appendNames(quote.filter(Boolean).join("\n\n")),
  };
}

/** Pending/failed sends remain recoverable; system rows, browser cards and empty messages have no actions. */
export function messageTextForItem(item: Item): MessageText | null {
  if (item.browser) return null;
  const agentMessage = item.event?.type === "message.agent" || item.event?.type === "message.task";
  const data = item.pending ?? (agentMessage || item.event?.type === "message.user" ? item.event!.data : null);
  if (!data) return null;
  const attachments = Array.isArray(data.attachments)
    ? data.attachments.filter((file: unknown): file is { name: string } => typeof record(file)?.name === "string") : [];
  const result = messageText(typeof data.text === "string" ? data.text : "", attachments, !item.pending && agentMessage);
  return result.copy.trim() ? result : null;
}

/** At most 2,000 Unicode code points including the ellipsis; snapshot this when the user selects Quote. */
export function quotePreview(text: string): string {
  const characters = Array.from(text.replace(/\r\n?|[\v\f\x1c-\x1e\x85\u2028\u2029]/g, "\n").trim());
  return characters.length > 2000 ? `${characters.slice(0, 1999).join("")}…` : characters.join("");
}

/** Every line, including blank lines, stays inside the Markdown quote; the draft is left unchanged. */
export function prependQuote(draft: string, quote: string | null): string {
  const preview = quote ? quotePreview(quote) : "";
  return preview ? `${preview.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${draft}` : draft;
}
