import type { ComponentProps } from 'react';
import { Pressable } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { duration, easing, reduceMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';

type Props = Omit<ComponentProps<typeof Pressable>, 'children'> & {
  children?: ComponentProps<typeof Pressable>['children'];
  feedback?: 'surface';
  /** 仅供组件 story / 草图固定展示按下态；真实交互仍由 Pressable 驱动。 */
  pressedPreview?: boolean;
  /** 深底设备名片可改用 bg-device-foreground/7，不重复乘 alpha。 */
  overlayClassName?: string;
};

/** 覆盖半透明表面，不改变内容或原填充的不透明度；长按仍使用原生 Pressable。 */
export function SurfacePressable({ children, className, feedback = 'surface', pressedPreview = false, overlayClassName, onPressIn, onPressOut, disabled, ...props }: Props) {
  const pressed = useSharedValue(0);
  const overlay = useAnimatedStyle(() => ({ opacity: pressed.value }));
  return <Pressable {...props} disabled={disabled} className={cn('overflow-hidden', className)}
    onPressIn={(event) => {
      pressed.set(withTiming(1, { duration: duration.exit, easing: easing.exit, reduceMotion }));
      onPressIn?.(event);
    }}
    onPressOut={(event) => {
      pressed.set(withTiming(0, { duration: duration.base, easing: easing.standard, reduceMotion }));
      onPressOut?.(event);
    }}>
    {(state) => <>
      {typeof children === 'function' ? children(state) : children}
      {feedback === 'surface' ? <Animated.View pointerEvents="none" className={cn('absolute inset-0 bg-surface-pressed', overlayClassName)} style={[overlay, pressedPreview && !disabled && { opacity: 1 }]} /> : null}
    </>}
  </Pressable>;
}
