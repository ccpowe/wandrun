import { ChevronLeft, Search } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ListGroup } from './list-group.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { EnvironmentReadNotice, EnvironmentRow } from './server-environment-row.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Input } from './ui/input.tsx';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs.tsx';
import { Text } from './ui/text.tsx';
import { useTranslation } from '../lib/i18n.ts';
import { ENVIRONMENT_FILTERS, environmentFilterLabel, parseEnvironmentFilter, type EnvironmentFilter, type ServerEnvironmentRow } from '../lib/server-environments.ts';

type Props = { banner: ReactNode; rows: ServerEnvironmentRow[]; loaded: boolean; error: string; query: string; filter: EnvironmentFilter;
  onQuery(query: string): void; onFilter(filter: EnvironmentFilter): void; onRetry(): void; onBack(): void };

/** settings-computer E: full execution environment list with search and state filter; rows are read-only. */
export function SettingsComputerEnvironmentsView({ banner, rows, loaded, error, query, filter, onQuery, onFilter, onRetry, onBack }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t('执行环境')} left={<Button testID="server-envs-back" intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>} />
    {banner}
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 12, paddingBottom: insets.bottom + 32 }}>
      <View className="mx-4 mb-4 flex-row items-center rounded-full bg-card pl-4">
        <Icon as={Search} size={20} className="text-muted-foreground" />
        <Input accessibilityLabel={t('搜索执行环境')} placeholder={t('搜索执行环境')} value={query} onChangeText={onQuery}
          autoCorrect={false} autoCapitalize="none" className="flex-1 rounded-full" />
      </View>
      <Tabs value={filter} onValueChange={value => onFilter(parseEnvironmentFilter(value))} className="mx-4">
        <TabsList>{ENVIRONMENT_FILTERS.map(value => <TabsTrigger key={value} value={value}><Text>{environmentFilterLabel(value)}</Text></TabsTrigger>)}</TabsList>
      </Tabs>
      <EnvironmentReadNotice loaded={loaded} error={error} onRetry={onRetry} />
      {rows.length ? <ListGroup label={t('{count} 个', { count: rows.length })}>{rows.map(row => <EnvironmentRow key={row.id} row={row} />)}</ListGroup>
        : <View testID="server-envs-empty" className="mx-4 mt-6 items-center gap-4 rounded-lg bg-card px-6 py-12"><Icon as={Search} className="text-muted-foreground" />
          <Text variant="caption" className="text-muted-foreground">{t('没有匹配的执行环境')}</Text></View>}
    </ScrollView>
  </View>;
}
