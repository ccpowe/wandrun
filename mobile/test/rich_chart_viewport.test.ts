import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barLayout, chartViewportProps, chartYAxisLabelWidth, lineLayout, LINE_POINT_RADIUS } from '../src/components/rich-message/chart-viewport.ts';

test('measured chart width becomes a plot viewport after Y-axis and point overhang', () => {
  for (const [container, lineWidth, barWidth] of [[328, 277, 279], [258, 207, 209]]) {
    const line = chartViewportProps(container, 'line');
    const bar = chartViewportProps(container, 'bar');
    assert.deepEqual(line, { width: lineWidth, yAxisLabelWidth: 48 });
    assert.deepEqual(bar, { width: barWidth, yAxisLabelWidth: 48 });
    assert.ok(line.yAxisLabelWidth + 1 + line.width + LINE_POINT_RADIUS <= container);
    assert.ok(bar.yAxisLabelWidth + 1 + bar.width <= container);

  }
});

test('resized and very narrow cards never pass a negative chart width', () => {
  assert.equal(chartViewportProps(210, 'line').width, 159);
  assert.equal(chartViewportProps(140, 'line').width, 89);
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

test('bar slots spread across wide plots and fall back to scrolling on narrow ones', () => {
  const wide = 1000;
  const bars = barLayout(wide, 4);
  assert.ok(Math.abs(24 + 4 * (bars.barWidth + bars.spacing) - wide) < 1e-9);
  assert.equal(bars.barWidth, 48);
  assert.deepEqual(barLayout(200, 12), { barWidth: 16, spacing: 12 });
});

test('5/12/24 points fit and sparse endpoint label slots stay visible at phone and tablet widths', () => {
  for (const width of [320, 360, 390, 768]) {
    for (const count of [5, 12, 24]) {
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
