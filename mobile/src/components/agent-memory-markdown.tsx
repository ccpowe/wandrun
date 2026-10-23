import * as Clipboard from "expo-clipboard";
import { ChevronRight, Copy, ExternalLink } from "lucide-react-native";
import { cloneElement, isValidElement, memo, useMemo, useState, type ReactElement } from "react";
import type { default as MarkdownIt, Token } from "markdown-it";
import Markdown, { renderRules as defaultRules, type ASTNode, type RenderRules } from "react-native-markdown-display";
import { AccessibilityInfo, Alert, Linking, Platform, Pressable, ScrollView, Text as NativeText, View, type TextProps, type TextStyle } from "react-native";
import { useCSSVariable } from "uniwind";

import { Text } from "@/components/ui/text.tsx";
import { DropdownMenu, DropdownMenuAnchor, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { MediaPicture } from "@/components/rich-message/media.tsx";
import { DrawerHorizontalGesture } from "@/components/chat/drawer-horizontal-gesture.tsx";
import type { AgentMemory, GatewayApi } from "@/gateway/api.ts";
import type { MessageMarkdownTokens } from "@/lib/agent-message-markdown.ts";
import { MathContent } from "@/components/rich-message/math.tsx";
import { containsMath, groupMarkdownBlocks, mathBlockHtml } from "@/lib/math-html.ts";
import { createMarkdown } from "@/lib/markdown.ts";
import { groupSelectableMarkdown, type SelectablePart, type SelectableSpan } from "@/lib/selectable-markdown.ts";
import { managedMemorySlug } from "@/lib/agent-memory.ts";
import { userErrorMessage } from "@/lib/user-error.ts";
import { t, useTranslation } from "@/lib/i18n.ts";

function containsImage(nodes: ASTNode[]): boolean {
  return nodes.some((child) => child.type === 'image' || containsImage(child.children ?? []));
}

function containsImageTokens(tokens: readonly Token[]): boolean {
  return tokens.some(token => token.type === 'image' || !!token.children && containsImageTokens(token.children));
}

type MathParagraphPart = { tokens: Token[]; source: string } | { image: Token };

/** Split only images at the paragraph's inline root; nesting across an image cannot be
 * projected as independently balanced HTML without changing its formatting. */
function splitMathParagraphImages(block: readonly Token[]): MathParagraphPart[] | null {
  if (block.length !== 3 || block[0].type !== 'paragraph_open' ||
      block[1].type !== 'inline' || block[2].type !== 'paragraph_close') return null;
  const inline = block[1];
  const children = inline.children ?? [];
  let depth = 0;
  const positions: number[] = [];
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child.type === 'image') {
      if (depth !== 0) return null;
      positions.push(index);
    }
    depth += child.nesting;
  }
  if (!positions.length) return null;
  const parts: MathParagraphPart[] = [];
  let start = 0;
  for (let step = 0; step <= positions.length; step++) {
    const position = step < positions.length ? positions[step] : children.length;
    if (start < position) {
      const fragment = children.slice(start, position);
      parts.push({
        tokens: [block[0], Object.assign(Object.create(Object.getPrototypeOf(inline)) as Token, inline, { children: fragment }), block[2]],
        source: fragment.map(token => token.type === 'math_inline' ? `$${token.content}$` : token.content).join(''),
      });
    }
    if (position < children.length) parts.push({ image: children[position] });
    start = position + 1;
  }
  return parts;
}

function renderImageToken(image: Token, key: string, api?: GatewayApi, conversationId?: string, messageSeq?: number) {
  const index = image.meta?.wandrunMediaIndex;
  const alt = image.content || image.attrGet('src') || '';
  return api && conversationId !== undefined && messageSeq !== undefined && typeof index === 'number'
    ? <MediaPicture key={key} api={api} location={{ conversationId, messageSeq, block: 'markdown', element: 'image', index }} alt={alt} height="auto" />
    : <Text key={key}>{t("[图片：{alt}]", { alt })}</Text>;
}


// Memory can come from the Agent or an external file: never interpret raw HTML, launch custom URL
// schemes, or automatically download image URLs merely because the profile was opened.
const markdown = createMarkdown();
const rules: RenderRules = {
  ...defaultRules,
  image: (node, _children, _parents, styles) => (
    <Text key={node.key} style={styles.link}>{t("[图片：{alt}]", { alt: node.attributes.alt || node.attributes.src })}</Text>
  ),
  math_inline: (node) => <Text key={node.key}>{`$${node.content}$`}</Text>,
  math_block: (node) => <Text key={node.key}>{`$$${node.content}$$`}</Text>,
  footnote_ref: (node, _children, _parents, styles) => (
    <Text key={node.key} style={styles.link}>[{Number((node as typeof node & { sourceMeta?: { id: number } }).sourceMeta?.id) + 1}]</Text>
  ),
  footnote_block: (node, children, _parents, styles) => (
    <View key={node.key} style={{ borderTopWidth: 1, borderColor: styles.hr.backgroundColor, paddingTop: 8 }}>{children}</View>
  ),
  footnote: (node, children) => (
    <View key={node.key}><Text>[{Number((node as typeof node & { sourceMeta?: { id: number } }).sourceMeta?.id) + 1}]</Text>{children}</View>
  ),
  footnote_anchor: () => null,
};

// Reuse the library's ordinary text styling (including inherited list styles).
// A pressable Text owns the responder, so links use a long-press menu rather than
// relying on native selection to win against the link's onPress.
const selectableRules: RenderRules = { ...rules };
for (const name of ["text", "textgroup", "strong", "em", "s", "code_inline", "code_block", "fence", "hardbreak", "softbreak", "inline", "span", "footnote_ref"]) {
  const render = rules[name]!;
  selectableRules[name] = (...args) => {
    const element = render(...args);
    return isValidElement<TextProps>(element) ? cloneElement(element, { selectable: true }) : element;
  };
}

/** An unconstrained horizontal text surface preserves source columns and explicit newlines.
 * Keep the library's text/selection styling; do not impose a new vertical cap on long blocks. */
function horizontalCodeBlock(text: ReactElement<TextProps>) {
  return <DrawerHorizontalGesture key={text.key}>
    <ScrollView horizontal style={{ flexGrow: 0, width: "100%" }} contentContainerStyle={{ flexGrow: 1 }}
      testID="markdown-code-scroll" showsHorizontalScrollIndicator={false}>
      {cloneElement(text, { testID: "markdown-code-text", style: [text.props.style, {
        flexGrow: 1, flexShrink: 0, fontFamily: Platform.select({ ios: "Courier", default: "monospace" }),
      }] })}
    </ScrollView>
  </DrawerHorizontalGesture>;
}
const openWebLink = (url: string) => /^https?:\/\//i.test(url);

/** A list item's own prose must precede its nested lists to form one row. */
function indexRowBoundary(node: ASTNode): number | null {
  const firstNested = node.children.findIndex(child => child.type === 'bullet_list' || child.type === 'ordered_list');
  if (firstNested < 0) return node.children.length;
  // A loose item can resume prose after a sublist; preserve its original block order.
  for (let index = firstNested + 1; index < node.children.length; index++) {
    const type = node.children[index].type;
    if (type !== 'bullet_list' && type !== 'ordered_list') return null;
  }
  return firstNested;
}

/** undefined signals competing destinations; nested lists belong to their own rows. */
function ownLinkTarget(node: ASTNode, target: string | null): string | null | undefined {
  if (node.type === 'bullet_list' || node.type === 'ordered_list') return target;
  if (node.type === 'link' || node.type === 'blocklink') {
    const url = node.attributes.href as string;
    if (target !== null && target !== url) return undefined;
    target = url;
  }
  for (const child of node.children ?? []) {
    const next = ownLinkTarget(child, target);
    if (next === undefined) return undefined;
    target = next;
  }
  return target;
}

/** Only one active destination may claim a whole index row. Inspect the renderer's AST,
 * not Markdown source: reference links, formatting and nested list items all share this path. */
function indexRowSlug(node: ASTNode, memory: AgentMemory): string | null {
  const boundary = indexRowBoundary(node);
  if (boundary === null) return null;
  let target: string | null = null;
  for (let index = 0; index < boundary; index++) {
    const next = ownLinkTarget(node.children[index], target);
    if (next === undefined) return null;
    target = next;
  }
  return target !== null ? managedMemorySlug(target, memory) : null;
}

type LinkTarget = { url: string; pageX: number; pageY: number };

function LinkMenu({ target, onClose }: { target: LinkTarget; onClose(): void }) {
  const { t } = useTranslation();
  const copy = async () => {
    onClose();
    try {
      if (!await Clipboard.setStringAsync(target.url)) throw new Error(t("剪贴板不可用"));
      AccessibilityInfo.announceForAccessibility(t("已复制链接"));
    } catch (error) {
      Alert.alert(t("无法复制链接"), t(userErrorMessage(error, "剪贴板不可用，请稍后重试")));
    }
  };
  return <DropdownMenu onOpenChange={(open) => { if (!open) onClose(); }}>
    <DropdownMenuAnchor point={target} />
    <DropdownMenuContent className="min-w-[220px] rounded-[16px] p-1.5">
      <DropdownMenuItem accessibilityLabel={t("复制链接")} onPress={() => void copy()} className="min-h-12 gap-3 rounded-[10px] px-3">
        <Icon as={Copy} className="size-[18px]" /><Text>{t("复制链接")}</Text>
      </DropdownMenuItem>
      <DropdownMenuItem accessibilityLabel={t("打开链接")} onPress={() => {
        onClose();
        void Linking.openURL(target.url);
      }} className="min-h-12 gap-3 rounded-[10px] px-3">
        <Icon as={ExternalLink} className="size-[18px]" /><Text>{t("打开链接")}</Text>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** A memoized prefix and a live suffix can share one native Text host. */
export type ProjectedMarkdownPart = Exclude<SelectablePart, { kind: 'text' }> |
  { kind: 'text'; spans: SelectableSpan[]; stableSpans?: SelectableSpan[] };


// Markdown's parser assigns fresh random AST keys on every render. A persisted message must
// retain its rendered tree when only its parent's UI/submission state changes.
export const AgentMemoryMarkdown = memo(function AgentMemoryMarkdown({ content, tokens, media, selectable = false, readOnly = false, compact = false, projectedParts, scrollCodeBlocks = false, managedMemory, memoryIndex = false }: {
  content: string; tokens?: MessageMarkdownTokens;
  /** Chat text selects natively; pressable links offer URL actions on long press. */
  selectable?: boolean;
  /** Only persisted Agent messages may enable authenticated Markdown images. */
  media?: { api: GatewayApi; conversationId: string; messageSeq: number };
  readOnly?: boolean;
  /** Use the denser typography required by inline file summaries. */
  compact?: boolean;
  /** Already projected text for an incrementally parsed, non-interactive draft. */
  projectedParts?: ProjectedMarkdownPart[];
  /** Chat opts in; memory, skills and compact attachment previews keep their existing layout. */
  scrollCodeBlocks?: boolean;
  /** Only active canonical references open the in-app detail route. */
  managedMemory?: { memory: AgentMemory; onOpen(slug: string): void };
  /** Index typography and whole-row navigation; detail, conflict and chat stay ordinary Markdown. */
  memoryIndex?: boolean;
}) {
  const parsed = useMemo(() => projectedParts ? [] : tokens ?? markdown.parse(content, {}), [content, tokens, projectedParts]);
  // Preview/interrupted content must not mount MathContent (which opens links and toggles source).
  const blocks = useMemo(() => !readOnly && containsMath(parsed) ? groupMarkdownBlocks(parsed) : null, [parsed, readOnly]);
  const api = media?.api;
  const conversationId = media?.conversationId;
  const messageSeq = media?.messageSeq;
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const selectableParts = useMemo(() => {
    if (projectedParts) return projectedParts;
    if (!selectable || readOnly) return null;
    const result: (ProjectedMarkdownPart | { kind: 'math'; tokens: Token[] })[] = [];
    let ordinary: Token[] = [];
    const flush = () => {
      if (ordinary.length) result.push(...groupSelectableMarkdown(ordinary));
      ordinary = [];
    };
    for (const block of groupMarkdownBlocks(parsed)) {
      if (containsMath(block)) {
        flush();
        result.push({ kind: 'math', tokens: block });
      } else ordinary.push(...block);
    }
    flush();
    return result;
  }, [parsed, selectable, readOnly, projectedParts]);
  const [foreground, muted, border, mutedForeground] = useCSSVariable([
    "--color-foreground", "--color-muted", "--color-border", "--color-muted-foreground",
  ]);
  const textColor = String(foreground ?? "#141414");
  const mutedColor = String(muted ?? "#F0F0ED");
  const borderColor = String(border ?? "#E3E3DF");
  const secondaryColor = String(mutedForeground ?? "#777773");
  const baseRules = useMemo<RenderRules>(() => {
    const base: RenderRules = !selectable ? { ...rules } : {
      ...selectableRules,
      link: (node, children, _parents, styles) => {
        const url = node.attributes.href;
        const web = openWebLink(url);
        return <NativeText key={node.key} style={styles.link}
          onPress={web ? () => { void Linking.openURL(url); } : undefined}
          onLongPress={web ? (event) => {
            // Keep the menu open after long press, including release/movement away.
            const { pageX, pageY } = event.nativeEvent;
            setLinkTarget({ url, pageX, pageY });
          } : undefined}>{children}</NativeText>;
      },
    };
    if (managedMemory) {
      const managedLink: NonNullable<RenderRules["link"]> = (node, children, parents, styles) => {
        const url = node.attributes.href;
        const slug = managedMemorySlug(url, managedMemory.memory);
        const row = parents.find(parent => parent.type === 'list_item');
        const rowOwnsLink = memoryIndex && !readOnly && slug && row &&
          parents.find(parent => parent.type === 'bullet_list' || parent.type === 'ordered_list')?.type === 'bullet_list' &&
          indexRowSlug(row, managedMemory.memory) === slug;
        return <NativeText key={node.key} style={rowOwnsLink ? [styles.link, { textDecorationColor: borderColor }] : styles.link}
          onPress={rowOwnsLink ? undefined : slug ? () => managedMemory.onOpen(slug)
            : openWebLink(url) ? () => { void Linking.openURL(url); } : undefined}>{children}</NativeText>;
      };
      base.link = managedLink;
      base.blocklink = managedLink;
    }
    if (memoryIndex && managedMemory && !readOnly) {
      base.list_item = (node, children, parents, styles, inheritedStyles) => {
        const nearestList = parents.find(parent => parent.type === 'bullet_list' || parent.type === 'ordered_list');
        if (nearestList?.type !== 'bullet_list') return defaultRules.list_item!(node, children, parents, styles, inheritedStyles);
        const boundary = indexRowBoundary(node);
        if (boundary === null || boundary === 0) return defaultRules.list_item!(node, children, parents, styles, inheritedStyles);
        const slug = indexRowSlug(node, managedMemory.memory);
        const own = children.slice(0, boundary);
        const nested = children.slice(boundary);
        const markerSize = 5;
        const markerGap = 10;
        const row = <View style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 8 }}>
          <View accessible={false} style={{ width: markerSize, height: markerSize, borderRadius: 3, backgroundColor: secondaryColor,
            marginRight: markerGap, marginTop: 9, flexShrink: 0 }} />
          <View style={{ flex: 1, minWidth: 0 }}>{own}</View>
          {slug ? <Icon as={ChevronRight} size={18} color={secondaryColor}
            style={{ marginLeft: 10, marginTop: 2 }} /> : null}
        </View>;
        return <View key={node.key}>{slug
          ? <Pressable accessibilityRole="button" testID={`memory-index-detail-${slug}`}
              onPress={() => managedMemory.onOpen(slug)}>{row}</Pressable>
          : row}
          {/* Align sublists with the parent's content, outside its press target. */}
          {nested.length ? <View style={{ paddingLeft: markerSize + markerGap }}>{nested}</View> : null}
        </View>;
      };
      base.textgroup = (node, children, parents, styles) => {
        const row = parents.find(parent => parent.type === 'list_item');
        const slug = row && parents.find(parent => parent.type === 'bullet_list' || parent.type === 'ordered_list')?.type === 'bullet_list'
          ? indexRowSlug(row, managedMemory.memory) : null;
        return <NativeText key={node.key} style={slug
          ? [styles.textgroup, { textDecorationLine: 'underline', textDecorationColor: borderColor }]
          : styles.textgroup}>{children}</NativeText>;
      };
    }
    if (!scrollCodeBlocks) return base;
    const codeBlock = base.code_block!;
    const fence = base.fence!;
    return {
      ...base,
      code_block: (...args) => horizontalCodeBlock(codeBlock(...args) as ReactElement<TextProps>),
      fence: (...args) => horizontalCodeBlock(fence(...args) as ReactElement<TextProps>),
    };
  }, [selectable, scrollCodeBlocks, managedMemory, memoryIndex, readOnly, borderColor, secondaryColor]);
  const renderRules = useMemo<RenderRules>(() => !readOnly && api && conversationId !== undefined && messageSeq !== undefined ? {
    ...baseRules,
    image: (node) => {
      const index = (node as typeof node & { sourceMeta?: { wandrunMediaIndex?: number } }).sourceMeta?.wandrunMediaIndex;
      return typeof index === 'number' ? <MediaPicture key={node.key} api={api}
        location={{ conversationId, messageSeq, block: 'markdown', element: 'image', index }}
        alt={node.attributes.alt || ''} height="auto" /> : <Text key={node.key}>{t("[图片：{alt}]", { alt: node.attributes.alt || node.attributes.src })}</Text>;
    },
    // The default paragraph wraps rows. Keeping wrap after switching to a column
    // makes Yoga size its cross-axis line to the spinner instead of the available width.
    paragraph: (node, children, parents, styles) =>
      containsImage(node.children ?? []) ? <View key={node.key}
        style={[styles._VIEW_SAFE_paragraph, { flexDirection: 'column', flexWrap: 'nowrap', alignItems: 'stretch' }]}>{children}</View>
        : defaultRules.paragraph!(node, children, parents, styles),
    textgroup: (node, children, _parents, styles) =>
      containsImage(node.children ?? []) ? <View key={node.key} className="gap-2">{children}</View>
        : <NativeText key={node.key} selectable={selectable} style={styles.textgroup}>{children}</NativeText>,
    strong: (node, children, parents, styles) =>
      containsImage(node.children ?? []) ? <View key={node.key}>{children}</View>
        : baseRules.strong!(node, children, parents, styles),
    em: (node, children, parents, styles) =>
      containsImage(node.children ?? []) ? <View key={node.key}>{children}</View>
        : baseRules.em!(node, children, parents, styles),
    link: (node, children, parents, styles, onLinkPress) =>
      containsImage(node.children ?? []) ? <View key={node.key}>{children}</View>
        : baseRules.link!(node, children, parents, styles, onLinkPress),
    blocklink: (node, children, parents, styles, onLinkPress) =>
      containsImage(node.children ?? []) ? <View key={node.key}>{children}</View>
        : defaultRules.blocklink!(node, children, parents, styles, onLinkPress),
  } : readOnly ? {
    ...baseRules,
    link: (node, children) => <NativeText key={node.key}>{children}</NativeText>,
    blocklink: (node, children) => <NativeText key={node.key}>{children}</NativeText>,
  } : baseRules, [api, conversationId, messageSeq, baseRules, readOnly, selectable]);
  const style = useMemo(() => ({
    body: { color: textColor, fontSize: compact ? 12 : 16, lineHeight: compact ? 18 : 26 },
    heading1: { color: textColor, fontSize: compact ? 14 : 26, lineHeight: compact ? 20 : undefined, fontWeight: "700" as const, marginTop: compact ? 0 : 12 },
    heading2: memoryIndex ? { color: secondaryColor, fontSize: 13, lineHeight: 18, fontWeight: "500" as const,
      marginTop: 16, marginBottom: 4 } : { color: textColor, fontSize: compact ? 14 : 22,
      lineHeight: compact ? 20 : undefined, fontWeight: "700" as const, marginTop: compact ? 0 : 12 },
    heading3: { color: textColor, fontSize: compact ? 14 : 19, lineHeight: compact ? 20 : undefined, fontWeight: "600" as const, marginTop: compact ? 0 : 10 },
    heading4: { color: textColor, fontSize: compact ? 14 : 16, lineHeight: compact ? 20 : undefined, fontWeight: "600" as const },
    heading5: { color: textColor, fontSize: compact ? 12 : 13, lineHeight: compact ? 18 : undefined, fontWeight: "600" as const },
    heading6: { color: textColor, fontSize: compact ? 12 : 11, lineHeight: compact ? 18 : undefined, fontWeight: "600" as const },
    paragraph: { marginTop: compact ? 0 : 4, marginBottom: compact ? 3 : 9 },
    // Long paths must wrap inside the paragraph rather than widen a summary dialog.
    textgroup: { flexShrink: 1, maxWidth: "100%" as const },
    link: { color: textColor, textDecorationLine: "underline" as const },
    ...(memoryIndex ? { bullet_list_content: { fontSize: 15, lineHeight: 22 } } : {}),
    blockquote: { backgroundColor: mutedColor, borderColor, marginLeft: 0, padding: compact ? 6 : 10 },
    code_inline: { backgroundColor: mutedColor, borderColor, color: textColor, padding: compact ? 2 : 3,
      fontFamily: Platform.select({ ios: "Courier", default: "monospace" }) },
    code_block: { backgroundColor: mutedColor, borderColor, color: textColor },
    fence: { backgroundColor: mutedColor, borderColor, color: textColor },
    hr: { backgroundColor: borderColor },
    table: { borderColor },
    tr: { borderColor },
  }), [textColor, mutedColor, borderColor, secondaryColor, compact, memoryIndex]);
  const linkMenu = selectable && !readOnly && linkTarget
    ? <LinkMenu target={linkTarget} onClose={() => setLinkTarget(null)} /> : null;
  const onManagedLink = managedMemory ? (url: string) => {
    const slug = managedMemorySlug(url, managedMemory.memory);
    if (!slug) return false;
    managedMemory.onOpen(slug);
    return true;
  } : undefined;
  const renderMath = (block: Token[], index: number) => {
    const parts = media ? splitMathParagraphImages(block) : null;
    if (parts) return parts.map((part, offset) => 'image' in part
      ? renderImageToken(part.image, `${index}:${offset}`, api, conversationId, messageSeq)
      : containsMath(part.tokens)
        ? <MathContent key={`${index}:${offset}`} html={mathBlockHtml(part.tokens, managedMemory?.memory)} source={part.source}
          onManagedLink={onManagedLink} />
        : <NativeMarkdownBlock key={`${index}:${offset}`} tokens={part.tokens} style={style} rules={renderRules} />);
    // A nested/format-spanning image cannot be extracted without corrupting its Markdown structure.
    // Keep the authenticated image in native Markdown and show the formula's source as text.
    if (media && containsImageTokens(block)) return [<NativeMarkdownBlock key={index} tokens={block} style={style} rules={renderRules} />];
    return [<MathContent key={index} html={mathBlockHtml(block, managedMemory?.memory)} source={block.map(token => token.content).filter(Boolean).join("\n")}
      onManagedLink={onManagedLink} />];
  };
  // Match the 8px Markdown/UI segment gap without letting the menu add layout space.
  if (selectableParts) return <><View style={{ gap: 8 }}>
    {selectableParts.flatMap((part, index) => {
      if (part.kind === 'math') return renderMath(part.tokens, index);
      if (part.kind === 'image') return [readOnly
        ? <Text key={index} style={style.link}>{t("[图片：{alt}]", { alt: part.token.content || part.token.attrGet('src') || '' })}</Text>
        : renderImageToken(part.token, String(index), api, conversationId, messageSeq)];
      if (part.kind === 'block') return [<NativeMarkdownBlock key={index} tokens={part.tokens} style={style} rules={renderRules} />];
      return [<SelectableTextRun key={index} spans={part.spans}
        stableSpans={part.stableSpans}
        style={style} readOnly={readOnly} markerColor={String(mutedForeground ?? borderColor)}
        onLinkLongPress={setLinkTarget} />];
    })}
  </View>{linkMenu}</>;
  if (!blocks) return <><NativeMarkdownBlock tokens={parsed} style={style} rules={renderRules} />{linkMenu}</>;
  return <View>
    {blocks.flatMap((block, index) => !containsMath(block)
      ? [<NativeMarkdownBlock key={index} tokens={block} style={style} rules={renderRules} />]
      : renderMath(block, index))}
    {linkMenu}
  </View>;
}, (before, after) => before.content === after.content && before.tokens === after.tokens && before.selectable === after.selectable &&
  before.projectedParts === after.projectedParts && before.scrollCodeBlocks === after.scrollCodeBlocks &&
  before.readOnly === after.readOnly && before.compact === after.compact && before.memoryIndex === after.memoryIndex &&
  before.managedMemory?.memory === after.managedMemory?.memory && before.managedMemory?.onOpen === after.managedMemory?.onOpen &&
  before.media?.api === after.media?.api &&
  before.media?.conversationId === after.media?.conversationId &&
  before.media?.messageSeq === after.media?.messageSeq);

/** Tokens are the complete block input. Unrelated draft text must not regenerate
 * markdown-display's random AST keys and remount a completed code/table subtree. */
const NativeMarkdownBlock = memo(function NativeMarkdownBlock({ tokens, style, rules }: {
  tokens: MessageMarkdownTokens; style: Record<string, object>; rules: RenderRules;
}) {
  const parser = useMemo(() => Object.assign(Object.create(markdown) as MarkdownIt, { parse: () => tokens }), [tokens]);
  return <Markdown markdownit={parser} rules={rules} onLinkPress={openWebLink} style={style}>{" "}</Markdown>;
});

/** Keep the native selectable host mounted while its anchored link menu opens or closes.
 * A memoized prefix is still a child of the same host, so it does not split selection. */
const SelectableTextRun = memo(function SelectableTextRun({ spans, stableSpans, style, markerColor, onLinkLongPress, readOnly = false }: {
  spans: SelectableSpan[];
  stableSpans?: SelectableSpan[];
  style: Record<string, TextStyle>;
  markerColor: string;
  onLinkLongPress(target: LinkTarget): void;
  readOnly?: boolean;
}) {
  return <NativeText selectable={!readOnly} style={style.body}>
    {stableSpans && <StableTextSpans spans={stableSpans} style={style} markerColor={markerColor}
      onLinkLongPress={onLinkLongPress} readOnly={readOnly} />}
    {renderTextSpans({ spans, style, markerColor, onLinkLongPress, readOnly })}
  </NativeText>;
});

type TextSpansProps = {
  spans: SelectableSpan[];
  style: Record<string, TextStyle>;
  markerColor: string;
  onLinkLongPress(target: LinkTarget): void;
  readOnly: boolean;
};

const StableTextSpans = memo(function StableTextSpans(props: TextSpansProps) {
  return <>{renderTextSpans(props)}</>;
});

function renderTextSpans({ spans, style, markerColor, onLinkLongPress, readOnly }: TextSpansProps) {
  return spans.map((span, index) => {
    const web = span.url && openWebLink(span.url);
    // Explicit text defaults match markdown-display 7.x (H4–H6 sizes, native code fonts,
    // emphasis and links), with local typography/colors. No default block layout is copied.
    const spanStyle = {
      ...(span.heading ? style[span.heading] : {}),
      ...(span.heading === 'heading1' ? { lineHeight: 34 } : {}),
      ...(span.heading === 'heading2' ? { lineHeight: 30 } : {}),
      ...(span.heading === 'heading3' ? { lineHeight: 28 } : {}),
      ...(span.marks.includes('strong') ? { fontWeight: 'bold' as const } : {}),
      ...(span.marks.includes('em') ? { fontStyle: 'italic' as const } : {}),
      ...(span.marks.includes('s') ? { textDecorationLine: 'line-through' as const } : {}),
      ...(span.marks.includes('code_inline') ? style.code_inline : {}),
      ...(span.url ? style.link : {}),
      ...(span.marker ? { color: markerColor } : {}),
    };
    return <NativeText key={index} style={spanStyle}
      onPress={!readOnly && web ? () => { void Linking.openURL(span.url!); } : undefined}
      onLongPress={!readOnly && web ? (event) => {
        const { pageX, pageY } = event.nativeEvent;
        onLinkLongPress({ url: span.url!, pageX, pageY });
      } : undefined}>{span.text}</NativeText>;
  });
}
