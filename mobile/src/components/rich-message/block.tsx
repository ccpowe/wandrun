import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { JSONUIProvider, Renderer } from '@json-render/react-native';
import { Button } from '@/components/ui/button.tsx';
import { Text } from '@/components/ui/text.tsx';
import type { UiSubmission } from '@/lib/agent-message.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { RichImageContext, RichInteractionContext, richRegistry } from './registry.tsx';
import { parseRichSpec, type RichSpec } from './spec.ts';
import { useUiDraft, type UiDraftOwner } from './use-ui-draft.ts';
import { gridMinimumWidth } from './layout.ts';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';

export type RichBlockProps = {
  source: string;
  block?: number;
  valid?: boolean;
  submission?: UiSubmission;
  onSubmit: (values: Record<string, unknown>, clientId: string) => Promise<void>;
  draft?: UiDraftOwner;
  /** Only ids authorized by this message's valid UI metadata and image attachments. */
  imageFiles?: Readonly<Record<string, string>>;
};

/** A malformed or rejected block is gray and inspectable, never a fatal chat-row exception. */
export function InvalidRichBlock({ source }: { source: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return <View className="border-border border" style={{ gap: richSpace.sm, borderRadius: richRadius.large, padding: richSpace.lg }} testID="rich-invalid">
    <Pressable accessibilityRole="button" accessibilityLabel={t('无法显示的界面')} accessibilityState={{ expanded }}
      onPress={() => setExpanded(!expanded)} testID="rich-invalid-toggle">
      <Text className="text-muted-foreground" style={richType.subtle}>{t('界面无法显示 · {action}', { action: expanded ? t('收起原文') : t('查看原文') })}</Text>
    </Pressable>
    {expanded ? <View className="bg-muted" style={{ borderRadius: richRadius.medium, paddingHorizontal: richSpace.md, paddingVertical: richSpace.sm }}><Text selectable className="text-foreground font-mono" style={richType.caption}>{source}</Text></View> : null}
  </View>;
}

class RichRenderBoundary extends React.Component<{ source: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <InvalidRichBlock source={this.props.source} /> : this.props.children;
  }
}

function RenderableBlock({ spec, submission, onSubmit, draft: owner, imageFiles, block = 0 }: RichBlockProps & { spec: RichSpec }) {
  const { t, locale } = useTranslation();
  const { store, currentDraft, disabled, send } = useUiDraft(spec, submission, owner, onSubmit);
  const submitted = !!submission;
  // Trusted renderer metadata never enters the wire schema: media coordinates and
  // Grid readability are derived once from the validated spec, not opaque React children.
  const renderSpec = useMemo(() => ({
    ...spec,
    elements: Object.fromEntries(Object.entries(spec.elements).map(([id, node]) =>
      node.type === 'Grid'
        ? [id, { ...node, props: { ...node.props, __minimumWidth: gridMinimumWidth(spec.elements, id) } }]
        : ['Image', 'MediaCard', 'Gallery', 'Mermaid'].includes(node.type)
          ? [id, { ...node, props: { ...node.props, __mediaId: id } }] : [id, node])),
  }), [spec]);

  const time = submission ? (() => {
    const date = new Date(submission.createdAt);
    return Number.isNaN(date.getTime()) ? submission.createdAt : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  })() : null;

  return <View style={{ gap: richSpace.sm }} testID="rich-block">
    <JSONUIProvider store={store}>
      <RichImageContext.Provider value={{ files: imageFiles, api: owner?.session.api,
        conversationId: owner?.conversationId, messageSeq: owner?.messageSeq, block }}>
        <RichInteractionContext.Provider value={{ submitted, disabled, pending: currentDraft.pending, submit: () => { void send(); }, submittedAt: time }}>
          <Renderer spec={renderSpec} registry={richRegistry} includeStandard={false} />
        </RichInteractionContext.Provider>
      </RichImageContext.Provider>
    </JSONUIProvider>
    {!submitted && currentDraft.completed ? <Text className="text-muted-foreground" style={richType.caption}>{t('已提交，等待对话更新…')}</Text> : null}
    {!submitted && currentDraft.error ? <View className="border-border border" style={{ gap: richSpace.sm, borderRadius: richRadius.medium, padding: richSpace.md }} testID="rich-submit-error">
      <Text className="text-muted-foreground" style={richType.subtle}>{t(currentDraft.error.message)}</Text>
      {currentDraft.error.retryable ? <Button variant="outline" size="sm" onPress={() => { void send(true); }} disabled={currentDraft.pending} accessibilityLabel={t('重试提交')} testID="rich-submit-retry" className="self-start"
        style={{ minHeight: richGeometry.touch, paddingHorizontal: richSpace.lg, borderRadius: richRadius.full }}><Text style={richType.body}>{t('重试提交')}</Text></Button> : null}
    </View> : null}
  </View>;
}

/**
 * Render one message-local fence. A session owns drafts and unknown-result attempts across
 * recycled rows; preview callers without a session use component-local state. A persisted
 * submission always replaces either draft and makes the card read-only.
 */
export function RichBlock({ source, valid = true, submission, onSubmit, draft, imageFiles, block }: RichBlockProps) {
  const spec = useMemo(() => valid ? parseRichSpec(source) : null, [source, valid]);
  if (!spec || !spec.root || !spec.elements[spec.root]) return <InvalidRichBlock source={source} />;
  return <RichRenderBoundary key={submission ? `submitted-${submission.createdAt}` : source} source={source}>
    <RenderableBlock source={source} spec={spec} valid={valid} submission={submission} onSubmit={onSubmit} draft={draft} imageFiles={imageFiles} block={block} />
  </RichRenderBoundary>;
}
