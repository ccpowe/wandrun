import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, Switch, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCSSVariable } from "uniwind";

import { ScreenBar } from "@/components/screen-bar.tsx";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { createResultUnknown, GatewayError, type Schedule, type ScheduleRule, type ScheduleRun } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { changedScheduleFields, editableSchedule, newScheduleDraft, scheduleNext, scheduleRunLabel, scheduleTime, validateSchedule, type CreateScheduleCommand, type ScheduleDraft } from "@/lib/schedules.ts";
import { useSession } from "@/lib/session-context.tsx";
import { cn } from "@/lib/utils.ts";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export default function ScheduleEditorRoute() {
  const { id, agentId } = useLocalSearchParams<{ id?: string; agentId: string }>();
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <ScheduleEditor key={`${agentId}:${id ?? "new"}`} id={id} agentId={agentId} session={session} />;
}

function ScheduleEditor({ id, agentId, session }: { id?: string; agentId: string; session: ChatSession }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [original, setOriginal] = useState<ScheduleDraft | null>(null);
  const [detail, setDetail] = useState<Schedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [retryLoad, setRetryLoad] = useState(0);
  const [saving, setSaving] = useState(false);
  const [createUnknown, setCreateUnknown] = useState(false);
  const createCommand = useRef<CreateScheduleCommand | null>(null);
  const operation = useRef(false);
  const mounted = useRef(true);
  const dismissed = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dismiss = useCallback(() => {
    if (!mounted.current || dismissed.current) return;
    dismissed.current = true;
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: "/agents/[id]", params: { id: agentId, tab: "schedules" } });
  }, [agentId]);
  const draftRef = useRef<ScheduleDraft | null>(null);
  const originalRef = useRef<ScheduleDraft | null>(null);
  const focused = useIsFocused();
  const revision = session.scheduleRevision;
  const insets = useSafeAreaInsets();
  const [foreground, background, muted, mutedForeground] = useCSSVariable(["--color-foreground", "--color-background", "--color-muted", "--color-muted-foreground"]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [runsError, setRunsError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [runsSettledKey, setRunsSettledKey] = useState<string | null>(null);
  const [runsComplete, setRunsComplete] = useState(false);
  const [runsRetry, setRunsRetry] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const runsGeneration = useRef(0);
  const runsKey = `${revision}:${runsRetry}`;
  const runsLoading = loadingMore || (!!id && focused && runsSettledKey !== runsKey);

  useEffect(() => {
    if (!focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => createUnknown || operation.current);
    return () => subscription.remove();
  }, [createUnknown, focused]);

  useEffect(() => {
    if (!focused) return;
    let active = true;
    const request = id
      ? session.api.getSchedule(id).then((schedule) => ({ schedule, defaultTimezone: null }))
      : session.api.listSchedules(agentId).then((listed) => ({ schedule: null, defaultTimezone: listed.default_timezone }));
    void request.then(({ schedule, defaultTimezone }) => {
      if (!active || session.scheduleRevision !== revision) return;
      if (schedule && schedule.agent_id !== agentId) { setLoadError("定时不属于这个 Agent"); setLoading(false); return; }
      if (id && session.deletedScheduleIds.has(id)) { dismiss(); return; }
      const fields = schedule ? editableSchedule(schedule) : newScheduleDraft(defaultTimezone);
      const dirty = !!draftRef.current && (!originalRef.current || Object.keys(changedScheduleFields(originalRef.current, draftRef.current)).length > 0);
      if (!dirty && !operation.current && !createCommand.current) {
        draftRef.current = fields;
        originalRef.current = schedule ? fields : null;
        setDraft(fields);
        setOriginal(schedule ? fields : null);
        setExternalChange(false);
      } else if (schedule && originalRef.current && Object.keys(changedScheduleFields(originalRef.current, fields)).length > 0) {
        setExternalChange(true);
      }
      setDetail(schedule);
      setLoading(false);
      setLoadError("");
    }, (reason: unknown) => {
      if (!active || session.scheduleRevision !== revision) return;
      if (reason instanceof GatewayError && reason.status === 404 && id) { dismiss(); return; }
      setLoadError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => { active = false; };
  }, [session, id, agentId, revision, retryLoad, focused, dismiss]);

  useEffect(() => {
    if (!id || !focused) return;
    let active = true;
    const generation = ++runsGeneration.current;
    void session.api.scheduleRuns(id).then(({ runs: page }) => {
      if (!active || runsGeneration.current !== generation || session.scheduleRevision !== revision) return;
      setRuns(page);
      setRunsComplete(page.length < 20);
      setRunsError("");
    }, (reason: unknown) => {
      if (active && runsGeneration.current === generation && session.scheduleRevision === revision) setRunsError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active && runsGeneration.current === generation) {
        setRunsSettledKey(runsKey);
        setLoadingMore(false);
      }
    });
    return () => { active = false; };
  }, [session, id, revision, runsKey, focused]);

  const change = (next: ScheduleDraft) => {
    if (operation.current || createUnknown) return;
    draftRef.current = next;
    setDraft(next);
    setSaveError("");
  };
  const changeRule = (rule: ScheduleRule) => { if (draft) change({ ...draft, rule }); };
  const changeKind = (kind: ScheduleRule["kind"]) => {
    if (!draft || kind === draft.rule.kind) return;
    const rule: ScheduleRule = kind === "once" ? { kind, local_at: "" }
      : kind === "daily" ? { kind, time: "08:00" }
      : kind === "weekly" ? { kind, time: "08:00", weekdays: [1] }
      : { kind, expression: "0 8 * * *" };
    changeRule(rule);
  };
  const save = async () => {
    if (!draft || operation.current || session.connection !== "open") return;
    if (!createUnknown) {
      const invalid = validateSchedule(draft);
      if (invalid) { setSaveError(invalid); return; }
    }
    const patch = original ? changedScheduleFields(original, draft) : null;
    if (id && patch && !Object.keys(patch).length) { dismiss(); return; }
    operation.current = true;
    setSaving(true);
    setSaveError("");
    try {
      if (id) await session.api.updateSchedule(id, patch!);
      else {
        createCommand.current ??= { clientId: `schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`, fields: { ...draft } };
        await session.api.createSchedule(agentId, createCommand.current.clientId, createCommand.current.fields);
      }
      createCommand.current = null;
      dismiss();
    } catch (reason) {
      const unknown = !id && createResultUnknown(reason, createUnknown);
      if (!unknown) createCommand.current = null;
      if (mounted.current) {
        setCreateUnknown(unknown);
        setSaveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally { operation.current = false; if (mounted.current) setSaving(false); }
  };
  const remove = async () => {
    if (!id || operation.current || session.connection !== "open") return;
    operation.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      await session.api.deleteSchedule(id);
      dismiss();
    } catch (reason) { if (mounted.current) setDeleteError(reason instanceof Error ? reason.message : String(reason)); }
    finally { operation.current = false; if (mounted.current) setDeleting(false); }
  };
  const loadMore = async () => {
    if (!id || runsLoading || runsComplete || !runs.length) return;
    const generation = ++runsGeneration.current;
    setLoadingMore(true);
    setRunsError("");
    try {
      const { runs: page } = await session.api.scheduleRuns(id, runs.at(-1)!.id);
      if (runsGeneration.current !== generation || !focused || session.scheduleRevision !== revision) return;
      setRuns((current) => {
        const seen = new Set(current.map((run) => run.id));
        return [...current, ...page.filter((run) => !seen.has(run.id))];
      });
      setRunsComplete(page.length < 20);
    } catch (reason) {
      if (runsGeneration.current === generation && session.scheduleRevision === revision) setRunsError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (mounted.current && runsGeneration.current === generation) setLoadingMore(false); }
  };
  const locked = saving || deleting || createUnknown;
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false, gestureEnabled: !locked }} />
    <ScreenBar left={<Button testID="schedule-back" variant="ghost" size="icon" className="bg-transparent" aria-label={t("返回")} disabled={locked}
      onPress={() => { if (!locked) dismiss(); }}><Icon as={ChevronLeft} className="size-[22px]" /></Button>}
      title={id ? t("编辑定时") : t("新建定时")}
      right={<Button testID="schedule-save" variant="outline" size="sm" className="h-8 rounded-full border-foreground bg-background" disabled={!draft || loading || saving || deleting || session.connection !== "open"}
        onPress={() => void save()}><Text>{saving ? t("保存中…") : createUnknown ? t("重试保存") : t("保存")}</Text></Button>} />
    <ConnectionBanner session={session} />
    {loading && !draft ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载定时…")}</Text> : null}
    {loadError ? <View className="mx-6 mt-4 gap-2"><Text testID="schedule-load-error" className="text-sm text-destructive">{t("无法加载定时：{error}", { error: t(loadError) })}</Text>
      <Button variant="outline" onPress={() => setRetryLoad((n) => n + 1)}><Text>{t("重试")}</Text></Button></View> : null}
    {draft && <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
      {externalChange && <View className="mx-4 mt-2 gap-2 rounded-xl bg-muted p-3"><Text className="text-sm">{t("定时已在别处更新，当前草稿未被覆盖。")}</Text>
        <Button testID="schedule-reload" variant="outline" disabled={saving} onPress={() => {
          draftRef.current = null; originalRef.current = null; setDraft(null); setLoading(true); setRetryLoad((n) => n + 1);
        }}><Text>{t("重新载入并舍弃草稿")}</Text></Button></View>}
      <View className="gap-3 px-4 pt-2">
        <View className="gap-1"><Text className="px-1 text-sm text-muted-foreground">{t("名称")}</Text>
          <Input testID="schedule-name" value={draft.name} editable={!locked} placeholder={t("例如每日新闻简报")} onChangeText={(name) => change({ ...draft, name })} /></View>
        <View className="gap-1"><Text className="px-1 text-sm text-muted-foreground">{t("要做什么")}</Text>
          <Textarea testID="schedule-content" value={draft.content} editable={!locked} className="min-h-24" placeholder={t("写下定时触发后交给 Agent 的完整任务说明")} onChangeText={(content) => change({ ...draft, content })} /></View>
      </View>
      <View className="mx-4 mt-4 overflow-hidden rounded-xl border border-border bg-card">
        <View className="gap-2 border-b border-border px-4 py-3"><Text>{t("重复")}</Text>
          <View className="flex-row flex-wrap gap-2">{(["once", "daily", "weekly", "cron"] as const).map((kind) =>
            <Button key={kind} testID={`schedule-kind-${kind}`} size="sm" variant="outline" disabled={locked} accessibilityRole="radio" accessibilityState={{ selected: draft.rule.kind === kind }}
              className={cn("rounded-full", draft.rule.kind === kind && "border-foreground bg-muted")}
              onPress={() => changeKind(kind)}><Text>{t(({ once: "单次", daily: "每天", weekly: "每周", cron: "Cron" })[kind])}</Text></Button>)}</View>
        </View>
        <View className="gap-1 border-b border-border px-4 py-3">
          <Text>{draft.rule.kind === "once" ? t("日期与时间") : draft.rule.kind === "cron" ? t("五段 Cron 表达式") : t("时间")}</Text>
          {draft.rule.kind === "once" ? <Input testID="schedule-local-at" value={draft.rule.local_at} editable={!locked} placeholder="YYYY-MM-DDTHH:mm" autoCapitalize="none"
            onChangeText={(local_at) => changeRule({ kind: "once", local_at })} />
            : draft.rule.kind === "cron" ? <Input testID="schedule-cron" value={draft.rule.expression} editable={!locked} placeholder="0 8 * * *" autoCapitalize="none"
              onChangeText={(expression) => changeRule({ kind: "cron", expression })} />
            : <Input testID="schedule-time" value={draft.rule.time} editable={!locked} placeholder="HH:mm" keyboardType="numbers-and-punctuation"
              onChangeText={(time) => changeRule(draft.rule.kind === "weekly" ? { ...draft.rule, time } : { kind: "daily", time })} />}
          {draft.rule.kind === "cron" && <Text className="text-xs text-muted-foreground">{t("分 时 日 月 星期")}</Text>}
        </View>
        {draft.rule.kind === "weekly" && <View className="flex-row flex-wrap gap-2 border-b border-border px-4 py-3">{WEEKDAYS.map((day, index) => {
          const weekday = index + 1;
          const selected = draft.rule.kind === "weekly" && draft.rule.weekdays.includes(weekday);
          return <Button key={day} testID={`schedule-weekday-${weekday}`} variant="outline" size="sm" disabled={locked}
            accessibilityRole="checkbox" accessibilityState={{ checked: selected }} className={cn("rounded-full", selected && "border-foreground bg-muted")}
            onPress={() => { if (draft.rule.kind !== "weekly") return; changeRule({ ...draft.rule, weekdays: selected ? draft.rule.weekdays.filter((n) => n !== weekday) : [...draft.rule.weekdays, weekday].sort() }); }}>
            <Text>{t("周{day}", { day: t(day) })}</Text></Button>;
        })}</View>}
        <View className="gap-1 border-b border-border px-4 py-3"><Text>{t("时区")}</Text>
          <Input testID="schedule-timezone" value={draft.timezone} editable={!locked} autoCapitalize="none" placeholder={t("例如 Asia/Shanghai")}
            onChangeText={(timezone) => change({ ...draft, timezone })} />
          <Text className="text-xs text-muted-foreground">{t("使用 IANA 时区，默认电脑时区，自动处理夏令时。")}</Text></View>
        <View className="min-h-[52px] flex-row items-center justify-between px-4"><Text>{t("启用")}</Text>
          <Switch testID="schedule-enabled" value={draft.enabled} disabled={locked}
            trackColor={{ false: String(muted ?? "#F0F0ED"), true: String(foreground ?? "#141414") }}
            thumbColor={String(draft.enabled ? background ?? "#FAFAFA" : mutedForeground ?? "#737373")} onValueChange={(enabled) => change({ ...draft, enabled })} />
        </View>
      </View>
      {detail && <Text testID="schedule-next" className="mx-8 mt-3 text-sm text-muted-foreground">{scheduleNext(detail)}</Text>}
      {saveError ? <Text testID="schedule-save-error" className="mx-6 mt-3 text-sm text-destructive">{t(saveError)}{createUnknown ? t("。结果未确认，请重试本次操作；确认前不能修改或退出。") : ""}</Text> : null}
      {id && <>
        <Text className="mx-8 mt-6 mb-2 text-xs text-muted-foreground">{t("最近运行")}</Text>
        <View className="mx-4 overflow-hidden rounded-xl border border-border bg-card">
          {runs.map((run) => {
            const linked = run.conversation_id && !session.isDeleted(run.conversation_id) ? run.conversation_id : null;
            return <Pressable key={run.id} testID={`schedule-run-${run.id}`} accessibilityRole={linked ? "button" : undefined}
              disabled={!linked || locked} onPress={() => { if (linked && !locked) router.push({ pathname: "/c/[id]", params: { id: linked } }); }}
              className="min-h-[60px] flex-row items-center justify-between gap-3 border-b border-border px-4 py-2">
              <View className="min-w-0 flex-1"><Text numberOfLines={1}>{scheduleTime(run.scheduled_at, detail?.timezone ?? draft.timezone)}</Text>
                {run.status === "missed" && run.missed_before != null ? <Text className="text-xs text-muted-foreground">{t("未运行区间截至 {time}", { time: scheduleTime(run.missed_before, detail?.timezone ?? draft.timezone) })}</Text> : null}
                {run.reason ? <Text className="text-xs text-muted-foreground" numberOfLines={2}>{t(run.reason)}</Text> : null}</View>
              <View className="items-end"><Text className="text-sm text-muted-foreground">{scheduleRunLabel(run)}</Text>
                {run.status !== "missed" && !linked ? <Text className="text-xs text-muted-foreground">{t("对话已删除")}</Text> : null}</View>
              {linked && <Icon as={ChevronRight} className="size-4 text-muted-foreground" />}
            </Pressable>;
          })}
          {runsLoading && !runs.length ? <Text className="p-4 text-sm text-muted-foreground">{t("正在加载运行记录…")}</Text> : null}
          {!runsLoading && !runs.length && !runsError ? <Text className="p-4 text-sm text-muted-foreground">{t("暂无运行记录")}</Text> : null}
          {runsError ? <View className="gap-2 p-4"><Text className="text-sm text-destructive">{t("无法加载运行记录：{error}", { error: t(runsError) })}</Text>
            <Button variant="outline" onPress={() => setRunsRetry((n) => n + 1)}><Text>{t("重试")}</Text></Button></View> : null}
          {!runsComplete && !!runs.length && <Button testID="schedule-runs-more" variant="ghost" disabled={runsLoading} onPress={() => void loadMore()}><Text>{runsLoading ? t("加载中…") : t("加载更多")}</Text></Button>}
        </View>
        <Button testID="schedule-delete" variant="ghost" className="mt-6 self-center" disabled={saving || deleting || session.connection !== "open"} onPress={() => setDeleteOpen(true)}>
          <Text className="text-destructive">{t("删除定时")}</Text></Button>
      </>}
    </KeyboardAwareScrollView>}
    <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!deleting) setDeleteOpen(open); }}>
      <AlertDialogContent overlayClassName="justify-end p-0" className="w-full rounded-b-none rounded-t-[24px] border-border bg-card" style={{ paddingBottom: insets.bottom + 20 }}>
        <AlertDialogHeader><AlertDialogTitle>{t("删除定时？")}</AlertDialogTitle>
          <AlertDialogDescription>{t("之后不再触发；已创建的对话仍会保留。")}</AlertDialogDescription></AlertDialogHeader>
        {deleteError ? <Text testID="schedule-delete-error" className="text-sm text-destructive">{t(deleteError)}</Text> : null}
        <AlertDialogFooter className="flex-col-reverse gap-2">
          <AlertDialogCancel disabled={deleting}><Text>{t("取消")}</Text></AlertDialogCancel>
          <Button testID="schedule-delete-confirm" variant="outline" disabled={deleting} onPress={() => void remove()}><Text className="text-destructive">{deleting ? t("删除中…") : t("删除")}</Text></Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </View>;
}
