// chat.C9 / T36–T40: the local send "pin" intent. One accepted local send pins that user message below
// the header; the page reducer owns only this intent. Geometry (anchored space, scroll, keyboard padding)
// stays in LegendList and keyboard-controller, and no phase is derived from `working` or any measured value.
// The one thing derived from `working` is `idle` (chat.C9b): a `turn-ended` event (working went true -> false) while an
// anchor exists keeps the working row as an invisible placeholder; it never changes the phase.
// See docs/research/chat-scroll-pin-top-plan-2026-11-04.md §4–§7.

/**
 * ordinary: no local send in this ChatHistory (initial open, old replies): end-follow and keyboard lift as before.
 * closing:  a send was accepted; the keyboard is being dismissed. End-follow is held, keyboard is NOT frozen,
 *           so the library can clear the keyboard padding.
 * pinned:   the dismiss completed; content stays put while the keyboard moves only the composer.
 * user:     the user took over (drag, return to end, UI submission); ordinary policy again. The anchored
 *           space of the last send stays configured until the next send or the view is destroyed.
 */
export type ChatPin =
  | Readonly<{ phase: "ordinary" }>
  /** `idle`: the turn ended while the anchor (end space) exists, so the "working" row stays as a blank of the same height
   * (chat.C9b); it lives as long as the anchor: cleared by the next send, kept through every other event. */
  | Readonly<{ phase: "closing" | "pinned" | "user"; request: string; idle?: true }>;

export type ChatPinEvent =
  /** A locally accepted send; `clientId` is the one the user row (`p${clientId}`) is keyed by. */
  | Readonly<{ type: "send"; clientId: string }>
  /** The public KeyboardController.dismiss() promise for that same send resolved. */
  | Readonly<{ type: "keyboard-closed"; clientId: string }>
  /** Drag, return to latest, or an in-message UI submission. */
  | Readonly<{ type: "user-navigation" }>
  /** `turn.working` went from true to false (completed, stopped or failed). Ignored without an anchor. */
  | Readonly<{ type: "turn-ended" }>;

export const initialChatPin: ChatPin = { phase: "ordinary" };

export function chatPinReducer(state: ChatPin, event: ChatPinEvent): ChatPin {
  // State first, then event; an event a phase does not accept returns the same state.
  // A send replaces everything (including `idle`); every other accepted event keeps `idle`.
  if (state.phase === "ordinary") return event.type === "send" ? { phase: "closing", request: event.clientId } : state;
  if (event.type === "send") return { phase: "closing", request: event.clientId };
  if (event.type === "turn-ended") return state.idle ? state : { ...state, idle: true };
  switch (state.phase) {
    case "closing":
      // A late dismiss never re-enters isolation after a newer send or after the user took over.
      if (event.type === "keyboard-closed") return event.clientId === state.request ? { ...state, phase: "pinned" } : state;
      if (event.type === "user-navigation") return { ...state, phase: "user" };
      return state;
    case "pinned":
      return event.type === "user-navigation" ? { ...state, phase: "user" } : state;
    case "user":
      return state;
  }
}

/** Row key of the pinned user message, or null before any local send. */
export function chatPinAnchorKey(state: ChatPin): string | null {
  return state.phase === "ordinary" ? null : `p${state.request}`;
}
/** End-follow is held while the pinned view is kept. */
export function chatPinHolds(state: ChatPin): boolean {
  return state.phase === "closing" || state.phase === "pinned";
}
/** Keyboard-controller `freeze`: only after the dismiss completed, never while closing. */
export function chatPinFrozen(state: ChatPin): boolean {
  return state.phase === "pinned";
}
/** The turn ended while the anchor exists: show the blank placeholder instead of removing the "working" row. */
export function chatPinKeepsIdleRow(state: ChatPin): boolean {
  return state.phase !== "ordinary" && state.idle === true;
}
