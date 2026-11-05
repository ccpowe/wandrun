import type { Meta, StoryObj } from '@storybook/react-native';
import { View } from 'react-native';
import { ChevronLeft, Menu, SquarePen } from 'lucide-react-native';

import { ScreenBar } from '@/components/screen-bar';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { SurfacePressable } from '@/components/ui/surface-pressable';
import { Text } from '@/components/ui/text';
import { WandrunAvatar } from '@/components/wandrun-avatar';
import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

/** 普通标题与中间自定义内容（聊天 Agent 名称区）共用同一顶栏骨架；长名称各一行截断。 */
function Bars({ theme = 'light' }: { theme?: FoundationTheme }) {
  const back = <Button intent="quiet" size="icon" accessibilityLabel="返回"><Icon as={ChevronLeft} /></Button>;
  const agent = (name: string, subtitle: string) => <SurfacePressable accessibilityRole="button" accessibilityLabel={`查看${name}资料`}
    className="min-h-12 max-w-full flex-row items-center gap-2.5 rounded-full px-3">
    <WandrunAvatar index={2} alt={name} size={28} />
    <View className="min-w-0 shrink">
      <Text variant="body" className="font-medium" numberOfLines={1}>{name}</Text>
      <Text className="text-xs text-muted-foreground" numberOfLines={1}>{subtitle}</Text>
    </View>
  </SurfacePressable>;
  return <FoundationFrame theme={theme}>
    <View className="gap-6 bg-background pb-6">
      <ScreenBar title="技能" left={back} />
      <ScreenBar title="编辑工作记忆" subtitle="资讯主编" left={back} />
      <ScreenBar left={<Button intent="quiet" size="icon" accessibilityLabel="对话列表"><Icon as={Menu} size={24} /></Button>}
        center={agent('资讯主编', '本周阅读清单')}
        right={<Button intent="quiet" size="icon" accessibilityLabel="新对话"><Icon as={SquarePen} size={24} /></Button>} />
      <ScreenBar left={<Button intent="quiet" size="icon" accessibilityLabel="对话列表"><Icon as={Menu} size={24} /></Button>}
        center={agent('每日科技资讯与论文阅读主编', '帮我把这周要读的三篇论文按优先级排一下，并整理成一页笔记')}
        right={<Button intent="quiet" size="icon" accessibilityLabel="新对话"><Icon as={SquarePen} size={24} /></Button>} />
    </View>
  </FoundationFrame>;
}

const meta = { title: 'foundation/ScreenBar', component: Bars, parameters: { fullScreen: true } } satisfies Meta<typeof Bars>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: '标题 + 中间自定义内容 · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: '标题 + 中间自定义内容 · 深色', args: { theme: 'dark' } };
