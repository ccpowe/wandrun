export const THUMBNAIL_REFRESH_MS = 15_000;

export type ThumbnailRequest = { source: string; uri: string; requestedAt: number };

/** Null source ends a visible visit. Each new visit/page loads immediately; only live cards
 * refresh (including retrying failures) at the low-frequency boundary, never on each render. */
export function nextThumbnailRequest(
  current: ThumbnailRequest | null, source: string | null, now: number, refresh: boolean,
): ThumbnailRequest | null {
  if (source === null) return null;
  if (current?.source === source && (!refresh || now - current.requestedAt < THUMBNAIL_REFRESH_MS)) return current;
  return { source, uri: `${source}${source.includes("?") ? "&" : "?"}at=${now}`, requestedAt: now };
}
