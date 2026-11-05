import { richSpace } from './tokens.ts';
import type { RichChildWidth } from './spec.ts';

/** Fractions share the row's gutters: two halves or one/two thirds sum to one complete row. */
export function fractionWidth(available: number, gap: number, width: Exclude<RichChildWidth, 'auto'>): number {
  const fraction = width === '1/2' ? 1 / 2 : width === '1/3' ? 1 / 3 : 2 / 3;
  return Math.max(0, (available + gap) * fraction - gap);
}

/** Grid readability wins over a model's fraction; auto follows the responsive default column. */
export function gridChildWidth(available: number, columns: number, minimum: number, fontScale: number, width?: RichChildWidth): number {
  const standard = readableColumns(available, columns, minimum, fontScale).width;
  return width && width !== 'auto'
    ? Math.min(available, Math.max(Math.min(available, minimum * fontScale), fractionWidth(available, richSpace.sm, width)))
    : standard;
}

/** Reserve the next card's glimpse plus its preceding gutter; gap=lg must not consume the entire hint. */
export function scrollChildWidth(available: number, gap: number, width?: RichChildWidth): number {
  return width && width !== 'auto'
    ? fractionWidth(Math.max(0, available - richSpace.lg - gap), gap, width)
    : available * 0.8;
}

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
