import { Pressable, View } from "react-native";

import { CHAT_FLOATING_SURFACE } from "@/components/chat/chat-surface.ts";
import { Text } from "@/components/ui/text.tsx";
import type { ChatNotice, ChatNoticeKind } from "@/lib/chat-notices.ts";
import { useTranslation } from "@/lib/i18n.ts";

/** The screen owns recovery actions; cards never interpret gateway errors or change their order. */
export function ChatNotices({ notices, onRetry, canRetryCollaboration }: {
  notices: ChatNotice[];
  onRetry(kind: ChatNoticeKind): void;
  canRetryCollaboration: boolean;
}) {
  const { t } = useTranslation();
  const labels = {
    history: t("重试加载历史消息"), stop: t("重试停止"),
    collaboration: t("重试加载协作"), target: t("重试加载目标消息"),
  };
  return <View className="gap-2 px-3" testID="chat-notices">
    {notices.map(({ kind, message }) => {
      const retry = kind !== "offline" && (kind !== "collaboration" || canRetryCollaboration) ? labels[kind] : null;
      return <View key={kind} testID={`chat-${kind}-error`} style={CHAT_FLOATING_SURFACE}
        className="gap-2 rounded-2xl border border-border bg-card px-3 py-2.5">
        <Text accessibilityRole="alert" className="text-[13px] leading-[18px] text-foreground">{message}</Text>
        {retry && <Pressable testID={`chat-${kind}-retry`} accessibilityRole="button" accessibilityLabel={retry}
          onPress={() => onRetry(kind)}>
          <Text className="text-[13px] text-primary">{retry}</Text>
        </Pressable>}
      </View>;
    })}
  </View>;
}
