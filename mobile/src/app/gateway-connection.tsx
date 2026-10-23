import Constants from "expo-constants";
import { router, Stack, useFocusEffect } from "expo-router";
import { Check, ChevronLeft, ChevronRight, Monitor, Pencil, Plus } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListGroup } from "@/components/list-group.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { ConnectionInfo } from "@/gateway/api.ts";
import type { SavedComputer } from "@/lib/credentials.ts";
import { t, useTranslation } from "@/lib/i18n.ts";
import { useGateway, useSession } from "@/lib/session-context.tsx";

type Action = "rename" | "disconnect" | null;

const displayName = (computer: SavedComputer) => computer.localName || computer.computerName || t("电脑");

export default function GatewayConnection() {
  const { t, locale } = useTranslation();
  const { computers, config, switchComputer, renameComputer, disconnect } = useGateway();
  const session = useSession();
  const insets = useSafeAreaInsets();
  const [details, setDetails] = useState<ConnectionInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [name, setName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const selected = computers.find((computer) => computer.computerId === selectedId) ?? config;
  const isCurrent = !!selected && selected.computerId === config?.computerId;

  useFocusEffect(useCallback(() => {
    if (!session) return;
    const controller = new AbortController();
    void session.api.connection(controller.signal).then((result) => {
      if (!controller.signal.aborted) setDetails(result);
    }).catch(() => {
      if (!controller.signal.aborted) setDetails(null);
    });
    return () => { controller.abort(); };
  }, [session]));

  const switchToSelected = async () => {
    if (!selected || isCurrent || working) return;
    setWorking(true);
    setError("");
    try {
      await switchComputer(selected.computerId);
    } catch {
      setError("切换电脑失败，请重试。");
    } finally {
      setWorking(false);
    }
  };

  const confirm = async () => {
    if (!selected || !action || working) return;
    setWorking(true);
    setError("");
    try {
      if (action === "rename") await renameComputer(selected.computerId, name.trim());
      else await disconnect(selected.computerId);
      setAction(null);
    } catch {
      setAction(null);
      setError(action === "rename"
        ? "无法保存备注名，请重试。"
        : "断开结果未确认，请检查电脑连接后重试；电脑列表可能尚未更新。");
    } finally {
      setWorking(false);
    }
  };

  const method = isCurrent ? details?.pairing_method ?? selected?.pairingMethod : selected?.pairingMethod;
  const pairedAt = isCurrent ? details?.paired_at ?? selected?.pairedAt : selected?.pairedAt;
  const formattedDate = pairedAt ? new Date(pairedAt).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" }) : "—";
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("关于与连接")} left={<Button testID="gateway-back" variant="ghost" size="icon" className="bg-transparent" aria-label={t("返回")}
      onPress={() => router.canGoBack() ? router.back() : router.replace("/settings")}><Icon as={ChevronLeft} className="size-[22px]" /></Button>}
      right={<Button testID="connection-add" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("添加电脑")}
        onPress={() => router.push({ pathname: "/connect", params: { mode: "add" } })}><Icon as={Plus} className="size-[22px]" /></Button>} />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
      <ListGroup label={t("电脑")}>
        {computers.map((computer) => <ListRow key={computer.computerId} testID={`connection-computer-${computer.computerId}`}
          compact
          leading={<View className="size-10 items-center justify-center rounded-[12px] bg-muted"><Icon as={Monitor} className="size-5" /></View>}
          title={displayName(computer)}
          meta={computer.authStatus === "invalid" ? t("需要重新配对") : computer.computerId === config?.computerId ? t("当前") : undefined}
          subtitle={<RowSubtitle compact text={computer.baseUrl} />}
          trailing={computer.computerId === selected?.computerId ? <Icon as={Check} className="size-5" /> : <Icon as={ChevronRight} className="size-5 text-muted-foreground" />}
          onPress={() => { setSelectedId(computer.computerId); setError(""); }} />)}
      </ListGroup>
      {selected ? <>
        <ListGroup label={t("所选电脑")}>
          <InfoRow testID="connection-name" label={t("名称")} value={displayName(selected)} />
          <InfoRow testID="connection-address" label={t("网关地址")} value={selected.baseUrl} mono />
          <InfoRow testID="connection-method" label={t("配对方式")} value={`${method === "qr" ? t("扫码") : method === "development" ? t("开发连接") : t("手动输入")} · ${formattedDate}`} />
          <InfoRow testID="connection-auth-status" label={t("认证状态")} value={selected.authStatus === "invalid" ? t("需要重新配对") : t("已配对")} />
        </ListGroup>
        <ListGroup label={t("版本")}>
          <InfoRow testID="connection-app-version" label={t("App")} value={Constants.expoConfig?.version ?? t("未知")} />
          <InfoRow testID="connection-gateway-version" label={t("电脑上的 Wandrun")} value={(isCurrent ? details?.gateway_version : null) ?? selected.gatewayVersion ?? t("暂不可用")} />
        </ListGroup>
        <View className="gap-2 px-4 pt-5">
          {selected.authStatus === "invalid" ? <Button testID="connection-repair" variant="outline" disabled={working}
            onPress={() => router.push({ pathname: "/connect", params: { address: selected.baseUrl, repair: selected.connectionId } })}><Text>{t("重新配对这台电脑")}</Text></Button> : null}
          {!isCurrent ? <Button testID="connection-switch" variant="outline" disabled={working} onPress={() => void switchToSelected()}><Text>{t("切换到这台电脑")}</Text></Button> : null}
          <Button testID="connection-rename" variant="outline" disabled={working} onPress={() => { setName(selected.localName ?? ""); setAction("rename"); }}><Icon as={Pencil} className="size-4" /><Text>{t("修改备注名")}</Text></Button>
          <Button testID="connection-disconnect" variant="ghost" disabled={working} onPress={() => setAction("disconnect")}><Text className="text-destructive">{t("断开这台电脑")}</Text></Button>
        </View>
      </> : null}
      {error ? <Text testID="connection-error" accessibilityLiveRegion="polite" className="mx-4 mt-2 text-sm text-destructive">{t(error)}</Text> : null}
    </ScrollView>
    <Modal visible={!!action} transparent animationType="fade" onRequestClose={() => { if (!working) setAction(null); }}>
      <KeyboardAvoidingView behavior="padding" className="flex-1 justify-center bg-black/50 px-6">
        <View className="gap-3 rounded-[20px] bg-card p-5">
          <Text className="text-lg font-semibold">{action === "rename" ? t("修改本地备注名") : t("断开{name}？", { name: selected ? displayName(selected) : t("这台电脑") })}</Text>
          {action === "rename"
            ? <Input testID="connection-local-name" value={name} onChangeText={setName} placeholder={selected?.computerName ?? t("电脑")} autoFocus />
            : <Text className="text-sm leading-5 text-muted-foreground">{t("将请求电脑撤销本设备令牌，成功后移出列表。再次连接需在电脑上生成新配对码。")}</Text>}
          <View className="flex-row justify-end gap-3 pt-2">
            <Button testID="connection-cancel" variant="ghost" disabled={working} onPress={() => setAction(null)}><Text>{t("取消")}</Text></Button>
            <Button testID={action === "rename" ? "connection-rename-confirm" : "connection-disconnect-confirm"} variant="outline" disabled={working} onPress={() => void confirm()}><Text>{working ? t("请稍候…") : action === "rename" ? t("保存备注名") : t("断开电脑")}</Text></Button>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </View>;
}

function InfoRow({ testID, label, value, mono = false }: { testID: string; label: string; value: string; mono?: boolean }) {
  return <View className="min-h-[52px] flex-row items-center gap-3 px-4">
    <Text className="flex-1 text-base">{label}</Text>
    <Text testID={testID} numberOfLines={2} className={`max-w-[65%] text-right text-sm text-muted-foreground ${mono ? "font-mono text-[13px]" : ""}`}>{value}</Text>
  </View>;
}
