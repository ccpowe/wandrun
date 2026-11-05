import type { TouchEvent } from "../takeover-lab/gestures.ts";

type NativeTouch = { id: number; x: number; y: number };
export type GestureTouchSnapshot = Omit<TouchEvent, "t">;

/** Snapshot on UI before crossing runtimes; never retain a native event or its points.
 * RNGH limits each sibling handler to its own pointers. UP still includes lifted
 * pointers in allTouches; the recognizers require the post-event set.
 */
export function gestureTouches(type: TouchEvent["type"], native: {
  allTouches?: readonly NativeTouch[] | null; changedTouches?: readonly NativeTouch[] | null;
}): GestureTouchSnapshot {
  "worklet";
  if (type === "cancel") return { type, touches: [] };
  const { allTouches, changedTouches } = native;
  if (allTouches == null || type === "end" && changedTouches == null) {
    console.warn(`[browser] gesture-payload-missing: ${type}; allTouches=${allTouches != null}; changedTouches=${changedTouches != null}`);
    // Unknown survivors must release held input, not leave it stuck or invent a click.
    return { type: "cancel", touches: [] };
  }
  const touches: TouchEvent["touches"] = [];
  for (const { id, x, y } of allTouches) {
    if (type === "end" && changedTouches!.some((changed) => changed.id === id)) continue;
    touches.push({ id: String(id), x, y });
  }
  return { type, touches };
}
