import type { Token } from 'markdown-it';

import type { AgentMessageSegment } from './agent-message.ts';
import { createMarkdown } from './markdown.ts';

export type MessageMarkdownTokens = Token[];

export type MessageMarkdownResult = { chunks: Map<number, MessageMarkdownTokens>; tail: MessageMarkdownTokens };

function messageParser(segments: readonly AgentMessageSegment[]) {
  let marker = 'WANDRUN_UI_BOUNDARY';
  while (segments.some((part) => part.kind === 'markdown' && part.text.includes(marker))) marker += '_';

  const markdown = createMarkdown({ footnotes: true });
  markdown.block.ruler.before('paragraph', 'wandrun_ui_boundary', (state, line, _end, silent) => {
    const start = state.bMarks[line] + state.tShift[line];
    if (state.src.slice(start, state.eMarks[line]) !== marker) return false;
    if (silent) return true;
    state.push('wandrun_ui_boundary', '', 0);
    state.line = line + 1;
    return true;
  });

  const source = segments.map((part) => part.kind === 'ui' ? `\n\n${marker}\n\n` : part.text).join('');
  return { markdown, source };
}

function distributeTokens(tokens: Token[], segments: readonly AgentMessageSegment[]): MessageMarkdownResult {
  const chunks = new Map<number, MessageMarkdownTokens>();
  // All image tokens consume a stable message-wide position, even unsupported URLs.
  // Their children describe alt text and must not consume another media index.
  let imageIndex = 0;
  const numberImages = (items: Token[]) => {
    for (const token of items) {
      if (token.type === 'image') token.meta = { ...token.meta, wandrunMediaIndex: imageIndex++ };
      else if (token.children) numberImages(token.children);
    }
  };
  numberImages(tokens);
  let index = 0;
  const tail: MessageMarkdownTokens = [];
  for (const token of tokens) {
    if (token.type === 'wandrun_ui_boundary') {
      index++;
      continue;
    }
    while (segments[index]?.kind === 'ui') index++;
    if (index >= segments.length) tail.push(token);
    else {
      let chunk = chunks.get(index);
      if (!chunk) chunks.set(index, chunk = []);
      chunk.push(token);
    }
  }
  return { chunks, tail };
}

/** Parse the whole Markdown document once so definitions on either side of a UI fence resolve everywhere. */
export function parseMessageMarkdown(segments: readonly AgentMessageSegment[]): MessageMarkdownResult {
  const { markdown, source } = messageParser(segments);
  return distributeTokens(markdown.parse(source, {}), segments);
}

type MarkdownEnvironment = {
  tailIsParagraph?: boolean;
  references?: Record<string, { href: string; title: string }>;
  footnotes?: {
    refs?: Record<string, number>;
    list?: { label?: string; count?: number; content?: string; tokens?: Token[] }[];
  };
};

function cloneToken(token: Token): Token {
  return Object.assign(Object.create(Object.getPrototypeOf(token)) as Token, token, {
    attrs: token.attrs?.map(([name, value]) => [name, value]) ?? null,
    meta: token.meta ? { ...token.meta } : token.meta,
    children: token.children?.map(cloneToken) ?? null,
  });
}

export type PreparedMessageMarkdown = {
  /** Stable body tokens, excluding the document-wide footnote footer. */
  chunks: Map<number, MessageMarkdownTokens>;
  /** null means the suffix may change prefix block ownership or definitions:
   * parse the complete document instead. Only unindented prose is cached. */
  parseTail(text: string): { tokens: MessageMarkdownTokens; footnotes: MessageMarkdownTokens } | null;
};

/** Cache a scanner prefix ending at a blank line or closed fence.
 * Blank lines alone do not close Markdown containers. parseTail admits only
 * standalone prose without new definitions; other suffixes require a full parse.
 * Each tail owns its reference counters, including on abandoned renders. */
export function prepareMessageMarkdownPrefix(segments: readonly AgentMessageSegment[]): PreparedMessageMarkdown {
  const { markdown, source } = messageParser(segments);
  const environment: MarkdownEnvironment = {};
  const definitions: Token[] = [];
  // markdown-it-footnote 4 consumes these wrappers in its core tail rule.
  // Retain their body tokens so later references can regenerate the footer
  // without reparsing either the definition source or ordinary prefix prose.
  markdown.core.ruler.before('footnote_tail', 'capture_definitions', state => {
    let inside = false;
    for (const token of state.tokens) {
      if (token.type === 'footnote_reference_open') inside = true;
      if (inside) definitions.push(token);
      if (token.type === 'footnote_reference_close') inside = false;
    }
    return true;
  });
  const prefix = markdown.parse(source, environment);
  const footerStart = prefix.findIndex(token => token.type === 'footnote_block_open');
  const body = footerStart < 0 ? prefix : prefix.slice(0, footerStart);
  const tailParser = createMarkdown({ footnotes: true });
  const referenceCount = Object.keys(environment.references ?? {}).length;
  tailParser.core.ruler.after('block', 'check_tail_blocks', state => {
    // Use the installed parser's block structure, before footnote_tail consumes
    // definition wrappers. Definitions inside quotes/lists are not prose either.
    const env = state.env as MarkdownEnvironment;
    env.tailIsParagraph = !state.src.trim() || (
      state.tokens.length === 3 && state.tokens[0].type === 'paragraph_open' &&
      state.tokens[1].type === 'inline' && state.tokens[2].type === 'paragraph_close'
    );
    return true;
  });
  tailParser.core.ruler.before('footnote_tail', 'prefix_definitions', state => {
    if (definitions.length) state.tokens = [...definitions.map(cloneToken), ...state.tokens];
    return true;
  });
  return {
    chunks: distributeTokens(body, segments).chunks,
    parseTail(text) {
      // Even a standalone paragraph can belong to a preceding list/footnote
      // when indented. Reject all indented lines, without guessing the container
      // or how many blank lines it may span.
      if (/(?:^|[\r\n])[ \t]/.test(text)) return null;
      const env: MarkdownEnvironment = {
        references: environment.references && { ...environment.references },
        footnotes: environment.footnotes && {
          refs: { ...environment.footnotes.refs },
          list: environment.footnotes.list?.map(note => ({
            ...note, tokens: note.tokens?.map(cloneToken),
          })),
        },
      };
      const tokens = tailParser.parse(text, env);
      // Link definitions emit no block tokens. Their environment changes still
      // require reparsing earlier unresolved references (including across UI).
      if (!env.tailIsParagraph || Object.keys(env.references ?? {}).length !== referenceCount) return null;
      const footer = tokens.findIndex(token => token.type === 'footnote_block_open');
      return footer < 0 ? { tokens, footnotes: [] }
        : { tokens: tokens.slice(0, footer), footnotes: tokens.slice(footer) };
    },
  };
}
