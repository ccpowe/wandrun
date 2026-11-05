import { Pressable, View } from "react-native";

import { AlertCircle, WifiOff, X } from "lucide-react-native";
import { StatusBanner } from "@/components/status-banner.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { ChatLocalNotice, ChatNotice } from "@/lib/chat-notices.ts";
import { useTranslation } from "@/lib/i18n.ts";

/** Reads recover in the background; only an unconfirmed write offers a user retry. */
export function ChatNotices({ notices, onRetryStop }: {
  notices: ChatNotice[];
  onRetryStop(): void;
}) {
  const { t } = useTranslation();
  return <View className="gap-2" testID="chat-notices">
    {notices.map(({ kind, message }) => {
      const retry = kind === "stop" ? t("重试停止") : null;
      return <View key={kind} testID={`chat-${kind}-error`} className="gap-1">
        <StatusBanner icon={kind === "offline" ? WifiOff : AlertCircle} title={message} accessibilityRole="alert" />
        {retry && <Pressable testID={`chat-${kind}-retry`} accessibilityRole="button" accessibilityLabel={retry}
          hitSlop={12} className="self-start px-4" onPress={onRetryStop}>
          <Text className="text-[13px] text-primary">{retry}</Text>
        </Pressable>}
      </View>;
    })}
  </View>;
}

/** This screen's own action result, shown in place under the banner instead of a system dialog.
 * design.md §6: closing is an × inside the banner, not a separate text link. */
export function ChatLocalNoticeView({ notice, onDismiss }: {
  /** Unknown first-action hints are owned by the app draft and stay until retried. */
  notice: ChatLocalNotice; onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  return <View testID={`chat-local-${notice.kind}`}>
    <StatusBanner icon={AlertCircle} title={notice.title} description={notice.description || undefined} accessibilityRole="alert"
      action={onDismiss ? { icon: X, label: t("关闭提示"), onPress: onDismiss, testID: "chat-local-dismiss" } : undefined} />
  </View>;
}
