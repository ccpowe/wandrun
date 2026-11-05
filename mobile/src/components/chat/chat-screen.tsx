import { router, Stack, useFocusEffect, useIsFocused } from 'expo-router';
import type { LegendListRef } from '@legendapp/list/react-native';
import { useKeyboardChatComposerInset } from '@legendapp/list/keyboard';
import { useCallback, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NewChatAgentChips, NewChatAgentDisplay, NewChatAgentSheet } from './agent-picker.tsx';
import { ChatFade } from './chat-fade.tsx';
import { ChatHeader } from './chat-header.tsx';
import { ChatHistory, type ChatHistoryHandle } from './chat-history.tsx';
import { CHAT_LAYOUT, chatBottomLayout } from './chat-surface.ts';
import { Composer } from './composer.tsx';
import { ConversationDrawer } from './conversation-drawer.tsx';
import { newClientId, type ChatSession } from '@/gateway/session.ts';
import { agentDisplayName } from '@/lib/agent-display-name.ts';
import { conversationChildren } from '@/lib/chat-branches.ts';
import type { ChatLocalNotice } from '@/lib/chat-notices.ts';
import { projectChatRows } from '@/lib/chat-timeline.ts';
import { chatWelcomeReducer, chatWelcomeVisible, initialChatWelcome, type ChatVisitLease } from '@/lib/chat-visit.ts';
import { chatUploadHandoff } from '@/lib/chat-upload-handoff.ts';
import { chatEntryTarget, chatExitAction } from '@/lib/conversation-navigation.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { prependQuote } from '@/lib/message-actions.ts';
import { recentAgentOrder } from '@/lib/new-chat-agents.ts';
import { useNewConversation, useNewConversationStore } from '@/lib/new-conversation-context.tsx';
import type { NewChatHost } from '@/lib/new-conversation.ts';
import { stageNewAttachments } from '@/lib/new-conversation-storage.ts';
import { pickUploads, type AttachmentSource } from '@/lib/pick-upload.ts';
import { useGateway } from '@/lib/session-context.tsx';
import { acquireUploadDraft, uploadDraftAccess, type UploadDraftAccess, type PickedUpload } from '@/lib/upload-drafts.ts';
import type { UploadItem } from '@/lib/upload-draft-state.ts';
import { useChatVisit } from '@/lib/use-chat-visit.ts';
import { useConversationDrawer } from '@/lib/use-conversation-drawer.ts';
import { useFocusedVisit } from '@/lib/use-focused-visit.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { userErrorMessage } from '@/lib/user-error.ts';

const noUploadAccess: UploadDraftAccess = { subscribe: () => () => {}, getSnapshot: () => null };
type Props = { session: ChatSession; id?: string; messageSeq?: number; initialCardOpen?: boolean; initialDrawerOpen?: boolean };

/** One native screen and one Composer. Only target-owned history is below the visit-generation key. */
export function ChatScreen({ session, id, messageSeq, initialCardOpen = false, initialDrawerOpen = false }: Props) {
  useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
  const { t } = useTranslation();
  const { config, rememberConversation } = useGateway();
  const focused = useIsFocused();
  const { visit, generation, navigation, canProject: hasVisitAccess, changeTarget } = useChatVisit({ id, messageSeq });
  const captureFocus = useFocusedVisit();
  useMountEffect(() => {
    let version = session.storeVersion;
    return session.subscribe(() => {
      if (version === session.storeVersion) return;
      version = session.storeVersion;
      visit.invalidate();
    });
  });
  const newStore = useNewConversationStore();
  const newState = useNewConversation();
  const insets = useSafeAreaInsets();
  const list = useRef<LegendListRef>(null);
  const history = useRef<ChatHistoryHandle>(null);
  const composer = useRef<View>(null);
  const [composerMeasured, setComposerMeasured] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(list, composer);
  const bottom = chatBottomLayout(composerHeight, insets.bottom);
  // These are independent local presentation values, tagged so an old target can never project them.
  const [quoteEntry, setQuoteEntry] = useState<{ generation: number; text: string } | null>(null);
  const [noticeEntry, setNoticeEntry] = useState<{ generation: number; notice: ChatLocalNotice | null } | null>(null);
  const [welcome, dispatchWelcome] = useReducer(chatWelcomeReducer, initialChatWelcome);
  const [agentsOpen, setAgentsOpen] = useState<number | null>(null);
  // The controller is still the sole data owner. This is an acquired, ready view handle, not a deferred result.
  const [boundAccess, setBoundAccess] = useState<{ generation: number; id: string; access: UploadDraftAccess } | null>(null);
  const conversation = id ? session.chat(id) : undefined;
  // Historical admission, not a copy of the current resource: resync can remove it before exit is decided.
  const [knownOwner, setKnownOwner] = useState<{ id: string; agentId: string } | null>(null);
  if (id && conversation && (knownOwner?.id !== id || knownOwner.agentId !== conversation.agent_id)) {
    setKnownOwner({ id, agentId: conversation.agent_id });
  }
  const ownerId = conversation?.agent_id ?? (knownOwner && knownOwner.id === id ? knownOwner.agentId : undefined);
  const rootId = id && conversation ? session.rootId(id) : undefined;
  const root = rootId ? session.conversations.get(rootId) : undefined;
  const recordable = !!root && !session.agents.deletedIds.has(root.agent_id);
  const connectionId = config?.connectionId;
  useFocusEffect(useCallback(() => {
    if (!id || !recordable || !connectionId) return;
    const confirmedRoot = session.rootId(id);
    if (confirmedRoot) void rememberConversation(connectionId, confirmedRoot).catch(error => console.warn('无法保存上次主对话', error));
  }, [id, recordable, connectionId, rememberConversation, session]));
  const acquired = boundAccess?.generation === generation && boundAccess.id === id ? boundAccess.access : null;
  const hasDraftTarget = !!id && !!conversation && !!rootId;
  const uploadAccess = useMemo(() => {
    if (acquired) return acquired;
    if (!id || !hasDraftTarget) return null;
    const root = session.rootId(id);
    return root ? uploadDraftAccess(session.api, id, root) : null;
  }, [acquired, session, id, hasDraftTarget]);
  const upload = useSyncExternalStore(uploadAccess?.subscribe ?? noUploadAccess.subscribe, uploadAccess?.getSnapshot ?? noUploadAccess.getSnapshot)?.controller ?? null;
  const saved = newState.status === 'loading' ? null : newState.saved;
  const attempt = saved?.attempt;
  const firstIntent = attempt ?? saved?.failure?.attempt;
  const computerId = session.api.config.computerId!;
  const foreignAttempt = !!attempt && attempt.computerId !== computerId;
  const recentAgents = recentAgentOrder(session.agents.agents, session.conversations.values());
  const selection = attempt ?? saved?.selection;
  const selectedId = selection?.computerId === computerId ? selection.agentId : undefined;
  const agent = id ? session.agents.agents.find(item => item.id === ownerId)
    : recentAgents.find(item => item.id === selectedId) ?? (!attempt ? recentAgents[0] : undefined);
  const task = id ? session.tasks.get(id) : undefined;
  const timeline = id ? session.timeline(id) : undefined;
  const { rows, turn } = projectChatRows({
    timelineId: id, events: timeline?.events ?? [], timelineLoaded: timeline?.loaded,
    historyError: timeline?.historyError, pending: id ? session.pendingFor(id) : [],
    drafts: id ? session.draftsFor(id) : [], draftOrder: session.drafts.order,
    browserTasks: session.browserTasks, tasks: session.tasks,
    turnFacts: { working: !!id && session.isWorking(id), stopping: !!id && session.stopping.has(id),
      activity: conversation && 'activity' in conversation ? conversation.activity : null, waitingForMembers: task?.status === 'waiting' },
    display: { currentAgentId: conversation?.agent_id,
      agentName: (agentId, snapshotName) => agentDisplayName(session.agents, agentId, snapshotName),
      agentAvatar: agentId => session.agents.agents.find(entry => entry.id === agentId)?.avatar ?? 0,
      creatorName: task => agentDisplayName(session.agents, task.creator_agent_id!),
      submissionsFor: (timelineId, seq) => session.submissionsFor(timelineId, seq) },
    firstIntent: !id && firstIntent ? { attempt: firstIntent, status: newState.status, error: newState.error,
      belongsToServer: !foreignAttempt } : undefined,
  });
  const editableSelection = !id && newState.status === 'editing';
  const firstBusy = newState.status === 'preparing' || newState.status === 'creating';
  const quote = quoteEntry?.generation === generation ? quoteEntry.text : null;
  const localNotice = noticeEntry?.generation === generation ? noticeEntry : null;
  const canProject = useCallback((lease: ChatVisitLease) => hasVisitAccess(lease) && !session.api.signal.aborted, [hasVisitAccess, session]);
  const showNotice = (notice: ChatLocalNotice, lease: ChatVisitLease) => { if (canProject(lease)) setNoticeEntry({ generation: lease.generation, notice }); };
  const drawer = useConversationDrawer(session, id, agent?.id, focused, initialDrawerOpen, changeTarget, visit);
  useFocusEffect(useCallback(() => {
    if (id || newState.status !== 'editing' || !agent) return;
    newStore.select(computerId, agent.id);
  }, [id, newState.status, agent, newStore, computerId]));
  const leave = !!id && chatExitAction(session, id, conversation, ownerId) === 'leave';
  useFocusEffect(useCallback(() => { if (leave) router.dismissTo('/'); }, [leave]));
  useFocusEffect(useCallback(() => {
    if (!id && newState.status === 'editing' && !agent && chatEntryTarget(session).type === 'empty') router.replace('/');
  }, [id, newState.status, agent, session]));

  const makeHost = useCallback((lease: ChatVisitLease): NewChatHost => {
    const version = session.storeVersion;
    return {
      computerId, online: () => session.connection === 'open', current: () => !session.api.signal.aborted,
      storeVersion: () => session.storeVersion,
      create: (agentId, key) => session.createConversation(agentId, undefined, key),
      bind: (createdId, first, send, nextText) => {
        if (version !== session.storeVersion || session.api.signal.aborted || !session.chat(createdId)) throw new Error('连接已关闭');
        const access = acquireUploadDraft(session.api, createdId, () => {});
        const controller = access.controller;
        try {
          const displayable = canProject(lease);
          const { message, transferred } = controller.handoffNewConversation(first, displayable ? nextText : undefined);
          if (message && !send) session.restoreFirstSend(createdId, message.clientId, message.text, message.files, 'deferred');
          if (displayable && visit.promote(lease, createdId)) {
            setBoundAccess({ generation: lease.generation, id: createdId, access: chatUploadHandoff(session.api, createdId, controller, lease) });
            dispatchWelcome({ type: 'engage', generation: lease.generation });
            navigation.setParams({ id: createdId, message_seq: undefined });
          }
          return { preserveDraft: !transferred, release: access.release,
            ...(!message || !send ? {} : { send: async () => {
              await session.send(createdId, message.text, message.files, message.clientId);
              if (!session.api.signal.aborted && version === session.storeVersion && !session.pending.has(message.clientId)) controller.acknowledgeFirstSend(message.clientId);
            } }),
          };
        } catch (error) { access.release(); throw error; }
      },
    };
  }, [session, computerId, canProject, visit, navigation]);
  const submitFirst = async (picked?: PickedUpload[]) => {
    if (id || firstBusy || foreignAttempt || (!attempt && !agent)) return;
    const focusedVisit = captureFocus();
    if (!focusedVisit()) return;
    const lease = visit.capture();
    if (!canProject(lease)) return;
    if (editableSelection && agent && !newStore.select(computerId, agent.id)) return;
    dispatchWelcome({ type: 'engage', generation }); setNoticeEntry(null);
    const create = attempt?.clientId ?? newClientId();
    const message = attempt?.messageClientId ?? newClientId();
    // Only a fresh text send pins its message; retrying a failed or unknown attempt never takes over the view.
    const fresh = !picked && !attempt && !saved?.failure;
    const submission = newStore.submit(makeHost(lease), { create, message }, picked ? () => stageNewAttachments(picked, create) : undefined);
    // The prepared first message is stored synchronously when accepted; an offline or rejected send stores no attempt.
    const stored = newStore.getSnapshot();
    if (fresh && stored.status !== 'loading' && stored.saved.attempt?.kind === 'send' && stored.saved.attempt.messageClientId === message) history.current?.beginSend(message);
    await submission;
  };
  const pick = async (source: AttachmentSource) => {
    const focusedVisit = captureFocus();
    const lease = visit.capture();
    if (!focusedVisit() || !canProject(lease) || (!id && (!editableSelection || saved?.failure))) return;
    dispatchWelcome({ type: 'engage', generation });
    try {
      const picked = await pickUploads(source);
      if (!focusedVisit() || !canProject(lease) || !picked.length) return;
      if (!id) await submitFirst(picked);
      else if (upload && conversation) for (const asset of picked) await upload.add(asset);
    } catch (error) { showNotice({ kind: 'pick', title: t('添加附件失败'), description: t(userErrorMessage(error, '无法添加所选附件，请检查文件读取权限后重试')) }, lease); }
  };
  const send = () => {
    if (!id) { if (!saved?.failure) void submitFirst(); return; }
    if (!upload || !conversation) return;
    const lease = visit.capture();
    if (!canProject(lease) || !focused) return;
    if (session.connection !== 'open') { showNotice({ kind: 'send-offline', title: t('发送失败'), description: '' }, lease); return; }
    try {
      const firstClientId = upload.draft.firstMessageId;
      const message = upload.consume(firstClientId, prependQuote(upload.draft.text.trim(), quote));
      if (!message) return;
      const clientId = firstClientId ?? newClientId();
      void session.send(id, message.text, message.files, clientId);
      // A closed or deleted session stores no pending row: that is not an accepted send, so nothing is pinned or dismissed.
      if (session.pending.has(clientId)) history.current?.beginSend(clientId);
      setQuoteEntry(null); setNoticeEntry(null);
    } catch (error) { showNotice({ kind: 'send', title: t('无法发送'), description: t(userErrorMessage(error, '无法发送消息，草稿仍在，请重试')) }, lease); }
  };
  const retryPending = (clientId: string) => {
    if (!id) { if (firstIntent?.messageClientId === clientId) void submitFirst(); return; }
    void session.retry(clientId);
  };
  const discardPending = (clientId: string) => {
    const lease = visit.capture();
    try {
      if (!id) newStore.discardFailure(clientId);
      else { upload?.acknowledgeFirstSend(clientId); session.discard(clientId); }
    } catch (error) { showNotice({ kind: 'send', title: t('无法删除消息'), description: t(userErrorMessage(error, '消息仍在，请重试')) }, lease); }
  };
  const stagedItems: UploadItem[] = !id && firstIntent?.kind === 'attachments' ? firstIntent.files.map(item => ({
    id: item.id, name: item.name, mediaType: item.mediaType, size: item.size, previewUri: item.uri,
    uploadUrl: null, fileId: null, progress: 0, error: null,
  })) : [];
  const newError = newState.error ?? saved?.failure?.error;
  const newReason = newState.reason ?? saved?.failure?.reason;
  const draftError: ChatLocalNotice | null = !id && foreignAttempt
    ? { kind: 'send', title: t('新对话仍属于原服务器，请切回原服务器继续'), description: '' }
    : !id && newError && (firstIntent?.kind !== 'send' || !!saved?.failure)
      ? { kind: newState.offline ? 'send-offline' : 'send', title: t(newError), description: newReason ? t(newReason) : '' } : null;
  const notice = localNotice ? localNotice.notice : draftError;
  const draft = id ? upload?.draft.text ?? '' : saved?.text ?? '';
  const draftLoading = id ? !upload?.ready : newState.status === 'loading';
  const attachmentsLocked = !id && (!editableSelection || !!saved?.failure || !agent || foreignAttempt);

  return <ConversationDrawer {...drawer.drawerProps} swipeEnabled={agentsOpen !== generation} onOpen={drawer.show}>
    <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1">
        <ChatHistory key={generation} session={session} id={id} messageSeq={messageSeq} list={list} handleRef={history}
          composerMeasured={composerMeasured} composerHeight={composerHeight} contentInsetEndAdjustment={contentInsetEndAdjustment}
          rows={rows} turn={turn} canDiscardFirst={!!saved?.failure && !firstBusy}
          notice={notice} onDismissNotice={() => setNoticeEntry({ generation, notice: null })}
          onQuote={text => { if (visit.getSnapshot() === generation) setQuoteEntry({ generation, text }); }}
          onRetryPending={retryPending} onDiscardPending={discardPending}
          onRetryCreation={!id && !foreignAttempt && !firstBusy && firstIntent?.kind === 'attachments' &&
            (newState.status === 'unknown' || !!saved?.failure) ? () => void submitFirst() : undefined} />
        {!id && agent && newState.status === 'editing' && !saved?.text && !firstIntent && chatWelcomeVisible(welcome, generation) && <View pointerEvents="none" className="absolute inset-0 items-center justify-center"
          style={{ paddingTop: insets.top + 62, paddingBottom: composerHeight + 24 }}><NewChatAgentDisplay agent={agent} /></View>}
        <KeyboardStickyView pointerEvents="box-none" style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingTop: bottom.stickyPaddingTop }}
          offset={{ closed: 0, opened: bottom.keyboardOffset }}>
          <ChatFade edge="bottom" height={bottom.fadeHeight} solidHeight={bottom.fadeSolidHeight} />
          <View ref={composer} onLayout={event => { onComposerLayout(event); setComposerHeight(event.nativeEvent.layout.height); setComposerMeasured(true); }}
            style={{ paddingBottom: CHAT_LAYOUT.composerBottomGap }}>
            {!id && agent && <NewChatAgentChips recent={recentAgents} selectedId={agent.id} disabled={!editableSelection}
              onSelect={selected => newStore.select(computerId, selected)} onOpenAll={() => setAgentsOpen(generation)} />}
            <Composer draft={draft} onChangeDraft={text => {
              if (id) upload?.setText(text);
              else { if (editableSelection && agent) newStore.select(computerId, agent.id); newStore.setText(text); }
              if (notice?.kind === 'send-offline') setNoticeEntry(null);
            }} quote={quote} onCancelQuote={() => setQuoteEntry(null)} attachments={id ? upload?.items ?? [] : stagedItems}
              uploadError={draftLoading ? t('正在读取草稿…') : id && upload?.error ? t(upload.error) : null}
              textOnly={!!task} disabledReason={task?.status === 'unavailable' ? t('这个协作已无法继续') : undefined}
              sendDisabled={draftLoading || (id ? !conversation : firstBusy || !!attempt || !!saved?.failure || foreignAttempt || !agent)}
              attachmentsDisabled={attachmentsLocked}
              attachmentActionsDisabled={!id && !editableSelection}
              onPick={source => void pick(source)} onRetry={itemId => { if (id) upload?.retry(itemId); else void submitFirst(); }}
              onRemove={itemId => {
                const lease = visit.capture();
                try { if (id) upload?.remove(itemId); else newStore.removeFailedAttachment(itemId); }
                catch (error) { showNotice({ kind: 'remove', title: t('无法移除附件'), description: t(userErrorMessage(error, '无法移除附件，请重试')) }, lease); }
              }} working={turn.working} stopping={turn.stopping} onSend={send} onStop={() => { if (id) void session.stop(id); }}
              onFocus={() => dispatchWelcome({ type: 'focus', generation })} onBlur={() => dispatchWelcome({ type: 'blur', generation })}
              inlineError={notice?.kind === 'send-offline' ? notice.title : null} />
          </View>
        </KeyboardStickyView>
      </View>
      <View pointerEvents="box-none" className="absolute inset-0"><ChatHeader session={session} agent={agent} title={conversation?.title ?? t('新对话')}
        tasks={id ? conversationChildren(session, id) : []} initialCardOpen={initialCardOpen}
        collaboration={task ? { creatorName: agentDisplayName(session.agents, task.creator_agent_id), rootId: task.root_id,
          rootTitle: session.conversations.get(task.root_id)?.title ?? task.root_title } : undefined}
        working={turn.working} onOpenConversations={drawer.show} newConversationDisabled={!id} onNewConversation={drawer.newConversation} /></View>
      {!id && editableSelection && agent && agentsOpen === generation && <NewChatAgentSheet agents={recentAgents} selectedId={agent.id}
        onSelect={selected => newStore.select(computerId, selected)} onClosed={() => setAgentsOpen(null)} />}
    </View>
  </ConversationDrawer>;
}
