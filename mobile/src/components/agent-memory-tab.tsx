import { router, useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { GatewayError, type AgentMemory } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { memoryModified } from "@/lib/agent-memory.ts";
import { useTranslation } from "@/lib/i18n.ts";

export function AgentMemoryTab({ id, session }: { id: string; session: ChatSession }) {
  const { t } = useTranslation();
  const [memory, setMemory] = useState<AgentMemory | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const focused = useIsFocused();
  const revision = session.memoryRevisionFor(id);
  const connectionRevision = session.memoryConnectionRevision;

  // External file edits and unchanged saves emit no SSE event; refetch on return.
  useEffect(() => {
    if (!focused) return;
    let active = true;
    void session.api.getAgentMemory(id).then(
      (snapshot) => {
        if (!active || session.agents.deletedIds.has(id) ||
          session.memoryRevisionFor(id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
        setMemory(snapshot);
        setError("");
      },
      (reason: unknown) => {
        if (!active || session.memoryRevisionFor(id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
        if (reason instanceof GatewayError && reason.status === 404) {
          router.dismissTo("/");
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => { active = false; };
  }, [session, id, revision, connectionRevision, retry, focused]);

  return (
    <View className="min-h-[320px] flex-1">
      <View className="mx-8 mt-3 flex-row items-center justify-between">
        <Text testID="profile-memory-modified" className="flex-1 text-xs text-muted-foreground">{memory ? memoryModified(memory) : t("跨对话记忆")}</Text>
        <Button testID="profile-memory-edit" variant="outline" size="sm" className="h-8 border-foreground"
          disabled={!memory} onPress={() => router.push({ pathname: "/memory-editor", params: { id } })}>
          <Text className="text-sm">{t("编辑")}</Text>
        </Button>
      </View>
      {error ? <View className="mx-8 mt-2 gap-2">
        <Text testID="profile-memory-error" className="text-sm text-destructive">{t("无法加载记忆：{error}", { error: t(error) })}</Text>
        <Button testID="profile-memory-retry" variant="outline" size="sm" className="self-start" onPress={() => setRetry((value) => value + 1)}><Text>{t("重试")}</Text></Button>
      </View> : null}
      {!memory && !error ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载记忆…")}</Text> : null}
      {memory ? <>
        {memory.content ? (
          <View testID="profile-memory-content" className="mx-[22px] mt-3">
            <AgentMemoryMarkdown content={memory.content} />
          </View>
        ) : (
          <View testID="profile-empty-memory" className="min-h-[240px] flex-1">
            <EmptyState title={t("它还没有记忆")} description={t("记忆是供未来对话使用的少量稳定背景。")} />
          </View>
        )}
      </> : null}
    </View>
  );
}
