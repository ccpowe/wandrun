import type { Meta, StoryObj } from '@storybook/react-native';
import { fixture, node } from './rich-fixtures';
import { RichStory } from './rich-story';

const meta = {
  title: 'rich/08 状态与动作', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BoundValue: Story = {
  name: 'Bound.value · 实时参数与选项名称',
  args: { fixture: fixture(node('Stack', { gap: 'lg' },
    node('Heading', { text: '调整参数' }),
    node('Field', { label: '预算', value: { $state: '/budget' } },
      node('Slider', { stateKey: 'budget', label: '预算滑块', min: 0, max: 3000, step: 100 })),
    node('Field', { label: '频率', value: { $state: '/frequency' } },
      node('Segmented', { stateKey: 'frequency', label: '选择频率', options: [{ value: 'week', label: '每周' }, { value: 'month', label: '每月' }] })),
    node('KeyValue', { items: [{ label: '当前预算', value: { $state: '/budget' } }, { label: '当前频率', value: { $state: '/frequency' } }] }),
    node('Submit', { label: '提交参数' })), { budget: 1500, frequency: 'week' }) },
};
export const BoundSubmitted: Story = { ...BoundValue, name: 'Bound.submitted · 固定已提交参数', args: { ...BoundValue.args!, mode: 'submitted' } };

export const FieldSubmittedValues: Story = {
  name: 'Bound.submitted · Field 同值不重复且保留其他值',
  args: { mode: 'submitted', fixture: fixture(node('Stack', { gap: 'lg' },
    node('Field', { label: '预算', value: { $state: '/budget' } },
      node('Slider', { label: '预算滑块', stateKey: 'budget', min: 0, max: 3000, step: 100 })),
    node('Field', { label: '备注', value: '固定说明' },
      node('TextInput', { label: '填写备注', stateKey: 'note' })),
    node('Field', { label: '补充', value: { $state: '/budget' } },
      node('TextInput', { label: '填写补充', stateKey: 'extra' })),
    node('Submit', { label: '提交参数' })), { budget: 1500, note: '保留备注', extra: '另一个值' }) },
};

export const BoundVisible: Story = {
  name: 'Bound.visible · 按状态显示说明',
  args: { fixture: fixture(node('Stack', { gap: 'lg' },
    node('Switch', { label: '显示详细说明', stateKey: 'details' }),
    { ...node('Text', { text: '详细说明已展开' }), visible: { $state: '/details' } },
    { ...node('Text', { text: '当前只显示摘要' }), visible: { $state: '/details', not: true } },
    node('Submit', { label: '提交设置' })), { details: false }) },
};
export const CopyIdle: Story = {
  name: 'Copy.idle · 复制固定文本',
  args: { fixture: fixture(node('Stack', {}, node('Text', { text: 'pnpm run storybook' }),
    node('Copy', { label: '复制命令', text: 'pnpm run storybook' }))) },
};
export const CopyBound: Story = {
  name: 'Copy.idle · 复制当前选项名称',
  args: { fixture: fixture(node('Stack', { gap: 'lg' },
    node('Field', { label: '频率', value: { $state: '/frequency' } },
      node('Segmented', { stateKey: 'frequency', label: '选择频率', options: [{ value: 'week', label: '每周' }, { value: 'month', label: '每月' }] })),
    node('ButtonRow', {}, node('Copy', { label: '复制频率', text: { $state: '/frequency' } }), node('Submit', { label: '提交频率' }))), { frequency: 'week' }) },
};
export const FollowUpsIdle: Story = {
  name: 'FollowUps.idle · 一组只能发送一条',
  args: { fixture: fixture(node('FollowUps', { items: [
    { label: '给一个例子', text: '请给出一个具体例子。' },
    { label: '继续展开', text: '请继续展开上一条结论。' },
    { label: '改成表格', text: '请用表格呈现这些信息。' },
  ] })) },
};
export const FollowUpsSending: Story = { ...FollowUpsIdle, name: 'Send.sending · 其余追问禁用', args: { ...FollowUpsIdle.args!, mode: 'submitting' } };
export const FollowUpsSent: Story = { ...FollowUpsIdle, name: 'Send.sent · 仅保留已发送追问', args: { ...FollowUpsIdle.args!, mode: 'submitted' } };
export const FollowUpsError: Story = { ...FollowUpsIdle, name: 'Send.error · 同项重试', args: { ...FollowUpsIdle.args!, mode: 'error' } };
export const FollowUpsUnknown: Story = { ...FollowUpsIdle, name: 'Send.error · 核对失败可再查，确认后同项重试', args: { ...FollowUpsIdle.args!, mode: 'unknown' } };
export const FollowUpsChecking: Story = { ...FollowUpsIdle, name: 'Send.checking · 只读核对中不重发', args: { ...FollowUpsIdle.args!, mode: 'checking' } };
export const StatCardTappable: Story = {
  name: 'StatCard.tappable · 同组只能发送一张',
  args: { fixture: fixture(node('Grid', { columns: 2 },
    node('StatCard', { icon: 'activity', label: '基础方案', value: '¥128', description: '适合日常使用', send: { text: '我选择基础方案。' } }),
    node('StatCard', { icon: 'clock-3', label: '专业方案', value: '¥256', description: '适合复杂任务', send: { text: '我选择专业方案。' } }))) },
};
export const StatCardSent: Story = { ...StatCardTappable, name: 'StatCard.sent · 保留全部并标已选', args: { ...StatCardTappable.args!, mode: 'submitted' } };
export const SendButton: Story = {
  name: 'Send.idle · 发送固定文本',
  args: { fixture: fixture(node('ButtonRow', {}, node('Copy', { label: '复制', text: '请继续分析。' }),
    node('Submit', { label: '继续分析', send: { text: '请继续分析。' } }))) },
};
