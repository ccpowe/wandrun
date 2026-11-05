import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartViewportProps, chartYAxisLabelWidth, lineLayout, LINE_POINT_RADIUS } from '../src/components/rich-message/chart-viewport.ts';

test('measured plot and point overhang stay inside the container', () => {
  for (const container of [258, 328]) {
    for (const kind of ['line', 'bar'] as const) {
      const viewport = chartViewportProps(container, kind);
      assert.ok(viewport.width > 0);
      assert.ok(viewport.yAxisLabelWidth + 1 + viewport.width + (kind === 'line' ? LINE_POINT_RADIUS : 0) <= container);
    }
  }
});

test('resized and very narrow cards never pass a negative chart width', () => {
  assert.equal(chartViewportProps(32, 'line').width, 0);
  assert.equal(chartViewportProps(32, 'bar').width, 0);
});

test('compact extreme labels at double font scale leave a useful phone plot', () => {
  const labels = ['-1.8e308', '-1e308', '0', '1e308', '1.8e308'];
  const measured = chartYAxisLabelWidth(labels, 2);
  for (const kind of ['line', 'bar'] as const) {
    const plot = chartViewportProps(320, kind, measured);
    assert.ok(plot.width >= 160);
    assert.ok(plot.yAxisLabelWidth + 1 + plot.width + (kind === 'line' ? LINE_POINT_RADIUS : 0) <= 320);
  }
  const widerLabels = chartViewportProps(320, 'line', 1000);
  assert.ok(widerLabels.width >= 160);
});


test('single/5/12/24 points fit and sparse endpoint label slots stay visible at phone and tablet widths', () => {
  for (const width of [320, 360, 390, 768]) {
    for (const count of [1, 5, 12, 24]) {
      for (const fontScale of [1, 1.5, 2]) {
        for (const text of ['2026', '这是完整的二十个中文字符横轴标签用来验证']) {
          const labels = Array.from({ length: count }, (_, i) => `${text}${i}`);
          const plot = chartViewportProps(width, 'line').width;
          const layout = lineLayout(plot, labels, fontScale);
          assert.ok(Math.abs(layout.initialSpacing + layout.spacing * (count - 1) + layout.endSpacing - plot) < 1e-9);
          assert.equal(layout.ticks[0].label, labels[0]);
          assert.equal(layout.ticks.at(-1)?.label, labels.at(-1));
          assert.ok(layout.ticks.length <= 6);
          for (const [index, tick] of layout.ticks.entries()) {
            assert.ok(tick.left >= 0);
            assert.ok(tick.left + layout.labelWidth <= plot);
            if (index) assert.ok(tick.left >= layout.ticks[index - 1].left + layout.labelWidth);
          }
        }
      }
    }
  }
});
