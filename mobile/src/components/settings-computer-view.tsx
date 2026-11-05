import { ChevronLeft, ChevronRight, Monitor, Server, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroupRow } from './group-row.tsx';
import { ListGroup } from './list-group.tsx';
import { ListRow, RowSubtitle } from './list-row.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { EnvironmentDot, EnvironmentReadNotice, EnvironmentRow } from './server-environment-row.tsx';
import { SwipeRow } from './swipe-row.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Progress } from './ui/progress.tsx';
import { Text } from './ui/text.tsx';
import type { ComputerStatus } from '../gateway/api.ts';
import { browserPageLabel, browserStateLabel, localBrowserCapacity, type ActiveBrowserPage, type BrowserPageGroup } from '../lib/browser-tasks.ts';
import { t, useTranslation } from '../lib/i18n.ts';
import type { ServerEnvironmentRow } from '../lib/server-environments.ts';

export type ServerEnvironmentsSnapshot = { shown: ServerEnvironmentRow[]; total: number; hiddenPaused: number; loaded: boolean; error: string };

type Props = { status: ComputerStatus | null; online: boolean; banner: ReactNode; resourceError?: string | null; browserError: string | null;
  browserLoading: boolean; groups: BrowserPageGroup[]; closeDisabledIds: ReadonlySet<string>; closeBlockedReasons: ReadonlyMap<string, string>; closeUnknown: boolean; closeError: string;
  environments: ServerEnvironmentsSnapshot; onRetryEnvironments(): void; onOpenPausedEnvironments(): void;
  onBack(): void; onRefreshBrowser(): void; onClose(taskId: string): void; onOpen(page: ActiveBrowserPage): void };
export function SettingsComputerView({ status, online, banner, resourceError, browserError, browserLoading, groups, closeDisabledIds, closeBlockedReasons, closeUnknown, closeError,
  environments, onRetryEnvironments, onOpenPausedEnvironments, onBack, onRefreshBrowser, onClose, onOpen }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t('服务器')} left={<Button testID="settings-computer-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {banner}
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
      <ComputerResources status={status} online={online} />
      {resourceError ? <Text testID="settings-computer-resource-error" variant="caption" className="mx-8 mt-2 text-destructive">{t("无法更新服务器状态：{error}", { error: t(resourceError) })}</Text> : null}
      <ListGroup label={t('执行环境 · {count}', { count: environments.total })}>
        {environments.shown.map(row => <EnvironmentRow key={row.id} row={row} />)}
        {environments.hiddenPaused ? <GroupRow testID="server-env-paused-summary" title={t('另有 {count} 个已暂停', { count: environments.hiddenPaused })}
          leading={<EnvironmentDot state="paused" />} affordance="navigate" onPress={onOpenPausedEnvironments} /> : null}
      </ListGroup>
      <EnvironmentReadNotice loaded={environments.loaded} error={environments.error} onRetry={onRetryEnvironments} />
      {browserError ? <View className="mx-8 mt-3 gap-2"><Text testID="settings-computer-pages-error" variant="caption" className="text-destructive">{t('无法更新浏览器页面：{error}', { error: t(browserError) })}</Text>
        <Button intent="soft" className="self-start" onPress={onRefreshBrowser}><Text>{t('重试')}</Text></Button></View> : null}
      {closeError ? <Text testID="settings-computer-close-error" variant="caption" className="mx-8 mt-3 text-destructive">{closeUnknown ? t(closeError) : t('关闭失败：{error}', { error: t(closeError) })}</Text> : null}
      {groups.map(group => <ListGroup key={group.agentId} label={`${group.agentName} · ${group.pages.length}`}>
        {group.pages.map(item => <SwipeRow key={`${item.task.id}:${item.page.id}`} contentClassName="bg-card"
          action={{ label: t('关闭此任务的全部浏览器页面'), icon: X, disabled: closeDisabledIds.has(item.task.id) || !online, onPress: () => onClose(item.task.id) }}>
          <ListRow testID={`settings-computer-page-${item.task.id}-${item.page.id}`}
            leading={<View className="size-9 items-center justify-center rounded-md bg-muted"><Icon as={Monitor} size={18} /></View>}
            title={browserPageLabel(item.page)} subtitle={<RowSubtitle text={t(closeBlockedReasons.get(item.task.id) ?? `${item.task.conversation_title} · ${browserStateLabel(item.task.state)}`)} />}
            alert={item.task.state === 'requested'} trailing={<Icon as={ChevronRight} size={16} className="text-muted-foreground/60" />} onPress={() => onOpen(item)} />
        </SwipeRow>)}
      </ListGroup>)}
      {/* B1: each environment row already shows its page count, so an empty directory renders nothing here. */}
      {!groups.length && !browserError && browserLoading ? <Text variant="caption" className="pt-12 text-center text-muted-foreground">{t('正在加载浏览器页面…')}</Text> : null}
    </ScrollView>
  </View>;
}
function ComputerResources({ status, online }: { status: ComputerStatus | null; online: boolean }) {
  const browser = localBrowserCapacity(status);
  const hours = Math.floor((status?.uptime_seconds ?? 0) / 3600);
  const minutes = Math.floor((status?.uptime_seconds ?? 0) / 60);
  const uptime = hours >= 24 ? t("服务器已运行 {days} 天 {hours} 小时", { days: Math.floor(hours / 24), hours: hours % 24 })
    : hours ? t("服务器已运行 {hours} 小时", { hours }) : minutes ? t("服务器已运行 {minutes} 分钟", { minutes }) : t("服务器刚刚启动");
  return <ListGroup inset="content">
    <View className="flex-row items-center gap-3 px-4 py-4"><Icon as={Server} size={28} />
      <View className="min-w-0 flex-1 gap-1"><Text variant="body" numberOfLines={1}>{status?.name ?? t('服务器')}</Text>
        <Text variant="caption" className="text-muted-foreground">{!online ? t('状态暂不可用') : status ? t('在线 · {uptime}', { uptime }) : t("正在读取服务器状态…")}</Text></View>
    </View>
    <ResourceMeter testID="settings-computer-cpu" label="CPU" percent={status?.cpu_percent ?? null} value={status?.cpu_percent == null ? t('暂不可用') : `${Math.round(status.cpu_percent)}%`} />
    <ResourceMeter testID="settings-computer-memory" label={t('内存')} percent={status?.memory.percent ?? null} value={status ? `${(status.memory.used_bytes / 1024 ** 3).toFixed(1)} / ${(status.memory.total_bytes / 1024 ** 3).toFixed(1)} GB` : t('暂不可用')} />
    <ResourceMeter testID="settings-computer-pages" label={t('浏览器页面')} percent={browser && browser.pages_limit > 0 ? browser.pages_used / browser.pages_limit * 100 : null} value={browser ? `${browser.pages_used} / ${browser.pages_limit}` : t('暂不可用')} />
  </ListGroup>;
}
function ResourceMeter({ testID, label, value, percent }: { testID: string; label: string; value: string; percent: number | null }) {
  return <View testID={testID} className="px-4 py-3"><View className="flex-row items-center justify-between gap-3"><Text variant="body">{label}</Text><Text variant="caption" className="text-muted-foreground">{value}</Text></View>
    {percent !== null ? <Progress accessibilityLabel={label} value={Math.max(0, Math.min(100, percent))} className="mt-2" />
      : <View className="mt-2 h-2 rounded-full bg-muted" />}
  </View>;
}
