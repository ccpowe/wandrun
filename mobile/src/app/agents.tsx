// 全部 Agent：分“在首页 / 不在首页”两组，按名字本地过滤；点一个进入它的编辑，不在首页的左滑“放回首页”（聊天从首页进入）。

import { Redirect, router, Stack } from "expo-router";
import { ArchiveRestore, ChevronLeft, Search } from "lucide-react-native";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { ListGroup } from "@/components/list-group.tsx";
import { ListLoadError } from "@/components/list-load-error.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { SwipeRow } from "@/components/swipe-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import type { AgentSummary } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { groupAgents } from "@/lib/agent-list.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function AllAgents() {
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <AllAgentsScreen session={session} />;
}

function AllAgentsScreen({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { agents, loaded, error } = session.agents;
  const { onHome, hidden } = groupAgents(agents, query);
  const offline = session.connection !== "open";

  const unhide = async (agent: AgentSummary) => {
    try {
      await session.agents.unhide(agent.id);
    } catch (error) {
      Alert.alert(t("无法放回首页"), t(error instanceof Error ? error.message : String(error)));
    }
  };

  const row = (agent: AgentSummary) => (
    <ListRow
      testID={`agent-row-${agent.id}`}
      compact
      leading={<WandrunAvatar index={agent.avatar} alt={agent.name} size={40} className="border border-border" />}
      title={agent.name}
      subtitle={<RowSubtitle compact text={agent.description.trim() || agent.id} />}
      onPress={() => router.push({ pathname: "/agent-editor", params: { id: agent.id } })}
    />
  );

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBar
        title={t("全部 Agent")}
        left={
          <Button variant="ghost" size="icon" className="bg-transparent" aria-label={t("返回")} onPress={() => router.back()}>
            <Icon as={ChevronLeft} className="size-[22px]" />
          </Button>
        }
      />
      <ConnectionBanner session={session} />
      {!offline && error !== null && <ListLoadError hasData={loaded} onRetry={() => session.agents.refresh()} />}
      <View className="mx-4 mb-2 mt-1 flex-row items-center gap-2 rounded-[12px] border border-input px-3">
        <Icon as={Search} className="size-[18px] text-muted-foreground" />
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder={t("搜索 Agent")}
          aria-label={t("搜索 Agent")}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          className="flex-1 border-0 bg-transparent px-0"
        />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerClassName="pb-8">
        <ListGroup label={t("在首页 · {count}", { count: onHome.length })}>
          {onHome.map((agent) => (
            <View key={agent.id}>{row(agent)}</View>
          ))}
        </ListGroup>
        <ListGroup label={t("不在首页 · {count}", { count: hidden.length })}>
          {hidden.map((agent) => (
            <SwipeRow
              key={agent.id}
              contentClassName="bg-card"
              action={{ label: t("放回首页"), icon: ArchiveRestore, onPress: () => void unhide(agent) }}
            >
              {row(agent)}
            </SwipeRow>
          ))}
        </ListGroup>
        {loaded && onHome.length + hidden.length === 0 && (
          <Text className="mt-12 text-center text-sm text-muted-foreground">
            {query.trim() ? t("没有名字匹配的 Agent") : t("还没有 Agent")}
          </Text>
        )}
        {hidden.length > 0 && (
          <Text className="mx-8 mt-2.5 text-xs text-muted-foreground">{t("左滑“不在首页”的 Agent 可放回首页。")}</Text>
        )}
      </ScrollView>
    </View>
  );
}
