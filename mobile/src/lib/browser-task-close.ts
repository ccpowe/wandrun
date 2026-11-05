export type BrowserTaskCloseState =
  | { status: 'idle'; taskId?: string; error: string }
  | { status: 'running'; taskId: string; operationId: string };
export type BrowserTaskCloseEvent =
  | { type: 'start'; taskId: string; operationId: string }
  | { type: 'settled'; operationId: string; error: string };
export function browserTaskCloseReducer(state: BrowserTaskCloseState, event: BrowserTaskCloseEvent): BrowserTaskCloseState {
  switch (state.status) {
    case 'idle': return event.type === 'start' ? { status: 'running', taskId: event.taskId, operationId: event.operationId } : state;
    case 'running':
      if (event.type !== 'settled' || event.operationId !== state.operationId) return state;
      return { status: 'idle', taskId: state.taskId, error: event.error };
  }
}
