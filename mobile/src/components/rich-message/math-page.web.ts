import { mathDocument, type MathPage, type MathTheme } from '../../lib/math-document.ts';
import { katexWebAssets } from './katex-web-assets.ts';

/** Expo serves public/ in development and copies it into the Web export.
 * These are app-owned resources, never CDN/message URLs. Parent-created blobs
 * cannot load in opaque sandboxed frames; keep the sandbox, not allow-same-origin.
 * The browser caches the same two URLs across all frames and theme changes.
 * Resolves immediately; the native implementation awaits local file writes. */
export async function prepareMathPage(body: string, theme: MathTheme): Promise<MathPage> {
  const resources = {
    script: new URL(katexWebAssets.script, window.location.origin).href,
    styles: new URL(katexWebAssets.styles, window.location.origin).href,
  };
  return { source: { html: mathDocument(body, theme, resources) } };
}
