import * as Clipboard from "expo-clipboard";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, AppState, Linking, View } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { Connector, OAuthStart } from "@/gateway/api.ts";
import { GatewayError } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { useTranslation } from "@/lib/i18n.ts";

type OAuthAction = "start" | "callback" | "cancel" | "revoke";

/** Only classified gateway codes cross into UI; raw network/SDK errors may contain callback URLs. */
function oauthFailure(reason: unknown, action: OAuthAction): string {
  if (reason instanceof GatewayError) {
    switch (reason.code) {
      case "unsupported_oauth": return "此服务不支持安全 OAuth（DCR + PKCE S256）。请检查地址或改用其他认证方式。";
      case "oauth_unavailable": return action === "callback" ? "授权兑换或连接准备暂不可用，请重新发起授权。" : "OAuth 服务暂不可用，请稍后重试。";
      case "invalid_callback": return "完整回调网址与本次授权不匹配或已过期，请核对网址，必要时重新发起授权。";
      case "oauth_denied": return "未同意服务方授权，请重新发起。";
      case "oauth_cancelled": return "本次授权已取消，请重新发起。";
      case "authorization_required": return "连接器需要重新授权，请重新发起。";
      case "invalid_request": return action === "callback" ? "请输入浏览器地址栏里的完整回调网址。" : "当前连接器不支持此授权操作。";
      case "not_found": return "连接器已不存在，请返回应用或连接器列表刷新。";
      case "timeout":
      case "cancelled": return "操作结果尚未确认，请刷新状态后再重试。";
    }
  }
  switch (action) {
    case "start": return "无法发起授权，请检查网关连接后重试。";
    case "callback": return "回调网址未能完成授权，请检查完整网址或重新发起。";
    case "cancel": return "取消等待失败，请刷新状态后重试。";
    case "revoke": return "断开授权失败，授权可能仍有效，请刷新状态后重试。";
  }
}

/** Device polling finishes on the gateway; render only classified, translated failures. */
function deviceFailure(code: string): string {
  switch (code) {
    case "oauth_denied": return "未同意服务方授权，请重新发起。";
    case "oauth_expired": return "本次授权已过期，请重新发起授权。";
    default: return "OAuth 服务暂不可用，请稍后重试。";
  }
}

/** A status refresh may return a new object for the same old terminal outcome. */
function sameAuthOutcome(left: Connector["auth"], right: Connector["auth"]): boolean {
  return left.status === right.status &&
    left.authorizing === right.authorizing &&
    left.error?.code === right.error?.code;
}

type LocalError =
  | { message: string; source: "command"; auth: Connector["auth"]; action?: OAuthAction; reconciled?: boolean }
  | { message: string; source: "flow"; flow: OAuthStart };

/** Browser links and pasted callbacks belong to this mounted page, never the connector catalog. */
export function ConnectorOAuth({ session, connector, onChange, onMissing, autoStart = false }: { session: ChatSession; connector: Connector; onChange: (value: Connector) => void; onMissing?: () => void; autoStart?: boolean }) {
  const { t, language, locale } = useTranslation();
  const focused = useIsFocused();
  const revision = useSyncExternalStore(session.subscribe, () => session.connectorRevision);
  const [start, setStart] = useState<OAuthStart | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [busy, setBusy] = useState(false);
  // An empty local message hides the old terminal outcome while a new command runs.
  const [error, setError] = useState<LocalError | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const startRef = useRef<OAuthStart | null>(null);
  // A successful start makes the next accepted read fresh even if its error code matches the old one.
  const awaitingStartSnapshot = useRef(false);
  const autoStarted = useRef(false);
  const focusEpoch = useRef(0);
  const focusedRef = useRef(false);
  const authRef = useRef(connector.auth);
  useEffect(() => { authRef.current = connector.auth; }, [connector.auth]);
  const setLocalError = useCallback((message: string, flow?: OAuthStart, action?: OAuthAction) => {
    setError(flow ? { message, source: "flow", flow } :
      { message, source: "command", auth: authRef.current, action });
  }, []);
  const acceptSnapshot = useCallback((value: Connector) => {
    const freshTerminal = awaitingStartSnapshot.current && !!value.auth.error && !value.auth.authorizing;
    awaitingStartSnapshot.current = false;
    const flowStillPending = value.auth.authorizing && !!startRef.current;
    setError((previous) => {
      if (!previous) return null;
      if (previous.source === "flow") return flowStillPending ? previous : null;
      if (previous.action === "callback" && !previous.reconciled && !value.auth.authorizing &&
        (value.auth.status !== "authorized" || previous.auth.status === "authorized") && !value.auth.error) {
        // A surviving old credential does not prove that this callback succeeded.
        return { ...previous, auth: value.auth, reconciled: true };
      }
      return freshTerminal || !sameAuthOutcome(previous.auth, value.auth) ? null : previous;
    });
    if (!value.auth.authorizing) {
      startRef.current = null;
      setStart(null);
      setCallbackUrl("");
    }
    onChange(value);
  }, [onChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; startRef.current = null; }; }, []);
  useEffect(() => {
    focusedRef.current = focused;
    const epoch = focusEpoch.current + 1;
    focusEpoch.current = epoch;
    return () => { focusedRef.current = false; focusEpoch.current = epoch + 1; };
  }, [focused]);

  const [foreground, setForeground] = useState(0);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setForeground((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!start) return;
    const timer = setTimeout(() => {
      if (startRef.current === start) startRef.current = null;
      setStart(null);
      setCallbackUrl("");
      setNotice("本次授权已过期，请重新发起授权。");
      setForeground((value) => value + 1);
    }, Math.max(0, start.expires_at * 1000 - Date.now()));
    return () => clearTimeout(timer);
  }, [start]);
  useEffect(() => {
    if (!focused) return;
    let active = true;
    const observed = generation.current;
    void session.api.getConnector(connector.id).then((value) => {
      if (active && observed === generation.current && !pending.current) acceptSnapshot(value);
    }, (reason: unknown) => {
      if (active && reason instanceof GatewayError && reason.status === 404) onMissing?.();
    });
    return () => { active = false; };
  }, [session, connector.id, focused, foreground, revision, acceptSnapshot, onMissing]);

  const act = useCallback(async (action: () => Promise<{ connector?: Connector; remote_revoked?: boolean | null }>, kind: OAuthAction, completed?: (result: { connector?: Connector; remote_revoked?: boolean | null }) => void) => {
    if (pending.current) return;
    pending.current = true;
    generation.current++;
    awaitingStartSnapshot.current = false;
    setBusy(true);
    setLocalError("");
    setNotice("");
    try {
      const result = await action();
      if (!mounted.current) return;
      if (result.connector) acceptSnapshot(result.connector);
      completed?.(result);
    } catch (reason) {
      if (mounted.current) {
        if (reason instanceof GatewayError && reason.status === 404) onMissing?.();
        if (reason instanceof GatewayError && reason.code === "remote_revocation_failed") {
          setNotice("本地授权已清除，但远端撤销失败；请到服务方设置里断开，并刷新此页核对状态。");
        } else setLocalError(oauthFailure(reason, kind), undefined, kind);
      }
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); setForeground((value) => value + 1); }
    }
  }, [acceptSnapshot, onMissing, setLocalError]);
  const begin = useCallback(() => {
    if (!focusedRef.current) return;
    const epoch = focusEpoch.current;
    void act(async () => {
      const value = await session.api.startConnectorOAuth(connector.id);
      awaitingStartSnapshot.current = true;
      if (mounted.current && focusedRef.current && focusEpoch.current === epoch) {
        const observed = generation.current;
        startRef.current = value;
        setStart(value);
        setCallbackUrl("");
        if (value.flow === "authorization_code") {
          try { await Linking.openURL(value.authorization_url); }
          catch {
            if (mounted.current && focusedRef.current && focusEpoch.current === epoch &&
              observed === generation.current && startRef.current === value) {
              setLocalError("无法打开系统浏览器，请复制本次授权链接并在手机浏览器中打开。", value);
            }
          }
        }
      }
      try { return { connector: await session.api.getConnector(connector.id) }; }
      catch { if (mounted.current) setNotice("授权已发起，但暂时无法读取最新状态；返回此页会重试。"); return {}; }
    }, "start");
  }, [act, session, connector.id, setLocalError]);
  useEffect(() => {
    if (!autoStart || autoStarted.current || !focused) return;
    autoStarted.current = true;
    if (connector.auth.status !== "authorized" && !connector.auth.authorizing) begin();
  }, [autoStart, connector.auth.status, connector.auth.authorizing, focused, begin]);
  const copy = async () => {
    // Clipboard work may settle after cancellation or a terminal gateway snapshot.
    if (!start) return;
    const flow = start;
    const observed = generation.current;
    const device = flow.flow === "device_code";
    try {
      if (!await Clipboard.setStringAsync(device ? flow.user_code : flow.authorization_url)) throw new Error("clipboard unavailable");
      if (!mounted.current || observed !== generation.current || startRef.current !== flow || !focusedRef.current) return;
      AccessibilityInfo.announceForAccessibility(t(device ? "已复制验证码" : "已复制授权链接"));
      setNotice(device ? "已复制验证码" : "已复制授权链接");
    } catch {
      if (mounted.current && observed === generation.current && startRef.current === flow && focusedRef.current) {
        setLocalError(device ? "无法复制验证码，请检查剪贴板权限。" : "无法复制授权链接，请检查剪贴板权限。", flow);
      }
    }
  };
  const cancel = () => void act(() => session.api.cancelConnectorOAuth(connector.id), "cancel", () => {
    startRef.current = null; setStart(null); setCallbackUrl(""); setNotice("已取消等待授权。");
  });
  const complete = () => void act(() => session.api.completeConnectorOAuth(connector.id, callbackUrl.trim()), "callback", () => {
    startRef.current = null; setStart(null); setCallbackUrl(""); setNotice("授权已处理。");
  });
  const revoke = () => void act(() => session.api.revokeConnectorOAuth(connector.id), "revoke", (result) => {
    startRef.current = null; setStart(null); setCallbackUrl("");
    setNotice(result.remote_revoked === false ? "本地授权已清除；远端撤销失败，服务方可能仍保留授权，请到服务方设置里断开。" :
      result.remote_revoked === null ? connector.app_id === "github"
        ? "本地授权已清除；GitHub 未提供远端撤销接口，请到 GitHub 设置中撤销此应用授权。"
        : "本地授权已清除；服务方未提供远端撤销接口，请到服务方设置检查授权。" : "授权已断开。");
  });
  const openBrowser = () => {
    if (!start) return;
    const flow = start;
    const observed = generation.current;
    void Linking.openURL(flow.authorization_url).catch(() => {
      if (mounted.current && observed === generation.current && startRef.current === flow && focusedRef.current) {
        setLocalError(flow.flow === "device_code" ? "无法打开 GitHub 授权页面，请在浏览器中访问 github.com/login/device。" :
          "无法打开系统浏览器，请复制本次授权链接。", flow);
      }
    });
  };
  const authorized = connector.auth.status === "authorized";
  const waiting = connector.auth.authorizing || !!start;
  const device = start?.flow === "device_code" || (!start && connector.app_id === "github");
  const visibleError = error && (error.source === "flow" ? error.flow === start :
    sameAuthOutcome(error.auth, connector.auth)) ? error.message :
    connector.app_id === "github" && connector.auth.error ? deviceFailure(connector.auth.error.code) : "";
  return <View className="px-4 py-5">
    <View className="w-full max-w-md self-center gap-4">
      <Text testID="oauth-status" className="text-sm font-medium">{waiting
        ? t(device ? "等待 GitHub 授权" : "等待浏览器完成")
        : t("授权：{status}", { status: t(authorized ? "已授权" : connector.auth.status === "reauthorization_required" ? "需要重新授权" : "未授权") })}</Text>
      {waiting ? <View className="gap-3">
        <Text className="text-sm leading-5 text-muted-foreground">{t(device
          ? start ? "在 GitHub 页面输入验证码并授权，完成后返回此页。" : "验证码仅在发起设备显示，请重新发起授权获取新码。"
          : "等待浏览器授权。返回此页刷新状态；若本次授权链接未显示，请重新发起。")}</Text>
        {start?.flow === "device_code" ? <View className="items-center gap-2 rounded-sm bg-muted px-4 py-5">
          <Text testID="oauth-user-code" selectable accessibilityLabel={t("GitHub 验证码：{code}", { code: start.user_code })} className="text-center font-mono text-[28px] font-semibold leading-9 tracking-[3px]">{start.user_code}</Text>
          <Text testID="oauth-expiry" className="text-center text-xs leading-[18px] text-muted-foreground">{t("验证码有效至 {time}", { time: new Date(start.expires_at * 1000).toLocaleTimeString(locale) })}</Text>
        </View> : null}
        {start?.flow === "authorization_code" ? <>
          <Text className="text-xs leading-[18px] text-muted-foreground">{t("本次授权有效至 {time} · 回调地址：{uri}", { time: new Date(start.expires_at * 1000).toLocaleTimeString(locale), uri: start.redirect_uri })}</Text>
          {start.manual_callback ? <Text className="text-xs leading-[18px] text-muted-foreground">{t("授权后若页面打不开，请复制浏览器地址栏中的完整回调网址粘贴到下方。")}</Text> : null}
        </> : null}
      </View> : null}
      {authorized ? <Text testID="oauth-scopes" className="text-xs leading-[18px] text-muted-foreground">{t("授权范围：{scopes}", { scopes: connector.auth.scopes.length ? connector.auth.scopes.join(language === "zh" ? "、" : ", ") : t("服务方未返回范围") })}</Text> : null}
      {connector.app_id === "github" ? <Text testID="oauth-github-permissions" className="text-xs leading-[18px] text-muted-foreground">{t("GitHub 的 repo 授权范围包含私有仓库的读取和写入，并非只读。令牌仅保存在网关；不会自动授予任何 Agent 使用权限。")}</Text> : null}
      {notice ? <Text testID="oauth-notice" accessibilityLiveRegion="polite" className="text-xs leading-[18px] text-muted-foreground">{t(notice)}</Text> : null}
      {visibleError ? <Text testID="oauth-error" accessibilityLiveRegion="polite" className="text-xs leading-[18px] text-destructive">{t(visibleError)}</Text> : null}
      <View className="gap-2.5">
        {start ? <>
          {start.flow === "device_code" ? <Button testID="oauth-copy-code" variant="outline" className="w-full" disabled={busy} onPress={() => void copy()}><Text>{t("复制验证码")}</Text></Button> : null}
          <Button testID="oauth-open-browser" className="w-full" accessibilityLabel={t(start.flow === "device_code" ? "打开 GitHub 授权页面" : "打开浏览器")} disabled={busy} onPress={openBrowser}><Text>{t(start.flow === "device_code" ? "打开 GitHub" : "打开浏览器")}</Text></Button>
          {start.flow === "authorization_code" ? <Button testID="oauth-copy-link" variant="outline" className="w-full" disabled={busy} onPress={() => void copy()}><Text>{t("复制授权链接")}</Text></Button> : null}
        </> : <Button testID="oauth-start" variant={authorized ? "outline" : "default"} className="w-full" disabled={busy} onPress={begin}><Text>{t(busy ? "请稍候…" : authorized ? "重新授权" : connector.auth.status === "reauthorization_required" || waiting ? "重新发起授权" : "去授权")}</Text></Button>}
        {waiting && !device ? <>
          <Input testID="oauth-callback-url" accessibilityLabel={t("完整回调网址")} value={callbackUrl} onChangeText={setCallbackUrl}
            placeholder={t("粘贴完整回调网址")} autoCapitalize="none" autoCorrect={false} autoComplete="off" keyboardType="url" />
          <Button testID="oauth-submit-callback" variant="outline" className="w-full" disabled={busy || !callbackUrl.trim()} onPress={complete}><Text>{t("提交回调网址")}</Text></Button>
        </> : null}
        {waiting ? <Button testID="oauth-cancel" variant="ghost" className="w-full" disabled={busy} onPress={cancel}><Text className="text-muted-foreground">{t("取消等待")}</Text></Button> : null}
        {authorized ? <Button testID="oauth-revoke" variant="ghost" className="w-full" disabled={busy} onPress={revoke}><Text className="text-destructive">{t("撤销授权")}</Text></Button> : null}
      </View>
    </View>
  </View>;
}
