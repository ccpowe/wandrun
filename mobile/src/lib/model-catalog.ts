import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { GatewayApi, ModelCatalog } from "../gateway/api.ts";

type CatalogEntry = { catalog: ModelCatalog | null; listeners: Set<() => void> };
const catalogs = new WeakMap<GatewayApi, CatalogEntry>();

function entryFor(api: GatewayApi): CatalogEntry {
  let entry = catalogs.get(api);
  if (!entry) {
    entry = { catalog: null, listeners: new Set() };
    catalogs.set(api, entry);
  }
  return entry;
}

/** Cached catalog is shown immediately, with each mounted consumer notified of later refreshes. Failed requests leave the last successful response intact. */
export function useModelCatalog(api: GatewayApi, refresh: boolean): { catalog: ModelCatalog | null; loading: boolean } {
  const subscribe = useCallback((listener: () => void) => {
    const entry = entryFor(api);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [api]);
  const snapshot = useCallback(() => entryFor(api).catalog, [api]);
  const catalog = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [request, setRequest] = useState({ api, refresh, loading: true });

  useEffect(() => {
    let mounted = true;
    void api.listModels(refresh).then((value) => {
      const entry = entryFor(api);
      // An older request must not roll back a newer successful refresh.
      if (!entry.catalog || value.fetched_at >= entry.catalog.fetched_at) {
        entry.catalog = value; // An empty successful list is authoritative too.
        for (const listener of entry.listeners) listener();
      }
    }, () => {
      // First failure leaves catalog null; a refresh failure keeps the prior list.
    }).finally(() => {
      if (mounted) setRequest({ api, refresh, loading: false });
    });
    return () => { mounted = false; };
  }, [api, refresh]);

  return { catalog, loading: request.api === api && request.refresh === refresh ? request.loading : true };
}
