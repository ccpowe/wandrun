import { useEffect, useState } from "react";

import { GatewayError, type AgentMemory, type MemoryScope } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { memoryError } from "@/lib/agent-memory.ts";

/** Read one resource while focused; stale requests cannot replace a newer SSE/connection revision. */
export function useMemory(session: ChatSession | null, scope: MemoryScope, id: string, focused: boolean) {
  const [result, setResult] = useState<{ session: ChatSession; scope: MemoryScope; id: string; memory: AgentMemory | null; error: string; status?: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const revision = session?.memoryRevisionFor(scope, id);
  const connectionRevision = session?.memoryConnectionRevision;
  useEffect(() => {
    if (!session || !focused) return;
    let active = true;
    const current = () => active && !(scope === "work" && session.agents.deletedIds.has(id)) &&
      session.memoryRevisionFor(scope, id) === revision && session.memoryConnectionRevision === connectionRevision;
    void session.api.getMemory(scope, id).then(
      (memory) => { if (current()) setResult({ session, scope, id, memory, error: "" }); },
      (reason: unknown) => {
        if (current()) setResult((previous) => ({ session, scope, id,
          memory: previous?.session === session && previous.scope === scope && previous.id === id ? previous.memory : null,
          error: memoryError(reason), status: reason instanceof GatewayError ? reason.status : undefined }));
      },
    );
    return () => { active = false; };
  }, [session, scope, id, focused, revision, connectionRevision, retry]);
  const matches = result?.session === session && result?.scope === scope && result?.id === id;
  return { memory: matches ? result.memory : null, error: matches ? result.error : "",
    notFound: matches && result.status === 404, retry: () => setRetry((value) => value + 1) };
}
