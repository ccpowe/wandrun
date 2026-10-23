import { Redirect, router, Stack, useFocusEffect, useIsFocused } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Image, Pressable, ScrollView, View, type ImageSourcePropType } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { AppEntry } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";

// Original brand assets: notion.com/front-static/logo-ios.png and brand.github.com/GitHub_Logos.zip.
// White plates preserve the original black marks in both application themes.
const APP_BRANDS: Record<string, { logo: ImageSourcePropType; description: string } | undefined> = {
  notion: {
    logo: require("../../assets/apps/notion.png"),
    description: "查找页面、读取文档，整理 Notion 工作区。",
  },
  github: {
    logo: require("../../assets/apps/github.png"),
    description: "查找仓库，处理 Issue 与 Pull Request。",
  },
};

export default function SettingsAppsRoute() {
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <AppList key={session.api.config.baseUrl} session={session} />;
}

function AppList({ session }: { session: ChatSession }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const revision = useSyncExternalStore(session.subscribe, () => session.connectorRevision);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ apps: AppEntry[]; loaded: boolean; error: string }>({ apps: [], loaded: false, error: "" });
  useFocusEffect(useCallback(() => { setRetry((value) => value + 1); }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && focused) setRetry((value) => value + 1);
    });
    return () => subscription.remove();
  }, [focused]);
  useEffect(() => {
    let active = true;
    void session.api.listApps().then(({ apps }) => {
      if (active) setState({ apps, loaded: true, error: "" });
    }, (reason: unknown) => {
      if (active) setState((previous) => ({ ...previous, error: reason instanceof Error ? reason.message : String(reason) }));
    });
    return () => { active = false; };
  }, [session, retry, revision]);

  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("应用")} left={<Button testID="apps-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回设置")} onPress={() => router.back()}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView contentContainerStyle={{ paddingTop: 20, paddingBottom: insets.bottom + 24 }}>
      {state.apps.length ? <View className="w-full max-w-xl self-center gap-4 px-5">{state.apps.map((app) => {
        const brand = APP_BRANDS[app.id];
        const authorized = app.connector?.auth.status === "authorized";
        const pending = !authorized && !!app.connector?.auth.authorizing;
        const reauthorize = !authorized && !pending && app.connector?.auth.status === "reauthorization_required";
        const status = t(authorized ? "已授权" : pending ? "等待授权" : reauthorize ? "需要重新授权" : app.connector ? "未授权" : "尚未连接");
        const subtitle = authorized
          ? app.connector!.used_by.length ? t("{count} 个 Agent 使用", { count: app.connector!.used_by.length }) : t("尚未分配给 Agent")
          : pending ? t("请在浏览器中继续") : reauthorize ? t("重新连接以恢复使用") : null;
        const action = t(authorized ? "管理应用" : pending ? "继续授权" : reauthorize ? "重新授权" : app.connector ? "去授权" : "连接应用");
        return <Pressable key={app.id} testID={`app-${app.id}`} accessibilityRole="button" accessibilityLabel={`${app.name}，${status}，${action}`}
          onPress={() => router.push({ pathname: "/apps/[id]", params: { id: app.id } })} className="gap-4 rounded-lg border border-border bg-card p-5 active:bg-muted">
          <View className="flex-row items-center gap-3">
            {brand ? <View className="size-[58px] items-center justify-center rounded-[15px] border border-black/10 bg-white">
              <Image source={brand.logo} style={{ width: 48, height: 48 }} resizeMode="contain" accessible={false} />
            </View> : null}
            <View className="min-w-0 flex-1">
              <Text className="text-[19px] font-semibold" numberOfLines={1}>{app.name}</Text>
            </View>
            <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
          </View>
          <Text className="text-sm leading-6 text-muted-foreground" numberOfLines={3}>{t(brand?.description ?? app.description)}</Text>
          <View className="flex-row items-center justify-between gap-3 border-t border-border pt-4">
            <View className="min-w-0 flex-1 gap-1">
              <View className="flex-row items-center gap-1.5">
                <View className={`size-1.5 rounded-full ${reauthorize ? "bg-destructive" : authorized ? "bg-foreground" : "bg-muted-foreground"}`} />
                <Text className={`min-w-0 flex-1 text-xs font-medium leading-[18px] ${reauthorize ? "text-destructive" : "text-foreground"}`}>{status}</Text>
              </View>
              {subtitle ? <Text className="text-xs leading-[18px] text-muted-foreground">{subtitle}</Text> : null}
            </View>
            <View pointerEvents="none" className={`h-9 items-center justify-center rounded-full border px-4 ${authorized || pending ? "border-border" : "border-primary bg-primary"}`}>
              <Text className={`text-xs font-semibold ${authorized || pending ? "text-foreground" : "text-primary-foreground"}`}>{action}</Text>
            </View>
          </View>
        </Pressable>;
      })}</View> : null}
      {!state.loaded && !state.error ? <Text className="mx-8 mt-8 text-center text-sm text-muted-foreground">{t("正在加载应用…")}</Text> : null}
      {state.loaded && !state.apps.length ? <Text className="mx-8 mt-8 text-center text-sm text-muted-foreground">{t("当前网关没有可用应用。")}</Text> : null}
      {state.error ? <View className="mx-6 mt-5 items-center gap-2"><Text testID="apps-error" className="text-center text-sm text-destructive">{t("无法加载应用：{error}", { error: t(state.error) })}</Text><Button testID="apps-retry" variant="outline" onPress={() => setRetry((value) => value + 1)}><Text>{t("重试")}</Text></Button></View> : null}
    </ScrollView>
  </View>;
}
