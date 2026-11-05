import { router, useFocusEffect } from 'expo-router';
import { useCallback, useSyncExternalStore } from 'react';
import type { MemoryScope } from '@/gateway/api.ts';
import type { ChatSession } from '@/gateway/session.ts';
import { memoryModified } from '@/lib/agent-memory.ts';
import { agentDisplayName } from '@/lib/agent-display-name.ts';
import { useMemory } from '@/lib/use-memory.ts';
import { ConnectionBanner } from '@/lib/connection-banner.tsx';
import { MemoryReaderView, type MemoryReaderPage } from './memory-reader-view.tsx';

/** Index readers and summaries consume the same Query key; work deletion owns only focused navigation. */
export function MemorySection({ scope, id, session, focused, renderPage }: { scope: MemoryScope; id: string; session: ChatSession; focused: boolean; renderPage?: MemoryReaderPage }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const { memory, error, notFound } = useMemory(session, scope, id, focused);
  const gone = scope === 'work' && (notFound || session.agents.deletedIds.has(id));
  useFocusEffect(useCallback(() => { if (gone) router.dismissTo('/'); }, [gone]));
  return <MemoryReaderView scope={scope} memory={memory} error={!!error} online={session.connection === 'open'} renderPage={renderPage}
    modified={memory ? memoryModified(memory, scope === 'work' ? agentDisplayName(session.agents, id) : undefined) : null}
    connectionBanner={<ConnectionBanner session={session} />} onEdit={() => router.push({ pathname: '/memory-editor', params: { scope, id } })}
    onOpen={slug => router.push({ pathname: '/memory-detail', params: { scope, id, slug } })} />;
}
