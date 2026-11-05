import { Cable, ChevronLeft, ChevronRight, Cpu, Moon, Sparkles, UserRound, WifiOff, X, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroupRow } from './group-row.tsx';
import { ListGroup } from './list-group.tsx';
import { LoadingState } from './loading-state.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Text } from './ui/text.tsx';
import { useTranslation } from '../lib/i18n.ts';
import type { SettingsSummary } from '../lib/settings-summary.ts';

export type SettingsEntry = 'models' | 'skills' | 'connectors' | 'about-you' | 'appearance';
export type SettingsEntryValue = { summary?: SettingsSummary; pending?: boolean };
type Props = { serverCards: ReactNode; message: string; stale: boolean; disabled: boolean;
  /** Set only for this page's own operation result (switch failure); live connection / read messages have no close. */
  onDismissMessage?(): void;
  entries: Record<SettingsEntry, SettingsEntryValue>; onBack(): void; onOpen(entry: SettingsEntry): void };
const agentEntries: { id: Exclude<SettingsEntry, 'appearance'>; icon: LucideIcon; title: string }[] = [
  { id: 'models', icon: Cpu, title: '模型' }, { id: 'skills', icon: Sparkles, title: '技能' },
  { id: 'connectors', icon: Cable, title: '连接器' }, { id: 'about-you', icon: UserRound, title: '关于你' },
];

export function SettingsView({ serverCards, message, stale, disabled, onDismissMessage, entries, onBack, onOpen }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar left={<Button testID="settings-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {message ? <StatusBanner icon={WifiOff} accessibilityRole="alert" title={t(message)} description={stale ? t('内容可能不是最新的') : undefined}
      action={onDismissMessage ? { icon: X, label: t('关闭提示'), onPress: onDismissMessage, testID: 'settings-message-dismiss' } : undefined} /> : null}
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
      <Text className="px-5 pb-4 pt-1 text-title font-semibold">{t('设置')}</Text>
      {serverCards}
      <ListGroup label={t('Agent')}>
        {agentEntries.map(({ id, icon, title }) => <SettingsRow key={id} testID={`settings-${id}`} title={t(title)} icon={icon} {...entries[id]} disabled={disabled} onPress={() => onOpen(id)} />)}
      </ListGroup>
      <ListGroup label={t('App')}><SettingsRow testID="settings-appearance" title={t('外观')} icon={Moon} {...entries.appearance} onPress={() => onOpen('appearance')} /></ListGroup>
    </ScrollView>
  </View>;
}
function SettingsRow({ testID, icon, title, summary, pending, disabled, onPress }: SettingsEntryValue & {
  testID: string; icon: LucideIcon; title: string; disabled?: boolean; onPress(): void;
}) {
  const { t } = useTranslation();
  const danger = !disabled && summary?.danger;
  return <GroupRow testID={testID} title={title} icon={icon} disabled={disabled} affordance={disabled ? 'none' : 'navigate'} alert={danger}
    trailing={<View className="max-w-[48%] flex-row items-center gap-2">
      {!disabled && !summary && pending ? <View className="h-6 w-8"><LoadingState /></View>
        : <Text variant="caption" numberOfLines={1} className={`min-w-0 shrink text-right ${danger ? 'text-destructive' : 'text-muted-foreground'}`}>{disabled ? t('连接后可用') : summary?.text ?? t('暂不可用')}</Text>}
      {!disabled ? <Icon as={ChevronRight} size={16} className="text-muted-foreground/60" /> : null}
    </View>} onPress={onPress} />;
}
