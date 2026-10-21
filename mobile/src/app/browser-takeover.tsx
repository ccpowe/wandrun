import { Stack, useLocalSearchParams } from "expo-router";

import { BrowserScreen } from "@/browser/screen.tsx";

export default function BrowserTakeover() {
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>();
  return <>
    <Stack.Screen options={{ headerShown: false, orientation: "all" }} />
    <BrowserScreen id={id} page={page} control />
  </>;
}
