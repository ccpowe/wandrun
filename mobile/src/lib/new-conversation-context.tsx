import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { NewConversationStore, memoryNewConversation } from './new-conversation.ts';
import { useMountEffect } from './use-mount-effect.ts';

const Context = createContext<NewConversationStore | null>(null);

/** One draft per App host; stories receive an isolated memory store at the same boundary. */
export function NewConversationProvider({ children, store: supplied }: { children: ReactNode; store?: NewConversationStore }) {
  const [store] = useState(() => supplied ?? memoryNewConversation());
  useMountEffect(() => { store.restore(); return () => {}; });
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useNewConversationStore(): NewConversationStore {
  const store = useContext(Context);
  if (!store) throw new Error('NewConversationProvider is required');
  return store;
}
export function useNewConversation() {
  const store = useNewConversationStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
