import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'test-renderer';
import ts from 'typescript';
import { MAX_ACTIVE_RENDERERS, RenderBudget, intersectsRenderViewport } from '../src/lib/render-budget.ts';
import { parseMessageMarkdown } from '../src/lib/agent-message-markdown.ts';
import { splitAgentMessage } from '../src/lib/agent-message.ts';
import { groupMarkdownBlocks, mathBlockHtml, mathNode } from '../src/lib/math-html.ts';

// Exercise resource ownership with real files; only Expo's native FS API is
// replaced. Browser execution/CSP/font loading also need the rendering smoke.
const cache = mkdtempSync(join(tmpdir(), 'math-resources-'));
let failWrite = '';
let beforeWrite: ((uri: string) => Promise<void>) | undefined;
class DiskPath {
  uri: string;
  constructor(parent: string | DiskPath, name = '') {
    this.uri = pathToFileURL(join(fileURLToPath(typeof parent === 'string' ? parent : parent.uri), name)).href;
  }
  get exists() { return existsSync(new URL(this.uri)); }
  delete() { rmSync(new URL(this.uri), { recursive: true }); }
}
class DiskFile extends DiskPath {
  write(text: string) {
    if (failWrite && this.uri.endsWith(failWrite)) {
      writeFileSync(new URL(this.uri), 'partial');
      throw new Error('disk write failed');
    }
    writeFileSync(new URL(this.uri), text);
  }
  async move(destination: DiskFile) {
    renameSync(new URL(this.uri), new URL(destination.uri));
    this.uri = destination.uri;
  }
}
class DiskDirectory extends DiskPath {
  create(options?: { idempotent?: boolean }) { mkdirSync(new URL(this.uri), { recursive: options?.idempotent }); }
}
const filesystem = {
  File: DiskFile, Directory: DiskDirectory, Paths: { cache: pathToFileURL(cache).href },
  async writeAsStringAsync(uri: string, text: string) {
    await beforeWrite?.(uri);
    new DiskFile(uri).write(text);
  },
};
after(() => rmSync(cache, { recursive: true, force: true }));

const visibility = new Map<object, (visible: boolean) => void>();
let focused = true;
let live = 0;
let peak = 0;
const native = {
  observe(view: object, notify: (visible: boolean) => void) {
    visibility.set(view, notify);
    return () => { visibility.delete(view); };
  },
  focused: () => focused,
  WebView(props: Record<string, unknown>) {
    useLayoutEffect(() => { live++; peak = Math.max(peak, live); return () => { live--; }; }, []);
    return createElement('WebView', props);
  },
};
declare global { var __mathNative: typeof native; var __mathFilesystem: typeof filesystem; var IS_REACT_ACT_ENVIRONMENT: boolean; }
globalThis.__mathNative = native;
globalThis.__mathFilesystem = filesystem;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const hosts: Record<string, string> = {
  'expo-router': `export const useIsFocused = globalThis.__mathNative.focused;`,
  'expo-file-system': `export const { File, Directory, Paths } = globalThis.__mathFilesystem;`,
  'expo-file-system/legacy': `export const { writeAsStringAsync } = globalThis.__mathFilesystem;`,
  'react-native': `export const View = 'View', Pressable = 'Pressable', Text = 'Text'; export const Platform = { OS: 'ios' }; export const Linking = { openURL() {} }; export const StyleSheet = { flatten: values => Object.assign({}, ...values) };`,
  'react-native-webview': `export default globalThis.__mathNative.WebView;`,
  'uniwind': `export const useCSSVariable = () => []; export const useResolveClassNames = () => ({});`,
  '@/components/ui/text.tsx': `export const Text = 'Text';`,
  '@/lib/session-context.tsx': `export const useSession=()=>({api:{config:{computerId:'computer-a'}}});`,
  './render-visibility.ts': `export const observeRenderVisibility = globalThis.__mathNative.observe;`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    if (specifier === './math-page') return nextResolve('./math-page.ts', context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
// Native hosts must be registered before loading this platform-specific module.
const { MathContent } = await import('../src/components/rich-message/math.tsx');

test('500 formula paragraphs and repeated long-conversation scrolling never exceed the global frame budget', async () => {
  const markdown = Array(500).fill('公式 $x$').join('\n\n');
  const parsed = parseMessageMarkdown(splitAgentMessage(markdown));
  const blocks = [...parsed.chunks.values()].flatMap(groupMarkdownBlocks);
  assert.equal(blocks.length, 500);
  const root = createRoot({ textComponentTypes: ['Text'], isStrictMode: true });
  let conversation = false;
  const render = () => {
    const content = blocks.map((block, i) => createElement(MathContent,
      { key: i, html: mathBlockHtml(block), source: `公式 ${i} $x$` }));
    root.render(createElement('View', {}, conversation
      ? Array.from({ length: 20 }, (_, i) => createElement('View', { key: i }, content.slice(i * 25, (i + 1) * 25)))
      : content));
  };
  try {
    await act(async () => { render(); });
    assert.equal(live, 0, 'no frame before viewport observation');
    const observers = [...visibility.values()];
    assert.equal(observers.length, 500);
    // Even one enormous visible message cannot allocate one renderer per block.
    await act(async () => { for (const notify of observers) notify(true); });
    assert.equal(live, MAX_ACTIVE_RENDERERS);
    assert.ok(root.container.queryAll(node => node.type === 'Text').some(node => node.props.children === '公式 499 $x$'));
    await act(async () => { root.container.queryAll(node => node.type === 'WebView')[0].props.onError(); });
    assert.equal(live, MAX_ACTIVE_RENDERERS, 'failed renderer yields its slot to another visible block');
    assert.ok(root.container.queryAll(node => node.type === 'Text').some(node => node.props.children === '公式 0 $x$'));
    for (const offset of [100, 490, 0, 240, 0, 490, 100, 0]) {
      await act(async () => { observers.forEach((notify, i) => notify(i >= offset && i < offset + 10)); });
      assert.equal(live, MAX_ACTIVE_RENDERERS);
      assert.ok(peak <= MAX_ACTIVE_RENDERERS, 'including retire/grant commits, not just settled counts');
    }
    // Repartition into 20 mounted message rows: the budget must stay global.
    conversation = true;
    await act(async () => { render(); });
    const messages = [...visibility.values()];
    for (const offset of [0, 50, 475, 200, 0, 475, 0]) {
      await act(async () => { messages.forEach((notify, i) => notify(i >= offset && i < offset + 50)); });
      assert.equal(live, MAX_ACTIVE_RENDERERS, 'two visible messages still share one budget');
      assert.ok(peak <= MAX_ACTIVE_RENDERERS);
    }
    focused = false;
    await act(async () => { render(); });
    assert.equal(live, 0, 'background route drops every renderer');
    assert.equal(visibility.size, 0);
    focused = true;
    await act(async () => { render(); });
    assert.equal(live, 0, 'returning route must be measured again');
    await act(async () => { [...visibility.values()].slice(0, 10).forEach(notify => notify(true)); });
    assert.equal(live, MAX_ACTIVE_RENDERERS);
  } finally {
    await act(async () => { root.unmount(); });
    focused = true;
  }
  assert.equal(live, 0);
  assert.equal(visibility.size, 0);
});

test('cancelled waiters cannot consume later permits; cleanup is idempotent', () => {
  const budget = new RenderBudget();
  const granted: number[] = [];
  const owners = Array.from({ length: MAX_ACTIVE_RENDERERS + 2 }, (_, i) => budget.request(() => granted.push(i)));
  owners[MAX_ACTIVE_RENDERERS]();
  owners[0](); owners[0]();
  assert.deepEqual(granted, [0, 1, 2, 3, 5]);
  owners.forEach(cancel => cancel());
});

test('offscreen prefetch cannot occupy a slot needed by a visible diagram or formula', () => {
  assert.equal(intersectsRenderViewport(0, -100, 320, 50, 320, 640), false);
  assert.equal(intersectsRenderViewport(0, 700, 320, 50, 320, 640), false);
});

test('visibility excludes collapsed, offscreen and invalid geometry', () => {
  for (const [x, y, width, height] of [[0, 801, 320, 50], [0, -211, 320, 50], [321, 0, 10, 50], [0, 0, 0, 50], [0, 0, 320, 0], [0, NaN, 320, 50]]) {
    assert.equal(intersectsRenderViewport(x, y, width, height, 320, 640), false);
  }
});

test('native pages share resources, isolate their content, and release only their own files', async () => {
  // The Expo filesystem host must be registered before importing this module.
  const { prepareMathPage } = await import('../src/components/rich-message/math-page.ts');
  const theme = { color: '#141414', muted: '#eeeeee', border: '#dddddd', fontSize: 16 };
  const pages = await Promise.all(['x', 'y', 'z', 'q'].map(tex => prepareMathPage(mathNode(tex, true), theme, 'computer-a')));
  try {
    const documents = pages.map(page => {
      assert.ok('uri' in page.source);
      return readFileSync(new URL(page.source.uri), 'utf8');
    });
    const scripts = documents.map(html => html.match(/<script[^>]* src="([^"]+)"/)![1]);
    const styles = documents.map(html => html.match(/rel="stylesheet" href="([^"]+)"/)![1]);
    assert.equal(new Set(scripts).size, 1);
    assert.equal(new Set(styles).size, 1);
    for (const [index, html] of documents.entries()) {
      assert.ok(Buffer.byteLength(html) < 6000, 'content pages do not carry the KaTeX payload');
      assert.ok(!html.includes('base64,'));
      assert.match(html, new RegExp(`data-tex="${['x', 'y', 'z', 'q'][index]}"`));
    }
    pages[0].dispose!();
    assert.ok('uri' in pages[0].source && !existsSync(new URL(pages[0].source.uri)));
    assert.ok('uri' in pages[1].source && existsSync(new URL(pages[1].source.uri)));
    assert.ok(readFileSync(new URL(scripts[1]), 'utf8').includes('KaTeX'));
    assert.ok(readFileSync(new URL(styles[1]), 'utf8').includes('data:font/woff2;base64,'));
  } finally {
    pages.forEach(page => page.dispose?.());
  }
  assert.deepEqual(readdirSync(join(cache, 'wandrun-katex', 'computer-a')).sort(), ['katex.css', 'katex.js']);
});

test('identical formula content from distinct computers has isolated WebView read scopes', async () => {
  const { prepareMathPage } = await import('../src/components/rich-message/math-page.ts');
  const theme = { color: '#141414', muted: '#eeeeee', border: '#dddddd', fontSize: 16 };
  const first = await prepareMathPage(mathNode('server-a', true), theme, 'computer-a');
  const second = await prepareMathPage(mathNode('server-b', true), theme, 'computer-b');
  try {
    assert.ok('uri' in first.source && 'uri' in second.source);
    assert.notEqual(first.readAccessUrl, second.readAccessUrl);
    assert.ok(first.source.uri.startsWith(first.readAccessUrl!));
    assert.ok(second.source.uri.startsWith(second.readAccessUrl!));
    assert.match(readFileSync(new URL(first.source.uri), 'utf8'), /server-a/);
    assert.match(readFileSync(new URL(second.source.uri), 'utf8'), /server-b/);
    assert.ok(!first.source.uri.startsWith(second.readAccessUrl!));
  } finally {
    first.dispose?.();
    second.dispose?.();
  }
});

test('existing pages never read partial resources during cache reconstruction', async () => {
  // Register the Expo filesystem host before loading the native module.
  const { prepareMathPage } = await import('../src/components/rich-message/math-page.ts');
  const theme = { color: '#141414', muted: '#eeeeee', border: '#dddddd', fontSize: 16 };
  const page = await prepareMathPage(mathNode('x', true), theme, 'computer-a');
  try {
    assert.ok('uri' in page.source);
    const html = readFileSync(new URL(page.source.uri), 'utf8');
    const resources = [
      html.match(/<script[^>]* src="([^"]+)"/)![1],
      html.match(/rel="stylesheet" href="([^"]+)"/)![1],
    ];
    for (const uri of resources) {
      const expected = readFileSync(new URL(uri), 'utf8');
      const reader = openSync(new URL(uri), 'r');
      const writing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      beforeWrite = async target => {
        if (target.endsWith('.html')) return;
        writeFileSync(new URL(target), '/* partial */');
        writing.resolve();
        await release.promise;
      };
      rmSync(new URL(uri));
      const rebuilding = prepareMathPage(mathNode('y', true), theme, 'computer-a');
      try {
        await writing.promise;
        assert.equal(readFileSync(reader, 'utf8'), expected, 'an in-flight reader retains the complete old resource');
        assert.throws(() => readFileSync(new URL(uri)), { code: 'ENOENT' },
          'an evicted URL stays absent until the complete resource is published');
        release.resolve();
        await rebuilding;
        assert.equal(readFileSync(new URL(uri), 'utf8'), expected, 'the old page URL now serves the complete rebuilt resource');
        assert.ok(!readdirSync(join(cache, 'wandrun-katex')).some(name => name.endsWith('.tmp')));
      } finally {
        beforeWrite = undefined;
        release.resolve();
        try { (await rebuilding).dispose?.(); }
        finally { closeSync(reader); }
      }
    }
  } finally {
    page.dispose?.();
  }
});

test('resource write and browser resource-load failures show source and release the frame permit', async () => {
  for (const failure of ['katex.css', 'bridge']) {
    const root = createRoot({ textComponentTypes: ['Text'], isStrictMode: true });
    if (failure !== 'bridge') {
      rmSync(join(cache, 'wandrun-katex', 'computer-a', 'katex.css'), { force: true });
      failWrite = `${failure}.tmp`;
    }
    try {
      await act(async () => { root.render(createElement(MathContent, { html: mathNode('x^2', true), source: 'x^2' })); });
      await act(async () => { [...visibility.values()].forEach(notify => notify(true)); });
      if (failure === 'bridge') {
        assert.equal(live, 1);
        await act(async () => {
          root.container.queryAll(node => node.type === 'WebView')[0].props.onMessage({ nativeEvent: { data: '{"kind":"error"}' } });
        });
      }
      assert.equal(live, 0);
      assert.ok(root.container.queryAll(node => node.type === 'Text').some(node => node.props.children === 'x^2'));
      assert.ok(!readdirSync(join(cache, 'wandrun-katex', 'computer-a')).some(name => name.endsWith('.html')));
      if (failure !== 'bridge') {
        assert.ok(!existsSync(join(cache, 'wandrun-katex', 'computer-a', 'katex.css')), 'partial asset must not become the shared resource');
        assert.ok(!readdirSync(join(cache, 'wandrun-katex', 'computer-a')).some(name => name.endsWith('.tmp')), 'failed writes clean up temporary resources');
      }
    } finally {
      failWrite = '';
      await act(async () => { root.unmount(); });
    }
  }
});

test('unmount during a content write releases the permit and deletes the late file', async () => {
  const writing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeWrite = async uri => {
    if (uri.endsWith('.html')) { writing.resolve(); await release.promise; }
  };
  const root = createRoot({ textComponentTypes: ['Text'] });
  try {
    await act(async () => { root.render(createElement(MathContent, { html: mathNode('q', true), source: 'q' })); });
    await act(async () => { [...visibility.values()].forEach(notify => notify(true)); });
    await writing.promise;
    await act(async () => { root.unmount(); });
    assert.equal(live, 0);
    await act(async () => { release.resolve(); });
    assert.deepEqual(readdirSync(join(cache, 'wandrun-katex', 'computer-a')).sort(), ['katex.css', 'katex.js']);
  } finally {
    beforeWrite = undefined;
    release.resolve();
    await act(async () => { root.unmount(); });
  }
});
