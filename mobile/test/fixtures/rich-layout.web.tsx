import '../../global.css';
import { createRoot } from 'react-dom/client';
import { Dimensions, View } from 'react-native';
import { RichBlock } from '../../src/components/rich-message/block.tsx';
import { RichLineChart } from '../../src/components/rich-message/charts.tsx';
import { richSpace, richType } from '../../src/components/rich-message/tokens.ts';
import { AgentMessageContent } from '../../src/components/chat/agent-message-content.tsx';
import { ChatSession } from '../../src/gateway/session.ts';

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
async function runChatCodeLayout(width: number, lines: number) {
  Dimensions.get('window').fontScale = 1;
  fontStyle.textContent = '';
  const code = Array.from({ length: lines }, (_, i) =>
    `${String(i).padStart(3, ' ')}    src/${'column_'.repeat(24)}    // aligned`).join('\n');
  root.render(<View key={`code-${width}-${lines}`} testID="chat-code-fixture" style={{ width }}>
    <AgentMessageContent text={'Before `inline`.\n\n```text\n' + code + '\n```\n\nAfter.'} onSubmit={async () => {}} />
  </View>);
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const frame = document.querySelector('[data-testid="chat-code-fixture"]') as HTMLElement | null;
    const scroll = frame?.querySelector('[data-testid="markdown-code-scroll"]') as HTMLElement | null;
    const text = scroll?.querySelector('[data-testid="markdown-code-text"]') as HTMLElement | null;
    if (!frame || !scroll || !text || text.textContent !== code || Math.abs(frame.getBoundingClientRect().width - width) > 1) continue;
    const style = getComputedStyle(text);
    const expectedHeight = lines * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    scroll.scrollLeft = scroll.scrollWidth;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const inline = [...frame.querySelectorAll('*')].find(node => node.childElementCount === 0 && node.textContent === 'inline');
    return { kind: 'chat-code', width, lines, viewportWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth,
      scrollLeft: scroll.scrollLeft, codeHeight: text.getBoundingClientRect().height, expectedHeight,
      frameScrollWidth: frame.scrollWidth, inlineOutsideScroll: !!inline && !scroll.contains(inline), fontFamily: style.fontFamily };
  }
  throw new Error(`Chat code did not settle: ${width}/${lines}: ${document.body.textContent}`);
}

/** Exercise real grouping and measured row adaptation inside the unchanged Grid policy. */
async function runLinkLayout(kind: 'link-grid' | 'link-card' | 'link-stack' | 'link-mixed' | 'link-list', width: number) {
  Dimensions.get('window').fontScale = 1;
  fontStyle.textContent = '';
  const nested = kind === 'link-card' || kind === 'link-stack';
  const source = JSON.stringify({ root: 'layout', state: {}, elements: {
    layout: { type: kind === 'link-list' ? 'Stack' : 'Grid', props: kind === 'link-list' ? {} : { columns: 3 },
      children: nested ? ['nested'] : kind === 'link-mixed' ? ['first', 'second', 'text', 'third'] : ['first', 'second'] },
    ...(nested ? { nested: { type: kind === 'link-card' ? 'Card' : 'Stack', props: {}, children: ['first', 'second'] } } : {}),
    first: { type: 'LinkCard', props: { title: 'React Native 官方教程', url: 'https://reactnative.dev/',
      description: '学习组件状态与界面布局。' }, children: [] },
    second: { type: 'LinkCard', props: { title: 'Expo Router 文档', url: 'https://docs.expo.dev/',
      description: '路由组织与导航边界。' }, children: [] },
    ...(kind === 'link-mixed' ? {
      text: { type: 'Text', props: { text: '分组间隔' }, children: [] },
      third: { type: 'LinkCard', props: { title: '独立链接', url: 'https://example.org/' }, children: [] },
    } : {}),
  } });
  root.render(<View key={`${kind}-${width}`} style={{ width }}><RichBlock source={source} onSubmit={async () => {}} /></View>);
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
    const block = document.querySelector('[data-testid="rich-block"]');
    const rows = [...document.querySelectorAll('[data-testid="rich-link-card"]')];
    if (!block || Math.abs(block.getBoundingClientRect().width - width) > 1 || rows.length !== (kind === 'link-mixed' ? 3 : 2)) continue;
    const measured = rows.map(row => ({
      bounds: row.getBoundingClientRect().toJSON(),
      text: row.lastElementChild!.getBoundingClientRect().toJSON(),
      thumbnail: row.querySelector('[data-testid="rich-link-thumbnail"]')?.getBoundingClientRect().toJSON() ?? null,
      scrollWidth: row.scrollWidth,
    }));
    if (measured.some(row => row.bounds.width <= 0 || !!row.thumbnail !== (row.bounds.width >= 238))) continue;
    return { kind, width, links: measured,
      groups: [...block.querySelectorAll('[data-testid="rich-link-list"]')].map(group =>
        [...group.querySelectorAll('[data-testid="rich-link-card"]')].map(row => parseFloat(getComputedStyle(row).borderTopWidth))) };
  }
  throw new Error(`Link layout did not settle: ${kind}/${width}: ${document.body.textContent}`);
}

async function runLinkTitleLayout(width: number) {
  Dimensions.get('window').fontScale = 1;
  fontStyle.textContent = '';
  const captions = ['Expo 入门教程', 'React Native 核心组件与 API', 'Expo Notifications'];
  const source = JSON.stringify({ root: 'list', state: {}, elements: {
    list: { type: 'Stack', props: {}, children: captions.map((_, index) => `link${index}`) },
    ...Object.fromEntries(captions.map((title, index) => [`link${index}`, {
      type: 'LinkCard', props: { title, url: 'https://docs.expo.dev/' }, children: [],
    }])),
  } });
  root.render(<View key={`titles-${width}`} style={{ width }}><RichBlock source={source} onSubmit={async () => {}} /></View>);
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
    const rows = [...document.querySelectorAll('[data-testid="rich-link-card"]')];
    if (rows.length !== captions.length || rows.some(row => Math.abs(row.getBoundingClientRect().width - width) > 1 ||
      !!row.querySelector('[data-testid="rich-link-thumbnail"]') !== (width >= 238))) continue;
    return { kind: 'link-titles', width, titles: rows.map((row, index) => {
      const title = row.lastElementChild!.firstElementChild!;
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let last: DOMRect | undefined;
      let arrow: DOMRect | undefined;
      let arrowUnderline = '';
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent!;
        const lastOffset = captions[index].length - 1 - offset;
        if (lastOffset >= 0 && lastOffset < text.length) {
          const range = document.createRange();
          range.setStart(node, lastOffset);
          range.setEnd(node, lastOffset + 1);
          last = range.getBoundingClientRect();
        }
        const arrowOffset = text.indexOf('↗');
        if (arrowOffset >= 0) {
          const range = document.createRange();
          range.setStart(node, arrowOffset);
          range.setEnd(node, arrowOffset + 1);
          arrow = range.getBoundingClientRect();
          arrowUnderline = getComputedStyle(node.parentElement!).textDecorationLine;
        }
        offset += text.length;
      }
      return { caption: captions[index], text: title.textContent, last: last?.toJSON(),
        arrow: arrow?.toJSON() ?? title.querySelector('svg')?.getBoundingClientRect().toJSON(), arrowUnderline,
        underlinedText: [...title.querySelectorAll('*')].filter(node => getComputedStyle(node).textDecorationLine === 'underline')
          .map(node => node.textContent).join(''),
        embeddedViews: title.querySelectorAll('div, svg').length };
    }) };
  }
  throw new Error(`Link title layout did not settle at ${width}`);
}

/** The HTTP fixture serves distinct authenticated images, so real Renderer coordinates determine pixels. */
async function runLinkThumbnailLayout() {
  Dimensions.get('window').fontScale = 1;
  fontStyle.textContent = '';
  const session = new ChatSession({ baseUrl: location.origin, token: 'thumbnail-test', computerId: 'thumbnail-test' });
  const source = JSON.stringify({ root: 'list', state: {}, elements: {
    list: { type: 'Stack', props: {}, children: ['one', 'card', 'missing'] },
    one: { type: 'LinkCard', props: { title: 'Website icon', url: 'https://source.invalid/one' }, children: [] },
    card: { type: 'Card', props: {}, children: ['two'] },
    two: { type: 'LinkCard', props: { title: 'Explicit image', url: 'https://source.invalid/two', image: 'https://source.invalid/provided.png' }, children: [] },
    missing: { type: 'LinkCard', props: { title: 'Icon unavailable', url: 'https://source.invalid/missing' }, children: [] },
  } });
  const message = '```wandrun-ui\n{invalid}\n```\n\n```wandrun-ui\n' + source + '\n```\n\n```wandrun-ui\n' + source;
  root.render(<View key="link-thumbnail-fixture" style={{ width: 358 }}>
    <AgentMessageContent text={message} onSubmit={async () => {}}
      draftOwner={{ session, conversationId: 'thumbnails', messageSeq: 7 }} />
  </View>);
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    await promise;
    const rows = [...document.querySelectorAll('[data-testid="rich-link-card"]')];
    const images = rows.map(row => row.querySelector('img'));
    if (rows.length !== 3 || !images[0]?.complete || !images[0].naturalWidth ||
        !images[1]?.complete || !images[1].naturalWidth || images[2]) continue;
    if (images.slice(0, 2).some(image => {
      let opacity = 1;
      for (let node: HTMLElement | null = image; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity < 0.99;
    })) continue;
    const colors = images.slice(0, 2).map(image => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.drawImage(image!, image!.naturalWidth / 2, image!.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    const explicit = images[1].getBoundingClientRect();
    return { kind: 'link-thumbnails', width: 358, colors,
      fallback: rows[2].querySelector('[data-testid="rich-link-thumbnail"]')?.textContent,
      explicitSamples: [{ x: explicit.left + 8, y: explicit.top + explicit.height / 2 },
        { x: explicit.right - 8, y: explicit.top + explicit.height / 2 }] };
  }
  throw new Error(`Link thumbnails did not decode distinct images: ${document.body.textContent}`);
}

Object.assign(window, { runLayoutCase, runReviewLayout, runChatCodeLayout, runLinkLayout, runLinkTitleLayout, runLinkThumbnailLayout });
