import { File } from 'expo-file-system';
import { requireNativeModule } from 'expo';
import * as tus from 'tus-js-client';
import type { Fetch } from '../gateway/api.ts';
import { unhandled } from './fake-gateway/strict.ts';

export type GatewayHost = { baseUrls: readonly string[]; fetch: Fetch };
type NativeDownload = {
  start(...args: Parameters<typeof File.createDownloadTask>): Promise<string | null>;
  cancel(): void;
  pause(): unknown;
  resume(): Promise<string | null>;
};
let installed = false;

/** One mounted test/story owns the native transports. No request falls through to the network.
 * SDK 57's native task boundary is intentional: keep its real DownloadTask state/cancellation
 * and File I/O, replacing only start/cancel. Recheck this boundary on Expo upgrades.
 */
export function installFakeGatewayHost(host: GatewayHost): () => void {
  if (installed) throw new Error('假网关宿主尚未释放，不能覆盖另一个场景');
  const origins = new Set(host.baseUrls.map(base => new URL(base).origin));
  const controllers = new Set<AbortController>();
  const downloads = new WeakMap<object, AbortController>();
  const prototype = requireNativeModule<{ FileSystemDownloadTask: { prototype: NativeDownload } }>('FileSystem').FileSystemDownloadTask.prototype;
  const previous = { fetch: globalThis.fetch, start: prototype.start, cancel: prototype.cancel, pause: prototype.pause, resume: prototype.resume, createRequest: tus.defaultOptions.httpStack.createRequest };
  let disposed = false;

  async function request<T>(url: string, init: RequestInit, controller: AbortController, consume: (response: Response) => Promise<T>): Promise<T> {
    if (disposed || controller.signal.aborted) throw aborted();
    const target = new URL(url);
    if (!origins.has(target.origin)) return unhandled(init.method ?? 'GET', target.pathname, '没有注册此电脑的假网关宿主');
    controllers.add(controller);
    const interrupted = Promise.withResolvers<never>();
    const onAbort = () => interrupted.reject(aborted());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([host.fetch(url, { ...init, signal: controller.signal }).then(consume), interrupted.promise]);
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  }

  // Pairing is public HTTP before a session exists; keep it at the same strict peer boundary.
  globalThis.fetch = (input, init) => {
    if (typeof input === 'string' && input.endsWith('/pairing/exchange')) {
      const target = new URL(input);
      if (!origins.has(target.origin)) return unhandled(init?.method ?? 'GET', target.pathname, '没有注册此服务器的假网关宿主');
      return host.fetch(input, init);
    }
    return previous.fetch(input, init);
  };

  tus.defaultOptions.httpStack.createRequest = (method, url) => {
    const headers = new Headers();
    const controller = new AbortController();
    let progress: ((sent: number) => void) | undefined;
    return {
      getMethod: () => method, getURL: () => url,
      setHeader: (key, value) => { headers.set(key, value); }, getHeader: key => headers.get(key) ?? undefined,
      setProgressHandler: handler => { progress = handler; },
      async send(body) {
        return request(url, { method, headers, body }, controller, async response => {
          const text = await response.text();
          if (disposed || controller.signal.aborted) throw aborted();
          if (body instanceof Uint8Array) progress?.(body.byteLength);
          return { getStatus: () => response.status, getHeader: (key: string) => response.headers.get(key) ?? undefined, getBody: () => text, getUnderlyingObject: () => response };
        });
      },
      abort: async () => { controller.abort(); }, getUnderlyingObject: () => controller,
    };
  };

  prototype.start = async function (url, destination, options) {
    if (!(destination instanceof File)) return unhandled('GET', new URL(url).pathname, '假网关下载要求显式 File 目的地');
    const controller = new AbortController();
    downloads.set(this, controller);
    try {
      return await request(url, { method: 'GET', headers: options?.headers }, controller, async response => {
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (disposed || controller.signal.aborted) throw aborted();
        destination.write(bytes);
        return destination.uri;
      });
    } finally {
      downloads.delete(this);
    }
  };
  prototype.cancel = function () { downloads.get(this)?.abort(); };
  // The App never pauses/resumes downloads. A newly added use must extend this boundary,
  // not inherit the SDK mock's empty-success response or make a real native request.
  prototype.pause = () => unhandled('NATIVE', 'download.pause', '当前假网关不模拟下载暂停');
  prototype.resume = () => unhandled('NATIVE', 'download.resume', '当前假网关不模拟下载续传');
  installed = true;

  return () => {
    if (disposed) return;
    disposed = true;
    for (const controller of controllers) controller.abort();
    prototype.start = previous.start; prototype.cancel = previous.cancel;
    prototype.pause = previous.pause; prototype.resume = previous.resume;
    tus.defaultOptions.httpStack.createRequest = previous.createRequest;
    globalThis.fetch = previous.fetch;
    installed = false;
  };
}

function aborted(): Error {
  const error = new Error('假网关请求已中止');
  error.name = 'AbortError';
  return error;
}
