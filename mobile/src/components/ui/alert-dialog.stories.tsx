import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { SurfacePressable } from '@/components/ui/surface-pressable';
import { Text } from '@/components/ui/text';
import type { FoundationTheme } from '@/dev/foundation-frame';
import { FoundationOverlayFrame } from '@/dev/foundation-overlay-frame';

function Confirmation({ theme = 'light' }: { theme?: FoundationTheme }) {
  const [open, setOpen] = useState(true);
  const [deleted, setDeleted] = useState(false);
  return <FoundationOverlayFrame theme={theme} host="foundation-alert">
    <View className="gap-4 p-4">
      <SurfacePressable accessibilityRole="button" onPress={() => setOpen(true)} className="min-h-12 justify-center rounded-full bg-card px-4"><Text variant="body">打开删除确认</Text></SurfacePressable>
      {deleted ? <Text variant="caption">已删除此展示对话</Text> : null}
    </View>
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent surface="filled" portalHost="foundation-alert" testID="foundation-alert-content">
        <AlertDialogHeader><AlertDialogTitle>删除这个对话？</AlertDialogTitle><AlertDialogDescription>正在进行的工作会停止；Agent 发给你的文件仍留在电脑上。</AlertDialogDescription></AlertDialogHeader>
        <View className="flex-row gap-3">
          <AlertDialogCancel><Text>取消</Text></AlertDialogCancel>
          <AlertDialogAction destructive onPress={() => setDeleted(true)}><Text>删除</Text></AlertDialogAction>
        </View>
      </AlertDialogContent>
    </AlertDialog>
  </FoundationOverlayFrame>;
}
const meta = { title: 'foundation/AlertDialog', component: Confirmation, parameters: { fullScreen: true } } satisfies Meta<typeof Confirmation>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Filled 删除确认 · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Filled 删除确认 · 深色', args: { theme: 'dark' } };
