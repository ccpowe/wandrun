import type { ReactNode } from 'react';
import { ChevronLeft, CircleAlert, Plus, Search } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectorIcon } from '@/components/connector-icon';
import { GroupRow } from '@/components/group-row';
import { ListGroup } from '@/components/list-group';
import { LoadingState } from '@/components/loading-state';
import { ScreenBar } from '@/components/screen-bar';
import { StatusBanner } from '@/components/status-banner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Text } from '@/components/ui/text';
import { connectorListRowState, type ConnectorHomeSelection, type ConnectorHomeState } from '@/lib/connector-list-state';
import { useTranslation } from '@/lib/i18n';
import { useDelayedNotice } from '@/lib/use-delayed-notice';

export function ConnectorHomeView({ selection, connectionBanner, onBack, onAdd, onTab, onSearch, onConnector, onCatalog }: {
  selection: ConnectorHomeSelection; connectionBanner?: ReactNode;
  onBack: () => void; onAdd: () => void; onTab: (tab: ConnectorHomeState['tab']) => void;
  onSearch: (query: string) => void; onConnector: (id: string) => void; onCatalog: (id: string) => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const showReadError = useDelayedNotice(selection.readFailed ? selection.tab : null);
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t('连接器')}
      left={<Button intent="quiet" size="icon" accessibilityLabel={t('返回设置')} onPress={onBack}><Icon as={ChevronLeft} /></Button>}
      right={<Button intent="quiet" size="icon" testID="connectors-add" accessibilityLabel={t('添加连接器')} onPress={onAdd}><Icon as={Plus} /></Button>} />
    {connectionBanner}
    {selection.readFailed && showReadError ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t('无法加载连接器，正在重试…')}
      description={selection.stale ? t('内容可能不是最新的') : undefined} /> : null}
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: 12, paddingBottom: insets.bottom + 24 }}>
      <View className="mx-4 mb-4 flex-row items-center rounded-full bg-card pl-4">
        <Icon as={Search} size={20} className="text-muted-foreground" />
        <Input accessibilityLabel={t('搜索连接器')} placeholder={t('搜索连接器')} value={selection.query} onChangeText={onSearch}
          autoCorrect={false} className="flex-1 rounded-full" />
      </View>
      <Tabs value={selection.tab} onValueChange={value => { if (value === 'available' || value === 'added') onTab(value); }} className="mx-4">
        <TabsList><TabsTrigger value="available"><Text>{t('可用')}</Text></TabsTrigger><TabsTrigger value="added"><Text>{t('已添加')}</Text></TabsTrigger></TabsList>
      </Tabs>
      {selection.tab === 'available' ? <ListGroup label={t('可用')}>{selection.apps.map(app => <GroupRow key={app.id} testID={`catalog-${app.id}`} title={app.name}
        description={app.description} leading={<ConnectorIcon name={app.name} appId={app.id} />}
        trailing={<Text variant="caption" className="text-muted-foreground">{t(app.connector ? '查看' : '连接')}</Text>} onPress={() => onCatalog(app.id)} />)}</ListGroup>
        : <ListGroup label={t('已添加')}>{selection.connectors.map(connector => {
          const summary = connectorListRowState(connector);
          return <GroupRow key={connector.id} testID={`connector-${connector.id}`} title={connector.name}
            description={t(summary.label, { count: connector.tool_count })} alert={summary.failed}
            leading={<ConnectorIcon name={connector.name} uri={connector.icon} appId={connector.app_id} />} affordance="navigate" onPress={() => onConnector(connector.id)} />;
        })}</ListGroup>}
      {selection.loading ? <View className="mt-8"><LoadingState /></View> : null}
      {selection.empty ? <View className="mx-4 mt-6 items-center gap-4 rounded-lg bg-card px-6 py-12"><Icon as={Search} className="text-muted-foreground" /><Text variant="caption" className="text-muted-foreground">{t(selection.emptyLabel)}</Text></View> : null}
    </ScrollView>
  </View>;
}
