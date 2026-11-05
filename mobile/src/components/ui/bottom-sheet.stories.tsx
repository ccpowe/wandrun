import { BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import type GorhomBottomSheet from '@gorhom/bottom-sheet';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useRef, useState } from 'react';
import { Keyboard, View } from 'react-native';

import { BottomSheet, BottomSheetInput } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import type { FoundationTheme } from '@/dev/foundation-frame';
import { FoundationOverlayFrame } from '@/dev/foundation-overlay-frame';

function Backdrop(props: BottomSheetBackdropProps) {
  return <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />;
}

function Rename({ theme = 'light' }: { theme?: FoundationTheme }) {
  const sheet = useRef<GorhomBottomSheet>(null);
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('周末旅行计划');
  const [draft, setDraft] = useState(name);
  const close = () => { Keyboard.dismiss(); sheet.current?.close(); };
  return <FoundationOverlayFrame theme={theme} host="foundation-sheet">
    <View className="gap-4 p-4">
      <Text variant="body" testID="foundation-saved-name">{name}</Text>
      <Button intent="soft" accessibilityLabel="打开重命名弹层" onPress={() => { setDraft(name); setOpen(true); }}><Text>重命名</Text></Button>
    </View>
    {open ? <BottomSheet ref={sheet} surface="page" enablePanDownToClose backdropComponent={Backdrop} onClose={() => setOpen(false)}>
      <Text className="text-lg font-medium leading-6">重命名</Text>
      <BottomSheetInput testID="foundation-sheet-input" accessibilityLabel="对话名称" value={draft} onChangeText={setDraft} returnKeyType="done" />
      <View className="flex-row gap-3">
        <Button intent="quiet" accessibilityLabel="取消重命名" onPress={close} className="flex-1"><Text>取消</Text></Button>
        <Button intent="primary" accessibilityLabel="保存名称" disabled={!draft.trim()} onPress={() => { setName(draft.trim()); close(); }} className="flex-1"><Text>保存</Text></Button>
      </View>
    </BottomSheet> : null}
  </FoundationOverlayFrame>;
}
const meta = { title: 'foundation/BottomSheet', component: Rename, parameters: { fullScreen: true } } satisfies Meta<typeof Rename>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = { name: 'Page 重命名与键盘 · 浅色', args: { theme: 'light' } };
export const Dark: Story = { name: 'Page 重命名与键盘 · 深色', args: { theme: 'dark' } };
