import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

/** A 20dp visual line; interactive rows own their full 44dp target inside the list cell. */
export function ProgressRow({ children, onPress, testID, accessibilityLabel }: {
  children: ReactNode;
  onPress?: () => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const content = <View testID={testID ? `${testID}-content` : undefined}
    style={{ minHeight: 20, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
    {children}
  </View>;
  // Padding is a real hit target, not hitSlop clipped by the virtualized cell.
  // Two consecutive targets touch; their content lines remain 24dp apart.
  return onPress ? <Pressable testID={testID} accessibilityRole="button"
    accessibilityLabel={accessibilityLabel} onPress={onPress} style={{ paddingVertical: 12 }}>
    {content}
  </Pressable> : content;
}
