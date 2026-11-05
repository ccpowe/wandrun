import { ChevronLeft, CircleAlert, Monitor, Plus, WifiOff, X } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { GroupRow } from "./group-row.tsx";
import { ListGroup } from "./list-group.tsx";
import { LoadingState } from "./loading-state.tsx";
import { ScreenBar } from "./screen-bar.tsx";
import { SettingsComputerCard } from "./settings-computer-card.tsx";
import { StatusBanner } from "./status-banner.tsx";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Input } from "./ui/input.tsx";
import { SurfacePressable } from "./ui/surface-pressable.tsx";
import { Text } from "./ui/text.tsx";
import type { ConnectionInfo } from "../gateway/api.ts";
import type { ChatSession } from "../gateway/session.ts";
import type { SavedComputer } from "../lib/credentials.ts";
import type { ConnectionActionSelection } from "../lib/gateway-connection.ts";
import { useTranslation } from "../lib/i18n.ts";
import { useDelayedNotice } from "../lib/use-delayed-notice.ts";

type Props = {
  /** The server this page shows; `current` is false only for a saved non-current server (settings.C8). */
  session: ChatSession | null; config: SavedComputer | null; current?: boolean; computers: readonly SavedComputer[];
  details?: ConnectionInfo; readError: boolean; pending: boolean; connectionLabel: string | null; appVersion: string;
  action: ConnectionActionSelection;
  /** settings.D7: the server-side pairing record was not removed; dismissible, owned by this page. */
  remoteNotice?: boolean; onDismissRemoteNotice?(): void;
  /** settings.D2: this visit's switch-failure result; live connection / read banners have no close. */
  switchNotice?: string | null; onDismissSwitchNotice?(): void;
  onBack(): void; onSelect(computer: SavedComputer): void; onAdd(): void; onRepair(): void;
  onRename(): void; onDisconnect(): void; onName(name: string): void; onCancel(): void; onConfirm(): void;
};

export function GatewayConnectionView({ session: currentSession, config, current = true, computers, details: currentDetails, readError, pending: currentPending,
  connectionLabel, appVersion, action, remoteNotice = false, onDismissRemoteNotice, switchNotice, onDismissSwitchNotice, onBack, onSelect, onAdd, onRepair, onRename, onDisconnect, onName, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // The live session and its details describe only the current server; a saved one shows stored fields.
  const session = current ? currentSession : null;
  const details = current ? currentDetails : undefined;
  const pending = current && currentPending;
  const method = details?.pairing_method ?? config?.pairingMethod;
  const version = details?.gateway_version ?? config?.gatewayVersion;
  const target = computers.find(computer => computer.computerId === action.targetId);
  const showReadError = useDelayedNotice(current && readError ? config?.connectionId ?? "connection" : null);
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t("服务器与连接")} left={<Button testID="gateway-back" intent="quiet" size="icon" accessibilityLabel={t("返回")} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {switchNotice ? <StatusBanner icon={WifiOff} title={t(switchNotice)} accessibilityRole="alert"
      action={onDismissSwitchNotice ? { icon: X, label: t("关闭提示"), onPress: onDismissSwitchNotice, testID: "connection-error-dismiss" } : undefined} /> : !current ? null : connectionLabel ? <StatusBanner icon={WifiOff} title={connectionLabel} description={t("内容可能不是最新的")} /> : readError && showReadError ? <StatusBanner icon={WifiOff} accessibilityRole="alert" title={t("无法加载服务器信息，正在重试…")} description={details ? t("内容可能不是最新的") : undefined} /> : null}
    {remoteNotice ? <View testID="disconnect-notice"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t("服务器上的配对记录未能同步移除，不影响使用。")}
      action={onDismissRemoteNotice ? { icon: X, label: t("关闭提示"), onPress: onDismissRemoteNotice, testID: "disconnect-notice-dismiss" } : undefined} /></View> : null}
    <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: insets.bottom + 32 }}>
      {config ? <>
        <SettingsComputerCard computer={config} session={session} name={details?.computer_name} version={version} large current={current} />
        <ListGroup inset="content">
          <InfoRow testID="connection-rename" label={t("备注名")} value={config.localName || details?.computer_name || config.computerName || t("服务器")} disabled={action.busy} onPress={onRename} />
          <InfoRow testID="connection-address" label={t("地址")} value={config.baseUrl} mono />
          <InfoRow testID="connection-method" label={t("配对方式")} value={method ? t(method === "qr" ? "扫码" : method === "development" ? "开发连接" : "手动输入") : undefined} pending={pending} />
          <InfoRow testID="connection-gateway-version" label={t("服务器版本")} value={version ? `Wandrun ${version}` : undefined} pending={pending} />
          <InfoRow testID="connection-app-version" label={t("App 版本")} value={appVersion} />
        </ListGroup>
      </> : null}
      {current ? <ListGroup label={t("其他服务器")}>
        {computers.filter(computer => computer.computerId !== config?.computerId).map(computer => <GroupRow key={computer.computerId} testID={`connection-computer-${computer.computerId}`}
          icon={Monitor} title={computer.localName || computer.computerName || t("服务器")} description={computer.authStatus === "invalid" ? `${computer.baseUrl} · ${t("需要重新配对")}` : computer.baseUrl}
          accessibilityLabel={`${computer.localName || computer.computerName || t("服务器")} ${computer.baseUrl}`}
          disabled={action.busy} onPress={() => onSelect(computer)} />)}
        <GroupRow testID="connection-add" title={t("添加服务器")} disabled={action.busy} icon={Plus} onPress={onAdd} />
      </ListGroup> : null}
      {config ? <View className="gap-4 px-4 pt-6">
        {config.authStatus === "invalid" ? <Button testID="connection-repair" intent="soft" disabled={action.busy} onPress={onRepair}><Text>{t("重新配对这台服务器")}</Text></Button> : null}
        <Button testID="connection-disconnect" intent="destructive" disabled={action.busy} onPress={onDisconnect}><Text>{t("断开这台服务器")}</Text></Button>
      </View> : null}
    </ScrollView>
    <AlertDialog open={action.dialog !== null} onOpenChange={open => { if (!open && !action.busy) onCancel(); }}>
      <AlertDialogContent>
        <KeyboardAvoidingView behavior="padding" className="gap-4">
          <AlertDialogTitle>{action.dialog === "rename" ? t("修改本地备注名") : t("断开{name}？", { name: target?.localName || target?.computerName || t("这台服务器") })}</AlertDialogTitle>
          {action.dialog === "rename" ? <Input testID="connection-local-name" tone="muted" accessibilityLabel={t("修改本地备注名")} value={action.draft} onChangeText={onName} editable={!action.busy} placeholder={target?.computerName ?? t("服务器")} autoFocus /> : <AlertDialogDescription>{t("将从手机移除这台服务器及其凭据，并尝试通知服务器取消配对。再次连接需重新配对。")}</AlertDialogDescription>}
          {action.error ? <Text testID="connection-action-error" variant="caption" accessibilityRole="alert" className="text-destructive">{t(action.error)}</Text> : null}
          <View className="flex-row justify-end gap-3">
            <Button testID="connection-cancel" intent="soft" disabled={action.busy} onPress={onCancel}><Text>{t("取消")}</Text></Button>
            <Button testID={action.dialog === "rename" ? "connection-rename-confirm" : "connection-disconnect-confirm"} intent={action.dialog === "rename" ? "primary" : "destructive"} disabled={action.busy} onPress={onConfirm}><Text>{action.busy ? t("请稍候…") : action.dialog === "rename" ? t("保存备注名") : t("断开服务器")}</Text></Button>
          </View>
        </KeyboardAvoidingView>
      </AlertDialogContent>
    </AlertDialog>
  </View>;
}

function InfoRow({ testID, label, value, pending, mono = false, disabled, onPress }: {
  testID: string; label: string; value?: string; pending?: boolean; mono?: boolean; disabled?: boolean; onPress?: () => void;
}) {
  const { t } = useTranslation();
  const content = <View className="min-h-12 flex-row items-center gap-3 px-4 py-3">
    <Text variant="caption" className="flex-1 text-muted-foreground">{label}</Text>
    {!value && pending ? <View className="h-6 w-8"><LoadingState /></View> : <Text testID={onPress ? undefined : testID} variant="body" numberOfLines={2} className={`max-w-[65%] text-right ${mono ? "font-mono" : ""}`}>{value ?? t("暂不可用")}</Text>}
  </View>;
  return onPress ? <SurfacePressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} feedback="surface">{content}</SurfacePressable>
    : <View>{content}</View>;
}
