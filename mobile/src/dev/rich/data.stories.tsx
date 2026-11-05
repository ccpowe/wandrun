import type { Meta, StoryObj } from '@storybook/react-native';
import { fixture, fromScenario, node } from './rich-fixtures';
import { RichStory } from './rich-story';

const meta = {
  title: 'rich/02 数据展示', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
  args: { fixture: fromScenario('display', 'Status') },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Status: Story = { name: 'Status · 进行中' };
export const FailedStatus: Story = { name: 'Status · 失败', args: { fixture: fixture(node('Status', { title: '同步附件', badge: { text: '失败', tone: 'error' }, caption: '远端连接已断开，附件未能同步。' })) } };
export const Metrics: Story = { name: 'Metrics · 指标摘要', args: { fixture: fromScenario('display', 'Metrics') } };
export const KeyValue: Story = { name: 'KeyValue · 详情', args: { fixture: fromScenario('detail', 'KeyValue') } };
export const Steps: Story = { name: 'Steps · 完成、当前、待办', args: { fixture: fromScenario('display', 'Steps') } };
export const FailedSteps: Story = { name: 'Steps · 失败与长说明', args: { fixture: fromScenario('steps', 'Steps') } };
export const Progress: Story = { name: 'Progress · 进行中', args: { fixture: fromScenario('detail', 'Progress') } };
export const ZeroProgress: Story = { name: 'Progress · 未开始', args: { fixture: fixture(node('Progress', { value: 0, caption: '尚未开始' })) } };
export const CompleteProgress: Story = { name: 'Progress · 已完成', args: { fixture: fixture(node('Progress', { value: 100, caption: '发布完成' })) } };
export const Table: Story = { name: 'Table · 带状态的表格', args: { fixture: fromScenario('display', 'Table') } };
export const EmptyTableRejected: Story = { name: 'Table · 空数据被契约拒绝', args: { fixture: fixture(node('Table', { columns: ['任务', '状态'], rows: [] })) } };
