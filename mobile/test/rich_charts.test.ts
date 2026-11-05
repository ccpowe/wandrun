import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { barLabelSlots, barRectangle, chartSelection, groupedBars, toggleChartSelection } from '../src/lib/rich-chart.ts';

// Selection is category-based: all series change together, including after leaving the plot.
test('Chart.scrubbing / held: nearest category clamps at either edge and single/empty plots are defined', () => {
  assert.equal(chartSelection(19, 20, 40, 4), 0);
  assert.equal(chartSelection(40, 20, 40, 4), 1);
  assert.equal(chartSelection(139, 20, 40, 4), 3);
  assert.equal(chartSelection(-200, 20, 40, 4), 0);
  assert.equal(chartSelection(1000, 20, 40, 4), 3);
  assert.equal(chartSelection(1000, 20, 0, 1), 0);
  assert.equal(chartSelection(0, 0, 0, 0), -1);
});

test('rich.T7a / T7b: tapping toggles the same category and replaces a different category', () => {
  assert.equal(toggleChartSelection(null, 0), 0);
  assert.equal(toggleChartSelection(0, 0), null);
  assert.equal(toggleChartSelection(0, 2), 2);
  assert.equal(toggleChartSelection(2, 2), null);
});

test('BarChart.multi: category groups fit the viewport without overlapping or trailing blank space', () => {
  for (const width of [160, 320, 768]) for (const count of [1, 4, 12]) for (const series of [1, 2, 3]) {
    const layout = groupedBars(width, count, series);
    const group = series * layout.barWidth + (series - 1) * layout.innerGap;
    assert.ok(layout.barWidth > 0);
    assert.ok(layout.groupGap >= 0);
    assert.ok(Math.abs(count * (group + layout.groupGap) - width) < 1e-8);
    for (let i = 0; i < count; i++) {
      const center = layout.initialSpacing + i * layout.slot + group / 2;
      assert.ok(Math.abs(center - (i + 0.5) * width / count) < 1e-8);
      assert.equal(chartSelection(center, layout.slot / 2, layout.slot, count), i);
    }
  }
});

test('BarChart.negative / horizontal: signed bars extend on opposite sides of zero with identical scale', () => {
  assert.deepEqual(barRectangle(25, 80, 2, 10, 12, false), { x: 10, y: 30, width: 12, height: 50 });
  assert.deepEqual(barRectangle(-25, 80, 2, 10, 12, false), { x: 10, y: 80, width: 12, height: 50 });
  assert.deepEqual(barRectangle(25, 80, 2, 10, 12, true), { x: 80, y: 10, width: 50, height: 12 });
  assert.deepEqual(barRectangle(-25, 80, 2, 10, 12, true), { x: 30, y: 10, width: 50, height: 12 });
  assert.equal(barRectangle(0, 80, 2, 10, 12, true).width, 0);
});

test('BarChart.multi: long category captions retain endpoints without overlap or escaping the plot', () => {
  for (const width of [160, 320, 768]) for (const count of [1, 4, 12]) {
    const captionWidth = Math.min(100, (width - 8) / 2);
    const ticks = barLabelSlots(count, width, captionWidth, 8);
    assert.equal(ticks[0].index, 0);
    assert.equal(ticks.at(-1)!.index, count - 1);
    for (let i = 0; i < ticks.length; i++) {
      assert.ok(ticks[i].left >= 0 && ticks[i].left + captionWidth <= width);
      if (i) assert.ok(ticks[i].left >= ticks[i - 1].left + captionWidth);
    }
  }
});

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
const css = readFileSync(new URL('../global.css', import.meta.url), 'utf8');
for (const theme of ['light', 'dark']) {
  test(`Chart.default: six categorical marks remain distinct and readable in ${theme}`, () => {
    const declarations = css.match(new RegExp(`@variant ${theme} \\{([^}]+)\\}`))![1];
    const palette = Object.fromEntries([...declarations.matchAll(/(--color-[\w-]+):\s*(#[\da-fA-F]+);/g)].map(([, name, value]) => [name, value]));
    const colors = [1, 2, 3, 4, 5, 6].map((n) => palette[`--color-chart-${n}`]);
    assert.equal(new Set(colors).size, 6);
    for (const color of colors) {
      const left = luminance(color), right = luminance(palette['--color-background']);
      assert.ok((Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05) >= 3);
    }
  });
}
