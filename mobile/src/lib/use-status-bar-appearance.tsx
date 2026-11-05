import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback } from 'react';
import { useUniwind } from 'uniwind';
import { StatusBarAppearance, type StatusBarIconStyle } from './status-bar-appearance.ts';
import { useMountEffect } from './use-mount-effect.ts';

// Only imperative icon color: mounting RN StatusBar would clear Expo Go's keyboard insets listener.
const appearance = new StatusBarAppearance(style => StatusBar.setStyle(style));

/** Mount once beside each app/Storybook root; changing theme does not remount screens. */
export function StatusBarTheme() {
  const { theme } = useUniwind();
  const style = theme === 'dark' ? 'light' : 'dark';
  return <ThemeStyle key={style} style={style} />;
}

function ThemeStyle({ style }: { style: StatusBarIconStyle }) {
  useMountEffect(() => {
    appearance.setThemeStyle(style);
    return () => {};
  });
  return null;
}

/** Hidden while mounted: the owner mounts it only while its route is focused and the App is in the
 * foreground, so blur, background and unmount (including error exits) all restore the bar.
 * Imperative only — never the StatusBar component (see mobile/AGENTS.md keyboard insets). */
export function HiddenStatusBar() {
  useMountEffect(() => {
    StatusBar.setHidden(true, 'none');
    return () => StatusBar.setHidden(false, 'none');
  });
  return null;
}

/** A retained route releases on blur, not only on unmount; cleanup never restores a stale theme. */
export function useImmersiveStatusBar(immersive = true): void {
  useFocusEffect(useCallback(() => {
    if (immersive) return appearance.enterImmersive();
  }, [immersive]));
}
