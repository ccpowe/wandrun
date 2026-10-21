import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { prepareMathPage } from '../src/components/rich-message/math-page.web.ts';
import { mathNode } from '../src/lib/math-html.ts';

const theme = { color: '#141414', muted: '#eeeeee', border: '#dddddd', fontSize: 16 };

test('Web documents reference one bundled resource pair across content and theme changes', async t => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://wandrun.example' } } });
  t.after(() => { Reflect.deleteProperty(globalThis, 'window'); });
  const pages = await Promise.all(['x^2', '\\frac{1}{2}', '\\sum_{i=1}^n i', '\\sqrt{x}'].map((tex, index) =>
    prepareMathPage(mathNode(tex, true), { ...theme, color: index % 2 ? '#eeeeee' : '#141414' })));
  const html = pages.map(page => { assert.ok('html' in page.source); return page.source.html; });
  const scripts = html.map(value => value.match(/<script src="([^"]+)"/)![1]);
  const styles = html.map(value => value.match(/rel="stylesheet" href="([^"]+)"/)![1]);
  assert.equal(new Set(scripts).size, 1);
  assert.equal(new Set(styles).size, 1);
  for (const value of html) {
    assert.ok(Buffer.byteLength(value) < 6000);
    assert.ok(!value.includes('base64,'));
  }
  // Execute the actual shared engine, rather than trusting a file name or mock.
  const script = readFileSync(new URL(`../public${new URL(scripts[0]).pathname}`, import.meta.url), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(script, context);
  const rendered = vm.runInContext('katex.renderToString("x^2", {trust:false})', context) as string;
  assert.match(rendered, /<math[\s>]/);
  assert.match(rendered, /<msup>/);
  const css = readFileSync(new URL(`../public${new URL(styles[0]).pathname}`, import.meta.url), 'utf8');
  assert.match(css, /data:font\/woff2;base64,/);
  assert.ok(!/url\((?!data:)/.test(css), 'fonts must not need network or file permissions');
});
