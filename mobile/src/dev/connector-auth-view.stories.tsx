import type { Meta, StoryObj } from '@storybook/react-native';
import { ConnectorOAuthView } from '@/components/connector-oauth';
import type { Connector } from '@/gateway/api';
const connector: Connector = { id: 'notion', name: 'Notion', description: '', app_id: 'notion', auth_type: 'oauth', status: 'disconnected', error: null, tool_count: 0, used_by: [], pending_restart: false,
  auth: { status: 'unauthorized', authorizing: true, transaction_id: 'story-transaction', scopes: [] } };
const expires_at = Math.floor(Date.now() / 1000) + 600;
const noop = () => {};
const meta = { title: 'connectors/authorization-view', component: ConnectorOAuthView, args: { connector, disabled: false,
  selection: { waiting: true, busy: false, canReopen: true, callback: '', error: '', notice: '', flow: { id: 'notion-flow',
    value: { flow: 'authorization_code', transaction_id: 'story-transaction', expires_at, authorization_url: 'https://authorize.example.invalid', redirect_uri: 'https://gateway.example.invalid/oauth/callback', manual_callback: false } } },
  onStart: noop, onReopen: noop, onCallback: noop, onSubmit: noop, onCancel: noop } } satisfies Meta<typeof ConnectorOAuthView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AU3: Story = { name: 'AU3 OAuth 浏览器等待' };
export const AU5: Story = { name: 'AU5 GitHub 短码', args: { connector: { ...connector, id: 'github', name: 'GitHub', app_id: 'github' }, selection: {
  waiting: true, busy: false, canReopen: true, callback: '', error: '', notice: '', flow: { id: 'github-flow', value: { flow: 'device_code', transaction_id: 'story-transaction', expires_at, authorization_url: 'https://github.com/login/device', user_code: 'ABCD-EFGH' } } } } };
export const AU6: Story = { name: 'AU6 其他设备发起的授权', args: { selection: { waiting: true, busy: false, canReopen: false, callback: '', error: '', notice: '', flow: undefined } } };
export const AU8: Story = { name: 'AU8 复制或打开失败可重试', args: { ...AU5.args, selection: { ...AU5.args!.selection!, error: '无法复制短码或打开授权页，请重试此步骤' } } };
export const AU9: Story = { name: 'AU9 GitHub 授权过期', args: { connector: { ...connector, id: 'github', name: 'GitHub', app_id: 'github', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [], error: { code: 'oauth_expired', message: '已过期' } } }, selection: { waiting: false, busy: false, canReopen: false, callback: '', error: '', notice: '', flow: undefined } } };
