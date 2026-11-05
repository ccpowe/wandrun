import { t } from './i18n.ts';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Keyboard } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';

import type { DrawerConversation } from '@/components/chat/conversation-drawer.tsx';
import type { ChatSession } from '@/gateway/session.ts';
import { DrawerFlow } from '@/lib/drawer-flow.ts';
import { chatLocation } from '@/lib/chat-route.ts';
import { agentDisplayName } from '@/lib/agent-display-name.ts';
import { rootBranches } from '@/lib/chat-branches.ts';
import { conversationActivityOrder } from '@/lib/conversation-activity.ts';
import { LoadResource } from '@/lib/load-state.ts';
import { useNewConversationStore } from '@/lib/new-conversation-context.tsx';

const noSessionSubscribe = () => () => {};
const noSessionVersion = () => 0;

/** One Flow per route/focus identity; cleanup revokes only this visit's closing/navigation. */
export function useConversationDrawer(session: ChatSession | null, currentId: string | undefined, agentId: string | undefined, focused: boolean, initialOpen = false, onNavigate?: (id?: string) => void, targetVisits?: { subscribe(changed: () => void): () => void }) {
  const newDraft = useNewConversationStore();
  const showTarget = useCallback((id?: string) => {
    if (onNavigate) onNavigate(id);
    else router.replace(chatLocation(id));
  }, [onNavigate]);
  const flow = useMemo(() => new DrawerFlow({
    hasConversation: id => !!session?.chat(id),
    dismissKeyboard: KeyboardController.dismiss,
    navigate: id => showTarget(id),
  }, initialOpen && focused), [session, focused, initialOpen, showTarget]);
  const subscribe = useCallback((changed: () => void) => {
    const stopFlow = flow.subscribe(changed);
    const stopTargets = targetVisits?.subscribe(() => flow.reset());
    return () => { stopTargets?.(); stopFlow(); };
  }, [flow, targetVisits]);
  const snapshot = useSyncExternalStore(subscribe, flow.getSnapshot);
  // Conversations and leases remain session facts, never copied into drawer state.
  useSyncExternalStore(session?.subscribe ?? noSessionSubscribe, session?.getVersion ?? noSessionVersion);
  useFocusEffect(useCallback(() => {
    if (!focused) return;
    flow.activate(initialOpen);
    return () => flow.deactivate();
  }, [flow, focused, initialOpen]));

  const agentIds = session?.agents.agents.map(agent => agent.id).join('\n') ?? '';
  // These reads merge watermarked collaboration facts into session; they are not a second JSON cache.
  const collaborations = useMemo(() => agentIds.split('\n').filter(Boolean).map(id => new LoadResource(async () => {
    if (!session) return;
    await session.refreshCollaborations(id);
    const error = session.collaborationErrors.get(id);
    if (error) throw new Error(error);
  })), [session, agentIds]);
  const connected = session?.connection === 'open';
  useFocusEffect(useCallback(() => {
    if (!connected || !focused) return;
    for (const resource of collaborations) { resource.start(); void resource.retry(); }
    return () => { for (const resource of collaborations) resource.stop(); };
  }, [collaborations, connected, focused]));

  const agents = session?.agents.agents ?? [];
  const requested = new Set<string>();
  for (const lease of session?.browserTasks.values() ?? []) {
    if (lease.state === 'requested') requested.add(lease.root_id);
  }
  const conversations: DrawerConversation[] = session ? [...session.conversations.values()]
    .filter(conversation => conversation.last_text !== null || session.pendingFor(conversation.id).length > 0)
    .sort(conversationActivityOrder).map(conversation => {
      const agent = agents.find(item => item.id === conversation.agent_id);
      const branches = rootBranches(session, conversation.id);
      return {
        id: conversation.id, title: conversation.title, source: conversation.source,
        activityAt: conversation.last_activity_at,
        // An unconfirmed first send (pending) outranks this: it belongs to E7, not “earlier”.
        unranked: conversation.last_activity_seq === null && conversation.last_text !== null &&
          session.pendingFor(conversation.id).length === 0,
        running: session.isWorking(conversation.id),
        // conversation-drawer.B5 / P6: AI reply not yet seen, failure and takeover requests all light the same dot; none moves the row.
        unread: conversation.id !== currentId &&
          (conversation.unread || branches.attention || conversation.status === 'failed' || requested.has(conversation.id)),
        agent: { name: agentDisplayName(session.agents, conversation.agent_id), avatar: agent?.avatar ?? 0 },
        collaborationCount: branches.count,
        reason: requested.has(conversation.id) ? t('等你接管') : conversation.source === 'schedule' ? t('定时') : undefined,
      };
    }) : [];
  const show = () => {
    if (!focused) return;
    Keyboard.dismiss();
    if (connected) for (const resource of collaborations) void resource.retry();
    flow.show();
  };
  // Freeze the user's command at the click, not the route id at Flow construction.
  const newConversation = () => {
    if (!focused) return;
    flow.newConversation(() => {
      if (!session || !agentId || currentId === undefined) return;
      newDraft.select(session.api.config.computerId!, agentId);
      showTarget();
    });
  };
  return {
    show,
    newConversation,
    drawerProps: {
      open: focused && snapshot.open,
      closing: focused && snapshot.closing,
      closeTicket: snapshot.closeTicket,
      drawerVisit: snapshot.drawerVisit,
      agents, connected,
      newConversationDisabled: !agentId,
      conversations,
      loadError: session ? [...session.collaborationErrors.values()][0] : undefined,
      onRename: (id: string, title: string) => session?.renameConversation(id, title) ?? Promise.resolve(false),
      onDelete: (id: string) => session?.deleteConversation(id) ?? Promise.resolve(false),
      failureMessage: () => session?.notice ?? null,
      currentId,
      onSelect: (id: string) => { if (focused) flow.select(id, currentId); },
      onNewConversation: newConversation,
      onRequestClose: () => flow.requestClose(),
    },
  };
}
