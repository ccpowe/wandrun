import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectorHeader } from '@/components/connector-header';
import { ConnectorIcon } from '@/components/connector-icon';
import { GroupRow } from '@/components/group-row';
import { ListGroup } from '@/components/list-group';
import { LoadingState } from '@/components/loading-state';
import { ScreenBar } from '@/components/screen-bar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import type { AppEntry } from '@/gateway/api';
import { catalogConnectHint, connectorAuthMethodLabel, connectorUrlHost } from '@/lib/connector-list-state';
import { useTranslation } from '@/lib/i18n';

/**
 * Unbound catalog entry (connector-auth.AU1): same layout as the connector detail, with the
 * bottom action area in the detail's position so it does not move once the binding exists.
 * Only catalog fields are shown; tools, Agents and scopes do not exist before binding.
 */
export function ConnectorCatalogView({ entry, missing, loading, busy, canConnect, banner, onBack, onConnect }: {
  entry?: AppEntry; missing: boolean; loading: boolean; busy: boolean; canConnect: boolean; banner?: ReactNode;
  onBack: () => void; onConnect: () => void;
}) {
  const { t } = useTranslation(); const insets = useSafeAreaInsets();
  const hint = entry ? catalogConnectHint(entry.auth.type) : undefined;
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t('连接器')} left={<Button intent="quiet" size="icon" disabled={busy} accessibilityLabel={t('返回')} onPress={onBack}><Icon as={ChevronLeft} /></Button>} />
    {banner}
    <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
      {entry ? <>
        <ConnectorHeader icon={<ConnectorIcon name={entry.name} appId={entry.id} large />} name={entry.name} description={entry.description} status={t('未连接')} />
        <ListGroup label={t('详情')} inset="content">
          <GroupRow title={t('授权方式')} value={t(connectorAuthMethodLabel(entry.auth.type))} />
          <GroupRow title={t('来源')} value={t('连接器目录')} />
          <GroupRow title={t('服务地址')} value={connectorUrlHost(entry.url)} />
        </ListGroup>
      </> : missing ? <Text variant="body" className="mx-4 mt-6 text-center text-muted-foreground">{t('此应用已不在网关目录中')}</Text> : loading ? <LoadingState /> : null}
    </ScrollView>
    {entry && hint ? <View style={{ paddingBottom: insets.bottom }}><View className="gap-2 px-4 pb-4 pt-2">
      <Text variant="caption" className="text-center text-muted-foreground">{t(hint.text, { name: entry.name })}</Text>
      <Button disabled={!hint.enabled || !canConnect} onPress={onConnect}><Text>{t(busy ? '正在连接…' : '连接')}</Text></Button>
    </View></View> : null}
  </View>;
}
