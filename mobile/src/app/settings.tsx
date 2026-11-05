import { router, Stack } from "expo-router";
import { useReducer } from "react";

import { SettingsServerCards } from "@/components/settings-server-cards.tsx";
import { SettingsView, type SettingsEntry } from "@/components/settings-view.tsx";
import { newClientId, type ChatSession } from "@/gateway/session.ts";
import { useAppearance } from "@/lib/appearance-context.tsx";
import { useConnectionLabel } from "@/lib/connection-banner.tsx";
import type { SavedComputer } from "@/lib/credentials.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { subscriptionView } from "@/lib/model-usage.ts";
import { memoryEntryCount } from "@/lib/memory-index.ts";
import { useGateway, useSession } from "@/lib/session-context.tsx";
import { useSettingsConnection, useSettingsData } from "@/lib/settings-data.ts";
import { connectorSettingsSummary, modelSettingsSummary } from "@/lib/settings-summary.ts";
import { selectSettingsPage, settingsSwitchReducer } from "@/lib/settings.ts";
import { useVisitNotice } from "@/lib/use-focused-visit.ts";
import { useDelayedNotice } from "@/lib/use-delayed-notice.ts";

export default function Settings() {
  const { config, computers, switchComputer } = useGateway();
  const session = useSession();
  return <SettingsPage key={config?.connectionId ?? "none"} session={session} computer={config} computers={computers} switchComputer={switchComputer} />;
}

export function SettingsPage({ session, computer, computerName, computers = [], switchComputer }: {
  session: ChatSession | null; computer?: SavedComputer | null; computerName?: string; computers?: readonly SavedComputer[];
  switchComputer?: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const appearance = useAppearance();
  const data = useSettingsData(session);
  const connection = useSettingsConnection(session);
  const connectionLabel = useConnectionLabel(session);
  const [state, dispatch] = useReducer(settingsSwitchReducer, { status: "idle" });
  // settings.S2: the switch-failure result belongs to the visit that started the switch.
  const result = useVisitNotice();
  const resources = [...Object.values(data), connection];
  const selection = selectSettingsPage(state, session?.connection === "open", connectionLabel, resources, result.notice ?? "");
  const readErrorIdentity = [...Object.entries(data).filter(([, resource]) => !!resource.error).map(([key]) => key),
    ...(connection.error ? ["connection"] : [])].join("|");
  const showReadError = useDelayedNotice(readErrorIdentity || null);
  const theme = t(appearance.theme === "system" ? "跟随系统" : appearance.theme === "dark" ? "深色" : "浅色");

  async function selectServer(next: SavedComputer) {
    if (state.status !== "idle" || !switchComputer) return;
    if (next.authStatus === "invalid") { router.push({ pathname: "/connect", params: { address: next.baseUrl, repair: next.connectionId } }); return; }
    const operationId = newClientId();
    const publish = result.begin();
    dispatch({ type: "switch-started", operationId });
    try { await switchComputer(next.computerId); dispatch({ type: "switch-succeeded", operationId }); }
    catch { dispatch({ type: "switch-failed", operationId }); publish("切换服务器失败，请重试。"); }
  }
  const open = (entry: SettingsEntry) => router.push(`/settings-${entry}`);
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <SettingsView message={selection.dismissible || connectionLabel || showReadError ? selection.message : ""} stale={selection.stale} disabled={selection.disabled}
      onDismissMessage={selection.dismissible ? result.dismiss : undefined}
      serverCards={<SettingsServerCards computers={computers} current={computer} session={session} name={computerName ?? connection.data?.computer_name}
        version={connection.data?.gateway_version ?? computer?.gatewayVersion} busy={selection.busy} onManage={() => router.push("/gateway-connection")} onSwitch={next => void selectServer(next)}
        onOpen={next => router.push({ pathname: "/gateway-connection", params: { computer: next.computerId } })} />}
      entries={{
        models: { summary: data.subscription.data ? modelSettingsSummary(subscriptionView(data.subscription.data, session?.connection !== "open" || data.subscription.fetchStatus === "paused" || !!data.subscription.error)) : undefined, pending: data.subscription.fetchStatus === "fetching" && !data.subscription.error },
        skills: { summary: data.skills.data ? { text: data.skills.data.failed ? t("{failed} 个失败 · 共 {total}", { failed: data.skills.data.failed, total: data.skills.data.total }) : String(data.skills.data.total), danger: data.skills.data.failed > 0 } : undefined, pending: data.skills.fetchStatus === "fetching" && !data.skills.error },
        connectors: { summary: data.connectors.data ? connectorSettingsSummary(data.connectors.data.connectors) : undefined, pending: data.connectors.fetchStatus === "fetching" && !data.connectors.error },
        "about-you": { summary: data.profile.data ? { text: t("{count} 条", { count: memoryEntryCount(data.profile.data.content) }), danger: false } : undefined, pending: !data.profile.error },
        appearance: { summary: { text: `${theme} · ${appearance.language === "zh" ? "中文" : "English"}`, danger: false } },
      }} onBack={() => router.canGoBack() ? router.back() : router.replace("/")} onOpen={open} />
  </>;
}
