import type { TextStyle } from 'react-native';

/** Rich-block design scale, independent of application chrome and utility defaults. */
export const richType = {
  // Reserved: no large-title component is exposed in the catalog.
  largeTitle: null,
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  title: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  subtle: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
  metric: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
} as const satisfies Record<string, TextStyle | null>;

export const richSpace = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const richRadius = { small: 8, medium: 12, large: 16, full: 9999 } as const;

/** Opaque, low-saturation source marks; white glyphs meet 4.5:1 on either theme. */
export const richSourceColors = ['#526477', '#5A6250', '#6B596E', '#47696B', '#765B55', '#5D617B'] as const;

/** Geometry is not spacing: accessible targets and data/renderer canvases retain their own dimensions.
 * Borders, icon/glyph dimensions, graph coordinates, percentages and calculated offsets are also
 * geometry, not additional spacing/radius levels. Zero removes space rather than adding a level.
 */
export const richGeometry = {
  touch: 44,
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
  switchHeight: 26,
} as const;
