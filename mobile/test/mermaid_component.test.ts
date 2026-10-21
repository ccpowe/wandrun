import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React, { act, createElement } from 'react';
import { createRoot } from 'test-renderer';
import type { Root } from 'test-renderer';
import ts from 'typescript';
import { MAX_ACTIVE_RENDERERS, renderBudget } from '../src/lib/render-budget.ts';
import type { MermaidInput, MermaidPage } from '../src/lib/mermaid-document.ts';

const state = {
  focused: true,
  colors: ['#ffffff', '#111111', '#777777', '#eeeeee', '#dddddd', '#bb3333'],
  pending: [] as { input: MermaidInput; viewport?: { zoom: number; cx: number; cy: number; width: number; height: number }; resolve: (page: MermaidPage) => void }[],
  navigation: [] as { pathname: string; params: Record<string, string> }[],
};
Object.assign(globalThis, { __mermaidReact: React, __mermaidState: state, IS_REACT_ACT_ENVIRONMENT: true });
const hosts: Record<string, string> = {
  'react-native': `
    const React=globalThis.__mermaidReact;
    export function View({ref,...props}) {
      const handle=React.useMemo(()=>({}),[]);
      React.useImperativeHandle(ref,()=>handle,[]);
      return React.createElement('View',props);
    }
    export const ActivityIndicator='ActivityIndicator', Pressable='Pressable', ScrollView='ScrollView';
    export const Platform={OS:'android'};`,
  'react-native-webview': "export default 'WebView';",
  'expo-router': `export const useIsFocused=()=>globalThis.__mermaidState.focused;
    export const router={push:route=>globalThis.__mermaidState.navigation.push(route)};`,
  'uniwind': 'export const useCSSVariable=()=>globalThis.__mermaidState.colors;',
  '@/components/ui/text.tsx': "export const Text='Text';",
  '@/components/ui/button.tsx': "export const Button='Button';",
  '@/components/ui/icon.tsx': "export const Icon='Icon';",
  'lucide-react-native': "export const ArrowLeft='ArrowLeft', Minus='Minus', Plus='Plus', Code2='Code2', Play='Play', RotateCcw='RotateCcw';",
  '@/components/ui/toggle-group.tsx': "export const ToggleGroup='ToggleGroup', ToggleGroupItem='ToggleGroupItem';",
  '@/lib/i18n.ts': 'export const useTranslation=()=>({t:value=>value,language:"zh"});',
  '@/lib/session-context.tsx': 'export const useSession=()=>({api:{config:{computerId:"component-test"}}});',
  './render-visibility.ts': 'export const observeRenderVisibility=(_view,notify)=>{notify(true);return ()=>notify(false);};',
  './math.tsx': "export const RichText='Text';",
  './mermaid-page': `export const prepareMermaidPage=(input,_theme,_computerId,_cached,viewport)=>{
    const {promise,resolve}=Promise.withResolvers();
    globalThis.__mermaidState.pending.push({input,viewport,resolve});
    return promise;
  };`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(hosts, specifier)) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
// The native test hooks must register before this platform module is evaluated;
// a static import would execute before the mocks exist.
const { MermaidDiagram, MermaidViewer, MermaidPicture } = await import('../src/components/rich-message/mermaid.tsx');
const frame = (root: Root) => root.container.queryAll(node => node.type === 'WebView')[0];
const diagram = (source: string) => createElement(MermaidDiagram, { source });
const byId = (root: Root, id: string) => root.container.queryAll(node => node.props.testID === id);
const viewSwitch = (root: Root) => root.container.queryAll(node => node.type === 'ToggleGroup')[0];
async function layout(root: Root) {
  await act(async () => { byId(root, 'mermaid-renderer')[0].props.onLayout({ nativeEvent: { layout: { width: 360, height: 320 } } }); });
}
async function mount(root: Root, source: string) {
  await act(async () => { root.render(diagram(source)); });
  await layout(root);
}
async function complete(index: number, uri: string, disposed: string[]) {
  await act(async () => { state.pending[index].resolve({ source: { uri }, dispose: () => { disposed.push(uri); } }); });
}

test('a tall diagram stays within the chat viewport without recreating its page on parent updates', async () => {
  state.pending = [];
  state.focused = true;
  const disposed: string[] = [];
  const root = createRoot();
  const source = 'flowchart TD\n A[height] --> B[stable]';
  try {
    await mount(root, source);
    assert.equal(state.pending.length, 1);
    await complete(0, 'file:///diagram/height.html', disposed);
    const first = frame(root);
    await act(async () => { first.props.onMessage({ nativeEvent: { data: JSON.stringify({
      kind: 'render', svg: '<svg viewBox="0 0 300 1640"><text>stable</text></svg>', width: 300, height: 1640, displayHeight: 1640,
    }) } }); });
    assert.equal(root.container.queryAll(node => node.props.testID === 'mermaid-ready').length, 1);
    assert.equal(frame(root).props.style.height, 320, 'a tall SVG must not expand the chat card');
    for (let index = 0; index < 4; index++) await act(async () => { root.render(diagram(source)); });
    assert.equal(state.pending.length, 1, 'height/parent updates must not restart the isolated renderer');
    assert.equal(frame(root), first);
    assert.equal(frame(root).props.style.height, 320);
    assert.deepEqual(disposed, []);
  } finally { await act(async () => { root.unmount(); }); }
  assert.deepEqual(disposed, ['file:///diagram/height.html']);
});

test('a page prepared after its source was replaced is disposed and cannot replace the current diagram', async () => {
  state.pending = [];
  state.focused = true;
  const disposed: string[] = [];
  const root = createRoot();
  try {
    await mount(root, 'flowchart TD\n A[late] --> B[old]');
    await act(async () => { root.render(diagram('flowchart TD\n A[current] --> B[new]')); });
    assert.equal(state.pending.length, 2);
    await complete(0, 'file:///diagram/old.html', disposed);
    assert.deepEqual(disposed, ['file:///diagram/old.html']);
    assert.equal(frame(root), undefined);
    await complete(1, 'file:///diagram/new.html', disposed);
    assert.deepEqual(frame(root).props.source, { uri: 'file:///diagram/new.html' });
  } finally { await act(async () => { root.unmount(); }); }
  assert.deepEqual(disposed, ['file:///diagram/old.html', 'file:///diagram/new.html']);
});

test('late events from an unmounted source cannot fail the replacement renderer', async () => {
  state.pending = [];
  state.focused = true;
  const disposed: string[] = [];
  const root = createRoot();
  try {
    await mount(root, 'flowchart TD\n A[before] --> B[change]');
    await complete(0, 'file:///diagram/before.html', disposed);
    const previousMessage = frame(root).props.onMessage;
    await act(async () => { root.render(diagram('flowchart TD\n A[after] --> B[change]')); });
    await complete(1, 'file:///diagram/after.html', disposed);
    await act(async () => { previousMessage({ nativeEvent: { data: '{"kind":"error","code":"syntax"}' } }); });
    assert.deepEqual(frame(root).props.source, { uri: 'file:///diagram/after.html' });
    assert.equal(root.container.queryAll(node => node.props.testID === 'mermaid-error').length, 0);
  } finally { await act(async () => { root.unmount(); }); }
});

test('leaving a route cancels its queued permit; returning prepares it only after capacity is available', async () => {
  state.pending = [];
  state.focused = true;
  const held = Array.from({ length: MAX_ACTIVE_RENDERERS }, () => renderBudget.request(() => {}));
  const disposed: string[] = [];
  const root = createRoot();
  const source = 'flowchart TD\n A[focus] --> B[capacity]';
  try {
    await mount(root, source);
    assert.equal(state.pending.length, 0);
    assert.equal(root.container.queryAll(node => node.props.testID === 'mermaid-waiting').length, 1);
    state.focused = false;
    await act(async () => { root.render(diagram(source)); });
    await act(async () => { held.forEach(release => release()); });
    assert.equal(state.pending.length, 0, 'an unfocused route must not consume newly released capacity');
    state.focused = true;
    await act(async () => { root.render(diagram(source)); });
    assert.equal(state.pending.length, 1);
    assert.equal(root.container.queryAll(node => node.props.testID === 'mermaid-waiting').length, 0);
    await complete(0, 'file:///diagram/focus.html', disposed);
    assert.ok(frame(root));
  } finally {
    await act(async () => { root.unmount(); });
    held.forEach(release => release());
    state.focused = true;
  }
  assert.deepEqual(disposed, ['file:///diagram/focus.html']);
});

test('code view yields its renderer slot and preview rejoins the budget without retaining a hidden frame', async () => {
  state.pending = [];
  state.focused = true;
  const disposed: string[] = [];
  const root = createRoot();
  const held = Array.from({ length: MAX_ACTIVE_RENDERERS - 1 }, () => renderBudget.request(() => {}));
  let nextGranted = false;
  let releaseNext = () => {};
  try {
    await act(async () => { root.render(createElement(MermaidViewer, { source: 'flowchart TD\n A[code] --> B[preview]' })); });
    await act(async () => { root.container.queryAll(node => node.props.testID === 'mermaid-renderer')[0].props.onLayout({
      nativeEvent: { layout: { width: 360, height: 320 } },
    }); });
    await complete(0, 'file:///diagram/view-switch.html', disposed);
    assert.ok(frame(root));
    releaseNext = renderBudget.request(() => { nextGranted = true; });
    assert.equal(nextGranted, false);
    await act(async () => { viewSwitch(root).props.onValueChange('code'); });
    assert.equal(frame(root), undefined);
    assert.equal(nextGranted, true, 'code view must make capacity available to another visible block');
    assert.deepEqual(disposed, ['file:///diagram/view-switch.html']);
    await act(async () => { viewSwitch(root).props.onValueChange('preview'); });
    assert.equal(frame(root), undefined, 'returning to preview must not bypass the four-renderer budget');
    assert.equal(state.pending.length, 1);
    await act(async () => { releaseNext(); });
    assert.equal(state.pending.length, 2);
    assert.equal(state.pending[1].viewport, undefined, 'inline returns to fit, never an interactive viewport');
    await complete(1, 'file:///diagram/view-return.html', disposed);
    assert.ok(frame(root));
  } finally {
    await act(async () => { root.unmount(); });
    releaseNext();
    held.forEach(release => release());
  }
  assert.deepEqual(disposed, ['file:///diagram/view-switch.html', 'file:///diagram/view-return.html']);
});

test('inline preview is the only full-screen target, including while renderer capacity is exhausted', async () => {
  state.pending = [];
  state.navigation = [];
  state.focused = true;
  const held = Array.from({ length: MAX_ACTIVE_RENDERERS }, () => renderBudget.request(() => {}));
  const root = createRoot();
  const source = 'flowchart LR\n A --> B';
  try {
    await act(async () => { root.render(createElement(MermaidPicture, {
      title: 'Release map', source,
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    await layout(root);
    assert.equal(state.pending.length, 0);
    assert.equal(byId(root, 'mermaid-waiting').length, 1);
    assert.equal(byId(root, 'mermaid-preview-open').length, 1);
    assert.equal(byId(root, 'mermaid-zoom-in').length, 0);
    assert.equal(byId(root, 'mermaid-reset').length, 0);
    assert.equal(byId(root, 'mermaid-open-full').length, 0);
    const open = byId(root, 'mermaid-preview-open')[0];
    assert.equal(open.props.accessibilityRole, 'button');
    await act(async () => { open.props.onPress({ nativeEvent: {} }); });
    assert.equal(state.navigation.length, 1);
    assert.equal(state.navigation[0].pathname, '/media-viewer');
    await act(async () => { viewSwitch(root).props.onValueChange('code'); });
    assert.equal(byId(root, 'mermaid-preview-open').length, 0);
    assert.equal(byId(root, 'rich-mermaid-source').length, 1);
    assert.equal(root.container.queryAll(node => node.type === 'Text' && node.props.selectable).length, 1);
    assert.equal(state.navigation.length, 1, 'source and header never navigate');
    await act(async () => { viewSwitch(root).props.onValueChange('preview'); });
    assert.equal(byId(root, 'mermaid-preview-open').length, 1);
  } finally {
    await act(async () => { root.unmount(); });
    held.forEach(release => release());
  }
});

test('inline preview without a valid opener stays static; renderer errors expose source instead', async () => {
  state.pending = [];
  state.focused = true;
  const disposed: string[] = [];
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MermaidPicture, { source: 'flowchart TD\n A --> B' })); });
    await layout(root);
    assert.equal(byId(root, 'mermaid-preview-open').length, 0);
    await act(async () => { root.render(createElement(MermaidPicture, {
      source: 'flowchart TD\n A --> B',
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    assert.equal(byId(root, 'mermaid-preview-open').length, 1);
    await complete(0, 'file:///diagram/invalid.html', disposed);
    await act(async () => { frame(root).props.onMessage({ nativeEvent: { data: '{"kind":"error","code":"syntax"}' } }); });
    assert.equal(byId(root, 'mermaid-preview-open').length, 0);
    assert.equal(byId(root, 'rich-mermaid-source').length, 1);
    assert.equal(byId(root, 'mermaid-view-preview')[0].props.disabled, true);
  } finally { await act(async () => { root.unmount(); }); }
  assert.deepEqual(disposed, ['file:///diagram/invalid.html']);
});

test('pinches, dragged touches and cancelled presses do not open preview, while fresh taps and accessibility clicks do', async () => {
  state.navigation = [];
  state.focused = true;
  const root = createRoot();
  const event = (x: number, y: number, count: number) => ({
    nativeEvent: { pageX: x, pageY: y, touches: Array.from({ length: count }, () => ({})) },
  });
  try {
    await act(async () => { root.render(createElement(MermaidPicture, {
      source: 'flowchart TD\n A --> B',
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    const open = byId(root, 'mermaid-preview-open')[0];
    await act(async () => {
      open.props.onTouchStart(event(30, 30, 1));
      open.props.onTouchStart(event(30, 30, 2));
      open.props.onTouchMove(event(30, 30, 1));
      open.props.onPress(event(30, 30, 0));
    });
    assert.equal(state.navigation.length, 0, 'lifting one pinch finger must not become a tap');
    await act(async () => {
      open.props.onTouchStart(event(30, 30, 1));
      open.props.onTouchMove(event(30, 60, 1));
      open.props.onPress(event(30, 60, 0));
    });
    assert.equal(state.navigation.length, 0, 'a drag ending inside the preview is not a tap');
    await act(async () => {
      open.props.onTouchStart(event(30, 30, 1));
      open.props.onPress({ nativeEvent: {
        pageX: 30, pageY: 60, touches: [], changedTouches: [{ pageX: 30, pageY: 60 }],
      } });
      open.props.onTouchEnd({ nativeEvent: {
        pageX: 30, pageY: 60, touches: [], changedTouches: [{ pageX: 30, pageY: 60 }],
      } });
    });
    assert.equal(state.navigation.length, 0, 'a native release far from the start is rejected even if onPress precedes touch end');
    await act(async () => {
      open.props.onTouchStart(event(30, 30, 1));
      open.props.onTouchCancel();
      open.props.onPress(event(30, 30, 0));
    });
    assert.equal(state.navigation.length, 0);
    await act(async () => { open.props.onPress({ nativeEvent: {} }); });
    assert.equal(state.navigation.length, 1, 'a rejected touch must not suppress a later accessibility click');
    await act(async () => {
      open.props.onTouchStart(event(30, 30, 1));
      open.props.onTouchMove(event(32, 33, 1));
      open.props.onPress(event(32, 33, 0));
    });
    assert.equal(state.navigation.length, 2, 'a fresh single-finger tap remains usable');
  } finally { await act(async () => { root.unmount(); }); }
});

// Browser TouchEvents carry coordinates on their Touch entries, while RN Web's
// subsequent Pressable onPress receives a click with no touches collection.
type WebFinger = { identifier: number; pageX: number; pageY: number; clientX: number; clientY: number };
const webFinger = (identifier: number, x: number, y: number): WebFinger => ({
  identifier, pageX: x, pageY: y, clientX: x, clientY: y,
});
function webTouch(root: Root, phase: 'Start' | 'Move' | 'End', fingers: WebFinger[], changed: WebFinger[]) {
  byId(root, 'mermaid-preview-open')[0].props[`onTouch${phase}`]?.({ nativeEvent: {
    type: `touch${phase.toLowerCase()}`, touches: fingers, targetTouches: fingers, changedTouches: changed,
  } });
}
const webClick = (pointerType: string, detail: number, firesTouchEvents: boolean) => ({
  nativeEvent: { type: 'click', pointerType, detail, sourceCapabilities: { firesTouchEvents } },
});

test('web pinch followed by a compatibility click does not open fullscreen', async () => {
  state.navigation = [];
  state.focused = true;
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MermaidPicture, {
      source: 'flowchart TD\n A --> B',
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    const open = byId(root, 'mermaid-preview-open')[0];
    const first = webFinger(1, 30, 30);
    const second = webFinger(2, 45, 30);
    await act(async () => {
      webTouch(root, 'Start', [first], [first]);
      webTouch(root, 'Start', [first, second], [second]);
      webTouch(root, 'End', [first], [second]);
      webTouch(root, 'End', [], [first]);
      open.props.onPress({ nativeEvent: { type: 'click', detail: 1, sourceCapabilities: { firesTouchEvents: true } } });
    });
    assert.equal(state.navigation.length, 0, 'releasing a pinch must not navigate on its browser click');
  } finally { await act(async () => { root.unmount(); }); }
});

test('web drag followed by a compatibility click does not open fullscreen', async () => {
  state.navigation = [];
  state.focused = true;
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MermaidPicture, {
      source: 'flowchart TD\n A --> B',
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    const open = byId(root, 'mermaid-preview-open')[0];
    const start = webFinger(1, 30, 30);
    const moved = webFinger(1, 30, 60);
    await act(async () => {
      webTouch(root, 'Start', [start], [start]);
      webTouch(root, 'Move', [moved], [moved]);
      webTouch(root, 'End', [], [moved]);
      open.props.onPress(webClick('touch', 1, false));
    });
    assert.equal(state.navigation.length, 0, 'moving beyond tap distance must not navigate on its browser click');
    await act(async () => {
      webTouch(root, 'Start', [start], [start]);
      webTouch(root, 'End', [], [moved]);
      open.props.onPress(webClick('touch', 1, false));
    });
    assert.equal(state.navigation.length, 0, 'a distant release also rejects a tap without an intermediate move');
  } finally { await act(async () => { root.unmount(); }); }
});

test('web pinch followed by an unmarked compatibility click does not open fullscreen', async () => {
  state.navigation = [];
  state.focused = true;
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MermaidPicture, {
      source: 'flowchart TD\n A --> B',
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    const open = byId(root, 'mermaid-preview-open')[0];
    const first = webFinger(1, 30, 30);
    const second = webFinger(2, 45, 30);
    await act(async () => {
      webTouch(root, 'Start', [first], [first]);
      webTouch(root, 'Start', [first, second], [second]);
      webTouch(root, 'End', [first], [second]);
      webTouch(root, 'End', [], [first]);
      open.props.onPress({ nativeEvent: { type: 'click', detail: 1 } });
    });
    assert.equal(state.navigation.length, 0, 'a browser click without touch source fields cannot reopen a rejected pinch');
    await act(async () => { open.props.onPress({ nativeEvent: { type: 'click', detail: 1 } }); });
    assert.equal(state.navigation.length, 1, 'consuming the rejected touch must not suppress an independent later click');
  } finally { await act(async () => { root.unmount(); }); }
});

test('web drag followed by an unmarked compatibility click does not open fullscreen', async () => {
  state.navigation = [];
  state.focused = true;
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MermaidPicture, {
      source: 'flowchart TD\n A --> B',
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    const open = byId(root, 'mermaid-preview-open')[0];
    const start = webFinger(1, 30, 30);
    const moved = webFinger(1, 30, 60);
    await act(async () => {
      webTouch(root, 'Start', [start], [start]);
      webTouch(root, 'Move', [moved], [moved]);
      webTouch(root, 'End', [], [moved]);
      open.props.onPress({ nativeEvent: { type: 'click', detail: 1 } });
    });
    assert.equal(state.navigation.length, 0, 'a browser click without touch source fields cannot reopen a rejected drag');
  } finally { await act(async () => { root.unmount(); }); }
});

test('web single taps open once and rejected touches do not poison mouse or keyboard activation', async () => {
  state.navigation = [];
  state.focused = true;
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MermaidPicture, {
      source: 'flowchart TD\n A --> B',
      location: { conversationId: 'chat-1', messageSeq: 5, block: 0, element: 'nodes', index: 2 },
    })); });
    const open = byId(root, 'mermaid-preview-open')[0];
    const start = webFinger(1, 30, 30);
    const end = webFinger(1, 33, 34);
    await act(async () => {
      webTouch(root, 'Start', [start], [start]);
      webTouch(root, 'Move', [end], [end]);
      webTouch(root, 'End', [], [end]);
      open.props.onPress({ nativeEvent: { type: 'click', detail: 1 } });
    });
    assert.equal(state.navigation.length, 1, 'a Web touch tap opens exactly once');
    const second = webFinger(2, 45, 30);
    await act(async () => {
      webTouch(root, 'Start', [start], [start]);
      webTouch(root, 'Start', [start, second], [second]);
      webTouch(root, 'End', [], [start, second]);
      open.props.onPress(webClick('mouse', 1, false));
    });
    assert.equal(state.navigation.length, 2, 'a later real mouse click still opens');
    await act(async () => { open.props.onPress({ nativeEvent: { type: 'keyup', key: 'Enter' } }); });
    assert.equal(state.navigation.length, 3, 'keyboard activation still opens');
    await act(async () => { open.props.onPress(webClick('', 0, false)); });
    assert.equal(state.navigation.length, 4, 'accessibility activation still opens');
  } finally { await act(async () => { root.unmount(); }); }
});

test('only fullscreen records viewport events and restores its own zoom after toggling code', async () => {
  state.pending = [];
  state.focused = true;
  const disposed: string[] = [];
  const root = createRoot();
  const viewport = { zoom: 2, cx: 150, cy: 75, width: 360, height: 320 };
  try {
    await act(async () => { root.render(createElement(MermaidViewer, { source: 'flowchart TD\n A --> B', full: true })); });
    assert.equal(viewSwitch(root).props.value, 'preview');
    assert.equal(byId(root, 'mermaid-preview-open').length, 0);
    await layout(root);
    assert.equal(state.pending[0].input.full, true);
    assert.equal(state.pending[0].viewport, undefined);
    await complete(0, 'file:///diagram/full.html', disposed);
    await act(async () => { frame(root).props.onMessage({ nativeEvent: { data: JSON.stringify({ kind: 'viewport', viewport }) } }); });
    assert.equal(byId(root, 'mermaid-full-reset').length, 1);
    await act(async () => { viewSwitch(root).props.onValueChange('code'); });
    assert.equal(frame(root), undefined);
    await act(async () => { viewSwitch(root).props.onValueChange('preview'); });
    assert.deepEqual(state.pending[1].viewport, viewport);
    await complete(1, 'file:///diagram/full-return.html', disposed);
  } finally { await act(async () => { root.unmount(); }); }
  assert.deepEqual(disposed, ['file:///diagram/full.html', 'file:///diagram/full-return.html']);
});

test('inline renderer ignores even well-formed viewport reports', async () => {
  state.pending = [];
  state.focused = true;
  const disposed: string[] = [];
  const statuses: unknown[] = [];
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(MermaidDiagram, {
      source: 'flowchart TD\n A --> B', onStatus: (status: unknown) => statuses.push(status),
    })); });
    await layout(root);
    await complete(0, 'file:///diagram/static.html', disposed);
    await act(async () => { frame(root).props.onMessage({ nativeEvent: { data: JSON.stringify({
      kind: 'viewport', viewport: { zoom: 2, cx: 10, cy: 10, width: 360, height: 320 },
    }) } }); });
    assert.deepEqual(statuses, []);
    assert.equal(state.pending[0].viewport, undefined);
  } finally { await act(async () => { root.unmount(); }); }
  assert.deepEqual(disposed, ['file:///diagram/static.html']);
});
