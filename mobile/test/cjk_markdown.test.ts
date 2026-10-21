import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitAgentMessage } from '../src/lib/agent-message.ts';
import { parseMessageMarkdown } from '../src/lib/agent-message-markdown.ts';
import { createMarkdown } from '../src/lib/markdown.ts';
import { mathBlockHtml } from '../src/lib/math-html.ts';
import { messageText } from '../src/lib/message-actions.ts';
import { groupSelectableMarkdown } from '../src/lib/selectable-markdown.ts';

for (const [source, marked, suffix, mark] of [
  ['**完成。**然后', '完成。', '然后', 'strong'],
  ['**「引号」**后', '「引号」', '后', 'strong'],
  ['*斜体，*接着', '斜体，', '接着', 'em'],
  ['**DeepSeek 开源。**我们', 'DeepSeek 开源。', '我们', 'strong'],
]) {
  test(`CJK emphasis reaches ordinary, selectable and HTML renderers: ${source}`, () => {
    const expected = `<p><${mark}>${marked}</${mark}>${suffix}</p>\n`;
    const markdown = createMarkdown();
    assert.equal(markdown.render(source), expected);
    const parsed = parseMessageMarkdown(splitAgentMessage(source));
    const tokens = parsed.chunks.get(0)!;
    assert.equal(mathBlockHtml(tokens), expected);
    assert.deepEqual(groupSelectableMarkdown(tokens).flatMap(part => part.kind === 'text'
      ? part.spans.map(span => [span.text, span.marks]) : []), [[marked, [mark]], [suffix, []]]);
    assert.equal(messageText(source).copy, source);
    assert.equal(messageText(source, [], false).copy, source);
  });
}

test('English emphasis keeps CommonMark intraword behavior', () => {
  const markdown = createMarkdown();
  assert.equal(markdown.renderInline('snake_case_name'), 'snake_case_name');
  assert.equal(markdown.renderInline('2*3*4'), '2<em>3</em>4');
  assert.equal(markdown.renderInline('**bold**text'), '<strong>bold</strong>text');
});

test('code and math retain literal stars beside CJK emphasis', () => {
  const source = '**完成。**然后 `**代码。**接着` $a*b*c$\n\n```text\n*代码，*接着\n```\n\n$$\na**b\n$$';
  const { chunks } = parseMessageMarkdown(splitAgentMessage(source));
  const tokens = chunks.get(0)!;
  const inline = tokens.flatMap(token => token.children ?? []);
  assert.deepEqual(inline.filter(token => ['code_inline', 'math_inline'].includes(token.type))
    .map(token => [token.type, token.content]), [['code_inline', '**代码。**接着'], ['math_inline', 'a*b*c']]);
  assert.deepEqual(tokens.filter(token => ['fence', 'math_block'].includes(token.type))
    .map(token => [token.type, token.content]), [['fence', '*代码，*接着\n'], ['math_block', 'a**b']]);
  const html = mathBlockHtml(tokens);
  assert.match(html, /<strong>完成。<\/strong>然后/);
  assert.match(html, /<code>\*\*代码。\*\*接着<\/code>/);
  assert.match(html, /data-tex="a\*b\*c"/);
  assert.match(html, /data-tex="a\*\*b"/);
  assert.equal(messageText(source).copy, source);
});
