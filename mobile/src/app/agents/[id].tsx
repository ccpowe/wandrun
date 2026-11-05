import { skipToken } from "@tanstack/react-query";
import { Redirect, router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useReducer, useSyncExternalStore } from "react";
import { AgentComputerTab } from "@/components/agent-computer-tab.tsx";
import { AgentProfileView } from "@/components/agent-profile-view.tsx";
import { GatewayError, type Schedule } from "@/gateway/api.ts";
import { newClientId, type ChatSession } from "@/gateway/session.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { agentProfileReducer, DEFAULT_PROFILE_TAB, profileStatus, selectAgentProfile, type ProfileTab } from "@/lib/agent-profile.ts";
import { ConnectionBanner, useConnectionLabel } from "@/lib/connection-banner.tsx";
import { chatLocation } from "@/lib/chat-route.ts";
import { agentDetailOptions, scheduleListOptions } from "@/lib/gateway-queries.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { retryDelay } from "@/lib/load-state.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useGatewayQuery } from "@/lib/use-gateway-query.ts";
import { useMemory } from "@/lib/use-memory.ts";
import { useFocusedVisit, useVisitNotice } from "@/lib/use-focused-visit.ts";
import { useNewConversationStore } from "@/lib/new-conversation-context.tsx";
import { userErrorMessage } from "@/lib/user-error.ts";

export default function AgentProfile() {
  const { id, tab } = useLocalSearchParams<{ id: string; tab?: string }>();
  const session = useSession();
  if (!session || !id) return <Redirect href="/" />;
  return <ProfileScreen id={id} initialTab={tab === "memory" || tab === "schedules" ? tab : DEFAULT_PROFILE_TAB} session={session} />;
}
export function ProfileScreen({ id, initialTab = DEFAULT_PROFILE_TAB, session }: { id: string; initialTab?: ProfileTab; session: ChatSession }) {
  return <ProfileContainer key={`${session.queryIdentity}:${id}:${initialTab}`} id={id} initialTab={initialTab} session={session} />;
}

/** Missing references ask the existing directory owner to refresh only while this section is focused. */
function MissingMembersRefresh({ session }: { session: ChatSession }) {
  useFocusEffect(useCallback(() => {
    const timer = setInterval(() => session.agents.refresh(), retryDelay(3));
    return () => clearInterval(timer);
  }, [session]));
  return null;
}

function ProfileContainer({ id, initialTab, session }: { id: string; initialTab: ProfileTab; session: ChatSession }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(agentProfileReducer, { status: "viewing", tab: initialTab });
  // agent-profile: a schedule toggle failure belongs to the visit that started it (useVisitNotice).
  const toggleResult = useVisitNotice();
  const focused = useIsFocused();
  const showOffline = useConnectionLabel(session) !== null;
  const offline = session.connection !== "open";
  const read = useGatewayQuery(agentDetailOptions(session, id));
  const schedules = useGatewayQuery(state.tab === "schedules" ? scheduleListOptions(session, id) : skipToken);
  const work = useMemory(session, "work", id, focused && state.tab === "memory");
  const profile = useMemory(session, "profile", "profile", focused && state.tab === "memory");
  const newDraft = useNewConversationStore();
  const captureVisit = useFocusedVisit();
  const operations = (schedules.data?.schedules ?? []).map(schedule => session.editorOperations.get(`schedule:${schedule.id}`));
  if (state.status !== "viewing" && !schedules.data?.schedules.some(schedule => schedule.id === state.scheduleId)) {
    operations.push(session.editorOperations.get(`schedule:${state.scheduleId}`));
  }
  const selection = selectAgentProfile(state, {
    id, detail: read.data, detailFailed: !!read.error,
    gone: read.error instanceof GatewayError && read.error.status === 404 || session.agents.deletedIds.has(id),
    agents: session.agents.agents, listLoaded: session.agents.loaded, listFailed: !!session.agents.error, offline,
    schedules: schedules.data?.schedules, scheduleFailed: !!schedules.error, schedulePaused: schedules.fetchStatus === "paused",
    scheduleReceiptRevision: session.scheduleReceiptRevision, scheduleReadRevision: schedules.data?.readRevision,
    memoryFailed: !!(work.error || profile.error), browserFailed: !!session.browserError, operations,
  });
  if (selection.adoption) dispatch(selection.adoption);

  const toggle = async (schedule: Schedule, enabled: boolean) => {
    const key = `schedule:${schedule.id}`;
    const outcome = session.editorOperations.get(key);
    if (selection.scheduleLocked || schedule.ended || session.connection !== "open" || outcome?.status === "pending" || outcome?.status === "unknown") return;
    const stillHere = captureVisit();
    if (!stillHere()) return;
    const operationId = newClientId();
    const publish = toggleResult.begin();
    dispatch({ type: "toggle-started", operationId, scheduleId: schedule.id });
    try {
      const result = await session.editorOperations.run(key, { operationId, resource: "schedule", id: schedule.id, action: "save", fields: { enabled }, baseline: { enabled: schedule.enabled } },
        () => session.api.updateSchedule(schedule.id, { enabled }));
      if (result?.event) session.connectorChanged(result.event);
      dispatch({ type: "toggle-succeeded", operationId });
    } catch (reason) {
      const settled = session.editorOperations.get(key);
      if (settled?.operationId === operationId && (settled.status === "unknown" || settled.reconciled)) dispatch({ type: "toggle-succeeded", operationId });
      else { dispatch({ type: "toggle-failed", operationId }); publish(userErrorMessage(reason, "无法更新定时")); }
    }
  };
  const feedback = offline ? null : state.tab === "schedules" && selection.scheduleUnknown ? t("保存结果未确认，正在核对…")
    : state.tab === "schedules" && toggleResult.notice ? t("无法更新定时：{error}", { error: t(toggleResult.notice) })
      : selection.feedback;
  if (selection.gone) return <Redirect href="/" />;
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    {state.tab === "members" && selection.missingMembers ? <MissingMembersRefresh session={session} /> : null}
    <AgentProfileView selection={selection} name={agentDisplayName(session.agents, id, read.data?.name)}
      status={selection.agent ? showOffline ? t("状态暂不可用") : profileStatus(id, session.conversations.values()) : null}
      detailFailed={!!read.error} feedback={feedback} scheduleUpdateFailed={!offline && state.tab === "schedules" && !selection.scheduleUnknown && !!toggleResult.notice} connectionBanner={<ConnectionBanner session={session} />}
      workMemory={work} sharedMemory={profile} browserContent={viewport => <AgentComputerTab id={id} session={session} viewport={viewport} />}
      onClose={() => router.back()} onEdit={() => { if (selection.canEdit && session.connection === "open") router.push({ pathname: "/agent-editor", params: { id } }); }}
      onTab={tab => dispatch({ type: "tab", tab })} onMember={agent => {
        if (!captureVisit()() || session.agents.deletedIds.has(agent.id)) return;
        const target = session.conversationFor(agent);
        if (target) router.push(chatLocation(target));
        else { newDraft.select(session.api.config.computerId!, agent.id); router.push(chatLocation()); }
      }} onToggle={(schedule, enabled) => void toggle(schedule, enabled)}
      onSchedule={scheduleId => router.push({ pathname: "/schedule-editor", params: { id: scheduleId, agentId: id } })}
      onWorkMemory={() => router.push({ pathname: "/memory-reader", params: { scope: "work", id } })}
      onSharedMemory={() => router.push("/settings-about-you")} />
  </>;
}
