import { Directory, File, Paths } from "expo-file-system";

import { DeliveryCache } from "./file-delivery.ts";

const deliveryCaches = new Map<string, DeliveryCache>();

/** Private per-computer originals for native sharing; do not construct on web. */
export function nativeDeliveryCache(computerId: string): DeliveryCache {
  // Expo's web FileSystem has no Directory implementation. Construct lazily.
  let cache = deliveryCaches.get(computerId);
  if (!cache) {
    const directory = new Directory(Paths.cache, "wandrun-delivery", encodeURIComponent(computerId));
    cache = new DeliveryCache({
      create: () => directory.create({ intermediates: true, idempotent: true }),
      list: () => directory.list().filter((entry): entry is File => entry instanceof File),
      file: (name) => new File(directory, name),
      download: async (url, destination, headers) => {
        // SDK 57 Android may leave a cancelled buffered read unsettled. Let the
        // old request finish in its original computer's private cache instead.
        const task = File.createDownloadTask(url, new File(destination.uri), { headers });
        if (!await task.downloadAsync()) throw new Error("下载未完成");
      },
    });
    deliveryCaches.set(computerId, cache);
  }
  return cache;
}
