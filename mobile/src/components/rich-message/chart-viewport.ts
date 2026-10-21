import { richSpace, richType } from './tokens.ts';

const Y_AXIS_LABEL_WIDTH = 48;
const Y_AXIS_THICKNESS = 1;
export const LINE_POINT_RADIUS = 2;

/** Reserve the Y-axis labels without letting large scaled text erase a phone's plot. */
export function chartViewportProps(containerWidth: number, kind: 'line' | 'bar', yAxisLabelWidth = Y_AXIS_LABEL_WIDTH) {
  // gifted-charts positions its ScrollView after the Y-axis and adds point radius to line viewport width.
  const pointOverhang = kind === 'line' ? LINE_POINT_RADIUS : 0;
  const reservedPlot = Math.min(160, containerWidth / 2);
  const labelWidth = Math.min(yAxisLabelWidth,
    Math.max(Y_AXIS_LABEL_WIDTH, containerWidth - reservedPlot - Y_AXIS_THICKNESS - pointOverhang));
  return {
    width: Math.max(0, containerWidth - labelWidth - Y_AXIS_THICKNESS - pointOverhang),
    yAxisLabelWidth: labelWidth,
  };
}

/** Approximate the rendered width of compact tick text; exact values belong in details. */
export function chartYAxisLabelWidth(labels: readonly string[], fontScale: number) {
  return Math.max(Y_AXIS_LABEL_WIDTH,
    Math.max(...labels.map((label) => label.length)) * richType.subtle.fontSize * 0.6 * fontScale + richSpace.sm);
}

const EDGE_SPACING = richSpace.md;

/**
 * Fit every point without scrolling; thin only axis labels. Native label slots
 * stay within the viewport, including the first/last label, and can wrap.
 */
export function lineLayout(plotWidth: number, labels: readonly string[], fontScale = 1) {
  const textWidth = Math.max(...labels.map((label) => Array.from(label).length * richType.subtle.fontSize)) * fontScale;
  const labelWidth = Math.max(0, Math.min(Math.max(32 * fontScale, textWidth), 100 * fontScale, (plotWidth - richSpace.sm) / 2));
  const initialSpacing = labelWidth / 2 + LINE_POINT_RADIUS;
  const endSpacing = initialSpacing + LINE_POINT_RADIUS * 2;
  const spacing = Math.max(0, (plotWidth - initialSpacing - endSpacing) / (labels.length - 1));
  const stride = Math.max(1, Math.ceil((labels.length - 1) / 5), Math.ceil((labelWidth + richSpace.sm) / Math.max(1, spacing)));
  const ticks = labels.flatMap((label, index) =>
    index === 0 || index === labels.length - 1 || (index % stride === 0 && (labels.length - 1 - index) * spacing >= labelWidth + richSpace.sm)
      ? [{ label, index, left: initialSpacing + index * spacing - labelWidth / 2 }]
      : []);
  return { initialSpacing, endSpacing, spacing, labelWidth, ticks };
}

/** Give each bar an equal slot of the plot: half bar, half gap, within readable bounds. */
export function barLayout(plotWidth: number, bars: number) {
  const slot = (plotWidth - 2 * EDGE_SPACING) / Math.max(1, bars);
  const barWidth = Math.min(48, Math.max(richSpace.lg, slot * 0.5));
  return { barWidth, spacing: Math.max(richSpace.md, slot - barWidth) };
}
