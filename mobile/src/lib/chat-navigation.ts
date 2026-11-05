import { router } from 'expo-router';
import { chatLocation } from './chat-route.ts';
type NavigationReader = { getState(): { index: number; routes: readonly { name: string; params?: object }[] } | undefined };

/** POP_TO matches a screen name without getId. Return by public stack position instead, retaining the original root key. */
export function returnToConversation(navigation: NavigationReader, id: string): void {
  const state = navigation.getState();
  if (state) {
    const current = state.routes[state.index];
    const currentParams = current?.params;
    if (current?.name === 'chat' && currentParams && 'id' in currentParams && currentParams.id === id) return;
    for (let index = state.index - 1; index >= 0; index--) {
      const route = state.routes[index];
      const params = route.params;
      if (route.name === 'chat' && params && 'id' in params && params.id === id) {
        router.dismiss(state.index - index);
        return;
      }
    }
  }
  router.replace(chatLocation(id));
}
