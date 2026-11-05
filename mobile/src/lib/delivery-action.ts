export type DeliveryAction = 'download' | 'share';
export type DeliveryState =
  | { status: 'idle'; error: string | null; saved: boolean }
  | { status: 'working'; operationId: string; action: DeliveryAction }
  | { status: 'closed' };
export type DeliveryEvent =
  | { type: 'start'; operationId: string; action: DeliveryAction }
  | { type: 'finished'; operationId: string; saved: boolean; error: string | null }
  | { type: 'close' };
export const initialDeliveryState: DeliveryState = { status: 'idle', error: null, saved: false };

export function deliveryReducer(state: DeliveryState, event: DeliveryEvent): DeliveryState {
  switch (state.status) {
    case 'idle':
      if (event.type === 'start') return { status: 'working', operationId: event.operationId, action: event.action };
      if (event.type === 'close') return { status: 'closed' };
      return state;
    case 'working':
      if (event.type === 'close') return { status: 'closed' };
      if (event.type === 'finished' && event.operationId === state.operationId) return { status: 'idle', error: event.error, saved: event.saved };
      return state;
    case 'closed': return state;
  }
}

/** Native access needs synchronous admission before React commits a disabled button. This is its only state owner. */
export class DeliveryAccess {
  private state: DeliveryState = initialDeliveryState;
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  send(event: DeliveryEvent): boolean {
    const next = deliveryReducer(this.state, event);
    if (next === this.state) return false;
    this.state = next;
    this.listeners.forEach(listener => listener());
    return true;
  }
  open(): void {
    if (this.state.status !== 'closed') return;
    this.state = initialDeliveryState;
    this.listeners.forEach(listener => listener());
  }
}

export type LeaseState<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; error: string };
export type LeaseEvent<T> = { type: 'ready'; value: T } | { type: 'failed'; error: string };
export function leaseReducer<T>(state: LeaseState<T>, event: LeaseEvent<T>): LeaseState<T> {
  switch (state.status) {
    case 'loading':
      return event.type === 'ready' ? { status: 'ready', value: event.value } : { status: 'failed', error: event.error };
    case 'ready':
      return event.type === 'failed' ? { status: 'failed', error: event.error } : state;
    case 'failed': return state;
  }
}
