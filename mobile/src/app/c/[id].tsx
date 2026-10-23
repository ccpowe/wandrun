// 聊天页：正序时间线；列表拥有测量、跟随和阅读状态，页面只拥有显式定位请求。
// 时间线筛选与状态派生在 lib/chat-timeline.ts；协议行为（发送即打断、停止、已读、重试）都在 ChatSession。

import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { type LegendListRef, type ViewToken } from "@legendapp/list/react-native";
import { useKeyboardChatComposerInset } from "@legendapp/list/keyboard";
import { ArrowDown } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChatHeader } from "@/components/chat/chat-header.tsx";
import { CHAT_FLOATING_SURFACE, CHAT_LAYOUT, chatBottomLayout } from "@/components/chat/chat-surface.ts";
import { ChatFade } from "@/components/chat/chat-fade.tsx";
import { ChatNotices } from "@/components/chat/chat-notices.tsx";
import { ChatTimelineList } from "@/components/chat/chat-timeline-list.tsx";
import { ConversationDrawer } from "@/components/chat/conversation-drawer.tsx";
import { Composer } from "@/components/chat/composer.tsx";
import { MessageRow } from "@/components/chat/message-row.tsx";
import { MessageActions } from "@/components/chat/message-actions.tsx";
import { TypingDots } from "@/components/chat/typing-dots.tsx";
import { ProgressRow } from "@/components/chat/progress-row.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { GatewayError } from "@/gateway/api.ts";
import { buildItems, isMessageTarget, showFailedHint, type Item } from "@/lib/chat-timeline.ts";
import { buildChatNotices } from "@/lib/chat-notices.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { useConnectionLabel } from "@/lib/connection-banner.tsx";
import { missingConversationAction, switchConversation } from "@/lib/conversation-navigation.ts";
import { nextConversationAfterDeletion } from "@/lib/conversation-management.ts";
import { prependQuote } from "@/lib/message-actions.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { pickUploads, type AttachmentSource } from "@/lib/pick-upload.ts";
import { useSession } from "@/lib/session-context.tsx";
import { acquireUploadDraft, type UploadDraftController } from "@/lib/upload-drafts.ts";
import { useConversationDrawer } from "@/lib/use-conversation-drawer.ts";
import { userErrorMessage } from "@/lib/user-error.ts";

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 25 };
const FOLLOW_AT_END = { animated: false };
const LIST_CONTENT = { paddingHorizontal: CHAT_LAYOUT.contentInsetHorizontal, paddingBottom: CHAT_LAYOUT.listBottomGap };
const ROW_GAP = 12;
const MESSAGE_SPACING = { paddingTop: ROW_GAP };
const FOOTER_CONTENT = { gap: ROW_GAP };
// The last delegation contributes 12dp bottom padding: with this gap the footer is 24dp away.
const FOOTER_AFTER_ITEMS = { paddingTop: ROW_GAP };
function messageItemType(item: Item) {
  if (item.pending) return "message.user";
  if (item.draft) return "message.agent";
  if (item.browser) return "browser";
  if (item.delegation) return "delegation";
  return item.event?.type ?? "event";
}
function messageItemsEqual(previous: Item, item: Item) {
  // buildItems rewraps immutable payloads; keep their known measurements.
  // Pending messages mutate in place and must still be reconsidered.
  return !previous.pending && !item.pending && previous.key === item.key &&
    previous.event === item.event && previous.draft === item.draft && previous.browser === item.browser &&
    previous.delegation?.status === item.delegation?.status;
}

export default function Chat() {
  const { id, message_seq } = useLocalSearchParams<{ id: string; message_seq?: string }>();
  // Each route target owns a fresh initial-placement lifecycle.
  return <ChatScreen key={`${id}:${message_seq ?? "latest"}`} id={id} messageSeq={message_seq ? Number(message_seq) : undefined} />;
}

function ChatScreen({ id, messageSeq }: { id: string; messageSeq?: number }) {
  const { t } = useTranslation();
  const session = useSession();
  const focused = useIsFocused();
  const [upload, setUpload] = useState<UploadDraftController | null>(null);
  const [, refreshUpload] = useState(0);
  const [quote, setQuote] = useState<string | null>(null);
  const list = useRef<LegendListRef>(null);
  // A failed target temporarily mounts history; subscribe again after retry replaces it.
  const [listGeneration, setListGeneration] = useState(0);
  const [targetState, setTargetState] = useState<"active" | "located" | "missing" | "none">(
    messageSeq !== undefined && Number.isFinite(messageSeq) ? "active" : "none",
  );
  const targetActive = targetState === "active";
  const [highlightExpired, setHighlightExpired] = useState(false);
  const [targetReading, setTargetReading] = useState(targetActive);
  const targetHighlighted = (targetActive || targetState === "located") && !highlightExpired;
  const subscribeToEnd = useCallback((notify: () => void) => {
    if (!listGeneration || !list.current) return () => {};
    return list.current.getState().listen("isAtEnd", notify);
  }, [listGeneration]);
  const getAtEnd = useCallback(
    () => !listGeneration || (list.current?.getState().isAtEnd ?? false),
    [listGeneration],
  );
  const listAtEnd = useSyncExternalStore(subscribeToEnd, getAtEnd, getAtEnd);
  const atEnd = !targetReading && listAtEnd;
  const mode = atEnd ? "FOLLOW" : "READ";
  const composer = useRef<View>(null);
  const [composerMeasured, setComposerMeasured] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const [topOverlayHeight, setTopOverlayHeight] = useState(0);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(list, composer);
  const [visibleCards, setVisibleCards] = useState<Set<string>>(new Set());
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<Item>[] }) => {
    const keys = viewableItems.filter((row) => row.isViewable && row.item.browser).map((row) => row.item.key);
    setVisibleCards((current) => current.size === keys.length && keys.every((key) => current.has(key)) ? current : new Set(keys));
  }, []);
  const viewabilityConfig = VIEWABILITY_CONFIG;
  const attemptedOldest = useRef<{ messageSeq: number | undefined; value: number | null | undefined } | null>(null);
  const insets = useSafeAreaInsets();
  const bottomLayout = chatBottomLayout(composerHeight, insets.bottom);

  useEffect(() => focused ? session?.view(id) : undefined, [session, id, focused, session?.connection]);
  const conversation = session?.chat(id);
  const rootId = conversation ? session!.rootId(id) : undefined;
  useEffect(() => {
    if (!session || !rootId) return;
    const { release } = acquireUploadDraft(session.api, id, (controller) => {
      setUpload(controller);
      refreshUpload((version) => version + 1);
    }, rootId);
    return () => { release(); setUpload(null); };
  }, [session, id, rootId]);
  const task = session?.tasks.get(id);
  const taskError = session?.taskErrors.get(id);
  // 保留入口 Agent：删除事件会先从 session 移除对话，届时不能再从当前资源取归属。
  const [agentId, setAgentId] = useState(conversation?.agent_id);
  if (conversation && agentId !== conversation.agent_id) setAgentId(conversation.agent_id);
  const agentDeleted = agentId !== undefined && session?.agents.deletedIds.has(agentId);
  useEffect(() => {
    if (!focused) return;
    if (agentDeleted) { router.dismissTo("/"); return; }
    if (!session || conversation) return;
    const action = missingConversationAction(session, id, agentId);
    if (action.type === "leave") { router.dismissTo("/"); return; }
    if (action.type === "wait") return;
    let cancelled = false;
    const next = nextConversationAfterDeletion(session.conversationsOf(action.agentId), action.agentId, id);
    if (next) switchConversation(next, (params) => router.setParams(params));
    else void session.blankConversation(action.agentId).then(
      (target) => { if (!cancelled) switchConversation(target, (params) => router.setParams(params)); },
      (error) => {
        if (cancelled) return;
        // Agent 删除会先发对话删除事件；新建空对话的 404 已足以确认入口消失。
        if (error instanceof GatewayError && error.status === 404) { router.dismissTo("/"); return; }
        Alert.alert(t("无法打开对话"), t(userErrorMessage(error, "无法打开对话，请重新加载后重试")));
        router.replace("/");
      },
    );
    return () => { cancelled = true; };
  }, [session, conversation, agentId, id, session?.connection, agentDeleted, focused, t]);
  const drawer = useConversationDrawer(session, id, agentId, focused);
  const agent = session?.agents.agents.find((item) => item.id === agentId);
  const timeline = session?.timeline(id);
  const working = session?.isWorking(id) ?? false;
  const stopping = session?.stopping.has(id) ?? false;
  const items = session && timeline ? buildItems(timeline.events, session.pendingFor(id), session.browserTasks, session.draftsFor(id), session.drafts.order, id, session.tasks) : [];
  const offlineLabel = useConnectionLabel(session);
  const targetIndex = messageSeq === undefined ? -1 : items.findIndex((item) => isMessageTarget(item, messageSeq));
  const timelineLoaded = timeline?.loaded;
  const timelineComplete = timeline?.complete;
  const timelineLoading = timeline?.loading;
  const timelineOldest = timeline?.oldest;
  const targetError = targetActive ? timeline?.historyError : undefined;
  const historyError = !targetActive && conversation ? timeline?.historyError : undefined;
  const stopError = conversation && !task ? session?.stopErrors.get(id) : undefined;
  const targetFailed = targetError !== undefined;
  const targetFound = targetIndex >= 0;
  // End geometry can settle after onReady. Release once the last-row target
  // actually reaches bottom, not while reading the top of an oversized row.
  // Latch this permission: subsequent growth must not reinstate target READ.
  if (targetReading && targetState === "located" && targetFound && targetIndex === items.length - 1 && listAtEnd) {
    setTargetReading(false);
  }
  useEffect(() => {
    if (!focused || !targetHighlighted || !targetFound || !listGeneration) return;
    // Flash only after placement. Expiry does not end READ mode or jump back to latest.
    const timer = setTimeout(() => setHighlightExpired(true), 2500);
    return () => clearTimeout(timer);
  }, [focused, targetHighlighted, targetFound, listGeneration]);
  // Deletion clears history before navigation finishes; that is not search exhaustion.
  if (targetActive && conversation && !agentDeleted && timelineLoaded && timelineComplete && !timelineLoading && targetIndex < 0) {
    setTargetState("missing");
    setTargetReading(false);
  }
  useEffect(() => {
    if (targetState === "missing") Alert.alert(t("消息不存在"), t("已加载全部历史，未找到目标消息。"));
  }, [targetState, t]);
  useEffect(() => {
    let attempt = attemptedOldest.current;
    if (!attempt || !Object.is(attempt.messageSeq, messageSeq)) {
      attempt = { messageSeq, value: undefined };
      attemptedOldest.current = attempt;
    }
    if (!targetActive || !focused || !session || !conversation || messageSeq === undefined ||
      !Number.isFinite(messageSeq) || !timelineLoaded || targetIndex >= 0) return;
    if (!targetFailed && !timelineComplete && !timelineLoading && attempt.value !== timelineOldest) {
      attempt.value = timelineOldest;
      void session.loadOlder(id);
    }
  }, [messageSeq, session, conversation, id, timelineLoaded, timelineComplete, timelineLoading, timelineOldest, targetIndex, focused, targetActive, targetFailed]);

  if (!session || !timeline) return null;
  const cancelTarget = () => {
    setTargetState("none");
    setTargetReading(false);
    setHighlightExpired(true);
  };
  const returnToBottom = () => {
    cancelTarget();
    // Jump immediately: a subsequent gesture should not compete with a return animation.
    void list.current?.scrollToEnd({ animated: false });
  };
  const takeOverAfterSend = () => {
    // Already following: let the list handle append and composer layout together.
    if (mode === "READ") returnToBottom();
    else cancelTarget();
  };
  const send = () => {
    if (!conversation || !upload) return;
    try {
      const message = upload.consume();
      if (message) {
        void session.send(id, prependQuote(message.text, quote), message.files);
        takeOverAfterSend();
        setQuote(null);
      }
    } catch (error) {
      Alert.alert(t("无法发送"), t(userErrorMessage(error, "无法发送消息，草稿仍在，请重试")));
    }
  };
  const pick = async (source: AttachmentSource) => {
    if (!upload || !conversation) return;
    try {
      const selected = await pickUploads(source);
      for (const asset of selected) await upload.add(asset);
    } catch (error) {
      Alert.alert(t("添加附件失败"), t(userErrorMessage(error, "无法添加所选附件，请检查文件读取权限后重试")));
    }
  };

  const notices = buildChatNotices({
    offline: offlineLabel,
    history: historyError ? t("历史消息加载失败：{error}", { error: t(historyError) }) : undefined,
    stop: stopError ? t("停止未确认，工作可能仍在继续：{error}", { error: t(stopError) }) : undefined,
    collaboration: [
      task?.status === "unavailable" ? t("这个协作已无法继续") : taskError ? t(taskError) : null,
      (task?.status === "failed" || task?.status === "unavailable") && task.error ? t(task.error) : null,
    ].filter(Boolean).join("\n"),
    target: targetFailed ? t("目标消息加载失败：{error}", { error: t(targetError ?? "") }) : undefined,
  });
  // Match the session's definition of a reusable blank: pending/failed local sends count as content.
  const emptyConversation = !!conversation && "last_text" in conversation && conversation.last_text === null &&
    !items.some((item) => item.pending || item.event?.type === "message.user" || item.event?.type === "message.agent");
  const browser = items.reduce<Item["browser"]>((active, item) =>
    item.browser && item.browser.state !== "released" ? item.browser : active, undefined);
  const browserUrl = (browser?.pages.find((page) => page.id === browser.current) ?? browser?.pages[0])?.url;

  return (
    <ConversationDrawer {...drawer.drawerProps} onOpen={drawer.show} swipeEnabled={!!conversation}>
    {/* Keep the existing keyboard-controller inset path; safe area is removed by StickyView only while open. */}
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1">
        {/* Initial placement measures the target as it mounts; do not position against paginating estimates. */}
        {composerMeasured && (!targetActive || targetFailed || (timelineLoaded && targetIndex >= 0)) && <ChatTimelineList
          // A failed target shows existing history. Retry must get a fresh initial placement,
          // even if React batches the loading and success notifications into one render.
          key={targetFailed ? "target-error" : "timeline"}
          ref={list}
          style={{ flex: 1 }}
          recycleItems={false}
          getItemType={messageItemType}
          itemsAreEqual={messageItemsEqual}
          estimatedItemSize={256}
          alignItemsAtEnd
          initialScrollAtEnd={!targetActive || targetIndex < 0}
          initialScrollIndex={targetActive && targetIndex >= 0 ? { index: targetIndex, viewPosition: 0 } : undefined}
          maintainScrollAtEnd={targetReading ? false : FOLLOW_AT_END}
          maintainVisibleContentPosition
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          keyboardOffset={bottomLayout.keyboardOffset}
          keyboardLiftBehavior="whenAtEnd"
          onReady={() => {
            setListGeneration((generation) => generation + 1);
            if (targetActive && targetFound && !targetFailed) {
              setTargetState("located");
            }
          }}
          onScrollBeginDrag={cancelTarget}
          data={items}
          keyExtractor={(item) => item.key}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          extraData={{ visibleCards, version: session.getVersion(), targetHighlighted }}
          renderItem={({ item, index }) => {
            const target = isMessageTarget(item, messageSeq);
            return <View testID={target ? `message-target-${messageSeq}` : undefined}
              // Draft touches intentionally preserve the target highlight as well as READ priority.
              onTouchStart={item.draft ? undefined : () => setHighlightExpired(true)}
              // Delegation padding supplies the gap; its real hit target stays inside this cell.
              style={index > 0 && !item.delegation && !items[index - 1].delegation ? MESSAGE_SPACING : undefined}
              className={target && targetHighlighted ? "rounded-xl bg-muted px-2 py-1" : undefined}>
              <MessageActions item={item} onQuote={setQuote}>
                <MessageRow item={item} session={session} timelineId={id} visible={focused && visibleCards.has(item.key)}
                  onUiSubmitted={takeOverAfterSend} />
              </MessageActions>
            </View>;
          }}
          onStartReached={() => { if (!targetActive) void session.loadOlder(id); }}
          onStartReachedThreshold={0.3}
          ListHeaderComponent={task ? <Pressable testID="chat-root-conversation" accessibilityRole="button"
            accessibilityLabel={t("返回根对话 {title}", { title: task.root_title })}
            onPress={() => router.push({ pathname: "/c/[id]", params: { id: task.root_id } })}
            className="mb-3 self-center rounded-full bg-card px-3 py-2">
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {t("返回根对话 {title}", { title: session.conversations.get(task.root_id)?.title || task.root_title || t("新对话") })} ›
            </Text>
          </Pressable> : null}
          ListFooterComponent={working || showFailedHint(conversation, items) ? (
            <View style={[FOOTER_CONTENT, items.length > 0 && FOOTER_AFTER_ITEMS]}>
              {working && (
                <ProgressRow testID="chat-working">
                  <TypingDots />
                  <Text className="flex-1 text-sm text-muted-foreground">
                    {stopping ? t("正在停止…") : t((conversation && "activity" in conversation ? conversation.activity : task?.status === "waiting" ? "等待成员结果" : null) ?? "工作中…")}
                  </Text>
                </ProgressRow>
              )}
              {showFailedHint(conversation, items) && (
                <Text className="self-center text-xs text-muted-foreground">{t("上一轮失败了，可以直接再发一条继续。")}</Text>
              )}
            </View>
          ) : null}
          contentContainerStyle={[LIST_CONTENT, { paddingTop: insets.top + 62 }]}
          keyboardShouldPersistTaps="handled"
        />}
        {emptyConversation && timelineLoaded && !working && agent && <View pointerEvents="none"
          testID="chat-empty" className="absolute inset-0 items-center justify-center gap-2 px-8"
          style={{ paddingTop: insets.top + 62, paddingBottom: composerHeight + 24 }}>
          <WandrunAvatar index={agent.avatar} alt={agent.name} size={88} className="mb-2 border border-border bg-white" />
          <Text className="w-full text-center text-xl font-semibold" numberOfLines={2}>{agent.name}</Text>
          {!!agent.description && <Text className="text-center text-sm text-muted-foreground">{agent.description}</Text>}
        </View>}
        {timeline.loading && (
          <View pointerEvents="none" className="absolute inset-x-0 items-center" style={{ top: insets.top + 62 }}>
            <Text className="rounded-full bg-background px-3 py-1 text-xs text-muted-foreground">{t("加载中…")}</Text>
          </View>
        )}
        {/* The jump hit area is outside the composer-only measurement used for the list inset. */}
        <KeyboardStickyView pointerEvents="box-none"
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, paddingTop: bottomLayout.stickyPaddingTop }}
          offset={{ closed: 0, opened: bottomLayout.keyboardOffset }}>
          <ChatFade edge="bottom" height={bottomLayout.fadeHeight} solidHeight={bottomLayout.fadeSolidHeight} />
          {mode === "READ" && (
            <Pressable testID="chat-return-to-bottom" accessibilityRole="button" accessibilityLabel={t("回到最新消息")}
              hitSlop={2} style={[CHAT_FLOATING_SURFACE, { position: "absolute", bottom: bottomLayout.returnButtonBottom,
                width: CHAT_LAYOUT.returnButtonSize, height: CHAT_LAYOUT.returnButtonSize }]}
              className="self-center items-center justify-center rounded-full border border-border bg-card"
              onPress={returnToBottom}>
              <Icon as={ArrowDown} className="size-5 text-foreground" strokeWidth={1.75} />
            </Pressable>
          )}
          <View ref={composer} onLayout={(event) => {
            onComposerLayout(event);
            setComposerHeight(event.nativeEvent.layout.height);
            // Bootstrap with the real composer inset, not a zero-height first frame.
            setComposerMeasured(true);
          }} style={{ paddingBottom: CHAT_LAYOUT.composerBottomGap }}>
            <Composer
              textOnly={!!task}
              disabledReason={task?.status === "unavailable" ? t("这个协作已无法继续") : !conversation ? t("正在加载会话…") : undefined}
              draft={upload?.draft.text ?? ""}
              onChangeDraft={(text) => upload?.setText(text)}
              quote={quote}
              onCancelQuote={() => setQuote(null)}
              attachments={upload?.items ?? []}
              uploadError={upload?.error ? t(upload.error) : !upload?.ready ? t("正在读取草稿…") : null}
              onPick={(source) => void pick(source)}
              onRetry={(itemId) => upload?.retry(itemId)}
              onRemove={(itemId) => {
                try { upload?.remove(itemId); }
                catch (error) { Alert.alert(t("无法移除附件"), t(userErrorMessage(error, "无法移除附件，请重试"))); }
              }}
              working={working}
              stopping={stopping}
              onSend={send}
              onStop={() => void session.stop(id)}
            />
          </View>
        </KeyboardStickyView>
      </View>
      <ChatFade edge="top" height={Math.max(insets.top + 82, notices.length ? topOverlayHeight + 24 : 0)} solidHeight={insets.top} />
      <View pointerEvents="box-none" className="absolute inset-x-0 top-0"
        onLayout={(event) => setTopOverlayHeight(event.nativeEvent.layout.height)}>
        <ChatHeader
          agent={agent}
          title={conversation?.title ?? ""}
          source={conversation && "source" in conversation ? conversation.source : undefined}
          collaboration={task ? {
            creatorName: agentDisplayName(session.agents, task.creator_agent_id),
            rootId: task.root_id, rootTitle: session.conversations.get(task.root_id)?.title ?? task.root_title,
          } : undefined}
          paddingTop={insets.top}
          working={working}
          browserUrl={browserUrl}
          onOpenConversations={conversation ? drawer.show : undefined}
          newConversationDisabled={!conversation || emptyConversation}
          onNewConversation={drawer.newConversation}
        />
        {notices.length > 0 && <View className="mt-2">
          <ChatNotices notices={notices} canRetryCollaboration={!conversation} onRetry={(kind) => {
            if (kind === "stop") void session.stop(id);
            else void session.loadOlder(id);
          }} />
        </View>}
      </View>
    </View>
    </ConversationDrawer>
  );
}
