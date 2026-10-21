import { Redirect, router, Stack, useFocusEffect } from "expo-router";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react-native";
import { useCallback } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { Connector } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { useConnectorCatalog } from "@/lib/connector-catalog.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { connectorAuthLabel, connectorStatus } from "@/lib/connectors.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function SettingsConnectorsRoute() {
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <ConnectorList session={session} />;
}

function ConnectorList({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const catalog = useConnectorCatalog(session);
  const insets = useSafeAreaInsets();
  const { refresh } = catalog;
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("连接器")} left={<Button testID="connectors-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回设置")} onPress={() => router.back()}><Icon as={ChevronLeft} className="size-[22px]" /></Button>}
      right={<Button testID="connectors-add" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("添加连接器")} onPress={() => router.push("/connector-editor")}><Icon as={Plus} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {catalog.connectors.length > 0 ? <ListGroup>{catalog.connectors.map((connector) => <ConnectorRow key={connector.id} connector={connector} />)}</ListGroup> : null}
      {catalog.loaded && !catalog.connectors.length ? <Text className="mx-8 mt-12 text-center text-sm text-muted-foreground">{t("还没有连接器。点右上角 ＋ 添加。")}</Text> : null}
      {!catalog.loaded && !catalog.error ? <Text className="mx-8 mt-8 text-center text-sm text-muted-foreground">{t("正在加载连接器…")}</Text> : null}
      {catalog.error ? <View className="mx-6 mt-5 items-center gap-2"><Text className="text-center text-sm text-destructive">{t(catalog.error)}</Text><Button variant="outline" onPress={catalog.refresh}><Text>{t("重试")}</Text></Button></View> : null}
      <Text className="mx-8 mt-4 text-xs leading-[18px] text-muted-foreground">{t("使用或测试时连接，网关退出时关闭；使用方式在 Agent 编辑 › 连接器中选择。")}</Text>
    </ScrollView>
  </View>;
}

function ConnectorRow({ connector }: { connector: Connector }) {
  const { t } = useTranslation();
  const status = connectorStatus(connector);
  const details = connector.used_by.length
    ? `${connectorAuthLabel(connector)} · ${t(status.label)} · ${t("{count} 个工具", { count: connector.tool_count })} · ${t("{count} 个 Agent 使用", { count: connector.used_by.length })}`
    : `${connectorAuthLabel(connector)} · ${t(status.label)} · ${t("{count} 个工具", { count: connector.tool_count })}`;
  return <Pressable testID={`connector-${connector.id}`} accessibilityRole="button" accessibilityLabel={`${connector.name}，${t(status.label)}`}
    onPress={() => router.push({ pathname: "/connector-editor", params: { id: connector.id } })}
    className="min-h-[68px] flex-row items-center gap-3 px-4 py-2.5 active:bg-muted">
    <View className="min-w-0 flex-1 gap-0.5">
      <Text className={`text-[17px] font-medium ${!connector.used_by.length && !status.failed ? "text-muted-foreground" : ""}`} numberOfLines={1}>{connector.name}</Text>
      {status.failed ? <>
        <Text className="text-[13px] leading-[18px] text-destructive" numberOfLines={2}>{t(status.label)}</Text>
        <Text className="text-[13px] text-muted-foreground">{connectorAuthLabel(connector)} · {t("{count} 个工具", { count: connector.tool_count })} · {t("{count} 个 Agent 使用", { count: connector.used_by.length })}</Text>
      </> : <Text className="text-[13px] text-muted-foreground" numberOfLines={2}>{details}</Text>}
      {connector.pending_restart ? <Text className="text-xs text-muted-foreground">{t("参数待重启生效")}</Text> : null}
    </View>
    {status.failed ? <View className="size-2 rounded-full bg-destructive" /> : null}
    <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
  </Pressable>;
}
