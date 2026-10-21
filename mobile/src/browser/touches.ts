import type { TouchEvent } from "../takeover-lab/gestures.ts";

type NativeTouch = { id: number; x: number; y: number };

/** RNGH already limits each sibling handler to its own pointers. Its UP payload still
 * includes lifted pointers in allTouches; the recognizers require the post-event set.
 * All regions use the same monotonic JS clock: RNGH touch payloads have no timestamp.
 */
export function gestureTouches(type: TouchEvent["type"], native: {
  allTouches: readonly NativeTouch[]; changedTouches: readonly NativeTouch[];
}, t: number): TouchEvent {
  const remaining = type === "cancel" ? [] : type === "end"
    ? native.allTouches.filter((touch) => !native.changedTouches.some((changed) => changed.id === touch.id))
    : native.allTouches;
  return { type, t, touches: remaining.map(({ id, x, y }) => ({ id: String(id), x, y })) };
}
