import { router, useIsFocused } from "expo-router";
import { ChevronRight, UserRound } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { MemorySection } from "@/components/memory-section.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { memoryModified } from "@/lib/agent-memory.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { memoryEntryCount } from "@/lib/memory-index.ts";
import { useMemory } from "@/lib/use-memory.ts";

export function AgentMemoryTab({ id, session }: { id: string; session: ChatSession }) {
  const focused = useIsFocused();
  const { t } = useTranslation();
  const { memory, error } = useMemory(session, "profile", "profile", focused);
  const modified = memory ? memoryModified(memory) : null;
  const summary = !memory ? error ? t("暂不可用") : t("加载中…") : !memory.content ? t("还没有内容") :
    modified ? t("{count} 条 · {modified}", { count: memoryEntryCount(memory.content), modified }) : t("{count} 条", { count: memoryEntryCount(memory.content) });
  return <View className="min-h-[520px] flex-1 pb-8">
    <MemorySection scope="work" id={id} session={session} focused={focused} />
    <Pressable testID="profile-about-you" accessibilityRole="button" onPress={() => router.push("/settings-about-you")}
      className="mx-4 mt-[18px] min-h-14 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3.5 py-3 active:bg-accent">
      <View className="size-9 items-center justify-center rounded-full bg-muted"><Icon as={UserRound} className="size-5" /></View>
      <View className="min-w-0 flex-1 gap-px">
        <Text className="text-base font-medium">{t("关于你")}</Text>
        <Text testID="profile-about-you-summary" numberOfLines={1} className="text-xs text-muted-foreground">{summary}</Text>
      </View>
      <Icon as={ChevronRight} className="size-5 text-muted-foreground" />
    </Pressable>
  </View>;
}
