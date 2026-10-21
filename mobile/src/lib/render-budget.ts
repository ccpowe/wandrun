/** Global across messages and surfaces, not a per-message allowance. */
export const MAX_ACTIVE_RENDERERS = 4;

/** Eligible blocks wait FIFO. Cancel only after the renderer has been removed from
 * the committed tree: a retiring frame still owns its permit until then. */
export class RenderBudget {
  private active = new Set<() => void>();
  private waiting = new Set<() => void>();

  request(granted: () => void): () => void {
    this.waiting.add(granted);
    this.drain();
    return () => {
      this.waiting.delete(granted);
      this.active.delete(granted);
      this.drain();
    };
  }

  private drain() {
    for (const granted of this.waiting) {
      if (this.active.size >= MAX_ACTIVE_RENDERERS) break;
      this.waiting.delete(granted);
      this.active.add(granted);
      granted();
    }
  }
}

export const renderBudget = new RenderBudget();

/** Offscreen prefetch must not hold the limited slots needed by visible blocks. */
export function intersectsRenderViewport(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number): boolean {
  return [x, y, width, height, viewportWidth, viewportHeight].every(Number.isFinite) &&
    width > 0 && height > 0 && viewportWidth > 0 && viewportHeight > 0 &&
    x + width > 0 && x < viewportWidth && y + height > 0 && y < viewportHeight;
}
