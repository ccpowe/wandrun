import { Redirect, router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { useCallback, useMemo, useReducer, useSyncExternalStore } from "react";

import { SkillDetailView } from "@/components/skill-detail-view.tsx";
import { StatusBanner } from "@/components/status-banner.tsx";
import { GatewayError } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner, useConnectionLabel } from "@/lib/connection-banner.tsx";
import { skillDetailOptions } from "@/lib/gateway-queries.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { skillDeletion } from "@/lib/skill-deletion.ts";
import { selectSkillDetail, skillDetailInteractionReducer } from "@/lib/skill-detail.ts";
import { useGatewayQuery } from "@/lib/use-gateway-query.ts";
import { useDelayedNotice } from "@/lib/use-delayed-notice.ts";

export default function SkillDetailRoute() {
  const { name } = useLocalSearchParams<{ name?: string }>();
  const session = useSession();
  if (!session || !name) return <Redirect href="/settings-skills" />;
  return <SkillDetailScreen name={name} session={session} />;
}
export function SkillDetailScreen({ name, session }: { name: string; session: ChatSession }) {
  return <SkillDetailContainer key={`${session.queryIdentity}:${name}`} name={name} session={session} />;
}
function SkillDetailContainer({ name, session }: { name: string; session: ChatSession }) {
  const { t } = useTranslation();
  useSyncExternalStore(session.subscribe, session.getVersion);
  const connectionLabel = useConnectionLabel(session);
  const focused = useIsFocused();
  const [state, dispatch] = useReducer(skillDetailInteractionReducer, { status: "content" });
  const read = useGatewayQuery(skillDetailOptions(session, name));
  const deletion = useMemo(() => skillDeletion(session, name), [session, name]);
  const action = useSyncExternalStore(deletion.subscribe, deletion.snapshot);
  const users = (read.data?.used_by ?? []).map(user => ({ ...user, avatar: session.agents.agents.find(agent => agent.id === user.id)?.avatar }));
  const selection = selectSkillDetail(state, action, { gone: read.fetchStatus !== "paused" && read.error instanceof GatewayError && read.error.status === 404,
    focused, online: session.connection === "open", users: users.length });
  const showReadError = useDelayedNotice(read.error && !selection.gone ? name : null);
  const showUnknown = useDelayedNotice(action.phase === "unknown" ? name : null);
  useFocusEffect(useCallback(() => () => { deletion.leave(); }, [deletion]));
  useFocusEffect(useCallback(() => { if (selection.gone) router.dismissTo("/settings-skills"); }, [selection.gone]));
  const banner = <>
    <ConnectionBanner session={session} />
    {!connectionLabel && !selection.gone && action.error && !selection.dialog && (action.phase !== "unknown" || showUnknown) ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(action.error)} />
      : !connectionLabel && !selection.gone && !action.error && read.error && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t("无法加载技能，正在重试…")} description={read.data ? t("内容可能不是最新的") : undefined} /> : null}
  </>;
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <SkillDetailView name={name} detail={selection.gone ? undefined : read.data} users={users} selection={selection} action={action} banner={banner}
      loading={!read.data && !read.error && read.fetchStatus === "fetching"} refreshing={read.fetchStatus === "fetching" && !!read.data} online={session.connection === "open"}
      onBack={() => router.back()} onRefresh={() => void read.refresh()}
      onUsers={open => dispatch({ type: open ? "users-opened" : "users-closed" })}
      onUser={user => { dispatch({ type: "users-closed" }); router.push({ pathname: "/agents/[id]", params: { id: user.id } }); }}
      onDeleteCheck={() => void deletion.preflight()} onDelete={() => void deletion.remove()} onDeleteCancel={deletion.cancel} />
  </>;
}
