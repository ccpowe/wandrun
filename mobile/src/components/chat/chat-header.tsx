import { router } from "expo-router";
import { ChevronLeft, Menu } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import type { AgentSummary } from "@/gateway/api.ts";
import { useTranslation } from "@/lib/i18n.ts";

type Props = {
  agent: AgentSummary | undefined;
  title: string;
  source?: "user" | "schedule";
  paddingTop: number;
  /** 打开该 Agent 的对话列表抽屉；对话信息还没加载时不传，按钮置灰。 */
  onOpenConversations?: () => void;
  collaboration?: { creatorName: string; rootId: string; rootTitle: string };
};

/** 顶栏共用资料入口；成员副标题额外提供返回根对话的路径。 */
export function ChatHeader({ agent, title, source, paddingTop, onOpenConversations, collaboration }: Props) {
  const { t } = useTranslation();
  return (
    <View className="min-h-[60px] flex-row items-center gap-2 border-b border-border px-4 pb-2" style={{ paddingTop }}>
      <Button variant="ghost" size="icon" className="bg-transparent" onPress={() => router.back()} aria-label={t("返回")}>
        <Icon as={ChevronLeft} className="size-[22px]" />
      </Button>
      <View className="min-w-0 flex-1 items-center">
        {agent && (
          <Pressable
            className="max-w-full flex-row items-center gap-2"
            onPress={() => router.push({ pathname: "/agents/[id]", params: { id: agent.id } })}
            accessibilityRole="button"
            accessibilityLabel={t("查看{agent}资料", { agent: agent.name })}
            testID="chat-agent-profile"
          >
            <WandrunAvatar index={agent.avatar} alt={agent.name} size={28} className="border border-border" />
            <Text className="shrink text-lg font-semibold" numberOfLines={1} testID="chat-agent-name">
              {agent.name}
            </Text>
          </Pressable>
        )}
        {collaboration ? <Pressable testID="chat-root-conversation" accessibilityRole="button"
          accessibilityLabel={t("返回根对话 {title}", { title: collaboration.rootTitle })}
          onPress={() => router.push({ pathname: "/c/[id]", params: { id: collaboration.rootId } })}
          className="max-w-full py-1">
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            {t("{creator} 发起 · {title}", { creator: collaboration.creatorName, title: collaboration.rootTitle || t("新对话") })} ›
          </Text>
        </Pressable> : <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1} testID="chat-conversation-title">
          {source === "schedule" ? t("定时 · {title}", { title: title || t("新对话") }) : title || t("新对话")}
        </Text>}
      </View>
      <Button
        variant="ghost"
        size="icon"
        className="bg-transparent"
        onPress={onOpenConversations}
        disabled={!onOpenConversations}
        aria-label={t("对话列表")}
      >
        <Icon as={Menu} className="size-[22px]" />
      </Button>
    </View>
  );
}
