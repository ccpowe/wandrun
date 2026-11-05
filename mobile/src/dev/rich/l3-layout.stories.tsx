import type { Meta, StoryObj } from '@storybook/react-native';
import { fixture, node, sized } from './rich-fixtures';
import { RichStory } from './rich-story';

const stat = (label: string, value: string) => node('StatCard', { icon: 'activity', label, value, description: '最近 7 天' });
const meta = {
  title: 'rich/07 L3 布局', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StackLayout: Story = {
  name: 'Stack.layout · 间距与两端对齐',
  args: { fixture: fixture(node('Stack', { gap: 'lg' },
    ...(['none', 'sm', 'md', 'lg'] as const).map(gap => node('Card', { title: `gap ${gap}` },
      node('Stack', { direction: 'horizontal', gap, justify: 'start', align: 'center', wrap: false },
        node('Badge', { text: '准备' }), node('Badge', { text: '执行' }), node('Badge', { text: '完成' })))),
    ...(['start', 'center', 'end', 'between'] as const).map(justify => node('Card', { title: `justify ${justify}` },
      node('Stack', { direction: 'horizontal', justify }, node('Badge', { text: '左侧' }), node('Badge', { text: '右侧' })))))) },
};
export const StackAlignWrap: Story = {
  name: 'Stack.layout · 交叉轴与换行',
  args: { fixture: fixture(node('Stack', { gap: 'lg' },
    ...(['start', 'center', 'end', 'stretch'] as const).map(align => node('Card', { title: `align ${align}` },
      node('Stack', { direction: 'horizontal', align, wrap: false },
        sized('2/3', stat('本周完成', '28')), sized('1/3', node('Badge', { text: '稳定', tone: 'success' }))))),
    node('Card', { title: 'wrap · 每行两项' }, node('Stack', { direction: 'horizontal', wrap: true, gap: 'sm' },
      ...['方案一', '方案二', '方案三', '方案四'].map(label => sized('1/2', stat(label, '12'))))))) },
};
export const GridFractions: Story = {
  name: 'Grid.layout · 三分之二与三分之一',
  args: { fixture: fixture(node('Grid', { columns: 3 },
    sized('2/3', stat('本周完成', '28')), sized('1/3', stat('待处理', '3')),
    sized('1/2', stat('月均', '24')), sized('1/2', stat('季均', '26')),
    sized('auto', stat('默认列宽', '12')))) },
};
export const GridReadable: Story = {
  name: 'Grid.layout · 大字号与宽内容优先',
  args: { fixture: fixture(node('Grid', { columns: 3 },
    sized('1/3', node('Table', { columns: ['项目', '结果'], rows: [['发布检查', '完成'], ['依赖核对', '正常']] })),
    sized('2/3', stat('窄屏自动单列', '28')))) },
};
export const ScrollRowFits: Story = {
  name: 'ScrollRow.fits · 单项不可滑',
  args: { fixture: fixture(node('ScrollRow', {}, stat('本周完成', '28'))) },
};
export const ScrollRowOverflow: Story = {
  name: 'ScrollRow.overflow · 露出下一张',
  args: { fixture: fixture(node('ScrollRow', {}, stat('方案一', '¥128'), stat('方案二', '¥256'), stat('方案三', '¥512'))) },
};
export const ScrollRowFractions: Story = {
  name: 'ScrollRow.overflow · 半宽卡片',
  args: { fixture: fixture(node('ScrollRow', { gap: 'sm' },
    ...['方案一', '方案二', '方案三', '方案四'].map(label => sized('1/2', stat(label, '128'))))) },
};
export const FieldDefault: Story = {
  name: 'Field.default · 参数行与真实提交',
  args: { fixture: fixture(node('Stack', { gap: 'lg' },
    node('Field', { label: '预算', value: { $state: '/budget' } }, node('Slider', { stateKey: 'budget', label: '预算滑块', min: 0, max: 3000, step: 100 })),
    node('Field', { label: '频率', value: { $state: '/frequency' } }, node('Segmented', { stateKey: 'frequency', label: '选择频率', options: [{ label: '每周', value: 'week' }, { label: '每月', value: 'month' }] })),
    node('Field', { label: '备注' }, node('TextInput', { stateKey: 'note', label: '填写备注', placeholder: '可补充说明' })),
    node('Field', { label: '通知' }, node('Switch', { stateKey: 'notify', label: '接收通知' })),
    node('ButtonRow', {}, node('Submit', { label: '提交参数' }))),
  { budget: 1500, frequency: 'week', note: '', notify: true }) },
};
export const FieldSubmitted: Story = { ...FieldDefault, name: 'Field.default · 已提交只读', args: { ...FieldDefault.args!, mode: 'submitted' } };
export const ButtonRowDefault: Story = {
  name: 'ButtonRow.default · 主操作占满',
  args: { fixture: fixture(node('Stack', {},
    node('TextInput', { stateKey: 'note', label: '发布备注', placeholder: '填写说明' }),
    node('ButtonRow', {}, node('Submit', { label: '提交备注' }))), { note: '' }) },
};
