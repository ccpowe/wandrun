import { Redirect, router, Stack, useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { AgentListView } from '@/components/agent-list-view.tsx';
import type { ChatSession } from '@/gateway/session.ts';
import { selectAgentList } from '@/lib/agent-list-state.ts';
import { ConnectionBanner, useConnectionLabel } from '@/lib/connection-banner.tsx';
import { useSession } from '@/lib/session-context.tsx';
import { useFocusedVisit } from '@/lib/use-focused-visit.ts';
import { CleanupResultNotice } from '@/components/cleanup-result-notice.tsx';
import { useCleanupResult } from '@/lib/use-cleanup-result.ts';

export default function AgentsRoute() {
  const session = useSession();
  return session ? <AllAgentsScreen session={session} /> : <Redirect href="/" />;
}
export function AllAgentsScreen({ session }: { session: ChatSession }) {
  return <AgentListContainer key={session.queryIdentity} session={session} />;
}

/** Session owns the directory and root activity; this page only projects them and navigates. */
function AgentListContainer({ session }: { session: ChatSession }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const list = session.agents;
  const focused = useIsFocused();
  const captureVisit = useFocusedVisit();
  const connectionLabel = useConnectionLabel(session);
  // Native Swipeable handles only; close revealed actions when leaving this page.
  const openSwipes = useRef(new Set<() => void>());
  const swipeChanged = useCallback((open: boolean, close: () => void) => {
    if (open) openSwipes.current.add(close); else openSwipes.current.delete(close);
  }, []);
  const closeSwipes = useCallback(() => { openSwipes.current.forEach(close => close()); openSwipes.current.clear(); }, []);
  const selection = selectAgentList({
    agents: list.agents, conversations: session.conversations.values(),
    offline: session.connection !== 'open', focused, loaded: list.loaded, readError: list.error,
  });
  const cleanupMessage = useCleanupResult(session, session.connection !== 'open' || !!selection.readError);
  useFocusEffect(useCallback(() => {
    list.refresh();
    return closeSwipes;
  }, [list, closeSwipes]));
  const back = useCallback(() => { closeSwipes(); router.back(); }, [closeSwipes]);
  const open = useCallback((id: string) => {
    if (!captureVisit()() || session.agents.deletedIds.has(id)) return;
    closeSwipes();
    router.push({ pathname: '/agents/[id]', params: { id } });
  }, [session, captureVisit, closeSwipes]);
  const edit = useCallback((id: string) => {
    if (!captureVisit()() || session.connection !== 'open' || session.agents.deletedIds.has(id)) return;
    closeSwipes();
    router.push({ pathname: '/agent-editor', params: { id } });
  }, [session, captureVisit, closeSwipes]);
  const add = () => {
    if (!captureVisit()() || session.connection !== 'open') return;
    closeSwipes();
    session.editorOperations.beginCreationVisit('agent');
    router.push('/agent-editor');
  };
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <AgentListView selection={selection} showFeedback={!connectionLabel} connectionBanner={<><ConnectionBanner session={session} /><CleanupResultNotice message={cleanupMessage} /></>}
      onBack={back} onAdd={add} onOpen={open} onEdit={edit} onSwipeChange={swipeChanged} />
  </>;
}
