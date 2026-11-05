import type { Meta, StoryObj } from '@storybook/react-native';
import { fixture, fromScenario, node } from './rich-fixtures';
import { RichStory } from './rich-story';
import { ChartsChatStory } from './charts-chat-story';

const meta = {
  title: 'rich/04 图表', component: RichStory,
  parameters: { fullScreen: true, hideFullScreenButton: true },
  args: { fixture: fromScenario('line', 'LineChart') },
} satisfies Meta<typeof RichStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LineChart: Story = { name: 'Chart.default · Line 多系列与负值' };
export const MaximumLineChart: Story = { name: 'Chart.scrubbing · 24 点与三系列', args: { fixture: fromScenario('maximum-line', 'LineChart') } };
export const ZeroLineChart: Story = { name: 'Chart.zero · Line 全零', args: { fixture: fixture(node('LineChart', { title: '本周完成项', xLabels: ['周一', '周二'], series: [{ name: '已完成', values: [0, 0] }] })) } };
export const SingleLineChart: Story = { name: 'Chart.single · Line 单点', args: { fixture: fixture(node('LineChart', { title: '今日完成项', xLabels: ['今天'], series: [{ name: '已完成', values: [8] }] })) } };
export const BarChart: Story = { name: 'Chart.default · Bar 渠道比较', args: { fixture: fromScenario('bar', 'BarChart') } };
export const MaximumBarChart: Story = { name: 'BarChart.multi · 12 类与三系列', args: { fixture: fixture(node('BarChart', { title: '各渠道净增长', labels: Array.from({ length: 12 }, (_, i) => `${i + 1}月`), series: [1, 2, 3].map((n) => ({ name: `方案 ${n}`, values: Array.from({ length: 12 }, (_, i) => (i - 3) * n) })) })) } };
export const NegativeBarChart: Story = { name: 'BarChart.negative · 全负值', args: { fixture: fixture(node('BarChart', { title: '成本变化', labels: ['官网', '社群', '搜索'], series: [{ name: '变化', values: [-45, -72, -38] }], unit: '元' })) } };
export const HorizontalBarChart: Story = { name: 'BarChart.horizontal · 多系列与负值', args: { fixture: fixture(node('BarChart', { title: '渠道净增长', labels: ['官网', '社群', '搜索', '活动'], series: [{ name: '本周', values: [45, -22, 38, 56] }, { name: '上周', values: [32, -15, 25, 40] }], horizontal: true, unit: '人' })) } };
export const ZeroBarChart: Story = { name: 'Chart.zero · Bar 全零', args: { fixture: fixture(node('BarChart', { title: '咨询量', labels: ['官网', '社群'], series: [{ name: '咨询', values: [0, 0] }] })) } };
export const PieChart: Story = { name: 'PieChart.selected · 预算占比', args: { fixture: fromScenario('pie', 'PieChart') } };
export const SinglePieChart: Story = { name: 'Chart.single · Pie 单项', args: { fixture: fixture(node('PieChart', { title: '支出', items: [{ label: '住宿', value: 3200 }], unit: '元' })) } };
export const ZeroPieChart: Story = { name: 'Chart.zero · Pie 全零与数据表', args: { fixture: fixture(node('PieChart', { title: '支出', items: [{ label: '住宿', value: 0 }, { label: '交通', value: 0 }] })) } };
export const EmptyLineChart: Story = { name: 'Chart.empty · Line 暂无数据', args: { fixture: fixture(node('LineChart', { title: '完成项', xLabels: [], series: [] })) } };
export const EmptyBarChart: Story = { name: 'Chart.empty · Bar 暂无数据', args: { fixture: fixture(node('BarChart', { title: '咨询量', labels: [], series: [] })) } };
export const EmptyPieChart: Story = { name: 'Chart.empty · Pie 暂无数据', args: { fixture: fixture(node('PieChart', { title: '支出', items: [] })) } };
export const ChartsInChatCompact: Story = { name: 'Chart.context · 文字与图表混排（单行图头与长名压力样本）', render: () => <ChartsChatStory /> };
