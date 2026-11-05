import { useIsFocused } from 'expo-router';
import { useMemo, useSyncExternalStore } from 'react';
import { NoticeDeadline } from './notice-deadline.ts';

/** A semantic state identity owns a display lease only during this focused page visit. */
export function useDelayedNotice(identity: string | null) {
  const focused = useIsFocused();
  const current = focused ? identity : null;
  const deadline = useMemo(() => new NoticeDeadline(() => current), [current]);
  return useSyncExternalStore(deadline.subscribe, deadline.snapshot, deadline.snapshot);
}
