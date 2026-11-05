import type { ReactNode } from "react";
import { Bookmark, ChevronLeft, CircleAlert, Clock3, CodeXml, File, Globe2, Image, LayoutPanelTop, Search, Terminal, type LucideIcon } from "lucide-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow } from "./group-row.tsx";
import { ListGroup } from "./list-group.tsx";
import { LoadingState } from "./loading-state.tsx";
import { ScreenBar } from "./screen-bar.tsx";
import { StatusBanner } from "./status-banner.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Text, TextClassContext } from "./ui/text.tsx";
import { capabilityDescriptions, type CapabilitySelection } from "../lib/agent-capabilities-state.ts";
import { useTranslation } from "../lib/i18n.ts";
import { useDelayedNotice } from "../lib/use-delayed-notice.ts";

const icons: Record<string, LucideIcon> = {
  files: File, processes: Terminal, memory: Bookmark, schedule: Clock3,
  image_generation: Image, ui_blocks: LayoutPanelTop, code_mode: CodeXml,
  tool_search: Search, browser: Globe2,
};

export type AgentCapabilitiesViewProps = {
  selection: CapabilitySelection;
  readError: boolean;
  connectionBanner: ReactNode;
  onBack(): void;
  onOpen(id: string): void;
  onClose(): void;
};

export function AgentCapabilitiesView({ selection, readError, connectionBanner, onBack, onOpen, onClose }: AgentCapabilitiesViewProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const showReadError = useDelayedNotice(readError ? "capabilities" : null);
  const { enabled, unavailable, selected, loading, empty, stale } = selection;
  return <View className="flex-1 bg-background">
    <ScreenBar title={t("系统能力")} left={<Button testID="capabilities-back" intent="quiet" size="icon" accessibilityLabel={t("返回 Agent 编辑")} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {connectionBanner}
    {readError && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t("无法加载系统能力，正在重试…")} description={stale ? t("内容可能不是最新的") : undefined} /> : null}
    <ScrollView testID="capabilities-screen" contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + 24 }}>
      {enabled.length ? <ListGroup label={t("已启用")}>{enabled.map(item => <GroupRow key={item.id} testID={`capability-${item.id}`} title={t(item.name)} description={t(item.summary)} icon={icons[item.id] ?? File} affordance="navigate" accessibilityLabel={`${t(item.name)}，${t(item.summary)}`} onPress={() => onOpen(item.id)} />)}</ListGroup> : null}
      {unavailable.length ? <TextClassContext.Provider value="text-muted-foreground"><ListGroup label={t("未启用")}>{unavailable.map(item => <GroupRow key={item.id} testID={`capability-unavailable-${item.id}`} title={t(item.name)} icon={icons[item.id] ?? File} value={t(item.reason ?? "")} />)}</ListGroup></TextClassContext.Provider> : null}
      {loading ? <LoadingState /> : null}
      {empty ? <Text variant="caption" className="mx-8 mt-10 text-center text-muted-foreground">{t("没有系统能力")}</Text> : null}
    </ScrollView>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent testID="capability-sheet" overlayTestID="capability-backdrop" overlayClassName="justify-end p-0" className="w-full rounded-b-none" style={{ paddingBottom: insets.bottom + 20 }}>
        <DialogHeader><DialogTitle testID="capability-sheet-title" className="pr-8 text-left">{selected && t(selected.name)}</DialogTitle><DialogDescription className="text-left leading-5">{selected && t(Object.hasOwn(capabilityDescriptions, selected.description) ? capabilityDescriptions[selected.description] : selected.description)}</DialogDescription></DialogHeader>
        {selected?.tools.length ? <View className="flex-row flex-wrap gap-2">{selected.tools.map(tool => <View key={tool} className="rounded-md bg-muted px-3 py-1"><Text className="font-mono text-xs">{tool}</Text></View>)}</View> : null}
        {selected?.reason ? <Text variant="caption" className="text-muted-foreground">{t(selected.reason)}</Text> : null}
      </DialogContent>
    </Dialog>
  </View>;
}
