import GorhomBottomSheet, { BottomSheetScrollView, BottomSheetTextInput, BottomSheetView, type BottomSheetBackgroundProps } from '@gorhom/bottom-sheet';
import type { ComponentProps } from 'react';
import { View } from 'react-native';
import { withUniwind } from 'uniwind';

import { cn } from '@/lib/utils';

function PageBackground({ style, ...props }: BottomSheetBackgroundProps) {
  return <View {...props} style={style} className="rounded-t-lg bg-page-surface" />;
}

function PageHandle() {
  return <View className="items-center pb-2 pt-3"><View className="h-1 w-9 rounded-full bg-border" /></View>;
}

/** 可滚动内容：水平 16、底部 28、无顶距（手柄自带下距）；点按列表项时不先收键盘。 */
const SCROLL_CONTENT = { paddingHorizontal: 16, paddingBottom: 28 } as const;

/**
 * 键盘与容器坐标完全交给 gorhom；调用者用 ref 或内容里的官方 useBottomSheet().close() 关闭，onClose 接回自己的本地状态。
 * layout="view"（默认）为短表单；layout="scroll" 用官方 BottomSheetScrollView 承载长内容，配合动态高度与
 * maxDynamicContentSize 封顶，内容少时矮、超过上限后滚动（新对话“全部 Agent”网格，chat.N2）。
 */
export function BottomSheet({ surface = 'page', layout = 'view', children, ...props }: ComponentProps<typeof GorhomBottomSheet> & { surface?: 'page'; layout?: 'view' | 'scroll' }) {
  return <GorhomBottomSheet
    keyboardBehavior="interactive"
    keyboardBlurBehavior="restore"
    android_keyboardInputMode="adjustPan"
    enableBlurKeyboardOnGesture
    {...(surface === 'page' ? { backgroundComponent: PageBackground, handleComponent: PageHandle } : {})}
    {...props}>
    {layout === 'scroll'
      ? <BottomSheetScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={SCROLL_CONTENT}>{children}</BottomSheetScrollView>
      : <BottomSheetView className="gap-4 px-4 pb-5 pt-2">{children}</BottomSheetView>}
  </GorhomBottomSheet>;
}

const StyledSheetInput = withUniwind(BottomSheetTextInput);

/** 使用官方输入原语保留焦点 / 键盘登记，不复制它的内部处理器。 */
export function BottomSheetInput({ className, ...props }: ComponentProps<typeof StyledSheetInput>) {
  return <StyledSheetInput className={cn('min-h-12 rounded-[12px] border-0 bg-card px-4 py-1 text-body leading-5 text-foreground', className)} {...props} />;
}
