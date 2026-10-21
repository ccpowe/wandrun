import '../../global.css';
import { createRoot } from 'react-dom/client';
import { Dimensions, View } from 'react-native';
import { RichBlock } from '../../src/components/rich-message/block.tsx';
import { RichLineChart } from '../../src/components/rich-message/charts.tsx';
import { richSpace, richType } from '../../src/components/rich-message/tokens.ts';

const root = createRoot(document.getElementById('root')!);
const fontStyle = document.createElement('style');
document.head.append(fontStyle);
const metricsSpec = JSON.stringify({ root: 'row', state: {}, elements: {
  row: { type: 'Stack', props: { direction: 'horizontal' }, children: ['text', 'metrics'] },
  text: { type: 'Text', props: { text: '状态' }, children: [] },
  metrics: { type: 'Metrics', props: { items: [
    { label: '已完成', value: '12' }, { label: '失败', value: '1' },
  ] }, children: [] },
} });
const longLabels = ['二零二六年第一季度第一阶段统计结果', '二零二六年第二季度第二阶段统计结果'];

// RN Web does not apply native fontScale to Text. Emulate that text size in CSS;
// the real browser still wraps text and RN Web produces every onLayout callback.
async function runLayoutCase(kind: 'metrics' | 'labels' | 'extreme' | 'heading', width: number, fontScale: number) {
  Dimensions.get('window').fontScale = fontScale;
  fontStyle.textContent = `[data-testid^="rich-line-label-"] { font-size: ${richType.subtle.fontSize * fontScale}px !important; line-height: ${richType.subtle.lineHeight * fontScale}px !important; }`;
  root.render(kind === 'metrics'
    ? <View style={{ width }}><RichBlock source={metricsSpec} onSubmit={async () => {}} /></View>
    : kind === 'heading'
      ? <View key={fontScale} style={{ width }}>
        <RichLineChart props={{ title: '趋势', xLabels: ['一', '二'], series: [{ name: '原始值', values: [50, 200] }] }} />
      </View>
      : <View key={fontScale} style={{ flexDirection: 'row', width: width * 2 + richSpace.sm, gap: richSpace.sm }}>
        {(kind === 'extreme'
          ? [[Number.MAX_VALUE, -Number.MAX_VALUE], [-Number.MAX_VALUE, -1e308]]
          : [longLabels, ['早', '晚']]).map((labels, index) => <View key={index} style={{ width }}>
          <RichLineChart props={{ title: `趋势 ${index}`,
            xLabels: kind === 'extreme' ? ['早', '晚'] : labels as string[],
            series: [{ name: '原始值', values: kind === 'extreme' ? labels as number[] : [1000000, 1000001] }] }} />
        </View>)}
      </View>);
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const block = document.querySelector('[data-testid="rich-block"]');
    const charts = [...document.querySelectorAll('[data-testid="rich-line-chart"]')];
    const ready = kind === 'metrics'
      ? block?.textContent?.includes('已完成') && block?.textContent?.includes('失败')
      : charts.length === (kind === 'heading' ? 1 : 2) && charts.every((chart) =>
        chart.querySelector('[data-testid="rich-line-label-1"]') && Math.abs(chart.getBoundingClientRect().width - width) < 1);
    if (!ready) continue;
    // Let ResizeObserver/onLayout updates and the resulting React commit settle.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (kind === 'metrics') {
      const labels = [...block!.querySelectorAll('div')].filter((element) => element.childElementCount === 0 && ['已完成', '失败'].includes(element.textContent ?? ''));
      const container = labels[0].parentElement!.parentElement!;
      return { kind, width, measuredWidth: container.getBoundingClientRect().width,
        text: container.textContent, cells: labels.map((label) => label.parentElement!.getBoundingClientRect().toJSON()) };
    }
    if (kind === 'heading') {
      const chart = charts[0];
      const toggle = chart.querySelector('[data-testid="rich-line-points-toggle"]')!;
      const plot = chart.querySelector('[data-testid="rich-line-plot"]')!;
      const wrapper = plot.firstElementChild!;
      const sections = wrapper.firstElementChild!;
      return { kind, width, fontScale, headingBottom: toggle.getBoundingClientRect().bottom,
        plotTop: plot.getBoundingClientRect().top, sectionsTop: sections.getBoundingClientRect().top };
    }
    if (kind === 'extreme') {
      return { kind, width, fontScale, charts: charts.map((chart) => {
        const plot = chart.querySelector('[data-testid="rich-line-plot"]')!;
        const circles = [...plot.querySelectorAll('circle')].map((node) => node.getBoundingClientRect().toJSON());
        return { bounds: chart.getBoundingClientRect().toJSON(), plot: plot.getBoundingClientRect().toJSON(),
          circles, yLabels: [...chart.querySelectorAll('*')].filter((node) => node.childElementCount === 0
            && /^-?\d+(?:\.\d+)?(?:e-?\d+)?$/.test(node.textContent ?? ''))
            .map((node) => node.textContent) };
      }) };
    }
    return { kind, width, fontScale, charts: charts.map((chart) => ({
      bounds: chart.getBoundingClientRect().toJSON(),
      legend: chart.querySelector('[data-testid="rich-line-legend"]')!.getBoundingClientRect().toJSON(),
      labels: [...chart.querySelectorAll('[data-testid^="rich-line-label-"]')].map((label) => ({
        text: label.textContent, bounds: label.getBoundingClientRect().toJSON(), scrollHeight: label.scrollHeight,
      })),
    })) };
  }
  throw new Error(`Layout did not reveal ${kind} at ${width}/${fontScale}: ${document.body.textContent}`);
}

// Review inputs run through the real validator, Grid metadata and renderer, not injected minimums.
async function runReviewLayout(kind: 'tabs' | 'tabs-scroll' | 'source-grid' | 'source-nested', width: number, input?: string) {
  Dimensions.get('window').fontScale = 1;
  fontStyle.textContent = '';
  const count = kind === 'tabs-scroll' ? 5 : 4;
  const nested = kind === 'source-nested';
  const source = input ?? JSON.stringify(kind.startsWith('tabs') ? {
    root: 'tabs', state: {}, elements: {
      tabs: { type: 'Tabs', props: { tabs: Array.from({ length: count }, (_, i) => ({
        label: `选项${i + 1}二零二六年第一季度第一阶段统计结果`,
      })) }, children: Array.from({ length: count }, (_, i) => `panel${i}`) },
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`panel${i}`, {
        type: 'Text', props: { text: `面板${i}` }, children: [],
      }])),
    },
  } : {
    root: 'grid', state: {}, elements: {
      grid: { type: 'Grid', props: { columns: 3 }, children: [nested ? 'card' : 'src', 'text1', 'text2'] },
      ...(nested ? { card: { type: 'Card', props: { title: '嵌套来源' }, children: ['src'] } } : {}),
      src: { type: 'Source', props: { items: [
        { title: 'Expo', url: 'https://docs.expo.dev/' },
        { title: 'KaTeX', url: 'https://katex.org/' },
        { title: 'Wiki', url: 'https://commons.wikimedia.org/' },
      ] }, children: [] },
      text1: { type: 'Text', props: { text: '相邻单元格甲' }, children: [] },
      text2: { type: 'Text', props: { text: '相邻单元格乙' }, children: [] },
    },
  });
  root.render(<View key={kind} style={{ width }}><RichBlock source={source} onSubmit={async () => {}} /></View>);
  const selector = kind.startsWith('tabs') ? '[data-testid="rich-tab-0"]' : '[data-testid="rich-source-toggle"]';
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const block = document.querySelector('[data-testid="rich-block"]');
    if (!block?.querySelector(selector) || Math.abs(block.getBoundingClientRect().width - width) > 1) continue;
    if (kind.startsWith('tabs')) {
      const triggers = [...block.querySelectorAll('[data-testid^="rich-tab-"]')];
      if (triggers.length !== count) continue;
      return { kind, width, tabs: triggers.map(trigger => {
        const pill = trigger.firstElementChild!;
        const label = pill.firstElementChild!;
        return { trigger: trigger.getBoundingClientRect().toJSON(), pill: pill.getBoundingClientRect().toJSON(),
          label: label.getBoundingClientRect().toJSON(), text: label.textContent,
          scrollWidth: label.scrollWidth, lineHeight: parseFloat(getComputedStyle(label).lineHeight) };
      }) };
    }
    const toggle = block.querySelector(selector)!;
    let cell = toggle;
    while (cell.parentElement && getComputedStyle(cell.parentElement).flexWrap !== 'wrap') cell = cell.parentElement;
    const label = toggle.children[1];
    return { kind, width, cell: cell.getBoundingClientRect().toJSON(),
      toggle: toggle.getBoundingClientRect().toJSON(), label: label.getBoundingClientRect().toJSON(),
      lineHeight: parseFloat(getComputedStyle(label).lineHeight),
      arrow: toggle.querySelector('svg')!.getBoundingClientRect().toJSON() };
  }
  throw new Error(`Review layout did not settle: ${kind}/${width}: ${document.body.textContent}`);
}
Object.assign(window, { runLayoutCase, runReviewLayout });
