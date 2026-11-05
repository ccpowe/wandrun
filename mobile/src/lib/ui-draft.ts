import type { UiAttempt, UiDraft, UiFailure } from './agent-message.ts';

export type UiDraftEvent =
  | { type: 'values'; values: Record<string, unknown> }
  | { type: 'start'; attempt: UiAttempt; retry: boolean }
  | { type: 'accepted'; clientId: string }
  | { type: 'failed'; clientId: string; failure: UiFailure; unknown: boolean }
  | { type: 'check' | 'check-failed'; clientId: string }
  | { type: 'checked'; clientId: string; failure: UiFailure };

/** rich.T1–T5: one frozen attempt owns sending/unknown/retry; external persisted receipts
 * override this entire draft in ChatSession, not by copying a receipt into the reducer. */
export function uiDraftReducer(state: UiDraft, event: UiDraftEvent): UiDraft {
  const flow = state.flow;
  switch (flow.status) {
    case 'editing':
      if (event.type === 'values') return { ...state, values: event.values };
      if (event.type === 'start' && !event.retry) return { ...state, flow: { status: 'sending', attempt: event.attempt } };
      return state;
    case 'sending':
      if (event.type === 'accepted' && event.clientId === flow.attempt.clientId)
        return { ...state, flow: { status: 'awaiting', attempt: flow.attempt } };
      if (event.type === 'failed' && event.clientId === flow.attempt.clientId)
        return { ...state, flow: event.unknown ? { status: 'unknown', attempt: flow.attempt } :
          { status: 'failed', attempt: event.failure.editable ? null : flow.attempt, error: event.failure } };
      return state;
    case 'unknown':
      if (event.type === 'check' && event.clientId === flow.attempt.clientId)
        return { ...state, flow: { status: 'checking', attempt: flow.attempt } };
      return state;
    case 'checking':
      if (event.type === 'checked' && event.clientId === flow.attempt.clientId)
        return { ...state, flow: { status: 'failed', attempt: flow.attempt, error: event.failure } };
      if (event.type === 'check-failed' && event.clientId === flow.attempt.clientId)
        return { ...state, flow: { status: 'unknown', attempt: flow.attempt } };
      return state;
    case 'failed':
      if (event.type === 'values' && flow.error.editable) return { ...state, values: event.values };
      if (event.type === 'start' && (flow.attempt
        ? event.retry && flow.error.retryable && event.attempt.clientId === flow.attempt.clientId && event.attempt.actionId === flow.attempt.actionId
        : !event.retry && flow.error.editable)) return { ...state, flow: { status: 'sending', attempt: flow.attempt ?? event.attempt } };
      return state;
    case 'awaiting':
      return state;
  }
}

/** Local previews have the same synchronous state-owner admission as a session-backed block.
 * This is an external store, not a ref mirror of React state, so same-turn double taps are rejected. */
export function createUiDraftStore(initial: UiDraft) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch(event: UiDraftEvent) {
      const next = uiDraftReducer(state, event);
      if (next === state) return false;
      state = next;
      for (const listener of listeners) listener();
      return true;
    },
  };
}

export type CopyState = { status: 'idle' } | { status: 'copying' | 'done' | 'failed'; operation: string };
export type CopyEvent = { type: 'start' | 'done' | 'failed' | 'reset'; operation: string };
/** rich.T6: late clipboard outcomes and old reset timers cannot replace a newer result. */
export function copyReducer(state: CopyState, event: CopyEvent): CopyState {
  switch (state.status) {
    case 'idle':
    case 'done':
    case 'failed':
      if (event.type === 'start') return { status: 'copying', operation: event.operation };
      if (state.status === 'done' && event.type === 'reset' && state.operation === event.operation) return { status: 'idle' };
      return state;
    case 'copying':
      if (event.operation !== state.operation) return state;
      if (event.type === 'done' || event.type === 'failed') return { status: event.type, operation: event.operation };
      return state;
  }
}
