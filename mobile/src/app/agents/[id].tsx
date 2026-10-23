import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { Brain, ChevronRight, Clock, Monitor, Pencil, Users, X } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentMemoryTab } from "@/components/agent-memory-tab.tsx";
import { AgentComputerTab } from "@/components/agent-computer-tab.tsx";
import { AgentSchedulesTab } from "@/components/agent-schedules-tab.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ListLoadError } from "@/components/list-load-error.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { DEFAULT_PROFILE_TAB, profileLoadFailed, profileMembers, profileStatus, type ProfileState, type ProfileTab } from "@/lib/agent-profile.ts";
import { ConnectionBanner, useConnectionLabel } from "@/lib/connection-banner.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useOpenAgentChat } from "@/lib/use-open-agent-chat.ts";
import { cn } from "@/lib/utils.ts";
import { useTranslation } from "@/lib/i18n.ts";

const TABS = [
  { id: "computer", label: "电脑", icon: Monitor },
  { id: "schedules", label: "定时", icon: Clock },
  { id: "members", label: "成员", icon: Users },
  { id: "memory", label: "记忆", icon: Brain },
] as const;

export default function AgentProfile() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <ProfileScreen key={`${id}:${tab ?? ""}`} id={id} initialTab={tab === "memory" || tab === "schedules" ? tab : DEFAULT_PROFILE_TAB} session={session} />;
}

function ProfileScreen({ id, initialTab, session }: { id: string; initialTab: ProfileTab; session: ChatSession }) {
  const { t, language } = useTranslation();
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const scroll = useRef<ScrollView>(null);
  const [viewport, setViewport] = useState({ offset: 0, height: 0 });
  const [profile, setProfile] = useState<ProfileState>({ status: "available", detail: null, error: null });
  const { detail, error } = profile;
  const [retry, setRetry] = useState(0);
  const insets = useSafeAreaInsets();
  const open = useOpenAgentChat(session);
  const { agents, loaded, error: listError, definitionVersion } = session.agents;
  const offline = session.connection !== "open";
  const showOffline = useConnectionLabel(session) !== null;

  useEffect(() => {
    let active = true;
    // 资源变化、重连或显式重试均重拉；过期请求和卸载后的响应不能覆盖新资料。
    void session.api.getAgent(id).then(
      (value) => { if (active) setProfile({ status: "available", detail: value, error: null }); },
      (reason: unknown) => { if (active) setProfile((current) => profileLoadFailed(current, reason)); },
    );
    return () => { active = false; };
  }, [id, session, definitionVersion, session.connection, retry]);

  const agent = agents.find((item) => item.id === id) ?? detail;
  const { members, missing } = detail ? profileMembers(detail, agents) : { members: [], missing: [] };
  const refresh = () => { setRetry((value) => value + 1); session.agents.refresh(); };

  if (profile.status === "not-found" || session.agents.deletedIds.has(id)) return <Redirect href="/" />;

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBar left={
        <Button testID="profile-close" variant="ghost" size="icon" className="bg-transparent" aria-label={t("关闭")} onPress={() => router.back()}>
          <Icon as={X} className="size-[22px]" />
        </Button>
      } right={
        <Button testID="profile-edit" variant="ghost" size="icon" className="bg-transparent" aria-label={t("编辑 Agent")}
          disabled={offline || !detail} onPress={() => router.push({ pathname: "/agent-editor", params: { id } })}>
          <Icon as={Pencil} className="size-[22px]" />
        </Button>
      } />
      <ConnectionBanner session={session} />
      <ScrollView ref={scroll} contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}
        onLayout={(event) => {
          // State updaters may run after React Native releases the pooled event.
          const height = event.nativeEvent.layout.height;
          setViewport((current) => ({ ...current, height }));
        }}
        scrollEventThrottle={200}
        onScroll={(event) => {
          if (tab !== "computer") return;
          const offset = event.nativeEvent.contentOffset.y;
          setViewport((current) => ({ ...current, offset }));
        }}>
        <View className="items-center gap-1 px-4 pb-5">
          {agent && <WandrunAvatar index={agent.avatar} alt={agent.name} size={88} className="border border-border" />}
          <Text testID="profile-name" className="mt-2.5 text-center text-xl font-semibold">{agent?.name ?? (error ? t("资料暂不可用") : t("加载中…"))}</Text>
          {agent && <Text className="text-sm text-muted-foreground">{showOffline ? t("状态暂不可用") : profileStatus(id, session.conversations.values())}</Text>}
        </View>
        <View accessibilityRole="tablist" className="mx-4 flex-row rounded-[12px] bg-muted p-[3px]">
          {TABS.map((item) => (
            <Button key={item.id} testID={`profile-tab-${item.id}`} variant="ghost" accessibilityRole="tab"
              accessibilityState={{ selected: tab === item.id }} aria-label={t(item.label)}
              onPress={() => { scroll.current?.scrollTo({ y: 0, animated: false }); setViewport((current) => ({ ...current, offset: 0 })); setTab(item.id); }}
              // English labels use the icon space; no flex shorthand may override their content basis.
              className={cn("h-[38px] min-w-0 gap-1.5 rounded-[9px] border",
                language === "en" ? "grow shrink-0 basis-auto px-1" : "flex-1 px-0",
                tab === item.id ? "border-border bg-card" : "border-transparent bg-transparent")}
            >
              {language !== "en" && <Icon as={item.icon} className={cn("size-[18px]", tab !== item.id && "text-muted-foreground")} />}
              <Text className={cn("text-sm font-medium", tab !== item.id && "text-muted-foreground")}>{t(item.label)}</Text>
            </Button>
          ))}
        </View>
        {error && <View className="mx-8 mt-4 gap-2"><Text className="text-sm text-destructive">{t("无法加载资料：{error}，请重试", { error: t(error.message) })}</Text><Button variant="outline" onPress={refresh}><Text>{t("重试")}</Text></Button></View>}
        {tab === "members" ? (
          <>
            {!offline && listError && <ListLoadError hasData={loaded} onRetry={refresh} />}
            <View className="mx-8 mt-3 flex-row items-center justify-between">
              <Text className="text-xs text-muted-foreground">{t("成员 · {count}", { count: detail?.workers.length ?? 0 })}</Text>
              <Button testID="profile-edit-members" variant="ghost" className="h-9 bg-transparent px-0" disabled={offline || !detail}
                onPress={() => router.push({ pathname: "/agent-editor", params: { id, section: "members" } })}>
                <Text className="text-sm">{t("修改")}</Text>
              </Button>
            </View>
            {!detail || !loaded ? (
              !error && <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载成员…")}</Text>
            ) : detail.workers.length === 0 ? (
              <View testID="profile-empty-members" className="min-h-[320px] flex-1">
                <EmptyState title={t("没有成员")} />
              </View>
            ) : (
              <>
                <ListGroup>
                  {members.map((member) => (
                    <ListRow key={member.id} testID={`profile-member-${member.id}`} compact
                      leading={<WandrunAvatar index={member.avatar} alt={member.name} size={40} className="border border-border" />}
                      title={member.name} subtitle={<RowSubtitle compact text={member.description.trim() || member.id} />}
                      trailing={<Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />}
                      onPress={() => void open(member)} />
                  ))}
                </ListGroup>
                {missing.length > 0 && <View className="mx-8 mt-3 gap-2"><Text className="text-sm text-muted-foreground">{t("部分成员资料暂不可用")}</Text><Button variant="outline" onPress={refresh}><Text>{t("重新加载")}</Text></Button></View>}
              </>
            )}
          </>
        ) : tab === "schedules" ? (
          <AgentSchedulesTab id={id} name={agent?.name ?? "Agent"} session={session} />
        ) : tab === "memory" ? (
          <AgentMemoryTab id={id} session={session} />
        ) : (
          <AgentComputerTab id={id} session={session} viewport={viewport} />
        )}
      </ScrollView>
    </View>
  );
}
