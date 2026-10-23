import { router, useIsFocused } from "expo-router";
import { ChevronDown, ChevronRight, Monitor, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { BrowserTaskCloseDialog } from "@/components/browser-task-close-dialog.tsx";
import { BrowserThumbnail } from "@/components/browser-thumbnail.tsx";
import { EmptyState } from "@/components/empty-state.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { SwipeRow } from "@/components/swipe-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { BrowserTask } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { activeBrowserPages, browserPageLabel, browserStateLabel, prioritizeBrowserPages } from "@/lib/browser-tasks.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { useTranslation } from "@/lib/i18n.ts";

/** The entry Agent owns the conversation even when a member holds its browser lease. */
export function AgentComputerTab({ id, session, viewport }: {
  id: string; session: ChatSession; viewport: { offset: number; height: number };
}) {
  const { t, language } = useTranslation();
  const focused = useIsFocused();
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState<BrowserTask | null>(null);
  const [tabTop, setTabTop] = useState<number | null>(null);
  const [cardBounds, setCardBounds] = useState<{ key: string; top: number; height: number } | null>(null);
  useEffect(() => { if (focused) void session.refreshBrowserTasks(); }, [session, focused]);
  const pages = prioritizeBrowserPages(activeBrowserPages(session.browserTasks.values(), id));
  const [featured, ...others] = pages;
  const featuredKey = featured ? `${featured.task.id}:${featured.page.id}` : "";
  const thumbnailVisible = focused && tabTop !== null && cardBounds?.key === featuredKey && viewport.height > 0 &&
    tabTop + cardBounds.top < viewport.offset + viewport.height &&
    tabTop + cardBounds.top + cardBounds.height > viewport.offset;
  const open = (leaseId: string, pageId: string) => router.push({ pathname: "/browser-viewer", params: { id: leaseId, page: pageId } });
  return <View className="min-h-[320px] flex-1" onLayout={(event) => setTabTop(event.nativeEvent.layout.y)}>
    {session.browserError ? <View className="mx-8 mt-4 gap-2">
      <Text testID="profile-computer-error" className="text-sm text-destructive">{t("无法更新浏览器页面：{error}", { error: t(session.browserError) })}</Text>
      <Button variant="outline" className="self-start" onPress={() => void session.refreshBrowserTasks()}><Text>{t("重试")}</Text></Button>
    </View> : null}
    {featured ? <>
      <View key={featuredKey} testID={`profile-computer-card-${featured.task.id}`}
        onLayout={(event) => setCardBounds({ key: featuredKey, top: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height })}
        className="mx-4 mt-4 overflow-hidden rounded-[18px] border border-border bg-card">
        <SwipeRow contentClassName="bg-card"
          action={{ label: t("关闭此任务的全部浏览器页面"), visibleLabel: language === "en" ? t("全部关闭") : undefined, icon: X, onPress: () => setClosing(featured.task) }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t("观看 {page}", { page: browserPageLabel(featured.page) })}
            onPress={() => open(featured.task.id, featured.page.id)}>
            <BrowserThumbnail task={featured.task} page={featured.page.id} active={thumbnailVisible} />
          </Pressable>
          <View className="flex-row items-center gap-2.5 px-3.5 py-3">
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-[15px] font-medium">{browserPageLabel(featured.page)}</Text>
              <Text numberOfLines={1} className="text-[13px] text-muted-foreground">{featured.task.conversation_title} · {t("{name} 操作", { name: agentDisplayName(session.agents, featured.task.agent_id, featured.task.agent_name) })}</Text>
            </View>
            <Button testID={`profile-computer-watch-${featured.task.id}`} variant="outline" className="h-8 rounded-full px-3.5"
              onPress={() => open(featured.task.id, featured.page.id)}><Text className="text-[13px]">{t("观看")}</Text></Button>
          </View>
          <View className="flex-row items-center gap-1.5 px-3.5 pb-3">
            {featured.task.state === "requested" && <View className="size-[7px] rounded-full bg-destructive" />}
            <Text className="text-xs font-semibold">{t(browserStateLabel(featured.task.state))}</Text>
          </View>
        </SwipeRow>
      </View>
      {others.length > 0 && <>
        <Button testID="profile-computer-other-pages" variant="ghost" className="mx-4 mt-4 justify-start bg-transparent px-4"
          onPress={() => setExpanded((value) => !value)}>
          <Text className="text-[13px] text-muted-foreground">{t("其他页面 · {count}", { count: others.length })}</Text>
          <Icon as={expanded ? ChevronDown : ChevronRight} className="size-4 text-muted-foreground" />
        </Button>
        {expanded && <ListGroup>{others.map(({ task, page }) => <SwipeRow key={`${task.id}:${page.id}`} contentClassName="bg-card"
          action={{ label: t("关闭此任务的全部浏览器页面"), visibleLabel: language === "en" ? t("全部关闭") : undefined, icon: X, onPress: () => setClosing(task) }}>
          <ListRow compact
            testID={`profile-computer-page-${task.id}-${page.id}`}
            leading={<View className="size-9 items-center justify-center rounded-[10px] bg-muted"><Icon as={Monitor} className="size-[18px]" /></View>}
            title={browserPageLabel(page)} subtitle={<RowSubtitle compact text={`${task.conversation_title} · ${t(browserStateLabel(task.state))}`} />}
            alert={task.state === "requested"} trailing={<Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />}
            onPress={() => open(task.id, page.id)} />
        </SwipeRow>)}</ListGroup>}
      </>}
      <Text className="mx-8 mt-3 text-xs leading-[17px] text-muted-foreground">{t("包含成员代办的页面。左滑可关闭该任务的全部页面。")}</Text>
    </> : !session.browserError && session.browserRevision === 0 ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载浏览器页面…")}</Text> :
      !session.browserError ? <View testID="profile-computer-empty" className="min-h-[320px] flex-1">
        <EmptyState title={t("没有浏览器页面")} />
      </View> : null}
    {closing && <BrowserTaskCloseDialog session={session} task={closing} onDismiss={() => setClosing(null)} testIDPrefix="profile-computer" />}
  </View>;
}
