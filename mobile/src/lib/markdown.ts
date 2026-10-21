import MarkdownIt, { type PluginSimple } from 'markdown-it';
import cjkFriendly from 'markdown-it-cjk-friendly';
import footnote from 'markdown-it-footnote';

import { withMathMarkdown } from './math-markdown.ts';

/**
 * Every markdown-it parser shares CJK emphasis and math parsing without rewriting its source.
 * Rich UI inline text uses its own parser (parseRichInline). Types come from @types/markdown-it 14
 * while the runtime is markdown-it 10, so newer APIs in the types may not exist at runtime.
 */
export function createMarkdown({ footnotes = false }: { footnotes?: boolean } = {}): MarkdownIt {
  const markdown = withMathMarkdown(new MarkdownIt({ html: false, linkify: true, typographer: true }).use(cjkFriendly));
  // Footnote's declarations use the CJS MarkdownIt type; our ESM declarations describe
  // the same runtime parser. Keep that declaration-only boundary here.
  if (footnotes) markdown.use(footnote as unknown as PluginSimple);
  return markdown;
}
