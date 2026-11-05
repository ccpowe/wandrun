import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { JSONUIProvider, Renderer, useStateStore } from '@json-render/react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import type { UiSubmission } from '@/lib/agent-message.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { resolveRichBindings, richVisible } from '@/lib/rich-state.ts';
import { RichImageContext, RichInteractionContext, richRegistry } from './registry.tsx';
import { parseRichSpec, richBlockFramed, type RichSpec } from './spec.ts';
import { RichFramed, SubmitFeedback } from './inputs.tsx';
import { useUiDraft, type UiDraftOwner } from './use-ui-draft.ts';
import { gridMinimumWidth } from './layout.ts';
import { richGeometry, richRadius, richSpace, richType } from './tokens.ts';

export type RichBlockProps = {
  source: string;
  block?: number;
  valid?: boolean;
  submission?: UiSubmission;
  onSubmit: (values: Record<string, unknown>, clientId: string, actionId?: string) => Promise<void>;
  draft?: UiDraftOwner;
  /** Only ids authorized by this message's valid UI metadata and image attachments. */
  imageFiles?: Readonly<Record<string, string>>;
};

/** `RichBlock.invalid`: a malformed or rejected block is one gray line that expands the raw source;
 * never a fatal chat-row exception. */
export function InvalidRichBlock({ source }: { source: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return <View style={{ gap: richSpace.xs }} testID="rich-invalid">
    <Pressable accessibilityRole="button" accessibilityLabel={t('无法显示的界面')} accessibilityState={{ expanded }}
      onPress={() => setExpanded(!expanded)} testID="rich-invalid-toggle" className="flex-row items-center self-start"
      style={{ minHeight: richGeometry.touch, gap: richSpace.xs }}>
      <Text className="text-muted-foreground" style={richType.subtle}>{t('界面无法显示 · {action}', { action: expanded ? t('收起原文') : t('查看原文') })}</Text>
      <Icon as={expanded ? ChevronUp : ChevronDown} size={14} className="text-muted-foreground" />
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

function BoundRenderer({ spec }: { spec: RichSpec }) {
  const { state } = useStateStore();
  return <Renderer spec={resolveRichBindings(spec, state)} registry={richRegistry} includeStandard={false} />;
}

function VisibleBlock({ spec, children }: { spec: RichSpec; children: React.ReactNode }) {
  const { state } = useStateStore();
  return richVisible(spec.elements[spec.root].visible, state) ? children : null;
}

function RenderableBlock({ spec, submission, onSubmit, draft: owner, imageFiles, block = 0 }: RichBlockProps & { spec: RichSpec }) {
  const { locale, t } = useTranslation();
  const { store, currentDraft, disabled, submitDisabled, connected, send, check } = useUiDraft(spec, submission, owner, onSubmit);
  const submitted = !!submission;
  const framed = richBlockFramed(spec);
  const flow = currentDraft.flow;
  const attempt = flow.status === 'editing' ? undefined : flow.attempt;
  const pending = flow.status === 'sending';
  const sending = Object.values(spec.elements).some(node => node.type === 'FollowUps' || node.props.send);
  const error = flow.status === 'failed' ? flow.error : flow.status === 'unknown' || flow.status === 'checking'
    ? { message: t('发送结果尚未确认，恢复连接后会核对。'), retryable: false } : null;
  // Trusted renderer metadata never enters the wire schema: media coordinates and
  // Grid readability are derived once from the validated spec, not opaque React children.
  const renderSpec = useMemo(() => ({
    ...spec,
    elements: Object.fromEntries(Object.entries(spec.elements).map(([id, node]) => [id, {
      ...node, props: { ...node.props, __elementId: id,
        ...(node.type === 'Grid' ? { __minimumWidth: gridMinimumWidth(spec.elements, id) } : {}),
        ...(['Image', 'MediaCard', 'Gallery', 'Mermaid', 'LinkCard'].includes(node.type) ? { __mediaId: id } : {}),
      },
    }])),
  }), [spec]);

  const time = submission ? (() => {
    const date = new Date(submission.createdAt);
    return Number.isNaN(date.getTime()) ? submission.createdAt : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  })() : null;

  return <JSONUIProvider store={store}><VisibleBlock spec={spec}>
    <View style={{ gap: richSpace.sm }} testID="rich-block">
      <RichFramed framed={framed}>
        <RichImageContext.Provider value={{ files: imageFiles, api: owner?.session.api,
          conversationId: owner?.conversationId, messageSeq: owner?.messageSeq, block }}>
          <RichInteractionContext.Provider value={{ submitted, disabled, submitDisabled, pending, submit: () => { void send(); },
            send: actionId => { void send(false, actionId); }, actionId: attempt?.actionId,
            sentActionId: submission?.actionId, submittedAt: time }}>
            <BoundRenderer spec={renderSpec} />
          </RichInteractionContext.Provider>
        </RichImageContext.Provider>
      {submission?.actionId ? <Text variant="caption" className="text-muted-foreground">{t('已发送 · {time}', { time: time || '' })}</Text> : null}
      {!submitted ? <SubmitFeedback completed={flow.status === 'awaiting'} error={error} sending={sending}
        pending={pending || !connected} onRetry={() => { void send(true); }}
        onCheck={flow.status === 'unknown' || flow.status === 'checking' ? check && (() => { void check(); }) : undefined}
        checking={flow.status === 'checking'} /> : null}
      </RichFramed>
    </View>
  </VisibleBlock></JSONUIProvider>;
}

/**
 * Render one message-local fence. A session owns drafts and unknown-result attempts across
 * recycled rows; preview callers without a session use component-local state. A persisted
 * submission always replaces either draft and makes the card read-only.
 */
export function RichBlock({ source, valid = true, submission, onSubmit, draft, imageFiles, block }: RichBlockProps) {
  const spec = useMemo(() => valid ? parseRichSpec(source) : null, [source, valid]);
  if (!spec || !spec.root || !spec.elements[spec.root]) return <InvalidRichBlock source={source} />;
  return <RichRenderBoundary key={`${draft?.session.queryIdentity ?? ''}:${draft?.session.storeVersion ?? 0}:${draft?.timelineId ?? draft?.conversationId ?? ''}:${draft?.messageSeq ?? ''}:${block ?? 0}:${submission ? `submitted-${submission.createdAt}` : source}`} source={source}>
    <RenderableBlock source={source} spec={spec} valid={valid} submission={submission} onSubmit={onSubmit} draft={draft} imageFiles={imageFiles} block={block} />
  </RichRenderBoundary>;
}
