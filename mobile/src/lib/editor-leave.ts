import type { NavigationAction } from 'expo-router/react-navigation';

export type LeaveTarget = { kind: 'navigation'; action: NavigationAction } | { kind: 'local'; run: () => void };
export type LeaveMode = 'ordinary' | 'unknown' | 'save' | 'confirm-save' | 'continue';
export type EditorLeaveState =
  | { status: 'inactive' | 'idle' | 'consumed' }
  | { status: 'requesting'; mode: LeaveMode }
  | { status: 'confirming'; target: LeaveTarget; reason: 'ordinary' | 'unknown' | 'environment' }
  | { status: 'saving'; target: LeaveTarget; operation: number };
export type EditorLeaveEvent =
  | { type: 'enter' | 'exit' | 'cancel' | 'consumed' }
  | { type: 'arm'; mode: LeaveMode }
  | { type: 'intercept'; target: LeaveTarget; mode: LeaveMode; operation: number }
  | { type: 'saved'; operation: number; success: boolean };

/** Only navigation intent lives here; dirty/busy/outcomes stay with their original owners. */
export function editorLeaveReducer(state: EditorLeaveState, event: EditorLeaveEvent): EditorLeaveState {
  switch (state.status) {
    case 'inactive':
      return event.type === 'enter' ? { status: 'idle' } : state;
    case 'consumed':
      if (event.type === 'enter') return { status: 'idle' };
      if (event.type === 'exit') return { status: 'inactive' };
      return state;
    case 'idle':
    case 'requesting':
    case 'confirming':
      if (event.type === 'exit') return { status: 'inactive' };
      if (event.type === 'cancel') return { status: 'idle' };
      if (event.type === 'arm') return { status: 'requesting', mode: event.mode };
      if (event.type === 'consumed') return { status: 'consumed' };
      if (event.type !== 'intercept') return state;
      if (event.mode === 'save') return { status: 'saving', operation: event.operation, target: event.target };
      return { status: 'confirming', target: event.target, reason: event.mode === 'confirm-save' ? 'environment' : event.mode === 'unknown' ? 'unknown' : 'ordinary' };
    case 'saving':
      if (event.type === 'exit') return { status: 'inactive' };
      // A later navigation replaces the destination, not the in-flight write.
      if (event.type === 'intercept') return { ...state, target: event.target };
      if (event.type === 'saved' && event.operation === state.operation) return event.success ? { status: 'consumed' } : { status: 'idle' };
      return state;
  }
}

/** Synchronous command admission prevents same-frame double saves; React subscribes, never mirrors it. */
export class EditorLeaveOwner {
  private state: EditorLeaveState = { status: 'inactive' };
  private operation = 0;
  private listeners = new Set<() => void>();
  private readonly dispatch: (action: NavigationAction) => void;
  constructor(dispatch: (action: NavigationAction) => void) { this.dispatch = dispatch; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private send(event: EditorLeaveEvent) {
    const next = editorLeaveReducer(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  enter = () => { this.send({ type: 'enter' }); };
  exit = () => { this.send({ type: 'exit' }); };
  cancel = () => { this.send({ type: 'cancel' }); };
  arm(mode: LeaveMode) { this.send({ type: 'arm', mode }); }
  private execute(target: LeaveTarget) {
    if (target.kind === 'navigation') this.dispatch(target.action);
    else { target.run(); this.enter(); }
  }
  confirm = () => {
    if (this.state.status !== 'confirming') return false;
    const target = this.state.target;
    this.send({ type: 'consumed' });
    this.execute(target);
    return true;
  };
  async confirmSave(save?: () => Promise<boolean>): Promise<void> {
    if (this.state.status !== 'confirming' || this.state.reason !== 'environment') return;
    await this.intercept(this.state.target, 'save', save);
  }
  async intercept(target: LeaveTarget, mode: LeaveMode, save?: () => Promise<boolean>): Promise<void> {
    if (this.state.status === 'inactive' || this.state.status === 'consumed') return;
    if (this.state.status === 'requesting') mode = this.state.mode;
    const operation = ++this.operation;
    const alreadySaving = this.state.status === 'saving';
    this.send({ type: 'intercept', target, mode, operation });
    if (alreadySaving) return;
    if (mode === 'continue') { this.confirm(); return; }
    if (mode !== 'save') return;
    let success = false;
    try { success = !!save && await save(); }
    catch { success = false; }
    finally {
      const current = this.state;
      if (current.status === 'saving' && current.operation === operation) {
        this.send({ type: 'saved', operation, success });
        if (success) this.execute(current.target);
      }
    }
  }
}
