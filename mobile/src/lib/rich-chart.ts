/** Nearest category, clamped even when a drag leaves the plot. Empty plots have no selection. */
export function chartSelection(position: number, first: number, spacing: number, count: number): number {
  if (count === 0) return -1;
  if (count === 1 || spacing <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round((position - first) / spacing)));
}

/** A tap toggles one category; dragging uses chartSelection without clearing it. */
export function toggleChartSelection(current: number | null, next: number): number | null {
  return current === next ? null : next;
}

/** Fit grouped bars into one viewport; category slots, not individual bars, own selection. */
export function groupedBars(width: number, categories: number, series: number) {
  const slot = Math.max(0, width) / Math.max(1, categories);
  const groupWidth = slot * 0.72;
  const innerGap = series > 1 ? Math.min(3, groupWidth * 0.08) : 0;
  const barWidth = Math.max(0, Math.min(48, (groupWidth - innerGap * (series - 1)) / Math.max(1, series)));
  const actualGroup = series * barWidth + Math.max(0, series - 1) * innerGap;
  return { slot, barWidth, innerGap, groupGap: slot - actualGroup, initialSpacing: (slot - actualGroup) / 2 };
}

/** Signed projected values share one baseline in either orientation; raw magnitudes never enter SVG. */
export function barRectangle(value: number, baseline: number, scale: number, cross: number, thickness: number, horizontal: boolean) {
  const end = baseline + (horizontal ? value : -value) * scale;
  return horizontal
    ? { x: Math.min(baseline, end), y: cross, width: Math.abs(end - baseline), height: thickness }
    : { x: cross, y: Math.min(baseline, end), width: thickness, height: Math.abs(end - baseline) };
}

/** Thin category captions, never the bars; first/last stay readable inside the measured viewport. */
export function barLabelSlots(count: number, width: number, labelWidth: number, gap: number) {
  if (!count) return [];
  const left = (index: number) => Math.max(0, Math.min(width - labelWidth, (index + 0.5) * width / count - labelWidth / 2));
  const ticks = [{ index: 0, left: left(0) }];
  const lastLeft = left(count - 1);
  for (let index = 1; index < count - 1; index++) {
    const position = left(index);
    if (position >= ticks[ticks.length - 1].left + labelWidth + gap && position + labelWidth + gap <= lastLeft) {
      ticks.push({ index, left: position });
    }
  }
  if (count > 1) ticks.push({ index: count - 1, left: lastLeft });
  return ticks;
}
