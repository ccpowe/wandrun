import { useQueryClient } from '@tanstack/react-query';
import { Redirect, router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StackActions } from 'expo-router/react-navigation';
import { useCallback, useImperativeHandle, useReducer, useRef, useState, useSyncExternalStore, type Ref } from 'react';
import { BackHandler } from 'react-native';
import { AgentEditorLeaveSheets, useEditorLeave } from '@/components/editor-leave-sheet.tsx';
import { ScheduleEditorView } from '@/components/schedule-editor-view.tsx';
import { GatewayError } from '@/gateway/api.ts';
import { newClientId, type ChatSession } from '@/gateway/session.ts';
import { ConnectionBanner } from '@/lib/connection-banner.tsx';
import { readScheduleForReload, scheduleDetailOptions, scheduleRunsOptions } from '@/lib/gateway-queries.ts';
import { scheduleEditorReducer, selectScheduleEditor, type ScheduleEditorExternal, type ScheduleEditorSelection } from '@/lib/schedule-editor.ts';
import { changedScheduleFields, validateSchedule } from '@/lib/schedules.ts';
import { useSession } from '@/lib/session-context.tsx';
import { useFocusedVisit } from '@/lib/use-focused-visit.ts';
import { useGatewayInfiniteQuery, useGatewayQuery } from '@/lib/use-gateway-query.ts';
import { userErrorMessage } from '@/lib/user-error.ts';

export default function ScheduleEditorRoute() {
  const { id, agentId } = useLocalSearchParams<{ id?: string; agentId: string }>();
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  if (!id) return <Redirect href={{ pathname: '/agents/[id]', params: { id: agentId, tab: 'schedules' } }} />;
  return <ScheduleEditor id={id} agentId={agentId} session={session} />;
}
export function ScheduleEditor(props: { id: string; agentId: string; session: ChatSession }) {
  return <ScheduleEditorContainer key={`${props.session.queryIdentity}:${props.agentId}:${props.id}`} {...props} />;
}

type LeaveControl = { back: () => void; submit: () => Promise<void>; finish: () => void; conversation: (id: string) => void };
function ScheduleLeaveBoundary({ selection, changes, save, onDiscard, agentId, ref }: {
  selection: ScheduleEditorSelection; changes: string[]; save: () => Promise<boolean>; onDiscard: () => void; agentId: string; ref: Ref<LeaveControl>;
}) {
  const [unknownOpen, setUnknownOpen] = useState(false);
  const dismiss = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/agents/[id]', params: { id: agentId, tab: 'schedules' } });
  }, [agentId]);
  const requestUnknown = useCallback(() => setUnknownOpen(true), []);
  const unknown = selection.phase === 'unknown';
  const leave = useEditorLeave(selection.dirty, selection.busy, dismiss, unknown || selection.phase === 'gone', save,
    selection.autoSaveOnLeave, unknown ? requestUnknown : undefined);
  useImperativeHandle(ref, () => ({ back: () => leave.request(), submit: leave.submit, finish: leave.complete,
    conversation: id => leave.requestAction(StackActions.push('chat', { id })),
  }), [leave]);
  useFocusEffect(useCallback(() => {
    if (selection.phase === 'gone' || selection.phase === 'closed') { leave.complete(); return; }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { leave.request(); return true; });
    return () => subscription.remove();
  }, [selection.phase, leave]));
  return <AgentEditorLeaveSheets ordinaryOpen={leave.open} unknownOpen={unknown && unknownOpen} changes={changes} busy={selection.busy}
    onDiscard={() => { onDiscard(); leave.finish(); }} onContinue={leave.cancel} onUnknownStay={() => { setUnknownOpen(false); leave.cancel(); }}
    onUnknownLeave={() => { setUnknownOpen(false); leave.finish(); }} />;
}

function ScheduleEditorContainer({ id, agentId, session }: { id: string; agentId: string; session: ChatSession }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const captureVisit = useFocusedVisit();
  const client = useQueryClient();
  const [state, dispatch] = useReducer(scheduleEditorReducer, { status: 'loading', sessionId: session.queryIdentity, resourceId: id });
  const leave = useRef<LeaveControl>(null);
  const read = useGatewayQuery(scheduleDetailOptions(session, id));
  const runs = useGatewayInfiniteQuery(scheduleRunsOptions(session, id));
  const operationKey = `schedule:${id}`;
  const external: ScheduleEditorExternal = { sessionId: session.queryIdentity, resourceId: id, agentId,
    offline: session.connection !== 'open', deleted: session.deletedScheduleIds.has(id) || session.agents.deletedIds.has(agentId)
      || read.error instanceof GatewayError && read.error.status === 404,
    outcome: session.editorOperations.get(operationKey), current: read.data, fresh: read.isFetchedAfterMount && read.isSuccess };
  const selection = selectScheduleEditor(state, external);
  if (selection.adoption) dispatch(selection.adoption);
  const currentSelection = () => selectScheduleEditor(state, { ...external, offline: session.connection !== 'open',
    deleted: external.deleted || session.deletedScheduleIds.has(id), outcome: session.editorOperations.get(operationKey) });
  async function save(): Promise<boolean> {
    if (!currentSelection().canSave || state.status !== 'editing') return false;
    const patch = changedScheduleFields(state.original, state.draft);
    if (!Object.keys(patch).length) return true;
    const problem = validateSchedule(state.draft);
    if (problem) { dispatch({ type: 'validation-failed', message: problem.message }); return false; }
    const operationId = newClientId();
    const stillHere = captureVisit();
    dispatch({ type: 'started', action: 'saving', operationId });
    try {
      const result = await session.editorOperations.run(operationKey, { operationId, resource: 'schedule', id, action: 'save', fields: patch, baseline: state.original }, () => session.api.updateSchedule(id, patch));
      if (!result) { dispatch({ type: 'failed', operationId, message: '保存未完成' }); return false; }
      const options = scheduleDetailOptions(session, id);
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      client.setQueryData(options.queryKey, result.schedule);
      const close = stillHere() && currentSelection().phase !== 'gone';
      dispatch({ type: 'saved', operationId, current: result.schedule });
      return close;
    } catch (error) {
      const outcome = session.editorOperations.get(operationKey);
      if (outcome?.operationId !== operationId || outcome.status !== 'unknown' && !outcome.reconciled) dispatch({ type: 'failed', operationId, message: userErrorMessage(error, '保存未完成') });
      return false;
    }
  }
  const remove = async () => {
    if (!currentSelection().canDelete || state.status !== 'editing' || state.dialog !== 'delete') return;
    const operationId = newClientId();
    const stillHere = captureVisit();
    dispatch({ type: 'started', action: 'deleting', operationId });
    try {
      const result = await session.editorOperations.run(operationKey, { operationId, resource: 'schedule', id, action: 'delete' }, () => session.api.deleteSchedule(id));
      if (!result) { dispatch({ type: 'failed', operationId, message: '删除未完成，请重新加载后重试' }); return; }
      const close = stillHere();
      dispatch({ type: 'deleted', operationId });
      if (close) leave.current?.finish();
    } catch (error) {
      const outcome = session.editorOperations.get(operationKey);
      if (outcome?.operationId !== operationId || outcome.status !== 'unknown' && !outcome.reconciled) dispatch({ type: 'failed', operationId, message: userErrorMessage(error, '删除未完成，请重新加载后重试') });
    }
  };
  const reload = async () => {
    if (!currentSelection().canSave) return;
    const operationId = newClientId();
    dispatch({ type: 'started', action: 'reloading', operationId });
    try {
      const current = await readScheduleForReload(session, id);
      dispatch({ type: 'reloaded', operationId, current });
    } catch { dispatch({ type: 'failed', operationId, message: '' }); }
  };
  const changes = state.status !== 'loading' && state.status !== 'closed'
    ? Object.keys(changedScheduleFields(state.original, state.draft)).map(key => ({ name: '名称', content: '要做什么', rule: '重复与时间', timezone: '时区', enabled: '启用' })[key as keyof typeof state.draft]!) : [];
  const runsError = !!runs.error;
  const readFailure = read.error ? '无法加载定时，正在重试…' : runsError ? '无法加载运行记录，正在重试…' : '';
  const mismatch = read.data && read.data.agent_id !== agentId;
  const feedback = selection.phase === 'unknown' ? selection.notice || '结果未确认，恢复连接后会核对' : selection.error || (mismatch ? '定时不属于这个 Agent' : readFailure) || selection.notice;
  const seen = new Set<number>();
  const rows = (runs.data?.pages.flatMap(page => page.runs) ?? []).filter(run => { if (seen.has(run.id)) return false; seen.add(run.id); return true; })
    .map(run => ({ ...run, linkedConversation: run.conversation_id && !session.isDeleted(run.conversation_id) ? run.conversation_id : null }));
  return <>
    <Stack.Screen options={{ headerShown: false, gestureEnabled: !selection.busy }} />
    <ScheduleEditorView selection={selection} detail={read.data} offline={external.offline} feedback={feedback} readFailure={readFailure && feedback === readFailure ? read.error ? 'detail' : 'runs' : null}
      connectionBanner={<ConnectionBanner session={session} />} runs={rows} runsLoading={runs.isFetching} runsLoaded={runs.data !== undefined} runsError={runsError} hasMore={runs.hasNextPage}
      onBack={() => leave.current?.back()} onSave={() => void leave.current?.submit()} onChange={draft => { if (currentSelection().canEdit) dispatch({ type: 'change', draft }); }}
      onDialog={dialog => { if (currentSelection().canEdit) dispatch({ type: 'dialog', dialog }); }} onReload={() => void reload()} onDelete={() => void remove()}
      onMore={() => { if (!runs.isFetching && runs.hasNextPage) void runs.fetchNextPage({ cancelRefetch: false }); }} onConversation={conversation => leave.current?.conversation(conversation)} />
    <ScheduleLeaveBoundary key={selection.leaveIdentity} ref={leave} selection={selection} changes={changes} save={save} onDiscard={() => dispatch({ type: 'discard' })} agentId={agentId} />
  </>;
}
