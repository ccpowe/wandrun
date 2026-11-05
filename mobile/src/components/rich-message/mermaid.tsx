import { router, useIsFocused } from 'expo-router';
import { ArrowLeft, ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react-native';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, View } from 'react-native';
import WebView from 'react-native-webview';
import { useCSSVariable } from 'uniwind';

import { Button } from '@/components/ui/button.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import { useTranslation } from '@/lib/i18n.ts';
import { useSession } from '@/lib/session-context.tsx';
import { renderBudget } from '@/lib/render-budget.ts';
import { mermaidCache } from '@/lib/mermaid-cache.ts';
import { MERMAID_INLINE_MAX, mermaidInlineHeight, type MermaidNaturalSize } from '@/lib/mermaid-inline.ts';
import { parseMermaidEvent } from '@/lib/mermaid-document.ts';
import type { MermaidCommand, MermaidInput, MermaidPage, MermaidTheme, MermaidViewport } from '@/lib/mermaid-document.ts';
import { prepareMermaidPage } from './mermaid-page';
import { observeRenderVisibility } from './render-visibility.ts';
import { RichText } from './math.tsx';
import type { MediaLocation } from './media.tsx';
import { MermaidToolbar } from './mermaid-toolbar.tsx';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';


type DiagramStatus = { ready: boolean; zoom: number };
type SavedViewport = { layout: Omit<MermaidInput, 'day'>; day: string; viewport: MermaidViewport };
type CommandSender = (action: MermaidCommand['action']) => void;
type DiagramControl = { run: CommandSender };

function errorMessage(code: string): string {
  if (code === 'limit') return '流程图复杂度或输出尺寸超出限制';
  if (code === 'source') return '流程图不允许外部资源或配置';
  if (code === 'unsupported-diagram') return '不支持这种流程图，请查看源码';
  if (code === 'timeout') return '流程图显示超时，请查看源码';
  if (code === 'failed' || code === 'resource' || code === 'render') return '流程图暂时无法显示，请查看源码';
  return '流程图源码无法解析或渲染';
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s,.%]+\))$/i.test(value) ? value : fallback;
}

/** The same four permits cover formulas, inline diagrams and full-screen diagrams.
 * A hidden/unfocused owner removes its frame before returning the permit. */
export function MermaidDiagram({ ref, source, full = false, visible = true, height: inlineHeight = MERMAID_INLINE_MAX, onError, onStatus, onRendered }: {
  ref?: Ref<DiagramControl>; source: string; full?: boolean; visible?: boolean;
  /** Inline viewport height; the viewer derives it from the rendered size (`Mermaid.fit` / `.tall`). */
  height?: number;
  onError?: (message: string | null) => void; onStatus?: (status: DiagramStatus) => void;
  onRendered?: (size: MermaidNaturalSize) => void;
}) {
  const { t } = useTranslation();
  const view = useRef<View>(null);
  const focused = useIsFocused();
  const [near, setNear] = useState(false);
  const [permitted, setPermitted] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [failure, setFailure] = useState<{ input: Omit<MermaidInput, 'day'>; message: string }>();
  const input = useMemo(() => ({ source, width: Math.floor(box.width), full }), [source, box.width, full]);
  const savedViewportRef = useRef<SavedViewport | undefined>(undefined);
  const senderRef = useRef<CommandSender | undefined>(undefined);
  const commandIdRef = useRef(0);
  useImperativeHandle(ref, () => ({ run: action => senderRef.current?.(action) }), []);
  const rendererKey = useMemo(() => JSON.stringify(input), [input]);
  const onFailure = useCallback((code: string) => setFailure({ input, message: errorMessage(code) }), [input]);
  const error = failure?.input === input ? failure.message : null;
  const eligible = visible && focused && near && input.width > 0 && !error;
  useEffect(() => {
    if (!focused || !view.current) return;
    const stop = observeRenderVisibility(view.current, setNear);
    return () => { stop(); setNear(false); };
  }, [focused]);
  useEffect(() => {
    if (!eligible) return;
    const cancel = renderBudget.request(() => setPermitted(true));
    return () => { setPermitted(false); cancel(); };
  }, [eligible]);
  useEffect(() => { onError?.(error); }, [error, onError]);
  useEffect(() => {
    if (full && !eligible) onStatus?.({ ready: false, zoom: savedViewportRef.current?.layout === input ? savedViewportRef.current.viewport.zoom : 1 });
  }, [eligible, full, input, onStatus]);
  const height = inlineHeight;
  return <View ref={view} collapsable={false} testID="mermaid-renderer"
    accessibilityElementsHidden={!visible} importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
    style={full ? { flex: 1, minHeight: 0, width: '100%' } : { width: '100%', height }}
    onLayout={event => {
      const { width, height: nextHeight } = event.nativeEvent.layout;
      setBox(previous => previous.width === width && previous.height === nextHeight ? previous : { width, height: nextHeight });
    }}>
    {error ? <View className="items-center justify-center" style={{ padding: richSpace.lg, ...(full ? { flex: 1 } : { minHeight: height }) }} testID="mermaid-error">
      <Text className="text-center text-destructive" style={richType.subtle}>{t(error)}</Text>
    </View> : eligible && permitted ? <ActiveDiagram key={rendererKey} input={input} viewportHeight={full ? box.height : height}
      savedViewportRef={savedViewportRef} senderRef={senderRef} commandIdRef={commandIdRef} onStatus={full ? onStatus : undefined} onFailure={onFailure} onRendered={onRendered} />
      : <View className="items-center justify-center" testID={focused && near ? 'mermaid-waiting' : undefined}
          style={full ? { flex: 1 } : { height }} accessibilityLabel={t('流程图')}>
        {focused && near ? <Text className="text-muted-foreground" style={richType.subtle}>{t('等待显示')}</Text> : null}
      </View>}
  </View>;
}

function ActiveDiagram({ input: layout, viewportHeight, savedViewportRef, senderRef, commandIdRef, onStatus, onFailure, onRendered }: {
  input: Omit<MermaidInput, 'day'>; viewportHeight: number;
  savedViewportRef: RefObject<SavedViewport | undefined>; senderRef: RefObject<CommandSender | undefined>; commandIdRef: RefObject<number>;
  onStatus?: (status: DiagramStatus) => void; onFailure: (code: string) => void; onRendered?: (size: MermaidNaturalSize) => void;
}) {
  // One date belongs to this mounted renderer, including delayed preparation/results.
  const input = useMemo<MermaidInput>(() => ({ ...layout, day: new Date().toISOString().slice(0, 10) }), [layout]);
  const { t } = useTranslation();
  const computerId = useSession()?.api.config.computerId ?? 'offline';
  const colors = useCSSVariable(['--color-card', '--color-foreground', '--color-muted-foreground', '--color-muted', '--color-border', '--color-destructive']);
  const background = safeColor(colors[0], '#ffffff');
  const foreground = safeColor(colors[1], '#141414');
  const muted = safeColor(colors[2], '#737373');
  const surface = safeColor(colors[3], '#f0f0ed');
  const border = safeColor(colors[4], '#999999');
  const error = safeColor(colors[5], '#b33b35');
  const theme = useMemo<MermaidTheme>(() => ({ background, foreground, muted, surface, surfaceAlt: surface, border, line: muted, accent: foreground, error }),
    [background, foreground, muted, surface, border, error]);
  const documentInput = useMemo(() => ({ input, theme, computerId }), [input, theme, computerId]);
  // Theme/scope changes replace the page without replacing this owner.
  const currentDocument = useRef(documentInput);
  useLayoutEffect(() => { currentDocument.current = documentInput; }, [documentInput]);
  const [loaded, setLoaded] = useState<{ input: typeof documentInput; page: MermaidPage }>();
  const page = loaded?.input === documentInput ? loaded.page : undefined;
  const [readyFor, setReadyFor] = useState<typeof documentInput>();
  const ready = readyFor === documentInput;
  const frame = useRef<HTMLIFrameElement>(null);
  const nativeFrame = useRef<WebView>(null);
  const readyDocument = useRef<typeof documentInput | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (layout.full) onStatus?.({ ready: false, zoom: savedViewportRef.current?.layout === layout ? savedViewportRef.current.viewport.zoom : 1 });
    let active = true;
    let prepared: MermaidPage | undefined;
    const dispose = () => {
      try { prepared?.dispose?.(); }
      catch (error) { console.warn('Could not remove diagram content file', error); }
    };
    const restore = layout.full && savedViewportRef.current?.layout === layout && savedViewportRef.current.day === input.day ? savedViewportRef.current.viewport : undefined;
    void prepareMermaidPage(input, theme, computerId, mermaidCache.get(input, computerId), restore).then(result => {
      prepared = result;
      if (active && currentDocument.current === documentInput) setLoaded({ input: documentInput, page: result });
      else dispose();
    }, () => { if (active && currentDocument.current === documentInput) onFailure('failed'); });
    return () => { active = false; dispose(); };
  }, [documentInput, input, theme, computerId, layout, savedViewportRef, onStatus, onFailure]);
  useEffect(() => {
    if (!page || ready) return;
    // Unmounting the failed frame releases the renderer, not merely a Promise waiter.
    const timeout = setTimeout(() => onFailure('timeout'), 5000);
    return () => clearTimeout(timeout);
  }, [page, ready, onFailure]);
  function handle(data: string) {
    if (!alive.current || !page || currentDocument.current !== documentInput) return;
    const event = parseMermaidEvent(data);
    if (!event) return;
    if (event.kind === 'error') { onFailure(event.code); return; }
    if (event.kind === 'viewport') {
      if (layout.full) {
        savedViewportRef.current = { layout, day: input.day, viewport: event.viewport };
        onStatus?.({ ready: readyDocument.current === documentInput, zoom: event.viewport.zoom });
      }
      return;
    }
    mermaidCache.put(input, computerId, { svg: event.svg, width: event.width, height: event.height });
    if (!layout.full) onRendered?.({ width: event.width, height: event.height });
    readyDocument.current = documentInput;
    setReadyFor(documentInput);
    if (layout.full) onStatus?.({ ready: true, zoom: savedViewportRef.current?.layout === layout ? savedViewportRef.current.viewport.zoom : 1 });
  }
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const receive = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && typeof event.data === 'string') handle(event.data);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  });
  useLayoutEffect(() => {
    if (!layout.full || !page) return;
    // Dispatch each press directly: React batching must not merge rapid actions,
    // and a new frame restores geometry rather than replaying the previous press.
    const send: CommandSender = action => {
      if (!alive.current || currentDocument.current !== documentInput || readyDocument.current !== documentInput) return;
      const data = JSON.stringify({ kind: 'mermaid-control', id: ++commandIdRef.current, action } satisfies MermaidCommand);
      if (Platform.OS === 'web') frame.current?.contentWindow?.postMessage(data, '*');
      else nativeFrame.current?.postMessage(data);
    };
    senderRef.current = send;
    return () => { if (senderRef.current === send) senderRef.current = undefined; };
  }, [commandIdRef, documentInput, layout.full, page, senderRef]);
  const height = Math.max(48, viewportHeight);
  if (!page) return <View style={{ height }} className="items-center justify-center"><ActivityIndicator /></View>;
  return <View style={{ width: '100%', height }} testID={ready ? 'mermaid-ready' : 'mermaid-loading'}>
    {Platform.OS === 'web'
      ? <iframe ref={frame} title={t('流程图')} sandbox="allow-scripts" srcDoc={'html' in page.source ? page.source.html : undefined}
          onError={() => onFailure('failed')} style={{ border: 0, width: '100%', height: '100%', background: 'transparent' }} />
      : <WebView ref={nativeFrame} source={page.source} allowingReadAccessToURL={page.readAccessUrl}
          style={{ flex: 0, width: '100%', height, backgroundColor: 'transparent' }} accessibilityLabel={t('流程图')}
          originWhitelist={['*']} javaScriptEnabled domStorageEnabled={false}
          allowFileAccess allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never" setSupportMultipleWindows={false} scrollEnabled={false} nestedScrollEnabled={false}
          onShouldStartLoadWithRequest={request => 'uri' in page.source && request.url === page.source.uri}
          onMessage={event => handle(event.nativeEvent.data)}
          onError={() => onFailure('failed')} onHttpError={() => onFailure('failed')}
          onRenderProcessGone={() => onFailure('failed')} onContentProcessDidTerminate={() => onFailure('failed')} />}
  </View>;
}

/** Observe touch validity without claiming gestures from the parent chat. */
type TouchPoint = { pageX: number; pageY: number };
type TouchPositionEvent = {
  touches: ArrayLike<TouchPoint>;
  changedTouches?: ArrayLike<TouchPoint>;
  pageX?: number;
  pageY?: number;
};

function touchPosition(event: TouchPositionEvent, released = false) {
  const point = released ? event.changedTouches?.[0] : event.touches[0] ?? event.changedTouches?.[0];
  const x = point?.pageX ?? event.pageX;
  const y = point?.pageY ?? event.pageY;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? { x, y } : undefined;
}

function PreviewOpen({ onOpen, pill = true }: { onOpen: () => void; pill?: boolean }) {
  const { t } = useTranslation();
  // undefined: no pending touch; null: pending touch was rejected.
  const touch = useRef<{ x: number; y: number } | null | undefined>(undefined);
  return <Pressable className="absolute inset-0" testID="mermaid-preview-open"
    accessibilityRole="button" accessibilityLabel={t('全屏查看流程图')}
    accessibilityHint={t('轻点预览以全屏查看流程图')}
    onTouchStart={({ nativeEvent: event }) => {
      touch.current = event.touches.length === 1 ? touchPosition(event) ?? null : null;
    }}
    onTouchMove={({ nativeEvent: event }) => {
      const start = touch.current;
      if (start) {
        const position = touchPosition(event);
        if (event.touches.length !== 1 || !position || Math.hypot(position.x - start.x, position.y - start.y) > 10) {
          touch.current = null;
        }
      }
    }}
    onTouchEnd={({ nativeEvent: event }) => {
      const start = touch.current;
      if (start) {
        const position = touchPosition(event, true);
        if (event.touches.length !== 0 || !position || Math.hypot(position.x - start.x, position.y - start.y) > 10) {
          touch.current = null;
        }
      }
    }}
    onTouchCancel={() => { touch.current = null; }}
    onPress={({ nativeEvent: event }) => {
      // RN Web delivers a click (MouseEvent/PointerEvent), not a TouchEvent.
      const click = event as typeof event & {
        type?: string; detail?: number; pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean };
      };
      const nativeTouch = Array.isArray(click.touches);
      const ambiguousClick = click.type === 'click' && click.detail !== 0 &&
        click.pointerType !== 'mouse' && click.pointerType !== 'pen' && click.sourceCapabilities?.firesTouchEvents !== false;
      const fromTouch = nativeTouch || (click.detail !== 0 && click.type !== 'keyup' &&
        (click.pointerType === 'touch' || click.sourceCapabilities?.firesTouchEvents === true ||
          (ambiguousClick && touch.current !== undefined)));
      const start = touch.current;
      let accepted = !fromTouch || start != null;
      // Fabric may deliver onPress before onTouchEnd; its release coordinates are authoritative.
      if (nativeTouch && start) {
        const end = touchPosition(click, true);
        if (click.touches.length !== 0 || !end || Math.hypot(end.x - start.x, end.y - start.y) > 10) accepted = false;
      }
      touch.current = undefined;
      if (accepted) onOpen();
    }}>
    {pill ? <View className="absolute border border-border bg-card" style={{ bottom: richSpace.sm, right: richSpace.sm, borderRadius: richRadius.full, paddingHorizontal: richSpace.md, paddingVertical: richSpace.xs }}>
      <Text className="text-muted-foreground" style={richType.caption}>{t('点击放大')}</Text>
    </View> : null}
  </Pressable>;
}

/** Native presentation keeps the inline preview inert except for opening fullscreen.
 * Code view releases its renderer; fullscreen alone retains a viewport for reacquisition. */
export function MermaidViewer({ source, title, full = false, onOpen, onBack }: {
  source: string; title?: string; full?: boolean;
  onOpen?: () => void; onBack?: () => void;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState({ source, view: 'preview' as 'code' | 'preview' });
  const [failure, setFailure] = useState<{ source: string; message: string | null }>();
  const [status, setStatus] = useState({ source, ready: false, zoom: 1 });
  const controlRef = useRef<DiagramControl>(null);
  const error = failure?.source === source ? failure.message : null;
  const selected = selection.source === source ? selection.view : 'preview';
  const view = error ? 'code' : selected;
  const ready = status.source === source && status.ready;
  const zoom = status.source === source ? status.zoom : 1;
  const onError = useCallback((message: string | null) => setFailure(previous =>
    previous?.source === source && previous.message === message ? previous : { source, message }), [source]);
  const onStatus = useCallback((next: DiagramStatus) => setStatus(previous => {
    // Geometry snapshots stay in the renderer; native controls only need bounds.
    const value = next.zoom <= 1.001 ? 1 : next.zoom >= 32 ? 32 : 2;
    return previous.source === source && previous.ready === next.ready && previous.zoom === value
      ? previous : { source, ready: next.ready, zoom: value };
  }), [source]);
  const control: CommandSender = action => controlRef.current?.run(action);
  if (!full) return <InlineMermaid source={source} title={title} onOpen={onOpen} view={view} error={error}
    onViewChange={next => setSelection({ source, view: next })} onError={onError} />;
  return <View className="min-h-0 flex-1">
    <View className="flex-row items-center border-b border-border" style={{ gap: richSpace.sm, paddingHorizontal: richSpace.lg, paddingVertical: richSpace.sm }}>
      {onBack ? <Button variant="ghost" size="icon" style={{ width: richGeometry.touch, height: richGeometry.touch, borderRadius: richRadius.full }} accessibilityLabel={t('返回')} onPress={onBack}>
        <Icon as={ArrowLeft} className="size-5" /></Button> : null}
      <View className="min-w-0 flex-1"><Text numberOfLines={1} style={richType.title}>{title || t('流程图')}</Text></View>
      <MermaidToolbar full view={view} onViewChange={next => setSelection({ source, view: next })}
        canPreview={!error} controls={{ ready, zoomed: zoom > 1, onReset: () => control('reset') }} />
    </View>
    <View className="relative min-h-0 flex-1 overflow-hidden" style={{ padding: richSpace.md }}>
      <MermaidDiagram ref={controlRef} source={source} full visible={view === 'preview'} onError={onError} onStatus={onStatus} />
      {view === 'code' ? <View className="absolute inset-0 bg-card" style={{ padding: richSpace.md }}>
        {error ? <Text className="text-destructive" style={{ ...richType.subtle, marginBottom: richSpace.sm }} accessibilityRole="alert">{t(error)}</Text> : null}
        <ScrollView className="min-h-0 flex-1 bg-muted" style={{ borderRadius: richRadius.small }} testID="media-viewer-source">
          <Text selectable className="font-mono" style={{ ...richType.caption, padding: richSpace.md }}>{source}</Text>
        </ScrollView>
      </View> : <View className="absolute flex-row border border-border bg-card" style={{ bottom: richSpace.xl, right: richSpace.xl, gap: richSpace.xs, borderRadius: richRadius.full }}>
        <Button variant="ghost" size="icon" testID="mermaid-full-zoom-out" style={{ width: richGeometry.touch, height: richGeometry.touch, borderRadius: richRadius.full }}
          accessibilityLabel={t('缩小流程图')} disabled={!ready || zoom <= 1} onPress={() => control('out')}>
          <Icon as={Minus} className="size-4" /></Button>
        <Button variant="ghost" size="icon" testID="mermaid-full-zoom-in" style={{ width: richGeometry.touch, height: richGeometry.touch, borderRadius: richRadius.full }}
          accessibilityLabel={t('放大流程图')} disabled={!ready || zoom >= 32} onPress={() => control('in')}>
          <Icon as={Plus} className="size-4" /></Button>
      </View>}
    </View>
  </View>;
}

/**
 * Inline chat preview (`Mermaid.waiting` / `.fit` / `.tall` / `.code` / `.error`). The viewport height follows the
 * rendered diagram (cached size first, 160 while unknown) up to 320; taller diagrams show a hint to open them.
 * Code view and the error source are in-flow, content-high and scroll inside 320. The diagram stays mounted (hidden)
 * in code / error view so its renderer state and the error report persist.
 */
function InlineMermaid({ source, title, onOpen, view, error, onViewChange, onError }: {
  source: string; title?: string; onOpen?: () => void; view: 'code' | 'preview'; error: string | null;
  onViewChange: (view: 'code' | 'preview') => void; onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const computerId = useSession()?.api.config.computerId ?? 'offline';
  const [boxWidth, setBoxWidth] = useState(0);
  const [rendered, setRendered] = useState<{ key: string; size: MermaidNaturalSize }>();
  const [sourceOpen, setSourceOpen] = useState(false);
  const width = Math.floor(boxWidth);
  const key = JSON.stringify([source, width]);
  // The cache key includes the UTC day of the render; read it once rather than on every render.
  const [day] = useState(() => new Date().toISOString().slice(0, 10));
  const cached = width > 0 ? mermaidCache.get({ source, width, full: false, day }, computerId) : undefined;
  const natural = rendered?.key === key ? rendered.size : cached ? { width: cached.width, height: cached.height } : undefined;
  const { height, tall } = mermaidInlineHeight(natural, boxWidth);
  const onRendered = useCallback((size: MermaidNaturalSize) => setRendered({ key, size }), [key]);
  const preview = view === 'preview' && !error;
  return <View style={{ gap: richSpace.sm }} onLayout={event => setBoxWidth(event.nativeEvent.layout.width)}>
    <View className="flex-row items-center" style={{ gap: richSpace.sm }}>
      <View className="min-w-0 flex-1"><RichText style={richType.title}>{title || t('流程图')}</RichText></View>
      {error ? null : <MermaidToolbar full={false} view={view} onViewChange={onViewChange} canPreview />}
    </View>
    <View className="relative overflow-hidden" style={{ height, display: preview ? 'flex' : 'none' }}>
      <MermaidDiagram source={source} visible={preview} height={height} onError={onError} onRendered={onRendered} />
      {preview && onOpen ? <PreviewOpen onOpen={onOpen} pill={!tall} /> : null}
    </View>
    {preview && tall ? <Text testID="mermaid-tall-hint" className="text-muted-foreground" style={richType.subtle}>{t('点开查看完整流程')}</Text> : null}
    {error ? <View style={{ gap: richSpace.xs }} testID="rich-mermaid-error">
      <Text className="text-muted-foreground" style={richType.subtle} accessibilityRole="alert">{t('流程图无法显示')}</Text>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: sourceOpen }} onPress={() => setSourceOpen(!sourceOpen)}
        className="flex-row items-center self-start" style={{ minHeight: richGeometry.touch, gap: richSpace.xs }} testID="mermaid-error-source-toggle">
        <Text className="text-foreground" style={richType.subtle}>{sourceOpen ? t('收起源码') : t('查看源码')}</Text>
        <Icon as={sourceOpen ? ChevronUp : ChevronDown} size={14} className="text-muted-foreground" />
      </Pressable>
      {sourceOpen ? <MermaidSource source={source} /> : null}
    </View> : view === 'code' ? <MermaidSource source={source} /> : null}
  </View>;
}

/** `Mermaid.code`: monospace source, content-high, scrolling inside 320. */
function MermaidSource({ source }: { source: string }) {
  return <ScrollView nestedScrollEnabled className="bg-muted" style={{ maxHeight: MERMAID_INLINE_MAX, flexGrow: 0, borderRadius: richRadius.small }} testID="rich-mermaid-source">
    <Text selectable className="font-mono" style={{ ...richType.caption, padding: richSpace.md }}>{source}</Text>
  </ScrollView>;
}

export function MermaidPicture({ title, source, location }: { title?: string; source: string; location?: MediaLocation }) {
  const { t } = useTranslation();
  const open = location ? () => {
    router.push({ pathname: '/media-viewer', params: { id: location.conversationId, seq: String(location.messageSeq),
      block: String(location.block), element: location.element, index: String(location.index), alt: title ?? t('流程图') } });
  } : undefined;
  // A+ read-only content: no frame (user chose frameless on the chat comparison, 2026-11-01).
  return <View testID="rich-mermaid">
    <MermaidViewer source={source} title={title} onOpen={open} />
  </View>;
}
