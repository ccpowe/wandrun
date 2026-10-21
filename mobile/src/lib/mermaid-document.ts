import { richType } from '../components/rich-message/tokens.ts';

/** One render identity; day is sampled before cache lookup and asynchronous preparation. */
export type MermaidInput = { source: string; width: number; full: boolean; day: string };
export type MermaidTheme = {
  background: string; foreground: string; muted: string; surface: string; surfaceAlt: string;
  border: string; line: string; accent: string; error: string;
};
export type MermaidResult = { svg: string; width: number; height: number };
/** Physical host dimensions and world-space SVG center at a zoom relative to fit. */
export type MermaidViewport = { zoom: number; cx: number; cy: number; width: number; height: number };
export type MermaidCommand = { kind: 'mermaid-control'; id: number; action: 'in' | 'out' | 'reset' };
export type MermaidPage = { source: { html: string } | { uri: string }; readAccessUrl?: string; dispose?: () => void };
export type MermaidEvent =
  | { kind: 'render'; svg: string; width: number; height: number; displayHeight: number }
  | { kind: 'viewport'; viewport: MermaidViewport }
  | { kind: 'error'; code: string };

export const MERMAID_OUTPUT_LIMIT = 1_000_000;
export const MERMAID_ENGINE = 'pele@1.6.0';
export const MERMAID_FONT = 'system-ui, sans-serif';
export const MERMAID_OPTIONS = `fontSize=${richType.body.fontSize};autoDirection=false;links=false;images=false;limit=10000;maxEdges=300;outputLimit=1000000;now=UTCday`;

function validDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100_000;
}

export function validMermaidViewport(value: unknown): value is MermaidViewport {
  if (!value || typeof value !== 'object') return false;
  const viewport = value as Record<string, unknown>;
  return typeof viewport.zoom === 'number' && Number.isFinite(viewport.zoom) &&
    viewport.zoom >= 1 && viewport.zoom <= 32 &&
    typeof viewport.cx === 'number' && Number.isFinite(viewport.cx) && Math.abs(viewport.cx) <= 1_000_000 &&
    typeof viewport.cy === 'number' && Number.isFinite(viewport.cy) && Math.abs(viewport.cy) <= 1_000_000 &&
    validDimension(viewport.width) && validDimension(viewport.height);
}

export function validMermaidResult(value: unknown): value is MermaidResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.svg === 'string' && result.svg.length > 0 && result.svg.length <= MERMAID_OUTPUT_LIMIT &&
    /^<svg(?:\s|>)/.test(result.svg.trimStart()) && validDimension(result.width) && validDimension(result.height);
}

const ERROR_CODES: Record<string, true> = {
  syntax: true, semantic: true, 'unsupported-diagram': true, limit: true,
  source: true, resource: true, render: true,
};
/** WebView messages are untrusted, even when their page is application-owned. */
export function parseMermaidEvent(data: string): MermaidEvent | null {
  if (typeof data !== 'string' || data.length > MERMAID_OUTPUT_LIMIT * 2 + 1024) return null;
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object') return null;
    const event = value as Record<string, unknown>;
    if (event.kind === 'error') {
      if (typeof event.code !== 'string' || event.code.length > 32 || !/^[a-z-]+$/.test(event.code)) return null;
      return { kind: 'error', code: ERROR_CODES[event.code] ? event.code : 'render' };
    }
    if (event.kind === 'viewport') {
      if (data.length > 512 || 'svg' in event || (event.viewport !== null &&
          typeof event.viewport === 'object' && 'svg' in event.viewport) ||
          !validMermaidViewport(event.viewport)) return null;
      const { zoom, cx, cy, width, height } = event.viewport;
      return { kind: 'viewport', viewport: { zoom, cx, cy, width, height } };
    }
    const displayHeight = event.displayHeight;
    if (event.kind === 'render' && validMermaidResult(event) && validDimension(displayHeight)) {
      return { kind: 'render', svg: event.svg, width: event.width, height: event.height, displayHeight };
    }
  } catch { /* A malformed bridge message has no effects. */ }
  return null;
}

// Same source policy as the retired gateway renderer: authors cannot override
// the application's options via Mermaid frontmatter/directives or URL loaders.
const DIRECTIVE = /%%[\s\ufeff]*\{|^[\s\ufeff]*---[\s\ufeff]*$/im;
const EXTERNAL = /(?:\b(?:https?|file|data|blob|ftp|javascript|ws|wss):|\/\/|\bclick\s+\S+)/i;
export function mermaidSourceError(source: string): 'limit' | 'source' | undefined {
  if (typeof source !== 'string' || !source.trim()) return 'source';
  if (source.length > 10_000 || source.split('\n').length > 300 || (source.match(/;/g)?.length ?? 0) > 300 ||
      (source.match(/\S+/g)?.length ?? 0) > 1500 || (source.match(/-->|---|==>/g)?.length ?? 0) > 300) return 'limit';
  if (DIRECTIVE.test(source) || EXTERNAL.test(source)) return 'source';
  return undefined;
}

export type MermaidResources = { pele: string; renderer: string };
const COLOR = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([\d\s,.%]+\))$/;
const COLORS: MermaidTheme = {
  background: '#ffffff', foreground: '#1f1f1f', muted: '#6e6e6e', surface: '#f3f3f3',
  surfaceAlt: '#e6e6e6', border: '#8a8a8a', line: '#1f1f1f', accent: '#5b7bd5', error: '#e45756',
};
function jsonData(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character]!);
}
function attr(value: string): string {
  return value.replace(/[&"<>]/g, character => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!);
}
/** The only executable code is the fixed bootstrap and two app-owned files.
 * Payload is inert JSON, not interpolated JavaScript. File URLs require nonce
 * authorization because CSP cannot restrict file: to a directory in Chromium.
 * The native WebView additionally restricts its read scope and the host must
 * reject all navigations except its page. Synchronous renderer hangs require
 * unloading the WebView, not a Promise timeout. */
export function mermaidDocument(input: MermaidInput, theme: MermaidTheme, resources: MermaidResources,
  cached?: MermaidResult, viewport?: MermaidViewport): string {
  const nonce = `mermaid-${Date.now().toString(36)}-${(++nextPageNonce).toString(36)}-${Math.random().toString(36).slice(2)}`;
  const colors = (Object.keys(COLORS) as (keyof MermaidTheme)[]).map(key => COLOR.test(theme[key]) ? theme[key] : COLORS[key]);
  const variables = ['bg', 'fg', 'muted', 'surface', 'surface-alt', 'border', 'line', 'accent', 'error'];
  const css = variables.map((name, i) => `--pele-${name}:${colors[i]}`).join(';');
  const policy = `default-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; navigate-to 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`;
  const sourceError = mermaidSourceError(input.source);
  const payload = { source: sourceError ? '' : input.source, sourceError, width: input.width, full: input.full,
    day: input.day, fontSize: richType.body.fontSize, cached: !sourceError && validMermaidResult(cached) ? cached : null,
    viewport: validMermaidViewport(viewport) ? viewport : null };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="${attr(policy)}"><style nonce="${nonce}">html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}body{font-family:system-ui,sans-serif;color:${colors[1]}}#diagram{width:100%;height:100vh;box-sizing:border-box;overflow:hidden;touch-action:${input.full ? 'none' : 'pan-y'};user-select:none;${css};--pele-font:system-ui,sans-serif}#diagram svg{display:block;width:100%;height:100%;max-width:none}</style></head><body><div id="diagram"></div>` +
    `<script id="mermaid-input" type="application/json">${jsonData(payload)}</script>` +
    `<script nonce="${nonce}">document.addEventListener('error',function(e){if(e.target.tagName!=='SCRIPT')return;var data='{"kind":"error","code":"resource"}';if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(data);else window.parent.postMessage(data,'*')},true)</script>` +
    `<script nonce="${nonce}" src="${attr(resources.pele)}"></script><script nonce="${nonce}" src="${attr(resources.renderer)}"></script></body></html>`;
}
let nextPageNonce = 0;
