import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { Connector } from "../gateway/api.ts";
import type { ChatSession } from "../gateway/session.ts";

/** Gateway-owned connector snapshots replace read-only metadata; callers keep editable form state separately. */
export function useConnectorCatalog(session: ChatSession): {
  connectors: Connector[]; loaded: boolean; error: string; refresh: () => void;
} {
  const revision = useSyncExternalStore(session.subscribe, () => session.connectorRevision);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  const [state, setState] = useState<{ session: ChatSession; connectors: Connector[]; loaded: boolean; error: string }>(
    { session, connectors: [], loaded: false, error: "" },
  );

  useEffect(() => {
    let active = true;
    void session.api.listConnectors().then(
      ({ connectors }) => { if (active) setState({ session, connectors, loaded: true, error: "" }); },
      (reason: unknown) => {
        if (active) setState((current) => ({
          session, connectors: current.session === session ? current.connectors : [],
          loaded: current.session === session && current.loaded,
          error: `无法加载连接器：${reason instanceof Error ? reason.message : String(reason)}`,
        }));
      },
    );
    return () => { active = false; };
  }, [session, revision, retry]);

  return state.session === session ? { ...state, refresh } : { connectors: [], loaded: false, error: "", refresh };
}
