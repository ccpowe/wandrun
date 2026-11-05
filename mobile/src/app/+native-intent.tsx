/** SDK 57 NativeIntent accepts null to suppress Router navigation. The original
 * Linking event still reaches openAuthSessionAsync's Android listener unchanged. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    const url = new URL(path);
    if (url.protocol !== 'wandrun:' || url.hostname !== 'oauth' || url.pathname !== '/done') return path;
    if (!initial) return null;
    // A cold launch has no page-local auth session to resume. Load real gateway
    // state; result=ok/error is deliberately not treated as authorization proof.
    const id = url.searchParams.get('connector');
    return id ? `/connectors/${encodeURIComponent(id)}` : '/settings-connectors';
  } catch {
    return path;
  }
}
