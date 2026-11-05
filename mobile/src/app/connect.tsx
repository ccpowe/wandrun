import { CameraView, useCameraPermissions } from "expo-camera";
import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { useCallback, useReducer, useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";

import { ConnectView } from "@/components/connect-view.tsx";
import { GatewayApi } from "@/gateway/api.ts";
import { newClientId } from "@/gateway/session.ts";
import { connectReducer, initialConnectState, selectConnect, type PairingPage } from "@/lib/connect.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { PairingScanScope, normalizeGatewayAddress, pairingCoordinator, parsePairingQr, type PairingMethod } from "@/lib/pairing.ts";
import { useGateway } from "@/lib/session-context.tsx";

export default function Connect() {
  const { address, repair, mode } = useLocalSearchParams<{ address?: string; repair?: string; mode?: "add" }>();
  const repairConnectionId = mode === "add" ? undefined : repair;
  return <ConnectContainer key={`${repairConnectionId ?? "new"}:${address ?? ""}`} repairConnectionId={repairConnectionId} repairAddress={address} adding={mode === "add"} />;
}
function ConnectContainer({ repairConnectionId, repairAddress, adding }: { repairConnectionId?: string; repairAddress?: string; adding: boolean }) {
  const { config, configure, revoked } = useGateway();
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [state, dispatch] = useReducer(connectReducer, repairConnectionId ? repairAddress ?? "" : "", initialConnectState);
  const [scope] = useState(() => new PairingScanScope());
  const exchange = useSyncExternalStore(pairingCoordinator.subscribe, pairingCoordinator.snapshot, pairingCoordinator.snapshot);
  const selection = selectConnect(state, exchange);
  const focused = useIsFocused();
  useFocusEffect(useCallback(() => {
    scope.focus(); dispatch({ type: "focused" });
    return () => scope.blur();
  }, [scope]));

  function leave(page: PairingPage) {
    if (!selectConnect(state, pairingCoordinator.snapshot()).canChangePage) return;
    scope.cancel(); dispatch({ type: "page", page });
  }
  async function connect(address: string, code: string, method: PairingMethod, qr?: string) {
    if (state.status !== "ready" || pairingCoordinator.snapshot().phase !== "idle") return;
    const signal = scope.start(qr);
    if (!signal) return;
    const operationId = newClientId();
    dispatch({ type: "connect-started", operationId });
    let message = "";
    try {
      const baseUrl = normalizeGatewayAddress(address);
      if (repairConnectionId && baseUrl !== repairAddress) message = "重新配对时请使用原服务器地址。添加其他服务器请返回「服务器与连接」。";
      else {
        void KeyboardController.dismiss();
        const error = await pairingCoordinator.connect(baseUrl, code, method, next => configure(next, repairConnectionId));
        if (error && !scope.current(signal)) Alert.alert(t("配对未完成"), t(error));
      }
    } catch { message = "服务器地址无效，请检查后重试。"; }
    finally {
      if (scope.current(signal)) dispatch({ type: "finished", operationId, message });
      scope.finish(signal);
    }
  }
  async function scan() {
    if (state.status !== "ready" || pairingCoordinator.snapshot().phase !== "idle") return;
    const signal = scope.start();
    if (!signal) return;
    const operationId = newClientId();
    dispatch({ type: "permission-started", operationId });
    pairingCoordinator.clearError();
    try {
      const result = permission?.granted ? permission : await requestPermission();
      if (!scope.current(signal)) return;
      scope.retryQr();
      dispatch({ type: "permission-finished", operationId, granted: result.granted,
        message: result.granted ? "" : "相机权限未开启。请手动输入地址和配对码，或在系统设置中允许相机权限后重试扫码。" });
    } catch {
      if (scope.current(signal)) dispatch({ type: "permission-finished", operationId, granted: false, message: "无法使用相机。请手动输入地址和配对码。" });
    } finally { scope.finish(signal); }
  }
  async function connectDevelopment() {
    if (state.status !== "ready" || pairingCoordinator.snapshot().phase !== "idle") return;
    const signal = scope.start();
    if (!signal) return;
    const operationId = newClientId();
    dispatch({ type: "development-started", operationId });
    let saving = false;
    let message = "";
    let api: GatewayApi | undefined;
    try {
      const baseUrl = normalizeGatewayAddress(state.address);
      const token = state.token.trim();
      if (!token) throw new Error("请输入开发令牌");
      void KeyboardController.dismiss();
      api = new GatewayApi({ baseUrl, token });
      const details = await api.connection(signal);
      if (!scope.current(signal)) return;
      saving = true;
      dispatch({ type: "development-saving", operationId });
      await configure({ baseUrl, token, deviceId: details.device_id ?? undefined, computerName: details.computer_name,
        gatewayVersion: details.gateway_version, pairedAt: details.paired_at, pairingMethod: details.pairing_method }, repairConnectionId);
    } catch { message = "开发令牌或服务器地址无效，请检查服务是否正在运行。"; }
    finally {
      api?.close();
      if (saving || scope.current(signal)) dispatch({ type: "finished", operationId, message });
      scope.finish(signal);
    }
  }
  const cancel = () => {
    if (!selectConnect(state, pairingCoordinator.snapshot()).canCancel) return;
    scope.cancel(); dispatch({ type: "cancelled" });
  };
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <ConnectView state={state} selection={selection} exchangePhase={exchange.phase}
      canClose={!!config && config.authStatus !== "invalid"} invalid={config?.authStatus === "invalid" && !adding} repairing={!!repairConnectionId} revoked={revoked}
      camera={permission?.granted && focused && state.page === "scan" ? <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={selection.busy ? undefined : ({ data }) => {
          if (!scope.canScan()) return;
          const target = parsePairingQr(data);
          if (!target) { dispatch({ type: "error", message: "不是 Wandrun 配对二维码。请扫描服务器上 wandrun pair 显示的二维码。" }); return; }
          dispatch({ type: "field", field: "address", value: target.baseUrl });
          dispatch({ type: "field", field: "code", value: target.code });
          void connect(target.baseUrl, target.code, "qr", data);
        }} /> : null}
      onClose={() => router.canGoBack() ? router.back() : router.replace("/")} onPage={leave} onScan={() => void scan()}
      onSubmit={() => void (state.page === "development" ? connectDevelopment() : connect(state.address, state.code, "manual"))}
      onCancel={cancel} onRetryScan={() => { if (pairingCoordinator.snapshot().phase === "idle") { scope.retryQr(); pairingCoordinator.clearError(); dispatch({ type: "scan-retried" }); } }}
      onManage={() => router.push("/gateway-connection")} onTitle={() => { if (__DEV__) dispatch({ type: "development-tapped" }); }}
      onField={(field, value) => dispatch({ type: "field", field, value })} />
  </>;
}
