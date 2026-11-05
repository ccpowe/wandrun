import type { AgentMemory, MemoryDetail, MemoryScope } from '../gateway/api.ts';
import type { ChatSession } from '../gateway/session.ts';
import { normalizeMemory } from './agent-memory.ts';

export type MemorySubmission = { version: string; content: string; slug?: string; action?: 'delete' };
export type MemoryCheckResult = { outcome: 'saved' | 'not-saved' | 'conflict'; index: AgentMemory; detail: MemoryDetail | null };
type PendingCheck = { submission: MemorySubmission; accept: (result: MemoryCheckResult) => void };
type CheckState = { status: 'idle' } | ({ status: 'checking' | 'unknown' } & PendingCheck);

/** A matching current value is sufficient for success, not a receipt for the original PUT.
 * An unchanged current CAS version permits retry against the original baseline, not a claim about write history. */
export function memoryCheckResult(submission: MemorySubmission, index: AgentMemory, detail: MemoryDetail | null): MemoryCheckResult {
  const matches = submission.action === 'delete'
    ? !!submission.slug && !index.details[submission.slug] && normalizeMemory(index.content) === submission.content
    : submission.slug === undefined ? normalizeMemory(index.content) === submission.content
      : !!index.details[submission.slug] && detail !== null && detail.version === index.version &&
        normalizeMemory(detail.content) === submission.content;
  return { outcome: matches ? 'saved' : index.version === submission.version ? 'not-saved' : 'conflict', index, detail };
}

/** Page-owned recovery for one ambiguous memory PUT. No writes, timers or automatic retry loop.
 * Focus/connection recovery may request one new read; a lost focus invalidates its old reply. */
export class MemorySaveCheck {
  private state: CheckState = { status: 'idle' };
  private listeners = new Set<() => void>();
  private read: AbortController | null = null;
  private focused = false;
  private online = false;
  private commandId: string | null = null;

  /** Synchronous admission also guards explicit CAS rebase and navigation before React commits.
   * An ambiguous write is handled by begin; the original PUT/DELETE is never replayed. */
  async execute<T>(operationId: string, command: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null;
    this.commandId = operationId;
    try { return await command(); }
    finally { if (this.commandId === operationId) this.commandId = null; }
  }

  private readonly session: ChatSession;
  private readonly scope: MemoryScope;
  private readonly id: string;
  constructor(session: ChatSession, scope: MemoryScope, id: string) {
    this.session = session;
    this.scope = scope;
    this.id = id;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get pending() { return this.state.status !== 'idle'; }
  get busy() { return this.commandId !== null || this.pending; }
  private publish(state: CheckState) { this.state = state; this.listeners.forEach(listener => listener()); }

  begin(submission: MemorySubmission, accept: PendingCheck['accept']) {
    if (this.state.status !== 'idle') return;
    this.publish({ status: 'unknown', submission, accept });
    void this.reconcile(this.session.memoryRevisionFor(this.scope, this.id));
  }
  focus(online: boolean, revision: number) {
    this.focused = true;
    this.online = online;
    void this.reconcile(revision);
  }
  blur = () => {
    this.focused = false;
    this.read?.abort();
    this.read = null;
    if (this.state.status === 'checking') this.publish({ ...this.state, status: 'unknown' });
  };
  private async snapshot(slug: string | undefined, current: () => boolean, signal: AbortSignal) {
    const index = await this.session.api.getMemory(this.scope, this.id, signal);
    if (!current()) return null;
    const detail = slug !== undefined && index.details[slug]
      ? await this.session.api.getMemoryDetail(this.scope, this.id, slug, signal) : null;
    return current() ? { index, detail } : null;
  }
  private async reconcile(revision: number) {
    if (this.state.status !== 'unknown' || !this.focused || !this.online || this.session.connection !== 'open' ||
      this.session.memoryRevisionFor(this.scope, this.id) !== revision ||
      (this.scope === 'work' && this.session.agents.deletedIds.has(this.id))) return;
    const pending = this.state;
    const read = new AbortController();
    this.read = read;
    const connection = this.session.memoryConnectionRevision;
    this.publish({ ...pending, status: 'checking' });
    const current = () => this.read === read && this.focused && this.session.connection === 'open' &&
      this.session.memoryRevisionFor(this.scope, this.id) === revision && this.session.memoryConnectionRevision === connection &&
      (this.scope !== 'work' || !this.session.agents.deletedIds.has(this.id));
    try {
      let snapshot = await this.snapshot(pending.submission.slug, current, read.signal);
      if (!snapshot) return;
      if (snapshot.detail && snapshot.detail.version !== snapshot.index.version) {
        // A version mismatch is positive evidence of a concurrent edit, not a failed read.
        // Re-read one pair immediately; never spin while the document keeps changing.
        snapshot = await this.snapshot(pending.submission.slug, current, read.signal);
        if (!snapshot || (snapshot.detail && snapshot.detail.version !== snapshot.index.version)) return;
      }
      const result = memoryCheckResult(pending.submission, snapshot.index, snapshot.detail);
      // Publish idle only after the consumer has adopted the result, including its CAS guard.
      pending.accept(result);
      this.read = null;
      this.publish({ status: 'idle' });
    } catch { /* A failed read cannot turn an ambiguous write into a definite failure. */ }
    finally {
      if (this.read === read) {
        this.read = null;
        this.publish({ ...pending, status: 'unknown' });
      }
    }
  }
}
