// chat.C6 / C7 / T2 / T3 / T4: a route may ask the chat to show one message (search, member preview).
// The page reducer owns only the reading intent; history paging and "exhausted" are owned by
// ChatTargetSeek over the session's timeline. List geometry (placement, at-end) stays in LegendList.
import type { ChatSession } from "../gateway/session.ts";
import { projectChatRows, isMessageTarget } from "./chat-timeline.ts";

/** The page's own definition of "the target is a visible row" (hidden or merged events are not). */
export function timelineHasTarget(session: ChatSession, id: string, seq: number): boolean {
  const timeline = session.timelines.get(id);
  if (!timeline) return false;
  return projectChatRows({ timelineId: id, events: timeline.events, pending: session.pendingFor(id),
    browserTasks: session.browserTasks, drafts: session.draftsFor(id), draftOrder: session.drafts.order, tasks: session.tasks }).rows
    .some((item) => isMessageTarget(item, seq));
}

export type ChatTargetState =
  /** No target: the list follows the latest messages by its own at-end state. */
  | Readonly<{ status: "latest" }>
  /** Waiting for the target row (paging older history) before the first placement. */
  | Readonly<{ status: "seeking"; seq: number; highlight: boolean }>
  /** The list was placed at the target. `reading` holds READ until released once. */
  | Readonly<{ status: "placed"; seq: number; placement: number; highlight: boolean; reading: boolean }>;

export type ChatTargetEvent =
  /** LegendList onReady with the target row present (initial placement at that row). */
  | Readonly<{ type: "placed"; placement: number }>
  /** Drag, local send / UI submission accepted, return to latest, or dismissing "not found". */
  | Readonly<{ type: "cancel" }>
  /** Touch on a non-draft row clears only the highlight. */
  | Readonly<{ type: "touched" }>
  | Readonly<{ type: "highlight-expired"; placement: number }>
  /** The last-row target actually reached the bottom after placement. */
  | Readonly<{ type: "reached-end" }>;

export function initialChatTarget(messageSeq: number | undefined): ChatTargetState {
  return messageSeq !== undefined && Number.isFinite(messageSeq) ? { status: "seeking", seq: messageSeq, highlight: true } : { status: "latest" };
}

export function chatTargetReducer(state: ChatTargetState, event: ChatTargetEvent): ChatTargetState {
  switch (state.status) {
    case "latest":
      return state;
    case "seeking":
      if (event.type === "cancel") return { status: "latest" };
      if (event.type === "touched") return state.highlight ? { ...state, highlight: false } : state;
      if (event.type === "placed") return { status: "placed", seq: state.seq, placement: event.placement, highlight: state.highlight, reading: true };
      return state;
    case "placed":
      if (event.type === "cancel") return { status: "latest" };
      if (event.type === "touched") return state.highlight ? { ...state, highlight: false } : state;
      if (event.type === "highlight-expired") return event.placement === state.placement && state.highlight ? { ...state, highlight: false } : state;
      // Latched: later growth never reinstates target READ.
      if (event.type === "reached-end") return state.reading ? { ...state, reading: false } : state;
      return state;
  }
}

export type ChatTargetFacts = Readonly<{
  /** ChatTargetSeek concluded that complete history has no such message. */
  missing: boolean;
  /** The current history read failed (the session retries in the background). */
  historyFailed: boolean;
  targetIndex: number;
  itemCount: number;
}>;

/** What the page renders from the intent plus external facts. */
export function selectChatTarget(state: ChatTargetState, facts: ChatTargetFacts) {
  const seeking = state.status === "seeking" && !facts.missing;
  const found = facts.targetIndex >= 0;
  return {
    /** Still looking for the target: initial placement waits for it (or shows history on failure). */
    seeking,
    failed: seeking && facts.historyFailed,
    missing: state.status === "seeking" && facts.missing,
    reading: seeking || (state.status === "placed" && state.reading),
    highlighted: (seeking || state.status === "placed") && state.highlight,
    /** Highlight lifetime starts at placement, not while seeking. */
    placement: state.status === "placed" && state.highlight && found ? state.placement : null,
    /** The read permission is released when the last-row target is at the bottom. */
    targetIsLast: found && facts.targetIndex === facts.itemCount - 1,
  };
}

/** Pages older history until the target appears or history is complete. One owner per
 * (session, conversation, seq); a focus visit activates it. "Missing" is latched: a later
 * resync must not re-enter seeking and remount the list. Leaving only stops paging. */
export class ChatTargetSeek {
  private missing = false;
  private attemptedOldest: number | null | undefined = undefined;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private readonly session: ChatSession;
  private readonly id: string;
  private readonly seq: number;

  constructor(session: ChatSession, id: string, seq: number) {
    this.session = session;
    this.id = id;
    this.seq = seq;
  }
  getSnapshot = (): boolean => this.missing;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  activate(): () => void {
    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe(() => this.step());
    this.step();
    return () => { this.unsubscribe?.(); this.unsubscribe = null; };
  }

  private step(): void {
    if (this.missing) return;
    const conversation = this.session.chat(this.id);
    const timeline = this.session.timelines.get(this.id);
    // Deletion clears history before navigation finishes; that is not search exhaustion.
    if (!conversation || this.session.agents.deletedIds.has(conversation.agent_id) || !timeline?.loaded) return;
    // Same definition as the page's targetIndex: an event that does not render as a row is not
    // "found" (otherwise the page would wait for a row that never comes).
    if (timelineHasTarget(this.session, this.id, this.seq)) return;
    if (timeline.complete && !timeline.loading) {
      this.missing = true;
      for (const listener of this.listeners) listener();
      return;
    }
    // One request per cursor; failures recover through the page's history retry, not here.
    if (timeline.historyError === undefined && !timeline.complete && !timeline.loading && this.attemptedOldest !== timeline.oldest) {
      this.attemptedOldest = timeline.oldest;
      void this.session.loadOlder(this.id);
    }
  }
}
