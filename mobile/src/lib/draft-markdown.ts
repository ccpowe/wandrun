/** stable marks a part whose rendered content will not change on append; open UI fences are placeholders. */
export type DraftPart = { kind: 'markdown' | 'ui' | 'mermaid'; text: string; stable?: boolean };

const lineBreak = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g;
const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** Unfinished Markdown is plain text: mask image syntax before a media source can be exposed. */
export function draftTailText(text: string, imagePlaceholder = '[图片生成中]'): string {
  return text.replace(/!\[[^\]\n]*(?:\]\([^)\n]*\)?)?/g, imagePlaceholder);
}

/** Append-only scanner: completed blocks retain identity; only the unfinished tail changes. */
export class DraftMarkdown {
  private source = '';
  private cursor = 0;
  private text = '';
  private parts: DraftPart[] = [];
  private fence: { character: string; length: number; kind: 'ui' | 'mermaid' | 'ordinary' } | null = null;

  /** A suspended render must not consume the committed parser's cursor or blocks. */
  fork(): DraftMarkdown {
    const next = new DraftMarkdown();
    next.source = this.source;
    next.cursor = this.cursor;
    next.text = this.text;
    next.parts = this.parts.slice();
    next.fence = this.fence;
    return next;
  }

  update(source: string): readonly DraftPart[] {
    if (!source.startsWith(this.source)) {
      this.source = '';
      this.cursor = 0;
      this.text = '';
      this.parts = [];
      this.fence = null;
    }
    this.source = source;
    lineBreak.lastIndex = this.cursor;
    let match: RegExpExecArray | null;
    while ((match = lineBreak.exec(source))) {
      // CR may be the first half of CRLF in the next cumulative snapshot.
      if (match[0] === '\r' && match.index + 1 === source.length) break;
      const line = source.slice(this.cursor, match.index);
      const ending = match[0];
      this.line(line, ending);
      this.cursor = match.index + ending.length;
      lineBreak.lastIndex = this.cursor;
    }
    const pending = source.slice(this.cursor);
    if (this.fence?.kind === 'ui' || this.fence?.kind === 'mermaid') return this.parts;
    const candidate = /^ {0,3}(`+|~+)(.*)$/.exec(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
    const info = candidate?.[2]?.trim() ?? '';
    const pendingFence = candidate && (candidate[1].length < 3 || 'wandrun-ui'.startsWith(info) || 'mermaid'.startsWith(info));
    if (pendingFence && this.fence === null) {
      const kind = 'mermaid'.startsWith(info) && !'wandrun-ui'.startsWith(info) ? 'mermaid' : 'ui';
      return [...this.parts, ...(this.text ? [{ kind: 'markdown' as const, text: this.text }] : []), { kind, text: '' }];
    }
    const tail = this.text + pending;
    return tail ? [...this.parts, { kind: 'markdown', text: tail }] : this.parts;
  }

  private line(line: string, ending: string): void {
    if (this.fence) {
      const closer = opener.exec(line);
      if (closer && closer[1][0] === this.fence.character && closer[1].length >= this.fence.length && /^[ \t]*$/.test(closer[2])) {
        if (this.fence.kind === 'ordinary') this.text += line + ending;
        this.fence = null;
        if (this.text) this.commit();
      } else if (this.fence.kind === 'ordinary') this.text += line + ending;
      return;
    }
    const opening = opener.exec(line);
    if (opening) {
      const info = opening[2];
      const kind = /^[ \t]*wandrun-ui[ \t]*$/.test(info) ? 'ui' : /^[ \t]*mermaid[ \t]*$/.test(info) ? 'mermaid' : 'ordinary';
      if (kind !== 'ordinary' && this.text) this.commit();
      this.fence = { character: opening[1][0], length: opening[1].length, kind };
      if (kind === 'ordinary') this.text += line + ending;
      else this.parts.push({ kind, text: '', stable: true });
      return;
    }
    this.text += line + ending;
    if (/^[ \t]*$/.test(line)) this.commit();
  }

  private commit(): void {
    if (this.text) this.parts.push({ kind: 'markdown', text: this.text, stable: true });
    this.text = '';
  }
}
