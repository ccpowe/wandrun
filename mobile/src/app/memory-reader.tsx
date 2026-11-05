import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { View } from "react-native";

import { MemorySection } from "@/components/memory-section.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { SettingsAboutYouView } from "@/components/settings-local-views.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import type { MemoryScope } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function MemoryReaderRoute() {
  const { scope, id } = useLocalSearchParams<{ scope: MemoryScope; id: string }>();
  const session = useSession();
  if (!session || !id || (scope !== "work" && scope !== "profile")) return <Redirect href="/" />;
  return <MemoryReaderScreen key={`${session.queryIdentity}:${scope}:${id}`} scope={scope} id={id} session={session} />;
}

/** Read the complete index Markdown; managed details retain their own reader/editor route. */
export function MemoryReaderScreen({ scope, id, session }: { scope: MemoryScope; id: string; session: ChatSession }) {
  const focused = useIsFocused();
  const { t } = useTranslation();
  const title = scope === "profile" ? t("关于你") : t("{name}的记忆", { name: agentDisplayName(session.agents, id) });
  if (scope === "profile") return <>
    <Stack.Screen options={{ headerShown: false }} />
    <MemorySection scope={scope} id={id} session={session} focused={focused}
      renderPage={(memory, edit) => <SettingsAboutYouView memory={memory} edit={edit}
        onBack={() => router.canGoBack() ? router.back() : router.replace("/settings")} />} />
  </>;
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false }} />
    <ScreenBar title={title} left={<Button testID="memory-reader-back" intent="quiet" size="icon" accessibilityLabel={t("返回")}
      onPress={() => router.canGoBack() ? router.back() :
        router.replace({ pathname: "/agents/[id]", params: { id, tab: "memory" } })}>
      <Icon as={ChevronLeft} />
    </Button>} />
    <MemorySection scope={scope} id={id} session={session} focused={focused} />
  </View>;
}
