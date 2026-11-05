import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { ExpoRoot, Stack } from 'expo-router';
import type { RequireContext } from 'expo-router/build/types';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GatewayQueryProvider } from '../lib/gateway-query-provider';
import { NewConversationProvider } from '../lib/new-conversation-context.tsx';

const SceneContent = createContext<ReactNode>(null);
function SceneRoute() { return useContext(SceneContent); }

/** Real Expo Router navigation/focus context, with story content mounted as its route. */
export function SceneProviders({ children, path = '/', location = path, routes }: {
  children: ReactNode; path?: string; location?: string; routes?: Record<string, ComponentType>;
}) {
  const context = useMemo(() => {
    const modules: Record<string, unknown> = {
      './_layout.tsx': { default: () => <Stack screenOptions={{ headerShown: false }} /> },
      [`./${path === '/' ? 'index' : path.slice(1)}.tsx`]: { default: SceneRoute },
      ...Object.fromEntries(Object.entries(routes ?? {}).map(([route, Screen]) =>
        [`./${route === '/' ? 'index' : route.slice(1)}.tsx`, { default: Screen }])),
    };
    return Object.assign((key: string) => modules[key], {
      keys: () => Object.keys(modules), resolve: (key: string) => key, id: 'gallery',
    }) as RequireContext;
  }, [path, routes]);
  // ExpoRoot captures its initial location once. Changing a story's entry is a new route
  // visit; session/content updates within that visit must not reset its navigation stack.
  const root = useMemo(() => <ExpoRoot key={`${path}:${location}`} context={context} location={location} />, [context, path, location]);
  return <NewConversationProvider><GatewayQueryProvider><SceneContent.Provider value={children}><SafeAreaProvider>{root}</SafeAreaProvider></SceneContent.Provider></GatewayQueryProvider></NewConversationProvider>;
}
