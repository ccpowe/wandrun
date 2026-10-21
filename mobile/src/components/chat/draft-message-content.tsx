import { memo, useMemo, useState } from 'react';
import { View } from 'react-native';

import { AgentMemoryMarkdown, type ProjectedMarkdownPart } from '@/components/agent-memory-markdown.tsx';
import { Text } from '@/components/ui/text.tsx';
import { parseMessageMarkdown, prepareMessageMarkdownPrefix, type MessageMarkdownTokens } from '@/lib/agent-message-markdown.ts';
import { DraftMarkdown, draftTailText, type DraftPart } from '@/lib/draft-markdown.ts';
import { groupSelectableMarkdown, type SelectablePart } from '@/lib/selectable-markdown.ts';
import { useTranslation } from '@/lib/i18n.ts';

/** A completed paragraph and its successor belong to one native text run, not
 * two Markdown views separated by the host's 8px UI-block gap. */
function joinTextParts(stable: ProjectedMarkdownPart[], tail: SelectablePart[]): ProjectedMarkdownPart[] {
  if (!stable.length) return tail;
  if (!tail.length) return stable;
  const last = stable.at(-1)!;
  const first = tail[0];
  if (last.kind !== 'text' || first.kind !== 'text') return [...stable, ...tail];
  return [...stable.slice(0, -1), { kind: 'text', stableSpans: last.stableSpans,
    spans: [{ text: '\n\n', marks: [] }, ...first.spans] }, ...tail.slice(1)];
}

function stablePartCount(parts: readonly DraftPart[]): number {
  let stableCount = parts.length;
  while (stableCount && !parts[stableCount - 1].stable) stableCount--;
  return stableCount;
}

/** Reuse prefix projections only when the parser accepts an independent suffix. */
const DraftMarkdownRun = memo(function DraftMarkdownRun({ prefixTokens, tailTokens }: {
  prefixTokens?: MessageMarkdownTokens;
  tailTokens?: MessageMarkdownTokens;
}) {
  const stableProjection = useMemo<ProjectedMarkdownPart[]>(() =>
    groupSelectableMarkdown(prefixTokens ?? []).map(part => part.kind === 'text'
      ? { kind: 'text', stableSpans: part.spans, spans: [] } : part), [prefixTokens]);
  const tailProjection = useMemo(() => groupSelectableMarkdown(tailTokens ?? []), [tailTokens]);
  const projectedParts = useMemo(() => joinTextParts(stableProjection, tailProjection),
    [stableProjection, tailProjection]);
  if (!projectedParts.length) return null;
  return <AgentMemoryMarkdown content=" " projectedParts={projectedParts} readOnly />;
});

type DraftRun = { kind: 'markdown'; parts: DraftPart[]; index: number } |
  { kind: 'ui' | 'mermaid'; index: number };

/** Drafts have no persisted media coordinate or validated UI; never mount interactive blocks. */
export function DraftMessageContent({ text, interrupted = false }: { text: string; interrupted?: boolean }) {
  const { t, language } = useTranslation();
  const [parsed, setParsed] = useState(() => {
    const scanner = new DraftMarkdown();
    return { text, scanner, parts: scanner.update(text) };
  });
  if (parsed.text !== text) {
    const scanner = parsed.scanner.fork();
    setParsed({ text, scanner, parts: scanner.update(text) });
  }
  const runs: DraftRun[] = [];
  parsed.parts.forEach((part, index) => {
    const previous = runs.at(-1);
    if (part.kind === 'markdown' && previous?.kind === 'markdown') previous.parts.push(part);
    else if (part.kind === 'markdown') runs.push({ kind: 'markdown', parts: [part], index });
    else runs.push({ kind: part.kind, index });
  });
  // All inputs below belong to parsed, including during the render that queues
  // a new scanner snapshot. Never cache old parts under the incoming text prop.
  const lastRun = runs.at(-1);
  const tailRun = lastRun?.kind === 'markdown' ? lastRun : undefined;
  const stableCount = tailRun ? stablePartCount(tailRun.parts) : 0;
  const tailText = tailRun?.parts.slice(stableCount).map(part => part.text).join('') ?? '';
  const prefixSegments = runs.map(run =>
    run.kind === 'markdown' ? { kind: 'markdown' as const,
      text: (run === tailRun ? run.parts.slice(0, stableCount) : run.parts).map(part => part.text).join('') }
      : { kind: 'ui' as const, source: '', block: run.index, closed: true });
  // A non-append snapshot rebuilds scanner objects even when its prefix is
  // unchanged. Cache by segment contents, preserving UI boundaries as well.
  const prefixKey = JSON.stringify(prefixSegments);
  const prefix = useMemo(() => prepareMessageMarkdownPrefix(prefixSegments),
    // prefixKey includes all parser inputs, not the changing tail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefixKey]);
  const document = useMemo(() => {
    const maskedTail = draftTailText(tailText, t('[图片生成中]'));
    const live = prefix.parseTail(maskedTail);
    if (!live) {
      return { parsed: parseMessageMarkdown(prefixSegments.map((part, index) =>
        part.kind === 'markdown' && index === runs.length - 1
          ? { ...part, text: part.text + maskedTail } : part)), live: undefined };
    }
    return { parsed: { chunks: prefix.chunks, tail: tailRun ? [] : live.footnotes },
      live: tailRun ? [...live.tokens, ...live.footnotes] : undefined };
  // All runs/tail boundaries are derived from this scanner snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, prefix, language]);
  return <View className="gap-2" testID={interrupted ? 'interrupted-content' : 'draft-content'}>
    {runs.map((run, index) => run.kind === 'markdown'
      ? <DraftMarkdownRun key={run.index} prefixTokens={document.parsed.chunks.get(index)}
        tailTokens={run === tailRun ? document.live : undefined} />
      : <Text key={run.index} className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        {run.kind === 'mermaid' ? t('流程图生成中') : interrupted ? t('界面未完成') : t('界面生成中')}
      </Text>)}
    {document.parsed.tail.length
      ? <AgentMemoryMarkdown content=" " projectedParts={groupSelectableMarkdown(document.parsed.tail)} readOnly />
      : null}
  </View>;
}
