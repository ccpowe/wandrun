import { router } from "expo-router";
import { Brain, Check, ChevronRight, CircleAlert, Clock, Hand, RefreshCw, Square } from "lucide-react-native";
import { Alert, Pressable, ScrollView, View, useWindowDimensions } from "react-native";

import { BrowserCard } from "@/components/chat/browser-card.tsx";
import { AgentMessageContent } from "@/components/chat/agent-message-content.tsx";
import { DraftMessageContent } from "@/components/chat/draft-message-content.tsx";
import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TASK_STATUS_LABEL, type Item } from "@/lib/chat-timeline.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import type { ContextCompactedData, ContextCompactionFailedData, FileRecord } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { TypingDots } from "./typing-dots.tsx";
import { AttachmentPreview } from "@/components/chat/attachment-preview.tsx";
import { ProgressRow } from "./progress-row.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { messagePreview } from "@/lib/message-preview.ts";
type CardFile = Pick<FileRecord, "id" | "name" | "size" | "media_type"> & Partial<Pick<FileRecord, "remote_environment">>;


/** My text bubble and the same attachment preview used by Agent messages. */
function MineBubble({ text, attachments = [], session, owner }: {
  text: string; attachments?: CardFile[]; session: ChatSession; owner?: { conversationId?: string; messageSeq?: number };
}) {
  return (
    <View className={attachments.length ? "w-[240px] max-w-[78%] self-end" : "max-w-[78%] self-end"}>
      {text ? <View className="self-end rounded-[20px] rounded-br-[6px] bg-primary px-3.5 py-2.5">
        <Text selectable className="text-base text-primary-foreground">{text}</Text>
      </View> : null}
      <AttachmentPreview files={attachments} session={session} owner={owner} mine />
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
          className="max-w-[300px] flex-row items-center gap-1.5 self-center rounded-2xl bg-muted px-3 py-1.5">
          <Icon as={RefreshCw} className="size-3.5 text-muted-foreground" />
          <Text className="shrink text-[13px] text-muted-foreground">{t("已压缩上下文（{agent}）", { agent: agentName })}</Text>
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
            <AgentMemoryMarkdown content={data.summary_text} />
          </View>
        </ScrollView>
      </DialogContent>
    </Dialog>
  );
}

/** The current timeline already identifies its Agent; only a different sender needs a name. */
function AgentSender({ session, timelineId, agentId, snapshotName }: {
  session: ChatSession; timelineId: string; agentId?: string; snapshotName?: string;
}) {
  if (!agentId || agentId === session.chat(timelineId)?.agent_id) return null;
  const name = agentDisplayName(session.agents, agentId, snapshotName);
  return <Text className="mb-0.5 text-xs text-muted-foreground">{name}</Text>;
}

/** 时间线上的一行：我的消息 / Agent 消息 / 停止、失败事件，以及还没确认的本地消息。 */
export function MessageRow({ item, session, visible = false, timelineId, onUiSubmitted }: {
  item: Item; session: ChatSession; visible?: boolean; timelineId?: string;
  /** Local form acceptance only; validation/rejection and other senders do not take over reading. */
  onUiSubmitted?: () => void;
}) {
  const { t } = useTranslation();
  if (item.delegation) {
    const { taskId, agentId, status } = item.delegation;
    const name = agentDisplayName(session.agents, agentId, item.event?.data.agent_name);
    return <ProgressRow testID={`delegation-${taskId}`}
      accessibilityLabel={t("委派 {agent} · {status}", { agent: name, status: t(TASK_STATUS_LABEL[status]) })}
      onPress={() => router.push({ pathname: "/c/[id]", params: { id: taskId } })}>
      {status === "running" || status === "waiting" ? <TypingDots />
        : <Icon as={status === "completed" ? Check : status === "failed" || status === "unavailable" ? CircleAlert : Square} className="size-4 text-muted-foreground" />}
      <Text numberOfLines={1} className="shrink text-sm">{t("委派 {agent} · {status}", { agent: name, status: t(TASK_STATUS_LABEL[status]) })}</Text>
      <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
    </ProgressRow>;
  }
  if (item.browser) {
    const agentId = item.browser.agent_id;
    const name = agentDisplayName(session.agents, agentId, item.browser.agent_name);
    return <BrowserCard task={item.browser} active={visible} agentName={name} />;
  }
  if (item.draft) return <View className="px-0.5" testID={`draft-${item.draft.draft_id}`}>
    <AgentSender session={session} timelineId={timelineId ?? item.draft.task_id ?? item.draft.conversation_id} agentId={item.draft.agent} />
    <DraftMessageContent text={item.draft.text} />
    <Text className="mt-1 text-xs text-muted-foreground">{t("生成中 · 尚未发送")}</Text>
  </View>;
  if (item.pending) {
    const pending = item.pending;
    return (
      <View className="flex-row items-center justify-end gap-2">
        {pending.status === "failed" && <Pressable
          testID={`message-failed-${pending.clientId}`}
          accessibilityRole="button"
          accessibilityLabel={t("消息发送失败，查看详情")}
          accessibilityHint={pending.retryable ? t("查看失败原因，并重试或删除消息") : t("查看失败原因或删除消息")}
          className="size-11 items-center justify-center"
          onPress={() => Alert.alert(t("发送失败"), pending.error ? t(pending.error) : t("消息未能发送。"), [
            { text: t("取消"), style: "cancel" },
            { text: t("删除消息"), style: "destructive", onPress: () => session.discard(pending.clientId) },
            ...(pending.retryable ? [{ text: t("重试"), onPress: () => { void session.retry(pending.clientId); } }] : []),
          ])}>
          <Icon as={CircleAlert} className="size-5 text-destructive" />
        </Pressable>}
        <MineBubble text={pending.text} attachments={pending.attachments} session={session} />
      </View>
    );
  }
  const event = item.event!;
  const ownerId = timelineId ?? event.data.task_id ?? event.conversation_id!;
  switch (event.type) {
    case "message.user": {
      const task = event.data.task_id ? session.tasks.get(ownerId) : undefined;
      const creatorName = task && agentDisplayName(session.agents, task.creator_agent_id);
      return <View className="gap-3">
        <MineBubble text={event.data.text} attachments={event.data.attachments} session={session}
          owner={{ conversationId: event.conversation_id, messageSeq: event.seq }} />
        {task && <Text testID={`interjection-${event.seq}`} className="self-center text-[13px] text-muted-foreground">
          {t("已打断这一轮 · 已告知 {agent}", { agent: creatorName ?? "" })}
        </Text>}
      </View>;
    }
    case "message.task_preview": {
      const agent = session.agents.agents.find((entry) => entry.id === event.data.agent_id);
      const name = agentDisplayName(session.agents, event.data.agent_id, event.data.agent_name);
      const attachments = Array.isArray(event.data.attachments) ? event.data.attachments : [];
      return <View testID={`task-preview-${event.seq}`}>
        <Pressable accessibilityRole="button" accessibilityLabel={t("查看 {agent} 给你的消息", { agent: name })}
          onPress={() => router.push({ pathname: "/c/[id]", params: { id: event.data.task_id, message_seq: String(event.data.message_seq) } })}
          className="flex-row items-center gap-2.5 rounded-2xl border border-border px-3 py-2.5">
          <WandrunAvatar index={agent?.avatar ?? 0} alt={name} size={28} className="border border-border" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="text-xs text-muted-foreground">{t("{agent} 给你发了消息", { agent: name })}</Text>
            <Text numberOfLines={1} className="text-sm">{messagePreview(event.data.text)}</Text>
          </View>
          <View className="h-8 justify-center rounded-full border-[1.5px] border-foreground px-3">
            <Text className="text-[13px] font-semibold">{t("查看")}</Text>
          </View>
        </Pressable>
        {attachments.length ? <AttachmentPreview files={attachments} session={session}
          owner={{ conversationId: event.data.task_id, messageSeq: event.data.message_seq }} /> : null}
      </View>;
    }
    case "message.task": {
      const incoming = event.data.recipient_task_id === ownerId;
      const counterpart = incoming ? event.data.sender_agent_id : event.data.recipient_agent_id;
      const agent = session.agents.agents.find((entry) => entry.id === counterpart);
      const name = agentDisplayName(session.agents, counterpart);
      return <View testID={`task-message-${event.seq}`} className={incoming ? "max-w-[86%] self-start gap-1.5" : "gap-1.5 px-0.5"}>
        <View className="flex-row items-center gap-1.5">
          {incoming && <WandrunAvatar index={agent?.avatar ?? 0} alt={name} size={18} className="border border-border" />}
          <Text className="text-xs text-muted-foreground">{incoming ? name : t("交给 {agent}", { agent: name })}</Text>
        </View>
        <View className={incoming ? "rounded-[20px] rounded-tl-[4px] border border-border px-3.5 py-2.5" : undefined}>
          <AgentMemoryMarkdown content={event.data.text} selectable />
          <AttachmentPreview files={event.data.attachments ?? []} session={session}
            owner={{ conversationId: event.conversation_id, messageSeq: event.seq }} />
        </View>
      </View>;
    }
    case "message.agent":
      // Agent 的消息不加底色，直接排在背景上。
      return (
        <View className="px-0.5">
          <AgentSender session={session} timelineId={ownerId} agentId={event.data.agent} snapshotName={event.data.agent_name} />
          {typeof event.data.text === "string" && (event.data.status === "interrupted"
            ? <DraftMessageContent text={event.data.text} interrupted />
            : <AgentMessageContent
              text={event.data.text}
              ui={Array.isArray(event.data.ui) ? event.data.ui : undefined}
              attachments={Array.isArray(event.data.attachments) ? event.data.attachments : undefined}
              submissions={session.submissionsFor(ownerId, event.seq)}
              draftOwner={{ session, conversationId: event.conversation_id!, timelineId: ownerId, messageSeq: event.seq }}
              onSubmit={async (block, values, clientId) => {
                await session.submitUi(ownerId, event.seq, block, values, clientId);
                onUiSubmitted?.();
              }}
            />)}
          {event.data.status === "interrupted"
            ? <Text className="mt-1 text-xs text-muted-foreground">{t("已中断 · 内容未完成")}</Text>
            : Array.isArray(event.data.attachments) && <AttachmentPreview files={event.data.attachments} session={session}
              owner={{ conversationId: event.conversation_id, messageSeq: event.seq }} />}
        </View>
      );
    case "context.compacted":
      return <CompactedRow seq={event.seq} data={event.data as ContextCompactedData}
        agentName={agentDisplayName(session.agents, event.data.agent_id, event.data.agent_name)} />;
    case "context.compaction_failed": {
      const data = event.data as ContextCompactionFailedData;
      return (
        <View testID={`context-compaction-failed-${event.seq}`} className="max-w-[300px] flex-row items-center gap-1.5 self-center rounded-2xl bg-muted px-3 py-1.5">
          <Icon as={CircleAlert} className="size-3.5 text-muted-foreground" />
          <Text className="shrink text-[13px] text-muted-foreground">{t("压缩未完成（{agent}）：{error}", { agent: agentDisplayName(session.agents, data.agent_id, data.agent_name), error: t(data.message || data.error) })}</Text>
        </View>
      );
    }
    case "takeover.ended":
      return (
        <View testID={`takeover-ended-${event.seq}`} className="max-w-[300px] flex-row items-center gap-1.5 self-center rounded-2xl bg-muted px-3 py-1.5">
          <Icon as={Hand} className="size-3.5 text-muted-foreground" />
          <Text className="shrink text-[13px] text-muted-foreground">{t(event.data.text)}</Text>
        </View>
      );
    case "schedule.triggered":
      return (
        <View testID={`schedule-triggered-${event.seq}`} className="flex-row items-center gap-1.5 self-center rounded-full bg-muted px-3 py-1.5">
          <Icon as={Clock} className="size-3.5 text-muted-foreground" />
          <Text className="text-[13px] text-muted-foreground">{t("定时 · {name}", { name: event.data.name })}</Text>
        </View>
      );
    case "memory.updated":
      return (
        <Pressable testID={`memory-updated-${event.seq}`} accessibilityRole="button"
          accessibilityLabel={t("查看{agent}的记忆", { agent: agentDisplayName(session.agents, event.data.agent_id, event.data.agent_name) })}
          onPress={() => router.push({ pathname: "/agents/[id]", params: { id: event.data.agent_id, tab: "memory" } })}
          className="flex-row items-center gap-1.5 self-center rounded-full border border-border bg-card px-3 py-1.5">
          <Icon as={Brain} className="size-3.5 text-muted-foreground" />
          <Text className="text-[13px] text-muted-foreground">{t(event.data.summary || "已记住")} · {t("查看记忆")}</Text>
        </Pressable>
      );
    case "turn.stopped":
      return (
        <View className="flex-row items-center gap-1.5 self-center">
          <Icon as={Square} className="size-3 text-muted-foreground" fill="currentColor" />
          <Text className="text-[13px] leading-[18px] text-muted-foreground">{t("你停止了这一轮及其下属工作")}</Text>
        </View>
      );
    case "turn.failed":
      return (
        <View className="rounded-lg bg-destructive/10 px-4 py-3.5">
          <Text className="text-[15px] text-destructive">{t("这一轮没有完成：{error}", { error: t(event.data.error) })}</Text>
          <Text className="mt-1 text-[13px] text-muted-foreground">{t("可以直接再发一条继续，已完成的内容会保留。")}</Text>
        </View>
      );
    default:
      return null;
  }
}
