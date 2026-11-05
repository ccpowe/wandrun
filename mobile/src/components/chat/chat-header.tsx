import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useReducer } from 'react';
import { BackHandler, Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { ChatHeaderView } from './chat-header-view.tsx';
import { ConversationCard, type ConversationCardTask } from './conversation-card.tsx';
import { CHAT_SPRINGS } from './chat-motion.ts';
import type { AgentSummary } from '@/gateway/api.ts';
import type { ChatSession, TaskView } from '@/gateway/session.ts';
import { branchNeedsAttention } from '@/lib/chat-branches.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { newClientId } from '@/gateway/session.ts';
import { collaborationPanelReducer } from '@/lib/chat-header-intent.ts';
import { chatLocation } from '@/lib/chat-route.ts';
import { returnToConversation } from '@/lib/chat-navigation.ts';

type Props = {
  agent: AgentSummary | undefined;
  title: string;
  onOpenConversations?: () => void;
  collaboration?: { creatorName: string; rootId: string; rootTitle: string };
  working: boolean;
  newConversationDisabled: boolean;
  onNewConversation?: () => void;
  session?: ChatSession;
  tasks?: TaskView[];
  /** Initial local presentation only; resource data still comes from the gateway. */
  initialCardOpen?: boolean;
};

/** Capsule interaction owns its local panel, never fabricates task or loading state. */
export function ChatHeader(props: Props) {
  return <ChatHeaderControl key={`${props.agent?.id ?? ''}:${!!props.tasks?.length}`} {...props} />;
}

function ChatHeaderControl({ agent, title, onOpenConversations, collaboration, working, newConversationDisabled, onNewConversation, session, tasks = [], initialCardOpen = false }: Props) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const [panel, dispatch] = useReducer(collaborationPanelReducer, initialCardOpen && tasks.length
    ? { status: 'open', visitId: 'initial' } : { status: 'closed' });
  const cardOpen = panel.status === 'open';
  const cardMounted = panel.status !== 'closed';
  const progress = useSharedValue(cardOpen ? 1 : 0);
  const close = useCallback(() => {
    if (panel.status !== 'open') return;
    const visitId = panel.visitId;
    dispatch({ type: 'close' });
    progress.set(withSpring(0, CHAT_SPRINGS.morph, (finished) => {
      if (finished) scheduleOnRN(dispatch, { type: 'closed', visitId });
    }));
  }, [panel, progress]);
  useFocusEffect(useCallback(() => {
    if (!cardMounted) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => subscription.remove();
  }, [cardMounted, close]));
  const sideStyle = useAnimatedStyle(() => ({ opacity: 1 - 0.65 * Math.max(0, Math.min(1, progress.value)) }));
  const profile = () => {
    close();
    if (agent) router.push({ pathname: '/agents/[id]', params: { id: agent.id } });
  };
  const subtitle = collaboration
    ? t('{creator} 发起 · {title}', { creator: collaboration.creatorName, title: collaboration.rootTitle || t('新对话') })
    : title || t('新对话');
  const requested = new Set([...session?.browserTasks.values() ?? []].filter(lease => lease.state === 'requested').map(lease => lease.task_id));
  const cardTasks: ConversationCardTask[] = session ? tasks.map(task => {
    const member = session.agents.agents.find(item => item.id === task.agent_id);
    return { id: task.id, title: task.title, member: { name: member?.name ?? task.agent_id, avatar: member?.avatar ?? 0 },
      status: requested.has(task.id) ? 'requested' : task.status, activityAt: task.updated_at,
      attention: branchNeedsAttention(session, task), working: !!task.branch_working };
  }) : [];
  return <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
    {cardMounted && <>
      <View style={StyleSheet.absoluteFill}>
        <Pressable testID="chat-card-dismiss" accessibilityRole="button" accessibilityLabel={t('收起协作卡片')} onPress={close} className="absolute inset-0" />
      </View>
    </>}
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
      <ChatHeaderView agent={agent} subtitle={subtitle} working={working}
        onOpenConversations={onOpenConversations} onBack={collaboration ? () => returnToConversation(navigation, collaboration.rootId) : undefined}
        newConversationDisabled={newConversationDisabled} onNewConversation={onNewConversation}
        onAgentPress={profile} childCount={tasks.length} cardExpanded={cardOpen}
        childAttention={cardTasks.some(task => task.attention)}
        wrapSideControl={(control) => <Animated.View pointerEvents={cardMounted ? 'none' : 'auto'} style={sideStyle}>{control}</Animated.View>}
        onChildrenPress={() => {
          if (cardOpen) { close(); return; }
          dispatch({ type: 'open', visitId: newClientId() }); progress.set(withSpring(1, CHAT_SPRINGS.morph));
        }} />
      {cardMounted && session && agent && <View className="mt-1">
        <ConversationCard tasks={cardTasks} progress={progress} now={new Date()}
          onSelect={(id) => { close(); router.push(chatLocation(id)); }} />
      </View>}
    </View>
  </View>;
}
