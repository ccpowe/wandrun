import { router, Stack } from "expo-router";
import { ChevronLeft, Monitor, Moon, Sun } from "lucide-react-native";
import { ScrollView, View } from "react-native";

import { SelectionRow } from "@/components/agent-editor-controls.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { appearance, useAppearance } from "@/lib/appearance-context.tsx";
import type { AppearancePreferences } from "@/lib/appearance.ts";
import { useTranslation } from "@/lib/i18n.ts";

export default function AppearanceSettings() {
  const state = useAppearance();
  const { t } = useTranslation();
  const change = (patch: Partial<AppearancePreferences>) => { void appearance.update(patch).catch(() => {}); };
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("外观")} left={<Button testID="appearance-back" variant="ghost" size="icon" className="bg-transparent"
      accessibilityLabel={t("返回")} onPress={() => router.canGoBack() ? router.back() : router.replace("/")}>
      <Icon as={ChevronLeft} className="size-[22px]" />
    </Button>} />
    <ScrollView contentContainerClassName="pb-10">
      <ListGroup label={t("语言")}>
        <SelectionRow testID="appearance-language-zh" label="中文" single selected={state.language === "zh"}
          disabled={state.saving} onPress={() => change({ language: "zh" })} />
        <SelectionRow testID="appearance-language-en" label="English" single selected={state.language === "en"}
          disabled={state.saving} onPress={() => change({ language: "en" })} />
      </ListGroup>
      <ListGroup label={t("颜色模式")}>
        <SelectionRow testID="appearance-theme-system" label={t("跟随系统")} single selected={state.theme === "system"}
          leading={<Icon as={Monitor} className="size-[22px] text-muted-foreground" />} disabled={state.saving} onPress={() => change({ theme: "system" })} />
        <SelectionRow testID="appearance-theme-light" label={t("浅色")} single selected={state.theme === "light"}
          leading={<Icon as={Sun} className="size-[22px] text-muted-foreground" />} disabled={state.saving} onPress={() => change({ theme: "light" })} />
        <SelectionRow testID="appearance-theme-dark" label={t("深色")} single selected={state.theme === "dark"}
          leading={<Icon as={Moon} className="size-[22px] text-muted-foreground" />} disabled={state.saving} onPress={() => change({ theme: "dark" })} />
      </ListGroup>
      <Text className="mx-8 mt-3 text-xs leading-[18px] text-muted-foreground">{t("外观设置会保存在此设备上，不影响其他设备。")}</Text>
      {state.error ? <Text testID="appearance-save-error" accessibilityRole="alert" className="mx-8 mt-3 text-sm text-destructive">{t(state.error)}</Text> : null}
    </ScrollView>
  </View>;
}
