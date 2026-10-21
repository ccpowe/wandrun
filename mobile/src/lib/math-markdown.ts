import type MarkdownIt from 'markdown-it';

const MAX_TEX = 4096;
export type MathPart = { tex: string; display: boolean } | { text: string };

function matchInlineMath(source: string, start: number): { end: number; tex: string } | null {
  if (source[start] !== '$' || source[start - 1] === '$' || source[start + 1] === '$' || source[start + 1] === undefined || /\s/.test(source[start + 1])) return null;
  for (let cursor = start + 1; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (char === '\n') return null;
    if (char !== '$') continue;
    if (source[cursor + 1] === '$') return null;
    let backslashes = 0;
    for (let index = cursor - 1; source[index] === '\\'; index--) backslashes++;
    if (backslashes % 2) continue;
    // A dollar immediately followed by a digit starts another price, not a
    // closing delimiter ($20、$30, $20和$30, $20–$30). Do not search past it.
    if (/[0-9]/.test(source[cursor + 1] ?? '')) return null;
    const tex = source.slice(start + 1, cursor);
    if (!tex.trim() || /\s/.test(tex[tex.length - 1]) || tex.length > MAX_TEX) return null;
    // Do not let the final price consume a following formula in unspaced
    // Chinese prose. Explicit TeX (e.g. 20\\text{元}) remains mathematical.
    if (/^\d/.test(tex) && /[\u3400-\u9fff、，]/.test(tex) && !tex.includes('\\')) return null;
    return { end: cursor + 1, tex };
  }
  return null;
}

/** Match a label formula at a source offset; callers decide which spans are code first. */
export function matchMathTextAt(source: string, start: number): { end: number; tex: string; display: boolean } | null {
  if (source[start] !== '$') return null;
  let slashes = 0;
  for (let index = start - 1; source[index] === '\\'; index--) slashes++;
  if (slashes % 2) return null;
  const inline = matchInlineMath(source, start);
  if (inline) return { ...inline, display: false };
  if (source[start + 1] !== '$' || source[start + 2] === '$') return null;
  for (let end = start + 2; end + 1 < source.length && end - start <= MAX_TEX + 4; end++) {
    if (source[end] !== '$' || source[end + 1] !== '$') continue;
    let escaped = 0;
    for (let index = end - 1; source[index] === '\\'; index--) escaped++;
    if (escaped % 2) continue;
    const tex = source.slice(start + 2, end);
    return tex.trim() ? { tex: tex.trim(), end: end + 2, display: true } : null;
  }
  return null;
}

/** Plain display labels recognize math delimiters without interpreting other Markdown syntax. */
export function splitMathText(source: string): MathPart[] {
  const result: MathPart[] = [];
  let from = 0;
  for (let i = 0; i < source.length; i++) {
    const matched = matchMathTextAt(source, i);
    if (!matched) continue;
    if (from < i) result.push({ text: source.slice(from, i) });
    result.push({ tex: matched.tex, display: matched.display });
    from = matched.end;
    i = from - 1;
  }
  if (from < source.length) result.push({ text: source.slice(from) });
  return result;
}

/** Delimiters are recognized during Markdown parsing, never inside code or link destinations. */
export function withMathMarkdown(markdown: MarkdownIt): MarkdownIt {
  markdown.block.ruler.before('fence', 'math_block', (state, line, end, silent) => {
    const start = state.bMarks[line] + state.tShift[line];
    const first = state.src.slice(start, state.eMarks[line]);
    if (!first.startsWith('$$') || first.startsWith('$$$')) return false;
    let tex = '';
    let closeLine = line;
    const sameLine = first.slice(2).indexOf('$$');
    if (sameLine >= 0) {
      const rest = first.slice(2);
      if (rest.slice(sameLine + 2).trim()) return false;
      tex = rest.slice(0, sameLine);
    } else {
      if (first.slice(2).trim()) tex = first.slice(2) + '\n';
      let closed = false;
      for (let cursor = line + 1; cursor < end; cursor++) {
        const content = state.src.slice(state.bMarks[cursor] + state.tShift[cursor], state.eMarks[cursor]);
        const at = content.indexOf('$$');
        if (at >= 0 && !content.slice(at + 2).trim()) {
          tex += content.slice(0, at);
          closeLine = cursor;
          closed = true;
          break;
        }
        tex += content + '\n';
        if (tex.length > MAX_TEX) return false;
      }
      if (!closed) return false;
    }
    if (!tex.trim() || tex.length > MAX_TEX) return false;
    if (silent) return true;
    const token = state.push('math_block', '', 0);
    token.content = tex.trim();
    token.map = [line, closeLine + 1];
    state.line = closeLine + 1;
    return true;
  });

  markdown.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const match = matchInlineMath(state.src, state.pos);
    if (!match || match.end > state.posMax) return false;
    if (!silent) {
      const token = state.push('math_inline', '', 0);
      token.content = match.tex;
    }
    state.pos = match.end;
    return true;
  });
  return markdown;
}

export const MAX_MATH_SOURCE = MAX_TEX;
