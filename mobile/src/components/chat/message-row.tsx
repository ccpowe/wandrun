import { useState, type ReactNode } from "react";
import { router } from "expo-router";
import { Check, ChevronRight, CircleAlert, Square } from "lucide-react-native";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { ActivityIndicator } from "@/components/ui/activity-indicator.tsx";

import { BrowserCard } from "@/components/chat/browser-card.tsx";
import { AgentMessageContent } from "@/components/chat/agent-message-content.tsx";
import { DraftMessageContent } from "@/components/chat/draft-message-content.tsx";
import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TASK_STATUS_LABEL, type ChatRow } from "@/lib/chat-timeline.ts";
import { chatLocation } from "@/lib/chat-route.ts";
import type { ContextCompactedData, ContextCompactionFailedData, FileRecord } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { TypingDots } from "./typing-dots.tsx";
import { AttachmentPreview, type AttachmentOwner } from "@/components/chat/attachment-preview.tsx";
import { ProgressRow } from "./progress-row.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { userErrorMessage } from "@/lib/user-error.ts";
import { deferLoadingIndicator } from "@/lib/load-state.ts";
import { useMountEffect } from "@/lib/use-mount-effect.ts";

/** Feedback only; the network deadline and retry identity remain session-owned. */
const sendingIndicatorDelayMs = 500;
function SendingIndicator({ clientId }: { clientId: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useMountEffect(() => deferLoadingIndicator(() => setVisible(true), sendingIndicatorDelayMs));
  return visible ? <ActivityIndicator testID={`message-sending-${clientId}`} accessibilityLabel={t("发送中")} size="small" /> : null;
}
type CardFile = Pick<FileRecord, "id" | "name" | "size" | "media_type"> & Partial<Pick<FileRecord, "remote_environment">>;


/** My text bubble and the same attachment preview used by Agent messages. */
function MineBubble({ text, attachments = [], session, owner, active = true, status }: {
  text: string; attachments?: CardFile[]; session: ChatSession; owner?: AttachmentOwner; active?: boolean; status?: ReactNode;
}) {
  return (
    <View className={attachments.length ? "w-[240px] max-w-[78%] self-end" : "max-w-[78%] self-end"}>
      {/* The status never participates in bubble sizing, including attachment-only messages. */}
      {status && <View className="absolute -left-7 top-0 bottom-0 w-5 items-center justify-center">{status}</View>}
      {text ? <View className="self-end rounded-[20px] rounded-br-[6px] bg-muted px-3.5 py-2.5">
        <Text className="text-base text-foreground">{text}</Text>
      </View> : null}
      <AttachmentPreview files={attachments} session={session} owner={owner} mine active={active} />
    </View>
  );
}

function CompactedRow({ data, seq, agentName }: { data: ContextCompactedData; seq: number; agentName: string }) {
  const { width, height } = useWindowDimensions();
  const { t } = useTranslation();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Pressable testID={`context-compacted-${seq}`} accessibilityRole="button"
          accessibilityLabel={t("已压缩上下文（{agent}），查看工作摘要", { agent: agentName })}
          className="self-center">
          <Text className="text-center text-xs text-muted-foreground">{t("已压缩上下文（{agent}）", { agent: agentName })}</Text>
        </Pressable>
      </DialogTrigger>
      {/* Keep dialog taps out of the backdrop; the ScrollView child claims body taps so Android can intercept drags. */}
      <DialogContent testID={`context-summary-${seq}`}
        onStartShouldSetResponder={() => true}
        style={{ width: Math.min(width - 32, 512), maxHeight: height * 0.85 }}>
        <DialogTitle className="pr-6">{t("上下文摘要 · {agent}", { agent: agentName })}</DialogTitle>
        <Text className="text-xs text-muted-foreground">{t("模型生成的工作摘要，非原文；聊天记录仍保留。")}</Text>
        <ScrollView style={{ maxHeight: height * 0.65 }} testID={`context-summary-body-${seq}`}>
          <View onStartShouldSetResponder={() => true}>
            <AgentMemoryMarkdown content={data.summary_text} scrollCodeBlocks />
          </View>
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}

/** The current timeline already identifies its Agent; only a different sender needs a name. */
function AgentSender({ name }: { name?: string }) {
  return name ? <Text className="mb-0.5 text-xs text-muted-foreground">{name}</Text> : null;
}

/** 时间线上的一行：我的消息 / Agent 消息 / 停止、失败事件，以及还没确认的本地消息。 */
export function MessageRow({ item, session, visible = false, timelineId, onUiSubmitted, onRetryPending }: {
  item: ChatRow; session: ChatSession; visible?: boolean; timelineId?: string;
  /** Before real identity, retry belongs to the first-intent owner, not session.retry. */
  onRetryPending?: (clientId: string) => void;
  /** Local form acceptance only; validation/rejection and other senders do not take over reading. */
  onUiSubmitted?: () => void;
}) {
  const { t } = useTranslation();
  if (item.delegation) {
    const { taskId, status } = item.delegation;
    const name = item.agentName!;
    return <ProgressRow testID={`delegation-${taskId}`}
      accessibilityLabel={t("委派 {agent} · {status}", { agent: name, status: t(TASK_STATUS_LABEL[status]) })}
      onPress={() => router.push(chatLocation(taskId))}>
      {status === "running" || status === "waiting" ? <TypingDots />
        : <Icon as={status === "completed" ? Check : status === "failed" || status === "unavailable" ? CircleAlert : Square} className="size-4 text-muted-foreground" />}
      <Text numberOfLines={1} className="shrink text-sm">{t("委派 {agent} · {status}", { agent: name, status: t(TASK_STATUS_LABEL[status]) })}</Text>
      <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
    </ProgressRow>;
  }
  if (item.browser) {
    return <BrowserCard session={session} task={item.browser} active={visible} agentName={item.agentName!} />;
  }
  if (item.draft) return <View className="px-0.5" testID={`draft-${item.draft.draft_id}`}>
    <AgentSender name={item.senderName} />
    <DraftMessageContent text={item.draft.text} />
  </View>;
  if (item.kind === "user" && item.pending) {
    const pending = item.pending;
    const retry = () => { if (onRetryPending) onRetryPending(pending.clientId); else void session.retry(pending.clientId); };
    return (
      <View className="items-end gap-1">
        <MineBubble text={pending.text} attachments={pending.attachments} session={session} active={visible}
          status={item.delivery === "sending"
            ? <SendingIndicator key={pending.clientId} clientId={pending.clientId} />
            : item.retryable
              ? <Pressable testID={`message-retry-icon-${pending.clientId}`} accessibilityRole="button"
                  accessibilityLabel={t("消息发送失败")} hitSlop={4} className="size-5"
                  onPress={retry}>
                  <Icon as={CircleAlert} className="size-5 text-destructive" />
                </Pressable>
              : <View accessible accessibilityRole="image" accessibilityLabel={t("消息发送失败")}><Icon as={CircleAlert} className="size-5 text-destructive" /></View>} />
        {item.delivery !== "sending" && (item.retryable
          ? <Pressable accessibilityRole="button" testID={`message-retry-${pending.clientId}`} hitSlop={2}
              onPress={retry}>
              <Text className="text-xs text-destructive">{t(item.delivery === "unconfirmed" ? "结果未确认，点按重试" : "点按重试")}</Text>
            </Pressable>
          : <Text className="text-xs text-destructive">{t("发送失败")}</Text>)}
      </View>
    );
  }
  const event = item.event!;
  const ownerId = timelineId ?? event.data.task_id ?? event.conversation_id!;
  switch (event.type) {
    case "message.user": {
      return <View className="gap-3">
        <MineBubble text={event.data.text} attachments={event.data.attachments} session={session}
          owner={{ timelineId: ownerId, messageSeq: event.seq }} active={visible} />
        {item.creatorName !== undefined && <Text testID={`interjection-${event.seq}`} className="self-center text-[13px] text-muted-foreground">
          {t("已打断这一轮 · 已告知 {agent}", { agent: item.creatorName })}
        </Text>}
      </View>;
    }
    case "message.task": {
      const { incoming, name, avatar } = item.counterpart!;
      return <View testID={`task-message-${event.seq}`} className={incoming ? "max-w-[86%] self-start gap-1.5" : "gap-1.5 px-0.5"}>
        <View className="flex-row items-center gap-1.5">
          {incoming && <WandrunAvatar index={avatar} alt={name} size={18} className="border border-border" />}
          <Text className="text-xs text-muted-foreground">{incoming ? name : t("交给 {agent}", { agent: name })}</Text>
        </View>
        <View className={incoming ? "rounded-[20px] rounded-tl-[4px] border border-border px-3.5 py-2.5" : undefined}>
          <AgentMemoryMarkdown content={event.data.text} selectable scrollCodeBlocks />
          <AttachmentPreview files={event.data.attachments ?? []} session={session}
            owner={{ timelineId: ownerId, messageSeq: event.seq }} active={visible} />
        </View>
      </View>;
    }
    case "message.agent":
      // Agent 的消息不加底色，直接排在背景上。
      return (
        <View className="px-0.5">
          <AgentSender name={item.senderName} />
          {typeof event.data.text === "string" && (item.kind === "agent" && item.phase === "interrupted"
            ? <DraftMessageContent text={event.data.text} interrupted />
            : <AgentMessageContent
              text={event.data.text}
              ui={Array.isArray(event.data.ui) ? event.data.ui : undefined}
              attachments={Array.isArray(event.data.attachments) ? event.data.attachments : undefined}
              submissions={item.submissions}
              draftOwner={{ session, conversationId: event.conversation_id!, timelineId: ownerId, messageSeq: event.seq }}
              onSubmit={async (block, values, clientId, actionId) => {
                await session.submitUi(ownerId, event.seq, block, values, clientId, actionId);
                onUiSubmitted?.();
              }}
            />)}
          {item.kind === "agent" && item.phase === "interrupted"
            ? <Text className="mt-1 text-xs text-muted-foreground">{t("已中断 · 内容未完成")}</Text>
            : Array.isArray(event.data.attachments) && <AttachmentPreview files={event.data.attachments} session={session}
              owner={{ timelineId: ownerId, messageSeq: event.seq }} active={visible} />}
        </View>
      );
    case "context.compacted":
      return <CompactedRow seq={event.seq} data={event.data as ContextCompactedData}
        agentName={item.agentName!} />;
    case "context.compaction_failed": {
      const data = event.data as ContextCompactionFailedData;
      return (
        <View testID={`context-compaction-failed-${event.seq}`} className="self-center">
          <Text className="text-center text-xs text-muted-foreground">{t("压缩未完成（{agent}）：{error}", { agent: item.agentName!, error: t(data.message || data.error) })}</Text>
        </View>
      );
    }
    case "takeover.ended":
      return (
        <View testID={`takeover-ended-${event.seq}`} className="self-center">
          <Text className="text-center text-xs text-muted-foreground">{t(event.data.text)}</Text>
        </View>
      );
    case "schedule.triggered":
      return (
        <View testID={`schedule-triggered-${event.seq}`} className="self-center">
          <Text className="text-center text-xs text-muted-foreground">{t("定时 · {name}", { name: event.data.name })}</Text>
        </View>
      );
    case "memory.updated":
      return (
        <Pressable testID={`memory-updated-${event.seq}`} accessibilityRole="button"
          accessibilityLabel={event.data.scope === "profile" ? t("查看关于你") : t("查看{agent}的工作记忆", { agent: item.agentName! })}
          onPress={() => event.data.scope === "profile" ? router.push("/settings-about-you") : router.push({ pathname: "/agents/[id]", params: { id: event.data.agent_id, tab: "memory" } })}
          className="self-center">
          <Text className="text-center text-xs text-muted-foreground">{t(event.data.summary || "已记住")} · {event.data.scope === "profile" ? t("查看关于你") : t("查看工作记忆")}</Text>
        </Pressable>
      );
    case "turn.stopped":
      return (
        <View className="self-center">
          <Text className="text-center text-xs text-muted-foreground">{t("你停止了这一轮及其下属工作")}</Text>
        </View>
      );
    case "turn.failed":
      return (
        <View testID={`turn-failed-${event.seq}`} className="self-center">
          <Text className="text-center text-xs text-muted-foreground">{t("这一轮未完成：{error}", {
            error: t(userErrorMessage(event.data.error, "原因未知")),
          })}</Text>
        </View>
      );
    default:
      return null;
  }
}
