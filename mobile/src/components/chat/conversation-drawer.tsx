import { PortalHost } from '@rn-primitives/portal';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useId, useMemo, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { BackHandler, Keyboard, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import { Drawer } from 'react-native-drawer-layout';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCSSVariable } from 'uniwind';

import type { AgentSummary } from '@/gateway/api.ts';
import { newClientId } from '@/gateway/session.ts';
import { DrawerTransition, type DrawerCloseTicket } from '@/lib/drawer-flow.ts';
import { groupDrawerConversations } from '@/lib/drawer-dates.ts';
import { DrawerOverlayOwner, selectDrawerOverlay } from '@/lib/drawer-overlay.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { useMinuteClock } from '@/lib/use-minute-clock.ts';
import { userErrorMessage } from '@/lib/user-error.ts';
import { DrawerPanelView } from './conversation-drawer-view.tsx';

export type DrawerConversation = {
  id: string; title: string; unread: boolean; source?: 'user' | 'schedule';
  running: boolean; activityAt: number | null;
  /** Confirmed content without any user send / schedule trigger: sorts last, no time (conversation-drawer.P9). */
  unranked?: boolean;
  agent: { name: string; avatar: number };
  collaborationCount: number;
  reason?: string;
};
type Props = {
  children: ReactNode;
  open: boolean; closing: boolean; closeTicket: DrawerCloseTicket | null; drawerVisit: object;
  onOpen(): void; swipeEnabled?: boolean;
  agents: AgentSummary[]; connected: boolean; newConversationDisabled?: boolean;
  conversations: DrawerConversation[]; loadError?: string;
  currentId: string | undefined;
  onSelect(id: string): void; onNewConversation(): void;
  onRename(id: string, title: string): Promise<boolean>; onDelete(id: string): Promise<boolean>;
  failureMessage(): string | null; onRequestClose(): void;
};

const DRAWER_PATHS = { agents: '/agents', computer: '/settings-computer', search: '/search', settings: '/settings' } as const;

/** Library owns drawer motion. A started transition holds an immutable ticket, not a latest-owner callback. */
export function ConversationDrawer(props: Props) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const host = useId();
  const [transition] = useState(() => new DrawerTransition());
  useMountEffect(() => () => transition.cancel());
  const scrim = useCSSVariable('--color-scrim');
  const drawerWidth = width * 0.86;
  const configureGestureHandler = useCallback((gesture: Parameters<NonNullable<ComponentProps<typeof Drawer>['configureGestureHandler']>>[0]) =>
    gesture.withTestId('conversation-drawer-pan').activeOffsetX([-12, 12]).failOffsetY([-10, 10])
      .hitSlop(props.open ? { left: 0 } : { left: -20, width: Math.max(0, width - 20) }), [props.open, width]);
  // Drawer 4.2.12 skips transitionStart for a gesture close with velocity. Its onClose
  // updates controlled open; the ensuing toggle captures the ticket before transitionEnd.
  return <View testID="conversation-drawer-shell" className="flex-1" pointerEvents={props.closing ? 'box-only' : 'auto'} onStartShouldSetResponder={() => props.closing}>
    <Drawer open={props.open} onOpen={() => { if (!props.open) props.onOpen(); }}
      onClose={() => { if (props.open) props.onRequestClose(); }}
      onTransitionStart={closing => transition.start(closing, props.closeTicket)}
      onTransitionEnd={closing => transition.end(closing)}
      drawerType="front" drawerPosition="left" drawerStyle={{ width: drawerWidth }}
      overlayStyle={{ backgroundColor: scrim as string }} overlayAccessibilityLabel={t('关闭对话列表')}
      swipeEnabled={(props.swipeEnabled ?? true) && !props.closing} swipeEdgeWidth={width}
      swipeMinDistance={drawerWidth / 2} swipeMinVelocity={500} keyboardDismissMode="on-drag" configureGestureHandler={configureGestureHandler}
      renderDrawerContent={() => <DrawerPanel {...props} host={host} />}>
      {props.children}
    </Drawer>
    <View pointerEvents="box-none" className="absolute inset-0"><PortalHost name={host} /></View>
  </View>;
}

function DrawerPanel(props: Props & { host: string }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [owner] = useState(() => new DrawerOverlayOwner());
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const dispatch = owner.send;
  const { conversations, connected, open, currentId, drawerVisit } = props;
  // A new connected interval cannot revive a menu opened in a disconnected visit; drafts are independent.
  const menuVisit = useMemo(() => ({ connected }), [connected]);
  const targetExists = state.status !== 'closed' && conversations.some(item => item.id === state.target.id);
  const selection = selectDrawerOverlay(state, { open, connected, hasTarget: targetExists, menuVisit, drawerVisit });
  const now = useMinuteClock();
  const groups = useMemo(() => groupDrawerConversations(conversations, now), [conversations, now]);
  const cancel = () => { if (!selection.busy) { dispatch({ type: 'cancel' }); Keyboard.dismiss(); } };
  const { closing, onRequestClose } = props;
  useFocusEffect(useCallback(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selection.overlay) {
        // The visible native rename sheet owns close()/onClose, including hardware back.
        if (selection.overlay.status === 'renaming' || selection.overlay.status === 'saving' || selection.overlay.status === 'rename-closing') return false;
        if (!selection.busy) { dispatch({ type: 'cancel' }); Keyboard.dismiss(); }
        return true;
      }
      if (closing) return true;
      if (!open) return false;
      onRequestClose();
      return true;
    });
    return () => listener.remove();
  }, [selection.overlay, selection.busy, closing, open, onRequestClose, dispatch]));
  const openMenu = (conversation: DrawerConversation, event: GestureResponderEvent) => {
    if (!open || !connected || selection.busy) return;
    dispatch({ type: 'open-menu', target: { id: conversation.id, title: conversation.title || t('新对话'), drawerVisit },
      menuVisit,
      replacesMissing: !targetExists && state.status !== 'closed' ? state.target.id : undefined,
      point: { pageX: event.nativeEvent.pageX ?? 44, pageY: event.nativeEvent.pageY } });
  };
  const submit = async () => {
    const current = owner.getSnapshot();
    const admission = selectDrawerOverlay(current, { open, connected, drawerVisit, menuVisit,
      hasTarget: current.status !== 'closed' && conversations.some(item => item.id === current.target.id) });
    if (!admission.canSubmit || (current.status !== 'renaming' && current.status !== 'delete-confirm')) return false;
    const operationId = newClientId();
    const renaming = current.status === 'renaming';
    // The owner reduces synchronously before a command starts, including events in one React commit.
    if (!dispatch({ type: 'submit', operationId })) return false;
    try {
      const success = renaming ? await props.onRename(current.target.id, current.title.trim()) : await props.onDelete(current.target.id);
      if (success) dispatch({ type: 'succeeded', operationId });
      else dispatch({ type: 'failed', operationId, message: props.failureMessage() ?? t(renaming ? '重命名失败，请重试' : '删除失败，请重试') });
      return success;
    } catch (cause) {
      dispatch({ type: 'failed', operationId, message: userErrorMessage(cause, renaming ? '重命名失败，请重试' : '删除失败，请重试') });
      return false;
    }
  };
  return <DrawerPanelView agents={props.agents} connected={connected} groups={groups} currentId={currentId} now={now} insets={insets}
    loadError={props.loadError} newConversationDisabled={props.newConversationDisabled}
    onNavigate={target => { props.onRequestClose(); router.push(DRAWER_PATHS[target]); }}
    onSelect={id => { if (open && !selection.overlay) props.onSelect(id); }}
    onMenu={openMenu} onNewConversation={() => { if (open) props.onNewConversation(); }}
    overlays={{ overlay: selection.overlay, host: props.host, busy: selection.busy, canSubmit: selection.canSubmit,
      onRename: () => dispatch({ type: 'rename' }), onDelete: () => dispatch({ type: 'delete' }), onDismissMenu: () => dispatch({ type: 'dismiss-menu' }),
      onCancel: cancel, onRenameClosing: target => dispatch({ type: 'rename-closing', target }),
      onRenameClosed: target => dispatch({ type: 'rename-closed', target }),
      onChange: title => dispatch({ type: 'change', title }), onSubmit: submit }} />;
}
