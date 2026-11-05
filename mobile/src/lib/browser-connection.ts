const ATTEMPT_TIMEOUT_MS = 10_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 1000, 2000, 5000, 10_000];

export type BrowserConnectionState =
  | { status: 'stopped' | 'closed' | 'open' }
  | { status: 'connecting'; attemptDeadline: number }
  | { status: 'reconnecting'; deadline: number; retries: number; retryAt: number | null; attemptDeadline: number | null };
export type BrowserConnectionEvent =
  | { type: 'start'; now: number }
  | { type: 'ready'; now: number }
  | { type: 'failed'; now: number; code: number; jitter: number }
  | { type: 'wake'; now: number; jitter: number }
  | { type: 'stop' };

/** Same base waits as the SSE stream; jitter follows LiveKit's default policy. */
export function browserRetryDelay(retries: number, jitter: number): number {
  return retries === 0 ? Math.round(jitter * 500)
    : Math.round(RETRY_DELAYS_MS[Math.min(retries - 1, RETRY_DELAYS_MS.length - 1)] * (0.5 + jitter));
}
function failed(state: BrowserConnectionState, now: number, code: number, jitter: number): BrowserConnectionState {
  if (code === 4401 || code === 4404) return { status: 'stopped' };
  if ([1002, 1003, 1007, 1008, 1009, 1010, 4400].includes(code)) return { status: 'closed' };
  const deadline = state.status === 'reconnecting' ? state.deadline : now + RECOVERY_TIMEOUT_MS;
  if (now >= deadline) return { status: 'closed' };
  const retries = state.status === 'reconnecting' ? state.retries : 0;
  return { status: 'reconnecting', deadline, retries, attemptDeadline: null,
    retryAt: Math.min(now + browserRetryDelay(retries, jitter), deadline) };
}

/** browser.RT1–RT8. Time/randomness are event inputs, never reducer side effects. */
export function browserConnectionReducer(state: BrowserConnectionState, event: BrowserConnectionEvent): BrowserConnectionState {
  if (event.type === 'stop') return state.status === 'stopped' ? state : { status: 'stopped' };
  switch (state.status) {
    case 'stopped':
    case 'closed':
      return event.type === 'start' ? { status: 'connecting', attemptDeadline: event.now + ATTEMPT_TIMEOUT_MS } : state;
    case 'open':
      return event.type === 'failed' ? failed(state, event.now, event.code, event.jitter) : state;
    case 'connecting':
      if (event.type === 'failed') return failed(state, event.now, event.code, event.jitter);
      if (event.type === 'ready' && event.now < state.attemptDeadline) return { status: 'open' };
      if (event.type === 'wake' && event.now >= state.attemptDeadline) return failed(state, event.now, 1006, event.jitter);
      return state;
    case 'reconnecting':
      if (event.type === 'start') return state;
      if (event.now >= state.deadline) return { status: 'closed' };
      if (event.type === 'ready') return state.retryAt === null && event.now < state.attemptDeadline! ? { status: 'open' } : state;
      if (event.type === 'failed') return state.retryAt === null ? failed(state, event.now, event.code, event.jitter) : state;
      if (state.retryAt !== null) return event.now >= state.retryAt
        ? { ...state, retries: state.retries + 1, retryAt: null, attemptDeadline: Math.min(event.now + ATTEMPT_TIMEOUT_MS, state.deadline) } : state;
      return event.now >= state.attemptDeadline! ? failed(state, event.now, 1006, event.jitter) : state;
  }
}

export function browserConnectionWakeAt(state: BrowserConnectionState): number | null {
  return state.status === 'connecting' ? state.attemptDeadline
    : state.status === 'reconnecting' ? Math.min(state.deadline, state.retryAt ?? state.attemptDeadline!) : null;
}
