import { Redirect, router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, UserRound } from "lucide-react-native";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { GatewayError, type BuiltinSkillDetail } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useSession } from "@/lib/session-context.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { skillMarkdown } from "@/lib/skills.ts";

export default function BuiltinSkillDetailRoute() {
  const { name } = useLocalSearchParams<{ name?: string }>();
  const session = useSession();
  if (!session || !name) return <Redirect href="/settings-skills" />;
  return <BuiltinDetailScreen key={name} name={name} session={session} />;
}

function BuiltinDetailScreen({ name, session }: { name: string; session: ChatSession }) {
  const { t } = useTranslation();
  const revision = useSyncExternalStore(session.subscribe, () => session.skillRevision);
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState<BuiltinSkillDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useFocusEffect(useCallback(() => {
    setRetry((value) => value + 1);
  }, []));
  useEffect(() => {
    if (!focused) return;
    let active = true;
    void session.api.getBuiltinSkill(name).then(
      (value) => { if (active) { setDetail(value); setError(""); setLoading(false); } },
      (reason: unknown) => {
        if (!active) return;
        if (reason instanceof GatewayError && reason.status === 404) {
          router.dismissTo("/settings-skills");
          return;
        }
        setError(`无法加载内置技能：${reason instanceof Error ? reason.message : String(reason)}`);
        setLoading(false);
      },
    );
    return () => { active = false; };
  }, [session, name, revision, retry, focused]);

  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={detail?.name ?? name} left={<Button testID="builtin-detail-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回技能列表")} onPress={() => router.back()}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView testID="builtin-detail-screen" refreshControl={<RefreshControl refreshing={loading && !!detail} onRefresh={() => { setLoading(true); setRetry((value) => value + 1); }} />}
      contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}>
      {loading && !detail ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载内置技能…")}</Text> : null}
      {error ? <View className="mx-6 mt-5 items-center gap-2"><Text className="text-center text-sm text-destructive">{t(error)}</Text><Button variant="outline" onPress={() => { setLoading(true); setRetry((value) => value + 1); }}><Text>{t("重试")}</Text></Button></View> : null}
      {detail ? <>
        {detail.description ? <Text className="mx-[22px] mb-3 text-[15px] leading-[22px]">{detail.description}</Text> : null}
        <ListGroup>
          <View className="min-h-[52px] flex-row items-center justify-between gap-3 px-4 py-3"><Text className="text-[15px]">{t("来源")}</Text><Text className="text-[13px] text-muted-foreground">{t("系统内置")}</Text></View>
          <View className="min-h-[52px] flex-row items-center justify-between gap-3 px-4 py-3"><Text className="text-[15px]">{t("所属能力")}</Text><Text testID="builtin-capability" className="text-[13px] text-muted-foreground">{t(detail.capability.name)}</Text></View>
        </ListGroup>
        <ListGroup label={t("使用它的 Agent")}>
          {detail.used_by.length ? detail.used_by.map((agent) => {
            const avatar = session.agents.agents.find((item) => item.id === agent.id)?.avatar;
            return <Pressable key={agent.id} testID={`builtin-agent-${agent.id}`} accessibilityRole="button" accessibilityLabel={t("打开 {name} 资料", { name: agent.name })}
              onPress={() => router.push({ pathname: "/agents/[id]", params: { id: agent.id } })} className="min-h-[60px] flex-row items-center gap-3 px-4 py-2 active:bg-muted">
              {avatar === undefined
                ? <View className="size-7 items-center justify-center rounded-full bg-muted"><Icon as={UserRound} className="size-4" /></View>
                : <WandrunAvatar index={avatar} alt={agent.name} size={28} />}
              <Text className="min-w-0 flex-1 text-[15px]" numberOfLines={1}>{agent.name}</Text><Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
            </Pressable>;
          }) : <Text className="px-4 py-4 text-sm text-muted-foreground">{t("没有 Agent 使用这个技能")}</Text>}
        </ListGroup>
        <Text className="mx-8 mb-2 mt-5 text-[13px] text-muted-foreground">SKILL.md</Text>
        <View testID="builtin-skill-content" className="mx-[22px]"><AgentMemoryMarkdown content={skillMarkdown({ status: "ok", content: detail.content })!} /></View>
        <View className="min-h-7 flex-1" />
        <Text className="mx-8 mt-4 text-xs leading-[18px] text-muted-foreground">{t("随 Wandrun 更新，不可编辑或删除。")}</Text>
      </> : null}
    </ScrollView>
  </View>;
}
