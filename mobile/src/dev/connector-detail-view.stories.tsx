import type { Meta, StoryObj } from '@storybook/react-native';
import { ConnectorDetailView } from '@/components/connector-detail-view';
import type { Connector } from '@/gateway/api';
import { initialConnectorDetail } from '@/lib/connector-detail';
const connector: Connector = { id: 'docs', name: '项目资料', description: '', url: 'https://docs.example.invalid/mcp', auth_type: 'none', app_id: null,
  status: 'connected', error: null, tool_count: 4, pending_restart: false, auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] }, used_by: [{ id: 'research', name: '研究助手', avatar: 2 }, { id: 'writing', name: '写作助手', avatar: 5 }] };
const noop = () => {};
const meta = { title: 'connectors/detail-view', component: ConnectorDetailView, parameters: { fullScreen: true }, args: { connector, state: initialConnectorDetail,
  busy: false, unknown: false, canWrite: true, canAuthorize: true, canEdit: true, loading: false, agentsLoading: false, toolsLoading: false, agents: connector.used_by,
  tools: { status: 'connected', as_of_seq: 0, tools: [{ name: 'search', title: '搜索资料', description: '在项目资料中检索相关段落与来源链接' }, { name: 'read', title: '读取页面', description: '按地址读取页面内容' }, { name: 'list', title: '列出空间', description: '查看可访问的资料空间' }, { name: 'update', title: '更新页面', description: '更新已有页面的内容' }] },
  onBack: noop, onEdit: noop, onMetadata: noop, onSave: noop, onCancel: noop, onParameters: noop, onParameterChange: noop, onAgents: noop, onTools: noop, onDeleteCheck: noop, onDelete: noop, onConnect: noop, onDisconnect: noop, onAuthorize: noop } } satisfies Meta<typeof ConnectorDetailView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const D3: Story = { name: 'D3 空说明提示' };
export const D4: Story = { name: 'D4 展开真实工具说明', args: { state: { ...initialConnectorDetail, expanded: true } } };
export const D5: Story = { name: 'D5 编辑名称与说明', args: { state: { ...initialConnectorDetail, status: 'metadata', original: connector, name: connector.name, description: '' } } };
export const D7: Story = { name: 'D7 级联删除确认', args: { state: { ...initialConnectorDetail, status: 'confirm-delete', agents: connector.used_by, error: '' } } };
export const D6Unknown: Story = { name: 'D6 保存结果未知', args: { unknown: true, canWrite: false, canEdit: false, state: { ...initialConnectorDetail, status: 'metadata', original: connector, name: '本次未确认名称', description: '' } } };
export const D4Agents: Story = { name: 'D4 已连接 Agent 只读', args: { state: { ...initialConnectorDetail, panel: 'agents' } } };
