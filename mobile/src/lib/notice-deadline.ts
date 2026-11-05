/** A display lease follows one continuous state identity, never the lifetime of its copy. */
export class NoticeDeadline {
  private visible = false;
  private identity: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private detach: (() => void) | undefined;
  private readonly read: () => string | null;
  private readonly subscribeSource?: (listener: () => void) => () => void;
  constructor(read: () => string | null, subscribeSource?: (listener: () => void) => () => void) {
    this.read = read;
    this.subscribeSource = subscribeSource;
  }
  snapshot = () => this.visible && this.identity === this.read();
  private publish(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const listener of this.listeners) listener();
  }
  private observe = () => {
    const identity = this.read();
    if (identity === this.identity) return;
    this.identity = identity;
    clearTimeout(this.timer);
    this.publish(false);
    if (identity !== null) this.timer = setTimeout(() => this.publish(true), 3000);
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.detach = this.subscribeSource?.(this.observe);
      this.observe();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.detach?.();
      this.detach = undefined;
      clearTimeout(this.timer);
      this.identity = null;
      this.visible = false;
    };
  };
}
