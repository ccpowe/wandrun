import { router, useIsFocused } from "expo-router";
import { Clock, Plus } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Switch, View } from "react-native";
import { useCSSVariable } from "uniwind";

import { EmptyState } from "@/components/empty-state.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ListRow, RowSubtitle } from "@/components/list-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { Schedule } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { scheduleNext, scheduleRuleLabel } from "@/lib/schedules.ts";
import { useTranslation } from "@/lib/i18n.ts";

export function AgentSchedulesTab({ id, name, session }: { id: string; name: string; session: ChatSession }) {
  const { t } = useTranslation();
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const operation = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const focused = useIsFocused();
  const revision = session.scheduleRevision;
  const [foreground, background, muted, mutedForeground] = useCSSVariable(["--color-foreground", "--color-background", "--color-muted", "--color-muted-foreground"]);
  useEffect(() => {
    if (!focused) return;
    let active = true;
    void session.api.listSchedules(id).then(
      (result) => {
        if (!active || session.scheduleRevision !== revision) return;
        setSchedules(result.schedules);
        setError("");
      },
      (reason: unknown) => {
        if (active && session.scheduleRevision === revision) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => { active = false; };
  }, [id, session, revision, retry, focused]);
  const toggle = async (schedule: Schedule, enabled: boolean) => {
    if (operation.current || schedule.ended || session.connection !== "open") return;
    operation.current = true;
    setUpdating(true);
    setUpdateError("");
    try {
      const result = await session.api.updateSchedule(schedule.id, { enabled });
      if (mounted.current && session.scheduleRevision === revision) {
        setSchedules((current) => current?.map((item) => item.id === schedule.id ? result.schedule : item) ?? null);
      }
    } catch (reason) {
      if (mounted.current) setUpdateError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operation.current = false;
      if (mounted.current) { setUpdating(false); setRetry((n) => n + 1); }
    }
  };
  return <View className="min-h-[320px] flex-1">
    <View className="mx-8 mt-3 flex-row items-center justify-between">
      <Text className="text-xs text-muted-foreground">{t("定时 · {count}", { count: schedules?.length ?? 0 })}</Text>
      <Button testID="profile-schedule-add" variant="ghost" size="icon" aria-label={t("新建定时")}
        disabled={!focused || session.connection !== "open"}
        onPress={() => router.push({ pathname: "/schedule-editor", params: { agentId: id } })}>
        <Icon as={Plus} className="size-5" />
      </Button>
    </View>
    {error ? <View className="mx-8 mt-2 gap-2"><Text testID="profile-schedules-error" className="text-sm text-destructive">{t("无法加载定时：{error}", { error: t(error) })}</Text>
      <Button variant="outline" className="self-start" onPress={() => setRetry((n) => n + 1)}><Text>{t("重试")}</Text></Button></View> : null}
    {updateError ? <Text testID="profile-schedules-update-error" className="mx-8 mt-2 text-sm text-destructive">{t("无法更新定时：{error}", { error: t(updateError) })}</Text> : null}
    {schedules === null && !error ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载定时…")}</Text> : null}
    {schedules?.length === 0 ? <EmptyState title={t("还没有定时")} description={t("到点后会开启新对话。")} /> : null}
    {!!schedules?.length && <ListGroup>{schedules.map((schedule) => <ListRow compact key={schedule.id} testID={`profile-schedule-${schedule.id}`}
      leading={<View className="size-9 items-center justify-center rounded-[10px] bg-muted"><Icon as={Clock} className="size-[18px]" /></View>}
      title={schedule.name} subtitle={<RowSubtitle compact text={`${scheduleRuleLabel(schedule.rule)} · ${scheduleNext(schedule)}`} />}
      trailing={<Switch testID={`profile-schedule-enabled-${schedule.id}`} accessibilityLabel={t("启用 {name}", { name: schedule.name })}
        value={schedule.enabled} disabled={updating || schedule.ended || session.connection !== "open"}
        trackColor={{ false: String(muted ?? "#F0F0ED"), true: String(foreground ?? "#141414") }}
        thumbColor={String(schedule.enabled ? background ?? "#FAFAFA" : mutedForeground ?? "#737373")}
        onValueChange={(enabled) => void toggle(schedule, enabled)} />}
      onPress={() => router.push({ pathname: "/schedule-editor", params: { id: schedule.id, agentId: id } })} />)}</ListGroup>}
  </View>;
}
