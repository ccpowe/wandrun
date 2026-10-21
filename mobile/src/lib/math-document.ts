export type MathTheme = { color: string; muted: string; border: string; fontSize: number };

/** Only the application's bundled resources may be supplied, never message URLs. */
export type MathResources = { script: string; styles: string };

/** A prepared page owns its content file, not the application-wide resources. */
export type MathPage = {
  source: { html: string } | { uri: string };
  readAccessUrl?: string;
  dispose?: () => void;
};
const SCRIPT = `
(function () {
  'use strict';
  function send(message) {
    var data = JSON.stringify(message);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(data);
    else window.parent.postMessage(data, '*');
  }
  // A failed stylesheet must not be reported as a successfully rendered formula.
  if (window.mathResourceFailed || typeof katex === 'undefined' || !document.querySelector('#katex-styles').sheet) {
    send({ kind: 'error' }); return;
  }
  document.querySelectorAll('[data-tex]').forEach(function (node) {
    try {
      katex.render(node.getAttribute('data-tex'), node, {
        displayMode: node.getAttribute('data-display') === '1',
        throwOnError: true, trust: false, strict: 'warn', maxExpand: 1000, maxSize: 20
      });
      node.classList.add('rendered');
    } catch {
      node.classList.add('failed');
      node.textContent = node.getAttribute('data-tex');
    }
  });
  function measure() {
    var height = Math.ceil(document.querySelector('.content').getBoundingClientRect().height);
    if (Number.isFinite(height) && height > 0) send({ kind: 'height', height: height });
  }
  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href]');
    if (link) {
      event.preventDefault();
      send({ kind: 'link', href: link.getAttribute('href') });
    }
  });
  // Trigger layout/font discovery before capturing the current ready promise.
  document.querySelector('.content').getBoundingClientRect();
  document.fonts.ready.then(function () {
    if (Array.from(document.fonts).some(function (font) { return font.status === 'error'; })) {
      send({ kind: 'error' }); return;
    }
    window.addEventListener('resize', measure);
    new ResizeObserver(measure).observe(document.body);
    measure();
  }, function () { send({ kind: 'error' }); });
})();`;

const PAGE_STYLE = `
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent}
body{font-family:system-ui,-apple-system,Roboto,sans-serif;color:var(--ink);font-size:var(--size);line-height:1.62;overflow-wrap:anywhere}
.content{padding:2px 0}p{margin:4px 0 9px}h1,h2,h3,h4,h5,h6{line-height:1.3;margin:12px 0 6px}
ul,ol{padding-left:24px;margin:6px 0}li{margin:3px 0}blockquote{border-left:3px solid var(--border);background:var(--muted);padding:8px 10px;margin:8px 0}
pre,code{background:var(--muted);font-family:monospace}pre{overflow-x:auto;padding:8px}code{white-space:pre-wrap}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}td,th{border:1px solid var(--border);padding:4px 6px}
a{color:inherit;text-decoration:underline}.math-source{white-space:pre-wrap}.math-source.display{display:block;overflow-x:auto;overflow-y:hidden;padding:7px 0;text-align:center}
.math-source.failed{font-family:monospace;color:var(--ink);background:var(--muted)}.katex-display{margin:0;overflow-x:auto;overflow-y:hidden}
`;

/** Escaped Markdown projection only. Resource URLs come from the platform owner.
 * Web CSP names two exact app resources. File URLs do not support path-scoped
 * CSP matching in Chromium: authorize only our fixed resource elements by nonce,
 * never the file: scheme. Escaping/trust:false remain the input boundary. */
export function mathDocument(body: string, theme: MathTheme, resources: MathResources): string {
  const { color, muted, border, fontSize } = theme;
  const css = `:root{--ink:${color};--muted:${muted};--border:${border};--size:${fontSize}px}`;
  const local = resources.script.startsWith('file:');
  const resourceNonce = local ? ' nonce="math-local"' : '';
  const stylesPolicy = local ? "style-src-elem 'nonce-math-local'" : `style-src-elem 'unsafe-inline' ${resources.styles}`;
  const scriptsPolicy = local ? "'nonce-math-local'" : `'nonce-math-local' ${resources.script}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src 'none'; font-src data:; style-src 'unsafe-inline'; ${stylesPolicy}; script-src ${scriptsPolicy}">` +
    `<script nonce="math-local">window.addEventListener('error', function(event) { if (event.target.tagName === 'LINK' || event.target.tagName === 'SCRIPT') window.mathResourceFailed = true; }, true);</script>` +
    `<link${resourceNonce} id="katex-styles" rel="stylesheet" href="${resources.styles}"><style nonce="math-local">${PAGE_STYLE}\n${css}</style></head><body><div class="content">${body}</div>` +
    `<script${resourceNonce} src="${resources.script}"></script><script nonce="math-local">${SCRIPT}</script></body></html>`;
}
