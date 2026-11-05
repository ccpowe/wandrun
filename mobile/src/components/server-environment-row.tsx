import { View } from 'react-native';
import { GroupRow } from './group-row.tsx';
import { Button } from './ui/button.tsx';
import { Text } from './ui/text.tsx';
import { useTranslation } from '../lib/i18n.ts';
import { environmentStateLabel, environmentSubtitle, type EnvironmentState, type ServerEnvironmentRow } from '../lib/server-environments.ts';

// Green / yellow follow the server card's status dot exception in design.md (settings-computer C1).
const DOT: Record<EnvironmentState, string> = { local: 'bg-rich-success', running: 'bg-rich-success', starting: 'bg-rich-warning',
  paused: 'bg-muted-foreground/50', unavailable: 'bg-destructive' };

export function EnvironmentDot({ state }: { state: EnvironmentState }) {
  const { t } = useTranslation();
  return <View className="w-5 items-center"><View accessibilityLabel={environmentStateLabel(state) ?? t('本机')} className={`size-2 rounded-full ${DOT[state]}`} /></View>;
}

/** Read-only row: tapping does nothing (C1 / E2). */
export function EnvironmentRow({ row }: { row: ServerEnvironmentRow }) {
  const { t } = useTranslation();
  return <GroupRow testID={`server-env-${row.id}`} title={row.name} description={environmentSubtitle(row)}
    leading={<EnvironmentDot state={row.state} />} value={row.browserPages ? t('浏览器 {count}', { count: row.browserPages }) : undefined} />;
}

/** First read (C4) and failure (C5) share the browser section's caption + retry form. */
export function EnvironmentReadNotice({ loaded, error, onRetry }: { loaded: boolean; error: string; onRetry(): void }) {
  const { t } = useTranslation();
  if (error) return <View className="mx-8 mt-2 gap-2"><Text testID="server-envs-error" variant="caption" className="text-destructive">{t('无法更新执行环境：{error}', { error: t(error) })}</Text>
    <Button intent="soft" className="self-start" onPress={onRetry}><Text>{t('重试')}</Text></Button></View>;
  if (!loaded) return <Text testID="server-envs-loading" variant="caption" className="mx-8 mt-2 text-muted-foreground">{t('正在读取执行环境…')}</Text>;
  return null;
}
