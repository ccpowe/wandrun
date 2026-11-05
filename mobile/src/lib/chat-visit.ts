export type ChatRouteTarget = Readonly<{ id?: string; messageSeq?: number }>;
export type ChatVisitLease = Readonly<{ owner: ChatVisit; generation: number }>;

function sameTarget(left: ChatRouteTarget, right: ChatRouteTarget): boolean {
  return left.id === right.id && left.messageSeq === right.messageSeq;
}

/** A route's display permission, not a second copy of its conversation or draft.
 * The navigator's state event admits targets; blur alone never revokes a started result.
 */
export class ChatVisit {
  private target: ChatRouteTarget;
  private generation = 0;
  private active = true;
  private readonly listeners = new Set<() => void>();

  constructor(target: ChatRouteTarget) { this.target = target; }
  getSnapshot = (): number => this.generation;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private revoke(): void {
    this.generation++;
    for (const listener of this.listeners) listener();
  }
  /** Mount setup is repeatable under StrictMode; cleanup only revokes UI access. */
  activate(): () => void {
    this.active = true;
    return () => {
      this.active = false;
      this.revoke();
    };
  }
  /** A store replacement is a new target lifetime even when its URL happens to be unchanged. */
  invalidate(): void { this.revoke(); }
  matches(target: ChatRouteTarget): boolean { return sameTarget(this.target, target); }
  /** null means this exact native route key is no longer in the navigator. */
  admit(target: ChatRouteTarget | null): void {
    if (!target) {
      if (this.active) { this.active = false; this.revoke(); }
      return;
    }
    if (sameTarget(this.target, target)) return;
    this.target = target;
    this.revoke();
  }
  capture(): ChatVisitLease { return { owner: this, generation: this.generation }; }
  allows(lease: ChatVisitLease): boolean {
    return this.active && lease.owner === this && lease.generation === this.generation;
  }
  /** Call before this screen's setParams. Its own promotion is not a new target visit. */
  promote(lease: ChatVisitLease, id: string): boolean {
    if (!this.allows(lease) || this.target.id !== undefined && this.target.id !== id) return false;
    this.target = { ...this.target, id };
    return true;
  }
}

export type ChatWelcomeState = Readonly<{ status: 'unfocused' | 'focused'; endedAt: number | null }>;
export type ChatWelcomeEvent = Readonly<{ type: 'focus' | 'blur' | 'engage'; generation: number }>;
export const initialChatWelcome: ChatWelcomeState = { status: 'unfocused', endedAt: null };

/** A retained TextInput may already be focused when a new draft visit starts. Keyboard hide is not an event here. */
export function chatWelcomeReducer(state: ChatWelcomeState, event: ChatWelcomeEvent): ChatWelcomeState {
  switch (state.status) {
    case 'unfocused':
      if (event.type === 'focus') return { status: 'focused', endedAt: event.generation };
      if (event.type === 'engage') return { ...state, endedAt: event.generation };
      return state;
    case 'focused':
      if (event.type === 'blur') return { status: 'unfocused', endedAt: event.generation };
      if (event.type === 'engage' || event.type === 'focus') return { ...state, endedAt: event.generation };
      return state;
  }
}

export function chatWelcomeVisible(state: ChatWelcomeState, generation: number): boolean {
  return state.status === 'unfocused' && state.endedAt !== generation;
}
