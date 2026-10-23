import { Redirect, router, Stack, useIsFocused } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { ScrollView, View } from "react-native";

import { MemorySection } from "@/components/memory-section.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function SettingsAboutYouRoute() {
  const session = useSession();
  const focused = useIsFocused();
  const { t } = useTranslation();
  if (!session) return <Redirect href="/" />;
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={t("关于你")} left={<Button testID="about-you-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回")}
      onPress={() => router.canGoBack() ? router.back() : router.replace("/settings")}><Icon as={ChevronLeft} className="size-[22px]" /></Button>} />
    <ConnectionBanner session={session} />
    <ScrollView contentContainerClassName="pb-12">
      <MemorySection scope="profile" id="profile" session={session} focused={focused} />
    </ScrollView>
  </View>;
}
