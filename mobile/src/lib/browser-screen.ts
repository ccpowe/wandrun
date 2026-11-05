import type { BrowserTask } from '../gateway/api.ts';
import type { EditorOperation } from '../gateway/editor-operation.ts';
import type { PageState } from '../browser/pages.ts';

export type BrowserCommand = 'takeover' | 'handback' | 'close-page';
export type BrowserPanel = { kind: 'stage' } | { kind: 'url'; draft: string } | { kind: 'pages' } | { kind: 'more' } | { kind: 'close-page'; target: string };
type Local = { panel: BrowserPanel; error: string; debug: boolean; reconnect: number };
export type BrowserScreenState = Local & ({ status: 'idle' } | { status: 'running'; operationId: string; command: BrowserCommand });
export type BrowserScreenEvent =
  | { type: 'start'; operationId: string; command: BrowserCommand }
  | { type: 'succeeded'; operationId: string; remainingPages?: number }
  | { type: 'failed'; operationId: string; error: string }
  | { type: 'panel'; panel: BrowserPanel }
  | { type: 'url'; draft: string }
  | { type: 'debug'; value: boolean }
  | { type: 'reconnect' }
  | { type: 'keyboard-hidden' }
  | { type: 'dismiss-error' };
export const initialBrowserScreen: BrowserScreenState = { status: 'idle', panel: { kind: 'stage' }, error: '', debug: false, reconnect: 0 };
export function browserScreenReducer(state: BrowserScreenState, event: BrowserScreenEvent): BrowserScreenState {
  switch (state.status) {
    case 'idle':
      switch (event.type) {
        case 'start': return { ...state, status: 'running', operationId: event.operationId, command: event.command, error: '' };
        case 'panel': return { ...state, panel: event.panel };
        case 'url': return state.panel.kind === 'url' ? { ...state, panel: { kind: 'url', draft: event.draft } } : state;
        case 'debug': return { ...state, debug: event.value };
        case 'reconnect': return { ...state, reconnect: state.reconnect + 1, error: '' };
        case 'dismiss-error': return { ...state, error: '' };
        case 'keyboard-hidden': return state.panel.kind === 'url' ? { ...state, panel: { kind: 'stage' } } : state;
        default: return state;
      }
    case 'running':
      switch (event.type) {
        case 'succeeded':
        case 'failed': {
          if (event.operationId !== state.operationId) return state;
          const panel = event.type === 'succeeded' && state.command === 'close-page'
            ? event.remainingPages === 0 ? { kind: 'stage' } as const : state.panel.kind === 'close-page' ? { kind: 'pages' } as const : state.panel
            : state.panel;
          return { status: 'idle', panel, error: event.type === 'failed' ? event.error : '', debug: state.debug, reconnect: state.reconnect };
        }
        case 'panel': return { ...state, panel: event.panel };
        case 'url': return state.panel.kind === 'url' ? { ...state, panel: { kind: 'url', draft: event.draft } } : state;
        case 'debug': return { ...state, debug: event.value };
        case 'reconnect': return { ...state, reconnect: state.reconnect + 1, error: '' };
        case 'dismiss-error': return { ...state, error: '' };
        case 'keyboard-hidden': return state.panel.kind === 'url' ? { ...state, panel: { kind: 'stage' } } : state;
        default: return state;
      }
  }
}

/** External snapshots remain owned by session/Query/runtime/EditorOperations. */
export function selectBrowserScreen(state: BrowserScreenState, external: {
  task?: BrowserTask | null; pages: PageState; ended: boolean; online: boolean; control: boolean;
  outcome?: Readonly<EditorOperation>;
}) {
  const { task, pages, ended, online, control, outcome } = external;
  const effectiveState = task && (task.state === 'released' || task.state === 'revoking' || task.state === 'stopping')
    ? task.state : pages.snapshot?.state ?? task?.state;
  const stopped = ended || effectiveState === 'released' || effectiveState === 'stopping';
  const unknown = outcome?.status === 'unknown';
  const pending = outcome?.status === 'pending';
  // An unknown operation may already have reconciled before its original catch runs.
  const localBusy = state.status === 'running' && !(outcome?.operationId === state.operationId && outcome.status !== 'pending');
  const busy = pending || localBusy;
  const canCommand = online && !stopped && !unknown && !busy && !!task;
  const canHandback = effectiveState === 'human' && !stopped;
  const error = unknown ? (online ? '操作结果未确认，正在核对结果' : '操作结果未确认，恢复连接后会核对结果') : state.error;
  return { effectiveState, stopped, unknown, busy, canHandback,
    human: control && canHandback,
    canTakeover: canCommand && (effectiveState === 'requested' || effectiveState === 'agent' || canHandback),
    canReturnControl: canCommand && canHandback,
    canClosePage: canCommand && control && canHandback,
    panel: stopped ? { kind: 'stage' } as const : state.panel, error };
}
