import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";

import { BrowserScreen } from "@/browser/screen.tsx";

export default function BrowserTakeover() {
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>();
  const [landscapeEnabled, setLandscapeEnabled] = useState(false);
  // A retained route must forget the selection when another screen takes focus.
  useFocusEffect(useCallback(() => () => setLandscapeEnabled(false), []));
  return <>
    <Stack.Screen options={{ headerShown: false, orientation: landscapeEnabled ? "landscape" : "portrait" }} />
    <BrowserScreen id={id} page={page} control landscapeEnabled={landscapeEnabled} onLandscapeChange={setLandscapeEnabled} />
  </>;
}
