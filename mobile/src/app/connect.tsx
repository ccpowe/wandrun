import { CameraView, useCameraPermissions } from "expo-camera";
import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { ScanLine, ChevronLeft } from "lucide-react-native";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Image, Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import { GatewayApi } from "@/gateway/api.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useGateway } from "@/lib/session-context.tsx";
import { PairingScanScope, normalizeGatewayAddress, pairingCoordinator, parsePairingQr } from "@/lib/pairing.ts";
import type { PairingMethod } from "@/lib/pairing.ts";

type Page = "landing" | "manual" | "scan" | "development";

export default function Connect() {
  const { t } = useTranslation();
  const { config, configure, revoked } = useGateway();
  const { address: repairAddress, repair, mode } = useLocalSearchParams<{ address?: string; repair?: string; mode?: "add" }>();
  // Authentication failure offers repair; it never supplies repair intent for a new pairing.
  const repairConnectionId = mode === "add" ? undefined : repair;
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [page, setPage] = useState<Page>("landing");
  const [address, setAddress] = useState(repairConnectionId ? repairAddress ?? "" : "");
  const [code, setCode] = useState("");
  const [devToken, setDevToken] = useState("");
  const [error, setError] = useState("");
  const [localBusy, setBusy] = useState(false);
  const [developmentSaving, setSaving] = useState(false);
  const exchange = useSyncExternalStore(pairingCoordinator.subscribe, pairingCoordinator.snapshot, pairingCoordinator.snapshot);
  const busy = localBusy || exchange.phase !== "idle";
  const saving = developmentSaving || exchange.phase === "saving";
  const visibleError = exchange.error || error;
  const [pairing] = useState(() => new PairingScanScope());
  const savingNow = useRef(false);
  const focused = useIsFocused();
  const taps = useRef(0);

  useFocusEffect(useCallback(() => {
    pairing.focus();
    setPage("landing");
    setError("");
    setBusy(false);
    setSaving(savingNow.current);
    return () => { pairing.blur(); };
  }, [pairing]));

  const leave = (next: Page) => {
    if (savingNow.current || pairingCoordinator.snapshot().phase === "saving") return;
    pairing.cancel();
    setBusy(false);
    setError("");
    setPage(next);
  };

  const connect = async (inputAddress: string, inputCode: string, method: PairingMethod, qr?: string) => {
    if (pairingCoordinator.snapshot().phase !== "idle") return;
    const signal = pairing.start(qr);
    if (!signal) return;
    setBusy(true);
    setError("");
    try {
      const baseUrl = normalizeGatewayAddress(inputAddress);
      if (repairConnectionId && baseUrl !== repairAddress) {
        setError("重新配对时请使用原电脑地址。添加其他电脑请返回「关于与连接」。");
        return;
      }
      const failure = await pairingCoordinator.connect(baseUrl, inputCode, method,
        (next) => configure(next, repairConnectionId));
      // The coordinator keeps the outcome for a replacement screen; also report it if
      // this visit has already gone away and there may be no pairing screen visible.
      if (failure && !pairing.current(signal)) Alert.alert(t("配对未完成"), t(failure));
    } catch {
      if (pairing.current(signal)) setError("电脑地址无效，请检查后重试。");
    } finally {
      if (pairing.current(signal)) setBusy(false);
      pairing.finish(signal);
    }
  };

  const scan = async () => {
    if (pairingCoordinator.snapshot().phase !== "idle") return;
    const signal = pairing.start();
    if (!signal) return;
    setError("");
    pairingCoordinator.clearError();
    try {
      const status = permission?.granted ? permission : await requestPermission();
      if (!pairing.current(signal)) return;
      pairing.retryQr(); // An explicit scanner visit may report a consumed code again.
      setPage(status.granted ? "scan" : "manual");
      if (!status.granted) setError("相机权限未开启。请手动输入电脑地址和配对码，或在系统设置中允许相机权限后重试扫码。");
    } catch {
      if (!pairing.current(signal)) return;
      setPage("manual");
      setError("无法使用相机。请手动输入电脑地址和配对码。");
    } finally {
      pairing.finish(signal);
    }
  };

  const connectDevelopment = async () => {
    if (pairingCoordinator.snapshot().phase !== "idle") return;
    const signal = pairing.start();
    if (!signal) return;
    setBusy(true);
    setError("");
    try {
      const baseUrl = normalizeGatewayAddress(address);
      const token = devToken.trim();
      if (!token) throw new Error("请输入开发令牌");
      const details = await new GatewayApi({ baseUrl, token }).connection(signal);
      if (!pairing.current(signal)) return;
      savingNow.current = true;
      setSaving(true);
      await configure({ baseUrl, token, deviceId: details.device_id ?? undefined,
        computerName: details.computer_name, gatewayVersion: details.gateway_version,
        pairedAt: details.paired_at, pairingMethod: details.pairing_method }, repairConnectionId);
      // Navigation follows the same session boundary as normal pairing.
    } catch {
      if (pairing.current(signal)) setError("开发令牌或网关地址无效，请检查网关是否正在运行。");
    } finally {
      if (pairing.current(signal)) {
        savingNow.current = false;
        setSaving(false);
        setBusy(false);
      }
      pairing.finish(signal);
    }
  };

  const retrySuffix = " 现在可以重试；若配对码已使用，请在电脑上重新生成。";
  const pairingError = visibleError.endsWith(retrySuffix)
    ? t("{error} 现在可以重试；若配对码已使用，请在电脑上重新生成。", { error: t(visibleError.slice(0, -retrySuffix.length)) })
    : t(visibleError);
  return <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
    {config && config.authStatus !== "invalid" && page === "landing" ? <View className="absolute left-3 z-10" style={{ top: insets.top }}>
      <Button testID="pairing-close" variant="ghost" size="icon" aria-label={t("返回当前电脑")} disabled={saving}
        onPress={() => router.canGoBack() ? router.back() : router.replace("/")}><Icon as={ChevronLeft} className="size-[22px]" /></Button>
    </View> : null}
    <Stack.Screen options={{ headerShown: false }} />
    {exchange.phase !== "idle" ? <Text testID="pairing-progress" accessibilityLiveRegion="polite" className="mx-4 mt-4 rounded-[14px] border border-border p-3 text-sm">
      {exchange.phase === "saving" ? t("正在保存连接…") : t("正在完成上一次配对，成功后仍会保存连接，请稍候…")}
    </Text> : null}
    {visibleError ? <Text testID="pairing-error" accessibilityLiveRegion="polite" className="mx-4 mt-4 rounded-[14px] border border-destructive p-3 text-sm text-destructive">{pairingError}</Text> : null}
    {page === "landing" ? <View className="flex-1">
      <View className="flex-1 items-center gap-[6px] px-8 pt-[70px]">
        <Image source={require("../../assets/empty-together.png")} style={{ width: 180, height: 180 }} resizeMode="contain" />
        <Pressable testID="pairing-title" onPress={() => { if (__DEV__ && ++taps.current >= 7) { taps.current = 0; setPage("development"); } }}>
          <Text className="text-center text-xl font-semibold">{t("连接你的电脑")}</Text>
        </Pressable>
        <Text className="text-center text-sm leading-5 text-muted-foreground">{t("在电脑上运行 wandrun pair，\n用手机扫屏幕上的二维码。")}</Text>
        {config?.authStatus === "invalid" && mode !== "add" ? <Text testID="pairing-invalid" accessibilityLiveRegion="polite" className="mt-4 rounded-[14px] border border-destructive px-4 py-3 text-center text-sm text-destructive">{repairConnectionId ? t("请在电脑上生成新配对码，重新配对。") : t("这台电脑的认证已失效。请在「查看已保存的电脑」中选择「重新配对这台电脑」。")}</Text> : null}
        {revoked ? <Text testID="pairing-revoked" accessibilityLiveRegion="polite" className="mt-4 rounded-[14px] border border-destructive px-4 py-3 text-center text-sm text-destructive">{t("这台设备的连接已被撤销")}</Text> : null}
      </View>
      <View className="gap-1 px-4" style={{ paddingBottom: insets.bottom + 30 }}>
        <Button testID="pairing-scan" variant="outline" disabled={busy} onPress={() => void scan()}><Icon as={ScanLine} className="size-5" /><Text>{t("扫码连接")}</Text></Button>
        <Pressable testID="pairing-manual" onPress={() => leave("manual")} className="items-center p-3"><Text className="text-sm text-muted-foreground">{t("手动输入地址和配对码")}</Text></Pressable>
        {config?.authStatus === "invalid" ? <Button testID="pairing-computers" variant="ghost" onPress={() => router.push("/gateway-connection")}><Text>{t("查看已保存的电脑")}</Text></Button> : null}
      </View>
    </View> : page === "scan" ? <View className="flex-1">
      <View className="flex-row items-center px-3 py-1">
        <Button testID="pairing-back" variant="ghost" size="icon" aria-label={t("返回")} disabled={saving} onPress={() => leave("landing")}><Icon as={ChevronLeft} className="size-[22px]" /></Button>
        <Text className="flex-1 text-center text-[17px] font-semibold">{t("扫码连接")}</Text><View className="w-11" />
      </View>
      {permission?.granted && focused ? <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={busy ? undefined : ({ data }) => {
          if (!pairing.canScan()) return;
          const target = parsePairingQr(data);
          if (!target) { setError("不是 Wandrun 配对二维码。请扫描电脑上 wandrun pair 显示的二维码。"); return; }
          setAddress(target.baseUrl);
          setCode(target.code);
          void connect(target.baseUrl, target.code, "qr", data);
        }} /> : null}
      {localBusy ? <View className="items-center gap-2 pt-3">
        {!saving ? <Button testID="pairing-cancel" variant="ghost" onPress={() => {
          if (savingNow.current || pairingCoordinator.snapshot().phase === "saving") return;
          pairing.cancel();
          setBusy(false);
          setError("已停止等待。请求若已兑换成功，连接仍会保存；否则请重新生成配对码。");
        }}><Text>{t("取消")}</Text></Button> : null}
      </View> : null}
      {visibleError ? <View className="mx-4 mt-3 gap-2">
        <Button testID="pairing-retry-scan" variant="outline" disabled={busy} onPress={() => {
          if (pairingCoordinator.snapshot().phase !== "idle") return;
          pairing.retryQr(); pairingCoordinator.clearError(); setError("");
        }}><Text>{t("重新扫描")}</Text></Button>
      </View> : null}
      <Pressable testID="pairing-manual" disabled={saving} onPress={() => leave("manual")} className="items-center p-6" style={{ paddingBottom: insets.bottom + 20 }}><Text className="text-sm text-muted-foreground">{t("改为手动输入地址和配对码")}</Text></Pressable>
    </View> : <View className="flex-1">
      <View className="flex-row items-center px-3 py-1">
        <Button testID="pairing-back" variant="ghost" size="icon" aria-label={t("返回")} disabled={saving} onPress={() => leave("landing")}><Icon as={ChevronLeft} className="size-[22px]" /></Button>
        <Text className="flex-1 text-center text-[17px] font-semibold">{page === "development" ? t("开发连接") : t("手动连接")}</Text><View className="w-11" />
      </View>
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
        <View className="gap-3 px-4 pt-2">
          <Text className="text-[13px] text-muted-foreground">{t("电脑地址")}</Text>
          <Input testID={page === "development" ? "gateway-address" : "pairing-address"} value={address} onChangeText={setAddress} placeholder="192.168.1.20:8765" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <Text className="mt-2 text-[13px] text-muted-foreground">{page === "development" ? t("开发令牌") : t("配对码（电脑上 wandrun pair 显示）")}</Text>
          <Input testID={page === "development" ? "gateway-token" : "pairing-code"} value={page === "development" ? devToken : code}
            onChangeText={page === "development" ? setDevToken : setCode} secureTextEntry autoCapitalize="none" autoCorrect={false} />
        </View>
        <View className="px-4 pt-4"><Button testID={page === "development" ? "gateway-save" : "pairing-submit"} variant="outline" disabled={busy || !address.trim() || !(page === "development" ? devToken : code).trim()}
          onPress={() => void (page === "development" ? connectDevelopment() : connect(address, code, "manual"))}><Text>{saving ? t("正在保存连接…") : busy ? t("正在连接…") : t("连接")}</Text></Button></View>
        {localBusy && !saving ? <Button testID="pairing-cancel" variant="ghost" onPress={() => {
          if (savingNow.current || pairingCoordinator.snapshot().phase === "saving") return;
          pairing.cancel();
          setBusy(false);
          if (page === "manual") setError("已停止等待。请求若已兑换成功，连接仍会保存；否则请重新生成配对码。");
        }}><Text>{t("取消")}</Text></Button> : null}
        {page === "manual" ? <Text className="px-8 pt-4 text-center text-xs leading-[18px] text-muted-foreground">{t("配对码 5 分钟内有效，只能使用一次；过期后请在电脑上重新运行 wandrun pair。")}</Text> : null}
      </KeyboardAwareScrollView>
    </View>}
  </View>;
}
