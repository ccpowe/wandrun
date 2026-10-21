import { mermaidDocument } from '../../lib/mermaid-document.ts';
import type { MermaidInput, MermaidPage, MermaidResult, MermaidTheme, MermaidViewport } from '../../lib/mermaid-document.ts';
import { peleWebAssets } from './pele-web-assets.ts';

/** Expo serves public/ in development and bundles it into Web exports. The
 * parent mounts this srcDoc in a sandboxed iframe with allow-scripts, without
 * allow-same-origin: no script may navigate the parent or read its credentials. */
export async function prepareMermaidPage(input: MermaidInput, theme: MermaidTheme, _computerId: string,
  cached?: MermaidResult, viewport?: MermaidViewport): Promise<MermaidPage> {
  return { source: { html: mermaidDocument(input, theme, {
    pele: new URL(peleWebAssets.script, window.location.origin).href,
    renderer: new URL(peleWebAssets.renderer, window.location.origin).href,
  }, cached, viewport) } };
}
