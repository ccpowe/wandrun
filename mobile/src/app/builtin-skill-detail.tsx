import { Redirect, router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { useCallback } from "react";
import { BuiltinSkillDetailView } from "@/components/skill-detail-view.tsx";
import { StatusBanner } from "@/components/status-banner.tsx";
import { GatewayError } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner, useConnectionLabel } from "@/lib/connection-banner.tsx";
import { builtinSkillDetailOptions } from "@/lib/gateway-queries.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useGatewayQuery } from "@/lib/use-gateway-query.ts";
import { useDelayedNotice } from "@/lib/use-delayed-notice.ts";

export default function BuiltinSkillDetailRoute() {
  const { name } = useLocalSearchParams<{ name?: string }>();
  const session = useSession();
  if (!session || !name) return <Redirect href="/settings-skills" />;
  return <BuiltinDetailScreen name={name} session={session} />;
}
export function BuiltinDetailScreen({ name, session }: { name: string; session: ChatSession }) {
  return <BuiltinDetailContainer key={`${session.queryIdentity}:${name}`} name={name} session={session} />;
}
function BuiltinDetailContainer({ name, session }: { name: string; session: ChatSession }) {
  const { t } = useTranslation();
  const connectionLabel = useConnectionLabel(session);
  const read = useGatewayQuery(builtinSkillDetailOptions(session, name));
  const gone = read.fetchStatus !== "paused" && read.error instanceof GatewayError && read.error.status === 404;
  const showReadError = useDelayedNotice(read.error && !gone ? name : null);
  useFocusEffect(useCallback(() => { if (gone) router.dismissTo("/settings-skills"); }, [gone]));
  const banner = <><ConnectionBanner session={session} />{!connectionLabel && !gone && read.error && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t("无法加载内置技能，正在重试…")} description={read.data ? t("内容可能不是最新的") : undefined} /> : null}</>;
  const users = (read.data?.used_by ?? []).map(user => ({ ...user, avatar: session.agents.agents.find(agent => agent.id === user.id)?.avatar }));
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <BuiltinSkillDetailView name={name} detail={gone ? undefined : read.data} users={users} banner={banner}
      loading={!read.data && !read.error && read.fetchStatus === "fetching"} refreshing={read.fetchStatus === "fetching" && !!read.data}
      onBack={() => router.back()} onRefresh={() => void read.refresh()} onUser={user => router.push({ pathname: "/agents/[id]", params: { id: user.id } })} />
  </>;
}
