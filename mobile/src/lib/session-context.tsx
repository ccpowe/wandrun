// One secure list owner gates routes; one session owner serializes all transport lifetimes.
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AppState, Platform, View } from "react-native";

import { Text } from "@/components/ui/text.tsx";
import { GatewayApi, GatewayError } from "@/gateway/api.ts";
import { ChatSession } from "@/gateway/session.ts";
import { backgroundRecoveryMs, resetConnections } from "@/lib/connection-liveness.ts";
import { Credentials, type ConnectionConfig, type SavedComputer } from "@/lib/credentials.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { SessionOwner } from "@/lib/session-owner.ts";
import { discardConversationDraft, pruneConversationDrafts, suspendComputerUploads } from "@/lib/upload-drafts.ts";

// expo-secure-store has no web implementation; the web build is a development preview only.
const credentials = new Credentials(Platform.OS === "web" ? {
  getItemAsync: async (key) => localStorage.getItem(key),
  setItemAsync: async (key, value) => localStorage.setItem(key, value),
  deleteItemAsync: async (key) => localStorage.removeItem(key),
} : SecureStore);

type Value = {
  session: ChatSession | null;
  sessionKey: number;
  computers: readonly SavedComputer[];
  config: SavedComputer | null;
  ready: boolean;
  revoked: boolean;
  configure(config: ConnectionConfig, repairConnectionId?: string): Promise<void>;
  switchComputer(id: string): Promise<void>;
  renameComputer(id: string, name: string): Promise<void>;
  disconnect(id?: string): Promise<void>;
};
const SessionContext = createContext<Value | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { computers, config, ready, revoked } = useSyncExternalStore(credentials.subscribe, credentials.snapshot, credentials.snapshot);
  const [failure, setFailure] = useState<string | null>(null);
  const sessionOwner = useMemo(() => new SessionOwner((owner) => {
    const session = new ChatSession(owner, undefined, {}, (reason) => {
      const operation = reason === "revoked" ? credentials.clear(owner, true) : credentials.markInvalid(owner);
      void operation.catch(() => setFailure("无法保存电脑认证状态，请重新打开 App 后重试。"));
    }, resetConnections);
    session.onConversationDeleted = (id) => {
      try { discardConversationDraft(owner.computerId, id); }
      catch (error) { console.warn("Could not clear deleted conversation draft", error); }
    };
    return session;
  }, suspendComputerUploads, ({ owner, session }) => {
    if (session.connection === "error") return;
    try { pruneConversationDrafts(owner.computerId, new Set(session.conversations.keys())); }
    catch (error) { console.warn("Could not prune deleted conversation drafts", error); }
  }), []);
  const active = useSyncExternalStore(sessionOwner.subscribe, sessionOwner.snapshot, sessionOwner.snapshot);
  useEffect(() => {
    void credentials.restore().catch(() => setFailure("无法读取已配对电脑，请重新打开 App 后重试。"));
  }, []);
  // Local notes don't change connectionId; invalid authentication closes this installation.
  const connectionId = config?.connectionId;
  const authStatus = config?.authStatus;
  useEffect(() => {
    void sessionOwner.select(authStatus === "invalid" ? null : credentials.snapshot().config)
      .catch(() => setFailure("无法结束原电脑连接，请重新打开 App 后重试。"));
  }, [connectionId, authStatus, sessionOwner]);
  useEffect(() => () => { void sessionOwner.select(null); }, [sessionOwner]);
  useEffect(() => {
    let backgroundAt: number | null = AppState.currentState === "background" ? Date.now() : null;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        backgroundAt ??= Date.now();
        return;
      }
      const backgroundMs = backgroundAt === null ? 0 : Math.max(0, Date.now() - backgroundAt);
      backgroundAt = null;
      if (backgroundMs >= backgroundRecoveryMs) sessionOwner.snapshot()?.session.resume("foreground", backgroundMs);
    });
    let previousNetwork: { type: Network.NetworkStateType | undefined; isConnected: boolean | undefined } | undefined;
    const network = Network.addNetworkStateListener((state) => {
      const nextNetwork = { type: state.type, isConnected: state.isConnected };
      if (previousNetwork === undefined) {
        // The first subscription event establishes the current-state baseline; it is not a recovery.
        previousNetwork = nextNetwork;
        return;
      }
      const changed = previousNetwork.type !== nextNetwork.type || previousNetwork.isConnected !== nextNetwork.isConnected;
      previousNetwork = nextNetwork;
      if (!changed) return;
      if (state.isConnected === false || state.type === Network.NetworkStateType.NONE) return;
      // Do not include isInternetReachable: Android validation can fluctuate without changing the
      // gateway route. Native HTTP/2 PING detects a same-type route failure within about 30 seconds.
      if (AppState.currentState === "active") sessionOwner.snapshot()?.session.resume("network");
    });
    return () => { subscription.remove(); network.remove(); };
  }, [sessionOwner]);

  const configure = useCallback(async (next: ConnectionConfig, repairConnectionId?: string) => {
    await credentials.install(next, repairConnectionId);
    const selected = credentials.snapshot().config;
    await sessionOwner.select(selected?.authStatus === "invalid" ? null : selected);
  }, [sessionOwner]);
  const switchComputer = useCallback(async (id: string) => {
    await credentials.switchComputer(id);
    const selected = credentials.snapshot().config;
    await sessionOwner.select(selected?.authStatus === "invalid" ? null : selected);
  }, [sessionOwner]);
  const renameComputer = useCallback((id: string, name: string) => credentials.renameComputer(id, name), []);
  const disconnect = useCallback(async (id?: string) => {
    const snapshot = credentials.snapshot();
    const current = snapshot.computers.find((item) => item.computerId === (id ?? snapshot.currentId));
    if (!current) return;
    credentials.beginDisconnect(current);
    // Revoke is bound to the selected list entry, not the active session. A racing SSE 401
    // can close that session without aborting the confirmation request that caused it.
    const api = new GatewayApi(current);
    try {
      if (current.pairingMethod !== "development") {
        try { await api.revokeCurrent(); }
        catch (error) {
          // User-requested disconnect may remove the saved entry even when the old
          // credential was already rejected; generic 401 itself is not revocation.
          if (!(error instanceof GatewayError) || error.status !== 401) throw error;
        }
      }
      await credentials.finishDisconnect(current);
      const selected = credentials.snapshot().config;
      await sessionOwner.select(selected?.authStatus === "invalid" ? null : selected);
    } finally {
      api.close();
      credentials.endDisconnect(current);
    }
  }, [sessionOwner]);

  if (failure) return <View className="flex-1 items-center justify-center bg-background px-6"><Text accessibilityRole="alert" className="text-destructive">{t(failure)}</Text></View>;
  return <SessionContext.Provider value={{ session: authStatus !== "invalid" && active?.owner.connectionId === config?.connectionId ? active?.session ?? null : null,
    sessionKey: authStatus === "invalid" ? 0 : active?.key ?? 0, computers, config, ready, revoked, configure, switchComputer, renameComputer, disconnect }}>{children}</SessionContext.Provider>;
}

export function useGateway(): Value {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useGateway 需要在 SessionProvider 里使用");
  return value;
}

/** Subscribe to a mutable ChatSession's version without multiplying React contexts. */
export function useSession(): ChatSession | null {
  const { session } = useGateway();
  useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getVersion ?? zero);
  return session;
}
const noopSubscribe = () => () => {};
const zero = () => 0;
