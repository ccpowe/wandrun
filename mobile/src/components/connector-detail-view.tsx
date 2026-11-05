import type { ReactNode } from 'react';
import { ChevronLeft, CircleAlert, X } from 'lucide-react-native';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectorHeader } from '@/components/connector-header';
import { ConnectorIcon } from '@/components/connector-icon';
import { ConnectorKeyForm } from '@/components/connector-key-form';
import { ConnectorParameterForm } from '@/components/connector-parameter-form';
import { GroupRow } from '@/components/group-row';
import { ListGroup } from '@/components/list-group';
import { LoadingState } from '@/components/loading-state';
import { ScreenBar } from '@/components/screen-bar';
import { StatusBanner } from '@/components/status-banner';
import { WandrunAvatar } from '@/components/wandrun-avatar';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import type { Connector, ConnectorAgent, ConnectorTools } from '@/gateway/api';
import type { ConnectorParameterDraft } from '@/lib/connector-add';
import type { ConnectorDetailState } from '@/lib/connector-detail';
import { connectorAuthMethodLabel, connectorListRowState } from '@/lib/connector-list-state';
import { useTranslation } from '@/lib/i18n';
import { useDelayedNotice } from '@/lib/use-delayed-notice';

export function ConnectorDetailView({ connector, keyEntry, parametersReady = true, state, busy, unknown, canWrite, canAuthorize, canEdit, loading, banner, authorization,
  agents, tools, agentsLoading, toolsLoading, onBack, onEdit, onMetadata, onSave, onCancel, notice, onDismissNotice, onParameters, onParameterChange, onAgents, onTools, onDeleteCheck, onDelete, onConnect, onDisconnect, onAuthorize }: {
  /** connector-auth.AU10: catalog key connector — the parameters page is a single Key field. */
  connector?: Connector; keyEntry?: { name: string; url: string }; parametersReady?: boolean; state: ConnectorDetailState; busy: boolean; unknown: boolean; canWrite: boolean; canAuthorize: boolean; canEdit: boolean; loading: boolean;
  banner?: ReactNode; authorization?: ReactNode; agents?: ConnectorAgent[]; tools?: ConnectorTools; agentsLoading: boolean; toolsLoading: boolean;
  onBack: () => void; onEdit: () => void; onMetadata: (fields: { name?: string; description?: string }) => void;
  onSave: () => void; onCancel: () => void;
  /** connector-detail S2: this visit's one-time failure for the detail / parameters page; dialogs keep their own. */
  notice?: string | null; onDismissNotice?: () => void; onParameters: () => void; onParameterChange: (fields: Partial<ConnectorParameterDraft>) => void;
  onAgents: () => void; onTools: () => void; onDeleteCheck: () => void; onDelete: () => void; onConnect: () => void; onDisconnect: () => void; onAuthorize: () => void;
}) {
  const { t } = useTranslation(); const insets = useSafeAreaInsets();
  const showUnknown = useDelayedNotice(unknown ? connector?.id ?? 'connector' : null);
  if (state.status === 'closed') return null;
  const panel = state.status === 'ready' ? state.panel : 'main';
  const parameters = state.status === 'parameters';
  const error = 'error' in state ? state.error : '';
  const summary = connector ? connectorListRowState(connector) : undefined;
  const connected = summary?.kind === 'connected';
  const failure = summary?.kind === 'failure' ? connector?.error || '连接未完成，请检查连接参数后重试' : undefined;
  return <View className="flex-1 bg-muted dark:bg-background">
    <ScreenBar title={t(parameters ? '连接参数' : panel === 'agents' ? '已连接的 Agent' : '连接器')}
      left={<Button intent="quiet" size="icon" accessibilityLabel={t('返回')} disabled={busy} onPress={onBack}><Icon as={ChevronLeft} /></Button>}
      right={parameters ? <Button testID="connector-parameters-save" intent="quiet" disabled={!canWrite || !!connector?.app_id && !keyEntry} onPress={onSave}><Text>{t('保存')}</Text></Button>
        : connector && panel === 'main' ? <Button intent="quiet" disabled={!canEdit} onPress={onEdit}><Text>{t('编辑')}</Text></Button> : undefined} />
    {banner}
    {unknown && showUnknown && state.status !== 'metadata' ? <StatusBanner icon={CircleAlert} title={t('保存结果未确认，恢复连接后自动核对')} /> : null}
    {notice && state.status !== 'metadata' && state.status !== 'confirm-delete' ? <View testID="connector-error"><StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(notice)}
      action={onDismissNotice ? { icon: X, label: t('关闭提示'), onPress: onDismissNotice, testID: 'connector-error-dismiss' } : undefined} /></View> : null}
    {state.notice ? <Text variant="caption" className="mx-4 text-muted-foreground">{t(state.notice)}</Text> : null}
    <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
      {loading ? <LoadingState /> : null}
      {parameters ? keyEntry ? <ConnectorKeyForm draft={state.draft} keyUrl={keyEntry.url} disabled={!canEdit} onChange={onParameterChange} />
        : <><ConnectorParameterForm draft={state.draft} disabled={!canEdit} readOnly={!!connector?.app_id} onChange={onParameterChange} />
        {connector?.app_id ? <Text variant="caption" className="mx-4 mt-4 text-muted-foreground">{t('连接参数由目录管理')}</Text> : null}</>
        : panel === 'agents' ? <ListGroup>{agents?.length ? agents.map(agent => <GroupRow key={agent.id} title={agent.name} leading={<WandrunAvatar index={agent.avatar ?? 0} alt={agent.name} size={40} />} />)
          : agents ? <GroupRow title={t('还没有已连接的 Agent')} /> : agentsLoading ? <LoadingState /> : null}</ListGroup>
          : connector ? <>
            <ConnectorHeader icon={<ConnectorIcon name={connector.name} uri={connector.icon} appId={connector.app_id} large />} name={connector.name}
              description={connector.description || t('补充说明后 Agent 才能按需找到它')} status={failure && failure !== notice ? t(failure) : summary ? t(summary.label, { count: connector.tool_count }) : undefined} />
            {authorization}
            {connected ? <>
              <ListGroup inset="content"><GroupRow title={t('工具')} value={t('{count} 个工具', { count: connector.tool_count })} affordance="disclose" expanded={state.expanded} onPress={onTools} />
                {tools?.status === 'connected' ? (state.expanded ? tools.tools : tools.tools.slice(0, 3)).map(tool => <GroupRow key={tool.name} title={tool.title || tool.name} description={state.expanded ? tool.description ?? undefined : undefined} />) : toolsLoading ? <LoadingState /> : null}
              </ListGroup>
              <ListGroup><GroupRow title={t('已连接的 Agent')} affordance="navigate" leading={<View className="flex-row gap-1">{connector.used_by.slice(0, 3).map(agent => <WandrunAvatar key={agent.id} index={agent.avatar ?? 0} alt={agent.name} size={28} />)}</View>}
                value={String(connector.used_by.length)} onPress={onAgents} /></ListGroup>
            </> : null}
            <ListGroup label={t('详情')} inset="content"><GroupRow title={t('授权方式')} value={t(connectorAuthMethodLabel(connector.app_id === 'github' ? 'device' : connector.auth_type))} />
              <GroupRow title={t('来源')} value={t(connector.app_id ? '连接器目录' : '自定义添加')} /><GroupRow title={t('连接参数')} affordance="navigate" disabled={!canEdit || !parametersReady} onPress={onParameters} />
              {connected ? <GroupRow title={t('测试连接')} disabled={!canWrite} onPress={onConnect} /> : null}
              {connected && connector.auth_type === 'oauth' ? <GroupRow title={t('重新授权')} affordance="navigate" disabled={!canAuthorize} onPress={onAuthorize} /> : null}
            </ListGroup>
            {connector.pending_restart ? <Text variant="caption" className="mx-4 mt-4 text-muted-foreground">{t('参数待重启生效')}</Text> : null}
          </> : null}
    </KeyboardAwareScrollView>
    {connector && !parameters && panel === 'main' ? <View style={{ paddingBottom: insets.bottom }}><View className="gap-2 px-4 pb-4 pt-2">
      {!connected && (connector.auth_type !== 'oauth' || connector.auth.status === 'authorized') ? <Button disabled={!canWrite || connector.auth_type === 'key' && !Object.keys(connector.headers ?? {}).length && !parametersReady} onPress={connector.auth_type === 'key' && !Object.keys(connector.headers ?? {}).length ? onParameters : onConnect}><Text>{t(connector.auth_type === 'key' && !Object.keys(connector.headers ?? {}).length ? '填写密钥' : '连接')}</Text></Button> : null}
      <View className="flex-row justify-center gap-3">
        {connector.auth_type === 'oauth' && connector.auth.status === 'authorized' || connector.auth_type === 'key' && Object.keys(connector.headers ?? {}).length > 0 ? <Button intent="quiet" disabled={!canWrite} onPress={onDisconnect}><Text>{t('断开连接')}</Text></Button> : null}
        <Button intent="destructive" disabled={!canWrite} onPress={onDeleteCheck}><Text>{t('删除连接器')}</Text></Button>
      </View>
    </View></View> : null}
    <Dialog open={state.status === 'metadata'} onOpenChange={open => { if (!open && !busy) { if (unknown) onBack(); else onCancel(); } }}><DialogContent>
      <DialogTitle>{t('编辑连接器')}</DialogTitle>
      {unknown ? <Text variant="caption" className="text-muted-foreground">{t('保存结果未确认，恢复连接后自动核对')}</Text> : null}
      {state.status === 'metadata' ? <><Text variant="caption">{t('名称')}</Text><Input tone="muted" accessibilityLabel={t('连接器名称')} value={state.name} editable={canEdit} onChangeText={name => onMetadata({ name })} />
        <Text variant="caption">{t('说明')}</Text><Input tone="muted" accessibilityLabel={t('连接器说明')} value={state.description} editable={canEdit} onChangeText={description => onMetadata({ description })} />
        {error ? <Text accessibilityRole="alert" variant="caption" className="text-destructive">{t(error)}</Text> : null}
        <View className="flex-row gap-3"><Button intent="soft" className="flex-1" disabled={busy} onPress={unknown ? onBack : onCancel}><Text>{t(unknown ? '离开' : '取消')}</Text></Button><Button className="flex-1" disabled={!canWrite} onPress={onSave}><Text>{t('保存')}</Text></Button></View></> : null}
    </DialogContent></Dialog>
    <AlertDialog open={state.status === 'confirm-delete' && !unknown} onOpenChange={open => { if (!open && !busy) onCancel(); }}><AlertDialogContent>
      <AlertDialogTitle>{t('删除 {name}？', { name: connector?.name ?? '' })}</AlertDialogTitle>
      {state.status === 'confirm-delete' ? <><AlertDialogDescription>{t(state.agents.length ? '将同时从这 {count} 个 Agent 中移除' : '删除后无法恢复', { count: state.agents.length })}</AlertDialogDescription>
        {state.agents.map(agent => <View key={agent.id} className="flex-row items-center gap-3"><WandrunAvatar index={agent.avatar ?? 0} alt={agent.name} size={40} /><Text variant="body">{agent.name}</Text></View>)}
        {error ? <Text accessibilityRole="alert" variant="caption" className="text-destructive">{t(error)}</Text> : null}
        <View className="flex-row gap-3"><Button intent="soft" className="flex-1" disabled={busy} onPress={onCancel}><Text>{t('取消')}</Text></Button><Button intent="destructive" className="flex-1" disabled={!canWrite} onPress={onDelete}><Text>{t(busy ? '删除中…' : '删除')}</Text></Button></View></> : null}
    </AlertDialogContent></AlertDialog>
  </View>;
}
