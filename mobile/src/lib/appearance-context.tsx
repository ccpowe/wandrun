import * as SecureStore from "expo-secure-store";
import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { Uniwind } from "uniwind";

import { LoadingState } from "@/components/loading-state.tsx";
import { Text } from "@/components/ui/text.tsx";
import { AppearanceStore } from "./appearance.ts";
import { useTranslation } from "./i18n.ts";
import { applyLanguage } from "./locale-store.ts";
import { retryDelay } from "./load-state.ts";
import { useMountEffect } from "./use-mount-effect.ts";

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

const AppearanceContext = createContext(appearance);

/** Native storage is replaceable at its boundary; screens always use the real store. */
export function AppearanceStoreProvider({ store, children }: { store: AppearanceStore; children: ReactNode }) {
  return <AppearanceContext.Provider value={store}>{children}</AppearanceContext.Provider>;
}
export function useAppearanceStore() { return useContext(AppearanceContext); }
export function useAppearance() {
  const store = useAppearanceStore();
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}


/** Restore before mounting sessions/screens to avoid changing locale/theme after first content. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const store = useAppearanceStore();
  const [host, setHost] = useState({ store, generation: 0 });
  if (host.store !== store) setHost({ store, generation: host.generation + 1 });
  return <AppearanceHost key={host.generation} store={store}>{children}</AppearanceHost>;
}

function AppearanceHost({ store, children }: { store: AppearanceStore; children: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const { t } = useTranslation();
  useMountEffect(() => {
    let active = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restore = () => {
      void store.restore().catch(() => {
        if (active && store.restoreRetryable) timer = setTimeout(restore, retryDelay(failures++));
      });
    };
    restore();
    return () => { active = false; clearTimeout(timer); };
  });
  if (!state.ready) return <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
    {state.error
      ? <Text accessibilityRole="alert" className="text-center text-sm text-destructive">{t(state.error)}</Text>
      : <LoadingState />}
  </View>;
  return children;
}
