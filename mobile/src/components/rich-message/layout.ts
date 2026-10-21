import { richSpace } from './tokens.ts';

/** Requested columns are a ceiling; measured content width and text scale own readability. */
export function readableColumns(available: number, requested: number, minimum: number, fontScale = 1) {
  const gap = richSpace.sm;
  const columns = Math.max(1, Math.min(requested, Math.floor((available + gap) / (minimum * fontScale + gap))));
  return { columns, width: Math.max(0, (available - gap * (columns - 1)) / columns) };
}

type LayoutNode = { type: string; children?: string[] };
const wideContent: Readonly<Record<string, true>> = { LineChart: true, BarChart: true, PieChart: true, Mermaid: true, Table: true, Image: true, MediaCard: true, Gallery: true, Source: true };

/** Inspect the validated spec, not opaque React children; nested media and Source summaries count too. */
export function gridMinimumWidth(elements: Readonly<Record<string, LayoutNode>>, id: string): number {
  const node = elements[id];
  return Object.hasOwn(wideContent, node.type) || node.children?.some(child => gridMinimumWidth(elements, child) === 280) ? 280 : 96;
}

/** Balance rows so four metrics on a phone form 2×2 rather than 3+1. */
export function metricColumns(available: number, count: number, fontScale = 1) {
  const capacity = readableColumns(available, count, 96, fontScale).columns;
  const rows = Math.ceil(count / capacity);
  return readableColumns(available, Math.ceil(count / rows), 96, fontScale);
}
