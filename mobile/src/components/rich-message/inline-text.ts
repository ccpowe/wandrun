import { mathNode } from '../../lib/math-html.ts';
import { matchMathTextAt } from '../../lib/math-markdown.ts';

export type InlinePart =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'math'; tex: string; display: boolean }
  | { kind: 'strong' | 'em'; children: InlinePart[] };

type Frame = { marker: '*' | '**'; children: InlinePart[] };

/** Parse only emphasis, code spans and math in an opt-in UI label.
 * Code shields dollars; math shields markup. Unclosed delimiters remain visible text.
 */
export function parseRichInline(source: string): InlinePart[] {
  const root: InlinePart[] = [];
  const frames: Frame[] = [];
  const current = () => frames.at(-1)?.children ?? root;
  const text = (value: string) => {
    if (!value) return;
    const parts = current();
    const previous = parts.at(-1);
    if (previous?.kind === 'text') previous.text += value;
    else parts.push({ kind: 'text', text: value });
  };
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (char === '\\' && /[*`$\\]/.test(source[i + 1] ?? '')) {
      text(source[i + 1]);
      i += 2;
      continue;
    }
    if (char === '`') {
      let length = 1;
      while (source[i + length] === '`') length++;
      const marker = '`'.repeat(length);
      let close = i + length;
      while (close < source.length) {
        close = source.indexOf('`', close);
        if (close < 0) break;
        let run = 1;
        while (source[close + run] === '`') run++;
        if (run === length) break;
        close += run;
      }
      if (close >= 0 && close < source.length) {
        current().push({ kind: 'code', text: source.slice(i + length, close) });
        i = close + length;
      } else {
        text(marker);
        i += length;
      }
      continue;
    }
    if (char === '$') {
      const formula = matchMathTextAt(source, i);
      if (formula) {
        current().push({ kind: 'math', tex: formula.tex, display: formula.display });
        i = formula.end;
        continue;
      }
    }
    if (char === '*') {
      const top = frames.at(-1);
      const canClose = i > 0 && !/\s/.test(source[i - 1]);
      const canOpen = i + 1 < source.length && !/\s/.test(source[i + 1]);
      const marker = top && source.startsWith(top.marker, i) && canClose
        ? top.marker : source[i + 1] === '*' ? '**' : '*';
      if (top?.marker === marker && canClose) {
        frames.pop();
        current().push({ kind: marker === '**' ? 'strong' : 'em', children: top.children });
      } else if (canOpen) {
        frames.push({ marker, children: [] });
      } else {
        text(marker);
      }
      i += marker.length;
      continue;
    }
    text(char);
    i++;
  }
  while (frames.length) {
    const frame = frames.pop()!;
    text(frame.marker);
    current().push(...frame.children);
  }
  return root;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Project parser-owned nodes only: no label text is trusted as HTML. */
export function richInlineHtml(parts: readonly InlinePart[]): string {
  return parts.map(part => {
    switch (part.kind) {
      case 'text': return escapeHtml(part.text);
      case 'code': return `<code>${escapeHtml(part.text)}</code>`;
      case 'math': return mathNode(part.tex, part.display);
      case 'strong': return `<strong>${richInlineHtml(part.children)}</strong>`;
      case 'em': return `<em>${richInlineHtml(part.children)}</em>`;
    }
  }).join('');
}

export function inlineHasMath(parts: readonly InlinePart[]): boolean {
  return parts.some(part => part.kind === 'math' ||
    (part.kind === 'strong' || part.kind === 'em') && inlineHasMath(part.children));
}
