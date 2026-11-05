import { Redirect, router, Stack } from "expo-router";
import { View } from "react-native";
import { CircleAlert, X } from "lucide-react-native";
import { useCallback, useSyncExternalStore } from "react";
import { SettingsSkillsView } from "@/components/settings-skills-view.tsx";
import { StatusBanner } from "@/components/status-banner.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner, useConnectionLabel } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useBuiltinSkillCatalog, useSkillCatalog } from "@/lib/skill-catalog.ts";
import { dismissSkillDeletionNotice, skillDeletionNotice, subscribeSkillDeletions } from "@/lib/skill-deletion.ts";
import { useOnVisitEnd } from "@/lib/use-focused-visit.ts";
import { useDelayedNotice } from "@/lib/use-delayed-notice.ts";

export default function SettingsSkillsRoute() {
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <SkillsList session={session} />;
}
export function SkillsList({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const catalog = useSkillCatalog(session);
  const builtins = useBuiltinSkillCatalog(session);
  const connection = useConnectionLabel(session);
  const readFailed = !!(catalog.error || builtins.error);
  const subscribeDeletions = useCallback((listener: () => void) => subscribeSkillDeletions(session, listener), [session]);
  const deleteNotice = useSyncExternalStore(subscribeDeletions, () => skillDeletionNotice(session));
  const readErrorIdentity = [catalog.error && "workspace", builtins.error && "builtin"].filter(Boolean).join("|");
  const showReadError = useDelayedNotice(readErrorIdentity || null);
  const showUnknown = useDelayedNotice(deleteNotice?.phase === "unknown" ? "deletion" : null);
  // A reconciled deletion result is shown to the list visit that sees it, then retired (unknown stays).
  useOnVisitEnd(useCallback(() => dismissSkillDeletionNotice(session), [session]));
  const banner = <><ConnectionBanner session={session} />{!connection && readFailed && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t("无法加载技能，正在重试…")}
    description={catalog.loaded || builtins.loaded ? t("内容可能不是最新的") : undefined} />
    : !connection && !readFailed && deleteNotice && (deleteNotice.phase !== "unknown" || showUnknown) ? <View testID="skills-delete-notice"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(deleteNotice.error)}
      action={deleteNotice.phase === "unknown" ? undefined : { icon: X, label: t("关闭提示"), onPress: () => dismissSkillDeletionNotice(session), testID: "skills-delete-notice-dismiss" }} /></View> : null}</>;
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <SettingsSkillsView skills={catalog.skills} builtins={builtins.skills} banner={banner}
      skillsLoading={!catalog.loaded && !catalog.error && catalog.fetchStatus === "fetching"} builtinsLoading={!builtins.loaded && !builtins.error && builtins.fetchStatus === "fetching"}
      empty={catalog.loaded && !catalog.error && catalog.fetchStatus !== "paused" && !catalog.skills.length} refreshing={catalog.refreshing || builtins.refreshing}
      onBack={() => router.back()} onRefresh={() => { void catalog.refresh(); void builtins.refresh(); }}
      onSkill={name => router.push({ pathname: "/skill-detail", params: { name } })} onBuiltin={name => router.push({ pathname: "/builtin-skill-detail", params: { name } })} />
  </>;
}
