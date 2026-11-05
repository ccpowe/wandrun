import { router, Stack } from "expo-router";
import { SettingsAppearanceView } from "@/components/settings-local-views.tsx";
import { useAppearance, useAppearanceStore } from "@/lib/appearance-context.tsx";
import { useVisitNotice } from "@/lib/use-focused-visit.ts";

/** The device-level store owns persistence/progress; this page has no duplicate flow or draft.
 * settings-appearance.A4: a save failure is this visit's one-time result. */
export default function AppearanceSettings() {
  const state = useAppearance();
  const appearance = useAppearanceStore();
  const result = useVisitNotice();
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <SettingsAppearanceView state={state} notice={result.notice} onBack={() => router.canGoBack() ? router.back() : router.replace("/")}
      onChange={patch => { const publish = result.begin(); void appearance.update(patch).catch(() => publish("无法保存外观设置，请重试。")); }}
      onDismissNotice={result.dismiss} />
  </>;
}
