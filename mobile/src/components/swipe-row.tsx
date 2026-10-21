import type { LucideIcon } from "lucide-react-native";
import { type ReactNode, useRef } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";

type Props = {
  children: ReactNode;
  /** 左滑露出的操作；label 保留完整无障碍语义，visibleLabel 可缩短可见文字。点它才执行，滑动不触发。 */
  action: { label: string; visibleLabel?: string; icon: LucideIcon; onPress: () => void };
  /** 行内容的不透明底色（如 bg-background / bg-card），盖住后面的操作按钮。 */
  contentClassName: string;
};

const ACTION_WIDTH = 88;

/**
 * 左滑一行露出一个操作（设计稿 .swipe：88px 宽，圆形描边图标 + 12px 文字）。
 * 手势用 react-native-gesture-handler 的 ReanimatedSwipeable（Expo Go 自带，依赖 reanimated）；
 * 根布局须有 GestureHandlerRootView。执行操作后先收回，避免列表重排前操作按钮一直露着。
 */
export function SwipeRow({ children, action, contentClassName }: Props) {
  const ref = useRef<SwipeableMethods>(null);
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={ACTION_WIDTH / 2}
      overshootRight={false}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => {
            ref.current?.close();
            action.onPress();
          }}
          className="items-center justify-center gap-1"
          style={{ width: ACTION_WIDTH }}
        >
          <View className="size-10 items-center justify-center rounded-full border-[1.5px] border-border">
            <Icon as={action.icon} className="size-5" />
          </View>
          <Text className="text-xs text-muted-foreground">{action.visibleLabel ?? action.label}</Text>
        </Pressable>
      )}
    >
      <View className={contentClassName}>{children}</View>
    </ReanimatedSwipeable>
  );
}
