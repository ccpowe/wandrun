import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Uniwind } from "uniwind";

import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { AppearanceStore } from "./appearance.ts";
import { useTranslation } from "./i18n.ts";
import { applyLanguage } from "./locale-store.ts";

const key = "wandrun.appearance.v1";
export const appearance = new AppearanceStore({
  async read() {
    return Platform.OS === "web" ? localStorage.getItem(key) : SecureStore.getItemAsync(key);
  },
  async write(value) {
    if (Platform.OS === "web") localStorage.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  },
}, (preferences) => {
  Uniwind.setTheme(preferences.theme);
  applyLanguage(preferences.language);
});

export function useAppearance() {
  return useSyncExternalStore(appearance.subscribe, appearance.snapshot, appearance.snapshot);
}


/** Restore before mounting sessions/screens to avoid changing locale/theme after first content. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const state = useAppearance();
  const { t } = useTranslation();
  useEffect(() => { void appearance.restore().catch(() => {}); }, []);
  if (!state.ready) return <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
    {state.error ? <>
      <Text accessibilityRole="alert" className="text-center text-sm text-destructive">{t(state.error)}</Text>
      <Button testID="appearance-retry-load" variant="outline" onPress={() => { void appearance.restore().catch(() => {}); }}><Text>{t("重载设置")}</Text></Button>
    </> : <ActivityIndicator accessibilityLabel={t("正在读取设置…")} />}
  </View>;
  return children;
}
