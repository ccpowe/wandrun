import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { ArrowUp, ChevronLeft, Plus, X } from 'lucide-react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

function Actions({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [action, setAction] = useState('尚未操作');
  return <FoundationFrame theme={theme}>
    <View className="gap-5 p-4">
      <Text variant="caption" className="text-muted-foreground">四种 intent · 胶囊 / 最小触区 48 / 14px 常规</Text>
      <Button intent="primary" onPress={() => setAction('已连接')}><Text>连接 · Primary</Text></Button>
      <Button intent="quiet" onPress={() => setAction('已跳过')}><Text>暂时跳过 · Quiet</Text></Button>
      <Button intent="soft" onPress={() => setAction('已取消')}><Text>取消 · Soft</Text></Button>
      <View className="flex-row gap-3">
        <Button intent="soft" className="flex-1" onPress={() => setAction('已取消删除')}><Text>取消</Text></Button>
        <Button intent="destructive" className="flex-1" onPress={() => setAction('已删除')}><Text>删除</Text></Button>
      </View>
      <Text variant="caption" className="text-muted-foreground">Soft 与 Destructive 同款轻灰：浅 muted / 深 secondary；危险仅红字。</Text>
      <View className="flex-row gap-3"><Button intent="primary" className="flex-1" disabled><Text>连接（禁用）</Text></Button><Button intent="destructive" className="flex-1" disabled><Text>删除（禁用）</Text></Button></View>
      <Text variant="caption" accessibilityLiveRegion="polite">{action}</Text>
      <Button onPress={() => setAction('默认主操作')}><Text>默认主操作</Text></Button>
    </View>
  </FoundationFrame>;
}

/** icon-sm：32 视觉 + 默认 hitSlop 8 补到 48；quiet 图标按钮（icon / icon-sm）禁用只转淡灰，不叠 50% 透明。 */
function SmallIcons({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [action, setAction] = useState('尚未操作');
  return <FoundationFrame theme={theme}>
    <View className="gap-5 p-4">
      <Text variant="caption" className="text-muted-foreground">icon-sm · 32 视觉 / 48 触区，字段内使用</Text>
      <View className="min-h-10 flex-row items-end rounded-[20px] bg-card px-1 dark:bg-muted">
        <Button intent="quiet" size="icon-sm" className="mb-1" accessibilityLabel="添加附件" onPress={() => setAction('已打开附件菜单')}><Icon as={Plus} size={22} className="text-foreground" /></Button>
        <Text variant="body" className="flex-1 py-2.5 pl-1 text-muted-foreground">说点什么</Text>
        <Button intent="primary" size="icon-sm" className="mb-1" accessibilityLabel="发送" onPress={() => setAction('已发送')}><Icon as={ArrowUp} size={18} className="text-primary-foreground" /></Button>
      </View>
      <View className="flex-row items-center gap-4">
        <Button intent="quiet" size="icon-sm" accessibilityLabel="关闭提示" onPress={() => setAction('已关闭')}><Icon as={X} size={18} /></Button>
        <Text variant="caption" className="text-muted-foreground">Quiet</Text>
        <Button intent="quiet" size="icon-sm" accessibilityLabel="发送（禁用）" disabled><Icon as={ArrowUp} size={18} /></Button>
        <Text variant="caption" className="text-muted-foreground">Quiet 禁用（淡灰）</Text>
      </View>
      <View className="flex-row items-center gap-4">
        <Button intent="quiet" size="icon" accessibilityLabel="返回"><Icon as={ChevronLeft} /></Button>
        <Text variant="caption" className="text-muted-foreground">Icon</Text>
        <Button intent="quiet" size="icon" accessibilityLabel="返回（禁用）" disabled><Icon as={ChevronLeft} /></Button>
        <Text variant="caption" className="text-muted-foreground">Icon 禁用（同样淡灰）</Text>
      </View>
      <Text variant="caption" accessibilityLiveRegion="polite">{action}</Text>
    </View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/Button', component: Actions, parameters: { fullScreen: true } } satisfies Meta<typeof Actions>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Primary + Quiet + Soft + Destructive · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Primary + Quiet + Soft + Destructive · 深色', args: { theme: 'dark' } };
export const IconSmallLight: Story = { name: 'Icon Small + Quiet 禁用 · 浅色', args: { theme: 'light' }, render: (args) => <SmallIcons {...args} /> };
export const IconSmallDark: Story = { name: 'Icon Small + Quiet 禁用 · 深色', args: { theme: 'dark' }, render: (args) => <SmallIcons {...args} /> };
