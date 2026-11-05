import { createResultUnknown, GatewayError } from '../gateway/api.ts';
import { userErrorMessage } from './user-error.ts';

export type NewChatSelection = { computerId: string; agentId: string };
export type StagedNewAttachment = { id: string; uri: string; name: string; mediaType: string; size: number };
export type NewChatAttempt = NewChatSelection & {
  clientId: string;
  messageClientId: string;
  kind: 'send' | 'attachments';
  text: string;
  files: StagedNewAttachment[];
  conversationId?: string;
  /** Creation is confirmed, but the original message was never submitted. */
  deferred?: true;
};
export type NewChatFailure = { attempt: NewChatAttempt; error: string; reason?: string };
/** text is the editable next draft; a submitted first message lives only in attempt/failure. */
export type NewChatSaved = { text: string; selection: NewChatSelection | null; attempt?: NewChatAttempt; failure?: NewChatFailure };
export type NewChatState = (
  | { status: 'loading'; error: string | null }
  | { status: 'editing'; saved: NewChatSaved; error: string | null }
  | { status: 'preparing'; kind: 'send' | 'attachments'; saved: NewChatSaved; operation: string; error: string | null }
  | { status: 'creating' | 'unknown' | 'awaiting'; saved: NewChatSaved & { attempt: NewChatAttempt }; operation: string; error: string | null }
) & {
  reason?: string;
  /** The message never left the device for lack of a connection: shown in the composer field, not a banner (N4 / N7). */
  offline?: boolean;
};
export type NewChatEvent =
  | { type: 'restored'; saved: NewChatSaved }
  | { type: 'restore-failed'; error: string }
  | { type: 'changed'; saved: NewChatSaved; error?: string; offline?: boolean }
  | { type: 'text'; text: string }
  | { type: 'prepare'; operation: string; kind: 'send' | 'attachments' }
  | { type: 'prepared'; operation: string; attempt: NewChatAttempt; clearDraft: boolean }
  | { type: 'created'; operation: string; id: string }
  | { type: 'deferred'; operation: string; id: string }
  | { type: 'bound'; operation: string; preserveDraft: boolean }
  | { type: 'retry' }
  | { type: 'unknown'; operation: string; error: string; reason?: string }
  | { type: 'ended'; operation: string; error?: string; reason?: string; offline?: boolean; keepText: boolean };

function endAttempt(saved: NewChatSaved, event: Extract<NewChatEvent, { type: 'ended' }>): NewChatState {
  const failure = event.keepText && !event.offline && saved.attempt
    ? { attempt: saved.attempt, error: event.error ?? '发送失败', reason: event.reason }
    : event.keepText ? saved.failure : undefined;
  const text = event.keepText
    ? event.offline && saved.attempt?.kind === 'send' ? saved.attempt.text : saved.text
    : '';
  return { status: 'editing', saved: { text, selection: saved.selection, ...(failure ? { failure } : {}) },
    error: event.error ?? null, reason: event.reason, offline: event.offline };
}

/** The only editable draft before a real id exists. Unknown attempts retain immutable request parameters. */
export function newChatReducer(state: NewChatState, event: NewChatEvent): NewChatState {
  switch (state.status) {
    case 'loading':
      if (event.type === 'restore-failed') return { ...state, error: event.error };
      if (event.type === 'restored') return event.saved.attempt
        ? { status: event.saved.attempt.deferred ? 'awaiting' : 'unknown', saved: { ...event.saved, attempt: event.saved.attempt }, operation: event.saved.attempt.clientId, error: event.saved.attempt.deferred ? event.saved.attempt.kind === 'send' ? '发送失败' : null : '操作结果未确认，可重试', offline: event.saved.attempt.deferred && event.saved.attempt.kind === 'send' }
        : { status: 'editing', saved: event.saved, error: null };
      return state;
    case 'editing':
      if (event.type === 'text') return { ...state, saved: { ...state.saved, text: event.text }, error: null, reason: undefined, offline: undefined };
      if (event.type === 'changed') return { status: 'editing', saved: event.saved, error: event.error ?? null, offline: event.offline };
      if (event.type === 'prepare') return { status: 'preparing', kind: event.kind, saved: state.saved, operation: event.operation, error: null };
      return state;
    case 'preparing':
      if (event.type === 'text') return { ...state, saved: { ...state.saved, text: event.text } };
      if (event.type === 'prepared' && event.operation === state.operation) {
        const { failure: _, ...saved } = state.saved;
        return { status: 'creating', saved: { ...saved, text: event.clearDraft ? '' : saved.text, attempt: event.attempt }, operation: state.operation, error: null };
      }
      if (event.type === 'ended' && event.operation === state.operation) return endAttempt(state.saved, event);
      return state;
    case 'unknown':
    case 'awaiting':
      if (event.type === 'text') return { ...state, saved: { ...state.saved, text: event.text } };
      if (event.type === 'retry') return { ...state, status: 'creating', error: null, reason: undefined, offline: undefined };
      if (state.status === 'awaiting' && event.type === 'bound' && event.operation === state.operation)
        return { status: 'editing', saved: { text: event.preserveDraft ? state.saved.text : '', selection: state.saved.selection }, error: null };
      // A store replacement ends this request identity, never moves it to the new database.
      if (event.type === 'ended' && event.operation === state.operation) return endAttempt(state.saved, event);
      return state;
    case 'creating':
      if (event.type === 'text') return { ...state, saved: { ...state.saved, text: event.text } };
      if (event.type === 'created' && event.operation === state.operation) return { ...state, saved: { ...state.saved, attempt: { ...state.saved.attempt, conversationId: event.id } } };
      if (event.type === 'deferred' && event.operation === state.operation) return { status: 'awaiting', saved: { ...state.saved, attempt: { ...state.saved.attempt, conversationId: event.id, deferred: true } }, operation: state.operation, error: state.saved.attempt.kind === 'send' ? '发送失败' : null, offline: state.saved.attempt.kind === 'send' };
      if (event.type === 'unknown' && event.operation === state.operation) return { ...state, status: 'unknown', error: event.error, reason: event.reason };
      if (event.type === 'bound' && event.operation === state.operation)
        return { status: 'editing', saved: { text: event.preserveDraft ? state.saved.text : '', selection: state.saved.selection }, error: null };
      if (event.type === 'ended' && event.operation === state.operation) return endAttempt(state.saved, event);
      return state;
  }
}

export type NewChatStorage = { read(): NewChatSaved | null; write(value: NewChatSaved): void };
export type NewChatHost = {
  computerId: string;
  online(): boolean;
  current(): boolean;
  storeVersion(): number;
  create(agentId: string, clientId: string): Promise<string>;
  /** Synchronous durable handoff: committing the target and releasing the global slot are one JS turn. */
  bind(id: string, attempt: NewChatAttempt, send: boolean, nextText: string): { preserveDraft: boolean; send?(): Promise<void>; release?(): void };
};
const empty: NewChatSaved = { text: '', selection: null };

/** App-wide draft, not an offline command queue. Only submit/retry sends writes; focus/reconnect never does. */
export class NewConversationStore {
  private state: NewChatState = { status: 'loading', error: null };
  private readonly listeners = new Set<() => void>();
  private readonly storage: NewChatStorage;
  constructor(storage: NewChatStorage) { this.storage = storage; }
  getSnapshot = (): NewChatState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(next: NewChatState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private dispatch(event: NewChatEvent): void { this.publish(newChatReducer(this.state, event)); }
  private save(next: NewChatState): void {
    if (next.status !== 'loading') this.storage.write(next.saved);
    this.publish(next);
  }
  restore(): void {
    if (this.state.status !== 'loading') return;
    try { this.dispatch({ type: 'restored', saved: this.storage.read() ?? empty }); }
    catch { this.dispatch({ type: 'restore-failed', error: '无法读取草稿' }); }
  }
  select(computerId: string, agentId: string): boolean {
    this.restore();
    if (this.state.status !== 'editing') return false;
    if (this.state.saved.selection?.computerId === computerId && this.state.saved.selection.agentId === agentId) return true;
    const saved = { ...this.state.saved, selection: { computerId, agentId } };
    try { this.save(newChatReducer(this.state, { type: 'changed', saved })); return true; }
    catch { this.dispatch({ type: 'changed', saved, error: '无法保存草稿，文字仍在' }); return false; }
  }
  setText(text: string): void {
    if (this.state.status === 'loading') return;
    const next = newChatReducer(this.state, { type: 'text', text });
    try { this.save(next); }
    catch { this.publish({ ...next, error: '无法保存草稿，文字仍在' }); }
  }
  /** Only an explicitly failed local first message can be discarded; unknown attempts cannot. */
  discardFailure(messageClientId: string): void {
    const state = this.state;
    if (state.status !== 'editing' || state.saved.failure?.attempt.messageClientId !== messageClientId) return;
    const { failure: _, ...saved } = state.saved;
    this.save(newChatReducer(state, { type: 'changed', saved }));
  }
  removeFailedAttachment(itemId: string): void {
    const state = this.state;
    if (state.status !== 'editing') return;
    const failure = state.saved.failure;
    if (failure?.attempt.kind !== 'attachments' || !failure.attempt.files.some(item => item.id === itemId)) return;
    const files = failure.attempt.files.filter(item => item.id !== itemId);
    if (!files.length) { this.discardFailure(failure.attempt.messageClientId); return; }
    this.save(newChatReducer(state, { type: 'changed', saved: { ...state.saved,
      failure: { ...failure, attempt: { ...failure.attempt, files } } } }));
  }
  /** Event-store replacement revokes only an attempt for that server; editable text is not replayed. */
  invalidateAttempt(computerId: string): void {
    const state = this.state;
    if ((state.status !== 'creating' && state.status !== 'unknown' && state.status !== 'awaiting') || state.saved.attempt.computerId !== computerId) return;
    const next = newChatReducer(state, { type: 'ended', operation: state.operation, keepText: true, error: '对话库已更换，草稿仍在' });
    try { this.save(next); } catch { this.publish(next); }
  }
  /** A known, unsent message may bind locally; this entry never submits it. */
  attach(host: NewChatHost): Promise<string | undefined> {
    const state = this.state;
    if (state.status !== 'awaiting' || !state.saved.attempt.conversationId) return Promise.resolve(undefined);
    return this.run(host, { create: state.saved.attempt.clientId, message: state.saved.attempt.messageClientId }, undefined, 'bind');
  }
  /** Prepare local attachment bytes before persisting a network attempt. Cancelling the picker never calls this. */
  async submit(host: NewChatHost, ids: { create: string; message: string }, stage?: () => Promise<StagedNewAttachment[]>): Promise<string | undefined> {
    return this.run(host, ids, stage, 'submit');
  }
  private async run(host: NewChatHost, ids: { create: string; message: string }, stage: (() => Promise<StagedNewAttachment[]>) | undefined, mode: 'submit' | 'bind'): Promise<string | undefined> {
    this.restore();
    const generation = host.storeVersion();
    let state = this.state;
    if (state.status === 'loading' || state.status === 'preparing' || state.status === 'creating') return;
    const fresh = state.status === 'editing';
    if (state.status === 'editing') {
      const selection = state.saved.selection;
      const failed = state.saved.failure?.attempt;
      if (!selection || selection.computerId !== host.computerId || (stage && failed) || (!stage && !failed && !state.saved.text.trim())) return;
      if (!host.online()) {
        this.dispatch({ type: 'changed', saved: state.saved, error: stage || failed?.kind === 'attachments' ? '添加附件失败' : '发送失败', offline: !stage && failed?.kind !== 'attachments' });
        return;
      }
      const text = failed?.text ?? state.saved.text;
      const kind = failed?.kind ?? (stage ? 'attachments' : 'send');
      this.dispatch({ type: 'prepare', operation: ids.create, kind });
      try {
        const files = failed?.files ?? (stage ? await stage() : []);
        const attempt: NewChatAttempt = { ...selection, clientId: ids.create, messageClientId: ids.message, kind, text, files };
        this.save(newChatReducer(this.state, { type: 'prepared', operation: ids.create, attempt, clearDraft: kind === 'send' && !failed }));
      } catch {
        this.dispatch({ type: 'ended', operation: ids.create, keepText: true, error: stage ? '添加附件失败' : '发送失败' });
        return;
      }
      state = this.state;
    } else {
      if (state.saved.attempt.computerId !== host.computerId) return;
      this.dispatch({ type: 'retry' });
      state = this.state;
    }
    if (state.status !== 'creating') return;
    const attempt = state.saved.attempt;
    const ownsAttempt = () => (this.state.status === 'creating' || this.state.status === 'awaiting') && this.state.operation === attempt.clientId;
    try {
      if (generation !== host.storeVersion()) { this.invalidateAttempt(host.computerId); return; }
      if (!host.current()) throw new GatewayError(0, 'cancelled', '连接已关闭');
      if (!attempt.deferred && !host.online()) {
        if (fresh) {
          this.save(newChatReducer(this.state, { type: 'ended', operation: attempt.clientId, keepText: true, error: stage ? '添加附件失败' : '发送失败', offline: !stage }));
          return;
        }
        throw new GatewayError(0, 'offline', '连接已断开');
      }
      const id = attempt.conversationId ?? await host.create(attempt.agentId, attempt.clientId);
      if (!ownsAttempt()) return;
      if (generation !== host.storeVersion()) {
        this.save(newChatReducer(this.state, { type: 'ended', operation: attempt.clientId, keepText: true, error: '对话库已更换，草稿仍在' }));
        return;
      }
      if (!host.current()) throw new GatewayError(0, 'cancelled', '连接已关闭');
      this.save(newChatReducer(this.state, { type: 'created', operation: attempt.clientId, id }));
      if (!ownsAttempt()) return;
      const deferred = attempt.kind === 'send' && (mode === 'bind' || !host.online());
      if (deferred && !attempt.deferred) this.save(newChatReducer(this.state, { type: 'deferred', operation: attempt.clientId, id }));
      const current = this.state;
      if ((current.status !== 'creating' && current.status !== 'awaiting') || current.operation !== attempt.clientId) return;
      const bound = host.bind(id, { ...attempt, conversationId: id, ...(deferred ? { deferred: true } : {}) }, !deferred && attempt.kind === 'send', current.saved.text);
      try {
        // A no-longer-current route cannot consume the editable next draft of a later visit.
        this.save(newChatReducer(this.state, { type: 'bound', operation: attempt.clientId, preserveDraft: bound.preserveDraft }));
        if (!deferred) await bound.send?.();
      } finally { bound.release?.(); }
      return id;
    } catch (error) {
      if (!ownsAttempt()) return;
      if (generation !== host.storeVersion()) { this.invalidateAttempt(host.computerId); return; }
      const current = this.state;
      const handedOffId = current.status === 'creating' && current.saved.attempt.conversationId;
      const unknown = !!handedOffId || createResultUnknown(error) || error instanceof GatewayError && (error.status === 408 || error.code === 'offline' || error.code === 'cancelled');
      const title = attempt.kind === 'send' ? '发送' : '添加附件';
      const message = attempt.deferred ? '发送失败' : unknown ? `${title}结果未确认，可重试` : `${title}失败`;
      const reason = userErrorMessage(error, '请稍后重试');
      const next = newChatReducer(this.state, unknown
        ? { type: 'unknown', operation: attempt.clientId, error: message, reason }
        : { type: 'ended', operation: attempt.clientId, keepText: true, error: message, reason });
      try { this.save(next); } catch { this.publish(next); }
      return;
    }
  }
}

/** Isolated scenes/tests never write the device's actual draft. */
export function memoryNewConversation(): NewConversationStore {
  let saved: NewChatSaved | null = null;
  return new NewConversationStore({ read: () => saved, write: value => { saved = value; } });
}
