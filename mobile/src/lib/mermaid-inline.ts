/** Inline Mermaid preview geometry (ADR-0081 §4, `screens/rich-message.md` F group). */
export const MERMAID_INLINE_MAX = 320;
/** Height reserved before any size is known (`Mermaid.waiting`). */
export const MERMAID_INLINE_WAITING = 160;
const MIN = 48;

export type MermaidNaturalSize = { width: number; height: number };

/**
 * The renderer never enlarges a diagram (scale = min(1, box / natural)), so the preview height is the
 * fitted natural height at the current width, capped at 320. `tall` marks diagrams cut down by the cap.
 */
export function mermaidInlineHeight(natural: MermaidNaturalSize | undefined, boxWidth: number): { height: number; tall: boolean } {
  if (!natural || !(natural.width > 0) || !(natural.height > 0) || !(boxWidth > 0)) return { height: MERMAID_INLINE_WAITING, tall: false };
  const fitted = natural.height * Math.min(1, boxWidth / natural.width);
  return { height: Math.max(MIN, Math.min(MERMAID_INLINE_MAX, Math.ceil(fitted))), tall: fitted > MERMAID_INLINE_MAX + 0.5 };
}
