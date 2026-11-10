import { useFocusEffect } from 'expo-router';
import { useRoute } from 'expo-router/react-navigation';
import { useCallback, useState } from 'react';
import type { ChatSession } from '../gateway/session.ts';
import { cleanupResultMessage, type CleanupResult } from './cleanup-result.ts';

/** Claim transfers ownership out of the session. Blur discards the visit, including a masked result. */
export function useCleanupResult(session: ChatSession, blocked: boolean, eligible = true): string | null {
  const route = useRoute();
  const [entry, setEntry] = useState<{ result: CleanupResult; shownAt?: number } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!eligible) return;
    const claim = () => {
      const result = session.cleanupResults.claim(route.key);
      if (result) setEntry({ result });
    };
    const unsubscribe = session.cleanupResults.subscribe(claim);
    claim();
    return () => { unsubscribe(); setEntry(null); };
  }, [session, route.key, eligible]));
  const result = entry?.result;
  const firstShownAt = entry?.shownAt;
  useFocusEffect(useCallback(() => {
    if (!result || blocked) return;
    const shownAt = firstShownAt ?? Date.now();
    if (firstShownAt === undefined) setEntry({ result, shownAt });
    const timer = setTimeout(() => setEntry(current => current?.result === result ? null : current), Math.max(0, 5000 - (Date.now() - shownAt)));
    return () => clearTimeout(timer);
  }, [result, blocked, firstShownAt]));
  return result && !blocked && eligible ? cleanupResultMessage(result.kind) : null;
}
