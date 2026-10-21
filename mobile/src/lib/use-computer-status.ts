import { useEffect, useState } from "react";

import type { ComputerStatus } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";

/** Refreshes host measurements on focus and lease changes, with periodic updates only while visible. */
export function useComputerStatus(session: ChatSession | null, focused: boolean) {
  const [snapshot, setSnapshot] = useState<{ session: ChatSession; status: ComputerStatus | null; error: string | null } | null>(null);
  const revision = session?.browserRevision;
  useEffect(() => {
    if (!session || !focused) return;
    let valid = true;
    let issued = 0;
    const refresh = () => {
      const request = ++issued;
      void session.api.computer().then(
        (status) => { if (valid && request === issued) setSnapshot({ session, status, error: null }); },
        (reason: unknown) => { if (valid && request === issued) setSnapshot((current) => ({
          session, status: current?.session === session ? current.status : null,
          error: reason instanceof Error ? reason.message : String(reason),
        })); },
      );
    };
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => { valid = false; clearInterval(interval); };
  }, [session, focused, revision]);
  return snapshot?.session === session ? snapshot : null;
}
