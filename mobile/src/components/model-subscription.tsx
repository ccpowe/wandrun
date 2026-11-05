import { Box, CircleAlert } from "lucide-react-native";
import { View } from "react-native";

import { ListGroup } from "@/components/list-group.tsx";
import { StatusBanner } from "@/components/status-banner.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useTranslation } from "../lib/i18n.ts";
import { quotaWarning, resetLabel, usedPercent, windowTitle } from "@/lib/model-usage.ts";
import type { SubscriptionView } from "@/lib/model-usage.ts";

/** Show current gateway authentication separately from the most recent quota observation. */
export function ModelSubscription({ view, nowSeconds, feedbackInBanner = false }: { view: SubscriptionView; nowSeconds: number; feedbackInBanner?: boolean }) {
  const { t, locale } = useTranslation();
  const { auth, usage, networkError } = view;
  const needsLogin = !networkError && (auth?.status === "reauth_required" || auth?.status === "relogin_required" || auth?.status === "login_required");
  const authLabel = networkError ? feedbackInBanner ? "登录状态待检查" : "服务器连接失败，登录状态暂时无法检查" : !auth ? "正在检查登录状态…" : {
    ready: "已登录",
    refresh_due: "即将续期",
    refreshing: "正在续期",
    reauth_required: "登录已失效，需要重新登录",
    relogin_required: "凭据轮换结果不确定，需要停止服务器并重新登录",
    temporarily_unavailable: "登录暂时不可用，请稍后重试",
    login_required: "尚未登录",
  }[auth.status];
  const warning = auth?.status === "ready" && !networkError ? quotaWarning(usage, nowSeconds) : null;

  return <>
    {warning ? <View testID="settings-subscription-warning"><StatusBanner icon={CircleAlert} title={warning} /></View> : null}
    <ListGroup inset="content">
      <View testID="settings-subscription" className="flex-row items-center gap-3 px-4 py-3.5">
        <View className="size-12 items-center justify-center rounded-md bg-muted"><Icon as={Box} className="size-6" /></View>
        <View className="min-w-0 flex-1">
          <Text variant="body" className="font-medium">{t("Codex 订阅")}</Text>
          <Text variant="caption" testID="settings-subscription-auth" className="text-muted-foreground">{t(authLabel)}</Text>
        </View>
      </View>
      {needsLogin && auth ? <View testID="settings-subscription-login" className="gap-2 px-4 pb-3">
        <Text variant="caption">{t("先停止服务器，再使用服务器的 CODEX_HOME（{home}）重新登录。成功后重启服务器并重新进入此页面；不要使用日常 Codex 目录。", { home: auth.codex_home })}</Text>
        <Text variant="caption" selectable className="font-mono">{auth.login_command}</Text>
      </View> : null}
      {usage?.windows.map((window, index) => (
        <View key={`${window.name}-${index}`} testID={`settings-subscription-window-${index}`} className="border-t border-border px-4 py-3">
          <View className="flex-row items-center justify-between gap-2">
            <Text variant="body" className="min-w-0 flex-1" numberOfLines={1}>{windowTitle(window)}</Text>
            <Text variant="caption" className="text-muted-foreground">{window.used_percent}% · {resetLabel(window.reset_at)}</Text>
          </View>
          <Progress value={usedPercent(window.used_percent)} className="mt-2" />
        </View>
      ))}
      {!usage && <Text variant="caption" className="px-4 pb-3 text-muted-foreground">{t("暂时无法获取额度")}</Text>}
    </ListGroup>
    {usage ? <Text variant="caption" testID="settings-subscription-quota-date" className="mx-8 mt-2 text-muted-foreground">{t("额度更新于 {time}{stale}", { time: new Date(usage.fetched_at * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }), stale: auth?.status !== "ready" || networkError ? t(" · 历史额度，不代表当前登录状态") : "" })}</Text> : null}
  </>;
}
