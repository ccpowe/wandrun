import { router } from "expo-router";
import { SquarePen, TextAlignStart } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { CHAT_FLOATING_SURFACE } from "@/components/chat/chat-surface.ts";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import type { AgentSummary } from "@/gateway/api.ts";
import { chatSubtitle } from "@/lib/chat-header.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { TypingDots } from "./typing-dots.tsx";


type Props = {
  agent: AgentSummary | undefined;
  title: string;
  source?: "user" | "schedule";
  paddingTop: number;
  /** The drawer stays unavailable until the conversation has loaded. */
  onOpenConversations?: () => void;
  collaboration?: { creatorName: string; rootId: string; rootTitle: string };
  working: boolean;
  browserUrl?: string;
  newConversationDisabled: boolean;
  onNewConversation?: () => void;
};

/** Three floating controls; the complete center capsule always opens the Agent profile. */
export function ChatHeader({ agent, title, source, paddingTop, onOpenConversations, collaboration, working, browserUrl, newConversationDisabled, onNewConversation }: Props) {
  const { t } = useTranslation();
  const subtitle = chatSubtitle({ title, source, collaboration, browserUrl }, t);
  const newDisabled = newConversationDisabled || !onNewConversation;
  return (
    <View className="flex-row items-center gap-2 px-3" style={{ paddingTop: paddingTop + 4 }}>
      <Pressable
        className="size-11 items-center justify-center rounded-full border border-border bg-card disabled:opacity-50"
        style={CHAT_FLOATING_SURFACE}
        onPress={onOpenConversations}
        disabled={!onOpenConversations}
        accessibilityRole="button"
        accessibilityLabel={t("对话列表")}
      >
        <Icon as={TextAlignStart} className="size-[22px]" />
      </Pressable>
      <View className="min-w-0 flex-1 items-center">
        {agent && <Pressable
          className="h-11 max-w-full flex-row items-center gap-2 rounded-full border border-border bg-card pl-1.5 pr-4"
          style={CHAT_FLOATING_SURFACE}
          onPress={() => router.push({ pathname: "/agents/[id]", params: { id: agent.id } })}
          accessibilityRole="button"
          accessibilityLabel={t("查看{agent}资料", { agent: agent.name })}
          testID="chat-agent-profile"
        >
          <WandrunAvatar index={agent.avatar} alt={agent.name} size={28} className="size-8 border border-border" />
          <View className="min-w-0 shrink items-start">
            <Text className="max-w-full text-[15px] leading-[19px] font-semibold" numberOfLines={1} testID="chat-agent-name">
              {agent.name}
            </Text>
            <View className="max-w-[160px] min-w-0 flex-row items-center gap-1">
              {working && <TypingDots compact />}
              <Text className="min-w-0 shrink text-[12px] leading-[15px] text-muted-foreground" numberOfLines={1} testID="chat-conversation-title">
                {subtitle}
              </Text>
            </View>
          </View>
        </Pressable>}
      </View>
      <Pressable
        className="size-11 items-center justify-center rounded-full border border-border bg-card"
        style={[CHAT_FLOATING_SURFACE, newDisabled && { opacity: 0.55 }]}
        onPress={newDisabled ? undefined : onNewConversation}
        disabled={newDisabled}
        accessibilityRole="button"
        accessibilityLabel={t("新对话")}
        testID="chat-new-conversation"
      >
        <Icon as={SquarePen} className={newDisabled ? "size-[22px] text-muted-foreground" : "size-[22px]"} />
      </Pressable>
    </View>
  );
}
