import { fit, type Size } from "../takeover-lab/geometry.ts";
import type { Frame } from "./protocol.ts";

/** Canvas identity follows transport/page generations, never frame seq or local layout.
 * Local zoom/pan stays on the surrounding View; this is the untransformed image rectangle.
 */
export function framePresentation(connectionId: string, frame: Frame, container: Size) {
  const placement = fit(container, { w: frame.css[0], h: frame.css[1] });
  if (!placement) return null;
  return {
    key: JSON.stringify([connectionId, frame.page, frame.epoch, frame.vp]),
    x: placement.ox,
    y: placement.oy,
    width: frame.css[0] * placement.s0,
    height: frame.css[1] * placement.s0,
  };
}
