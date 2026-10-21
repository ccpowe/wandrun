import { useFocusEffect, useIsFocused } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import type { AgentCapability } from "../gateway/api.ts";
import type { ChatSession } from "../gateway/session.ts";
import { t } from "./i18n.ts";

/** Fetch committed capabilities on focus, Agent changes and reconnect, without changing editor drafts. */
export function useAgentCapabilities(session: ChatSession, id?: string): {
  capabilities: AgentCapability[] | null; error: string; refresh: () => void;
} {
  const revision = useSyncExternalStore(session.subscribe, () => session.agents.definitionVersion);
  const connection = useSyncExternalStore(session.subscribe, () => session.connection);
  const focused = useIsFocused();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ session: ChatSession; id?: string; capabilities: AgentCapability[] | null; error: string }>(
    { session, id, capabilities: null, error: "" },
  );
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  useEffect(() => {
    if (!focused || !id) return;
    let active = true;
    void session.api.getAgentCapabilities(id).then(
      ({ capabilities }) => {
        if (active) setState({ session, id, capabilities, error: "" });
      },
      (reason: unknown) => {
        if (active) setState((current) => ({
          session, id,
          capabilities: current.session === session && current.id === id ? current.capabilities : null,
          error: t("无法加载系统能力：{error}", { error: t(reason instanceof Error ? reason.message : String(reason)) }),
        }));
      },
    );
    return () => { active = false; };
  }, [session, id, focused, revision, connection, retry]);
  return state.session === session && state.id === id
    ? { capabilities: state.capabilities, error: state.error, refresh }
    : { capabilities: null, error: "", refresh };
}
