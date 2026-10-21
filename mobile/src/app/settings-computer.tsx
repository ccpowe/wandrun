import { Redirect, router, Stack, useIsFocused } from "expo-router";
import { ChevronLeft, ChevronRight, Monitor, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BrowserTaskCloseDialog } from "@/components/browser-task-close-dialog.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { SwipeRow } from "@/components/swipe-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { BrowserTask, ComputerStatus } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { activeBrowserPages, browserPageLabel, browserStateLabel, groupBrowserPages } from "@/lib/browser-tasks.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { t, useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useComputerStatus } from "@/lib/use-computer-status.ts";

function uptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  if (hours >= 24) return t("网关已运行 {days} 天 {hours} 小时", { days: Math.floor(hours / 24), hours: hours % 24 });
  if (hours) return t("网关已运行 {hours} 小时", { hours });
  const minutes = Math.floor(seconds / 60);
  return minutes ? t("网关已运行 {minutes} 分钟", { minutes }) : t("网关刚刚启动");
}

function ResourceMeter({ testID, label, value, percent }: { testID: string; label: string; value: string; percent: number | null }) {
  return <View testID={testID} className="px-4 py-3">
    <View className="flex-row items-center justify-between gap-3">
      <Text className="text-[15px]">{label}</Text><Text className="text-[13px] text-muted-foreground">{value}</Text>
    </View>
    <View className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
      {percent !== null && <View className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />}
    </View>
  </View>;
}

function ComputerResources({ status, online }: { status: ComputerStatus | null; online: boolean }) {
  const { t } = useTranslation();
  return <ListGroup>
    <View className="flex-row items-center gap-3.5 px-4 py-3.5">
      <View className="size-12 items-center justify-center rounded-[14px] bg-muted"><Icon as={Monitor} className="size-6" /></View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-lg font-medium">{status?.name ?? t("电脑")}</Text>
        <View className="flex-row items-center gap-1.5">
          {status && online && <View className="size-[7px] rounded-full bg-foreground" />}
          <Text className="text-[13px] text-muted-foreground">{!online ? t("状态暂不可用") : status ? t("在线 · {uptime}", { uptime: uptime(status.uptime_seconds) }) : t("正在读取电脑状态…")}</Text>
        </View>
      </View>
    </View>
    <ResourceMeter testID="settings-computer-cpu" label="CPU" percent={status?.cpu_percent ?? null}
      value={status?.cpu_percent == null ? t("暂不可用") : `${Math.round(status.cpu_percent)}%`} />
    <ResourceMeter testID="settings-computer-memory" label={t("内存")} percent={status?.memory.percent ?? null}
      value={status ? `${(status.memory.used_bytes / 1024 ** 3).toFixed(1)} / ${(status.memory.total_bytes / 1024 ** 3).toFixed(1)} GB` : t("暂不可用")} />
    <ResourceMeter testID="settings-computer-pages" label={t("浏览器页面")}
      percent={status && status.browser.pages_limit > 0 ? status.browser.pages_used / status.browser.pages_limit * 100 : null}
      value={status ? `${status.browser.pages_used} / ${status.browser.pages_limit}` : t("暂不可用")} />
  </ListGroup>;
}

export default function SettingsComputer() {
  const session = useSession();
  if (!session) return <Redirect href="/settings" />;
  return <ComputerScreen key={JSON.stringify(session.api.config)} session={session} />;
}

function ComputerScreen({ session }: { session: ChatSession }) {
  const { t, language } = useTranslation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const computer = useComputerStatus(session, focused);
  const [closing, setClosing] = useState<BrowserTask | null>(null);
  useEffect(() => { if (focused) void session.refreshBrowserTasks(); }, [session, focused]);

  const pages = activeBrowserPages(session.browserTasks.values());
  const groups = groupBrowserPages(pages);
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("电脑")} left={<Button testID="settings-computer-back" variant="ghost" size="icon" className="bg-transparent"
      aria-label={t("返回")} onPress={() => router.back()}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
      <ComputerResources status={computer?.status ?? null} online={session.connection === "open"} />
      {computer?.error && <View className="mx-8 mt-2 gap-2"><Text testID="settings-computer-resource-error" className="text-sm text-destructive">{t("无法更新电脑状态：{error}", { error: t(computer.error) })}</Text></View>}
      {session.browserError && <View className="mx-8 mt-3 gap-2">
        <Text testID="settings-computer-pages-error" className="text-sm text-destructive">{t("无法更新浏览器页面：{error}", { error: t(session.browserError) })}</Text>
        <Button variant="outline" className="self-start" onPress={() => void session.refreshBrowserTasks()}><Text>{t("重试")}</Text></Button>
      </View>}
      {groups.map((group) => <ListGroup key={group.agentId} label={`${agentDisplayName(session.agents, group.agentId, group.agentName)} · ${group.pages.length}`}>
        {group.pages.map(({ task, page }) => <SwipeRow key={`${task.id}:${page.id}`} contentClassName="bg-card"
          action={{ label: t("关闭此任务的全部浏览器页面"), visibleLabel: language === "en" ? t("全部关闭") : undefined, icon: X, onPress: () => setClosing(task) }}>
          <ListRow compact testID={`settings-computer-page-${task.id}-${page.id}`}
            leading={<View className="size-9 items-center justify-center rounded-[10px] bg-muted"><Icon as={Monitor} className="size-[18px]" /></View>}
            title={browserPageLabel(page)} subtitle={<RowSubtitle compact text={`${task.conversation_title} · ${browserStateLabel(task.state)}`} />}
            alert={task.state === "requested"} trailing={<Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />}
            onPress={() => router.push({ pathname: "/browser-viewer", params: { id: task.id, page: page.id } })} />
        </SwipeRow>)}
      </ListGroup>)}
      {pages.length === 0 && !session.browserError && (session.browserRevision === 0 ?
        <Text className="pt-12 text-center text-sm text-muted-foreground">{t("正在加载浏览器页面…")}</Text> :
        <View testID="settings-computer-empty" className="items-center gap-2 px-8 pt-12">
          <Text className="text-lg font-medium">{t("没有正在使用的浏览器页面")}</Text>
        </View>)}
    </ScrollView>
    {closing && <BrowserTaskCloseDialog session={session} task={closing} onDismiss={() => setClosing(null)} testIDPrefix="settings-computer" />}
  </View>;
}
