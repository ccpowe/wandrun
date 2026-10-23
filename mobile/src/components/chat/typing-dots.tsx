import { useIsFocused } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useTranslation } from "@/lib/i18n.ts";

function Dot({ phase, offset, compact }: { phase: SharedValue<number>; offset: number; compact: boolean }) {
  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + 0.7 * (1 + Math.cos((phase.value - offset) * 2 * Math.PI)) / 2,
  }));
  return <Animated.View className={compact ? "size-1 rounded-full bg-muted-foreground" : "size-1.5 rounded-full bg-muted-foreground"} style={style} />;
}

/** Three staggered dots pause offscreen; compact form fits before the header subtitle. */
export function TypingDots({ compact = false }: { compact?: boolean }) {
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
    <View testID="typing-dots" className={compact ? "flex-row items-center gap-0.5" : "flex-row items-center gap-1"} accessible accessibilityLabel={t("进行中")}>
      <Dot phase={phase} offset={0} compact={compact} />
      <Dot phase={phase} offset={1 / 3} compact={compact} />
      <Dot phase={phase} offset={2 / 3} compact={compact} />
    </View>
  );
}
