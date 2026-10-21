import { ChatSession } from "../gateway/session.ts";
import type { SavedComputer } from "./credentials.ts";

export type ActiveSession = { owner: SavedComputer; session: ChatSession; key: number };

/** Serializes session transport teardown before opening the next computer. Accepted
 * native downloads finish under their original owner; they cannot publish into the new session.
 * Superseded selections never start. A new navigation key discards old resource IDs. */
export class SessionOwner {
  private current: ActiveSession | null = null;
  private desired: SavedComputer | null = null;
  private closing: Promise<void> = Promise.resolve();
  private revision = 0;
  private nextKey = 0;
  private listeners = new Set<() => void>();
  private readonly create: (config: SavedComputer) => ChatSession;
  private readonly suspend: (computerId: string) => Promise<void>;

  private readonly started: (active: ActiveSession) => void;
  constructor(create: (config: SavedComputer) => ChatSession, suspend: (computerId: string) => Promise<void>, started: (active: ActiveSession) => void = () => {}) {
    this.create = create;
    this.suspend = suspend;
    this.started = started;
  }
  snapshot = (): ActiveSession | null => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(active: ActiveSession | null): void {
    this.current = active;
    for (const listener of this.listeners) listener();
  }
  select(config: SavedComputer | null): Promise<void> {
    if (this.desired?.connectionId === config?.connectionId) return this.closing;
    this.desired = config;
    const revision = ++this.revision;
    const previous = this.current;
    this.publish(null);
    // Suspend retains tus URLs/bytes and aborts local DELETE requests without waiting
    // for remote cleanup. Close aborts session HTTP/SSE/WebSockets; both form the barrier.
    if (previous) {
      const suspended = this.suspend(previous.owner.computerId);
      const closed = previous.session.close();
      this.closing = Promise.all([this.closing, suspended, closed]).then(() => {});
    }
    const selected = this.closing.then(() => {
      if (revision !== this.revision || !config) return;
      const session = this.create(config);
      const active = { owner: config, session, key: ++this.nextKey };
      this.publish(active);
      void session.start().then(() => { if (this.current === active) this.started(active); });
    });
    this.closing = selected;
    return selected;
  }
}
