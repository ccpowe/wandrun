import type { ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text.tsx";

type Props = {
  left?: ReactNode;
  /** 居中标题；首页不加标题，不传。 */
  title?: string;
  subtitle?: string;
  right?: ReactNode;
};

/**
 * 无原生标题栏页面的顶栏（设计稿 .bar）：左右各放 44px 图标按钮，标题居中。
 * 自己让出状态栏高度（应用是 edge-to-edge）。两侧没有内容时仍占位，标题才不会偏。
 */
export function ScreenBar({ left, title, subtitle, right }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View className="min-h-[52px] flex-row items-center gap-2 px-4" style={{ marginTop: insets.top }}>
      <View className="min-w-11 flex-row">{left}</View>
      <View className="min-w-0 flex-1 items-center">
        {title ? (
          // Avoid Android ellipsizing a color-updated title at its intrinsic width.
          <Text className="self-stretch text-center text-lg font-semibold" numberOfLines={1}>
            {title}
          </Text>
        ) : null}
        {subtitle ? <Text className="text-xs text-muted-foreground" numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      <View className="min-w-11 flex-row justify-end">{right}</View>
    </View>
  );
}
