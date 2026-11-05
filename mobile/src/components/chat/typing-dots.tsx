import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useTranslation } from "@/lib/i18n.ts";
import { easing, reduceMotion, typingCycle } from '@/lib/motion.ts';

function Dot({ phase, offset, compact }: { phase: SharedValue<number>; offset: number; compact: boolean }) {
  const style = useAnimatedStyle(() => ({
    opacity: 0.3 + 0.7 * (1 + Math.cos((phase.value - offset) * 2 * Math.PI)) / 2,
  }));
  return <Animated.View className={compact ? "size-1 rounded-full bg-muted-foreground" : "size-1.5 rounded-full bg-muted-foreground"} style={style} />;
}

/** Three staggered dots pause offscreen; compact form fits before the header subtitle.
 * `still`: the invisible placeholder of an ended turn keeps the layout, not the animation. */
export function TypingDots({ compact = false, still = false }: { compact?: boolean; still?: boolean }) {
  const { t } = useTranslation();
  const phase = useSharedValue(0);
  useFocusEffect(useCallback(() => {
    phase.set(0);
    if (still) return;
    phase.set(withRepeat(
      withTiming(1, { duration: typingCycle, easing: easing.linear, reduceMotion }),
      -1, false, undefined, reduceMotion,
    ));
    return () => cancelAnimation(phase);
  }, [phase, still]));

  return (
    <View testID="typing-dots" className={compact ? "flex-row items-center gap-0.5" : "flex-row items-center gap-1"} accessible accessibilityLabel={t("进行中")}>
      <Dot phase={phase} offset={0} compact={compact} />
      <Dot phase={phase} offset={1 / 3} compact={compact} />
      <Dot phase={phase} offset={2 / 3} compact={compact} />
    </View>
  );
}
