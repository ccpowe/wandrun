import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { CircleAlert } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { ConnectView } from '../components/connect-view';
import { SettingsModelsView } from '../components/settings-models-view';
import { SkillDetailView } from '../components/skill-detail-view';
import { StatusBanner } from '../components/status-banner';
import { Text } from '../components/ui/text';
import { initialConnectState, selectConnect } from '../lib/connect';
import { useTranslation } from '../lib/i18n';
import { selectModelSettings } from '../lib/settings-models';
import { selectSkillDetail } from '../lib/skill-detail';
import { FoundationFrame, type FoundationTheme } from './foundation-frame';
import { SceneProviders } from './scene-providers';

function FlowViews({ kind, theme = 'light' }: { kind: 'models-read-error' | 'pairing-save' | 'skill-delete' | 'skill-unknown'; theme?: FoundationTheme }) {
  const { t } = useTranslation();
  const [lastAction, setLastAction] = useState('');
  const record = (action: string) => () => setLastAction(action);
  const pairing = initialConnectState();
  const exchange = { phase: 'saving' as const, error: '' };
  const deletion = { phase: kind === 'skill-delete' ? 'deleting' as const : 'unknown' as const, users: [], error: '' };
  return <FoundationFrame theme={theme} scrollable={false}><SceneProviders><View className="flex-1">
    {kind === 'models-read-error' ? <SettingsModelsView selection={selectModelSettings({ status: 'overview' }, false)}
      offline={false} banner={<StatusBanner icon={CircleAlert} title={t('无法加载{items}，正在重试…', { items: t('登录状态') })} />}
      picker={null} subscription={{ auth: null, networkError: true, usage: { plan_type: 'Pro', allowed: true, limit_reached: false,
        fetched_at: 1_800_000_000, windows: [{ name: 'primary', used_percent: 42, window_seconds: 604800, reset_at: 1_800_003_600 }] } }}
      subscriptionLoaded settingsLoaded={false} settingsPending={false} nowSeconds={1_800_000_000} usage={{ kind: 'usage-error' }}
      onBack={record('返回')} onSave={record('保存')} onOpen={record('默认模型')} />
      : kind === 'pairing-save' ? <ConnectView state={pairing} selection={selectConnect(pairing, exchange)} exchangePhase="saving"
        canClose invalid={false} repairing={false} revoked={false} camera={null}
        onClose={record('返回')} onPage={page => setLastAction(page)} onScan={record('扫码')} onSubmit={record('连接')}
        onCancel={record('取消')} onRetryScan={record('重新扫描')} onManage={record('管理')} onTitle={record('标题')}
        onField={(field, value) => setLastAction(`${field}: ${value}`)} />
        : <SkillDetailView name="research-notes" detail={{ name: 'research-notes', description: '研究笔记', status: 'ok', error: null,
          used_by: [], path: '/workspace/skills/research-notes/SKILL.md', mtime: null, content: '# Research notes\n\nKeep the evidence.' }} users={[]}
          action={deletion} selection={selectSkillDetail({ status: 'content' }, deletion, { gone: false, focused: true, online: true, users: 0 })}
          banner={kind === 'skill-unknown' ? <StatusBanner icon={CircleAlert} title={t('结果未确认，恢复连接后会核对')} /> : null}
          loading={false} refreshing={false} online onBack={record('返回')} onRefresh={record('刷新')} onUser={user => setLastAction(user.name)}
          onUsers={open => setLastAction(`users: ${open}`)} onDeleteCheck={record('检查删除')} onDelete={record('删除')} onDeleteCancel={record('取消')} />}
    {lastAction ? <Text variant="caption">Storybook: {lastAction}</Text> : null}<PortalHost />
  </View></SceneProviders></FoundationFrame>;
}
const meta = { title: 'settings-flow-views', component: FlowViews, parameters: { fullScreen: true } } satisfies Meta<typeof FlowViews>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ModelsReadError: Story = { name: '模型读取失败 · 历史额度不是登录证据', args: { kind: 'models-read-error' } };
export const ModelsReadErrorDark: Story = { name: '模型读取失败 · 深色', args: { kind: 'models-read-error', theme: 'dark' } };
export const PairingSave: Story = { name: '配对安全保存中 · 不可取消', args: { kind: 'pairing-save' } };
export const SkillDelete: Story = { name: '技能删除中 · 确认层防重', args: { kind: 'skill-delete' } };
export const SkillUnknownDark: Story = { name: '技能删除未确认 · 深色', args: { kind: 'skill-unknown', theme: 'dark' } };
