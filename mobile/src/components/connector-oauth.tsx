import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import type { Connector } from '@/gateway/api';
import type { AuthorizationFlow } from '@/lib/connector-authorization';
import { useTranslation } from '@/lib/i18n';

export type ConnectorAuthorizationSelection = {
  flow?: AuthorizationFlow; waiting: boolean; busy: boolean; canReopen: boolean; callback: string; error: string; notice: string;
};
export function ConnectorOAuthView({ connector, selection, disabled, onStart, onReopen, onCallback, onSubmit, onCancel }: {
  connector: Connector; selection: ConnectorAuthorizationSelection; disabled: boolean;
  onStart: () => void; onReopen: () => void; onCallback: (value: string) => void; onSubmit: () => void; onCancel: () => void;
}) {
  const { t, locale } = useTranslation();
  const flow = selection.flow?.value;
  const error = selection.error || (connector.auth.error?.code === 'oauth_expired' ? '本次授权已过期，请重新发起授权。'
    : connector.auth.error?.code === 'oauth_denied' ? '未同意服务方授权，请重新发起。' : connector.auth.error ? 'OAuth 服务暂不可用，请稍后重试。' : '');
  if (connector.status === 'connected' && connector.auth.status === 'authorized' && !selection.waiting && !error) return null;
  return <View className="mx-4 gap-4">
    {selection.waiting ? <View className="items-center gap-4 rounded-lg bg-card px-4 py-6">
      {flow?.flow === 'device_code' ? <><Text variant="caption" className="text-muted-foreground">{t('GitHub 短码')}</Text>
        <Text testID="oauth-user-code" selectable className="text-title font-mono tracking-widest">{flow.user_code}</Text>
        <Text variant="caption" className="text-muted-foreground">{t('验证码有效至 {time}', { time: new Date(flow.expires_at * 1000).toLocaleTimeString(locale) })}</Text>
        <Text variant="body">{t('等待 GitHub 授权')}</Text></>
        : <><ActivityIndicator /><Text variant="body">{t(flow ? '正在浏览器中授权…' : '正在等待授权…')}</Text></>}
      {!flow ? <Text variant="caption" className="text-muted-foreground">{t('授权链接或短码仅在发起设备显示，请重新发起授权')}</Text> : null}
    </View> : null}
    {connector.app_id === 'github' ? <Text variant="caption" className="leading-5 text-muted-foreground">{t('GitHub 的 repo 授权范围包含私有仓库的读取和写入，并非只读。令牌仅保存在网关；不会自动授予任何 Agent 使用权限。')}</Text> : null}
    {selection.notice ? <Text accessibilityLiveRegion="polite" variant="caption" className="text-muted-foreground">{t(selection.notice)}</Text> : null}
    {error ? <Text accessibilityRole="alert" variant="caption" className="leading-5 text-destructive">{t(error)}</Text> : null}
    {flow ? <Button intent="soft" disabled={selection.busy || !selection.canReopen} onPress={onReopen}><Text>{t(flow.flow === 'device_code' ? '复制短码并打开 GitHub' : '重新打开授权链接')}</Text></Button>
      : <Button intent={connector.auth.status === 'authorized' && connector.status !== 'connected' ? 'soft' : undefined} disabled={disabled} testID="oauth-start" onPress={onStart}><Text>{t(connector.auth.status === 'authorized' ? '重新授权' : '连接')}</Text></Button>}
    {flow?.flow === 'authorization_code' && flow.manual_callback ? <>
      <Input testID="oauth-callback-url" accessibilityLabel={t('完整回调网址')} value={selection.callback} editable={!disabled} onChangeText={onCallback} placeholder={t('粘贴完整回调网址')} autoCapitalize="none" autoCorrect={false} />
      <Button intent="soft" disabled={disabled || !selection.callback.trim()} onPress={onSubmit}><Text>{t('提交回调网址')}</Text></Button>
    </> : null}
    {selection.waiting ? <Button intent="quiet" disabled={disabled} onPress={onCancel}><Text>{t('取消授权')}</Text></Button> : null}
  </View>;
}
