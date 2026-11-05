import { isCancelledError, skipToken } from '@tanstack/react-query';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useImperativeHandle, useReducer, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { BackHandler } from 'react-native';
import { createResultUnknown, GatewayError, type MemoryDetail, type MemoryScope } from '@/gateway/api.ts';
import { newClientId, type ChatSession } from '@/gateway/session.ts';
import { conflictMemory, memoryError, memoryLength, memoryModified, newDetailIndex, normalizeMemory } from '@/lib/agent-memory.ts';
import { agentDisplayName } from '@/lib/agent-display-name.ts';
import { ConnectionBanner } from '@/lib/connection-banner.tsx';
import { memoryDetailOptions, memoryIndexOptions, readMemoryForReload } from '@/lib/gateway-queries.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { memoryEditorReducer, selectMemoryEditor, type MemoryEditorKind, type MemoryEditorSelection, type MemoryEditorExternal } from '@/lib/memory-editor.ts';
import { memoryIndexEntries } from '@/lib/memory-index.ts';
import { useFocusedVisit } from '@/lib/use-focused-visit.ts';
import { useGatewayQuery } from '@/lib/use-gateway-query.ts';
import { useMemorySaveCheck } from '@/lib/use-memory-save-check.ts';
import { useEditorLeave } from './editor-leave-sheet.tsx';
import { MemoryDetailView } from './memory-detail-view.tsx';
import { MemoryEditorView } from './memory-editor-view.tsx';
import { MemorySaveNotice } from './memory-save-notice.tsx';
import { AlertDialog, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog.tsx';
import { Button } from './ui/button.tsx';
import { Text } from './ui/text.tsx';

type LeaveControl = { back: () => void };
function MemoryLeaveBoundary({ selection, checkStatus, online, index, deleting, onBlur, ref }: {
  selection: MemoryEditorSelection; checkStatus: 'idle' | 'checking' | 'unknown'; online: boolean; index: boolean; deleting: boolean; onBlur: () => void; ref: Ref<LeaveControl>;
}) {
  const { t } = useTranslation();
  const [unknownOpen, setUnknownOpen] = useState(false);
  const gone = selection.phase === 'gone';
  const dismiss = useCallback(() => {
    if (gone) router.dismissTo('/');
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [gone]);
  const requestUnknown = useCallback(() => setUnknownOpen(true), []);
  const unknown = checkStatus !== 'idle';
  const leave = useEditorLeave(selection.dirty, selection.busy, dismiss, unknown || selection.phase === 'gone', undefined, false, unknown ? requestUnknown : undefined);
  useImperativeHandle(ref, () => ({ back: () => leave.request() }), [leave]);
  const finish = leave.complete;
  useFocusEffect(useCallback(() => {
    if (selection.phase === 'gone' || selection.phase === 'closed') finish();
  }, [selection.phase, finish]));
  useFocusEffect(useCallback(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { leave.request(); return true; });
    return () => subscription.remove();
  }, [leave]));
  return <>
    <MemorySaveNotice status={checkStatus} online={online} leaveOpen={unknownOpen} deleting={deleting} onContinue={() => { setUnknownOpen(false); leave.cancel(); }} onLeave={() => { onBlur(); setUnknownOpen(false); leave.finish(); }} />
    <AlertDialog open={leave.open} onOpenChange={open => { if (!open) leave.cancel(); }}><AlertDialogContent testID="memory-discard-dialog">
      <AlertDialogHeader><AlertDialogTitle>{index ? t('放弃未保存的记忆？') : t('放弃未保存的详情？')}</AlertDialogTitle></AlertDialogHeader>
      <AlertDialogFooter><Button testID="memory-discard-stay" intent="soft" onPress={leave.cancel}><Text>{t('继续编辑')}</Text></Button><Button testID="memory-discard-leave" intent="destructive" onPress={leave.finish}><Text>{t('放弃')}</Text></Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}

/** CAS, conflict and ambiguous writes are memory-domain operations, not ordinary editor PATCH outcomes. */
export function MemoryEditorContainer({ session, scope, id, kind, slug = '' }: { session: ChatSession; scope: MemoryScope; id: string; kind: MemoryEditorKind; slug?: string }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const { t } = useTranslation();
  const resourceId = `${scope}:${scope === 'profile' ? 'profile' : id}:${kind === 'index' ? 'index' : slug || 'new'}`;
  const [state, dispatch] = useReducer(memoryEditorReducer, { status: 'loading', sessionId: session.queryIdentity, resourceId, kind, slug });
  const { check, status: checkStatus } = useMemorySaveCheck(session, scope, id);
  const captureVisit = useFocusedVisit();
  const leave = useRef<LeaveControl>(null);
  const suspended = state.status === 'closed' || state.status === 'gone' || checkStatus !== 'idle' || state.status === 'working' && state.action !== 'reload';
  const indexRead = useGatewayQuery(memoryIndexOptions(session, scope, id), !suspended);
  const detailSlug = 'slug' in state ? state.slug : slug;
  const detailKind = 'kind' in state ? state.kind : kind;
  const hasDetail = detailKind === 'detail' && !!indexRead.data?.details[detailSlug];
  const detailRead = useGatewayQuery(hasDetail ? memoryDetailOptions(session, scope, id, detailSlug) : skipToken, !suspended);
  const detail = detailKind === 'detail' && indexRead.data && !hasDetail ? null : detailRead.data;
  const external: MemoryEditorExternal = { sessionId: session.queryIdentity, resourceId, index: indexRead.data, detail,
    indexFresh: indexRead.isFetchedAfterMount && indexRead.isSuccess, detailFresh: !hasDetail || detailRead.isFetchedAfterMount && detailRead.isSuccess,
    deleted: scope === 'work' && (session.agents.deletedIds.has(id) || indexRead.error instanceof GatewayError && indexRead.error.status === 404),
    checkStatus, offline: session.connection !== 'open' };
  const selection = selectMemoryEditor(state, external);
  if (selection.adoption) dispatch(selection.adoption);
  const current = () => selectMemoryEditor(state, { ...external, checkStatus: check.getSnapshot().status, offline: session.connection !== 'open', deleted: external.deleted || scope === 'work' && session.agents.deletedIds.has(id) });
  const form = selection.form;
  const open = (next?: string) => {
    if (!current().canOpen || check.busy) return;
    router.push({ pathname: '/memory-detail', params: { scope, id, ...(next ? { slug: next } : { create: '1' }) } });
  };
  const save = async () => {
    if (!current().canSave || !form) return;
    const content = normalizeMemory(form.content);
    if (form.kind === 'create' && form.base.details[form.slug]) { dispatch({ type: 'validation-failed', message: '条目标识已存在，请换一个' }); return; }
    const indexContent = form.kind === 'create' ? newDetailIndex(form.base.content, scope, form.slug) : undefined;
    if (indexContent && memoryLength(indexContent) > form.base.limit) { dispatch({ type: 'validation-failed', message: '索引超过上限，请先精简索引' }); return; }
    const operationId = newClientId();
    const stillHere = captureVisit();
    dispatch({ type: 'started', action: 'save', operationId });
    try {
      const saved = await check.execute(operationId, () => form.kind === 'index' ? session.api.updateMemory(scope, id, content, form.base.version)
        : session.api.updateMemoryDetail(scope, id, form.slug, content, form.base.version, indexContent));
      if (!saved) return;
      const ref = saved.details[form.slug];
      const savedDetail: MemoryDetail | null = form.kind !== 'index' && ref ? { scope, ...(scope === 'work' ? { agent_id: id } : {}), slug: form.slug, content, version: saved.version, ...ref, limit: selection.limit } : null;
      const close = stillHere() && !(scope === 'work' && session.agents.deletedIds.has(id));
      dispatch({ type: 'saved', operationId, index: saved, detail: savedDetail, close });
    } catch (reason) {
      if (scope === 'work' && reason instanceof GatewayError && reason.status === 404) { dispatch({ type: 'agent-gone', operationId }); return; }
      if (reason instanceof GatewayError && reason.status === 409) {
        dispatch({ type: 'conflict', operationId, index: conflictMemory(reason.details, scope, id) });
        void indexRead.refresh(); void detailRead.refresh();
      } else if (createResultUnknown(reason) || reason instanceof GatewayError && reason.status === 408) {
        check.begin({ version: form.base.version, content, ...(form.kind === 'index' ? {} : { slug: form.slug }) }, result => {
          const close = result.outcome === 'saved' && captureVisit()();
          dispatch({ type: 'checked', operationId, result, close });
        });
      } else dispatch({ type: 'failed', operationId, message: t('保存失败，草稿仍在：{error}', { error: memoryError(reason) }) });
    }
  };
  const reload = async () => {
    if (!current().canReload || !form || check.busy) return;
    const operationId = newClientId();
    dispatch({ type: 'started', action: 'reload', operationId });
    try {
      const result = await check.execute(operationId, () => readMemoryForReload(session, scope, id, form.kind === 'detail' ? form.slug : undefined));
      if (!result) return;
      dispatch({ type: 'reloaded', operationId, ...result });
    } catch (reason) { dispatch({ type: 'failed', operationId, message: isCancelledError(reason) ? '' : t('重新载入失败，草稿仍在：{error}', { error: memoryError(reason) }) }); }
  };
  const deleteDialog = (show: boolean) => {
    if (!current().canDelete || !form?.detail) return;
    if (show && form.deleteIndex.includes(form.detail.path)) { dispatch({ type: 'validation-failed', message: '请先从索引中移除该详情的所有链接' }); return; }
    if (show && memoryLength(form.deleteIndex) > form.base.limit) { dispatch({ type: 'validation-failed', message: '索引超过上限，请先精简索引' }); return; }
    dispatch({ type: 'delete-dialog', open: show });
  };
  const remove = async () => {
    if (!current().canDelete || !form?.deleteOpen || check.pending) return;
    const operationId = newClientId();
    const stillHere = captureVisit();
    dispatch({ type: 'started', action: 'delete', operationId });
    try {
      const result = await check.execute(operationId, () => session.api.deleteMemoryDetail(scope, id, form.slug, normalizeMemory(form.deleteIndex), form.base.version));
      if (!result) return;
      dispatch({ type: 'deleted', operationId, close: stillHere() });
    } catch (reason) {
      if (reason instanceof GatewayError && reason.status === 409) {
        dispatch({ type: 'conflict', operationId, index: conflictMemory(reason.details, scope, id) });
        void indexRead.refresh(); void detailRead.refresh();
      } else if (createResultUnknown(reason) || reason instanceof GatewayError && reason.status === 408) {
        check.begin({ version: form.base.version, content: normalizeMemory(form.deleteIndex), slug: form.slug, action: 'delete' }, result => {
          const close = result.outcome === 'saved' && captureVisit()();
          dispatch({ type: 'checked', operationId, result, close });
        });
      } else dispatch({ type: 'failed', operationId, message: '删除未完成，请重新加载后重试' });
    }
  };
  const boundary = <MemoryLeaveBoundary key={selection.leaveIdentity} ref={leave} selection={selection} checkStatus={checkStatus} online={!external.offline} index={kind === 'index'} deleting={state.status === 'working' && state.action === 'delete'} onBlur={check.blur} />;
  const common = { selection, connectionBanner: <ConnectionBanner session={session} />, notice: boundary,
    readError: [indexRead.error && 'index', detailRead.error && 'detail'].filter(Boolean).join('|') || null, online: !external.offline, onBack: () => leave.current?.back(), onSave: () => void save(),
    onContent: (content: string) => { if (current().canEdit) dispatch({ type: 'change', content }); }, onReload: () => void reload(), onOpen: open };
  const agentName = scope === 'work' ? agentDisplayName(session.agents, id) : undefined;
  const title = form?.kind === 'create' || state.status === 'loading' && kind === 'create' ? t('新建详情')
    : selection.index ? memoryIndexEntries(selection.index.content, selection.index).find(entry => entry.slug === detailSlug)?.title ?? detailSlug : detailSlug;
  return <><Stack.Screen options={{ headerShown: false, gestureEnabled: !selection.busy }} />
    {kind === 'index' ? <MemoryEditorView {...common} scope={scope} onShowCurrent={() => dispatch({ type: 'show-current' })} />
      : <MemoryDetailView {...common} title={title} owner={scope === 'profile' ? t('关于你') : t('{name} 的工作记忆', { name: agentName ?? '' })}
        modified={selection.index ? memoryModified(selection.index, agentName) : null} onSlug={next => { if (current().canEdit) dispatch({ type: 'slug', slug: next }); }}
        onEdit={() => { if (current().canStartEdit && selection.index && selection.detail) dispatch({ type: 'edit', index: selection.index, detail: selection.detail }); }}
        onReviewDelete={() => { if (current().canDelete && selection.index && selection.detail) dispatch({ type: 'review-delete', index: selection.index, detail: selection.detail }); }}
        onDeleteIndex={content => { if (selection.phase === 'ready') dispatch({ type: 'delete-index', content }); }} onCancelDelete={() => dispatch({ type: 'cancel-delete' })}
        onDeleteDialog={deleteDialog} onDelete={() => void remove()} />}
  </>;
}
