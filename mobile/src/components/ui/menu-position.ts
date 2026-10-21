type Rectangle = { x: number; y: number; width: number; height: number };
type Insets = { top?: number; right?: number; bottom?: number; left?: number };

type MenuPlacement = {
  trigger: Rectangle;
  content: { width: number; height: number };
  /** Portal overlay's measured bounds, in the same page coordinates as the trigger. */
  viewport: Rectangle;
  insets: Insets;
  keyboardHeight?: number; // KeyboardController height includes the bottom system inset.
  side: 'top' | 'bottom';
  align: 'start' | 'center' | 'end';
  sideOffset: number;
  alignOffset: number;
  avoidCollisions: boolean;
};

/** Places a native portal menu within its actual visible overlay, flipping when the opposite side fits. */
export function placeMenu({ trigger, content, viewport, insets, keyboardHeight = 0, side, align, sideOffset, alignOffset, avoidCollisions }: MenuPlacement) {
  const topEdge = insets.top ?? 0;
  // The keyboard replaces, rather than adds to, the closed-state bottom safe area.
  const bottomEdge = Math.max(topEdge, viewport.height - (keyboardHeight > 0 ? keyboardHeight : insets.bottom ?? 0));
  const leftEdge = insets.left ?? 0;
  const rightEdge = Math.max(leftEdge, viewport.width - (insets.right ?? 0));
  const triggerTop = trigger.y - viewport.y;
  const triggerLeft = trigger.x - viewport.x;
  const above = triggerTop - sideOffset - content.height;
  const below = triggerTop + trigger.height + sideOffset;
  const topFits = above >= topEdge;
  const bottomFits = below + content.height <= bottomEdge;
  const spaceAbove = triggerTop - sideOffset - topEdge;
  const spaceBelow = bottomEdge - below;
  const useTop = avoidCollisions && side === 'bottom'
    ? !bottomFits && (topFits || spaceAbove > spaceBelow)
    : avoidCollisions && side === 'top'
      ? topFits || (!bottomFits && spaceAbove >= spaceBelow)
      : side === 'top';
  const desiredTop = useTop ? above : below;
  const visibleHeight = bottomEdge - topEdge;
  const height = Math.min(content.height, visibleHeight);
  const top = avoidCollisions
    ? Math.max(topEdge, Math.min(desiredTop, bottomEdge - height))
    : desiredTop;
  const maxWidth = rightEdge - leftEdge;
  const width = Math.min(content.width, maxWidth);
  const desiredLeft = align === 'end' ? triggerLeft + trigger.width - width
    : align === 'center' ? triggerLeft + (trigger.width - width) / 2
      : triggerLeft;
  const left = avoidCollisions
    ? Math.max(leftEdge, Math.min(desiredLeft + alignOffset, rightEdge - width))
    : desiredLeft + alignOffset;
  return { position: 'absolute' as const, top, left, maxWidth, maxHeight: visibleHeight };
}
