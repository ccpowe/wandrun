// 首页：Agent 列表的派生视图（ADR-0022 约定 9）。数据与刷新在 session.agents，这里只负责展示和手势。

import { router, Stack } from "expo-router";
import { Archive, Bot, LayoutGrid, Plus, Search, UserRound } from "lucide-react-native";
import { Alert, FlatList, View } from "react-native";

import { EmptyState } from "@/components/empty-state.tsx";
import { ListLoadError } from "@/components/list-load-error.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { PopoverMenu } from "@/components/popover-menu.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { SwipeRow } from "@/components/swipe-row.tsx";
import { TypingDots } from "@/components/chat/typing-dots.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import type { AgentSummary } from "@/gateway/api.ts";
import { formatActivityTime, homeAgents, homeRowText } from "@/lib/agent-list.ts";
import { ConnectionBanner, useConnectionLabel } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useMinuteClock } from "@/lib/use-minute-clock.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useOpenAgentChat } from "@/lib/use-open-agent-chat.ts";

export default function Home() {
  const session = useSession();
  if (!session) return null;
  return <HomeScreen session={session} />;
}

function HomeScreen({ session }: { session: NonNullable<ReturnType<typeof useSession>> }) {
  const { t } = useTranslation();
  const open = useOpenAgentChat(session);
  const { agents, loaded, error } = session.agents;
  const now = useMinuteClock();
  const offline = session.connection !== "open";
  const showOffline = useConnectionLabel(session) !== null;
  const onHome = homeAgents(agents);

  const hide = async (agent: AgentSummary) => {
    try {
      await session.agents.hide(agent.id);
    } catch (error) {
      Alert.alert(t("无法移出首页"), error instanceof Error ? t(error.message) : String(error));
    }
  };

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBar
        left={
          <Button variant="ghost" size="icon" className="size-11 rounded-full bg-muted" aria-label={t("设置")} onPress={() => router.push("/settings")}>
            <Icon as={UserRound} className="size-[22px]" />
          </Button>
        }
        right={<View className="flex-row items-center gap-1">
          <Button testID="home-search" variant="ghost" size="icon" className="size-11 rounded-full" aria-label={t("搜索")} onPress={() => router.push("/search")}>
            <Icon as={Search} className="size-[22px]" />
          </Button>
          <PopoverMenu
            trigger={{ icon: Plus, label: t("新建 Agent 或查看全部 Agent") }}
            disabled={offline}
            items={[
              { label: t("新建 Agent"), icon: Bot, onPress: () => router.push("/agent-editor") },
              { label: t("全部 Agent"), testID: "home-menu-all-agents", icon: LayoutGrid, onPress: () => router.push("/agents") },
            ]}
          />
        </View>}
      />
      <View className="h-4" />
      <ConnectionBanner session={session} />
      {!offline && error !== null && <ListLoadError hasData={loaded} onRetry={() => session.agents.refresh()} />}
      {loaded && onHome.length === 0 ? (
        <EmptyState
          title={agents.length === 0 ? t("还没有 Agent") : t("首页没有 Agent")}
          description={agents.length > 0 ? t("可从“全部 Agent”放回首页。") : undefined}
        >
          {agents.length > 0 && (
            <Button variant="outline" className="min-w-[200px]" onPress={() => router.push("/agents")}>
              <Text>{t("全部 Agent")}</Text>
            </Button>
          )}
          <Button testID="home-create-agent" variant="outline" className="min-w-[200px]" disabled={offline} onPress={() => router.push("/agent-editor")}>
            <Text>{t("新建 Agent")}</Text>
          </Button>
        </EmptyState>
      ) : (
        // 离线时列表置灰但仍可点进已加载的对话。
        <FlatList
          className={showOffline ? "opacity-55" : undefined}
          data={onHome}
          keyExtractor={(agent) => agent.id}
          renderItem={({ item }) => (
            <SwipeRow
              contentClassName="bg-background"
              action={{ label: t("移出首页"), icon: Archive, onPress: () => void hide(item) }}
            >
              <HomeRow
                agent={item}
                activity={session.conversations.get(item.latest_conversation?.id ?? "")?.activity ?? null}
                now={now}
                offline={showOffline}
                requestedConversation={session.requestedBrowser(item.id)?.root_id}
                onOpen={open}
              />
            </SwipeRow>
          )}
        />
      )}
    </View>
  );
}

function HomeRow({
  agent,
  activity,
  now,
  offline,
  onOpen,
  requestedConversation,
}: {
  agent: AgentSummary;
  activity: string | null;
  now: Date;
  offline: boolean;
  requestedConversation?: string;
  onOpen: (agent: AgentSummary) => void;
}) {
  const { t, locale } = useTranslation();
  const text = homeRowText(agent, activity, offline);
  const at = agent.latest_conversation?.last_activity_at;
  const systemSubtitle = text.kind === "failed" || offline && agent.latest_conversation?.status === "working" ||
    !agent.latest_conversation?.last_text?.trim() && !agent.description.trim();
  return (
    <ListRow
      testID={`agent-row-${agent.id}`}
      leading={<WandrunAvatar index={agent.avatar} alt={agent.name} size={52} className="border border-border" />}
      title={agent.name}
      meta={at == null ? null : formatActivityTime(at, now, locale)}
      subtitle={
        <>
          {text.kind === "working" && <TypingDots />}
          <RowSubtitle text={requestedConversation ? t("等你接管浏览器") : text.kind === "working" ? activity ? t("工作中 · {activity}", { activity: t(activity) }) : t("工作中") : systemSubtitle ? t(text.text) : text.text} tone={requestedConversation ? "error" : text.kind === "working" ? "active" : text.kind === "failed" ? "error" : "muted"} />
        </>
      }
      alert={agent.unread || requestedConversation !== undefined}
      onPress={() => requestedConversation ? router.push({ pathname: "/c/[id]", params: { id: requestedConversation } }) : onOpen(agent)}
    />
  );
}
