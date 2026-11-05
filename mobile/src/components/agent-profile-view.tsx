import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { CircleAlert, Pencil, X } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AgentMemoryTab, type AgentMemoryRead } from "./agent-memory-tab.tsx";
import { AgentSchedulesTab } from "./agent-schedules-tab.tsx";
import { GroupRow } from "./group-row.tsx";
import { ListGroup } from "./list-group.tsx";
import { ScreenBar } from "./screen-bar.tsx";
import { StatusBanner } from "./status-banner.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Text } from "./ui/text.tsx";
import { WandrunAvatar } from "./wandrun-avatar.tsx";
import type { AgentSummary, Schedule } from "../gateway/api.ts";
import type { AgentProfileSelection, ProfileTab } from "../lib/agent-profile.ts";
import { useTranslation } from "../lib/i18n.ts";
import { useDelayedNotice } from "../lib/use-delayed-notice.ts";

export type ProfileViewport = { offset: number; height: number };
export type AgentProfileViewProps = {
  selection: AgentProfileSelection; name: string; status: string | null;
  detailFailed: boolean; feedback: string | null; connectionBanner: ReactNode;
  /** The feedback shown is this visit's schedule toggle failure (test hook for agent-profile schedules). */
  scheduleUpdateFailed?: boolean;
  workMemory: AgentMemoryRead; sharedMemory: AgentMemoryRead;
  browserContent(viewport: ProfileViewport): ReactNode;
  onClose(): void; onEdit(): void; onTab(tab: ProfileTab): void;
  onMember(agent: AgentSummary): void; onToggle(schedule: Schedule, enabled: boolean): void; onSchedule(id: string): void;
  onWorkMemory(): void; onSharedMemory(): void;
};
const tabs: { id: ProfileTab; label: string }[] = [
  { id: "computer", label: "浏览器" }, { id: "schedules", label: "定时" },
  { id: "members", label: "成员" }, { id: "memory", label: "记忆" },
];

/** Layout refs contain only native geometry; business data and commands arrive through props. */
export function AgentProfileView(props: AgentProfileViewProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const [viewport, setViewport] = useState<ProfileViewport>({ offset: 0, height: 0 });
  const { selection, name, status, feedback } = props;
  const feedbackKind = selection.tab === "schedules" && selection.scheduleUnknown ? "schedule-unknown" : props.detailFailed ? "detail" : selection.tab;
  const showPersistent = useDelayedNotice(feedback && !props.scheduleUpdateFailed ? `${selection.agent?.id}:${feedbackKind}` : null);
  const selectTab = (tab: string) => {
    const selected = tabs.find(item => item.id === tab);
    if (!selected) return;
    scroll.current?.scrollTo({ y: 0, animated: false });
    setViewport(current => ({ ...current, offset: 0 }));
    props.onTab(selected.id);
  };
  return <View className="flex-1 bg-page-surface">
    <ScreenBar left={<Button testID="profile-close" intent="quiet" size="icon" accessibilityLabel={t("关闭")} onPress={props.onClose}><Icon as={X} size={22} /></Button>}
      right={<Button testID="profile-edit" intent="quiet" size="icon" accessibilityLabel={t("编辑 Agent")} disabled={!selection.canEdit} onPress={props.onEdit}><Icon as={Pencil} size={20} /></Button>} />
    {props.connectionBanner}
    {feedback && (props.scheduleUpdateFailed || showPersistent) ? <View testID={props.scheduleUpdateFailed ? "profile-schedules-update-error" : undefined}><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(feedback)} /></View> : null}
    <ScrollView ref={scroll} contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}
      onLayout={event => { const height = event.nativeEvent.layout.height; setViewport(current => ({ ...current, height })); }}
      scrollEventThrottle={200} onScroll={event => {
        if (selection.tab !== "computer") return;
        const offset = event.nativeEvent.contentOffset.y;
        setViewport(current => ({ ...current, offset }));
      }}>
      <View className="items-center px-4 pb-1 pt-2">
        {selection.agent ? <WandrunAvatar index={selection.agent.avatar} alt={name} size={88} /> : null}
        <Text testID="profile-name" className="mt-3 text-center text-[24px] font-medium leading-8">{selection.agent ? name : t(props.detailFailed ? "资料暂不可用" : "加载中…")}</Text>
        {status ? <Text variant="caption" className="mt-1 text-muted-foreground">{status}</Text> : null}
      </View>
      <Tabs value={selection.tab} onValueChange={selectTab} className="mt-5 gap-0">
        <View className="px-4"><TabsList>{tabs.map(item => <TabsTrigger key={item.id} testID={`profile-tab-${item.id}`} accessibilityLabel={t(item.label)} value={item.id}><Text>{t(item.label)}</Text></TabsTrigger>)}</TabsList></View>
        {selection.tab === "members" ? <>
          {selection.membersLoading ? !props.detailFailed && <Text variant="caption" className="mt-12 text-center text-muted-foreground">{t("正在加载成员…")}</Text>
            : selection.membersEmpty ? <ListGroup className="mt-5"><View className="min-h-[52px] justify-center px-4"><Text testID="profile-empty-members" variant="caption" className="text-muted-foreground">{t("没有成员")}</Text></View></ListGroup>
              : selection.members.length ? <ListGroup className="mt-5">{selection.members.map(member => <GroupRow key={member.id} testID={`profile-member-${member.id}`}
                leading={<WandrunAvatar index={member.avatar} alt={member.name} size={28} />} title={member.name} description={member.description.trim() || member.id}
                affordance="navigate" onPress={() => props.onMember(member)} />)}</ListGroup> : null}
        </> : selection.tab === "schedules" ? <AgentSchedulesTab selection={selection} onToggle={props.onToggle} onOpen={props.onSchedule} />
          : selection.tab === "memory" ? <AgentMemoryTab name={name} work={props.workMemory} profile={props.sharedMemory} onWork={props.onWorkMemory} onProfile={props.onSharedMemory} />
            : props.browserContent(viewport)}
      </Tabs>
    </ScrollView>
  </View>;
}
