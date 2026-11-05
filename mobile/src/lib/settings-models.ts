import type { ModelSettings } from '../gateway/api.ts';
import type { EditorOperation } from '../gateway/editor-operation.ts';

export const modelSettingsOperationKey = 'settings:models';
type Form = { original: ModelSettings; draft: ModelSettings; seenRecoveryId?: string; notice?: 'reconciled' };
export type ModelSettingsState = { status: 'overview' }
  | (Form & { status: 'editing'; error: string })
  | (Form & { status: 'saving'; operationId: string });
export type ModelSettingsEvent =
  | { type: 'opened'; current: ModelSettings; seenRecoveryId?: string }
  | { type: 'changed'; fields: ModelSettings }
  | { type: 'closed' }
  | { type: 'unknown-left'; operationId: string }
  | { type: 'rejected'; message: string }
  | { type: 'save-started'; operationId: string }
  | { type: 'save-succeeded'; operationId: string; current: ModelSettings }
  | { type: 'save-failed'; operationId: string; message: string }
  | { type: 'adopt-recovery'; operationId: string; current: ModelSettings };

export function modelSettingsReducer(state: ModelSettingsState, event: ModelSettingsEvent): ModelSettingsState {
  switch (state.status) {
    case 'overview':
      return event.type === 'opened' ? { status: 'editing', original: event.current, draft: event.current, error: '', seenRecoveryId: event.seenRecoveryId } : state;
    case 'editing':
      switch (event.type) {
        case 'changed': return { ...state, draft: event.fields, error: '' };
        case 'closed': return { status: 'overview' };
        case 'rejected': return { ...state, draft: state.original, error: event.message };
        case 'save-started': return { ...state, status: 'saving', operationId: event.operationId };
        case 'adopt-recovery': return event.operationId === state.seenRecoveryId ? state
          : { status: 'editing', original: event.current, draft: event.current, error: '', seenRecoveryId: event.operationId, notice: 'reconciled' };
        default: return state;
      }
    case 'saving':
      switch (event.type) {
        case 'unknown-left': return event.operationId === state.operationId ? { status: 'overview' } : state;
        case 'save-succeeded': return event.operationId !== state.operationId ? state
          : { status: 'editing', original: event.current, draft: event.current, error: '', seenRecoveryId: state.seenRecoveryId };
        case 'save-failed': return event.operationId !== state.operationId ? state
          : { status: 'editing', original: state.original, draft: state.original, error: event.message, seenRecoveryId: state.seenRecoveryId };
        case 'adopt-recovery': return event.operationId !== state.operationId || event.operationId === state.seenRecoveryId ? state
          : { status: 'editing', original: event.current, draft: event.current, error: '', seenRecoveryId: event.operationId, notice: 'reconciled' };
        default: return state;
      }
  }
}
export type ModelSettingsSelection = {
  panel: boolean; busy: boolean; unknown: boolean; canEdit: boolean; canSave: boolean; dirty: boolean;
  draft?: ModelSettings; error: string; notice?: 'reconciled'; adoption?: Extract<ModelSettingsEvent, { type: 'adopt-recovery' }>;
};
export function selectModelSettings(state: ModelSettingsState, offline: boolean, outcome?: EditorOperation): ModelSettingsSelection {
  const unknown = outcome?.status === 'unknown';
  const busy = !unknown && (outcome?.status === 'pending' || state.status === 'saving');
  const adoption = state.status !== 'overview' && outcome?.reconciled && outcome.value && outcome.operationId !== state.seenRecoveryId
    && (state.status !== 'saving' || state.operationId === outcome.operationId)
    ? { type: 'adopt-recovery' as const, operationId: outcome.operationId, current: outcome.value as ModelSettings } : undefined;
  return { panel: state.status !== 'overview', busy, unknown, adoption,
    notice: state.status === 'editing' && !unknown && !adoption ? state.notice : undefined,
    canEdit: state.status === 'editing' && !busy && !unknown && !adoption,
    canSave: state.status === 'editing' && !busy && !unknown && !adoption && !offline,
    dirty: state.status !== 'overview' && (state.draft.default_model !== state.original.default_model || state.draft.default_reasoning_effort !== state.original.default_reasoning_effort),
    draft: state.status === 'overview' ? undefined : state.draft, error: state.status === 'editing' && !unknown && !adoption ? state.error : '' };
}
