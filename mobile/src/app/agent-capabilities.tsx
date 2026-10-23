import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { Bookmark, ChevronLeft, ChevronRight, Clock3, CodeXml, File, Globe2, Image, LayoutPanelTop, Search, Terminal } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { useAgentCapabilities } from "@/lib/agent-capabilities.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useSession } from "@/lib/session-context.tsx";
import { useTranslation } from "@/lib/i18n.ts";

const icons: Record<string, LucideIcon> = {
  files: File, processes: Terminal, memory: Bookmark, schedule: Clock3,
  image_generation: Image, ui_blocks: LayoutPanelTop, code_mode: CodeXml,
  tool_search: Search, browser: Globe2,
};

// Only known gateway descriptions have shorter display copy; leave other descriptions intact.
const descriptions: Record<string, string> = {
  "跨对话保留记忆，可在 Agent 资料中编辑。": "跨对话记忆，可在 Agent 资料编辑。",
  "连接器设为“按需搜索”时，Agent 先搜索再加载需要的工具。": "按需连接器先搜索，再加载所需工具。",
  "读写这个 Agent 所在电脑上的文件，相对路径落在当前对话的目录里。": "读写 Agent 电脑的文件；相对路径使用当前对话目录。",
  "在这台电脑上运行命令和脚本，耗时的会转到后台，完成后通知 Agent。": "在电脑上运行命令和脚本；耗时任务后台运行，完成后通知 Agent。",
  "用电脑上的浏览器操作网页，遇到登录等情况请你接管。": "用电脑浏览器操作网页；登录等情况由你接管。",
  "写一段 Python 脚本批量调用工具、处理中间数据。": "用 Python 批量调用工具、处理中间数据。",
  "在消息中显示表单、图表等交互界面。": "消息内的交互表单、图表。",
  "由 Agent 创建定时任务，在 Agent 资料 › 定时中管理。": "Agent 创建定时，在 Agent 资料 › 定时中管理。",
  "生成图片并保存到当前对话的目录。": "生成图片，保存到当前对话目录。",
};

export default function AgentCapabilitiesRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const session = useSession();
  if (!session || !id) return <Redirect href="/" />;
  return <CapabilitiesScreen key={id} session={session} id={id} />;
}

function CapabilitiesScreen({ session, id }: { session: ChatSession; id: string }) {
  const { t } = useTranslation();
  const { capabilities, error, refresh } = useAgentCapabilities(session, id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const enabled = capabilities?.filter((item) => item.status === "enabled") ?? [];
  const unavailable = capabilities?.filter((item) => item.status !== "enabled") ?? [];
  const selected = enabled.find((item) => item.id === selectedId) ?? null;
  // A loaded snapshot revokes the selection, not just the currently visible details.
  if (capabilities !== null && selectedId !== null && selected === null) setSelectedId(null);
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("系统能力")} left={<Button testID="capabilities-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回 Agent 编辑")} onPress={() => router.back()}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView testID="capabilities-screen" refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {enabled.length ? <ListGroup label={t("已启用")}>{enabled.map((item) => <Pressable key={item.id} testID={`capability-${item.id}`} accessibilityRole="button" accessibilityLabel={`${t(item.name)}，${t(item.summary)}`} onPress={() => setSelectedId(item.id)} className="min-h-[68px] flex-row items-center gap-3 px-4 py-2.5 active:bg-muted">
        <Icon as={icons[item.id] ?? File} className="size-[22px]" />
        <View className="min-w-0 flex-1 gap-0.5"><Text className="text-[17px] font-medium" numberOfLines={1}>{t(item.name)}</Text><Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{t(item.summary)}</Text></View>
        <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
      </Pressable>)}</ListGroup> : null}
      {unavailable.length ? <ListGroup label={t("未启用")}>{unavailable.map((item) => <View key={item.id} testID={`capability-unavailable-${item.id}`} className="min-h-[60px] flex-row items-center gap-3 px-4 py-2.5">
        <Icon as={icons[item.id] ?? File} className="size-[22px] text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-[15px] text-muted-foreground" numberOfLines={1}>{t(item.name)}</Text>
        <Text className="max-w-[55%] text-xs text-muted-foreground" numberOfLines={2}>{t(item.reason ?? "")}</Text>
      </View>)}</ListGroup> : null}
      {!capabilities && !error ? <Text className="mx-8 mt-10 text-center text-sm text-muted-foreground">{t("正在加载系统能力…")}</Text> : null}
      {error ? <View className="mx-6 mt-5 items-center gap-2"><Text className="text-center text-sm text-destructive">{t(error)}</Text><Button variant="outline" onPress={refresh}><Text>{t("重试")}</Text></Button></View> : null}
    </ScrollView>
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
      <DialogContent testID="capability-sheet" overlayTestID="capability-backdrop" overlayClassName="justify-end p-0" className="w-full rounded-b-none rounded-t-[24px] border-border bg-card" style={{ paddingBottom: insets.bottom + 20 }}>
        <DialogHeader><DialogTitle testID="capability-sheet-title" className="pr-8 text-left">{selected && t(selected.name)}</DialogTitle><DialogDescription className="text-left leading-5">{selected && t(Object.hasOwn(descriptions, selected.description) ? descriptions[selected.description] : selected.description)}</DialogDescription></DialogHeader>
        {selected?.tools.length ? <View className="flex-row flex-wrap gap-2">{selected.tools.map((tool) => <View key={tool} className="rounded-md border border-border bg-muted px-2.5 py-1"><Text className="font-mono text-xs">{tool}</Text></View>)}</View> : null}
        {selected?.reason ? <Text className="text-xs text-muted-foreground">{t(selected.reason)}</Text> : null}
      </DialogContent>
    </Dialog>
  </View>;
}
