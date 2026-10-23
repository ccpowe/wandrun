import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React, { act, createContext, createElement } from 'react';
import { createRoot, type Root, type TestInstance } from 'test-renderer';
import Yoga, { type Node as YogaNode } from 'yoga-layout';
import MarkdownIt from 'markdown-it';
import ts from 'typescript';
import type { ChatSession } from '../src/gateway/session.ts';
import { GatewayApi, type AgentMemory } from '../src/gateway/api.ts';
import { parseMessageMarkdown } from '../src/lib/agent-message-markdown.ts';
import { groupSelectableMarkdown } from '../src/lib/selectable-markdown.ts';
const markdownDrawerContext = createContext<object | undefined>(undefined);
Object.assign(globalThis, { __markdownTestReact: React, __markdownDrawerContext: markdownDrawerContext });

// Keep the real Markdown parser, menu/Portal state and placement, and media effects.
// Native host measurement places the message tail at y=1200, outside the viewport.
const hosts: Record<string, string> = {
  'react-native-drawer-layout': 'export const DrawerGestureContext=globalThis.__markdownDrawerContext;',
  'react-native-gesture-handler': `const React=globalThis.__markdownTestReact;
    export const Gesture={Native:()=>({shouldCancelWhenOutside(){return this},disallowInterruption(){return this},blocksExternalGesture(){return this}})};
    export const GestureDetector=({gesture,children})=>React.createElement('GestureDetector',{gesture},children);`,
  'react-native': `export const Text='Text', View='View', ScrollView='ScrollView',
    ActivityIndicator='ActivityIndicator', FlatList='FlatList', TouchableWithoutFeedback='TouchableWithoutFeedback';
    export const Animated={};
    export function Pressable({ref,...props}) {
      const React=globalThis.__markdownTestReact;
      React.useImperativeHandle(ref,()=>({measure:callback=>{
        if(props.testID==='menu-backdrop') callback(0,0,390,800,0,0);
        else callback(0,0,0,0,0,1200);
      }}),[props.testID]);
      return React.createElement('Pressable',props);
    }
    export const StyleSheet={create:x=>x, flatten:x=>Object.assign({},...[x].flat(Infinity).filter(Boolean)),
      absoluteFill:{position:'absolute',top:0,left:0,right:0,bottom:0}};
    export const Platform={get OS(){return globalThis.__textPlatform ?? (globalThis.__nativeMenus?'android':'web')},
      select:x=>x[Platform.OS] ?? x.default};
    export const Linking={openURL:url=>{ globalThis.__openedLinks?.push(url); }};
    export const AccessibilityInfo={announceForAccessibility:()=>{},setAccessibilityFocus:()=>{}}, findNodeHandle=()=>null;
    export const Dimensions={get:()=>({width:390,height:852})};
    export const BackHandler={addEventListener:()=>({remove(){}})};
    export const Alert={alert:(...args)=>{ globalThis.__alerts?.push(args); }};`,
  'expo-clipboard': `export const setStringAsync=async value=>{ globalThis.__copiedLinks?.push(value); return true; };`,
  'lucide-react-native': `export const Copy=()=>null, ExternalLink=Copy, Check=Copy, ChevronDown=Copy, ChevronRight=Copy, ChevronUp=Copy;`,
  'react-native-reanimated': `export const FadeIn={reduceMotion:()=>undefined}, ReduceMotion={System:0};`,
  'react-native-screens': `export const FullWindowOverlay='FullWindowOverlay';`,
  'react-native-safe-area-context': `export const useSafeAreaInsets=()=>({top:24,right:0,bottom:34,left:0});`,
  'react-native-keyboard-controller': `export const useKeyboardState=select=>select({isVisible:false,height:0});`,
  '@/components/ui/native-only-animated-view.tsx': `import {Pressable} from 'react-native';
    export const NativeOnlyAnimatedView=({as,...props})=>globalThis.__markdownTestReact.createElement(Pressable,props);`,
  '@/components/ui/icon.tsx': `export const Icon=()=>null;`,
  'expo-file-system': `export const Directory=class {}, File=class {}; export const Paths={};`,
  'expo-image': `export const Image='ExpoImage';`,
  'expo-router': `export const router={push:()=>{}};`,
  'uniwind': `export const useUniwind=()=>({theme:globalThis.__markdownDark?'dark':'light'});
    export const useCSSVariable=()=>globalThis.__markdownDark?['#eee','#222','#444']:['#111','#eee','#ddd'];`,
  'react-native-fit-image': `export default 'FitImage';`,
  '@/components/ui/text.tsx': `export const Text='Text', TextClassContext=globalThis.__markdownTestReact.createContext(undefined);`,
  '@/components/rich-message/block.tsx': `export const RichBlock=()=>null;`,
  '@/components/rich-message/math.tsx': `export const MathContent='MathContent', RichText='Text';`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    if (specifier === './dropdown-menu' && context.parentURL?.includes('/@rn-primitives/dropdown-menu/')) {
      return nextResolve('./dropdown-menu.mjs', context);
    }
    if (context.parentURL?.includes('/react-native-markdown-display/') && specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL);
      if (existsSync(fileURLToPath(url) + '.js')) return nextResolve(url.href + '.js', context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx') || url.includes('/react-native-markdown-display/') && url.endsWith('.js') ||
        url.includes('/@rn-primitives/') && url.endsWith('.mjs')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        fileName: 'component.tsx',
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});
// Native hosts and JSX transpilation must register before platform imports; static imports run before hooks.
const { AgentMessageContent } = await import('../src/components/chat/agent-message-content.tsx');
const { AgentMemoryMarkdown } = await import('../src/components/agent-memory-markdown.tsx');
const { DraftMessageContent } = await import('../src/components/chat/draft-message-content.tsx');
const { PortalHost } = await import('@rn-primitives/portal');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(globalThis, { __DEV__: false });

function mediaResponse(url: string, width: number, height: number): Response {
  if (url.includes('/content')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  return Response.json({ mime: 'image/png', width, height });
}

test('unrelated chat renders preserve the Markdown image and do not refetch its metadata or bytes', async () => {
  let requests = 0;
  const api = new GatewayApi({ baseUrl: 'https://gateway.invalid', token: 'test', computerId: 'computer-a' }, async (url) => {
    requests++;
    return mediaResponse(String(url), 2400, 600);
  });
  const session = { api } as ChatSession;
  const root = createRoot();
  const render = (messageSeq: number) => createElement(AgentMessageContent, {
    text: 'Before\n\n![diagram](https://images.example/diagram.png)\n\nAfter',
    draftOwner: { session, conversationId: 'conversation', messageSeq },
    onSubmit: async () => {},
  });
  try {
    await act(async () => { root.render(render(1)); });
    const image = root.container.queryAll(node => node.type === 'ExpoImage')[0];
    assert.ok(image);
    assert.equal(requests, 2);
    for (let i = 0; i < 5; i++) await act(async () => { root.render(render(1)); });
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage')[0], image);
    assert.equal(requests, 2);
    await act(async () => { root.render(render(2)); });
    assert.equal(requests, 4, 'a different message must resolve its own authenticated media and bytes');
  } finally {
    await act(async () => { root.unmount(); });
  }
});

// Feed the rendered native ancestor styles to Yoga, not a hand-written approximation
// of flexbox. The image frame's only intrinsic loading width is the native spinner.
function imageLayout(image: TestInstance, availableWidth: number) {
  const ancestors: TestInstance[] = [];
  for (let node: TestInstance | null = image; node?.type; node = node.parent) ancestors.unshift(node);
  const root = Yoga.Node.create();
  root.setWidth(availableWidth);
  let frame: YogaNode = root;
  try {
    for (const host of ancestors) {
      const node = Yoga.Node.create();
      const style = Object.assign({}, ...[host.props.style].flat(Infinity).filter(Boolean));
      if (style.width !== undefined) node.setWidth(style.width);
      if (style.height !== undefined) node.setHeight(style.height);
      if (style.aspectRatio !== undefined) node.setAspectRatio(style.aspectRatio);
      if (style.flexDirection === 'row') node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
      if (style.flexWrap === 'wrap') node.setFlexWrap(Yoga.WRAP_WRAP);
      if (style.alignItems === 'flex-start') node.setAlignItems(Yoga.ALIGN_FLEX_START);
      if (style.alignItems === 'center') node.setAlignItems(Yoga.ALIGN_CENTER);
      frame.insertChild(node, 0);
      frame = node;
    }
    if (image.queryAll(node => node.type === 'ActivityIndicator').length) {
      const spinner = Yoga.Node.create();
      spinner.setWidth(20);
      spinner.setHeight(20);
      frame.insertChild(spinner, 0);
    }
    root.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    return frame.getComputedLayout();
  } finally {
    root.freeRecursive();
  }
}

/** Use the rendered native styles; fixed text measurement isolates horizontal list hierarchy from fonts. */
function markdownLayoutPositions(host: TestInstance) {
  const nodes = new Map<TestInstance, YogaNode>();
  function build(cell: TestInstance): YogaNode {
    const node = Yoga.Node.create();
    nodes.set(cell, node);
    const style = Object.assign({}, ...[cell.props.style].flat(Infinity).filter(Boolean));
    if (style.flexDirection === 'row') node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    if (style.flexWrap === 'wrap') node.setFlexWrap(Yoga.WRAP_WRAP);
    if (style.flex !== undefined) node.setFlex(style.flex);
    if (style.flexShrink !== undefined) node.setFlexShrink(style.flexShrink);
    if (style.width !== undefined) node.setWidth(style.width);
    if (style.height !== undefined) node.setHeight(style.height);
    if (style.minWidth !== undefined) node.setMinWidth(style.minWidth);
    for (const [edge, suffix] of [[Yoga.EDGE_LEFT, 'Left'], [Yoga.EDGE_RIGHT, 'Right']] as const) {
      const margin = style[`margin${suffix}`] ?? style.marginHorizontal ?? style.margin;
      const padding = style[`padding${suffix}`] ?? style.paddingHorizontal ?? style.padding;
      if (margin !== undefined) node.setMargin(edge, margin);
      if (padding !== undefined) node.setPadding(edge, padding);
    }
    if (cell.type === 'Text') node.setMeasureFunc(() => ({ width: 64, height: 22 }));
    else for (const child of cell.children) if (typeof child !== 'string') node.insertChild(build(child), node.getChildCount());
    return node;
  }
  const layout = build(host);
  try {
    layout.setWidth(390);
    layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    return new Map([...nodes].map(([cell, node]) => {
      let left = 0;
      for (let ancestor: YogaNode | null = node; ancestor; ancestor = ancestor.getParent()) left += ancestor.getComputedLeft();
      return [cell, left];
    }));
  } finally { layout.freeRecursive(); }
}

for (const text of [
  '![W3C logo](https://www.w3.org/Icons/w3c_home.png)',
  'Caption: ![W3C logo](https://www.w3.org/Icons/w3c_home.png)',
  '**![W3C logo](https://www.w3.org/Icons/w3c_home.png)**',
  '![W3C logo](https://www.w3.org/Icons/w3c_home.png)\n\n$$x^2$$',
  '$x$ ![W3C logo](https://www.w3.org/Icons/w3c_home.png) $y$',
]) {
  test(`Markdown image uses available width while loading and preserves its ratio: ${text}`, async () => {
    let resolveMetadata!: (response: Response) => void;
    const api = new GatewayApi({ baseUrl: 'https://gateway.invalid', token: 'test', computerId: 'computer-a' }, async (url) =>
      String(url).includes('/content') ? mediaResponse(String(url), 72, 48)
        : new Promise<Response>(resolve => { resolveMetadata = resolve; }));
    const root = createRoot();
    try {
      await act(async () => { root.render(createElement(AgentMessageContent, {
        text, draftOwner: { session: { api } as ChatSession, conversationId: 'conversation', messageSeq: 5 },
        onSubmit: async () => {},
      })); });
      const image = root.container.queryAll(node => node.props.testID === 'media-image')[0];
      assert.ok(image);
      for (const width of [320, 720]) assert.equal(imageLayout(image, width).width, width, 'loading must not shrink to spinner width');
      await act(async () => { resolveMetadata(Response.json({ mime: 'image/png', width: 72, height: 48 })); });
      for (const width of [320, 720]) {
        const layout = imageLayout(image, width);
        assert.equal(layout.width, width);
        assert.ok(Math.abs(layout.height - width * 48 / 72) < 1, 'image height follows intrinsic ratio after resizing');
      }
      assert.equal(root.container.queryAll(node => node.type === 'ExpoImage').length, 1);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
}

test('math and an authenticated image in one paragraph keep source order and survive parent rerenders', async () => {
  let requests = 0;
  const api = new GatewayApi({ baseUrl: 'https://gateway.invalid', token: 'test', computerId: 'computer-a' }, async (url) => {
    requests++;
    return mediaResponse(String(url), 640, 480);
  });
  const session = { api } as ChatSession;
  const root = createRoot();
  const render = (messageSeq: number) => createElement(AgentMessageContent, {
    text: 'Before $x+1$ ![plot](https://images.example/plot.png) after $y^2$',
    draftOwner: { session, conversationId: 'conversation', messageSeq },
    onSubmit: async () => {},
  });
  try {
    await act(async () => { root.render(render(7)); });
    const pieces = root.container.queryAll(node => node.type === 'MathContent' || node.type === 'ExpoImage');
    assert.deepEqual(pieces.map(node => node.type), ['MathContent', 'ExpoImage', 'MathContent']);
    assert.match(String(pieces[0].props.html), /data-tex="x\+1"/);
    assert.match(String(pieces[2].props.html), /data-tex="y\^2"/);
    assert.ok(pieces.every(node => !String(node.props.html ?? '').includes('images.example')));
    assert.equal(requests, 2);
    for (let i = 0; i < 5; i++) await act(async () => { root.render(render(7)); });
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage')[0], pieces[1]);
    assert.equal(requests, 2);
    await act(async () => { root.render(render(8)); });
    assert.equal(requests, 4, 'a new persisted message resolves its own image index');
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('an image-looking expression inside TeX does not shift the following proxied image index', async () => {
  const paths: string[] = [];
  const api = new GatewayApi({ baseUrl: 'https://gateway.invalid', token: 'test', computerId: 'computer-a' }, async (url) => {
    paths.push(String(url));
    return mediaResponse(String(url), 320, 240);
  });
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(AgentMessageContent, {
      text: '$\\text{![not-an-image](https://images.example/fake.png)}$ ![real](https://images.example/real.png)',
      draftOwner: { session: { api } as ChatSession, conversationId: 'conversation', messageSeq: 3 },
      onSubmit: async () => {},
    })); });
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage').length, 1);
    assert.deepEqual(paths, [
      'https://gateway.invalid/conversations/conversation/messages/3/media/markdown/image/0',
      'https://gateway.invalid/conversations/conversation/messages/3/media/markdown/image/0/content',
    ]);
    const math = root.container.queryAll(node => node.type === 'MathContent')[0];
    assert.ok(math);
    assert.ok(!String(math.props.html).includes('<img'));
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('nested media preserves its native structure and formula source; memory remains offline math', async () => {
  const api = new GatewayApi({ baseUrl: 'https://gateway.invalid', token: 'test', computerId: 'computer-a' }, async (url) =>
    mediaResponse(String(url), 320, 240));
  const root = createRoot();
  const text = '- $x$ **![plot](https://images.example/plot.png)**';
  try {
    await act(async () => { root.render(createElement(AgentMessageContent, {
      text, draftOwner: { session: { api } as ChatSession, conversationId: 'conversation', messageSeq: 4 },
      onSubmit: async () => {},
    })); });
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage').length, 1);
    assert.equal(root.container.queryAll(node => node.type === 'MathContent').length, 0);
    assert.ok(root.container.queryAll(node => node.type === 'Text' && node.props.children === '$x$').length);
    await act(async () => { root.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} })); });
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage').length, 0);
    const math = root.container.queryAll(node => node.type === 'MathContent');
    assert.equal(math.length, 1);
    assert.match(String(math[0].props.html), /data-tex="x"/);
    assert.ok(!String(math[0].props.html).includes('<img'));
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('long-press menus follow the touched link, not the distant message tail, while short presses open URLs', async () => {
  const opened: string[] = [];
  const copied: string[] = [];
  Object.assign(globalThis, { __openedLinks: opened, __copiedLinks: copied, __nativeMenus: true });
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement('View', null, createElement(AgentMessageContent, {
      text: 'Read [one](https://example.org/a%20b?q=1&x=2#fragment) and [two](http://example.org/b) or [email](mailto:me@example.org)' +
        '\n\nA long paragraph separating the links from the message tail.'.repeat(50),
      onSubmit: async () => {},
    }), createElement(PortalHost))); });
    const links = root.container.queryAll(node => node.type === 'Text' &&
      node.props.style?.textDecorationLine === 'underline');
    assert.equal(links.length, 3);
    assert.equal(typeof links[2].props.onPress, 'undefined', 'non-web schemes are inert');
    assert.equal(typeof links[2].props.onLongPress, 'undefined');
    assert.ok(root.container.queryAll(node => node.type === 'Text' && node.props.selectable &&
      node.queryAll(child => child.type === 'Text' && child.props.children === 'Read ').length > 0).length,
      'one selectable parent contains the surrounding chat text');

    await act(async () => { links[0].props.onLongPress({ nativeEvent: { pageX: 40, pageY: 200 } }); });
    assert.deepEqual(opened, [], 'long press must not launch the browser');
    const backdrop = root.container.queryAll(node => node.props.testID === 'menu-backdrop')[0];
    let menu = root.container.queryAll(node => node.props.role === 'menu')[0];
    await act(async () => {
      backdrop.props.onLayout();
      menu.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 220, height: 124 } } });
    });
    menu = root.container.queryAll(node => node.props.role === 'menu')[0];
    const placement = Object.assign({}, ...[menu.props.style].flat(Infinity));
    assert.equal(placement.top, 200, 'the menu starts at the link touch, not the tail measured at y=1200');
    assert.equal(placement.left, 40);
    const copy = root.container.queryAll(node => node.props.accessibilityLabel === '复制链接')[0];
    await act(async () => { await copy.props.onPress(); });
    assert.deepEqual(copied, ['https://example.org/a%20b?q=1&x=2#fragment']);
    assert.deepEqual(opened, []);
    assert.equal(root.container.queryAll(node => node.props.role === 'menu').length, 0);

    await act(async () => { links[1].props.onLongPress({ nativeEvent: { pageX: 90, pageY: 360 } }); });
    const secondBackdrop = root.container.queryAll(node => node.props.testID === 'menu-backdrop')[0];
    menu = root.container.queryAll(node => node.props.role === 'menu')[0];
    await act(async () => {
      secondBackdrop.props.onLayout();
      menu.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 220, height: 124 } } });
    });
    menu = root.container.queryAll(node => node.props.role === 'menu')[0];
    assert.equal(Object.assign({}, ...[menu.props.style].flat(Infinity)).top, 360, 'a different link replaces the previous anchor');
    const open = root.container.queryAll(node => node.props.accessibilityLabel === '打开链接')[0];
    await act(async () => { open.props.onPress(); });
    assert.deepEqual(opened, ['http://example.org/b']);
    await act(async () => { links[0].props.onPress(); });
    assert.deepEqual(opened, ['http://example.org/b', 'https://example.org/a%20b?q=1&x=2#fragment']);

    await act(async () => { links[0].props.onLongPress({ nativeEvent: { pageX: 40, pageY: 740 } }); });
    const bottomBackdrop = root.container.queryAll(node => node.props.testID === 'menu-backdrop')[0];
    menu = root.container.queryAll(node => node.props.role === 'menu')[0];
    await act(async () => {
      bottomBackdrop.props.onLayout();
      menu.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 220, height: 124 } } });
    });
    menu = root.container.queryAll(node => node.props.role === 'menu')[0];
    assert.equal(Object.assign({}, ...[menu.props.style].flat(Infinity)).top, 616, 'a low link still uses the shared upward collision placement');
    await act(async () => { bottomBackdrop.props.onPress(); });
    assert.equal(root.container.queryAll(node => node.props.role === 'menu').length, 0, 'the backdrop still dismisses the menu');
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, { __openedLinks: undefined, __copiedLinks: undefined, __nativeMenus: false });
  }
});

test('non-chat Markdown retains its existing link behavior without a link menu', async () => {
  const opened: string[] = [];
  Object.assign(globalThis, { __openedLinks: opened });
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, {
      content: '[site](https://example.org) [email](mailto:me@example.org)',
    })); });
    const links = root.container.queryAll(node => node.type === 'Text' && typeof node.props.onPress === 'function');
    assert.equal(links.length, 2);
    assert.equal(links[0].props.selectable, undefined);
    assert.equal(root.container.queryAll(node => node.props.role === 'menu').length, 0);
    await act(async () => { links[0].props.onPress(); links[1].props.onPress(); });
    assert.deepEqual(opened, ['https://example.org']);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, { __openedLinks: undefined });
  }
});

test('real Markdown renderer routes active links in math lists internally and keeps external/local policy', async () => {
  const path = `/.wandrun/memory/profile/details/topic/${'a'.repeat(64)}.md`;
  const stale = `/.wandrun/memory/profile/details/topic/${'b'.repeat(64)}.md`;
  const memory: AgentMemory = { scope: 'profile', content: '', version: 'v1', limit: 1000,
    updated_at: null, updated_by: null, details: { topic: { path, sha256: 'a'.repeat(64) } } };
  const opened: string[] = [];
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, {
      content: `- [topic](${path} "title") $x$ [web](https://example.org)\n- [stale](${stale}) [local](/etc/passwd)`,
      managedMemory: { memory, onOpen: (slug: string) => opened.push(slug) },
    })); });
    const math = root.container.queryAll(node => node.type === 'MathContent')[0];
    assert.ok(math, 'the math-containing list uses the actual math branch');
    assert.match(math.props.html, new RegExp(`href="${path}"`));
    assert.match(math.props.html, /href="https:\/\/example\.org"/);
    assert.ok(!math.props.html.includes(`href="${stale}"`));
    assert.ok(!math.props.html.includes('href="/etc/passwd"'));
    await act(async () => {
      assert.equal(math.props.onManagedLink(path), true);
      assert.equal(math.props.onManagedLink(stale), false);
      assert.equal(math.props.onManagedLink('/etc/passwd'), false);
      assert.equal(math.props.onManagedLink('https://example.org'), false);
    });
    assert.deepEqual(opened, ['topic']);
  } finally { await act(async () => { root.unmount(); }); }
});

test('memory index rows own only a single active canonical destination, including nested and reference links', async () => {
  const path = `/.wandrun/memory/profile/details/topic/${'a'.repeat(64)}.md`;
  const stale = `/.wandrun/memory/profile/details/topic/${'b'.repeat(64)}.md`;
  const work = `/.wandrun/memory/work/details/topic/${'a'.repeat(64)}.md`;
  const memory: AgentMemory = { scope: 'profile', content: '', version: 'v1', limit: 1000,
    updated_at: null, updated_by: null, details: { topic: { path, sha256: 'a'.repeat(64) } } };
  const opened: string[] = [];
  const external: string[] = [];
  Object.assign(globalThis, { __openedLinks: external });
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, {
      content: `## Group\n- Plain **formatted** [topic][detail] tail\n  - Nested [topic](${path})\n- [topic](${path}) and [web](https://example.org)\n- [stale](${stale})\n- [wrong scope](${work})\n\n[detail]: ${path}`,
      managedMemory: { memory, onOpen: (slug: string) => opened.push(slug) }, memoryIndex: true,
    })); });
    const rows = root.container.queryAll(node => node.props.testID === 'memory-index-detail-topic');
    assert.equal(rows.length, 2, 'only the parent and its independently navigable nested row claim the whole row');
    assert.ok(rows.every(row => row.type === 'Pressable' && row.props.accessibilityRole === 'button'));
    await act(async () => { rows[0].props.onPress(); rows[1].props.onPress(); });
    assert.deepEqual(opened, ['topic', 'topic']);
    const links = root.container.queryAll(node => node.type === 'Text' && typeof node.props.onPress === 'function');
    assert.equal(links.length, 2, 'mixed-target row keeps both destinations; stale and wrong-scope links stay inert');
    await act(async () => { links[0].props.onPress(); links[1].props.onPress(); });
    assert.deepEqual(opened, ['topic', 'topic', 'topic']);
    assert.deepEqual(external, ['https://example.org']);
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, {
      content: `## Group\n- prose [topic](${path})`,
      managedMemory: { memory, onOpen: (slug: string) => opened.push(slug) },
    })); });
    assert.equal(root.container.queryAll(node => node.type === 'Pressable' && node.props.testID?.startsWith('memory-index-detail-')).length, 0);
    const ordinaryLink = root.container.queryAll(node => node.type === 'Text' && typeof node.props.onPress === 'function');
    assert.equal(ordinaryLink.length, 1, 'ordinary memory Markdown keeps link-level navigation');
    await act(async () => { ordinaryLink[0].props.onPress(); });
    assert.deepEqual(opened, ['topic', 'topic', 'topic', 'topic']);
    const workMemory: AgentMemory = { ...memory, scope: 'work',
      details: { topic: { path: work, sha256: 'a'.repeat(64) } } };
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, {
      content: `- [profile](${path})\n- [work](${work})`,
      managedMemory: { memory: workMemory, onOpen: (slug: string) => opened.push(slug) }, memoryIndex: true,
    })); });
    const workRows = root.container.queryAll(node => node.props.testID === 'memory-index-detail-topic');
    assert.equal(workRows.length, 1, 'only the currently active scope can claim a row');
    await act(async () => { workRows[0].props.onPress(); });
    assert.deepEqual(opened, ['topic', 'topic', 'topic', 'topic', 'topic']);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, { __openedLinks: undefined });
  }
});

test('memory index nested rows preserve visible hierarchy and separate parent and child detail targets', async () => {
  const reference = (slug: string) => ({ path: `/.wandrun/memory/work/details/${slug}/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) });
  const memory: AgentMemory = { scope: 'work', agent_id: 'helper', content: '', version: 'v1', limit: 1000,
    updated_at: null, updated_by: null, details: { parent: reference('parent'), child: reference('child') } };
  const opened: string[] = [];
  const root = createRoot();
  try {
    for (const content of [
      '- Parent\n  - Child\n    - Grandchild\n- Sibling',
      `- [Parent](${memory.details.parent.path})\n  - [Child](${memory.details.child.path})\n    - Grandchild\n- Sibling`,
    ]) {
      await act(async () => root.render(createElement(AgentMemoryMarkdown, {
        content, memoryIndex: true, managedMemory: { memory, onOpen: (slug: string) => opened.push(slug) },
      })));
      const positions = markdownLayoutPositions(root.container);
      const left = (label: string) => {
        let cell = root.container.queryAll(node => node.type === 'Text' && node.props.children === label)[0];
        assert.ok(cell, label);
        while (!positions.has(cell)) cell = cell.parent!;
        return positions.get(cell)!;
      };
      assert.equal(left('Parent'), left('Sibling'), 'siblings retain the same level');
      assert.ok(left('Child') > left('Parent'), 'a child is visibly indented from its parent');
      assert.ok(left('Grandchild') > left('Child'), 'each deeper list adds indentation');
    }
    const parent = root.container.queryAll(node => node.props.testID === 'memory-index-detail-parent')[0];
    const child = root.container.queryAll(node => node.props.testID === 'memory-index-detail-child')[0];
    assert.equal(parent.queryAll(node => node === child).length, 0, 'the parent press target excludes the nested child');
    await act(async () => { child.props.onPress(); parent.props.onPress(); });
    assert.deepEqual(opened, ['child', 'parent']);
  } finally { await act(async () => root.unmount()); }
});

for (const content of ['3. Numbered', '- Parent\n\n  - Child\n\n  Continuation']) {
  test(`memory index fallback marker inherits body color and typography: ${content.split('\n')[0]}`, async () => {
    const memory: AgentMemory = { scope: 'profile', content, version: 'v1', limit: 1000,
      updated_at: null, updated_by: null, details: {} };
    const root = createRoot();
    try {
      for (const dark of [false, true]) for (const compact of [false, true]) {
        Object.assign(globalThis, { __markdownDark: dark });
        let ordinaryStyle: Record<string, unknown> = {};
        for (const memoryIndex of [false, true]) {
          await act(async () => root.render(createElement(AgentMemoryMarkdown, {
            content, compact, memoryIndex, managedMemory: { memory, onOpen: () => {} },
          })));
          const marker = root.container.queryAll(node => node.type === 'Text' &&
            (node.props.children === '•' || Array.isArray(node.props.children) && node.props.children.join('') === '3.'))[0];
          assert.ok(marker);
          const markerStyle = Object.assign({}, ...[marker.props.style].flat(Infinity).filter(Boolean));
          if (!memoryIndex) {
            ordinaryStyle = markerStyle;
            assert.equal(markerStyle.color, dark ? '#eee' : '#111');
          } else for (const field of ['color', 'fontSize', 'lineHeight']) {
            assert.equal(markerStyle[field], ordinaryStyle[field], `${field} must be inherited in ${dark ? 'dark' : 'light'} mode, compact=${compact}`);
          }
        }
      }
    } finally {
      await act(async () => root.unmount());
      Object.assign(globalThis, { __markdownDark: undefined });
    }
  });
}

test('readOnly overrides selectable links and media, including a transition from an open link menu', async () => {
  let requests = 0;
  const api = new GatewayApi({ baseUrl: 'https://gateway.invalid', token: 'test', computerId: 'computer-a' }, async (url) => {
    requests++;
    return mediaResponse(String(url), 72, 48);
  });
  Object.assign(globalThis, { __nativeMenus: true });
  const root = createRoot();
  const content = 'Read [link](https://example.org) ![image](https://example.org/a.png)\n\n$x^2$';
  const tokens = parseMessageMarkdown([{ kind: 'markdown', text: content }]).chunks.get(0);
  try {
    await act(async () => { root.render(createElement('View', null,
      createElement(AgentMemoryMarkdown, { content, selectable: true }), createElement(PortalHost))); });
    const link = root.container.queryAll(node => typeof node.props.onLongPress === 'function')[0];
    await act(async () => { link.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 200 } }); });
    assert.equal(root.container.queryAll(node => node.props.role === 'menu').length, 1);
    await act(async () => { root.render(createElement('View', null,
      createElement(AgentMemoryMarkdown, { content, tokens, selectable: true, readOnly: true,
        media: { api, conversationId: 'conversation', messageSeq: 1 } }), createElement(PortalHost))); });
    assert.equal(root.container.queryAll(node => node.props.role === 'menu').length, 0);
    assert.equal(root.container.queryAll(node => typeof node.props.onPress === 'function' || typeof node.props.onLongPress === 'function').length, 0);
    assert.equal(root.container.queryAll(node => node.type === 'ExpoImage' || node.type === 'MathContent').length, 0);
    assert.equal(requests, 0, 'streaming/read-only content must not request authenticated media');
    assert.ok(root.container.queryAll(node => node.type === 'Text' && node.props.selectable).length);
  } finally {
    await act(async () => { root.unmount(); });
    Object.assign(globalThis, { __nativeMenus: false });
  }
});

function parsedTokens(source: string) {
  return parseMessageMarkdown([{ kind: 'markdown' as const, text: source }]).chunks.get(0)!;
}

test('selectable prose stays in one native text run across headings, paragraphs, nested lists and quotes', async () => {
  const content = '# Title\n\nA **bold *italic*** and `code` [link](https://example.org).\n\n' +
    '3. first\n   - nested\n   - second\n4. last\n\n> quoted\n> next';
  const parts = groupSelectableMarkdown(parsedTokens(content));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'text');
  if (parts[0].kind !== 'text') return;
  const text = parts[0].spans.map(span => span.text).join('');
  assert.match(text, /^Title\n\nA bold italic and code link\.\n\n3\. first\n  • nested\n  • second\n4\. last\n\n▎ quoted\n▎ next$/);
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, { content, selectable: true })); });
    const selectable = root.container.queryAll(node => node.type === 'Text' && node.props.selectable);
    assert.equal(selectable.length, 1);
    const children = selectable[0].queryAll(node => node.type === 'Text');
    const boldItalic = children.find(node => node.props.children === 'italic')!;
    assert.equal(boldItalic.props.style.fontWeight, 'bold');
    assert.equal(boldItalic.props.style.fontStyle, 'italic');
    assert.equal(children.find(node => node.props.children === 'Title')!.props.style.fontSize, 26);
    assert.equal(children.find(node => node.props.children === 'code')!.props.style.backgroundColor, '#eee');
    assert.equal(children.find(node => node.props.children === '▎ ')!.props.style.color, '#ddd');
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('merged text keeps small heading sizes and platform code fonts with local colors', async () => {
  for (const platform of ['ios', 'android', 'web']) {
    Object.assign(globalThis, { __textPlatform: platform });
    const root = createRoot();
    try {
      await act(async () => { root.render(createElement(AgentMemoryMarkdown, {
        content: '##### Small heading\n\n###### Smallest heading\n\n**Bold** *Italic* `code` [link](https://example.org)',
        selectable: true,
      })); });
      const span = (text: string) => root.container.queryAll(node => node.type === 'Text' && node.props.children === text)[0];
      assert.equal(span('Small heading').props.style.fontSize, 13);
      assert.equal(span('Smallest heading').props.style.fontSize, 11);
      assert.equal(span('code').props.style.fontFamily, platform === 'ios' ? 'Courier' : 'monospace');
      assert.equal(span('code').props.style.backgroundColor, '#eee');
      assert.equal(span('code').props.style.color, '#111');
      assert.equal(span('Bold').props.style.fontWeight, 'bold');
      assert.equal(span('Italic').props.style.fontStyle, 'italic');
      assert.equal(span('link').props.style.textDecorationLine, 'underline');
      assert.equal(span('link').props.style.color, '#111');
    } finally {
      await act(async () => { root.unmount(); });
      Object.assign(globalThis, { __textPlatform: undefined });
    }
  }
});

test('quote markers and ordered starts remain textual inside nested containers', () => {
  const source = '> 7. quoted **entry**\n>    - nested\n>\n> 8. next';
  const parts = groupSelectableMarkdown(parsedTokens(source));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'text');
  if (parts[0].kind !== 'text') return;
  const text = parts[0].spans.map(span => span.text).join('');
  assert.match(text, /▎ 7\. quoted entry/);
  assert.match(text, /\n  ▎ • nested/);
  assert.match(text, /\n▎ 8\. next$/);
});

test('quoted headings keep their attribution marker and nested heading styles', () => {
  const parts = groupSelectableMarkdown(parsedTokens('> # Quoted title\n>\n> > ## Nested title\n>\n> body'));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'text');
  if (parts[0].kind !== 'text') return;
  assert.equal(parts[0].spans.map(span => span.text).join(''), '▎ Quoted title\n\n▎▎ Nested title\n\n▎ body');
  assert.equal(parts[0].spans.find(span => span.text === 'Quoted title')?.heading, 'heading1');
  assert.equal(parts[0].spans.find(span => span.text === 'Nested title')?.heading, 'heading2');
});

test('math and rich UI split rendered text runs without fragmenting adjacent prose', async () => {
  const root = createRoot();
  const ui = '```wandrun-ui\n{"root":"x","elements":{"x":{"type":"Text","props":{"text":"UI"}}}}\n```';
  const text = `Before\n\nStill before\n\n$x^2$\n\nAfter math\n\n${ui}\n\nAfter UI\n\nLast paragraph`;
  try {
    await act(async () => { root.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} })); });
    const runs = root.container.queryAll(node => node.type === 'Text' && node.props.selectable);
    const content = runs.map(node => React.Children.toArray(node.props.children)
      .map(child => React.isValidElement<{ children: string }>(child) ? child.props.children : child).join(''));
    assert.deepEqual(content, ['Before\n\nStill before', 'After math', 'After UI\n\nLast paragraph']);
    assert.equal(root.container.queryAll(node => node.type === 'MathContent').length, 1);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('media, code fences and tables split selectable text only at their own boundaries, including within lists', () => {
  const content = 'Before\n\n- first\n  ![plot](https://example.org/a.png)\n  next\n  ```txt\n  code\n  ```\n  after\n\n' +
    '| A | B |\n| - | - |\n| 1 | 2 |\n\nEnd';
  const parts = groupSelectableMarkdown(parsedTokens(content));
  assert.deepEqual(parts.map(part => part.kind), ['text', 'image', 'text', 'block', 'text', 'block', 'text']);
  const text = parts.filter(part => part.kind === 'text').map(part => part.spans.map(span => span.text).join(''));
  assert.match(text[0], /Before\n\n• first\n?$/);
  assert.match(text[1], /next$/);
  assert.match(text[2], /^after$/);
  assert.equal(text[3], 'End');
});

function textLayoutTree(node: TestInstance | string): unknown {
  if (typeof node === 'string') return node;
  const { className, style } = node.props;
  return { type: node.type, className, style, children: node.children.map(textLayoutTree) };
}

function chatTextRuns(root: Root, selectable: boolean): unknown[] {
  return root.container.queryAll(node => node.type === 'Text' &&
    node.props.selectable === selectable && node.parent?.props.style?.gap === 8).map(textLayoutTree);
}

test('ordinary draft and final Markdown share host text layout across completed and open blocks', async () => {
  const cases = [
    'One paragraph without a trailing newline',
    'First paragraph.\n\nSecond paragraph without a trailing newline',
    '# Heading\n\nA **bold** [link](https://example.org) without a trailing newline',
    'Intro\n\n1. first\n2. second\n\nAfter the list',
    'Intro\n\n- first\n\n- second\n\nAfter the list',
    '- first\n\n  continuation\n\n- second',
    '## Heading\n\n- first\n- second\n\n[link](https://example.org)\n\nLast',
    '- first\n\n  continuation without a trailing newline',
    'Intro\n\n> quoted\n> next\n\nAfter',
    'Before\n\n```ts\nconst value = 1;\n```\n\nAfter',
    'Before\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter',
  ];
  for (const text of cases) {
    const draft = createRoot();
    const final = createRoot();
    try {
      await act(async () => {
        draft.render(createElement(DraftMessageContent, { text }));
        final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
      });
      assert.deepEqual(draft.container.children.map(textLayoutTree),
        final.container.children.map(textLayoutTree), text);
      assert.equal(draft.container.queryAll(node => typeof node.props.onPress === 'function' ||
        typeof node.props.onLongPress === 'function' || node.type === 'MathContent' ||
        node.type === 'RichBlock').length, 0);
      assert.equal(draft.container.queryAll(node => node.type === 'Text' && node.props.selectable).length, 0);
      assert.equal(chatTextRuns(final, true).length, text.includes('```') || text.includes('| A |') ? 2 : 1,
        'only native code/table blocks split the continuous text host');
      if (text.includes('[link]')) assert.equal(final.container.queryAll(node =>
        node.type === 'Text' && node.props.children === 'link' && typeof node.props.onPress === 'function').length, 1);
    } finally {
      await act(async () => { draft.unmount(); final.unmount(); });
    }
  }
});

test('draft prose around UI and mermaid placeholders keeps the final text-run layout', async () => {
  for (const text of [
    'Before **bold**.\n\n```wandrun-ui\n{}\n```\n\n# After\n\n[link](https://example.org)',
    'Before\n\n```mermaid\ngraph LR\n```\n\nAfter [link](https://example.org)',
  ]) {
    const draft = createRoot();
    const final = createRoot();
    try {
      await act(async () => {
        draft.render(createElement(DraftMessageContent, { text }));
        final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
      });
      assert.deepEqual(chatTextRuns(draft, false), chatTextRuns(final, true), text);
      assert.equal(draft.container.queryAll(node => typeof node.props.onPress === 'function' ||
        typeof node.props.onLongPress === 'function' || node.type === 'MathContent').length, 0);
    } finally {
      await act(async () => { draft.unmount(); final.unmount(); });
    }
  }
});

test('definitions across stable and live blocks resolve in the read-only draft as in the final message', async () => {
  for (const text of [
    '[label][ref]\n\n[ref]: https://example.org',
    '[label][ref]\n\n```wandrun-ui\n{}\n```\n\n[ref]: https://example.org',
    'A footnote[^one].\n\n[^one]: The note',
  ]) {
    const draft = createRoot();
    const final = createRoot();
    try {
      await act(async () => {
        draft.render(createElement(DraftMessageContent, { text }));
        final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
      });
      assert.deepEqual(chatTextRuns(draft, false), chatTextRuns(final, true), text);
      if (!text.includes('wandrun-ui')) {
        assert.deepEqual(draft.container.children.map(textLayoutTree), final.container.children.map(textLayoutTree));
      }
      assert.equal(draft.container.queryAll(node => typeof node.props.onPress === 'function' ||
        typeof node.props.onLongPress === 'function').length, 0);
    } finally {
      await act(async () => { draft.unmount(); final.unmount(); });
    }
  }
});

test('read-only draft shows inline math source without mounting interactive math', async () => {
  const root = createRoot();
  try {
    await act(async () => { root.render(createElement(DraftMessageContent, { text: 'Before $x^2$ after' })); });
    assert.equal(root.container.queryAll(node => node.type === 'Text' && node.props.children === '$x^2$').length, 1);
    assert.equal(root.container.queryAll(node => node.type === 'MathContent' ||
      typeof node.props.onPress === 'function' || typeof node.props.onLongPress === 'function').length, 0);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test('completed read-only draft blocks keep their host identity as tails grow, including after UI', async () => {
  for (const before of [
    'Finished **bold**.\n\nUnfinished',
    'Earlier\n\n```wandrun-ui\n{}\n```\n\nFinished **bold**.\n\nUnfinished',
  ]) {
    const root = createRoot();
    try {
      await act(async () => { root.render(createElement(DraftMessageContent, { text: before })); });
      const completed = root.container.queryAll(node => node.type === 'Text' && node.props.children === 'bold')[0];
      assert.ok(completed);
      await act(async () => { root.render(createElement(DraftMessageContent, { text: before + ' tail' })); });
      assert.equal(root.container.queryAll(node => node.type === 'Text' && node.props.children === 'bold')[0], completed);
      assert.equal(root.container.queryAll(node => typeof node.props.onPress === 'function').length, 0);
    } finally {
      await act(async () => { root.unmount(); });
    }
  }
});

test('definition drafts display every append immediately and retain document-wide reference semantics', async () => {
  for (const prefix of [
    '[label][ref]\n\n[ref]: https://example.org\n\n',
    'A footnote[^one].\n\n[^one]: The note\n\n',
    '[label][ref]\n\n```wandrun-ui\n{}\n```\n\n[ref]: https://example.org\n\n',
    'First[^one] and inline ^[Inline note].\n\n[^one]: The note\n\n[^two]: Another note\n\n',
  ]) {
    const draft = createRoot();
    const final = createRoot();
    try {
      for (const tail of ['Old', 'Old NEW', 'Old NEW LAST', 'Old NEW LAST [label][ref] [^one] [^two]']) {
        const text = prefix + tail;
        await act(async () => {
          draft.render(createElement(DraftMessageContent, { text }));
          final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
        });
        assert.deepEqual(chatTextRuns(draft, false), chatTextRuns(final, true), text);
        if (!text.includes('wandrun-ui')) {
          assert.deepEqual(draft.container.children.map(textLayoutTree), final.container.children.map(textLayoutTree));
        }
        await act(async () => { draft.render(createElement(DraftMessageContent, { text, interrupted: true })); });
        assert.deepEqual(chatTextRuns(draft, false), chatTextRuns(final, true), 'same text and interruption cannot leave stale tokens');
        assert.equal(draft.container.queryAll(node => typeof node.props.onPress === 'function' ||
          typeof node.props.onLongPress === 'function' || node.type === 'MathContent').length, 0);
      }
    } finally {
      await act(async () => { draft.unmount(); final.unmount(); });
    }
  }
});

test('new definitions, changed definitions and multiline footnotes invalidate the cached prefix', async () => {
  const draft = createRoot();
  const final = createRoot();
  try {
    for (const text of [
      '[label][ref]\n\nTail',
      '[label][ref]\n\nTail\n\n[ref]: https://example.org',
      '[label][ref]\n\nTail\n\n[ref]: https://example.org/new\n\nNext',
      'Note[^one].\n\n[^one]: Start\n\n    continuation',
      'Note[^one].\n\n[^one]: Start\n\n    continuation grows\n\nNext',
      'Note[^one].\n\n[^one]: Replacement\n\nReset',
    ]) {
      await act(async () => {
        draft.render(createElement(DraftMessageContent, { text }));
        final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
      });
      assert.deepEqual(draft.container.children.map(textLayoutTree), final.container.children.map(textLayoutTree), text);
    }
  } finally {
    await act(async () => { draft.unmount(); final.unmount(); });
  }
});

for (const [name, definition] of [
  ['blockquote link', '> [new]: https://new.org'],
  ['list link', '- [new]: https://new.org'],
  ['nested link', '> 1. [new]: https://new.org'],
  ['blockquote footnote', '> [^one]: Note body'],
  ['list footnote', '- [^one]: Note body'],
  ['nested footnote', '> 1. [^one]: Note body'],
]) {
  test(`${name}: a new definition resolves the entire draft on first mount and append`, async () => {
    for (const oldDefinition of ['', '[old]: https://old.org\n\n']) {
      const prefix = oldDefinition + '[label][new]\n\nNote[^one].\n\n';
      const draft = createRoot();
      const final = createRoot();
      const fresh = createRoot();
      try {
        for (const text of [prefix, prefix + definition, prefix + definition + '\n\nNext paragraph']) {
          await act(async () => {
            draft.render(createElement(DraftMessageContent, { text }));
            final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
          });
          assert.deepEqual(draft.container.children.map(textLayoutTree), final.container.children.map(textLayoutTree), text);
        }
        const text = prefix + definition;
        await act(async () => {
          fresh.render(createElement(DraftMessageContent, { text }));
          final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
        });
        assert.deepEqual(fresh.container.children.map(textLayoutTree), final.container.children.map(textLayoutTree), 'independent first mount');
      } finally {
        await act(async () => { draft.unmount(); final.unmount(); fresh.unmount(); });
      }
    }
  });
}

test('footnote continuations across multiple blank parts retain their footer block ownership', async () => {
  for (const newline of ['\n', '\r\n']) {
    for (const gap of [2, 3, 5]) {
      for (const indent of ['    ', '\t']) {
        const prefix = `Note[^one].${newline.repeat(2)}[^one]: Start${newline.repeat(gap)}`;
        const draft = createRoot();
        const final = createRoot();
        const fresh = createRoot();
        try {
          for (const suffix of ['', `${indent}continuation`, `${indent}continuation grows`,
            `${indent}continuation grows${newline.repeat(2)}Body after the note`]) {
            const text = prefix + suffix;
            await act(async () => {
              draft.render(createElement(DraftMessageContent, { text }));
              final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
            });
            assert.deepEqual(draft.container.children.map(textLayoutTree), final.container.children.map(textLayoutTree), text);
          }
          const text = prefix + `${indent}continuation`;
          await act(async () => {
            fresh.render(createElement(DraftMessageContent, { text }));
            final.render(createElement(AgentMessageContent, { text, onSubmit: async () => {} }));
          });
          assert.deepEqual(fresh.container.children.map(textLayoutTree), final.container.children.map(textLayoutTree), text);
        } finally {
          await act(async () => { draft.unmount(); final.unmount(); fresh.unmount(); });
        }
      }
    }
  }
});

for (const definition of ['[ref]: https://example.org\n\n', '[^one]: A footnote\n\n']) {
  test(`stable definition prefixes are not reparsed on ordinary tail updates: ${definition.trim()}`, async (t) => {
    const root = createRoot();
    const prefix = definition + Array.from({ length: 200 }, (_, index) => `Paragraph ${index} **stable body**.\n\n`).join('');
    try {
      await act(async () => { root.render(createElement(DraftMessageContent, { text: prefix + 'Tail' })); });
      const parse = MarkdownIt.prototype.parse;
      let characters = 0;
      let tailCharacters = 0;
      t.mock.method(MarkdownIt.prototype, 'parse', function (this: MarkdownIt, source: string, env: unknown) {
        characters += source.length;
        return parse.call(this, source, env);
      });
      for (let index = 0; index < 20; index++) {
        const tail = `Tail update ${index}`;
        tailCharacters += tail.length;
        await act(async () => { root.render(createElement(DraftMessageContent, { text: prefix + tail })); });
      }
      assert.ok(characters <= tailCharacters * 2, `parsed ${characters} characters for ${tailCharacters} tail characters`);
      assert.equal(root.container.queryAll(node => node.type === 'Text' && node.props.children === 'Tail update 19').length, 1);
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
}

test('stable code and table hosts survive tail updates with and without definitions', async () => {
  for (const definition of ['', '[ref]: https://example.org\n\n', '[^one]: Note\n\n']) {
    const root = createRoot();
    const prefix = definition + '```txt\nStable code\n```\n\n| Column |\n| --- |\n| Stable cell |\n\n';
    try {
      await act(async () => { root.render(createElement(DraftMessageContent, { text: prefix + 'Tail' })); });
      const code = root.container.queryAll(node => node.type === 'Text' && node.props.children === 'Stable code')[0];
      const cell = root.container.queryAll(node => node.type === 'Text' && node.props.children === 'Stable cell')[0];
      assert.ok(code);
      assert.ok(cell);
      for (const tail of ['Tail grows', 'Tail grows again']) {
        await act(async () => { root.render(createElement(DraftMessageContent, { text: prefix + tail })); });
        assert.equal(root.container.queryAll(node => node.type === 'Text' && node.props.children === 'Stable code')[0], code);
        assert.equal(root.container.queryAll(node => node.type === 'Text' && node.props.children === 'Stable cell')[0], cell);
      }
    } finally {
      await act(async () => { root.unmount(); });
    }
  }
});

test('chat code fences and indented blocks preserve columns on the drawer-isolated horizontal surface', async () => {
  const code = 'root/\n├── src/          // aligned comment\n└── tests/        // aligned comment\n' +
    Array.from({ length: 80 }, (_, i) => `row_${i}    ${'long_column_'.repeat(12)}    // keep this column`).join('\n');
  const root = createRoot();
  const withDrawer = (child: React.ReactNode) =>
    createElement(markdownDrawerContext.Provider, { value: { id: 'drawer' } }, child);
  try {
    for (const block of ['```text\n' + code + '\n```', code.split('\n').map(line => '    ' + line).join('\n')]) {
      await act(async () => { root.render(withDrawer(createElement(AgentMessageContent, {
        text: 'Before `inline`.\n\n' + block + '\n\nAfter.', onSubmit: async () => {},
      }))); });
      const scroll = root.container.queryAll(node => node.props.testID === 'markdown-code-scroll')[0];
      assert.ok(scroll);
      assert.equal(scroll.type, 'ScrollView');
      assert.equal(scroll.props.horizontal, true);
      assert.equal(scroll.parent?.type, 'GestureDetector');
      assert.equal(scroll.parent?.children[0], scroll, 'priority is attached to the scrolling host');
      const text = scroll.queryAll(node => node.props.testID === 'markdown-code-text')[0];
      assert.equal(text.props.children, code);
      assert.equal(text.props.selectable, true, 'wrapping must not move selection onto the ScrollView');
      const style = Object.assign({}, ...[text.props.style].flat(Infinity).filter(Boolean));
      assert.equal(style.flexShrink, 0);
      assert.equal(style.maxHeight, undefined);
      assert.equal(text.props.numberOfLines, undefined);
      assert.equal(scroll.props.style.maxHeight, undefined);
      const inline = root.container.queryAll(node => node.type === 'Text' && node.props.children === 'inline')[0];
      assert.ok(inline);
      assert.equal(scroll.queryAll(node => node === inline).length, 0);
    }
    await act(async () => { root.render(withDrawer(createElement(DraftMessageContent, { text: '```text\n' + code }))); });
    assert.equal(root.container.queryAll(node => node.props.testID === 'markdown-code-text')[0].props.children, code,
      'an unfinished streaming code fence uses the same unwrapped surface');
  } finally { await act(async () => { root.unmount(); }); }
});

test('horizontal code is opt-in and can change without stale memoized rules', async () => {
  const root = createRoot();
  const content = 'A `short` value.\n\n```text\none    two\nthree  four\n```';
  try {
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, { content, selectable: true })); });
    assert.equal(root.container.queryAll(node => node.props.testID === 'markdown-code-scroll').length, 0);
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, { content, selectable: true, scrollCodeBlocks: true })); });
    assert.equal(root.container.queryAll(node => node.props.testID === 'markdown-code-scroll').length, 1);
    await act(async () => { root.render(createElement(AgentMemoryMarkdown, { content, selectable: true, scrollCodeBlocks: false })); });
    assert.equal(root.container.queryAll(node => node.props.testID === 'markdown-code-scroll').length, 0);
  } finally { await act(async () => { root.unmount(); }); }
});
