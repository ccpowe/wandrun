import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { Uniwind } from 'uniwind';

import { useMountEffect } from '@/lib/use-mount-effect';

export type FoundationTheme = 'light' | 'dark';

function ThemeMount({ theme, children }: { theme: FoundationTheme; children: ReactNode }) {
  useMountEffect(() => {
    const previous = Uniwind.currentTheme;
    Uniwind.setTheme(theme);
    return () => Uniwind.setTheme(previous);
  });
  return children;
}

/** 组件目录共用的双主题展示容器；重挂恢复主题，不持有组件业务状态。 */
export function FoundationFrame({ theme, children, scrollable = true }: { theme: FoundationTheme; children: ReactNode; scrollable?: boolean }) {
  return <ThemeMount key={theme} theme={theme}>
    <View className="flex-1 bg-muted dark:bg-background">
      {scrollable ? <ScrollView contentContainerClassName="pb-8">{children}</ScrollView> : children}
    </View>
  </ThemeMount>;
}
