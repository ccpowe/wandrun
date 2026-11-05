import { ChevronLeft, CircleAlert } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { GroupRow } from './group-row.tsx';
import { ListGroup } from './list-group.tsx';
import { LoadingState } from './loading-state.tsx';
import { ModelSubscription } from './model-subscription.tsx';
import { ScreenBar } from './screen-bar.tsx';
import { StatusBanner } from './status-banner.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Progress } from './ui/progress.tsx';
import { Text } from './ui/text.tsx';
import { WandrunAvatar } from './wandrun-avatar.tsx';
import type { AgentUsageView } from '../lib/agent-usage-view.ts';
import { useTranslation } from '../lib/i18n.ts';
import { agentTokens, formatTokens, type SubscriptionView } from '../lib/model-usage.ts';
import type { ModelSettingsSelection } from '../lib/settings-models.ts';

type Props = { selection: ModelSettingsSelection; banner: ReactNode; picker: ReactNode; offline: boolean;
  subscription: SubscriptionView; subscriptionLoaded: boolean; nowSeconds: number;
  defaultLabel?: string; settingsLoaded: boolean; settingsPending: boolean; usage: AgentUsageView;
  onBack(): void; onOpen(): void; onSave(): void };

export function SettingsModelsView({ selection, banner, picker, offline, subscription, subscriptionLoaded, nowSeconds, defaultLabel,
  settingsLoaded, settingsPending, usage, onBack, onOpen, onSave }: Props) {
  const { t } = useTranslation();
  let maximum = 1;
  if (usage.kind === 'rows') for (const { item } of usage.rows) maximum = Math.max(maximum, agentTokens(item));
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t(selection.panel ? '默认模型' : '模型')} left={<Button testID={selection.panel ? 'settings-model-back' : 'settings-models-back'} intent="quiet" size="icon" accessibilityLabel={t('返回')} onPress={onBack}><Icon as={ChevronLeft} size={22} /></Button>}
      right={selection.panel ? <Button testID="settings-model-save" intent="quiet" disabled={!selection.canSave} accessibilityHint={offline ? t('连接后可用') : undefined} onPress={onSave}><Text>{selection.busy ? t('保存中…') : t('保存')}</Text></Button> : undefined} />
    {selection.error ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(selection.error)} /> : banner}
    {selection.panel ? picker : <ScrollView contentContainerClassName="pb-10">
      {subscriptionLoaded ? <ModelSubscription feedbackInBanner view={subscription} nowSeconds={nowSeconds} /> : <View className="h-24"><LoadingState /></View>}
      <ListGroup inset="content"><GroupRow testID="settings-model-default" title={t('新建 Agent 默认模型')} value={defaultLabel} disabled={!settingsLoaded} affordance="navigate" onPress={onOpen}
        trailing={!defaultLabel && settingsPending ? <View className="h-6 w-8"><LoadingState /></View> : undefined} /></ListGroup>
      <ListGroup label={t('最近 7 天用量（按 Agent）')} inset="content">
        <View testID="settings-usage">
          {usage.kind === 'rows' ? usage.rows.map(({ item, agent }) => <View key={item.agent_id} testID={`settings-usage-${item.agent_id}`} className="gap-2 px-4 py-3">
            <View className="flex-row items-center gap-3">
              <WandrunAvatar index={agent.avatar} alt={agent.name} size={28} />
              <Text variant="body" className="min-w-0 flex-1" numberOfLines={1}>{agent.name}</Text>
              <Text variant="caption" className="text-muted-foreground">{formatTokens(agentTokens(item))} tokens</Text>
            </View>
            <Progress accessibilityLabel={agent.name} value={agentTokens(item) / maximum * 100} />
          </View>) : usage.kind === 'loading-agents' || usage.kind === 'loading-usage' ? <View className="h-16"><LoadingState /></View>
            : <Text variant="caption" className="px-4 py-4 text-muted-foreground">{usage.kind === 'no-agents' ? t('还没有 Agent') : usage.kind === 'no-usage' ? t('最近 7 天暂无用量') : t('暂不可用')}</Text>}
        </View>
      </ListGroup>
    </ScrollView>}
  </View>;
}
