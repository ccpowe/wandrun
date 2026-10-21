import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inlineHasMath, parseRichInline, richInlineHtml } from '../src/components/rich-message/inline-text.ts';

const html = (source: string) => richInlineHtml(parseRichInline(source));

test('opt-in emphasis and code parse as nested native-capable parts without a formula', () => {
  const parts = parseRichInline('Plain **bold and *italic*** then `code $5`');
  assert.equal(inlineHasMath(parts), false);
  assert.equal(richInlineHtml(parts), 'Plain <strong>bold and <em>italic</em></strong> then <code>code $5</code>');
  assert.deepEqual(parseRichInline('**a**'), [{ kind: 'strong', children: [{ kind: 'text', text: 'a' }] }]);
});

test('unpaired markers stay literal and escaped markers are not formatting', () => {
  assert.equal(html('unpaired **strong and *italic and `code'), 'unpaired **strong and *italic and `code');
  assert.equal(html('unpaired end** and end*'), 'unpaired end** and end*');
  assert.equal(html('\\*literal\\* \\`literal\\` \\$5'), '*literal* `literal` $5');
  assert.equal(html('a $open and $$unfinished'), 'a $open and $$unfinished');
  assert.equal(html('trailing `'), 'trailing `');
  assert.equal(html('``'), '``');
});

test('formula takes precedence over markup; code shields dollars and delimiters', () => {
  const parts = parseRichInline('**Rate $x*y$** and `literal $q$ *z*` then $$a+b$$');
  assert.equal(inlineHasMath(parts), true);
  assert.match(richInlineHtml(parts), /^<strong>Rate <span class="math-source" data-tex="x\*y" data-display="0">x\*y<\/span><\/strong> and <code>literal \$q\$ \*z\*<\/code> then <span class="math-source display" data-tex="a\+b" data-display="1">a\+b<\/span>$/);
  assert.equal(html('`$20` and $20、$30, then $x$'), '<code>$20</code> and $20、$30, then <span class="math-source" data-tex="x" data-display="0">x</span>');
  assert.equal(html('``price `$20` and *literal*`` then $x$'),
    '<code>price `$20` and *literal*</code> then <span class="math-source" data-tex="x" data-display="0">x</span>');
  assert.equal(html('$x*2$ and **strong `code` with $y$**'),
    '<span class="math-source" data-tex="x*2" data-display="0">x*2</span> and <strong>strong <code>code</code> with <span class="math-source" data-tex="y" data-display="0">y</span></strong>');
});

test('all prose, code and formula HTML is escaped before the offline renderer', () => {
  const output = html('**<script>** `</code><img src=x>` $</span><script>$ & " \'');
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('<img'));
  assert.match(output, /<strong>&lt;script&gt;<\/strong>/);
  assert.match(output, /<code>&lt;\/code&gt;&lt;img src=x&gt;<\/code>/);
  assert.match(output, /data-tex="&lt;\/span&gt;&lt;script&gt;"/);
  assert.match(output, /&amp; &quot; &#39;$/);
});
