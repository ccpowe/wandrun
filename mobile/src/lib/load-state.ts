/** Feedback delay, not an animation duration. Fast loads never mount an indicator. */
export const loadingDelay = 300;
export function deferLoadingIndicator(show: () => void, delay = loadingDelay) {
  const timer = setTimeout(show, delay);
  return () => clearTimeout(timer);
}
const retryDelays = [500, 1000, 2000, 5000, 10_000] as const;
export const retryDelay = (failures: number) => retryDelays[Math.min(Math.max(0, failures), retryDelays.length - 1)];

export type LoadSnapshot<T> = {
  status: 'pending' | 'ready' | 'error' | 'retrying';
  data: T | undefined;
  error: unknown;
};

/** Owns one read and its retry timer. Failed refreshes retain the last successful data.
 * start/retry coalesce while in flight; stop aborts and ignores late responses.
 * A page owns this resource and starts/stops it with its lifetime.
 */
export class LoadResource<T> {
  private snapshot: LoadSnapshot<T> = { status: 'pending', data: undefined, error: null };
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopped = false;
  private readonly load: (signal: AbortSignal) => Promise<T>;

  constructor(load: (signal: AbortSignal) => Promise<T>) { this.load = load; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(snapshot: LoadSnapshot<T>) { this.snapshot = snapshot; this.listeners.forEach(listener => listener()); }
  start = () => { this.stopped = false; if (this.snapshot.status !== 'ready') void this.retry(); };
  stop = () => {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = null;
  };
  retry = async () => {
    if (this.request || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const request = new AbortController();
    this.request = request;
    this.publish({ ...this.snapshot, status: this.snapshot.error === null ? this.snapshot.status : 'retrying' });
    try {
      const data = await this.load(request.signal);
      if (this.request !== request) return;
      this.failures = 0;
      this.publish({ status: 'ready', data, error: null });
    } catch (error) {
      if (this.request !== request) return;
      this.publish({ ...this.snapshot, status: 'error', error });
      this.timer = setTimeout(() => { this.timer = undefined; void this.retry(); }, retryDelay(this.failures++));
    } finally {
      if (this.request === request) this.request = null;
    }
  };
}
