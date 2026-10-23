import type { Token } from "markdown-it";

import type { AgentMemory } from "../gateway/api.ts";
import { managedMemorySlug } from "./agent-memory.ts";
import { createMarkdown } from "./markdown.ts";

const markdown = createMarkdown();

/** Active detail links and their visible names, parsed with the same Markdown rules as the reader.
 * Code and plain mentions do not count; the first link text wins if a detail appears more than once. */
export function memoryIndexEntries(content: string, memory: AgentMemory): { slug: string; title: string }[] {
  const entries: { slug: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const block of markdown.parse(content, {})) {
    if (!block.children) continue;
    let slug: string | null = null;
    let title = "";
    for (const token of block.children) {
      if (token.type === "link_open") {
        slug = managedMemorySlug(token.attrGet("href") ?? "", memory);
        title = "";
      } else if (token.type === "link_close") {
        if (slug && !seen.has(slug)) {
          seen.add(slug);
          entries.push({ slug, title: title.trim() || slug });
        }
        slug = null;
      } else if (slug) {
        if (token.type === "text" || token.type === "code_inline" || token.type === "image") title += token.content;
        else if (token.type === "softbreak" || token.type === "hardbreak") title += " ";
      }
    }
  }
  return entries;
}

/** Count Markdown list entries, falling back to nonempty paragraphs for prose-only indexes. */
export function memoryEntryCount(content: string): number {
  const tokens: Token[] = markdown.parse(content, {});
  let listItems = 0;
  let paragraphs = 0;
  let listDepth = 0;
  for (const token of tokens) {
    if (token.type === "bullet_list_open" || token.type === "ordered_list_open") listDepth++;
    else if (token.type === "bullet_list_close" || token.type === "ordered_list_close") listDepth--;
    else if (token.type === "list_item_open") listItems++;
    else if (token.type === "paragraph_open" && !listDepth) paragraphs++;
  }
  return listItems || paragraphs;
}
