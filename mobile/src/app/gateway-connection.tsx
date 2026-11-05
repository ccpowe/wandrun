import Constants from "expo-constants";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useReducer } from "react";

import { GatewayConnectionView } from "@/components/gateway-connection-view.tsx";
import { newClientId } from "@/gateway/session.ts";
import { useConnectionLabel } from "@/lib/connection-banner.tsx";
import type { SavedComputer } from "@/lib/credentials.ts";
import { connectionActionReducer, selectConnectionAction, validLocalName } from "@/lib/gateway-connection.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useGateway, useSession } from "@/lib/session-context.tsx";
import { useSettingsConnection } from "@/lib/settings-data.ts";
import { useVisitNotice, type VisitNotice } from "@/lib/use-focused-visit.ts";

export default function GatewayConnection() {
  const { config } = useGateway();
  // settings.D2/D7/T6/T7: this page visit owns its one-time results (switch failure, "server record not
  // removed"). They live outside the keyed container so removing the current server (a remount) keeps them.
  const switchResult = useVisitNotice();
  const remoteResult = useVisitNotice<true>();
  return <GatewayConnectionContainer key={config?.connectionId ?? "none"} switchResult={switchResult} remoteResult={remoteResult} />;
}

function GatewayConnectionContainer({ switchResult, remoteResult }: { switchResult: VisitNotice<string>; remoteResult: VisitNotice<true> }) {
  const { t } = useTranslation();
  const { computer: requested } = useLocalSearchParams<{ computer?: string }>();
  const { computers, config, switchComputer, renameComputer, disconnect } = useGateway();
  // settings.C8: a saved non-current server can be shown by id. Once it is removed (or
  // repaired into the current server) the same page derives back to the current server.
  const shown = computers.find(computer => computer.computerId === requested && computer.computerId !== config?.computerId) ?? config;
  const session = useSession();
  const details = useSettingsConnection(session);
  const connectionLabel = useConnectionLabel(session);
  const [state, dispatch] = useReducer(connectionActionReducer, { status: "idle", error: "" });
  const action = selectConnectionAction(state);

  async function selectComputer(computer: SavedComputer) {
    if (state.status !== "idle") return;
    if (computer.authStatus === "invalid") {
      router.push({ pathname: "/gateway-connection", params: { computer: computer.computerId } });
      return;
    }
    const operationId = newClientId();
    const publish = switchResult.begin();
    dispatch({ type: "switch-started", targetId: computer.computerId, operationId });
    try { await switchComputer(computer.computerId); dispatch({ type: "succeeded", operationId }); }
    catch { dispatch({ type: "failed", operationId }); publish("切换服务器失败，请重试。"); }
  }
  async function confirm() {
    if (state.status !== "rename" && state.status !== "disconnect") return;
    if (state.status === "rename" && !validLocalName(state.draft)) { dispatch({ type: "invalid-name" }); return; }
    const operationId = newClientId();
    dispatch({ type: "confirmed", operationId });
    try {
      if (state.status === "rename") await renameComputer(state.targetId, state.draft.trim());
      else { const publish = remoteResult.begin(); await disconnect(state.targetId, () => publish(true)); }
      dispatch({ type: "succeeded", operationId });
    } catch { dispatch({ type: "failed", operationId }); }
  }

  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <GatewayConnectionView session={session} config={shown} current={shown === config} computers={computers} details={details.data}
      readError={details.error !== null} pending={details.fetchStatus === "fetching" && !details.error} connectionLabel={connectionLabel}
      appVersion={Constants.expoConfig?.version ?? t("未知")} action={action} remoteNotice={remoteResult.notice === true} onDismissRemoteNotice={remoteResult.dismiss}
      switchNotice={switchResult.notice} onDismissSwitchNotice={switchResult.dismiss}
      onBack={() => router.canGoBack() ? router.back() : router.replace("/settings")}
      onSelect={computer => void selectComputer(computer)} onAdd={() => router.push({ pathname: "/connect", params: { mode: "add" } })}
      onRepair={() => { if (shown) router.push({ pathname: "/connect", params: { address: shown.baseUrl, repair: shown.connectionId } }); }}
      onRename={() => { if (shown) dispatch({ type: "rename-opened", targetId: shown.computerId, draft: shown.localName ?? "" }); }}
      onDisconnect={() => { if (shown) dispatch({ type: "disconnect-opened", targetId: shown.computerId }); }}
      onName={draft => dispatch({ type: "name-changed", draft })} onCancel={() => dispatch({ type: "cancelled" })} onConfirm={() => void confirm()} />
  </>;
}
