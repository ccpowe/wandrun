import type { GatewayApi } from '../gateway/api.ts';
import { nextThumbnailRequest, THUMBNAIL_REFRESH_MS, type ThumbnailRequest } from './browser-thumbnail.ts';
import { loadLocalImage, type LocalImageLease } from '@/lib/local-image.ts';

export type BrowserThumbnailSnapshot = { status: 'loading' | 'ready' | 'displayed' | 'failed'; uri: string | null };
/** Native image leases are not JSON/Query data. One visible session/source owns bytes,
 * the low-frequency clock and late-result disposal, never a command or business draft. */
export class BrowserThumbnailResource {
  private snapshot: BrowserThumbnailSnapshot = { status: 'loading', uri: null };
  private listeners = new Set<() => void>();
  private api: GatewayApi;
  private source: string;
  private refresh: boolean;
  constructor(api: GatewayApi, source: string, refresh: boolean) {
    this.api = api; this.source = source; this.refresh = refresh;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private update(snapshot: BrowserThumbnailSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  displayed = (uri: string) => { if (this.snapshot.uri === uri) this.update({ status: 'displayed', uri }); };
  failed = (uri: string) => { if (this.snapshot.uri === uri) this.update({ status: 'failed', uri: null }); };
  attach = () => {
    let current: AbortController | null = null;
    let lease: LocalImageLease | null = null;
    let request: ThumbnailRequest | null = null;
    let attached = true;
    const read = () => {
      const next = nextThumbnailRequest(request, this.source, Date.now(), this.refresh);
      if (!next || next === request) return;
      request = next;
      current?.abort(); lease?.dispose(); lease = null;
      const controller = current = new AbortController();
      this.update({ status: 'loading', uri: null });
      void loadLocalImage(this.api, next.uri, controller.signal).then(result => {
        if (!attached || controller !== current || controller.signal.aborted || this.api.signal.aborted) { result.dispose(); return; }
        lease = result; this.update({ status: 'ready', uri: result.uri });
      }, () => { if (attached && controller === current && !controller.signal.aborted && !this.api.signal.aborted) this.update({ status: 'failed', uri: null }); });
    };
    read();
    const interval = this.refresh ? setInterval(read, THUMBNAIL_REFRESH_MS) : undefined;
    return () => { attached = false; current?.abort(); lease?.dispose(); lease = null; clearInterval(interval); };
  };
}
