import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert } from 'lucide-react-native';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Schedule, ScheduleRule, ScheduleRun } from '@/gateway/api.ts';
import type { ScheduleEditorSelection } from '@/lib/schedule-editor.ts';
import { scheduleNext, scheduleRunLabel, scheduleTime, type ScheduleDraft } from '@/lib/schedules.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useDelayedNotice } from '@/lib/use-delayed-notice.ts';
import { ListGroup } from './list-group.tsx';
import { LoadingState } from './loading-state.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Input } from './ui/input.tsx';
import { Switch } from './ui/switch.tsx';
import { SurfacePressable } from './ui/surface-pressable.tsx';
import { Text } from './ui/text.tsx';

export type ScheduleRunRow = ScheduleRun & { linkedConversation: string | null };
export function ScheduleEditorView({ selection: s, detail, offline, feedback, readFailure, connectionBanner, runs, runsLoading, runsLoaded, runsError, hasMore,
  onBack, onSave, onChange, onDialog, onReload, onDelete, onMore, onConversation }: {
  selection: ScheduleEditorSelection; detail?: Schedule; offline: boolean; feedback: string; readFailure: string | null; connectionBanner?: ReactNode;
  runs: ScheduleRunRow[]; runsLoading: boolean; runsLoaded: boolean; runsError: boolean; hasMore: boolean;
  onBack: () => void; onSave: () => void; onChange: (draft: ScheduleDraft) => void; onDialog: (dialog: 'reload' | 'delete' | null) => void;
  onReload: () => void; onDelete: () => void; onMore: () => void; onConversation: (id: string) => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const draft = s.draft;
  const persistentFeedback = readFailure || s.phase === 'unknown';
  const showPersistent = useDelayedNotice(persistentFeedback ? `${detail?.id ?? 'schedule'}:${s.phase === 'unknown' ? 'unknown' : readFailure}` : null);
  const changeRule = (rule: ScheduleRule) => { if (draft) onChange({ ...draft, rule }); };
  return <View className="flex-1 bg-background">
    <ScreenBar title={t('编辑定时')} left={<Button testID="schedule-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} disabled={!s.canBack} onPress={onBack}><Icon as={ChevronLeft} /></Button>}
      right={<Button testID="schedule-save" intent="quiet" disabled={!s.canSave} onPress={onSave}><Text>{s.busyAction ? t(({ saving: '保存中…', deleting: '删除中…', reloading: '加载中…' })[s.busyAction]) : t('保存')}</Text></Button>} />
    {connectionBanner}
    {!offline && feedback && (!persistentFeedback || showPersistent) ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(feedback)} description={readFailure && draft ? t('内容可能不是最新的') : undefined} /> : null}
    {!draft && s.phase === 'loading' ? <LoadingState /> : null}
    {draft ? <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {s.externalChange ? <View className="mx-4 mt-4 gap-3"><Text variant="caption">{t('定时已在别处更新，当前草稿未被覆盖。')}</Text>
        <Button testID="schedule-reload" intent="soft" disabled={!s.canSave} onPress={() => onDialog('reload')}><Text>{t('重新载入并舍弃草稿')}</Text></Button></View> : null}
      <View className="gap-5 px-4 pt-4">
        <View className="gap-2"><Text variant="caption" className="text-muted-foreground">{t('名称')}</Text><Input testID="schedule-name" value={draft.name} editable={s.canEdit} placeholder={t('例如每日新闻简报')} onChangeText={name => onChange({ ...draft, name })} /></View>
        <View className="gap-2"><Text variant="caption" className="text-muted-foreground">{t('要做什么')}</Text><Input testID="schedule-content" multiline textAlignVertical="top" className="min-h-24" value={draft.content} editable={s.canEdit} placeholder={t('写下定时触发后交给 Agent 的完整任务说明')} onChangeText={content => onChange({ ...draft, content })} /></View>
      </View>
      <ListGroup inset="content">
        <View className="gap-2 p-4"><Text variant="body">{t('重复')}</Text><View className="flex-row flex-wrap gap-2">{(['once', 'daily', 'weekly', 'cron'] as const).map(kind => <Button key={kind} testID={`schedule-kind-${kind}`} intent={draft.rule.kind === kind ? 'primary' : 'soft'} size="sm" disabled={!s.canEdit} accessibilityRole="radio" accessibilityState={{ selected: draft.rule.kind === kind }} onPress={() => {
          if (kind === draft.rule.kind) return;
          changeRule(kind === 'once' ? { kind, local_at: '' } : kind === 'daily' ? { kind, time: '08:00' } : kind === 'weekly' ? { kind, time: '08:00', weekdays: [1] } : { kind, expression: '0 8 * * *' });
        }}><Text>{t(({ once: '单次', daily: '每天', weekly: '每周', cron: 'Cron' })[kind])}</Text></Button>)}</View></View>
        <View className="gap-2 p-4"><Text variant="body">{draft.rule.kind === 'once' ? t('日期与时间') : draft.rule.kind === 'cron' ? t('五段 Cron 表达式') : t('时间')}</Text>
          {draft.rule.kind === 'once' ? <Input tone="muted" testID="schedule-local-at" value={draft.rule.local_at} editable={s.canEdit} placeholder="YYYY-MM-DDTHH:mm" autoCapitalize="none" onChangeText={local_at => changeRule({ kind: 'once', local_at })} />
            : draft.rule.kind === 'cron' ? <Input tone="muted" testID="schedule-cron" value={draft.rule.expression} editable={s.canEdit} placeholder="0 8 * * *" autoCapitalize="none" onChangeText={expression => changeRule({ kind: 'cron', expression })} />
              : <Input tone="muted" testID="schedule-time" value={draft.rule.time} editable={s.canEdit} placeholder="HH:mm" keyboardType="numbers-and-punctuation" onChangeText={time => changeRule(draft.rule.kind === 'weekly' ? { ...draft.rule, time } : { kind: 'daily', time })} />}
          {draft.rule.kind === 'cron' ? <Text variant="caption" className="text-muted-foreground">{t('分 时 日 月 星期')}</Text> : null}
        </View>
        {draft.rule.kind === 'weekly' ? <View className="flex-row flex-wrap gap-2 p-4">{['一', '二', '三', '四', '五', '六', '日'].map((day, index) => {
          const weekday = index + 1;
          const selected = draft.rule.kind === 'weekly' && draft.rule.weekdays.includes(weekday);
          return <Button key={day} testID={`schedule-weekday-${weekday}`} intent={selected ? 'primary' : 'soft'} size="sm" disabled={!s.canEdit} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => {
            if (draft.rule.kind === 'weekly') changeRule({ ...draft.rule, weekdays: selected ? draft.rule.weekdays.filter(n => n !== weekday) : [...draft.rule.weekdays, weekday].sort() });
          }}><Text>{t('周{day}', { day: t(day) })}</Text></Button>;
        })}</View> : null}
        <View className="gap-2 p-4"><Text variant="body">{t('时区')}</Text><Input tone="muted" testID="schedule-timezone" value={draft.timezone} editable={s.canEdit} autoCapitalize="none" placeholder={t('例如 Asia/Shanghai')} onChangeText={timezone => onChange({ ...draft, timezone })} />
          <Text variant="caption" className="text-muted-foreground">{t('使用 IANA 时区，默认服务器时区，自动处理夏令时。')}</Text></View>
        <View className="min-h-12 flex-row items-center justify-between px-4"><Text variant="body">{t('启用')}</Text><Switch testID="schedule-enabled" checked={draft.enabled} disabled={!s.canEdit || detail?.ended === true && detail.rule.kind === 'once'} onCheckedChange={enabled => onChange({ ...draft, enabled })} /></View>
      </ListGroup>
      {detail ? <Text testID="schedule-next" variant="caption" className="mx-8 mt-3 text-muted-foreground">{scheduleNext(detail)}</Text> : null}
      <ListGroup label={t('最近运行')} inset="content">
        {runs.map(run => <SurfacePressable key={run.id} testID={`schedule-run-${run.id}`} accessibilityRole={run.linkedConversation ? 'button' : undefined} disabled={!run.linkedConversation || !s.canBack} onPress={() => { if (run.linkedConversation) onConversation(run.linkedConversation); }} className="min-h-16 flex-row items-center gap-3 px-4 py-3">
          <View className="min-w-0 flex-1"><Text variant="body" numberOfLines={1}>{scheduleTime(run.scheduled_at, detail?.timezone ?? draft.timezone)}</Text>
            {run.status === 'missed' && run.missed_before != null ? <Text variant="caption" className="text-muted-foreground">{t('未运行区间截至 {time}', { time: scheduleTime(run.missed_before, detail?.timezone ?? draft.timezone) })}</Text> : null}
            {run.reason ? <Text variant="caption" className="text-muted-foreground" numberOfLines={2}>{t(run.reason)}</Text> : null}</View>
          <View className="items-end"><Text variant="caption" className="text-muted-foreground">{scheduleRunLabel(run)}</Text>{!run.linkedConversation ? <Text variant="caption" className="text-muted-foreground">{t('没有可打开的对话')}</Text> : null}</View>
          {run.linkedConversation ? <Icon as={ChevronRight} className="size-4 text-muted-foreground" /> : null}
        </SurfacePressable>)}
        {!runsLoaded && !runs.length && !runsError ? <View className="h-16"><LoadingState /></View> : null}
        {runsLoaded && !runs.length && !runsError ? <Text variant="caption" className="p-4 text-muted-foreground">{t('暂无运行记录')}</Text> : null}
        {hasMore && runs.length ? <Button testID="schedule-runs-more" intent="quiet" disabled={runsLoading} onPress={onMore}><Text>{runsLoading ? t('加载中…') : t('加载更多')}</Text></Button> : null}
      </ListGroup>
      <Button testID="schedule-delete" intent="destructive" className="mt-6 self-center" disabled={!s.canDelete} onPress={() => onDialog('delete')}><Text>{t('删除定时')}</Text></Button>
    </KeyboardAwareScrollView> : null}
    <AlertDialog open={s.dialog === 'reload'} onOpenChange={open => { if (!open) onDialog(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t('重新载入并舍弃草稿？')}</AlertDialogTitle><AlertDialogDescription>{t('当前未保存的修改会被服务器上的最新内容替换。')}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogCancel><Text>{t('继续编辑')}</Text></AlertDialogCancel><Button testID="schedule-reload-confirm" intent="soft" disabled={!s.canSave} onPress={onReload}><Text>{t('重新载入')}</Text></Button>
    </AlertDialogContent></AlertDialog>
    <AlertDialog open={s.dialog === 'delete'} onOpenChange={open => { if (!open && !s.busy) onDialog(null); }}><AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{t('删除定时？')}</AlertDialogTitle><AlertDialogDescription>{t('之后不再触发；已创建的对话仍会保留。')}</AlertDialogDescription></AlertDialogHeader>
      {s.deleteError ? <Text testID="schedule-delete-error" variant="caption" className="text-destructive">{t(s.deleteError)}</Text> : null}
      <AlertDialogFooter><AlertDialogCancel disabled={s.busy}><Text>{t('取消')}</Text></AlertDialogCancel><Button testID="schedule-delete-confirm" intent="destructive" disabled={!s.canDelete} onPress={onDelete}><Text>{s.busy ? t('删除中…') : t('删除')}</Text></Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </View>;
}
