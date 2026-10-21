import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useTranslation } from "@/lib/i18n.ts";

function Dot({ phase, offset }: { phase: SharedValue<number>; offset: number }) {
  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + 0.7 * (1 + Math.cos((phase.value - offset) * 2 * Math.PI)) / 2,
  }));
  return <Animated.View className="size-1.5 rounded-full bg-muted-foreground" style={style} />;
}

/** 三点在 UI 线程错峰明暗循环；失焦即停止，系统减少动态效果时保持静态。 */
export function TypingDots() {
  const focused = useIsFocused();
  const { t } = useTranslation();
  const phase = useSharedValue(0);
  useEffect(() => {
    if (!focused) return;
    phase.value = 0;
    phase.value = withRepeat(
      withTiming(1, { duration: 1200, easing: Easing.linear, reduceMotion: ReduceMotion.System }),
      -1, false, undefined, ReduceMotion.System,
    );
    return () => cancelAnimation(phase);
  }, [focused, phase]);

  return (
    <View testID="typing-dots" className="flex-row items-center gap-1" accessible accessibilityLabel={t("进行中")}>
      <Dot phase={phase} offset={0} />
      <Dot phase={phase} offset={1 / 3} />
      <Dot phase={phase} offset={2 / 3} />
    </View>
  );
}
