import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Token } from 'markdown-it';
import { test } from 'node:test';

import { splitAgentMessage } from '../src/lib/agent-message.ts';
import { parseMessageMarkdown } from '../src/lib/agent-message-markdown.ts';
import { containsMath, groupMarkdownBlocks, mathBlockHtml, mathNode, safeWebLink } from '../src/lib/math-html.ts';
import { splitMathText } from '../src/lib/math-markdown.ts';

function blocks(source: string) {
  const { chunks, tail } = parseMessageMarkdown(splitAgentMessage(source));
  return [...[...chunks.values()].flatMap(groupMarkdownBlocks), ...groupMarkdownBlocks(tail)];
}

test('inline and display math parse at source positions, not in code, escaped literals or link URLs', () => {
  const parsed = blocks('Use $x^2$ and $y+1$. `code $x$` \\$5 [source](https://example.org/$path)\n\n```tex\n$z$\n```\n\n$$\\frac{1}{2}$$');
  const math = parsed.flatMap(group => group.flatMap(token => token.type === 'math_block' ? [token] : token.children?.filter(child => child.type === 'math_inline') ?? []));
  assert.deepEqual(math.map(token => [token.type, token.content]), [['math_inline', 'x^2'], ['math_inline', 'y+1'], ['math_block', '\\frac{1}{2}']]);
  assert.equal(containsMath(parsed[0]), true);
  assert.equal(containsMath(parsed[1]), false);
  assert.equal(containsMath(parsed[2]), true);
});

test('unmatched and empty delimiters remain source text, while multiline display math is bounded', () => {
  const parsed = blocks('$orphan and $$empty$$ and $ $\n\n$$\na+b\n$$\n\n$$\nunclosed');
  assert.equal(parsed.flat().filter(token => token.type === 'math_block').length, 1);
  assert.equal(parsed.flat().find(token => token.type === 'math_block')?.content, 'a+b');
  assert.equal(parsed.flat().flatMap(token => token.children ?? []).filter(token => token.type === 'math_inline').length, 0);
  assert.deepEqual(splitMathText('cost \\$5 then $x$ and $open'), [{ text: 'cost \\$5 then ' }, { tex: 'x', display: false }, { text: ' and $open' }]);
  assert.deepEqual(splitMathText('before $$a+b$$ after'), [{ text: 'before ' }, { tex: 'a+b', display: true }, { text: ' after' }]);
});

test('math in list, quote and table remains one projected containing block each', () => {
  const groups = blocks('- one $x$\n- two $y$\n\n> formula $q$\n\n| A | B |\n|---|---|\n| $m$ | $n$ |');
  assert.equal(groups.length, 3);
  assert.match(mathBlockHtml(groups[0]), /<ul>[\s\S]*data-tex="x"[\s\S]*data-tex="y"[\s\S]*<\/ul>/);
  assert.match(mathBlockHtml(groups[1]), /<blockquote>[\s\S]*data-tex="q"/);
  assert.match(mathBlockHtml(groups[2]), /<table>[\s\S]*data-tex="m"[\s\S]*data-tex="n"/);
});

test('whole-message math parsing preserves footnote definitions across UI fences', () => {
  const parts = splitAgentMessage('Math $x$ with [^a].\n\n```wandrun-ui\n{}\n```\n\n[^a]: value $y$');
  const parsed = parseMessageMarkdown(parts);
  const first = parsed.chunks.get(0)!;
  const second = parsed.chunks.get(2)!;
  assert.ok(first.some(token => token.children?.some(child => child.type === 'footnote_ref')));
  assert.ok(second.some(token => token.children?.some(child => child.type === 'math_inline' && child.content === 'y')));
  assert.equal(parsed.tail.length, 0);
});

test('projected HTML escapes hostile TeX and cannot make unsafe navigation or image requests', () => {
  const malicious = '</span><script src="https://evil.test/x"></script>';
  assert.ok(!mathNode(malicious, false).includes('<script'));
  const rawHtml = mathBlockHtml(blocks('<script>alert(1)</script> and $x$')[0]);
  assert.ok(!rawHtml.includes('<script>'));
  assert.match(rawHtml, /&lt;script&gt;/);
  const html = mathBlockHtml(blocks('![a](https://evil.test/image.png) [good](https://example.org/a) [bad](javascript:alert(1)) $x$')[0]);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /href="https:\/\/example\.org\/a"/);
  assert.equal(safeWebLink('https://example.org/a'), true);
  assert.equal(safeWebLink('file:///etc/passwd'), false);
  assert.equal(safeWebLink('https://example.org/\nattack'), false);
});

test('adjacent dollar prices and bilingual ranges stay literal in Markdown and labels', () => {
  for (const source of [
    '价格 $20、$30', '$20和$30', 'USD $20-$30', '价格区间 $20–$30 / 件',
    '$20~$30', '$20至$30', 'Basic $20，Pro $30', '¥1,280 和 $20',
    '$20.50、$30.75', 'from $20 to $30', 'US$20 / 月，US$30 / month',
  ]) {
    assert.deepEqual(splitMathText(source), [{ text: source }], source);
    assert.equal(blocks(source).some(containsMath), false, source);
  }
  for (const source of ['价格$20和$30，公式$x+1$；结果$2x$', 'Price $20–$30; math $x+1$ and $2x$']) {
    assert.deepEqual(splitMathText(source).filter(part => 'tex' in part),
      [{ tex: 'x+1', display: false }, { tex: '2x', display: false }]);
    const math = blocks(source).flat().flatMap(token => token.children ?? []).filter(token => token.type === 'math_inline');
    assert.deepEqual(math.map(token => token.content), ['x+1', '2x']);
  }
  assert.deepEqual(splitMathText('$20\\text{元}$'), [{ tex: '20\\text{元}', display: false }]);
  assert.deepEqual(splitMathText('$x\\$20$'), [{ tex: 'x\\$20', display: false }]);
});

const mediaCases = JSON.parse(readFileSync(new URL('../../tests/fixtures/ui_markdown_media.json', import.meta.url), 'utf8')) as {
  name: string; text: string; urls: string[];
}[];
for (const { name, text, urls } of mediaCases) {
  test(`shared Markdown media positions: ${name}`, () => {
    const parsed = parseMessageMarkdown(splitAgentMessage(text));
    const images: { url: string | null; index: number }[] = [];
    const collect = (tokens: Token[]) => {
      for (const token of tokens) {
        if (token.type === 'image') images.push({ url: token.attrGet('src'), index: token.meta.wandrunMediaIndex });
        else if (token.children) collect(token.children);
      }
    };
    for (const tokens of parsed.chunks.values()) collect(tokens);
    collect(parsed.tail);
    assert.deepEqual(images, urls.map((url, index) => ({ url, index })));
  });
}
