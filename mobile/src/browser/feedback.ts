import { pointerForViewport, toRemote, toScreen, type Point, type Size, type View } from "../takeover-lab/geometry.ts";

/** Local acknowledgement, not remote success: touch marks the contact; mouse marks the
 * CSS pointer. Ignore letterboxing and missing geometry; never send or alter input here.
 */
export function feedbackPoint(mode: "mouse" | "touch", contact: Point, pointer: Point | null,
  container: Size, css: Size, view: View): Point | null {
  if (mode === "mouse") return toScreen(pointerForViewport(pointer, css.w, css.h), container, css, view);
  return toRemote(contact, container, css, view) ? contact : null;
}
