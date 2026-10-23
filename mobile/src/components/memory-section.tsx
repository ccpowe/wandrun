import { router } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";

import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { MemoryScope } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { memoryModified } from "@/lib/agent-memory.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useMemory } from "@/lib/use-memory.ts";

/** One reading surface for working memory and the global About You resource. */
export function MemorySection({ scope, id, session, focused }: { scope: MemoryScope; id: string; session: ChatSession; focused: boolean }) {
  const { t } = useTranslation();
  const { memory, error, retry, notFound } = useMemory(session, scope, id, focused);
  const modified = memory ? memoryModified(memory, scope === "work" ? agentDisplayName(session.agents, id) : undefined) : null;
  const prefix = scope === "profile" ? "profile-shared-memory" : "profile-memory";
  useEffect(() => {
    if (scope === "work" && notFound) router.dismissTo("/");
  }, [scope, notFound]);
  const edit = <Button testID={`${prefix}-edit`} variant="outline" size="sm" className="h-8 rounded-full border-foreground bg-background px-3.5"
    disabled={!memory} onPress={() => router.push({ pathname: "/memory-editor", params: { id, scope } })}>
    <Text className="text-[13px]">{t("编辑")}</Text>
  </Button>;
  return <View>
    {error ? <View className="mx-[22px] mt-4 gap-2">
      <Text testID={`${prefix}-error`} className="text-sm text-destructive">{t("无法加载记忆：{error}", { error: t(error) })}</Text>
      <Button testID={`${prefix}-retry`} variant="outline" size="sm" className="self-start" onPress={retry}><Text>{t("重试")}</Text></Button>
    </View> : null}
    {!memory && !error ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载记忆…")}</Text> : null}
    {memory ? memory.content ? <>
      <View className="mt-4 flex-row items-center gap-2 pl-[22px] pr-5">
        <Text testID={`${prefix}-modified`} className="flex-1 text-xs leading-4 text-muted-foreground">{modified}</Text>
        {edit}
      </View>
      <View testID={`${prefix}-content`} className="mx-[22px]">
        <AgentMemoryMarkdown content={memory.content} memoryIndex managedMemory={{ memory, onOpen: (slug) => router.push({ pathname: "/memory-detail", params: { scope, id, slug } }) }} />
      </View>
    </> : <View testID={scope === "work" ? "profile-empty-memory" : `${prefix}-empty`} className="items-center gap-3.5 px-8 pt-[72px]">
      <Text className="text-[15px] text-muted-foreground">{scope === "profile" ? t("还没有内容") : t("还没有工作记忆")}</Text>
      {edit}
    </View> : null}
  </View>;
}
