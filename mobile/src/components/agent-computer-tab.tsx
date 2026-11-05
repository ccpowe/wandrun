import { router, useFocusEffect, useIsFocused } from "expo-router";
import { ChevronDown, ChevronRight, Globe2, X } from "lucide-react-native";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { BrowserThumbnail } from "@/components/browser-thumbnail.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { SwipeRow } from "@/components/swipe-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { SurfacePressable } from "@/components/ui/surface-pressable.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { activeBrowserPages, browserPageLabel, browserStateLabel, prioritizeBrowserPages } from "@/lib/browser-tasks.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useBrowserTaskClose } from "@/lib/use-browser-task-close.ts";

/** The entry Agent owns the conversation even when a member holds its browser lease. */
export function AgentComputerTab({ id, session, viewport }: {
  id: string; session: ChatSession; viewport: { offset: number; height: number };
}) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const [expanded, setExpanded] = useState(false);
  const pages = prioritizeBrowserPages(activeBrowserPages(session.browserTasks.values(), id));
  const browserClose = useBrowserTaskClose(session, pages.map(({ task }) => task.id));
  const [tabTop, setTabTop] = useState<number | null>(null);
  const [cardBounds, setCardBounds] = useState<{ key: string; top: number; height: number } | null>(null);
  useFocusEffect(useCallback(() => { void session.refreshBrowserTasks(); }, [session]));
  const [featured, ...others] = pages;
  const featuredKey = featured ? `${featured.task.id}:${featured.page.id}` : "";
  const thumbnailVisible = focused && tabTop !== null && cardBounds?.key === featuredKey && viewport.height > 0 &&
    tabTop + cardBounds.top < viewport.offset + viewport.height &&
    tabTop + cardBounds.top + cardBounds.height > viewport.offset;
  const open = (leaseId: string, pageId: string) => router.push({ pathname: "/browser-viewer", params: { id: leaseId, page: pageId } });
  return <View className="min-h-[320px] flex-1" onLayout={(event) => setTabTop(event.nativeEvent.layout.y)}>
    {browserClose.error ? <Text testID="profile-computer-close-error" className="mx-8 mt-3 text-sm text-destructive">{browserClose.unknown ? t(browserClose.error) : t("关闭失败：{error}", { error: t(browserClose.error) })}</Text> : null}
    {featured ? <>
      <View key={featuredKey} testID={`profile-computer-card-${featured.task.id}`}
        onLayout={(event) => setCardBounds({ key: featuredKey, top: event.nativeEvent.layout.y, height: event.nativeEvent.layout.height })}
        className="mx-4 mt-5 overflow-hidden rounded-lg bg-card">
        <SwipeRow contentClassName="bg-card"
          action={{ label: t("关闭此任务的全部浏览器页面"), icon: X, disabled: !browserClose.canClose(featured.task.id), onPress: () => void browserClose.close(featured.task.id) }}>
          <SurfacePressable accessibilityRole="button" accessibilityLabel={t("观看 {page}", { page: browserPageLabel(featured.page) })}
            onPress={() => open(featured.task.id, featured.page.id)}>
            <BrowserThumbnail session={session} task={featured.task} page={featured.page.id} active={thumbnailVisible} />
          </SurfacePressable>
          <View className="flex-row items-center gap-3 px-4 py-3">
            <View className="min-w-0 flex-1">
              <Text variant="body" numberOfLines={1}>{browserPageLabel(featured.page)}</Text>
              <Text variant="caption" numberOfLines={1} className="text-muted-foreground">{featured.task.conversation_title} · {t("{name} 操作", { name: agentDisplayName(session.agents, featured.task.agent_id, featured.task.agent_name) })}</Text>
            </View>
            <Button testID={`profile-computer-watch-${featured.task.id}`} intent="soft"
              onPress={() => open(featured.task.id, featured.page.id)}><Text>{t("观看")}</Text></Button>
          </View>
          <View className="flex-row items-center gap-2 px-4 pb-3">
            {featured.task.state === "requested" && <View className="size-[7px] rounded-full bg-destructive" />}
            <Text variant="caption" className="text-muted-foreground">{t(browserClose.blockedReasons.get(featured.task.id) ?? browserStateLabel(featured.task.state))}</Text>
          </View>
        </SwipeRow>
      </View>
      {others.length > 0 && <>
        <Button testID="profile-computer-other-pages" intent="quiet" className="mx-4 mt-5 justify-start px-4"
          onPress={() => setExpanded((value) => !value)}>
          <Text variant="caption" className="text-muted-foreground">{t("其他页面 · {count}", { count: others.length })}</Text>
          <Icon as={expanded ? ChevronDown : ChevronRight} className="size-4 text-muted-foreground" />
        </Button>
        {expanded && <ListGroup>{others.map(({ task, page }) => <SwipeRow key={`${task.id}:${page.id}`} contentClassName="bg-card"
          action={{ label: t("关闭此任务的全部浏览器页面"), icon: X, disabled: !browserClose.canClose(task.id), onPress: () => void browserClose.close(task.id) }}>
          <ListRow
            testID={`profile-computer-page-${task.id}-${page.id}`}
            leading={<Icon as={Globe2} size={20} className="text-muted-foreground" />}
            title={browserPageLabel(page)} subtitle={<RowSubtitle text={t(browserClose.blockedReasons.get(task.id) ?? `${task.conversation_title} · ${browserStateLabel(task.state)}`)} />}
            alert={task.state === "requested"} trailing={<Icon as={ChevronRight} size={16} className="text-muted-foreground/60" />}
            onPress={() => open(task.id, page.id)} />
        </SwipeRow>)}</ListGroup>}
      </>}
      <Text variant="caption" className="mx-8 mt-3 leading-5 text-muted-foreground">{t("包含成员代办的页面。左滑可关闭该任务的全部页面。")}</Text>
    </> : !session.browserError && session.browserRevision === 0 ? <Text variant="caption" className="mt-12 text-center text-muted-foreground">{t("正在加载浏览器页面…")}</Text> :
      !session.browserError ? <ListGroup className="mt-5"><View className="min-h-[52px] justify-center px-4"><Text testID="profile-computer-empty" variant="caption" className="text-muted-foreground">{t("没有浏览器页面")}</Text></View></ListGroup> : null}
  </View>;
}
