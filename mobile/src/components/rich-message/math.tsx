import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text as NativeText, View, type TextProps } from 'react-native';
import WebView from 'react-native-webview';
import { useCSSVariable, useResolveClassNames } from 'uniwind';

import { Text } from '@/components/ui/text.tsx';
import type { MathPage } from '@/lib/math-document.ts';
import { useSession } from '@/lib/session-context.tsx';
import { useTranslation } from '@/lib/i18n.ts';
import { prepareMathPage } from './math-page';
import { mathNode, safeWebLink } from '@/lib/math-html.ts';
import { splitMathText, MAX_MATH_SOURCE } from '@/lib/math-markdown.ts';
import { inlineHasMath, parseRichInline, richInlineHtml, type InlinePart } from './inline-text.ts';
import { renderBudget } from '@/lib/render-budget.ts';
import { observeRenderVisibility } from './render-visibility.ts';
import { richType } from './tokens.ts';

const MAX_HTML = 100_000;
const MAX_HEIGHT = 8192;
const FALLBACK_HEIGHT = 54;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s,.%]+\))$/i.test(value) ? value : fallback;
}

type MathContentProps = { html: string; source: string; className?: string; style?: TextProps['style']; accessibilityLabel?: string; testID?: string; pointerEvents?: TextProps['pointerEvents'] };

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
  const eligible = focused && near && props.html !== failedHtml && props.html.length <= MAX_HTML;
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
    {eligible && permitted
      ? <ActiveMathContent {...props} onFailure={() => setFailedHtml(props.html)} />
      : <Text selectable className={props.className} style={props.style}>{props.source}</Text>}
  </View>;
}

/** One isolated offline renderer, mounted only while its outer owner has a permit. */
function ActiveMathContent({ html, source, className, style, accessibilityLabel, pointerEvents, onFailure }: MathContentProps & { onFailure: () => void }) {
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
  const [showSource, setShowSource] = useState(false);
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
      } else if (payload.kind === 'error') {
        setFailed(true);
      } else if (payload.kind === 'link' && typeof payload.href === 'string' && safeWebLink(payload.href)) {
        void Linking.openURL(payload.href);
      }
    } catch { /* Untrusted bridge data has no effects. */ }
  }
  if (html.length > MAX_HTML || failed || !page) return <Text selectable className={className} style={style} pointerEvents={pointerEvents}>{source}</Text>;
  return <View pointerEvents={pointerEvents} style={{ width: '100%', minWidth: 0 }}>
    {Platform.OS === 'web'
      ? <iframe ref={frame} title={t('数学内容：{source}', { source: (accessibilityLabel ?? source).slice(0, 4000) })} sandbox="allow-scripts" srcDoc={'html' in page.source ? page.source.html : undefined} onError={() => setFailed(true)} style={{ border: 0, width: '100%', height, background: 'transparent' }} />
      : <WebView source={page.source} allowingReadAccessToURL={page.readAccessUrl}
          style={{ flex: 0, width: '100%', height, backgroundColor: 'transparent' }} accessibilityLabel={(accessibilityLabel ?? source).slice(0, 4000)}
          originWhitelist={['*']} javaScriptEnabled domStorageEnabled={false}
          allowFileAccess allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false} mixedContentMode="never" scrollEnabled={height === MAX_HEIGHT}
          onShouldStartLoadWithRequest={request => 'uri' in page.source && request.url === page.source.uri}
          onMessage={event => handle(event.nativeEvent.data)}
          onError={() => setFailed(true)} onHttpError={() => setFailed(true)}
          onRenderProcessGone={() => setFailed(true)} onContentProcessDidTerminate={() => setFailed(true)} />}
    {pointerEvents !== 'none' ? <Pressable accessibilityRole="button" accessibilityLabel={showSource ? t('隐藏公式源码') : t('查看公式源码')} onPress={() => setShowSource(value => !value)}>
      <Text style={richType.caption} className="text-muted-foreground">{showSource ? t('隐藏公式源码') : t('查看公式源码')}</Text>
    </Pressable> : null}
    {showSource ? <Text selectable style={richType.caption} className="text-muted-foreground">{source}</Text> : null}
  </View>;
}

/** A standalone formula; TeX is passed directly, without Markdown delimiter scanning. */
export function RichMath({ tex, display = true }: { tex: string; display?: boolean }) {
  if (!tex.trim() || tex.length > MAX_MATH_SOURCE) return <Text selectable style={richType.body}>{tex}</Text>;
  return <MathContent html={mathNode(tex, display)} source={tex} style={richType.body} />;
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
