import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import ts from 'typescript';
import { chartValueAxis } from '../src/components/rich-message/chart-values.ts';
import { richGeometry } from '../src/components/rich-message/tokens.ts';

const stylesheet = readFileSync(new URL('../global.css', import.meta.url), 'utf8');
const themes = (['light', 'dark'] as const).map((theme) => {
  const declarations = stylesheet.match(new RegExp(`@variant ${theme} \\{([^}]+)\\}`))?.[1];
  assert.ok(declarations, `${theme} theme exists`);
  return Object.fromEntries([...declarations.matchAll(/(--color-[\w-]+):\s*(#[\da-fA-F]+);/g)]
    .map(([, name, value]) => [name, value]));
});
let currentTheme: Record<string, string> = themes[0];

declare global {
  var __richChartVariables: (names: string[]) => (string | undefined)[];
  var IS_REACT_ACT_ENVIRONMENT: boolean;
  var __richChartFontScale: number;
}
globalThis.__richChartVariables = (names) => names.map((name) => currentTheme[name]);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__richChartFontScale = 1;

// Keep the actual chart component and value projection; substitute only platform hosts/hooks.
const hosts: Record<string, string> = {
  'react-native': `export const View = 'View'; export const Pressable = 'Pressable'; export const useWindowDimensions = () => ({fontScale: globalThis.__richChartFontScale});`,
  'react-native-svg': `export default 'Svg'; export const Circle = 'Circle'; export const Line = 'Line'; export const Rect = 'Rect';`,
  'react-native-gifted-charts': `export const LineChart = 'LineChart'; export const BarChart = 'BarChart'; export const PieChart = 'PieChart';`,
  'uniwind': `export const useCSSVariable = globalThis.__richChartVariables;`,
  './math.tsx': `export const RichText = 'Text';`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});

// Import after hook registration: static imports would load native-only chart dependencies before substitutes.
const { RichLineChart, RichBarChart, RichPieChart } = await import('../src/components/rich-message/charts.tsx');

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const channels = hex.match(/[a-f\d]{2}/gi);
    assert.ok(channels && channels.length === 3);
    const [r, g, blue] = channels.map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
  };
  const left = luminance(a), right = luminance(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

for (const [index, theme] of themes.entries()) {
  test(`six ordinary pie slices remain distinct and readable in ${index ? 'dark' : 'light'} theme`, async () => {
    currentTheme = theme;
    const root = createRoot({ textComponentTypes: ['Text'] });
    try {
      await act(async () => { root.render(createElement(RichPieChart, {
        props: { items: ['甲', '乙', '丙', '丁', '戊', '己'].map((label, i) => ({ label, value: i + 1 })) },
      })); });
      const pie = root.container.queryAll((node) => node.type === 'PieChart')[0];
      const slices = pie.props.data as { color: string; value: number }[];
      const legend = root.container.queryAll((node) => node.props.testID === 'rich-pie-legend')[0];
      const marks = legend.queryAll((node) => node.props.style?.backgroundColor).map((node) => node.props.style.backgroundColor as string);
      assert.deepEqual(marks, slices.map((slice) => slice.color));
      assert.equal(new Set(marks).size, 6);
      const statusColors = Object.entries(theme).filter(([key]) => key.startsWith('--color-rich-') && key.endsWith('-border'))
        .map(([, color]) => color);
      for (const mark of marks) {
        assert.ok(!statusColors.includes(mark), `${mark} cannot impersonate a semantic state`);
        assert.ok(contrast(mark, theme['--color-background']) >= 3, `${mark} remains legible on ${theme['--color-background']}`);
      }
      assert.notEqual(slices[3].color, theme['--color-rich-error-border']);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
}

test('three crossing lines have matching legend patterns and point selection retains raw values', async () => {
  currentTheme = themes[0];
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => { root.render(createElement(RichLineChart, { props: {
      xLabels: ['早', '晚'], unit: 'm', series: [
        { name: 'Alpha', values: [1.23456789e-7, 3] },
        { name: 'Beta', values: [2, 1.23456789012345e+100] },
        { name: 'Gamma', values: [4, 1] },
      ],
    } })); });
    const card = root.container.queryAll((node) => node.props.testID === 'rich-line-chart')[0];
    await act(async () => { card.props.onLayout({ nativeEvent: { layout: { width: 320 } } }); });
    const chart = root.container.queryAll((node) => node.type === 'LineChart')[0];
    const sets = chart.props.dataSet as { color: string; strokeDashArray?: number[]; dataPointsShape: string;
      data: { onPress: () => void }[] }[];
    const samples = root.container.queryAll((node) => node.type === 'Svg');
    assert.equal(samples.length, 3);
    assert.deepEqual(sets.map((set) => set.strokeDashArray), [undefined, [8, 4], [2, 4]]);
    assert.deepEqual(sets.map((set) => set.dataPointsShape), ['circular', 'rectangular', 'circular']);
    for (let i = 0; i < sets.length; i++) {
      const line = samples[i].queryAll((node) => node.type === 'Line')[0];
      const marker = samples[i].queryAll((node) => node.type === 'Circle' || node.type === 'Rect')[0];
      assert.equal(line.props.stroke, sets[i].color);
      assert.deepEqual(line.props.strokeDasharray, sets[i].strokeDashArray);
      assert.equal(marker.type, sets[i].dataPointsShape === 'rectangular' ? 'Rect' : 'Circle');
      assert.equal(marker.props.fill, sets[i].color);
    }
    await act(async () => { sets[0].data[0].onPress(); });
    const selected = root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0];
    assert.equal(selected.props.children, 'Alpha · 早：1.23456789e-7 m');
    await act(async () => { sets[1].data[1].onPress(); });
    assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0].props.children,
      'Beta · 晚：1.23456789012345e+100 m');
    await act(async () => {
      root.container.queryAll((node) => node.props.testID === 'rich-line-points-toggle')[0].props.onPress();
    });
    await act(async () => {
      root.container.queryAll((node) => node.props.testID === 'rich-line-point-4')[0].props.onPress();
    });
    assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0].props.children,
      'Gamma · 早：4 m');
    assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-line-points-toggle')[0].props.accessibilityState.expanded, false);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('bar and pie selection reports original values rather than scaled chart coordinates', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => { root.render(createElement(RichBarChart, { props: {
      labels: ['小值', '大值'], values: [1.23456789e-7, 9.87654321e100], unit: '元',
    } })); });
    const card = root.container.queryAll((node) => node.props.testID === 'rich-bar-chart')[0];
    await act(async () => { card.props.onLayout({ nativeEvent: { layout: { width: 320 } } }); });
    const chart = root.container.queryAll((node) => node.type === 'BarChart')[0];
    await act(async () => { chart.props.data[1].onPress(); });
    assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0].props.children,
      '大值：9.87654321e+100 元');
    await act(async () => {
      root.container.queryAll((node) => node.props.testID === 'rich-bar-points-toggle')[0].props.onPress();
    });
    await act(async () => {
      root.container.queryAll((node) => node.props.testID === 'rich-bar-point-0')[0].props.onPress();
    });
    assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0].props.children,
      '小值：1.23456789e-7 元');
    await act(async () => { root.render(createElement(RichPieChart, { props: {
      items: [{ label: '小值', value: 0.000000123456789 }, { label: '大值', value: 1e100 }], unit: '元',
    } })); });
    await act(async () => {
      root.container.queryAll((node) => node.props.testID === 'rich-pie-point-0')[0].props.onPress();
    });
    assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0].props.children,
      '小值：1.23456789e-7 元');
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('signed line charts keep one plot height, visible endpoint labels and accessible exact values', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    for (const width of [320, 360, 390, 768]) {
      for (const count of [5, 12, 24]) {
        for (const value of [10, -10, 0, Number.MAX_VALUE]) {
          const xLabels = Array.from({ length: count }, (_, i) => String(2000 + i));
          const values = Array.from({ length: count }, (_, i) => value === Number.MAX_VALUE ? value : value + i);
          await act(async () => { root.render(createElement(RichLineChart, { key: `${width}-${count}-${value}`, props: {
            title: '趋势', xLabels, series: [{ name: '数值', values }],
          } })); });
          await act(async () => {
            root.container.queryAll((node) => node.props.testID === 'rich-line-chart')[0]
              .props.onLayout({ nativeEvent: { layout: { width } } });
          });
          const chart = root.container.queryAll((node) => node.type === 'LineChart')[0];
          const axis = chartValueAxis(values);
          assert.equal(chart.props.noOfSectionsBelowXAxis, 0);
          assert.equal(chart.props.maxValue, (axis.above + axis.below) * 25);
          assert.equal(chart.props.height, richGeometry.chartHeight);
          assert.deepEqual(chart.props.yAxisLabelTexts, axis.labels);
          assert.deepEqual(chart.props.dataSet[0].data.map((point: { value: number }) => point.value), axis.values.map(value => value + axis.below * 25));
          // gifted-charts adds endSpacing to horizontal rules, outside its scroll viewport.
          assert.ok(chart.props.yAxisLabelWidth + 1 + chart.props.width + chart.props.endSpacing <= width);
          for (const index of [0, count - 1]) {
            const label = root.container.queryAll((node) => node.props.testID === `rich-line-label-${index}`)[0];
            assert.equal(label.props.children, xLabels[index]);
            assert.equal(label.props.numberOfLines, undefined);
          }
          assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value').length, 0);
          await act(async () => {
            root.container.queryAll((node) => node.props.testID === 'rich-line-points-toggle')[0].props.onPress();
          });
          const points = root.container.queryAll((node) => /^rich-line-point-\d+$/.test(node.props.testID ?? ''));
          assert.deepEqual(points.map((point) => point.props.accessibilityLabel),
            values.map((raw, i) => `数值 · ${xLabels[i]}：${raw}`));
          await act(async () => { points[count - 1].props.onPress(); });
          assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0].props.children,
            `数值 · ${xLabels[count - 1]}：${values[count - 1]}`);
        }
      }
    }
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('line and bar render zero-anchored nice ticks for positive, negative and mixed series', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    for (const values of [
      [10, 12, 11], [-17.2, -9.6, -10.6], [-3, 9, 1],
      [Number.MIN_VALUE, 2 * Number.MIN_VALUE], [-Number.MAX_VALUE, Number.MAX_VALUE],
    ]) {
      const axis = chartValueAxis(values);
      for (const kind of ['line', 'bar'] as const) {
        await act(async () => { root.render(kind === 'line'
          ? createElement(RichLineChart, { key: `${kind}-${values}`,
            props: { xLabels: ['甲', '乙', '丙'], series: [{ name: '数值', values }] } })
          : createElement(RichBarChart, { key: `${kind}-${values}`,
            props: { labels: ['甲', '乙', '丙'], values } })); });
        await act(async () => {
          root.container.queryAll((node) => node.props.testID === `rich-${kind}-chart`)[0]
            .props.onLayout({ nativeEvent: { layout: { width: 320 } } });
        });
        const chart = root.container.queryAll((node) => node.type === (kind === 'line' ? 'LineChart' : 'BarChart'))[0];
        const displayValues = kind === 'line'
          ? chart.props.dataSet[0].data.map((point: { value: number }) => point.value)
          : chart.props.data.map((point: { value: number }) => point.value);
        assert.deepEqual(displayValues, kind === 'line' ? axis.values.map(value => value + axis.below * 25) : axis.values);
        const below = kind === 'line' ? 0 : axis.below;
        assert.equal(chart.props.noOfSectionsBelowXAxis, below);
        assert.equal(chart.props.maxValue, 25 * (kind === 'line' ? axis.above + axis.below : axis.above));
        assert.ok(Math.abs(chart.props.height + chart.props.stepHeight * below - richGeometry.chartHeight) < 1e-8);
        assert.deepEqual(chart.props.yAxisLabelTexts, axis.labels);
        assert.ok(chart.props.yAxisLabelWidth + chart.props.width + 1 <= 320);
        if (!axis.above) {
          assert.equal(chart.props.yAxisLabelTexts.at(-1), '0');
          if (kind === 'bar') assert.equal(chart.props.height, 0);
          else assert.ok(displayValues.every((value: number) => value >= 0));
        }
        const firstPoint = kind === 'line' ? chart.props.dataSet[0].data[0] : chart.props.data[0];
        await act(async () => { firstPoint.onPress(); });
        assert.equal(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0].props.children,
          kind === 'line' ? `数值 · 甲：${values[0]}` : `甲：${values[0]}`);
      }
    }
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('320px double-scale extreme charts retain distinct plot positions and exact details', async () => {
  globalThis.__richChartFontScale = 2;
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    for (const [kind, values] of [
      ['line', [-1e308, Number.MAX_VALUE]],
      ['line', [-Number.MAX_VALUE, 1e308]],
      ['bar', [-1e308, Number.MAX_VALUE]],
      ['bar', [-Number.MAX_VALUE, 1e308]],
    ] satisfies ['line' | 'bar', number[]][]) {
      await act(async () => { root.render(kind === 'line'
        ? createElement(RichLineChart, { key: `${kind}-${values}`, props: {
          title: '极值', xLabels: ['负', '正'], series: [{ name: '原始值', values }],
        } })
        : createElement(RichBarChart, { key: `${kind}-${values}`, props: {
          title: '极值', labels: ['负', '正'], values,
        } })); });
      await act(async () => { root.container.queryAll((node) => node.props.testID === `rich-${kind}-chart`)[0]
        .props.onLayout({ nativeEvent: { layout: { width: 320 } } }); });
      const chart = root.container.queryAll((node) => node.type === (kind === 'line' ? 'LineChart' : 'BarChart'))[0];
      assert.ok(chart.props.width >= 160);
      assert.ok(chart.props.yAxisLabelWidth + chart.props.width + 1 + (kind === 'line' ? 2 : 0) <= 320);
      assert.ok(chart.props.yAxisLabelTexts.every((label: string) => label.length <= 9 && !label.includes('Infinity')));
      const points = kind === 'line' ? chart.props.dataSet[0].data : chart.props.data;
      assert.notEqual(points[0].value, points[1].value);
      assert.ok(points.every((point: { value: number }) => Number.isFinite(point.value)));
      await act(async () => { root.container.queryAll((node) => node.props.testID === `rich-${kind}-points-toggle`)[0].props.onPress(); });
      const detail = root.container.queryAll((node) => node.props.testID === `rich-${kind}-point-1`)[0];
      assert.ok(detail.props.accessibilityLabel.includes(String(values[1])));
      await act(async () => { detail.props.onPress(); });
      assert.ok(root.container.queryAll((node) => node.props.testID === 'rich-chart-selected-value')[0]
        .props.children.includes(String(values[1])));
      if (kind === 'line') {
        const labels = root.container.queryAll((node) => /^rich-line-label-\d+$/.test(node.props.testID ?? ''));
        const left = labels.map((label) => label.props.style.marginLeft);
        assert.ok(left[1] > left[0]);
        const plot = root.container.queryAll((node) => node.props.testID === 'rich-line-plot')[0];
        assert.equal(plot.props.style.paddingTop, richGeometry.chartHeight / chart.props.noOfSections / 2);
      } else {
        const plot = root.container.queryAll((node) => node.props.testID === 'rich-bar-plot')[0];
        assert.equal(plot.props.style.paddingTop, chart.props.stepHeight / 2);
      }
    }
  } finally {
    globalThis.__richChartFontScale = 1;
    await act(async () => { root.unmount(); });
  }
});
