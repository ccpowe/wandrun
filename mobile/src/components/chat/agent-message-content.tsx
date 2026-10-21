import { useMemo } from "react";
import { View } from "react-native";

import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { RichBlock } from "@/components/rich-message/block.tsx";
import { authorizedImageFiles, splitAgentMessage, type UiSubmission } from "@/lib/agent-message.ts";
import { parseMessageMarkdown } from "@/lib/agent-message-markdown.ts";
import type { FileRecord } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";

export type UiBlockStatus = { block: number; valid: boolean; error?: string; files?: Record<string, string> };

/** Render an Agent's Markdown/UI interleave; only the host knows event identity and persistence. */
export function AgentMessageContent({ text, ui, attachments, submissions, onSubmit, draftOwner }: {
  text: string;
  ui?: readonly UiBlockStatus[];
  attachments?: readonly Pick<FileRecord, "id" | "media_type">[];
  submissions?: ReadonlyMap<number, UiSubmission>;
  draftOwner?: { session: ChatSession; conversationId: string; timelineId?: string; messageSeq: number };
  onSubmit: (block: number, values: Record<string, unknown>, clientId: string) => Promise<void>;
}) {
  const segments = useMemo(() => splitAgentMessage(text), [text]);
  const parsed = useMemo(() => parseMessageMarkdown(segments), [segments]);
  const api = draftOwner?.session.api;
  const conversationId = draftOwner?.conversationId;
  const messageSeq = draftOwner?.messageSeq;
  const media = useMemo(() => api && conversationId !== undefined && messageSeq !== undefined
    ? { api, conversationId, messageSeq } : undefined, [api, conversationId, messageSeq]);
  return <View className="gap-2">
    {segments.map((part, index) => part.kind === "markdown"
      ? parsed.chunks.get(index)?.length ? <AgentMemoryMarkdown key={index} content={part.text} tokens={parsed.chunks.get(index)}
        media={media} selectable /> : null
      : <RichBlock key={index} source={part.source} block={part.block}
        valid={part.closed && ui?.find((status) => status?.block === part.block)?.valid !== false}
        imageFiles={authorizedImageFiles(ui?.find((entry) => entry?.block === part.block), attachments)}
        submission={submissions?.get(part.block)}
        draft={draftOwner && { ...draftOwner, block: part.block }}
        onSubmit={(values, clientId) => onSubmit(part.block, values, clientId)} />)}
    {parsed.tail.length ? <AgentMemoryMarkdown content=" " tokens={parsed.tail} media={media} selectable /> : null}
  </View>;
}
