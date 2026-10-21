import type { Token } from 'markdown-it';

export type SelectableSpan = {
  text: string;
  marks: string[];
  heading?: string;
  url?: string;
  marker?: boolean;
};
export type SelectablePart = { kind: 'text'; spans: SelectableSpan[] } |
  { kind: 'block'; tokens: Token[] } | { kind: 'image'; token: Token };

/** Project parsed Markdown tokens into continuous text runs. Native views (media, tables,
 * code fences) end a run; list/quote/heading structure becomes text, not sibling views.
 * This consumes the same markdown-it tokens used by the ordinary renderer. */
export function groupSelectableMarkdown(tokens: readonly Token[]): SelectablePart[] {
  const parts: SelectablePart[] = [];
  let spans: SelectableSpan[] = [];
  let pendingBreak = 0;
  let heading: string | undefined;
  let quoteDepth = 0;
  const lists: { ordered: boolean; number: number; depth: number }[] = [];
  const marks: string[] = [];
  const links: string[] = [];
  let inItem = false;
  let itemParagraphs = 0;
  let itemQuoteDepth = 0;

  const flush = () => {
    if (spans.length) parts.push({ kind: 'text', spans });
    spans = [];
    pendingBreak = 0;
  };
  const append = (text: string, marker = false) => {
    if (!text) return;
    if (pendingBreak && spans.length) spans.push({ text: '\n'.repeat(pendingBreak), marks: [] });
    pendingBreak = 0;
    spans.push({ text, marks: marker ? [] : [...marks], heading: marker ? undefined : heading,
      url: marker ? undefined : links.at(-1), marker });
  };
  const breakAfter = (lines: number) => { pendingBreak = Math.max(pendingBreak, lines); };
  const special = (part: SelectablePart) => { flush(); parts.push(part); };
  const startTextBlock = () => {
    const firstInItem = inItem && itemParagraphs === 0;
    if (inItem && itemParagraphs++) breakAfter(1);
    if (quoteDepth && !(firstInItem && quoteDepth === itemQuoteDepth)) append(`${'▎'.repeat(quoteDepth)} `, true);
  };
  const inline = (children: readonly Token[]) => {
    for (const child of children) {
      switch (child.type) {
        case 'strong_open': case 'em_open': case 's_open': marks.push(child.type.slice(0, -5)); break;
        case 'strong_close': case 'em_close': case 's_close': marks.pop(); break;
        case 'link_open': links.push(child.attrGet('href') || ''); break;
        case 'link_close': links.pop(); break;
        case 'text': case 'html_inline': append(child.content); break;
        // The selectable chat renderer diverts math to MathContent. Read-only
        // drafts use this projection instead and must retain visible source.
        case 'math_inline': append(`$${child.content}$`); break;
        case 'code_inline':
          if (child.content) {
            append(child.content);
            spans[spans.length - 1].marks.push('code_inline');
          }
          break;
        case 'softbreak': case 'hardbreak':
          append('\n');
          if (quoteDepth) append(`${'▎'.repeat(quoteDepth)} `, true);
          break;
        case 'image': special({ kind: 'image', token: child }); break;
        case 'footnote_ref': append(`[${Number(child.meta?.id) + 1}]`); break;
        default: if (child.children?.length) inline(child.children);
          else if (child.nesting === 0) append(child.content);
      }
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'heading_open': heading = `heading${token.tag.slice(1)}`; startTextBlock(); break;
      case 'heading_close': heading = undefined; breakAfter(2); break;
      case 'paragraph_open': startTextBlock(); break;
      case 'paragraph_close': breakAfter(inItem ? 1 : 2); break;
      case 'blockquote_open': quoteDepth++; break;
      case 'blockquote_close': quoteDepth--; breakAfter(inItem ? 1 : 2); break;
      case 'bullet_list_open': case 'ordered_list_open':
        lists.push({ ordered: token.type === 'ordered_list_open', number: Number(token.attrGet('start') || 1), depth: lists.length });
        break;
      case 'bullet_list_close': case 'ordered_list_close': lists.pop(); breakAfter(lists.length ? 1 : 2); break;
      case 'list_item_open': {
        const list = lists.at(-1);
        if (list) {
          breakAfter(spans.length ? 1 : 0);
          const prefix = list.ordered ? `${list.number++}${token.markup || '.'}` : '•';
          append(`${'  '.repeat(list.depth)}${quoteDepth ? `${'▎'.repeat(quoteDepth)} ` : ''}${prefix} `, true);
        }
        inItem = true;
        itemParagraphs = 0;
        itemQuoteDepth = quoteDepth;
        break;
      }
      case 'list_item_close': inItem = lists.length > 1; breakAfter(1); break;
      case 'inline': inline(token.children ?? []); break;
      case 'fence': case 'code_block': case 'hr': case 'math_block':
        special({ kind: 'block', tokens: [token] }); break;
      case 'table_open': case 'footnote_block_open': {
        let depth = token.nesting;
        let end = i;
        while (depth > 0 && end + 1 < tokens.length) depth += tokens[++end].nesting;
        special({ kind: 'block', tokens: tokens.slice(i, end + 1) });
        i = end;
        break;
      }
    }
  }
  flush();
  return parts;
}
