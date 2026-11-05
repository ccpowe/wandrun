import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Linking, Platform, Pressable, StyleSheet, Text as NativeText, View, type TextProps } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ChevronDown, ChevronUp, Copy } from 'lucide-react-native';
import WebView from 'react-native-webview';
import { useCSSVariable, useResolveClassNames } from 'uniwind';

import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import type { MathPage } from '@/lib/math-document.ts';
import { useSession } from '@/lib/session-context.tsx';
import { useTranslation } from '@/lib/i18n.ts';
import { prepareMathPage } from './math-page';
import { formulaSources, mathNode, safeWebLink } from '@/lib/math-html.ts';
import { splitMathText, MAX_MATH_SOURCE } from '@/lib/math-markdown.ts';
import { inlineHasMath, parseRichInline, richInlineHtml, type InlinePart } from './inline-text.ts';
import { renderBudget } from '@/lib/render-budget.ts';
import { observeRenderVisibility } from './render-visibility.ts';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';

const MAX_HTML = 100_000;
const MAX_HEIGHT = 8192;
const FALLBACK_HEIGHT = 54;
const BUBBLE_HEIGHT = 32;
/** Window space a bubble needs above a formula: status bar and chat header overlay plus the bubble itself. */
const BUBBLE_ROOM = 120;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s,.%]+\))$/i.test(value) ? value : fallback;
}

type MathContentProps = { html: string; source: string; className?: string; style?: TextProps['style']; accessibilityLabel?: string; testID?: string; pointerEvents?: TextProps['pointerEvents']; onManagedLink?: (href: string) => boolean;
  /** A standalone formula block (`Math` component): a KaTeX failure replaces it with `Math.error`. */
  standalone?: boolean };

/** All formula entry points share visibility and a global four-frame budget.
 * Inactive blocks retain source and their measured height; no page is prepared.
 * Active pages reference one application-owned pair of KaTeX resources. */
export function MathContent(props: MathContentProps) {
  const view = useRef<View>(null);
  const focused = useIsFocused();
  const [near, setNear] = useState(false);
  const [permitted, setPermitted] = useState(false);
  const [measurement, setMeasurement] = useState<{ html: string; height: number }>();
  const [failedHtml, setFailedHtml] = useState<string>();
  // Formula-level KaTeX failures in a standalone block: show a reason with collapsible source, release the frame.
  const [invalidHtml, setInvalidHtml] = useState<string>();
  const invalid = props.standalone && invalidHtml === props.html;
  const eligible = focused && near && props.html !== failedHtml && !invalid && props.html.length <= MAX_HTML;
  useEffect(() => {
    if (!focused || !view.current) return;
    const stop = observeRenderVisibility(view.current, setNear);
    return () => { stop(); setNear(false); };
  }, [focused]);
  useEffect(() => {
    if (!eligible) return;
    const cancel = renderBudget.request(() => setPermitted(true));
    return () => {
      // Passive cleanup runs after the old frame leaves the committed tree.
      setPermitted(false);
      cancel();
    };
  }, [eligible]);
  return <View ref={view} collapsable={false} testID={props.testID} pointerEvents={props.pointerEvents}
    className={props.className}
    onLayout={event => {
      if (eligible && permitted) setMeasurement({ html: props.html, height: event.nativeEvent.layout.height });
    }}
    style={{ width: '100%', minWidth: 0, minHeight: !eligible || !permitted
      ? measurement?.html === props.html ? measurement.height : undefined : undefined }}>
    {invalid || props.standalone && props.html === failedHtml ? <MathError source={props.source} />
      : eligible && permitted
        ? <ActiveMathContent {...props} onFailure={() => setFailedHtml(props.html)}
          onFormulaError={props.standalone ? () => setInvalidHtml(props.html) : undefined} />
        : <Text selectable className={props.className} style={props.style}>{props.source}</Text>}
  </View>;
}

/** One isolated offline renderer, mounted only while its outer owner has a permit. */
function ActiveMathContent({ html, source, className, style, accessibilityLabel, pointerEvents, onManagedLink, onFailure, onFormulaError }: MathContentProps & { onFailure: () => void; onFormulaError?: () => void }) {
  const { t } = useTranslation();
  const computerId = useSession()?.api.config.computerId ?? 'offline';
  const [foreground, mutedValue, borderValue] = useCSSVariable(['--color-foreground', '--color-muted', '--color-border']);
  const resolved = useResolveClassNames(className ?? '');
  const textStyle = StyleSheet.flatten([resolved, style]);
  const color = safeColor(textStyle?.color, safeColor(foreground, '#141414'));
  const muted = safeColor(mutedValue, '#F0F0ED');
  const border = safeColor(borderValue, '#E3E3DF');
  const fontSize = typeof textStyle?.fontSize === 'number' && textStyle.fontSize >= 8 && textStyle.fontSize <= 48 ? textStyle.fontSize : richType.body.fontSize;
  const input = useMemo(() => ({ html, theme: { color, muted, border, fontSize }, computerId }), [html, color, muted, border, fontSize, computerId]);
  const [loaded, setLoaded] = useState<{ input: typeof input; page: MathPage }>();
  const page = loaded?.input === input ? loaded.page : undefined;
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  // Math.source: a long press on one formula (the page highlights it and reports its index and box) shows a small
  // “复制源码” bubble above it, or below when there is no room above; a tap or copy dismisses it.
  const [bubble, setBubble] = useState<{ index: number; top: number; bottom: number; below: boolean }>();
  const host = useRef<View>(null);
  const nativeFrame = useRef<WebView>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [renderedInput, setRenderedInput] = useState(input);
  // Reset before children commit a new document, not in a post-commit effect.
  if (renderedInput !== input) {
    setRenderedInput(input);
    setHeight(FALLBACK_HEIGHT);
    setFailed(false);
    setReady(false);
  }
  useEffect(() => {
    let active = true;
    let prepared: MathPage | undefined;
    const dispose = () => {
      try { prepared?.dispose?.(); }
      catch (error) { console.warn('Could not remove math content file', error); }
    };
    void prepareMathPage(input.html, input.theme, input.computerId).then(page => {
      prepared = page;
      if (active) setLoaded({ input, page });
      else dispose(); // An unmount/theme change cannot orphan a late content file.
    }, () => { if (active) setFailed(true); });
    return () => { active = false; dispose(); };
  }, [input]);
  useEffect(() => {
    if (!page || ready || failed) return;
    const timeout = setTimeout(() => setFailed(true), 5000);
    return () => clearTimeout(timeout);
  }, [page, ready, failed]);
  useEffect(() => {
    if (failed) onFailure();
  }, [failed, onFailure]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    function receive(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || typeof event.data !== 'string' || event.data.length > 2200) return;
      handle(event.data);
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  });
  function handle(data: string) {
    if (data.length > 2200) return;
    try {
      const message: unknown = JSON.parse(data);
      if (!message || typeof message !== 'object') return;
      const payload = message as Record<string, unknown>;
      if (payload.kind === 'height' && typeof payload.height === 'number' && Number.isFinite(payload.height) && payload.height > 0) {
        setHeight(Math.min(Math.ceil(payload.height), MAX_HEIGHT));
        setReady(true);
        if (typeof payload.failed === 'number' && payload.failed > 0) onFormulaError?.();
      } else if (payload.kind === 'error') {
        setFailed(true);
      } else if (payload.kind === 'longpress' && typeof payload.index === 'number' && typeof payload.top === 'number' && typeof payload.bottom === 'number') {
        if (pointerEvents === 'none') return;
        const { index, top, bottom } = payload;
        // Flip below when the formula sits near the top of the window (status bar + chat header + bubble).
        const place = (y: number) => setBubble({ index, top, bottom, below: y + top < BUBBLE_ROOM });
        if (host.current?.measureInWindow) host.current.measureInWindow((_x, y) => place(y));
        else place(BUBBLE_ROOM); // Hosts without window geometry keep the default above placement.
      } else if (payload.kind === 'tap') {
        setBubble(undefined);
      } else if (payload.kind === 'link' && typeof payload.href === 'string') {
        if (onManagedLink?.(payload.href)) return;
        if (safeWebLink(payload.href)) void Linking.openURL(payload.href);
      }
    } catch { /* Untrusted bridge data has no effects. */ }
  }
  if (html.length > MAX_HTML || failed || !page) return <Text selectable className={className} style={style} pointerEvents={pointerEvents}>{source}</Text>;
  const dismiss = () => {
    setBubble(undefined);
    const data = JSON.stringify({ kind: 'clear-press' });
    if (Platform.OS === 'web') frame.current?.contentWindow?.postMessage(data, '*');
    else nativeFrame.current?.postMessage?.(data);
  };
  const copySource = async (index: number) => {
    dismiss();
    try {
      if (!await Clipboard.setStringAsync(formulaSources(html)[index] ?? source)) throw new Error('clipboard unavailable');
      AccessibilityInfo.announceForAccessibility(t('已复制'));
    } catch {
      AccessibilityInfo.announceForAccessibility(t('无法复制'));
    }
  };
  return <View ref={host} pointerEvents={pointerEvents} style={{ width: '100%', minWidth: 0 }} testID={bubble ? 'math-source-active' : undefined}>
    {Platform.OS === 'web'
      ? <iframe ref={frame} title={t('数学内容：{source}', { source: (accessibilityLabel ?? source).slice(0, 4000) })} sandbox="allow-scripts" srcDoc={'html' in page.source ? page.source.html : undefined} onError={() => setFailed(true)} style={{ border: 0, width: '100%', height, background: 'transparent' }} />
      : <WebView ref={nativeFrame} source={page.source} allowingReadAccessToURL={page.readAccessUrl}
          style={{ flex: 0, width: '100%', height, backgroundColor: 'transparent' }} accessibilityLabel={(accessibilityLabel ?? source).slice(0, 4000)}
          originWhitelist={['*']} javaScriptEnabled domStorageEnabled={false}
          allowFileAccess allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false} mixedContentMode="never" scrollEnabled={height === MAX_HEIGHT}
          onShouldStartLoadWithRequest={request => 'uri' in page.source && request.url === page.source.uri}
          onMessage={event => handle(event.nativeEvent.data)}
          onError={() => setFailed(true)} onHttpError={() => setFailed(true)}
          onRenderProcessGone={() => setFailed(true)} onContentProcessDidTerminate={() => setFailed(true)} />}
    {bubble ? <View pointerEvents="box-none" className="absolute inset-x-0 items-center"
      style={{ top: bubble.below ? bubble.bottom + richSpace.sm : bubble.top - BUBBLE_HEIGHT - richSpace.sm }} testID={bubble.below ? 'math-copy-below' : 'math-copy-above'}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('复制源码')} testID="math-copy-source" hitSlop={8}
        onPress={() => { void copySource(bubble.index); }} className="bg-foreground flex-row items-center"
        style={{ height: BUBBLE_HEIGHT, gap: richSpace.xs, paddingHorizontal: richSpace.md, borderRadius: BUBBLE_HEIGHT / 2 }}>
        <Icon as={Copy} size={14} className="text-background" />
        <Text className="text-background" style={[richType.caption, { fontWeight: '500' }]}>{t('复制源码')}</Text>
      </Pressable>
    </View> : null}
  </View>;
}

/** `Math.error`: one reason line with the TeX behind “查看源码”. */
function MathError({ source }: { source: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <View style={{ gap: richSpace.xs }} testID="math-error">
    <Text className="text-muted-foreground" style={richType.subtle} accessibilityRole="alert">{t('公式无法显示')}</Text>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} testID="math-error-source-toggle"
      className="flex-row items-center self-start" style={{ minHeight: richGeometry.touch, gap: richSpace.xs }}>
      <Text className="text-foreground" style={richType.subtle}>{open ? t('收起源码') : t('查看源码')}</Text>
      <Icon as={open ? ChevronUp : ChevronDown} size={14} className="text-muted-foreground" />
    </Pressable>
    {open ? <View className="bg-muted" style={{ borderRadius: richRadius.small, padding: richSpace.md }}>
      <Text selectable className="font-mono" style={richType.caption}>{source}</Text>
    </View> : null}
  </View>;
}

/** A standalone formula; TeX is passed directly, without Markdown delimiter scanning. */
export function RichMath({ tex, display = true }: { tex: string; display?: boolean }) {
  if (!tex.trim() || tex.length > MAX_MATH_SOURCE) return <Text selectable style={richType.body}>{tex}</Text>;
  return <MathContent html={mathNode(tex, display)} source={tex} style={richType.body} standalone />;
}

function nativeInline(parts: readonly InlinePart[]): ReactNode {
  return parts.map((part, index) => {
    switch (part.kind) {
      case 'text': return part.text;
      case 'code': return <NativeText key={index} className="bg-muted font-mono">{part.text}</NativeText>;
      case 'strong': return <NativeText key={index} style={{ fontWeight: richType.title.fontWeight }}>{nativeInline(part.children)}</NativeText>;
      case 'em': return <NativeText key={index} className="italic">{nativeInline(part.children)}</NativeText>;
      case 'math': return null; // Formula-bearing labels use the single HTML projection instead.
    }
  });
}

/** Opt-in inline labels use native Text until a formula requires one local WebView. */
export function RichText({ children, className, inline = false, ...props }: TextProps & { children?: ReactNode; className?: string; inline?: boolean }) {
  if (typeof children !== 'string') return <Text className={className} {...props}>{children}</Text>;
  if (inline) {
    const parts = parseRichInline(children);
    if (!inlineHasMath(parts)) return <Text className={className} {...props}>{nativeInline(parts)}</Text>;
    return <MathContent html={richInlineHtml(parts)} source={children} className={className} style={props.style}
      accessibilityLabel={props.accessibilityLabel} testID={props.testID} pointerEvents={props.pointerEvents} />;
  }
  const parts = splitMathText(children);
  if (!parts.some(part => 'tex' in part)) return <Text className={className} {...props}>{children}</Text>;
  const html = parts.map(part => 'tex' in part ? mathNode(part.tex, part.display) : escapeHtml(part.text)).join('');
  return <MathContent html={html} source={children} className={className} style={props.style} accessibilityLabel={props.accessibilityLabel} testID={props.testID} pointerEvents={props.pointerEvents} />;
}
