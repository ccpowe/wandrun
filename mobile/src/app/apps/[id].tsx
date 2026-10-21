import { Redirect, router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ConnectorOAuth } from "@/components/connector-oauth.tsx";
import { EditorRow } from "@/components/agent-editor-controls.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { AppEntry, Connector } from "@/gateway/api.ts";
import { createResultUnknown } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { connectorStatus } from "@/lib/connectors.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function AppDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const session = useSession();
  if (!session || !id) return <Redirect href="/" />;
  return <AppDetail key={`${session.api.config.baseUrl}:${id}`} session={session} id={id} />;
}

function AppDetail({ session, id }: { session: ChatSession; id: string }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const revision = useSyncExternalStore(session.subscribe, () => session.connectorRevision);
  const [retry, setRetry] = useState(0);
  const [entry, setEntry] = useState<AppEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<{ message: string; template?: string } | null>(null);
  const [autoStartConnectorId, setAutoStartConnectorId] = useState<string | null>(null);
  const command = useRef<string | null>(null);
  const operation = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useFocusEffect(useCallback(() => { setRetry((value) => value + 1); }, []));
  const boundConnectorId = entry?.connector?.id;
  useEffect(() => {
    // The app catalog discovers its binding only while unbound. Once bound, OAuth controls
    // own connector snapshots; a delayed catalog response must never overwrite them.
    if (boundConnectorId) return;
    let active = true;
    void session.api.listApps().then(({ apps }) => {
      if (!active || operation.current) return;
      const current = apps.find((item) => item.id === id);
      if (!current) { setEntry(null); setError("此应用已不在网关目录中"); setLoading(false); return; }
      setEntry((previous) => previous?.connector ? { ...current, connector: previous.connector } : current);
      setError("");
      setLoading(false);
      if (current.connector) command.current = null;
    }, (reason: unknown) => {
      if (active && !operation.current) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    return () => { active = false; };
  }, [session, id, retry, revision, boundConnectorId]);

  const update = useCallback((connector: Connector) => {
    setEntry((current) => current ? { ...current, connector } : current);
  }, []);
  const missingConnector = useCallback(() => {
    setAutoStartConnectorId(null);
    setEntry((current) => current ? { ...current, connector: null } : current);
    setRetry((value) => value + 1);
  }, []);
  const connect = async () => {
    if (operation.current || entry?.connector) return;
    operation.current = true;
    setConnecting(true);
    setConnectError(null);
    // An uncertain response keeps the same key; the gateway owns idempotent binding.
    const clientId = command.current ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    command.current = clientId;
    try {
      const { connector } = await session.api.connectApp(id, clientId);
      command.current = null;
      // A replay may return its original binding snapshot after another device has already
      // started or completed OAuth. Only the current connector may authorize auto-start.
      let current: Connector;
      try {
        current = await session.api.getConnector(connector.id);
      } catch {
        if (mounted.current) setConnectError({ message: "连接已建立，但暂时无法确认当前授权状态；请重试或返回应用列表刷新。" });
        return;
      }
      if (!mounted.current) return;
      setAutoStartConnectorId(current.auth.status === "unauthorized" && !current.auth.authorizing ? current.id : null);
      update(current);
    } catch (reason) {
      const unknown = createResultUnknown(reason);
      if (!unknown) command.current = null;
      if (mounted.current) setConnectError({ template: unknown ? "连接结果尚未确认，请重试或返回列表刷新：{error}" : "连接失败：{error}", message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      operation.current = false;
      setConnecting(false);
    }
  };

  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false, gestureEnabled: !connecting }} />
    <ScreenBar title={entry?.name ?? t("应用")} left={<Button testID="app-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回应用")} disabled={connecting} onPress={() => router.back()}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 28 }}>
      {entry ? <>
        <Text className="mx-6 mt-4 text-sm leading-5 text-muted-foreground">{t(entry.description)}</Text>
        {!entry.connector ? <View className="mx-5 mt-5 gap-3 rounded-md border border-border bg-card p-4">
          <Text className="text-sm leading-5">{t("连接会在网关中取得此应用的连接器，然后开始授权；按服务方要求在浏览器中完成。不会自动授予任何 Agent。")}</Text>
          {id === "github" ? <Text testID="app-github-permissions" className="text-xs leading-[18px] text-muted-foreground">{t("GitHub 的 repo 授权范围包含私有仓库的读取和写入，并非只读。令牌仅保存在网关；不会自动授予任何 Agent 使用权限。")}</Text> : null}
          <Button testID="app-connect" variant="outline" disabled={connecting} onPress={() => void connect()}><Text>{t(connecting ? "连接中…" : "连接应用")}</Text></Button>
          {connectError ? <Text testID="app-connect-error" className="text-sm text-destructive">{connectError.template ? t(connectError.template, { error: t(connectError.message) }) : t(connectError.message)}</Text> : null}
        </View> : <>
          <ListGroup label={t("OAuth 授权")}>
            <ConnectorOAuth key={entry.connector.id} session={session} connector={entry.connector} onChange={update} onMissing={missingConnector} autoStart={autoStartConnectorId === entry.connector.id} />
          </ListGroup>
          <ListGroup label={t("连接管理")}>
            <EditorRow label={t("连接器")} value={entry.connector.name} description={t("地址和授权方式由网关应用目录管理")} onPress={() => router.push({ pathname: "/connector-editor", params: { id: entry.connector!.id, fromApp: id } })} />
            <EditorRow label={t("连接状态")} value={connectorStatus(entry.connector).label} description={t("{count} 个工具", { count: entry.connector.tool_count })} />
          </ListGroup>
          <ListGroup label={t("Agent 使用范围")}>
            <EditorRow label={t("不是自动授予")} description={t("请到每个 Agent 编辑 › 连接器中，显式选择直接携带或按需搜索。")} />
            {entry.connector.used_by.map((agent) => <EditorRow key={agent.id} testID={`app-agent-${agent.id}`} label={agent.name} description={t("打开 Agent 编辑")} onPress={() => router.push({ pathname: "/agent-editor", params: { id: agent.id } })} />)}
            <EditorRow testID="app-select-agent" label={t("选择可使用的 Agent")} description={t("打开全部 Agent；进入需要授权的 Agent 编辑页选择连接器")} onPress={() => router.push("/agents")} />
          </ListGroup>
        </>}
      </> : null}
      {loading ? <Text className="mx-8 mt-10 text-center text-sm text-muted-foreground">{t("正在加载应用…")}</Text> : null}
      {error ? <View className="mx-6 mt-8 items-center gap-3"><Text testID="app-error" className="text-sm text-destructive">{t(error)}</Text><Button testID="app-retry" variant="outline" onPress={() => { setLoading(true); setRetry((value) => value + 1); }}><Text>{t("重试")}</Text></Button></View> : null}
    </ScrollView>
  </View>;
}
