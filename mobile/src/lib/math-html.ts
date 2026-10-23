import type { Token } from 'markdown-it';
import type { AgentMemory } from '../gateway/api.ts';
import { managedMemorySlug } from './agent-memory.ts';

import { createMarkdown } from './markdown.ts';

const markdown = createMarkdown({ footnotes: true });
const escape = markdown.utils.escapeHtml;

/** Only parser-produced tokens may reach this renderer; raw HTML is disabled at parse time. */
markdown.renderer.rules.math_inline = (tokens, index) => mathNode(tokens[index].content, false);
markdown.renderer.rules.math_block = (tokens, index) => mathNode(tokens[index].content, true) + '\n';
markdown.renderer.rules.image = (tokens, index) => `[图片：${escape(tokens[index].content || tokens[index].attrGet('src') || '')}]`;
markdown.renderer.rules.link_open = (tokens, index, _options, env) => {
  const url = tokens[index].attrGet('href') || '';
  const memory: AgentMemory | undefined = env.managedMemory;
  return safeWebLink(url) || memory && managedMemorySlug(url, memory) ? `<a href="${escape(url)}">` : '<a>';
};
markdown.renderer.rules.link_close = () => '</a>';

export function safeWebLink(url: string): boolean {
  return url.length <= 2048 && /^https?:\/\//i.test(url) && !/[\x00-\x20\x7f]/.test(url);
}

export function mathNode(tex: string, display: boolean): string {
  const safe = escape(tex);
  return `<span class="math-source${display ? ' display' : ''}" data-tex="${safe}" data-display="${display ? '1' : '0'}">${safe}</span>`;
}

export function containsMath(tokens: readonly Token[]): boolean {
  return tokens.some(token => token.type === 'math_inline' || token.type === 'math_block' || !!token.children && containsMath(token.children));
}

/** Keep each containing block (paragraph/list/quote/table/footnote section) in one WebView. */
export function groupMarkdownBlocks(tokens: readonly Token[]): Token[][] {
  const result: Token[][] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    depth += tokens[i].nesting;
    if (depth !== 0) continue;
    result.push(tokens.slice(start, i + 1));
    start = i + 1;
  }
  if (start < tokens.length) result.push(tokens.slice(start));
  return result;
}

export function mathBlockHtml(tokens: readonly Token[], managedMemory?: AgentMemory): string {
  return markdown.renderer.render(tokens as Token[], markdown.options, { managedMemory });
}
