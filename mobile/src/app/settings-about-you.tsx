import { Redirect, router, Stack, useIsFocused } from "expo-router";
import { MemorySection } from "@/components/memory-section.tsx";
import { SettingsAboutYouView } from "@/components/settings-local-views.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function SettingsAboutYouRoute() {
  const session = useSession();
  const focused = useIsFocused();
  if (!session) return <Redirect href="/" />;
  return <AboutYouScreen session={session} focused={focused} />;
}
export function AboutYouScreen({ session, focused }: { session: ChatSession; focused: boolean }) {
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <MemorySection scope="profile" id="profile" session={session} focused={focused}
      renderPage={(memory, edit) => <SettingsAboutYouView memory={memory} edit={edit}
        onBack={() => router.canGoBack() ? router.back() : router.replace("/settings")} />} />
  </>;
}
