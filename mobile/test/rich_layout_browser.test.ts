import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

type Bounds = { x: number; y: number; width: number; height: number; right: number; bottom: number };
type LayoutResult = {
  kind: 'metrics' | 'labels' | 'extreme' | 'heading' | 'tabs' | 'tabs-scroll' | 'source-grid' | 'source-nested' | 'chat-code' | 'link-grid' | 'link-card' | 'link-stack' | 'link-mixed' | 'link-list' | 'link-titles' | 'link-thumbnails'; width: number; fontScale?: number;
  measuredWidth?: number; text?: string; cells?: Bounds[];
  headingBottom?: number; plotTop?: number; sectionsTop?: number;
  tabs?: { trigger: Bounds; pill: Bounds; label: Bounds; text: string; scrollWidth: number; lineHeight: number }[];
  cell?: Bounds; toggle?: Bounds; label?: Bounds; arrow?: Bounds; lineHeight?: number;
  charts?: { bounds: Bounds; legend?: Bounds; plot?: Bounds; circles?: Bounds[]; yLabels?: string[];
    labels?: { text: string; bounds: Bounds; scrollHeight: number }[] }[];
  lines?: number; viewportWidth?: number; scrollWidth?: number; scrollLeft?: number; codeHeight?: number;
  expectedHeight?: number; frameScrollWidth?: number; inlineOutsideScroll?: boolean; fontFamily?: string;
  links?: { bounds: Bounds; text: Bounds; thumbnail: Bounds | null; scrollWidth: number }[];
  groups?: number[][];
  titles?: { caption: string; text: string; last: Bounds; arrow: Bounds;
    arrowUnderline: string; underlinedText: string; embeddedViews: number }[];
  colors?: number[][]; explicitEdgeColors?: number[][]; fallback?: string;
};

test('browser layout preserves charts, tabs, Source summaries and unwrapped chat code', { timeout: 180000 }, (context) => {
  const python = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));
  // The layout probe drives Chrome from the backend venv; app-only checkouts skip it.
  if (!existsSync(python)) { context.skip('backend .venv not installed'); return; }
  const run = spawnSync(python,
    [fileURLToPath(new URL('./fixtures/rich_layout_browser.py', import.meta.url))], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 170000,
      env: { ...process.env, LANGSMITH_TRACING: 'false' },
    });
  if (run.status === 77) { context.skip(run.stderr.trim()); return; }
  assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}`);
  const results: LayoutResult[] = JSON.parse(run.stdout);
  for (const result of results) {
    const where = `${result.kind} ${result.width}/${result.fontScale ?? 1}`;
    if (result.kind === 'link-thumbnails') {
      assert.deepEqual(result.colors, [[200, 40, 40, 255], [40, 200, 40, 255]],
        'website icons and explicit images must display their own authenticated pixels through real Renderer coordinates');
      assert.deepEqual(result.explicitEdgeColors, [[40, 200, 40, 255], [40, 200, 40, 255]],
        'an explicit wide image must retain its center crop');
      assert.equal(result.fallback, 'S', 'a 404 icon must retain its source mark, even when image bytes exist');
      continue;
    }
    if (result.kind === 'link-titles') {
      for (const title of result.titles!) {
        assert.equal(title.text, `${title.caption}\u2060\u00a0↗\ufe0e`, where);
        assert.equal(title.embeddedViews, 0, `${where}: title must not use embedded-view baseline layout`);
        assert.equal(title.underlinedText, title.caption, `${where}: underline must cover the complete title only`);
        assert.equal(title.arrowUnderline, 'none', `${where}: arrow must not be underlined`);
        assert.ok(Math.abs(title.last.y - title.arrow.y) <= 1, `${where}: last character and arrow separated vertically`);
        assert.ok(title.arrow.x >= title.last.right - 1, `${where}: arrow must follow the final character`);
      }
      continue;
    }
    if (result.kind.startsWith('link-')) {
      assert.deepEqual(result.groups, result.kind === 'link-mixed' ? [[0, 1], [0]] : [[0, 1]], `${where}: adjacent rows must group through the real Renderer`);
      for (const link of result.links!) {
        assert.ok(link.text.width >= Math.min(160, link.bounds.width) - 1, `${where}: decorative art crushed the text column`);
        assert.ok(link.text.right <= link.bounds.right + 1, `${where}: text escaped the row`);
        assert.ok(link.scrollWidth <= link.bounds.width + 1, `${where}: row overflow`);
        if (link.thumbnail) {
          assert.equal(link.thumbnail.width, 64, where);
          assert.equal(link.thumbnail.height, 64, where);
        } else {
          assert.ok(Math.abs(link.text.width - link.bounds.width) <= 1, `${where}: narrow rows must give text the full width`);
        }
      }
      continue;
    }
    if (result.kind === 'chat-code') {
      assert.ok(Math.abs(result.viewportWidth! - result.width) <= 1, `${where}: code viewport does not fit the message`);
      assert.ok(result.scrollWidth! > result.viewportWidth!, `${where}: long code must overflow horizontally`);
      assert.ok(result.scrollLeft! > 0, `${where}: the surface cannot scroll to the long-line suffix`);
      assert.ok(Math.abs(result.codeHeight! - result.expectedHeight!) <= 1, `${where}: source lines wrapped or were vertically capped`);
      assert.ok(result.frameScrollWidth! <= result.width + 1, `${where}: code widens the whole page`);
      assert.equal(result.inlineOutsideScroll, true, `${where}: inline code was moved into the block scroller`);
      assert.match(result.fontFamily!, /monospace/);
      continue;
    }
    if (result.kind === 'tabs' || result.kind === 'tabs-scroll') {
      const tabs = result.tabs!;
      assert.equal(tabs.length, result.kind === 'tabs' ? 4 : 5, where);
      for (const [index, tab] of tabs.entries()) {
        assert.equal(tab.text, `选项${index + 1}二零二六年第一季度第一阶段统计结果`);
        assert.ok(tab.trigger.height >= 44, where);
        assert.ok(tab.pill.x >= tab.trigger.x && tab.pill.right <= tab.trigger.right + 1, `${where}: pill overlaps adjacent target`);
        assert.ok(tab.label.x >= tab.pill.x && tab.label.right <= tab.pill.right + 1, `${where}: text escapes pill`);
        assert.ok(tab.label.height <= tab.lineHeight + 1, `${where}: label wraps`);
      }
      if (result.kind === 'tabs') {
        assert.ok(tabs.every(tab => Math.abs(tab.trigger.width - tabs[0].trigger.width) < 1), where);
        assert.ok(tabs.at(-1)!.trigger.right <= result.width + 1, where);
        assert.ok(tabs.every(tab => tab.scrollWidth > tab.label.width), `${where}: fixture no longer exercises truncation`);
      } else {
        assert.ok(tabs.at(-1)!.trigger.right > result.width, `${where}: missing horizontal overflow`);
        assert.ok(tabs.every(tab => tab.scrollWidth <= tab.label.width + 1), `${where}: scrolling labels compressed`);
      }
      continue;
    }
    if (result.kind === 'source-grid' || result.kind === 'source-nested') {
      assert.ok(result.cell!.width >= 280, `${where}: Source assigned a narrow column`);
      assert.ok(result.toggle!.x >= result.cell!.x && result.toggle!.right <= result.cell!.right + 1, where);
      assert.ok(result.label!.height <= result.lineHeight! + 1, `${where}: summary wraps`);
      assert.ok(result.arrow!.width > 0 && result.arrow!.right <= result.toggle!.right, `${where}: arrow crushed or outside button`);
      continue;
    }
    if (result.kind === 'metrics') {
      assert.equal(result.measuredWidth, result.width, where);
      assert.match(result.text!, /12.*已完成.*1.*失败/, where);
      assert.equal(result.cells!.length, 2, where);
      assert.ok(result.cells!.every((cell) => cell.width >= 140 && cell.height > 0), where);
      continue;
    }
    if (result.kind === 'heading') {
      assert.ok(result.sectionsTop! >= result.headingBottom!, `${where}: gifted background covers data button`);
      assert.ok(result.plotTop! <= result.sectionsTop!, where);
      continue;
    }
    if (result.kind === 'extreme') {
      for (const chart of result.charts!) {
        assert.ok(chart.plot!.width >= 160, `${where}: plot disappeared`);
        assert.ok(chart.circles!.length >= 2, `${where}: no SVG points`);
        assert.notEqual(chart.circles![0].x, chart.circles![1].x, where);
        assert.notEqual(chart.circles![0].y, chart.circles![1].y, where);
        assert.ok(chart.yLabels!.some((label) => label.includes('e308')), `${where}: extreme tick not displayed`);
        assert.ok(!chart.yLabels!.some((label) => label.includes('Infinity')), where);
      }
      continue;
    }
    const [long, short] = result.charts!;
    assert.equal(long.labels![0].text, '二零二六年第一季度第一阶段统计结果', where);
    assert.equal(long.labels![1].text, '二零二六年第二季度第二阶段统计结果', where);
    for (const chart of result.charts!) {
      assert.equal(chart.bounds.width, result.width, where);
      for (const label of chart.labels!) {
        assert.ok(label.bounds.bottom <= chart.legend!.y, `${where}: label overlaps legend`);
        assert.ok(label.scrollHeight <= label.bounds.height + 1, `${where}: text clipped`);
        assert.ok(label.bounds.x >= chart.bounds.x && label.bounds.right <= chart.bounds.right + 1, where);
      }
    }
    assert.ok(Math.abs(long.bounds.height - short.bounds.height) < 1, `${where}: unequal row heights`);
    assert.ok(Math.abs(long.legend!.y - short.legend!.y) < 1, `${where}: unaligned legends`);
    if (result.width === 320 && result.fontScale === 2) {
      assert.ok(long.labels![0].bounds.height > 120, `fixture must exceed the former height limit: ${JSON.stringify(long.labels![0])}`);
    }
  }
});
