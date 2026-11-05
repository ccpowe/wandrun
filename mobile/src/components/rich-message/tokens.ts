import type { TextStyle } from 'react-native';

/** Rich-block type scale (ADR-0081): body matches chat Markdown (16/26), block titles use the Markdown h4
 * step and Heading the h3 step; secondary text, form labels and chart axes use the foundation caption. */
export const richType = {
  // Reserved: no large-title component is exposed in the catalog.
  largeTitle: null,
  heading: { fontSize: 19, lineHeight: 28, fontWeight: '600' },
  title: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 26, fontWeight: '400' },
  subtle: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  metric: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
} as const satisfies Record<string, TextStyle | null>;

export const richSpace = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
/** Foundation radii (global.css radius-sm / md / lg). */
export const richRadius = { small: 8, medium: 14, large: 20, full: 9999 } as const;

/** Theme-owned source data colors, separate from chart and status semantics. */
export const richSourceColors = ['--color-source-1', '--color-source-2', '--color-source-3', '--color-source-4', '--color-source-5', '--color-source-6'] as const;

/** Geometry is not spacing: accessible targets and data/renderer canvases retain their own dimensions.
 * Borders, icon/glyph dimensions, graph coordinates, percentages and calculated offsets are also
 * geometry, not additional spacing/radius levels. Zero removes space rather than adding a level.
 */
export const richGeometry = {
  touch: 48,
  chartHeight: 145,
  chartBarRadius: 3, // Small data marks, not UI containers.
  imageHeight: 180,
  galleryHeight: 200,
  horizontalImageHeight: 156,
  progressHeight: 6,
  radioSize: 18,
  sourceMarkSize: 22,
  sourceMarkOverlap: 6, // Circular marks overlap; this is not a spacing-scale gap.
  sourceMarkBorder: 2, // The muted outline separates overlapping marks, not a container border.
  sourceCardWidth: 148, // Fixed-width rail cards expose overflow rather than squeezing source titles.
  sourceCardMarkSize: 14, // Decorative domain mark; body typography still uses the shared caption scale.
  linkMarkSize: 40, // LinkCard site mark / thumbnail (ADR-0081 confirmation 6).
  switchHeight: 26,
} as const;
