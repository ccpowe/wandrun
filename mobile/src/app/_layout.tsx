import "../../global.css";

import { PortalHost } from "@rn-primitives/portal";
import { router, Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { NavigationBar } from "expo-navigation-bar";
import * as SystemUI from "expo-system-ui";
import { useReducer } from "react";
import { useCSSVariable, useUniwind } from "uniwind";
import { ActivityIndicator, View } from "react-native";

import { SessionProvider, useGateway, useSession } from "@/lib/session-context.tsx";
import { authenticatedScreens, developmentScreens, sharedScreens } from "@/lib/root-stack-routes.ts";
import { AppearanceProvider } from "@/lib/appearance-context.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { navigationAdmissionReducer } from "@/lib/navigation-admission.ts";
import { useMountEffect } from "@/lib/use-mount-effect.ts";
import { StatusBarTheme } from "@/lib/use-status-bar-appearance.tsx";
import { NewConversationProvider, useNewConversationStore } from "@/lib/new-conversation-context.tsx";
import { nativeNewConversation } from "@/lib/new-conversation-storage.ts";
import type { ChatSession } from "@/gateway/session.ts";

const newConversation = nativeNewConversation();

export default function RootLayout() {
  return <AppearanceProvider><NewConversationProvider store={newConversation}><ThemedApp /></NewConversationProvider></AppearanceProvider>;
}

function ThemedApp() {
  const { theme } = useUniwind();
  const background = useCSSVariable("--color-background") as string;
  const barStyle = theme === "dark" ? "light" : "dark";
  // enforceContrast is a native resource in standalone builds (rebuild required).
  // Expo Go also reads it from the manifest; Fast Refresh does not reload that config.
  return (
    // 应用已是 edge-to-edge：状态栏与导航栏都声明透明，库给出的键盘高度含导航栏（与 iOS 含 home indicator 一致）。
    // 左滑行（ReanimatedSwipeable）要求手势根视图。
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: background }}>
    <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
    <NativeBackground key={background} background={background} />
    <SessionProvider>
      <StatusBarTheme />
      <NavigationBar style={barStyle} />
      <AppStack />
      <PortalHost />
    </SessionProvider>
    </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function NativeBackground({ background }: { background: string }) {
  useMountEffect(() => {
    // Edge-to-edge bars reveal this native window background, not Expo Go's launch screen.
    void SystemUI.setBackgroundColorAsync(background);
    return () => {};
  });
  return null;
}

function AppStack() {
  const { ready, sessionKey, config } = useGateway();
  const session = useSession();
  if (!ready) return <View className="flex-1 items-center justify-center bg-background"><ActivityIndicator /></View>;
  return <>
    {session && <NewDraftSession key={session.queryIdentity} session={session} />}
    <SessionStack key={sessionKey} paired={!!config && sessionKey !== 0} />
  </>;
}

/** Event-store replacement revokes a first action even when its page is not focused. */
function NewDraftSession({ session }: { session: ChatSession }) {
  const draft = useNewConversationStore();
  useMountEffect(() => {
    let version = session.storeVersion;
    return session.subscribe(() => {
      if (session.storeVersion === version) return;
      version = session.storeVersion;
      if (session.api.config.computerId) draft.invalidateAttempt(session.api.config.computerId);
    });
  });
  return null;
}

function SessionStack({ paired }: { paired: boolean }) {
  const { t } = useTranslation();
  const [admission, dispatch] = useReducer(navigationAdmissionReducer, "clearing");
  return <Stack screenOptions={{ orientation: "portrait" }} screenListeners={{ state: ({ data }) => {
    // This is the navigator's committed state event, not a frame-count assumption.
    if (!paired) return;
    if (admission === "clearing" && !data.state.routes.some(route => authenticatedScreens.some(screen => screen.name === route.name))) {
      dispatch({ type: "history-cleared" });
    } else if (admission === "opening") {
      dispatch({ type: "admission-committed" });
      router.replace("/");
    }
  } }}>
    <Stack.Protected guard={paired && admission !== "clearing"}>
      {authenticatedScreens.map((screen) => <Stack.Screen key={screen.name} {...screen} options={screen.options ? { ...screen.options, title: screen.options.title ? t(screen.options.title) : screen.options.title } : undefined} />)}
    </Stack.Protected>
    {sharedScreens.map((screen) => <Stack.Screen key={screen.name} {...screen} options={{ ...screen.options, title: t(screen.options.title) }} />)}
    <Stack.Protected guard={__DEV__}>
      {developmentScreens.map((screen) => <Stack.Screen key={screen.name} {...screen} options={{ ...screen.options, title: t(screen.options.title) }} />)}
    </Stack.Protected>
  </Stack>;
}
