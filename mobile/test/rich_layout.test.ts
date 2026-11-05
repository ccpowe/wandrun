import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { act, createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createRoot, type TestInstance } from 'test-renderer';
import ts from 'typescript';
import { fractionWidth, gridChildWidth, gridMinimumWidth, metricColumns, readableColumns, scrollChildWidth } from '../src/components/rich-message/layout.ts';
import { richGeometry, richRadius, richSpace } from '../src/components/rich-message/tokens.ts';
import Yoga, { type Node as YogaNode } from 'yoga-layout';
import { applyLanguage } from '../src/lib/locale-store.ts';

test('column minimums govern phones, tablet, nesting and increased text scale', () => {
  for (const available of [289, 290, 320, 360, 390]) {
    for (const requested of [2, 3]) assert.deepEqual(readableColumns(available, requested, 280), { columns: 1, width: available });
    const metrics = readableColumns(available, 4, 140);
    assert.equal(metrics.columns, 2);
    assert.equal(metrics.width * 2 + richSpace.sm, available);
  }
  for (const [available, expected] of [[567, 1], [568, 2], [768, 2], [855, 2], [856, 3], [1024, 3]]) {
    const layout = readableColumns(available, 3, 280);
    assert.equal(layout.columns, expected);
    assert.ok(layout.width >= 280);
    assert.equal(layout.width * layout.columns + (layout.columns - 1) * richSpace.sm, available);
  }
  assert.equal(readableColumns(768, 4, 140).columns, 4);
  assert.equal(readableColumns(768, 3, 280, 1.5).columns, 1);
  assert.equal(readableColumns(240, 4, 140).columns, 1);
});

test('Grid reserves wide columns for nested media, charts and tables, not short cards', () => {
  const elements = {
    root: { type: 'Grid', children: ['card'] },
    card: { type: 'Card', children: ['content'] },
    content: { type: 'Text' },
  };
  assert.equal(gridMinimumWidth(elements, 'root'), 96);
  for (const type of ['LineChart', 'BarChart', 'PieChart', 'Mermaid', 'Table', 'Image', 'MediaCard', 'Gallery']) {
    assert.equal(gridMinimumWidth({ ...elements, content: { type } }, 'root'), 280);
  }
  assert.equal(readableColumns(350, 3, gridMinimumWidth(elements, 'root')).columns, 3);
});

test('Metrics balances three on a phone and four in two full rows, respecting large text', () => {
  for (const width of [304, 320, 350, 380]) {
    assert.equal(metricColumns(width, 3).columns, 3);
    assert.equal(metricColumns(width, 4).columns, 2);
  }
  assert.equal(metricColumns(300, 3).columns, 2);
  assert.equal(metricColumns(350, 3, 1.5).columns, 2);
  assert.equal(metricColumns(350, 3, 2).columns, 1);
  assert.equal(metricColumns(768, 4).columns, 4);
});

test('Stack.layout / Grid.layout: proportional widths share gutters and yield to readable minimums', () => {
  for (const width of [280, 320, 349.7142857, 768]) {
    const gap = richSpace.sm;
    assert.ok(Math.abs(fractionWidth(width, gap, '1/2') * 2 + gap - width) < 1e-8);
    assert.ok(Math.abs(fractionWidth(width, gap, '1/3') + fractionWidth(width, gap, '2/3') + gap - width) < 1e-8);
    assert.equal(gridChildWidth(width, 3, 280, 1, '1/3'), 280);
    assert.equal(gridChildWidth(width, 3, 280, 2, '1/3'), Math.min(width, 560));
    assert.equal(gridChildWidth(width, 3, 96, 1, 'auto'), readableColumns(width, 3, 96).width);
  }
});

test('ScrollRow.fits / .overflow: default and fraction widths leave a real next-item glimpse', () => {
  for (const available of [280, 320, 768]) {
    for (const gap of [0, richSpace.sm, richSpace.md, richSpace.lg]) {
      const full = scrollChildWidth(available, gap);
      assert.ok(full < available && full * 2 + gap > available);
      const half = scrollChildWidth(available, gap, '1/2');
      assert.equal(available - (half * 2 + gap * 2), richSpace.lg, 'the gutter must not erase the next-card glimpse');
      assert.ok(half * 3 + gap * 2 > available);
      assert.equal(scrollChildWidth(available, gap, 'auto'), full);
    }
  }
});

declare global {
  var __richOpenedUrl: string;
  var __richFieldStore: { state: Record<string, unknown>; set: (path: string, value: unknown) => void };
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const exportsAsHosts = (names: string[]) => names.map((name) => `export const ${name} = '${name}';`).join('\n');
const hosts: Record<string, string> = {
  '@/components/chat/drawer-horizontal-gesture.tsx': 'export const DrawerHorizontalGesture=({children})=>children; export const DrawerNativeControlGesture=({children})=>children;',
  'react-native': `${exportsAsHosts(['View', 'Pressable', 'ScrollView'])}
    export const Platform = { OS: 'android' };
    export const useWindowDimensions = () => ({ fontScale: 1 });
    export const Linking = { openURL: async url => { globalThis.__richOpenedUrl = url; } };`,
  '@json-render/core': 'export const defineCatalog = (_schema, catalog) => catalog;',
  '@json-render/react-native': 'export const defineRegistry = (_catalog, config) => ({ registry: config.components }); export const useStateStore = () => globalThis.__richFieldStore;',
  '@json-render/react-native/schema': 'export const schema = {};',
  '@react-native-community/slider': "export default 'Slider';",
  '@react-native-community/datetimepicker': "export default 'DateTimePicker'; export const DateTimePickerAndroid = {};",
  '@rn-primitives/select': exportsAsHosts(['Item', 'ItemText', 'ItemIndicator']),
  // Single names resolve to distinct surface colors so tests can tell which surface a fade ends on.
  'uniwind': "export const useCSSVariable = (name) => Array.isArray(name) ? [] : ({ '--color-card': '#FFFFFF', '--color-background': '#FAFAF9' })[name] ?? '';",
  'expo-linear-gradient': "export const LinearGradient = 'LinearGradient';",
  'lucide-react-native': exportsAsHosts(['CalendarDays', 'Check', 'ChevronDown', 'ChevronUp', 'ExternalLink', 'ArrowUpRight', 'Info', 'CircleCheck', 'TriangleAlert', 'CircleAlert', 'X']),
  './media.tsx': exportsAsHosts(['MediaCard', 'MediaGallery', 'MediaPicture', 'LinkThumbnail']),
  './file-tree.tsx': exportsAsHosts(['FileTreeDisplay']),
  './mermaid.tsx': exportsAsHosts(['MermaidPicture']),
  './math.tsx': "export const RichText = 'Text'; export const RichMath = 'Math';",
  './icons.tsx': 'export const richIcons = {};',
  './charts.tsx': exportsAsHosts(['RichLineChart', 'RichBarChart', 'RichPieChart']),
  './actions.tsx': exportsAsHosts(['CopyAction', 'FollowUpsDisplay']),
  './semantic-colors.ts': 'export const useRichColors = () => ({});',
};
const uiNames = ['Badge', 'Accordion', 'AccordionContent', 'AccordionItem', 'AccordionTrigger', 'Button', 'Card', 'Checkbox', 'Icon', 'Input', 'Progress', 'RadioGroup', 'RadioGroupItem', 'Separator', 'Select', 'SelectContent', 'SelectTrigger', 'Switch', 'Text', 'Textarea', 'Tabs', 'TabsList', 'TabsTrigger', 'ToggleGroup', 'ToggleGroupItem', 'SurfacePressable'];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = specifier.startsWith('@/components/ui/') ? exportsAsHosts(uiNames) : hosts[specifier];
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
// Native dependencies must be replaced before loading the registry; static import runs before hooks.
const { richRegistry } = await import('../src/components/rich-message/registry.tsx');
const components = richRegistry as unknown as Record<string, ComponentType<{ props: Record<string, unknown>; children?: ReactNode }>>;

test('vertical Stack auto retains measured Metrics beside default and fractional children', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const MetricItem: ComponentType<{ element: { width?: string }; label: string }> = ({ label }) =>
    createElement(components.Metrics, { props: { items: [{ label, value: '28' }] } });
  try {
    await act(async () => { root.render(createElement(components.Stack, { props: {} },
      createElement(MetricItem, { key: 'default', element: {}, label: '默认指标' }),
      createElement(MetricItem, { key: 'auto', element: { width: 'auto' }, label: '自动指标' }),
      createElement(MetricItem, { key: 'half', element: { width: '1/2' }, label: '半宽指标' }))); });
    const stack = root.container.queryAll(node => node.props.testID === 'rich-stack')[0];
    await act(async () => { stack.props.onLayout({ nativeEvent: { layout: { width: 320 } } }); });
    const metrics: { view: TestInstance; node: YogaNode }[] = [];
    const initialLayout = (view: TestInstance): YogaNode => {
      const node = Yoga.Node.create();
      if (view.props.onLayout && view.props.testID !== 'rich-stack') metrics.push({ view, node });
      const style = view.props.style ?? {};
      if (style.width !== undefined) node.setWidth(style.width);
      if (style.flexShrink !== undefined) node.setFlexShrink(style.flexShrink);
      if (style.alignSelf === 'flex-start') node.setAlignSelf(Yoga.ALIGN_FLEX_START);
      if (style.gap !== undefined) node.setGap(Yoga.GUTTER_ALL, style.gap);
      for (const child of view.children) {
        if (typeof child !== 'string') node.insertChild(initialLayout(child), node.getChildCount());
      }
      return node;
    };
    const layout = initialLayout(stack);
    try {
      layout.setWidth(320);
      layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
      const widths = metrics.map(metric => metric.node.getComputedWidth());
      assert.deepEqual(widths, [320, 320, 160]);
      await act(async () => {
        metrics.forEach((metric, index) => metric.view.props.onLayout({ nativeEvent: { layout: { width: widths[index] } } }));
      });
      for (const [index, label] of ['默认指标', '自动指标', '半宽指标'].entries()) {
        const text = metrics[index].view.queryAll(node => node.type === 'Text').map(node => node.props.children);
        assert.ok(text.includes(label) && text.includes('28'), `${label} must render its real value after native measurement`);
      }
    } finally { layout.freeRecursive(); }
  } finally { await act(async () => { root.unmount(); }); }
});

test('Stack fractions keep their row and proportions across native rounding and intrinsic-width mixing', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    for (const pattern of [['1/2', '1/2'], ['2/3', '1/3'], ['auto', '1/2', '1/3']] as const) {
      for (const [gapName, gap] of [['none', 0], ['sm', richSpace.sm], ['md', richSpace.md], ['lg', richSpace.lg]] as const) {
        await act(async () => { root.render(createElement(components.Stack, { props: { direction: 'horizontal', wrap: true, gap: gapName } },
          pattern.map((width, index) => createElement('Text', { key: index, element: { width },
            style: width === 'auto' ? { width: 40 } : undefined }, `项${index}`)))); });
        const stack = root.container.queryAll(node => node.props.testID === 'rich-stack')[0];
        for (const width of [320, 349.7142857, 350.095238, 768]) {
          await act(async () => { stack.props.onLayout({ nativeEvent: { layout: { width } } }); });
          const layout = Yoga.Node.create();
          try {
            layout.setWidth(width - 0.15);
            layout.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
            layout.setFlexWrap(Yoga.WRAP_WRAP);
            layout.setGap(Yoga.GUTTER_ALL, gap);
            for (const child of stack.children) {
              if (typeof child === 'string') continue;
              const node = Yoga.Node.create();
              const style = child.props.style;
              if (style.width !== undefined) node.setWidth(style.width);
              if (style.flexBasis !== undefined) node.setFlexBasis(style.flexBasis);
              if (style.flexGrow !== undefined) node.setFlexGrow(style.flexGrow);
              if (style.flexShrink !== undefined) node.setFlexShrink(style.flexShrink);
              if (style.maxWidth !== undefined) node.setMaxWidth(style.maxWidth);
              node.setHeight(44);
              layout.insertChild(node, layout.getChildCount());
            }
            layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
            const cells = pattern.map((_, index) => layout.getChild(index).getComputedLayout());
            assert.ok(cells.every(cell => cell.top === 0), `${pattern} at ${width}/${gapName} wrapped early`);
            assert.ok(cells.every(cell => cell.left + cell.width <= width + 1));
            pattern.forEach((fraction, index) => {
              const expected = fraction === 'auto' ? 40 : (width + gap) * (fraction === '1/2' ? 1 / 2 : fraction === '1/3' ? 1 / 3 : 2 / 3) - gap;
              // The floor + 1 layout margin and Yoga's pixel rounding may leave up to 3 units of slack.
              assert.ok(Math.abs(cells[index].width - expected) <= 3, `${fraction} at ${width}/${gapName}: ${cells[index].width} instead of ${expected}`);
            });
          } finally { layout.freeRecursive(); }
        }
      }
    }
  } finally { await act(async () => { root.unmount(); }); }
});

test('Grid wraps stable cells at the readable minimum without fractional-width early wrapping', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    for (const minimum of [96, 280]) {
      await act(async () => { root.render(createElement(components.Grid, {
        props: { columns: 3, __minimumWidth: minimum },
      }, ['A', 'B', 'C', 'D', 'E'].map((text) => createElement('Text', { key: text }, text)))); });
      for (const width of [320, 349.7142857, 350.095238, 360, 390, 568, 768, 1024, 320]) {
        await act(async () => { root.container.queryAll((node) => !!node.props.onLayout)[0].props.onLayout({ nativeEvent: { layout: { width } } }); });
        const grid = root.container.queryAll(node => !!node.props.onLayout)[0];
        assert.equal(grid.props.style.flexWrap, 'wrap');
        assert.equal(grid.props.style.gap, richSpace.sm);
        const columns = readableColumns(width, 3, minimum).columns;
        const cells = grid.queryAll(node => node.props.style?.flexBasis !== undefined);
        assert.equal(cells.length, 5);
        const layout = Yoga.Node.create();
        try {
          layout.setWidth(width - 0.15); // Native measured width can round up to the physical pixel grid.
          layout.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
          layout.setFlexWrap(Yoga.WRAP_WRAP);
          layout.setGap(Yoga.GUTTER_ALL, richSpace.sm);
          cells.forEach((cell, index) => {
            const node = Yoga.Node.create();
            node.setFlexGrow(cell.props.style.flexGrow);
            node.setFlexShrink(cell.props.style.flexShrink);
            node.setFlexBasis(cell.props.style.flexBasis);
            node.setMinWidth(cell.props.style.minWidth);
            node.setMaxWidth(cell.props.style.maxWidth);
            node.setHeight(44);
            layout.insertChild(node, index);
          });
          layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
          const bounds = cells.map((_, i) => layout.getChild(i).getComputedLayout());
          assert.equal(new Set(bounds.map(cell => cell.top)).size, Math.ceil(cells.length / columns));
          assert.ok(bounds.every(cell => cell.left + cell.width <= width + 1));
          // A partial final row still uses the same column width, not stretched cells.
          assert.ok(Math.max(...bounds.map(cell => cell.width)) - Math.min(...bounds.map(cell => cell.width)) <= 1);
          for (let row = 0; row < Math.ceil(cells.length / columns); row++) {
            const rowCells = bounds.slice(row * columns, (row + 1) * columns);
            assert.ok(rowCells.every(cell => cell.top === rowCells[0].top));
            assert.ok(Math.max(...rowCells.map(cell => cell.width)) - Math.min(...rowCells.map(cell => cell.width)) <= 1);
          }
        } finally { layout.freeRecursive(); }
      }
    }
  } finally { await act(async () => { root.unmount(); }); }
});

test('Grid column changes keep the actual Accordion local open state mounted', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => { root.render(createElement(components.Grid, { props: { columns: 2, __minimumWidth: 280 } },
      ['First', 'Second'].map(title => createElement(components.Accordion, { key: title, props: { title } },
        createElement('Text', null, `${title} content`))))); });
    const resize = async (width: number) => {
      await act(async () => { root.container.queryAll(node => !!node.props.onLayout)[0].props.onLayout({ nativeEvent: { layout: { width } } }); });
    };
    await resize(350);
    const accordions = () => root.container.queryAll(node => node.type === 'Accordion');
    assert.deepEqual(accordions().map(node => node.props.value), ['', '']);
    await act(async () => { accordions()[0].props.onValueChange('content'); });
    assert.deepEqual(accordions().map(node => node.props.value), ['content', '']);
    await resize(600);
    assert.deepEqual(accordions().map(node => node.props.value), ['content', '']);
    await resize(350);
    assert.deepEqual(accordions().map(node => node.props.value), ['content', '']);
    await act(async () => { accordions()[0].props.onValueChange(''); });
    assert.deepEqual(accordions().map(node => node.props.value), ['', '']);
  } finally { await act(async () => { root.unmount(); }); }
});

test('native Metrics rows fill fractional phone widths without wrapping or leaving a half-width last row', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    for (const count of [3, 4, 5]) {
      await act(async () => { root.render(createElement(components.Metrics, {
        props: { items: Array.from({ length: count }, (_, i) => ({ label: `指标${i}`, value: String(i) })) },
      })); });
      for (const width of [320, 349.7142857, 350.095238, 380]) {
        await act(async () => { root.container.queryAll(node => !!node.props.onLayout)[0].props.onLayout({ nativeEvent: { layout: { width } } }); });
        const rows = root.container.queryAll(node => node.props.style?.flexDirection === 'row');
        // A+ metrics have no tiles; columns are separated by the larger lg gap (ADR-0081).
        assert.ok(rows.every(row => row.props.style.gap === richSpace.lg));
        assert.equal(rows.length, Math.ceil(count / metricColumns(width, count).columns));
        for (const row of rows) {
          const layout = Yoga.Node.create();
          try {
            layout.setWidth(width - 0.15); // Native measured width can round up to the physical pixel grid.
            layout.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
            layout.setGap(Yoga.GUTTER_ALL, row.props.style.gap);
            const cells = row.queryAll(node => node.props.style?.flex === 1);
            cells.forEach((cell, index) => {
              const node = Yoga.Node.create();
              node.setFlex(cell.props.style.flex);
              node.setMinWidth(cell.props.style.minWidth);
              node.setHeight(60);
              layout.insertChild(node, index);
            });
            layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
            const bounds = cells.map((_, i) => layout.getChild(i).getComputedLayout());
            assert.ok(bounds.every(cell => cell.top === 0));
            assert.ok(Math.max(...bounds.map(cell => cell.width)) - Math.min(...bounds.map(cell => cell.width)) <= 1);
            const last = bounds.at(-1)!;
            assert.ok(Math.abs(last.left + last.width - width) <= 1);
          } finally { layout.freeRecursive(); }
        }
      }
    }
  } finally { await act(async () => { root.unmount(); }); }
});

test('one Source shows its destination without www and opens the exact URL', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const title = '很长的来源标题'.repeat(10);
  const host = `${'verylongdomain'.repeat(4)}.example.com`;
  const url = `https://www.${host}/full/address?query=complete`;
  try {
    await act(async () => { root.render(createElement(components.Source, { props: { items: [{ title, url }] } })); });
    assert.equal(root.container.queryAll(node => node.props.testID === 'rich-source-toggle').length, 0);
    const link = root.container.queryAll(node => node.props.testID === 'rich-source-0')[0];
    assert.equal(link.props.accessibilityRole, 'link');
    assert.ok(link.props.accessibilityLabel.includes(title));
    assert.ok(link.props.accessibilityLabel.includes(url));
    assert.ok(link.queryAll(node => node.type === 'Text').some(node => node.props.children === host));
    await act(async () => { link.props.onPress(); });
    assert.equal(globalThis.__richOpenedUrl, url);
  } finally { await act(async () => { root.unmount(); }); }
});

test('multiple Sources disclose links and retain open state across Grid column changes', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const items = [
    { title: 'Expo', url: 'https://docs.expo.dev/' },
    { title: 'KaTeX', url: 'https://katex.org/docs/options' },
  ];
  try {
    await act(async () => { root.render(createElement(components.Grid, { props: { columns: 2, __minimumWidth: 280 } },
      createElement(components.Source, { props: { items } }))); });
    const toggle = () => root.container.queryAll(node => node.props.testID === 'rich-source-toggle')[0];
    const rows = () => root.container.queryAll(node => /^rich-source-\d+$/.test(String(node.props.testID ?? '')));
    const resize = async (width: number) => {
      await act(async () => { root.container.queryAll(node => !!node.props.onLayout)[0].props.onLayout({ nativeEvent: { layout: { width } } }); });
    };
    await resize(350);
    assert.equal(toggle().props.accessibilityRole, 'button');
    assert.equal(toggle().props.accessibilityState.expanded, false);
    assert.equal(rows().length, 0);
    await act(async () => { toggle().props.onPress(); });
    assert.equal(toggle().props.accessibilityState.expanded, true);
    assert.deepEqual(rows().map(node => node.props.testID), ['rich-source-0', 'rich-source-1']);
    assert.ok(rows()[1].props.accessibilityLabel.includes(items[1].url));
    await resize(600);
    assert.equal(toggle().props.accessibilityState.expanded, true);
    assert.equal(rows().length, 2);
    await resize(350);
    assert.equal(toggle().props.accessibilityState.expanded, true);
    assert.equal(rows().length, 2);
    await act(async () => { toggle().props.onPress(); });
    assert.equal(toggle().props.accessibilityState.expanded, false);
    assert.equal(rows().length, 0);
  } finally { await act(async () => { root.unmount(); }); }
});

test('Source summary shows only the first three distinct sites, not one mark per URL', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const urls = ['https://www.dpm.org.cn/one', 'https://dpm.org.cn/two',
    'https://commons.wikimedia.org/image', 'https://creativecommons.org/license', 'https://example.com/'];
  try {
    await act(async () => { root.render(createElement(components.Source, {
      props: { items: urls.map(url => ({ url })) },
    })); });
    const toggle = root.container.queryAll(node => node.props.testID === 'rich-source-toggle')[0];
    const initials = toggle.queryAll(node => node.type === 'Text' && typeof node.props.children === 'string' && node.props.children.length === 1);
    assert.deepEqual(initials.map(node => node.props.children), ['D', 'W', 'C']);
    await act(async () => { toggle.props.onPress(); });
    assert.equal(root.container.queryAll(node => /^rich-source-\d+$/.test(String(node.props.testID ?? ''))).length, urls.length);
  } finally { await act(async () => { root.unmount(); }); }
});

test('Source cards overflow a narrow rail without shrinking or wrapping to another row', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => { root.render(createElement(components.Source, { props: { items: [
      { url: 'https://www.dpm.org.cn/' }, { url: 'https://commons.wikimedia.org/' }, { url: 'https://katex.org/' },
    ] } })); });
    await act(async () => { root.container.queryAll(node => node.props.testID === 'rich-source-toggle')[0].props.onPress(); });
    const rail = root.container.queryAll(node => node.props.testID === 'rich-source-rail')[0];
    const cards = rail.queryAll(node => /^rich-source-\d+$/.test(String(node.props.testID ?? '')));
    for (const width of [280, 320, 360]) {
      const layout = Yoga.Node.create();
      try {
        layout.setWidth(width);
        layout.setFlexDirection(rail.props.horizontal ? Yoga.FLEX_DIRECTION_ROW : Yoga.FLEX_DIRECTION_COLUMN);
        layout.setGap(Yoga.GUTTER_ALL, rail.props.contentContainerStyle.gap);
        cards.forEach((card, index) => {
          const node = Yoga.Node.create();
          node.setWidth(card.props.style.width);
          node.setFlexShrink(card.props.style.flexShrink);
          node.setMinHeight(card.props.style.minHeight);
          layout.insertChild(node, index);
        });
        layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
        const bounds = cards.map((_, index) => layout.getChild(index).getComputedLayout());
        assert.equal(new Set(bounds.map(card => card.top)).size, 1);
        assert.ok(bounds.every(card => card.height >= 44));
        assert.ok(bounds.at(-1)!.left + bounds.at(-1)!.width > width);
      } finally { layout.freeRecursive(); }
    }
  } finally { await act(async () => { root.unmount(); }); }
});

test('Steps keeps long notes below labels in a shrinkable column, not beside them', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const note = '先确认备份已经完成，再逐项检查原文件与归档记录，避免删除仍在使用的文件。';
  try {
    await act(async () => { root.render(createElement(components.Steps, { props: { items: [{ label: '核验', note, state: 'todo' }] } })); });
    const column = root.container.queryAll((node) => node.type === 'View' && node.props.className === 'min-w-0 flex-1' && node.props.style?.gap === richSpace.xs)[0];
    const text = column.queryAll((node) => node.type === 'Text').map((node) => node.props.children);
    assert.deepEqual(text, ['核验', note]);
  } finally { await act(async () => { root.unmount(); }); }
});

test('Steps renders a non-interactive numbered rail with localized progress and failure states', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const items = [
    { label: 'Build', state: 'done' },
    { label: 'Deploy', state: 'current', note: 'Wait for every service to pass its health check before continuing.' },
    { label: 'Sync', state: 'failed' },
    { label: 'Verify', state: 'todo' },
    { label: 'Finish', state: 'done' },
  ];
  try {
    await act(async () => { root.render(createElement(components.Steps, { props: { items } })); });
    const rows = () => root.container.queryAll(node => node.type === 'View' && node.props.accessible === true);
    assert.deepEqual(rows().map(row => row.props.accessibilityLabel), [
      '第 1 步，Build，已完成', '第 2 步，Deploy，进行中', '第 3 步，Sync，失败',
      '第 4 步，Verify，未开始', '第 5 步，Finish，已完成',
    ]);
    const connectors = root.container.queryAll(node => node.props.testID === 'rich-step-connector');
    assert.deepEqual(connectors.map(node => node.props.className), [
      'absolute bg-foreground', 'absolute bg-border',
      'absolute bg-border', 'absolute bg-border',
    ]);
    assert.equal(rows().at(-1)!.queryAll(node => node.props.testID === 'rich-step-connector').length, 0);
    const glyphs = (index: number) => rows()[index].queryAll(node => node.type === 'Text').map(node => node.props.children);
    assert.deepEqual(glyphs(1), [2, 'Deploy', items[1].note]);
    assert.deepEqual(glyphs(2), ['!', 'Sync']);
    assert.deepEqual(glyphs(3), [4, 'Verify']);
    assert.equal(rows()[1].queryAll(node => node.type === 'Text' && node.props.children === 'Deploy')[0].props.style[1].fontWeight, '500'); // Steps.current: medium label
    assert.equal(root.container.queryAll(node => ['radio', 'button', 'radiogroup'].includes(node.props.accessibilityRole ?? node.props.role) || !!node.props.onPress).length, 0);
    await act(async () => { applyLanguage('en'); });
    assert.deepEqual(rows().map(row => row.props.accessibilityLabel), [
      'Step 1, Build, Completed', 'Step 2, Deploy, In progress', 'Step 3, Sync, Failed',
      'Step 4, Verify, Not started', 'Step 5, Finish, Completed',
    ]);
    await act(async () => { root.render(createElement(components.Steps, { props: { items: [items[0]] } })); });
    assert.equal(root.container.queryAll(node => node.props.testID === 'rich-step-connector').length, 0);
  } finally { await act(async () => { root.unmount(); applyLanguage('zh'); }); }
});

test('Select clears only an existing value and removes its clear action afterward', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  globalThis.__richFieldStore = { state: { choice: 'a' }, set: (path, value) => { globalThis.__richFieldStore.state[path.slice(1)] = value; } };
  const render = () => createElement(components.Select, { props: {
    stateKey: 'choice', label: '选择', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }],
  } });
  try {
    await act(async () => { root.render(render()); });
    const clear = root.container.queryAll(node => node.props.testID === 'rich-select-choice-clear')[0];
    // Foundation 48 target (design §3.4), placed left of the trigger's chevron.
    assert.equal(clear.props.style.width, 48);
    assert.equal(clear.props.style.height, 48);
    const trigger = root.container.queryAll(node => node.props.testID === 'rich-select-choice')[0];
    assert.equal(trigger.props.tone, 'muted');
    assert.ok(clear.props.accessibilityLabel);
    await act(async () => { clear.props.onPress(); root.render(render()); });
    assert.equal(globalThis.__richFieldStore.state.choice, '');
    assert.equal(root.container.queryAll(node => node.props.testID === 'rich-select-choice-clear').length, 0);
  } finally { await act(async () => { root.unmount(); }); }
});

test('compact and descriptive choices both preserve selection and disabled options', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  globalThis.__richFieldStore = { state: { choice: '' }, set: (path, value) => { globalThis.__richFieldStore.state[path.slice(1)] = value; } };
  try {
    for (const description of [undefined, '说明']) {
      await act(async () => { root.render(createElement(components.ChoiceGroup, { props: {
        stateKey: 'choice', options: [{ value: 'a', label: '甲', description }, { value: 'b', label: '乙', disabled: true }],
      } })); });
      const choices = root.container.queryAll(node => node.props.accessibilityRole === 'radio');
      assert.equal(choices.length, 2);
      assert.ok(choices.every(choice => choice.props.style.minHeight === 48));
      await act(async () => { choices[0].props.onPress(); choices[1].props.onPress(); });
      assert.equal(globalThis.__richFieldStore.state.choice, 'a');
      assert.equal(choices[1].props.accessibilityState.disabled, true);
    }
  } finally { await act(async () => { root.unmount(); }); }
});

test('MultiSelect announces checked state: chips use primary/soft intents, checklist rows are the checkbox', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  globalThis.__richFieldStore = { state: { picks: ['a'] }, set: (path, value) => { globalThis.__richFieldStore.state[path.slice(1)] = value; } };
  const options = [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }];
  try {
    await act(async () => { root.render(createElement(components.MultiSelect, { props: { stateKey: 'picks', label: '选', variant: 'chips', options } })); });
    const chips = root.container.queryAll(node => node.props.role === 'checkbox');
    assert.deepEqual(chips.map(chip => [chip.props.intent, chip.props.accessibilityState.checked]), [['primary', true], ['soft', false]]);
    await act(async () => { root.render(createElement(components.MultiSelect, { props: { stateKey: 'picks', label: '选', variant: 'checklist', options } })); });
    const rows = root.container.queryAll(node => node.props.role === 'checkbox' && node.type === 'SurfacePressable');
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.props.style.minHeight === 48));
    await act(async () => { rows[1].props.onPress(); });
    assert.deepEqual(globalThis.__richFieldStore.state.picks, ['a', 'b']);
  } finally { await act(async () => { root.unmount(); }); }
});

test('Segmented options reach a 48 target: 42 visual block plus hitSlop over the 3px track padding', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  globalThis.__richFieldStore = { state: { length: 'short' }, set: (path, value) => { globalThis.__richFieldStore.state[path.slice(1)] = value; } };
  try {
    await act(async () => { root.render(createElement(components.Segmented, { props: {
      stateKey: 'length', label: '篇幅', options: [{ value: 'short', label: '简短' }, { value: 'long', label: '详细' }],
    } })); });
    const track = root.container.queryAll(node => node.type === 'ToggleGroup')[0];
    const items = root.container.queryAll(node => node.type === 'ToggleGroupItem');
    assert.equal(items.length, 2);
    for (const item of items) {
      const { top, bottom } = item.props.hitSlop;
      // The slop must stay inside the track padding so neighbours never overlap and the whole 48 is tappable.
      assert.equal(item.props.style.minHeight + top + bottom, 48);
      assert.ok(top <= track.props.style.padding && bottom <= track.props.style.padding);
    }
    assert.equal(track.props.style.minHeight, 48);
  } finally { await act(async () => { root.unmount(); }); }
});

test('Tabs activates only the selected panel in equal-width and scrolling lists', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    for (const count of [2, 4, 5]) {
      await act(async () => { root.render(createElement(components.Tabs, {
        props: { tabs: Array.from({ length: count }, (_, i) => ({ label: `Long tab ${i}` })) },
      }, Array.from({ length: count }, (_, i) => createElement('Text', { key: i }, `Panel ${i}`)))); });
      await act(async () => { root.container.queryAll(node => node.type === 'Tabs')[0].props.onValueChange(String(count - 1)); });
      const visible = root.container.queryAll(node => node.props.role === 'tabpanel' && node.props.style.display !== 'none');
      assert.equal(visible.length, 1);
      assert.ok(String(visible[0].props.nativeID).endsWith(`-panel-${count - 1}`));
    }
  } finally { await act(async () => { root.unmount(); }); }
});

test('Table fade ends on the surface it sits on: card inside a framed block, page background elsewhere', async () => {
  const { RichFramedContext } = await import('../src/components/rich-message/framed-context.ts');
  const root = createRoot({ textComponentTypes: ['Text'] });
  const wide = { columns: ['一', '二', '三', '四', '五'], rows: [['1', '2', '3', '4', '5']] };
  const fadeEnd = async (framed: boolean) => {
    await act(async () => { root.render(createElement(RichFramedContext.Provider, { value: framed }, createElement(components.Table, { props: wide }))); });
    await act(async () => { root.container.queryAll(node => !!node.props.onLayout)[0].props.onLayout({ nativeEvent: { layout: { width: 320 } } }); });
    const fade = root.container.queryAll(node => node.props.testID === 'rich-table-fade')[0];
    return fade.props.colors as string[];
  };
  try {
    assert.deepEqual(await fadeEnd(true), ['#FFFFFF00', '#FFFFFF']);
    assert.deepEqual(await fadeEnd(false), ['#FAFAF900', '#FAFAF9']);
  } finally { await act(async () => { root.unmount(); }); }
});

test('Table.fits / Table.overflow: the right-edge fade marks horizontal overflow until the end is reached', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  const fade = () => root.container.queryAll(node => node.props.testID === 'rich-table-fade').length;
  const layout = (width: number) => root.container.queryAll(node => !!node.props.onLayout)[0].props.onLayout({ nativeEvent: { layout: { width } } });
  try {
    const narrow = { columns: ['甲', '乙'], rows: [['1', '2']] };
    await act(async () => { root.render(createElement(components.Table, { props: narrow })); });
    await act(async () => { layout(320); });
    assert.equal(fade(), 0, 'two 160pt columns fit without a fade');
    const wide = { columns: ['一', '二', '三', '四', '五'], rows: [['1', '2', '3', '4', '5']] };
    await act(async () => { root.render(createElement(components.Table, { props: wide })); });
    await act(async () => { layout(320); });
    assert.equal(fade(), 1, 'five 80pt minimum columns overflow 320');
    const scroll = root.container.queryAll(node => node.type === 'ScrollView')[0];
    const at = (x: number) => ({ nativeEvent: { contentOffset: { x }, layoutMeasurement: { width: 320 }, contentSize: { width: 400 } } });
    await act(async () => { scroll.props.onScroll(at(80)); });
    assert.equal(fade(), 0, 'the fade hides at the end');
    await act(async () => { scroll.props.onScroll(at(20)); });
    assert.equal(fade(), 1, 'scrolling back shows it again');
  } finally { await act(async () => { root.unmount(); }); }
});

test('Grid.layout actual declared child widths make a 2/3 + 1/3 row without merging or overflow', async () => {
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => { root.render(createElement(components.Grid, { props: { columns: 3 } },
      createElement('Text', { key: 'wide', element: { type: 'StatCard', width: '2/3' } }, '宽项'),
      createElement('Text', { key: 'narrow', element: { type: 'StatCard', width: '1/3' } }, '窄项'))); });
    for (const width of [320, 349.7142857, 768]) {
      await act(async () => { root.container.queryAll(node => !!node.props.onLayout)[0].props.onLayout({ nativeEvent: { layout: { width } } }); });
      const cells = root.container.queryAll(node => node.props.style?.flexBasis !== undefined);
      const layout = Yoga.Node.create();
      try {
        layout.setWidth(width - 0.15);
        layout.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
        layout.setFlexWrap(Yoga.WRAP_WRAP);
        layout.setGap(Yoga.GUTTER_ALL, richSpace.sm);
        for (const [index, cell] of cells.entries()) {
          const node = Yoga.Node.create();
          node.setFlexBasis(cell.props.style.flexBasis);
          node.setFlexGrow(cell.props.style.flexGrow);
          node.setMaxWidth(cell.props.style.maxWidth);
          node.setHeight(48);
          layout.insertChild(node, index);
        }
        layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
        const [wide, narrow] = [layout.getChild(0).getComputedLayout(), layout.getChild(1).getComputedLayout()];
        assert.equal(wide.top, narrow.top);
        assert.ok(wide.width > narrow.width * 1.9);
        assert.ok(narrow.left + narrow.width <= width + 1);
      } finally { layout.freeRecursive(); }
    }
  } finally { await act(async () => { root.unmount(); }); }
});
