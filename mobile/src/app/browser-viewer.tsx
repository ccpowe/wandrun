import { Stack, useLocalSearchParams } from "expo-router";

import { BrowserScreen } from "@/browser/screen.tsx";

export default function BrowserViewer() {
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>();
  return <>
    <Stack.Screen options={{ headerShown: false, orientation: "portrait" }} />
    <BrowserScreen id={id} page={page} control={false} />
  </>;
}
