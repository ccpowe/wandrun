import { router, Stack, useFocusEffect, useIsFocused } from "expo-router";
import { Bell, Bot, Cable, ChevronLeft, ChevronRight, CircleHelp, Cpu, Grid2X2, Monitor, Moon, Sparkles } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { LucideIcon } from "lucide-react-native";
import { useConnectorCatalog } from "@/lib/connector-catalog.ts";
import { connectorSummary } from "@/lib/connectors.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { lastSubscriptionUsage, loadSubscriptionUsage, subscriptionSummary } from "@/lib/model-usage.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useBuiltinSkillCatalog, useSkillCatalog } from "@/lib/skill-catalog.ts";
import { useGateway, useSession } from "@/lib/session-context.tsx";
import { useComputerStatus } from "@/lib/use-computer-status.ts";

export default function Settings() {
  const { t } = useTranslation();
  const { config } = useGateway();
  const session = useSession();
  const api = session?.api;
  const focused = useIsFocused();
  const computer = useComputerStatus(session, focused);
  const [subscription, setSubscription] = useState(() => api ? lastSubscriptionUsage(api) : null);

  useFocusEffect(useCallback(() => {
    if (!api) return;
    let active = true;
    setSubscription(lastSubscriptionUsage(api));
    void loadSubscriptionUsage(api, false).then((value) => { if (active) setSubscription(value); });
    return () => { active = false; };
  }, [api]));

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenBar left={<Button testID="settings-back" variant="ghost" size="icon" className="bg-transparent" aria-label={t("返回")} onPress={() => router.canGoBack() ? router.back() : router.replace("/")}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
      <ScrollView contentContainerClassName="pb-10">
        <Text className="px-5 pb-4 pt-1 text-[28px] font-semibold leading-9">{t("设置")}</Text>
        <Pressable testID="settings-computer" disabled={!session} accessibilityState={{ disabled: !session }}
          onPress={() => router.push("/settings-computer")}
          className="mx-4 mb-1 flex-row items-center gap-3.5 rounded-md border border-border bg-card px-4 py-3.5 active:bg-accent">
          <View className="size-12 items-center justify-center rounded-[14px] bg-muted"><Icon as={Monitor} className="size-6" /></View>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-lg font-medium">{config?.localName || computer?.status?.name || config?.computerName || t("电脑")}</Text>
            <View className="flex-row items-center gap-1.5">
              {computer?.status && session?.connection === "open" ? <View className="size-[7px] rounded-full bg-foreground" /> : null}
              <Text className="text-[13px] text-muted-foreground">{!session ? t("连接网关后可用") : session.connection !== "open" ? t("状态暂不可用") :
                computer?.status ? t("在线 · {count} 个浏览器页面", { count: computer.status.browser.pages_used }) : computer?.error ? t("电脑状态暂不可用") : t("正在加载电脑状态…")}</Text>
            </View>
          </View>
          {session && <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />}
        </Pressable>
        <ListGroup label={t("Agent")}>
          <SettingsRow testID="settings-all-agents" icon={Bot} title={t("全部 Agent")} detail={session?.agents.loaded ? String(session.agents.agents.length) : undefined} disabled={!session} disabledReason={t("连接网关后可用")} onPress={() => router.push("/agents")} />
          <SettingsRow testID="settings-models" icon={Cpu} title={t("模型")} detail={subscription ? subscriptionSummary(subscription) : t("登录状态待检查")} disabled={!session} disabledReason={t("连接网关后可用")} onPress={() => router.push("/settings-models")} />
          {session ? <SkillSettingsRow session={session} /> : <SettingsRow testID="settings-skills" icon={Sparkles} title={t("技能")} disabled disabledReason={t("连接网关后可用")} />}
          {session ? <ConnectorSettingsRow session={session} /> : <SettingsRow testID="settings-connectors" icon={Cable} title={t("连接器")} disabled disabledReason={t("连接网关后可用")} />}
          <SettingsRow testID="settings-apps" icon={Grid2X2} title={t("应用")} disabled={!session} disabledReason={t("连接网关后可用")} onPress={() => router.push("/settings-apps")} />
        </ListGroup>
        <ListGroup label={t("App")}>
          <SettingsRow icon={Bell} title={t("通知")} disabled />
          <SettingsRow testID="settings-appearance" icon={Moon} title={t("外观")} onPress={() => router.push("/settings-appearance")} />
          <SettingsRow testID="settings-about-connection" icon={CircleHelp} title={t("关于与连接")} detail={config?.localName || config?.computerName || t("电脑")} onPress={() => router.push("/gateway-connection")} />
        </ListGroup>
      </ScrollView>
    </View>
  );
}

function SkillSettingsRow({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const catalog = useSkillCatalog(session);
  const builtins = useBuiltinSkillCatalog(session);
  const { refresh } = catalog;
  const { refresh: refreshBuiltins } = builtins;
  useFocusEffect(useCallback(() => { refresh(); refreshBuiltins(); }, [refresh, refreshBuiltins]));
  const failed = catalog.skills.some((skill) => skill.status === "error");
  return <SettingsRow testID="settings-skills" icon={Sparkles} title={t("技能")}
    detail={catalog.loaded && builtins.loaded ? failed ? t("{count} · 有无法加载", { count: catalog.skills.length + builtins.skills.length }) : String(catalog.skills.length + builtins.skills.length) : catalog.error || builtins.error ? t("暂不可用") : t("加载中…")}
    danger={catalog.loaded && failed} onPress={() => router.push("/settings-skills")} />;
}

function ConnectorSettingsRow({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const { connectors, loaded, error, refresh } = useConnectorCatalog(session);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const summary = connectorSummary(connectors);
  return <SettingsRow testID="settings-connectors" icon={Cable} title={t("连接器")}
    detail={loaded ? summary.text : error ? t("暂不可用") : t("加载中…")} danger={summary.failed}
    onPress={() => router.push("/settings-connectors")} />;
}

function SettingsRow({ testID, icon, title, detail, danger, disabled, disabledReason, onPress }: { testID?: string; icon: LucideIcon; title: string; detail?: string; danger?: boolean; disabled?: boolean; disabledReason?: string; onPress?: () => void }) {
  const { t } = useTranslation();
  return <Pressable testID={testID} disabled={disabled} accessibilityState={{ disabled }} onPress={onPress} className={`min-h-[60px] flex-row items-center gap-3 px-4 ${disabled ? "opacity-50" : "active:bg-accent"}`}>
    <Icon as={icon} className="size-[22px]" />
    <Text className="min-w-0 flex-1 text-[15px]">{title}</Text>
    {danger && !disabled ? <View className="size-2 rounded-full bg-destructive" /> : null}
    <Text className={`text-[13px] ${danger ? "text-destructive" : "text-muted-foreground"}`} numberOfLines={1}>{disabled ? disabledReason ?? t("即将支持") : detail}</Text>
    {!disabled && <Icon as={ChevronRight} className="size-4 text-muted-foreground" />}
  </Pressable>;
}
