import { Clock } from "lucide-react-native";
import { View } from "react-native";
import { GroupRow } from "./group-row.tsx";
import { ListGroup } from "./list-group.tsx";
import { Switch } from "./ui/switch.tsx";
import { Text } from "./ui/text.tsx";
import type { Schedule } from "../gateway/api.ts";
import type { AgentProfileSelection } from "../lib/agent-profile.ts";
import { scheduleNext, scheduleRuleLabel } from "../lib/schedules.ts";
import { useTranslation } from "../lib/i18n.ts";

export function AgentSchedulesTab({ selection, onToggle, onOpen }: {
  selection: AgentProfileSelection; onToggle(schedule: Schedule, enabled: boolean): void; onOpen(id: string): void;
}) {
  const { t } = useTranslation();
  return <View className="min-h-[320px] flex-1">
    {selection.schedulesLoading ? <Text variant="caption" className="mt-12 text-center text-muted-foreground">{t("正在加载定时…")}</Text> : null}
    {selection.schedulesEmpty ? <ListGroup className="mt-5"><View className="min-h-[52px] justify-center px-4"><Text variant="caption" className="text-muted-foreground">{t("还没有定时")}</Text></View></ListGroup> : null}
    {selection.schedules.length ? <ListGroup className="mt-5">{selection.schedules.map(schedule => <View key={schedule.id} className="flex-row items-center">
      <GroupRow testID={`profile-schedule-${schedule.id}`} className="min-w-0 flex-1" icon={Clock} title={schedule.name}
        description={`${scheduleRuleLabel(schedule.rule)} · ${scheduleNext(schedule)}`} onPress={() => onOpen(schedule.id)} />
      <View className="min-h-12 justify-center pl-1 pr-4"><Switch testID={`profile-schedule-enabled-${schedule.id}`} accessibilityLabel={t("启用 {name}", { name: schedule.name })}
        checked={schedule.enabled} disabled={selection.scheduleLocked || schedule.ended}
        onCheckedChange={enabled => onToggle(schedule, enabled)} /></View>
    </View>)}</ListGroup> : null}
  </View>;
}
