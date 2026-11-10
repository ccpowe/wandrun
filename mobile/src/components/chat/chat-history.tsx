import { useFocusEffect, useIsFocused } from 'expo-router';
import { type LegendListRef, type ViewToken } from '@legendapp/list/react-native';
import type { useKeyboardChatComposerInset } from '@legendapp/list/keyboard';
import { ArrowDown } from 'lucide-react-native';
import { useCallback, useImperativeHandle, useMemo, useReducer, useState, useSyncExternalStore, type Dispatch, type Ref, type RefObject } from 'react';
import { View } from 'react-native';
import { KeyboardController, KeyboardStickyView } from 'react-native-keyboard-controller';
import { useDerivedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatFade } from './chat-fade.tsx';
import { ChatLocalNoticeView, ChatNotices } from './chat-notices.tsx';
import { ChatTimelineList } from './chat-timeline-list.tsx';
import { MessageActions } from './message-actions.tsx';
import { MessageRow } from './message-row.tsx';
import { ProgressRow } from './progress-row.tsx';
import { TypingDots } from './typing-dots.tsx';
import { CHAT_FLOATING_SURFACE, CHAT_LAYOUT, chatBottomLayout } from './chat-surface.ts';
import { Icon } from '@/components/ui/icon.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Text } from '@/components/ui/text.tsx';
import type { ChatSession } from '@/gateway/session.ts';
import { buildChatNotices, type ChatLocalNotice } from '@/lib/chat-notices.ts';
import { chatRowsEqual, rowLayout } from '@/lib/chat-row-equality.ts';
import { isMessageTarget, type ChatRow, type TurnState } from '@/lib/chat-timeline.ts';
import { chatPinAnchorKey, chatPinFrozen, chatPinHolds, chatPinKeepsIdleRow, chatPinReducer, initialChatPin } from '@/lib/chat-pin.ts';
import { ChatTargetSeek, chatTargetReducer, initialChatTarget, selectChatTarget, type ChatTargetEvent } from '@/lib/chat-target.ts';
import { useConnectionLabel } from '@/lib/connection-banner.tsx';
import { useTranslation } from '@/lib/i18n.ts';
import { LoadResource } from '@/lib/load-state.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { useDelayedNotice } from '@/lib/use-delayed-notice.ts';
import { CleanupResultNotice } from '@/components/cleanup-result-notice.tsx';
import { useCleanupResult } from '@/lib/use-cleanup-result.ts';

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 25 };
const FOLLOW_AT_END = { animated: false };
const LIST_CONTENT = { paddingHorizontal: CHAT_LAYOUT.contentInsetHorizontal, paddingBottom: CHAT_LAYOUT.listBottomGap };
const MESSAGE_SPACING = { paddingTop: 12 };
/** Gap between the header (or banner) bottom and the first readable content; with no banner it is the list's paddingTop. */
const CONTENT_TOP_GAP = 10;
const WORKING_CONTENT = { gap: 12 };
const HIDDEN = { opacity: 0 };
const noSeek = { subscribe: () => () => {}, getSnapshot: () => false };

function messageItemType(item: ChatRow) {
  if (item.pending) return 'message.user';
  if (item.draft) return 'message.agent';
  if (item.browser) return 'browser';
  if (item.delegation) return 'delegation';
  if (item.kind === 'working') return 'working';
  return item.event?.type ?? 'event';
}
function TargetHighlightExpiry({ placement, onExpire }: { placement: number; onExpire: Dispatch<ChatTargetEvent> }) {
  useMountEffect(() => {
    const timer = setTimeout(() => onExpire({ type: 'highlight-expired', placement }), 2500);
    return () => clearTimeout(timer);
  });
  return null;
}

/** Leading space of a row; the renderer and the pin's anchor offset share this one rule. */
function messageSpacing(items: ChatRow[], index: number) {
  return index > 0 && !items[index].delegation && !items[index - 1].delegation ? MESSAGE_SPACING : undefined;
}

export type ChatHistoryHandle = {
  /** A local send was accepted (pending row or prepared first message with this client id exists). */
  beginSend(clientId: string): void;
};
type Props = {
  session: ChatSession;
  id?: string;
  messageSeq?: number;
  list: RefObject<LegendListRef | null>;
  handleRef: Ref<ChatHistoryHandle>;
  composerMeasured: boolean;
  composerHeight: number;
  contentInsetEndAdjustment: ReturnType<typeof useKeyboardChatComposerInset>['contentInsetEndAdjustment'];
  rows: ChatRow[];
  turn: TurnState;
  canDiscardFirst: boolean;
  notice: ChatLocalNotice | null;
  onDismissNotice(): void;
  onQuote(text: string): void;
  onRetryPending(clientId: string): void;
  onDiscardPending(clientId: string): void;
  onRetryCreation?: () => void;
};

/** Target-specific reading/placement state. The outer screen and Composer are not under its key.
 * A local first bubble is list data only: no invented id is passed to session/history/uploads.
 */
export function ChatHistory({ session, id, messageSeq, list, handleRef, composerMeasured, composerHeight, contentInsetEndAdjustment,
  rows: projected, turn, canDiscardFirst, notice, onDismissNotice, onQuote, onRetryPending, onDiscardPending, onRetryCreation }: Props) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const bottom = chatBottomLayout(composerHeight, insets.bottom);
  const [listGeneration, setListGeneration] = useState(0);
  const [topOverlayHeight, setTopOverlayHeight] = useState(0);
  const [visibleCards, setVisibleCards] = useState<Set<string>>(new Set());
  const [intent, dispatchTarget] = useReducer(chatTargetReducer, messageSeq, initialChatTarget);
  const soughtSeq = intent.status === 'seeking' ? intent.seq : null;
  const seek = useMemo(() => id && soughtSeq !== null ? new ChatTargetSeek(session, id, soughtSeq) : null, [session, id, soughtSeq]);
  const missing = useSyncExternalStore(seek?.subscribe ?? noSeek.subscribe, seek?.getSnapshot ?? noSeek.getSnapshot);
  useFocusEffect(useCallback(() => seek?.activate(), [seek]));
  const connection = session.connection;
  useFocusEffect(useCallback(() => id && connection !== 'listing' ? session.view(id) : undefined, [session, id, connection]));
  const conversation = id ? session.chat(id) : undefined;
  const timeline = id ? session.timeline(id) : undefined;
  const task = id ? session.tasks.get(id) : undefined;
  const taskError = id ? session.taskErrors.get(id) : undefined;
  const [pin, dispatchPin] = useReducer(chatPinReducer, initialChatPin);
  // The pinned row can disappear (a failed send that the user deletes, chat.T42): then there is no anchor, and hold, keyboard
  // freeze and the idle placeholder must not outlive it. All three derive from "the anchor row exists".
  const anchorKey = chatPinAnchorKey(pin);
  const anchorExists = anchorKey !== null && projected.some(row => row.key === anchorKey);
  // chat.C9b / T41: when the turn ends while the pinned end space exists, the working row stays (same key) as an invisible
  // copy of its last content, so its height stays the real one. Removing it shrinks the content before the end space grows
  // back, and the native clamp drops the pinned message. Knowing that the turn *ended* needs the previous render's value:
  // this is React's documented "adjust state while rendering" pattern (react.dev useState, "Storing information from
  // previous renders"): it only updates this component's own state, is guarded by the comparison, and `turn-ended` is
  // idempotent (approved exception: mobile/docs/react-guidelines.md §3). A pure derivation cannot tell "ended" from "never worked" (a failed send must leave no blank).
  const [seen, setSeen] = useState({ working: turn.working, label: turn.label });
  if (turn.working ? !seen.working || seen.label !== turn.label : seen.working) {
    setSeen({ working: turn.working, label: turn.working ? turn.label : seen.label });
    if (!turn.working) dispatchPin({ type: 'turn-ended' });
  }
  const idleRow = chatPinKeepsIdleRow(pin) && anchorExists && !turn.working;
  const idleLabel = seen.label;
  const items = useMemo(() => idleRow ? [...projected, { kind: 'working', key: 'working', label: idleLabel, idle: true } as ChatRow] : projected,
    [projected, idleRow, idleLabel]);
  // Working is local list content, never a message/seq or a target's last content item.
  const contentItemCount = items.length - (turn.working || idleRow ? 1 : 0);
  const targetIndex = messageSeq === undefined ? -1 : items.findIndex(item => isMessageTarget(item, messageSeq));
  const subscribeToEnd = useCallback((notify: () => void) => {
    if (!listGeneration || !list.current) return () => {};
    return list.current.getState().listen('isAtEnd', notify);
  }, [listGeneration, list]);
  const getAtEnd = useCallback(() => !listGeneration || (list.current?.getState().isAtEnd ?? false), [listGeneration, list]);
  const atEnd = useSyncExternalStore(subscribeToEnd, getAtEnd, getAtEnd);
  const target = selectChatTarget(intent, { missing, historyFailed: timeline?.historyError !== undefined, targetIndex, itemCount: contentItemCount });
  const mode = !target.reading && atEnd ? 'FOLLOW' : 'READ';
  const cancelTarget = useCallback(() => dispatchTarget({ type: 'cancel' }), []);
  const holdEnd = chatPinHolds(pin) && anchorExists;
  const freezeKeyboard = chatPinFrozen(pin) && anchorExists;
  const freeze = useDerivedValue(() => freezeKeyboard, [freezeKeyboard]);
  const userTookOver = useCallback(() => { cancelTarget(); dispatchPin({ type: 'user-navigation' }); }, [cancelTarget]);
  const returnToBottom = useCallback(() => { userTookOver(); void list.current?.scrollToEnd({ animated: false }); }, [userTookOver, list]);
  // Rich-interaction submissions keep their old take-over: back to the end when reading, otherwise just end the target.
  const takeOverAfterUiSubmit = useCallback(() => { if (mode === 'READ') returnToBottom(); else userTookOver(); }, [mode, returnToBottom, userTookOver]);
  const beginSend = useCallback((clientId: string) => {
    cancelTarget();
    dispatchPin({ type: 'send', clientId });
    // The official anchored-end-space send: one animated end request now (the new message slides up, as in the official helper), no second scroll on dismiss or ready.
    void list.current?.scrollToEnd({ animated: true });
    void KeyboardController.dismiss().then(() => dispatchPin({ type: 'keyboard-closed', clientId }));
  }, [cancelTarget, list]);
  useImperativeHandle(handleRef, () => ({ beginSend }), [beginSend]);
  const historyFailed = timeline?.historyError !== undefined;
  const historyRetry = useMemo(() => new LoadResource(async () => {
    if (!id) return;
    await session.loadOlder(id);
    const error = session.timeline(id).historyError;
    if (error) throw new Error(error);
  }), [session, id]);
  useFocusEffect(useCallback(() => {
    if (!historyFailed || connection === 'listing') return;
    historyRetry.start(); void historyRetry.retry();
    return historyRetry.stop;
  }, [historyRetry, historyFailed, connection]));
  const offline = useConnectionLabel(session);
  if (intent.status === 'placed' && intent.reading && target.targetIsLast && atEnd) dispatchTarget({ type: 'reached-end' });
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<ChatRow>[] }) => {
    const keys = viewableItems.filter(row => row.isViewable).map(row => row.item.key);
    setVisibleCards(current => current.size === keys.length && keys.every(key => current.has(key)) ? current : new Set(keys));
  }, []);
  const stopError = id && conversation ? session.stopErrors.get(id) : undefined;
  const historyError = !target.seeking && conversation && historyFailed ? 'history' : session.agents.error ? 'agents' : null;
  const showHistoryError = useDelayedNotice(historyError);
  const showStopError = useDelayedNotice(stopError ? 'stop' : null);
  const showTaskError = useDelayedNotice(taskError ? 'collaboration' : null);
  const showTargetError = useDelayedNotice(target.failed ? 'target' : null);
  const notices = buildChatNotices({
    offline,
    history: showHistoryError && historyError ? t(historyError === 'history' ? '无法加载历史消息，正在重试…' : '无法加载 Agent，正在重试…') : undefined,
    stop: stopError && showStopError ? t('停止未确认，工作可能仍在继续：{error}', { error: t(stopError) }) : undefined,
    collaboration: [task?.status === 'unavailable' ? t('这个协作已无法继续') : taskError && showTaskError ? t('无法加载协作，正在重试…') : null,
      (task?.status === 'failed' || task?.status === 'unavailable') && task.error ? t(task.error) : null].filter(Boolean).join('\n'),
    target: target.failed && showTargetError ? t('无法加载目标消息，正在重试…') : undefined,
  });
  const missingNotice: ChatLocalNotice | null = target.missing
    ? { kind: 'missing', title: t('消息不存在'), description: t('已加载全部历史，未找到目标消息。') } : null;
  const bannerNotice = notice?.kind === 'send-offline' ? missingNotice : notice ?? missingNotice;
  const cleanupMessage = useCleanupResult(session, session.connection !== 'open' || notices.length > 0 || !!bannerNotice,
    !!conversation || !id && session.agents.loaded && session.agents.agents.length > 0);
  const headerBottom = notices.length || bannerNotice || cleanupMessage ? insets.top + CHAT_LAYOUT.bannerTop + topOverlayHeight : insets.top + CHAT_LAYOUT.headerHeight;
  // The pinned user message starts where readable content starts. Only the row key is remembered; the banner
  // and spacing are read from the current layout, so a late banner changes the space but never re-sends the pin.
  const anchorIndex = anchorKey === null ? -1 : items.findIndex(item => item.key === anchorKey);
  const anchorOffset = headerBottom + CONTENT_TOP_GAP - (anchorIndex < 0 ? 0 : messageSpacing(items, anchorIndex)?.paddingTop ?? 0);
  const anchoredEndSpace = useMemo(() => anchorIndex < 0 ? undefined : { anchorIndex, anchorOffset }, [anchorIndex, anchorOffset]);
  // Everything renderItem reads that is not part of a row's own content (chatRowsEqual covers that). The object
  // changes only when one of these really changes, never per render: a changed extraData re-renders every row and
  // delays the list's end request (docs/research/chat-pin-bisect-2026-11-04.md §9). Row reads of session state:
  // `connection` (AttachmentPreview reload), the rest are the values below; UI drafts subscribe on their own.
  const layout = rowLayout(items);
  const extraData = useMemo(() => ({ visibleCards, connection, focused, mode, targetHighlighted: target.highlighted, layout }),
    [visibleCards, connection, focused, mode, target.highlighted, layout]);
  const dismissNotice = () => { if (notice && bannerNotice === notice) onDismissNotice(); else cancelTarget(); };

  return <>
    {composerMeasured && (!target.seeking || target.failed || (timeline?.loaded && targetIndex >= 0)) && <ChatTimelineList
      key={target.failed ? 'target-error' : 'timeline'} ref={list} style={{ flex: 1 }} recycleItems={false}
      getItemType={messageItemType} itemsAreEqual={chatRowsEqual} estimatedItemSize={256}
      alignItemsAtEnd initialScrollAtEnd={!target.seeking || targetIndex < 0}
      initialScrollIndex={target.seeking && targetIndex >= 0 ? { index: targetIndex, viewPosition: 0 } : undefined}
      maintainScrollAtEnd={target.reading || holdEnd ? false : FOLLOW_AT_END} maintainVisibleContentPosition
      anchoredEndSpace={anchoredEndSpace}
      contentInsetEndAdjustment={contentInsetEndAdjustment} keyboardOffset={bottom.keyboardOffset} keyboardLiftBehavior="whenAtEnd" freeze={freeze}
      onReady={() => {
        setListGeneration(generation => generation + 1);
        if (target.seeking && targetIndex >= 0 && !target.failed) dispatchTarget({ type: 'placed', placement: listGeneration + 1 });
      }}
      onScrollBeginDrag={userTookOver} data={items} keyExtractor={item => item.key}
      onViewableItemsChanged={onViewableItemsChanged} viewabilityConfig={VIEWABILITY_CONFIG}
      extraData={extraData}
      renderItem={({ item, index }) => {
        const isTarget = isMessageTarget(item, messageSeq);
        if (item.kind === 'working') {
          // The idle placeholder renders the same content as the working row but invisible and hidden from screen readers,
          // so its height is the real one (activity text may wrap; system font scale applies).
          const idle = item.idle === true;
          return <View style={[WORKING_CONTENT, index > 0 && MESSAGE_SPACING, idle && HIDDEN]}
            accessibilityElementsHidden={idle} importantForAccessibility={idle ? 'no-hide-descendants' : undefined}>
            <ProgressRow testID={idle ? 'chat-working-idle' : 'chat-working'}><TypingDots still={idle} /><Text className="flex-1 text-sm text-muted-foreground">{t(item.label)}</Text></ProgressRow>
          </View>;
        }
        return <View testID={isTarget ? `message-target-${messageSeq}` : undefined}
          onTouchStart={item.draft ? undefined : () => dispatchTarget({ type: 'touched' })}
          style={messageSpacing(items, index)}
          className={isTarget && target.highlighted ? 'rounded-xl bg-muted px-2 py-1' : undefined}>
          <MessageActions item={item} onQuote={onQuote}
            onDiscard={item.kind === 'user' && item.pending && item.delivery !== 'sending' && (id || canDiscardFirst) ? () => onDiscardPending(item.pending!.clientId) : undefined}>
            <MessageRow item={item} session={session} timelineId={id} visible={focused && visibleCards.has(item.key)}
              onUiSubmitted={takeOverAfterUiSubmit} onRetryPending={onRetryPending} />
          </MessageActions>
        </View>;
      }}
      onStartReached={() => { if (id && !target.seeking) void session.loadOlder(id); }} onStartReachedThreshold={0.3}
      contentContainerStyle={[LIST_CONTENT, { paddingTop: insets.top + 62 }]} keyboardShouldPersistTaps="handled" />}
    {focused && target.placement !== null && listGeneration > 0 && <TargetHighlightExpiry key={target.placement} placement={target.placement} onExpire={dispatchTarget} />}
    {timeline?.loading && <View pointerEvents="none" className="absolute inset-x-0 items-center" style={{ top: insets.top + 62 }}>
      <Text className="rounded-full bg-background px-3 py-1 text-xs text-muted-foreground">{t('加载中…')}</Text>
    </View>}
    {mode === 'READ' && <KeyboardStickyView pointerEvents="box-none"
      style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }} offset={{ closed: 0, opened: bottom.keyboardOffset }}>
      <SurfacePressable testID="chat-return-to-bottom" accessibilityRole="button" accessibilityLabel={t('回到最新消息')}
        hitSlop={4} style={[CHAT_FLOATING_SURFACE, { position: 'absolute', bottom: bottom.returnButtonBottom,
          width: CHAT_LAYOUT.returnButtonSize, height: CHAT_LAYOUT.returnButtonSize }]}
        className="self-center items-center justify-center rounded-full bg-card" onPress={returnToBottom}>
        <Icon as={ArrowDown} size={20} className="text-foreground" />
      </SurfacePressable>
    </KeyboardStickyView>}
    <ChatFade edge="top" statusBar={insets.top}
      headerBottom={headerBottom} />
    {(notices.length > 0 || bannerNotice || cleanupMessage) && <View className="absolute inset-x-0 gap-2" style={{ top: insets.top + CHAT_LAYOUT.bannerTop }}
      onLayout={event => setTopOverlayHeight(event.nativeEvent.layout.height)}>
      {notices.length > 0 && <ChatNotices notices={notices} onRetryStop={() => { if (id) void session.stop(id); }} />}
      {bannerNotice && <ChatLocalNoticeView notice={bannerNotice} onDismiss={dismissNotice} />}
      <CleanupResultNotice message={cleanupMessage} />
      {onRetryCreation && <Button intent="soft" className="self-start mx-4" onPress={onRetryCreation}><Text>{t('重试')}</Text></Button>}
    </View>}
  </>;
}
