import type { Schedule } from '../gateway/api.ts';
import type { EditorOperation } from '../gateway/editor-operation.ts';
import { changedScheduleFields, editableSchedule, type ScheduleDraft } from './schedules.ts';

type Identity = { sessionId: string; resourceId: string };
type Form = Identity & { draft: ScheduleDraft; original: ScheduleDraft; observedSnapshot?: Schedule; adoptedRecoveryId?: string; notice: string };
export type ScheduleEditorState =
  | (Identity & { status: 'loading' })
  | (Form & { status: 'editing'; error: string; dialog: 'delete' | 'reload' | null; deleteError: string })
  | (Form & { status: 'saving' | 'deleting' | 'reloading'; operationId: string })
  | (Identity & { status: 'closed' });
export type ScheduleEditorEvent =
  | ({ type: 'adopt-initial'; current: Schedule; recoveryId?: string } & Identity)
  | ({ type: 'adopt-snapshot'; current: Schedule } & Identity)
  | ({ type: 'adopt-recovery'; current: Schedule; operationId: string; notice: string; observedSnapshot?: Schedule } & Identity)
  | { type: 'change'; draft: ScheduleDraft }
  | { type: 'discard' }
  | { type: 'validation-failed'; message: string }
  | { type: 'dialog'; dialog: 'delete' | 'reload' | null }
  | { type: 'started'; action: 'saving' | 'deleting' | 'reloading'; operationId: string }
  | { type: 'failed'; operationId: string; message: string }
  | { type: 'saved'; operationId: string; current: Schedule }
  | { type: 'reloaded'; operationId: string; current: Schedule }
  | { type: 'deleted'; operationId: string };

export function scheduleEditorReducer(state: ScheduleEditorState, event: ScheduleEditorEvent): ScheduleEditorState {
  switch (state.status) {
    case 'loading':
      if (event.type === 'adopt-initial' && event.sessionId === state.sessionId && event.resourceId === state.resourceId && event.current.id === state.resourceId) {
        const draft = editableSchedule(event.current);
        return { ...state, status: 'editing', draft, original: draft, observedSnapshot: event.current, adoptedRecoveryId: event.recoveryId, notice: '', error: '', dialog: null, deleteError: '' };
      }
      return state;
    case 'closed': return state;
    case 'editing':
      switch (event.type) {
        case 'change': return { ...state, draft: event.draft, error: '', notice: '' };
        case 'discard': return { ...state, draft: state.original, error: '', dialog: null, deleteError: '' };
        case 'validation-failed': return { ...state, error: event.message };
        case 'dialog': return { ...state, dialog: event.dialog, deleteError: '' };
        case 'started': return { ...state, status: event.action, operationId: event.operationId };
        case 'adopt-snapshot':
          if (event.sessionId !== state.sessionId || event.resourceId !== state.resourceId || event.current.id !== state.resourceId || Object.keys(changedScheduleFields(state.original, state.draft)).length) return state;
          return { ...state, original: editableSchedule(event.current), draft: editableSchedule(event.current), observedSnapshot: event.current };
        case 'adopt-recovery':
          if (event.sessionId !== state.sessionId || event.resourceId !== state.resourceId || event.current.id !== state.resourceId || state.adoptedRecoveryId === event.operationId) return state;
          return { ...state, original: editableSchedule(event.current), draft: editableSchedule(event.current), observedSnapshot: event.observedSnapshot, adoptedRecoveryId: event.operationId, notice: event.notice, error: '', dialog: null, deleteError: '' };
        default: return state;
      }
    case 'saving':
    case 'deleting':
    case 'reloading': {
      if (event.type === 'adopt-recovery') {
        if (event.sessionId !== state.sessionId || event.resourceId !== state.resourceId || event.current.id !== state.resourceId || event.operationId !== state.operationId || state.adoptedRecoveryId === event.operationId) return state;
        const draft = editableSchedule(event.current);
        return { ...state, status: 'editing', draft, original: draft, observedSnapshot: event.observedSnapshot, adoptedRecoveryId: event.operationId, notice: event.notice, error: '', dialog: null, deleteError: '' };
      }
      if (!('operationId' in event) || event.operationId !== state.operationId) return state;
      if (event.type === 'failed') return { ...state, status: 'editing', error: state.status === 'saving' ? event.message : '', dialog: state.status === 'deleting' ? 'delete' : null, deleteError: state.status === 'deleting' ? event.message : '' };
      if (event.type === 'saved' && state.status === 'saving') {
        const draft = editableSchedule(event.current);
        return { ...state, status: 'editing', draft, original: draft, observedSnapshot: event.current, error: '', deleteError: '', dialog: null };
      }
      if (event.type === 'reloaded' && state.status === 'reloading') {
        const draft = editableSchedule(event.current);
        return { ...state, status: 'editing', draft, original: draft, observedSnapshot: event.current, error: '', deleteError: '', dialog: null };
      }
      if (event.type === 'deleted' && state.status === 'deleting') return { status: 'closed', sessionId: state.sessionId, resourceId: state.resourceId };
      return state;
    }
  }
}

export type ScheduleEditorExternal = Identity & { offline: boolean; deleted: boolean; outcome?: EditorOperation; current?: Schedule; fresh: boolean; agentId: string };
export function selectScheduleEditor(state: ScheduleEditorState, external: ScheduleEditorExternal): ScheduleEditorSelection {
  const { outcome, current } = external;
  const identity = state.sessionId === external.sessionId && state.resourceId === external.resourceId;
  const gone = !identity || external.deleted || outcome?.reconciled && outcome.value === null;
  const unknown = outcome?.status === 'unknown';
  const pending = outcome?.status === 'pending';
  const recovery = outcome?.reconciled && outcome.value && 'draft' in state && state.adoptedRecoveryId !== outcome.operationId
    && (state.status === 'editing' || 'operationId' in state && state.operationId === outcome.operationId) ? outcome : null;
  const draft = 'draft' in state ? state.draft : null;
  const dirty = 'original' in state && Object.keys(changedScheduleFields(state.original, state.draft)).length > 0;
  const busy = !unknown && (pending || state.status === 'saving' || state.status === 'deleting' || state.status === 'reloading');
  const phase = gone ? 'gone' : state.status === 'closed' ? 'closed' : unknown ? 'unknown' : busy ? 'busy' : state.status === 'loading' ? 'loading' : 'editing';
  let adoption: ScheduleEditorEvent | null = null;
  if (!gone && state.status !== 'closed') {
    if (state.status === 'loading' && external.fresh && current?.agent_id === external.agentId) {
      adoption = { type: 'adopt-initial', sessionId: external.sessionId, resourceId: external.resourceId, current, recoveryId: outcome?.reconciled ? outcome.operationId : undefined };
    } else if (!unknown && recovery && recovery.id === state.resourceId && (recovery.value as Schedule).id === state.resourceId) {
      adoption = { type: 'adopt-recovery', sessionId: external.sessionId, resourceId: external.resourceId, operationId: recovery.operationId, current: recovery.value as Schedule, observedSnapshot: current,
        notice: recovery.status === 'confirmed' ? '已核对，操作已完成。' : '已核对服务器上的当前内容，请检查后再保存。' };
    } else if (!unknown && external.fresh && current?.agent_id === external.agentId && state.status === 'editing' && !dirty && current !== state.observedSnapshot && Object.keys(changedScheduleFields(state.original, editableSchedule(current))).length) {
      adoption = { type: 'adopt-snapshot', sessionId: external.sessionId, resourceId: external.resourceId, current };
    }
  }
  const ready = phase === 'editing' && !adoption;
  return { phase, draft, dirty, busy, adoption, busyAction: busy ? state.status === 'reloading' ? 'reloading' : state.status === 'deleting' || outcome?.action === 'delete' ? 'deleting' : 'saving' : null,
    canEdit: ready, canSave: ready && !external.offline, canDelete: ready && !external.offline,
    canBack: !busy, autoSaveOnLeave: ready && !external.offline && state.status === 'editing' && !state.error,
    externalChange: !!current && 'original' in state && dirty && Object.keys(changedScheduleFields(state.original, editableSchedule(current))).length > 0,
    error: state.status === 'editing' ? state.error : '',
    notice: unknown ? !('operationId' in state) || state.operationId !== outcome.operationId ? outcome.action === 'delete' ? '上次删除结果未确认，正在核对。' : '上次保存结果未确认，正在核对。' : '' : 'notice' in state ? state.notice : '',
    dialog: ready && state.status === 'editing' ? state.dialog : phase === 'busy' && state.status === 'deleting' ? 'delete' : null,
    deleteError: state.status === 'editing' ? state.deleteError : '',
    leaveIdentity: `${external.sessionId}:${external.resourceId}:${phase === 'unknown' ? outcome?.operationId : phase === 'gone' ? 'gone' : 'ordinary'}`,
  };
}
export type ScheduleEditorSelection = {
  phase: 'gone' | 'closed' | 'unknown' | 'busy' | 'loading' | 'editing';
  draft: ScheduleDraft | null; dirty: boolean; busy: boolean; adoption: ScheduleEditorEvent | null;
  busyAction: 'saving' | 'deleting' | 'reloading' | null;
  canEdit: boolean; canSave: boolean; canDelete: boolean; canBack: boolean; autoSaveOnLeave: boolean;
  externalChange: boolean; error: string; notice: string; dialog: 'delete' | 'reload' | null; deleteError: string; leaveIdentity: string;
};
