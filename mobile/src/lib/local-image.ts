import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import type { GatewayApi } from '../gateway/api.ts';
import { assertNotAborted } from './abort.ts';

export type LocalImageLease = { uri: string; dispose(): void };
let initialized = false;
let sequence = 0;

/** Own one image decoder URI in the active computer's namespace. Native
 * downloads stream into a File; web uses the API's abortable response body.
 * Callers release completed files on unmount or refresh.
 */
export async function loadLocalImage(api: GatewayApi, path: string, signal: AbortSignal): Promise<LocalImageLease> {
  if (!api.config.computerId) throw new Error('图片需要有效的电脑连接');
  assertNotAborted(signal);
  assertNotAborted(api.signal);
  if (Platform.OS === 'web') {
    const { bytes, contentType } = await api.readBinary(path, signal);
    assertNotAborted(signal);
    assertNotAborted(api.signal);
    const uri = URL.createObjectURL(new Blob([bytes], { type: contentType }));
    if (signal.aborted || api.signal.aborted) {
      URL.revokeObjectURL(uri);
      assertNotAborted(signal);
      assertNotAborted(api.signal);
    }
    return { uri, dispose: () => URL.revokeObjectURL(uri) };
  }

  const root = new Directory(Paths.cache, 'wandrun-images');
  if (!initialized) {
    if (root.exists) root.delete();
    initialized = true;
  }
  const directory = new Directory(root, encodeURIComponent(api.config.computerId));
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, `image-${++sequence}`);
  try {
    assertNotAborted(signal);
    assertNotAborted(api.signal);
    // SDK 57 Android's buffered-read cancellation may never settle. The old
    // request finishes into its own file; only publish while both owners live.
    const task = File.createDownloadTask(`${api.config.baseUrl}${path}`, file, {
      headers: api.headers(),
    });
    if (!await task.downloadAsync()) throw new Error('下载未完成');
    assertNotAborted(signal);
    assertNotAborted(api.signal);
    return { uri: file.uri, dispose: () => { if (file.exists) file.delete(); } };
  } catch (cause) {
    if (file.exists) file.delete();
    if (!signal.aborted && !api.signal.aborted) void api.checkUnauthorized(signal);
    throw cause;
  }
}
