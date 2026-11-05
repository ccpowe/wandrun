import type { Meta, StoryObj } from '@storybook/react-native';
import { ChatScenePage } from './chat-scene';

const meta = { title: 'conversation-drawer', component: ChatScenePage, parameters: { fullScreen: true } } satisfies Meta<typeof ChatScenePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const E1: Story = { name: 'E1 抽屉 A · 日期分组与协作红点', args: { state: 'E1' } };
export const E1Dark: Story = { name: 'E1 抽屉 A · 日期分组与协作红点（深色）', args: { state: 'E1', theme: 'dark' } };
export const E2: Story = { name: 'E2 空列表 · 保留功能入口', args: { state: 'E2' } };
export const E3: Story = { name: 'E3 只有一个主对话', args: { state: 'E3' } };
export const E3Dark: Story = { name: 'E3 正式行样本（深色）', args: { state: 'E3', theme: 'dark' } };
export const E4: Story = { name: 'E4 多个主对话 · 长列表滚动', args: { state: 'E4' } };
export const E4Dark: Story = { name: 'E4 多个主对话 · 长列表（深色）', args: { state: 'E4', theme: 'dark' } };
export const E5: Story = { name: 'E5 断线 · 连接小字与缓存导航', args: { state: 'E5' } };
export const E6: Story = { name: 'E6 空白新对话不列入抽屉', args: { state: 'E6' } };
export const E7: Story = { name: 'E7 首条发送失败 · 不编造活动时间', args: { state: 'E7' } };
