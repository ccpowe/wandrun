import "../../global.css";

import { PortalHost } from "@rn-primitives/portal";
import { router, Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { StatusBar } from "expo-status-bar";
import { NavigationBar } from "expo-navigation-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { useCSSVariable, useUniwind } from "uniwind";
import { ActivityIndicator, View } from "react-native";

import { SessionProvider, useGateway } from "@/lib/session-context.tsx";
import { authenticatedScreens, developmentScreens, sharedScreens } from "@/lib/root-stack-routes.ts";
import { AppearanceProvider } from "@/lib/appearance-context.tsx";
import { useTranslation } from "@/lib/i18n.ts";

export default function RootLayout() {
  return <AppearanceProvider><ThemedApp /></AppearanceProvider>;
}

function ThemedApp() {
  const { theme } = useUniwind();
  const background = useCSSVariable("--color-background") as string;
  useEffect(() => {
    // Edge-to-edge bars reveal the app/window background; do not set bar colors.
    // Runs after JS mounts; it cannot color Expo Go's native launch screen.
    void SystemUI.setBackgroundColorAsync(background);
  }, [background]);
  const barStyle = theme === "dark" ? "light" : "dark";
  // enforceContrast is a native resource in standalone builds (rebuild required).
  // Expo Go also reads it from the manifest; Fast Refresh does not reload that config.
  return (
    // 应用已是 edge-to-edge：状态栏与导航栏都声明透明，库给出的键盘高度含导航栏（与 iOS 含 home indicator 一致）。
    // 左滑行（ReanimatedSwipeable）要求手势根视图。
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: background }}>
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
    <SessionProvider>
      <StatusBar style={barStyle} />
      <NavigationBar style={barStyle} />
      <AppStack />
      <PortalHost />
    </SessionProvider>
    </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function AppStack() {
  const { t } = useTranslation();
  const { config, ready, sessionKey } = useGateway();
  const [navigationKey, setNavigationKey] = useState(0);
  useEffect(() => {
    // Let the navigator commit removal of the old protected history before admission.
    const frame = requestAnimationFrame(() => setNavigationKey(sessionKey));
    return () => cancelAnimationFrame(frame);
  }, [sessionKey]);
  useEffect(() => {
    if (sessionKey && navigationKey === sessionKey) router.replace("/");
  }, [navigationKey, sessionKey]);
  if (!ready) return <View className="flex-1 items-center justify-center bg-background"><ActivityIndicator /></View>;
  // Drop protected routes for one committed render before admitting a new session.
  // A keyed Stack alone can restore a Web URL containing the old computer's resource IDs.
  // Re-enable only after that history is gone, then open home; local notes keep the key.
  return <Stack key={sessionKey} screenOptions={{ orientation: "portrait" }}>
    <Stack.Protected guard={!!config && sessionKey !== 0 && navigationKey === sessionKey}>
      {authenticatedScreens.map((screen) => <Stack.Screen key={screen.name} {...screen} options={screen.options ? { ...screen.options, title: screen.options.title ? t(screen.options.title) : screen.options.title } : undefined} />)}
    </Stack.Protected>
    {sharedScreens.map((screen) => <Stack.Screen key={screen.name} {...screen} options={{ ...screen.options, title: t(screen.options.title) }} />)}
    <Stack.Protected guard={__DEV__}>
      {developmentScreens.map((screen) => <Stack.Screen key={screen.name} {...screen} options={{ ...screen.options, title: t(screen.options.title) }} />)}
    </Stack.Protected>
  </Stack>;
}
