import { useNavigation, useRoute, type NativeStackNavigationProp } from 'expo-router';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { ChatVisit, type ChatRouteTarget, type ChatVisitLease } from './chat-visit.ts';
import { useMountEffect } from './use-mount-effect.ts';

/** The public navigator state event invalidates permissions before a late command can claim a new target. */
export function useChatVisit(initialTarget: ChatRouteTarget) {
  const navigation = useNavigation<NativeStackNavigationProp<{ chat: { id?: string; message_seq?: string } }>>();
  const route = useRoute();
  const [visit] = useState(() => new ChatVisit(initialTarget));
  const readTarget = useCallback((): ChatRouteTarget | null | undefined => {
    const state = navigation.getState();
    if (!state) return undefined;
    const current = state.routes.find(item => item.key === route.key);
    if (!current) return null;
    const params = current.params;
    return { id: params?.id, messageSeq: params?.message_seq ? Number(params.message_seq) : undefined };
  }, [navigation, route.key]);
  useMountEffect(() => {
    const deactivate = visit.activate();
    const admit = () => {
      const target = readTarget();
      if (target !== undefined) visit.admit(target);
    };
    const unsubscribe = navigation.addListener('state', admit);
    admit();
    return () => { unsubscribe(); deactivate(); };
  });
  const generation = useSyncExternalStore(visit.subscribe, visit.getSnapshot, visit.getSnapshot);
  const canProject = useCallback((lease: ChatVisitLease) => {
    const target = readTarget();
    return !!target && visit.allows(lease) && visit.matches(target);
  }, [readTarget, visit]);
  const changeTarget = useCallback((id?: string) => {
    // An explicit drawer intent revokes the old result before asking the navigator to commit it.
    visit.admit({ id });
    navigation.setParams({ id, message_seq: undefined });
  }, [visit, navigation]);
  return { visit, generation, navigation, canProject, changeTarget };
}
