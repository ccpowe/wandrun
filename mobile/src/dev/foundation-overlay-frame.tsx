import { PortalHost } from '@rn-primitives/portal';
import type { ReactNode } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { FoundationFrame, type FoundationTheme } from '@/dev/foundation-frame';

/** Portal 放进真实 393dp 容器；断点仍取平板窗口，验证浮层不越出容器。 */
export function FoundationOverlayFrame({ theme, host, children }: { theme: FoundationTheme; host: string; children: ReactNode }) {
  const { height, width } = useWindowDimensions();
  return <GestureHandlerRootView style={{ flex: 1 }}><FoundationFrame theme={theme} scrollable={false}>
    <View className="flex-1 items-center justify-center py-4">
      <View testID="foundation-overlay-phone" className="overflow-hidden bg-muted dark:bg-background" style={{ width: Math.min(393, width), height: Math.min(812, height - 180) }}>
        {children}
        <PortalHost name={host} />
      </View>
    </View>
  </FoundationFrame></GestureHandlerRootView>;
}
