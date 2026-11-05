import { useFocusEffect } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { type ReactNode, useCallback, useRef } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { Icon } from "@/components/ui/icon.tsx";
import { cn } from "@/lib/utils.ts";

type Props = {
  children: ReactNode;
  /** 左滑只显示图标；label 保留完整无障碍语义。点它才执行，滑动不触发。 */
  action: { label: string; icon: LucideIcon; onPress: () => void; disabled?: boolean };
  /** 行内容的不透明底色（如 bg-background / bg-card），盖住后面的操作按钮。 */
  contentClassName: string;
  /** 操作列的外轮廓圆角；只改变填充形状，不给拖动行增加裁剪祖先。 */
  actionClassName?: string;
  /** false 时收回已露出的操作区并禁用横滑；默认不改变现有调用方。 */
  enabled?: boolean;
  /** 通知展开 / 收回，允许列表只收起真正展开的行，不重建每一行的手势。 */
  onOpenChange?: (open: boolean, close: () => void) => void;
};

const ACTION_WIDTH = 80;

/**
 * 左滑露出 80dp 宽浅灰整列操作区，22dp 图标，无圆框与可见文字。
 * 手势用 react-native-gesture-handler 的 ReanimatedSwipeable（Expo Go 自带，依赖 reanimated）；
 * 根布局须有 GestureHandlerRootView。执行操作后先收回，避免列表重排前操作按钮一直露着。
 */
export function SwipeRow({ children, action, contentClassName, actionClassName, enabled = true, onOpenChange }: Props) {
  const ref = useRef<SwipeableMethods>(null);
  const close = useCallback(() => { ref.current?.close(); }, []);
  const willOpen = useCallback(() => onOpenChange?.(true, close), [onOpenChange, close]);
  const willClose = useCallback(() => onOpenChange?.(false, close), [onOpenChange, close]);
  const press = useCallback(() => { close(); action.onPress(); }, [close, action]);
  useFocusEffect(useCallback(() => {
    if (!enabled) close();
    return () => { close(); onOpenChange?.(false, close); };
  }, [enabled, close, onOpenChange]));
  const renderActions = useCallback(() => (
    <Pressable accessibilityRole="button" accessibilityLabel={action.label} disabled={action.disabled}
      onPress={press} className={cn("items-center justify-center bg-muted", actionClassName)} style={{ width: ACTION_WIDTH }}>
      <Icon as={action.icon} className="size-[22px] text-foreground" />
    </Pressable>
  ), [action, press, actionClassName]);
  return (
    <ReanimatedSwipeable
      ref={ref}
      enabled={enabled}
      friction={2}
      rightThreshold={ACTION_WIDTH / 2}
      overshootRight={false}
      onSwipeableWillOpen={onOpenChange ? willOpen : undefined}
      onSwipeableWillClose={onOpenChange ? willClose : undefined}
      renderRightActions={renderActions}
    >
      <View className={contentClassName}>{children}</View>
    </ReanimatedSwipeable>
  );
}
