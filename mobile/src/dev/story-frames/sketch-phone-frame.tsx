import type { ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';

/** 逻辑像素原尺寸展示，不用 transform 缩放平板上的 App。 */
export function SketchPhoneFrame({ children }: { children: ReactNode }) {
  const { height } = useWindowDimensions();
  return <View className="flex-1 items-center justify-center bg-border"><View testID="sketch-phone-frame" className="overflow-hidden bg-muted" style={{ width: 393, height: Math.min(812, height - 112) }}>{children}</View></View>;
}
