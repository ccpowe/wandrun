import { MERMAID_ENGINE, MERMAID_FONT, MERMAID_OPTIONS, mermaidSourceError, validMermaidResult } from './mermaid-document.ts';
import type { MermaidInput, MermaidResult } from './mermaid-document.ts';

const MAX_ENTRIES = 16;
const MAX_BYTES = 4 * 1024 * 1024;

/** Completed SVGs belong to one computer and one layout policy. Colors are
 * intentionally absent: Pele's SVG uses CSS variables for the current theme.
 * Callers must display a hit in the same restricted Mermaid document, never in
 * a native SVG renderer. Length counts JS UTF-16 code units (two bytes each). */
export class MermaidCache {
  private entries = new Map<string, { result: MermaidResult; bytes: number }>();
  private bytes = 0;

  private key(input: MermaidInput, computerId: string): string | undefined {
    if (mermaidSourceError(input.source) || !Number.isFinite(input.width) || input.width < 1 || input.width > 4096 ||
        typeof input.full !== 'boolean' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
        typeof computerId !== 'string' || computerId.length > 1024) return undefined;
    // A late previous-day result must retain the date of its document.
    return JSON.stringify([computerId, input.source, MERMAID_ENGINE, input.width, input.full,
      MERMAID_FONT, MERMAID_OPTIONS, input.day]);
  }

  get(input: MermaidInput, computerId: string): MermaidResult | undefined {
    const key = this.key(input, computerId);
    if (key === undefined) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry.result };
  }

  put(input: MermaidInput, computerId: string, result: MermaidResult): void {
    const key = this.key(input, computerId);
    if (key === undefined || !validMermaidResult(result)) return;
    const bytes = (key.length + result.svg.length) * 2 + 16;
    if (bytes > MAX_BYTES) return;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    this.entries.set(key, { result: { svg: result.svg, width: result.width, height: result.height }, bytes });
    this.bytes += bytes;
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
}

export const mermaidCache = new MermaidCache();
