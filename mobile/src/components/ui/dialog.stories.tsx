import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { GroupRow } from '@/components/group-row';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import type { FoundationTheme } from '@/dev/foundation-frame';
import { FoundationOverlayFrame } from '@/dev/foundation-overlay-frame';

function Information({ theme = 'light', placement = 'center' }: { theme?: FoundationTheme; placement?: 'center' | 'bottom' }) {
  const [open, setOpen] = useState(true);
  return <FoundationOverlayFrame theme={theme} host="foundation-dialog">
    <View className="p-4"><Button intent="soft" onPress={() => setOpen(true)}><Text>打开对话框</Text></Button></View>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent placement={placement} surface="filled" portalHost="foundation-dialog" showCloseButton={false}
        accessibilityLabel={placement === 'bottom' ? '使用它的 Agent' : '连接器详情'} overlayTestID="foundation-dialog-backdrop" testID="foundation-dialog-content">
        {placement === 'bottom' ? <>
          <DialogTitle className="sr-only" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">使用它的 Agent</DialogTitle>
          <GroupRow title="小万" affordance="navigate" onPress={() => setOpen(false)} />
          <GroupRow title="旅行助手" affordance="navigate" onPress={() => setOpen(false)} />
        </> : <>
          <DialogHeader><DialogTitle>连接器详情</DialogTitle><DialogDescription>可以在已连接的 Agent 中查看谁正在使用这个连接器。</DialogDescription></DialogHeader>
          <DialogClose asChild><Button intent="soft"><Text>知道了</Text></Button></DialogClose>
        </>}
      </DialogContent>
    </Dialog>
  </FoundationOverlayFrame>;
}
const meta = { title: 'foundation/Dialog', component: Information, parameters: { fullScreen: true } } satisfies Meta<typeof Information>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Filled 对话框 · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Filled 对话框 · 深色', args: { theme: 'dark' } };
export const BottomLight: Story = { name: 'Bottom 使用者 · 浅色', args: { theme: 'light', placement: 'bottom' } };
export const BottomDark: Story = { name: 'Bottom 使用者 · 深色', args: { theme: 'dark', placement: 'bottom' } };
