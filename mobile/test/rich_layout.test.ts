import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { act, createElement } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { createRoot } from 'test-renderer';
import ts from 'typescript';
import { gridMinimumWidth, metricColumns, readableColumns } from '../src/components/rich-message/layout.ts';
import { richGeometry, richRadius, richSpace } from '../src/components/rich-message/tokens.ts';
import Yoga from 'yoga-layout';
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

declare global {
  var __richOpenedUrl: string;
  var __richFieldStore: { state: Record<string, unknown>; set: (path: string, value: unknown) => void };
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const exportsAsHosts = (names: string[]) => names.map((name) => `export const ${name} = '${name}';`).join('\n');
const hosts: Record<string, string> = {
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
  'uniwind': 'export const useCSSVariable = () => [];',
  'lucide-react-native': exportsAsHosts(['CalendarDays', 'Check', 'ChevronDown', 'ChevronUp', 'ExternalLink', 'Info', 'CircleCheck', 'TriangleAlert', 'CircleAlert', 'X']),
  './media.tsx': exportsAsHosts(['MediaCard', 'MediaGallery', 'MediaPicture']),
  './mermaid.tsx': exportsAsHosts(['MermaidPicture']),
  './math.tsx': "export const RichText = 'Text'; export const RichMath = 'Math';",
  './icons.tsx': 'export const richIcons = {};',
  './charts.tsx': exportsAsHosts(['RichLineChart', 'RichBarChart', 'RichPieChart']),
  './semantic-colors.ts': 'export const useRichColors = () => ({});',
};
const uiNames = ['Badge', 'Accordion', 'AccordionContent', 'AccordionItem', 'AccordionTrigger', 'Button', 'Card', 'Checkbox', 'Icon', 'Input', 'Progress', 'RadioGroup', 'RadioGroupItem', 'Separator', 'Select', 'SelectContent', 'SelectTrigger', 'Switch', 'Text', 'Textarea', 'Tabs', 'TabsList', 'TabsTrigger', 'ToggleGroup', 'ToggleGroupItem'];
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
        assert.ok(rows.every(row => row.props.style.gap === richSpace.sm));
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
      'absolute border-l border-foreground', 'absolute border-l border-border',
      'absolute border-l border-border', 'absolute border-l border-border',
    ]);
    assert.equal(rows().at(-1)!.queryAll(node => node.props.testID === 'rich-step-connector').length, 0);
    const glyphs = (index: number) => rows()[index].queryAll(node => node.type === 'Text').map(node => node.props.children);
    assert.deepEqual(glyphs(1), [2, 'Deploy', items[1].note]);
    assert.deepEqual(glyphs(2), ['!', 'Sync']);
    assert.deepEqual(glyphs(3), [4, 'Verify']);
    assert.equal(rows()[1].queryAll(node => node.type === 'Text' && node.props.children === 'Deploy')[0].props.style.fontWeight, '600');
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
    assert.equal(clear.props.style.width, richGeometry.touch);
    assert.equal(clear.props.style.height, richGeometry.touch);
    assert.equal(clear.props.style.right, richSpace.lg + richSpace.md);
    const trigger = root.container.queryAll(node => node.props.testID === 'rich-select-choice')[0];
    assert.equal(trigger.props.style.minHeight, richGeometry.touch);
    assert.equal(trigger.props.style.borderRadius, richRadius.medium);
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
      const choices = root.container.queryAll(node => node.type === 'Pressable');
      assert.ok(choices.every(choice => choice.props.style.minHeight === richGeometry.touch));
      await act(async () => { choices[0].props.onPress(); choices[1].props.onPress(); });
      assert.equal(globalThis.__richFieldStore.state.choice, 'a');
      assert.equal(choices[1].props.accessibilityState.disabled, true);
    }
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
