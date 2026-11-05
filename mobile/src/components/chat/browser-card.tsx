import { router } from "expo-router";
import { View } from "react-native";

import { BrowserThumbnail } from "@/components/browser-thumbnail.tsx";
import { SurfacePressable } from "@/components/ui/surface-pressable.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { BrowserTask } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { browserStateLabel } from "@/lib/browser-tasks.ts";
import { useTranslation } from "@/lib/i18n.ts";

/** A lease stays at its first timeline position; agentName is the resolved holder label, never an ID fallback. */
export function BrowserCard({ session, task, active, agentName }: { session: ChatSession; task: BrowserTask; active: boolean; agentName: string }) {
  const { t } = useTranslation();
  const page = task.pages.find((page) => page.id === task.current) ?? task.pages[0];
  const ended = task.state === "released";
  const open = () => router.push({ pathname: "/browser-viewer", params: { id: task.id } });
  return <SurfacePressable testID={`browser-card-${task.id}`} accessibilityRole="button" accessibilityLabel={t("观看浏览器")}
    onPress={open} className="w-[260px] max-w-full overflow-hidden rounded-lg bg-card">
    <View className="h-[150px] bg-muted">
      <BrowserThumbnail session={session} task={task} active={active && !ended} refresh className="h-full w-full" />
      <View className="absolute left-3 top-3 flex-row items-center gap-1.5 rounded-full bg-immersive-scrim px-2 py-1">
        {!ended && <View className={task.state === "requested" ? "size-1.5 rounded-full bg-destructive" : "size-1.5 rounded-full bg-immersive-foreground"} />}
        <Text className="text-xs text-immersive-foreground">{ended ? t("已结束") : t("实时")}</Text>
      </View>
    </View>
    <View className="flex-row items-center gap-2 px-3 py-2.5">
      <View className="min-w-0 flex-1">
        <Text variant="caption">{agentName} · {t(browserStateLabel(task.state))}</Text>
        <Text variant="caption" numberOfLines={1} className="text-muted-foreground">{page?.url || (task.reason ? t(task.reason) : t("页面已关闭"))}</Text>
      </View>
      <Button testID={`browser-watch-${task.id}`} intent="soft" size="sm" onPress={open}>
        <Text>{t("观看")}</Text>
      </Button>
    </View>
  </SurfacePressable>;
}
