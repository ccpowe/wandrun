import type { Meta, StoryObj } from '@storybook/react-native';
import { Copy, Pencil, Pin, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { DropdownMenu, DropdownMenuAnchor, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SurfacePressable } from '@/components/ui/surface-pressable';
import { Text } from '@/components/ui/text';
import type { FoundationTheme } from '@/dev/foundation-frame';
import { FoundationOverlayFrame } from '@/dev/foundation-overlay-frame';

function Menu({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [point, setPoint] = useState<{ pageX: number; pageY: number } | null>(null);
  const [selection, setSelection] = useState('');
  return <FoundationOverlayFrame theme={theme} host="foundation-menu">
    <View className="gap-4 p-4">
      <Text variant="body">长按对话，或点按打开菜单。</Text>
      <DropdownMenu onOpenChange={(next) => { if (!next) setPoint(null); }}>
        <DropdownMenuTrigger asChild><SurfacePressable accessibilityLabel="打开对话菜单" onLongPress={(event) => setPoint({ pageX: event.nativeEvent.pageX, pageY: event.nativeEvent.pageY })} className="min-h-[52px] justify-center rounded-md bg-card px-4"><Text variant="body">周末旅行计划</Text></SurfacePressable></DropdownMenuTrigger>
        {point ? <DropdownMenuAnchor point={point} /> : null}
        <DropdownMenuContent surface="filled" portalHost="foundation-menu" className="w-[220px]" sideOffset={8}>
          <DropdownMenuItem icon={Pencil} onPress={() => setSelection('重命名')}><Text>重命名</Text></DropdownMenuItem>
          <DropdownMenuItem icon={Pin} onPress={() => setSelection('置顶')}><Text>置顶</Text></DropdownMenuItem>
          <DropdownMenuItem icon={Copy} onPress={() => setSelection('复制')}><Text>复制</Text></DropdownMenuItem>
          <DropdownMenuItem icon={Trash2} variant="destructive" onPress={() => setSelection('删除')}><Text>删除</Text></DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {selection ? <Text variant="caption">已选择：{selection}</Text> : null}
    </View>
  </FoundationOverlayFrame>;
}
const meta = { title: 'foundation/DropdownMenu', component: Menu, parameters: { fullScreen: true } } satisfies Meta<typeof Menu>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Filled 菜单 · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Filled 菜单 · 深色', args: { theme: 'dark' } };
