import { focusManager } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { MemoryScope } from '../gateway/api.ts';
import type { ChatSession } from '../gateway/session.ts';
import { MemorySaveCheck } from './memory-save-check.ts';

const subscribeForeground = (listener: () => void) => focusManager.subscribe(listener);
const isForeground = () => focusManager.isFocused();

/** Recovery is owned by this resource visit, and runs only while focused and connected. */
export function useMemorySaveCheck(session: ChatSession, scope: MemoryScope, id: string) {
  const [check] = useState(() => new MemorySaveCheck(session, scope, id));
  const state = useSyncExternalStore(check.subscribe, check.getSnapshot);
  const foreground = useSyncExternalStore(subscribeForeground, isForeground);
  const online = session.connection === 'open';
  const revision = session.memoryRevisionFor(scope, id);
  useFocusEffect(useCallback(() => {
    check.focus(online && foreground, revision);
    return check.blur;
  }, [check, online, foreground, revision]));
  return { check, status: state.status };
}
