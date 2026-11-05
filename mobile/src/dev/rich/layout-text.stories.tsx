import type { Meta, StoryObj } from '@storybook/react-native';
import { fixture, fromScenario, node } from './rich-fixtures';
import { RichStory } from './rich-story';

const meta = {
  title: 'rich/01 布局与文字', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
  args: { fixture: fromScenario('detail', 'Stack') },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Stack: Story = { name: 'Stack · 横向排列' };
export const Card: Story = { name: 'Card · 信息卡片', args: { fixture: fromScenario('detail', 'Card') } };
export const Divider: Story = { name: 'Divider · 分隔线', args: { fixture: fixture(node('Stack', {}, node('Text', { text: '发布记录' }), node('Divider'), node('Text', { text: 'v1.4 已完成构建', tone: 'muted' }))) } };
export const Heading: Story = { name: 'Heading · 标题', args: { fixture: fromScenario('detail', 'Heading') } };
export const Text: Story = { name: 'Text · 正文与行内格式', args: { fixture: fromScenario('showcase', 'Text') } };
export const MutedText: Story = { name: 'Text · 弱化文字', args: { fixture: fromScenario('showcase', 'Text', 1) } };
export const Badge: Story = { name: 'Badge · 六种语义', args: { fixture: fromScenario('semantic-colors', 'Stack') } };
export const Tabs: Story = { name: 'Tabs · 切换内容', args: { fixture: fromScenario('progressive', 'Tabs') } };
export const Accordion: Story = { name: 'Accordion · 默认折叠', args: { fixture: fromScenario('progressive', 'Accordion') } };
export const ExpandedAccordion: Story = { name: 'Accordion · 默认展开', args: { fixture: fromScenario('progressive', 'Accordion', 1) } };
export const Grid: Story = { name: 'Grid · 自适应布局', args: { fixture: fromScenario('components', 'Grid') } };
export const Icon: Story = { name: 'Icon · 受控图标', args: { fixture: fromScenario('components', 'Icon') } };
export const List: Story = { name: 'List · 有序列表', args: { fixture: fromScenario('components', 'List') } };
export const UnorderedList: Story = { name: 'List · 图标列表', args: { fixture: fromScenario('showcase', 'List', 1) } };
export const Callout: Story = { name: 'Callout · 四种语义', args: { fixture: fromScenario('components', 'Grid') } };
export const Quote: Story = { name: 'Quote · 引用与署名', args: { fixture: fromScenario('components', 'Quote') } };
export const StatCard: Story = {
  name: 'StatCard.static · 只读统计卡',
  args: { fixture: fixture(node('Grid', { columns: 2 },
    node('StatCard', { icon: 'activity', badge: { text: '稳定', tone: 'success' }, label: '本周完成', value: '28', description: '比上周多 6 项' }),
    node('StatCard', { icon: 'clock-3', label: '平均用时', value: '4.2 小时', description: '最近 7 天' }))) },
};
