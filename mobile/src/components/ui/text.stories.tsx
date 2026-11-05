import type { Meta, StoryObj } from '@storybook/react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

function Typography({ theme = 'light' }: { theme?: FoundationTheme }) {
  return <FoundationFrame theme={theme}>
    <View className="gap-6 p-4">
      <View className="gap-2"><Text variant="body">Body · 15 / 20 · 常规字重</Text><Text variant="body">列表标题、表单输入，保持清晰舒适。</Text></View>
      <View className="gap-2"><Text variant="caption" className="text-muted-foreground">Caption · 13 / 18 · 说明与状态</Text><Text variant="caption" className="text-muted-foreground">双行说明保留 18 行距。较长的确认说明可以用 leading-5，明确覆盖到 20。</Text></View>
      <View className="gap-2"><Text variant="caption" className="leading-5 text-muted-foreground">Caption · 13 / 20 · 长提示：删除后不能恢复；请核对当前对象再继续。</Text></View>
      <View className="gap-2"><Text>默认 Text · 16 / 24（不变）</Text><Text className="text-sm">原 sm · 14 / 20（不变）</Text><Text className="text-xs">原 xs · 12 / 16（不变）</Text></View>
      <View className="gap-2 rounded-lg bg-device-surface p-4"><Text variant="body" className="text-device-foreground">Device 配对表面与前景</Text><Text variant="caption" className="text-device-foreground">深色保持深灰设备卡，不反转为亮卡。</Text></View>
      <View className="rounded-lg bg-page-surface p-4"><Text variant="body">Page 表面 · 资料 / 重命名</Text></View>
    </View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/Text', component: Typography, parameters: { fullScreen: true } } satisfies Meta<typeof Typography>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Body + Caption · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Body + Caption · 深色', args: { theme: 'dark' } };
