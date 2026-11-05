// One secure list owner gates routes; one session owner serializes all transport lifetimes.
import * as SecureStore from "expo-secure-store";
import { createContext, type ReactNode, useCallback, useContext, useEffectEvent, useMemo, useState, useSyncExternalStore } from "react";
import { Platform, View } from "react-native";

import { Text } from "@/components/ui/text.tsx";
import { GatewayApi, GatewayError, type Fetch } from "@/gateway/api.ts";
import { ChatSession } from "@/gateway/session.ts";
import { resetConnections } from "@/lib/connection-liveness.ts";
import { Credentials, type ConnectionConfig, type SavedComputer } from "@/lib/credentials.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { SessionOwner } from "@/lib/session-owner.ts";
import { acknowledgeFirstSendDraft, discardConversationDraft, reconcileConversationDrafts, suspendComputerUploads } from "@/lib/upload-drafts.ts";
import { GatewayQueryProvider, subscribeQueryRecovery } from "./gateway-query-provider.tsx";
import { useMountEffect } from "./use-mount-effect.ts";

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
  newChatConnectionId: string | null;
  configure(config: ConnectionConfig, repairConnectionId?: string): Promise<void>;
  switchComputer(id: string): Promise<void>;
  renameComputer(id: string, name: string): Promise<void>;
  /** Resolves once the local record is durably removed. The best-effort server revoke continues
   * afterwards; a non-401 failure is reported only to `onRemoteFailed` (the page that asked). */
  disconnect(id?: string, onRemoteFailed?: () => void): Promise<void>;
  rememberConversation(connectionId: string, conversationId: string): Promise<void>;
};
const SessionContext = createContext<Value | null>(null);

// An isolated storage/HTTP boundary lets whole-page stories exercise the real owner without
// reading or overwriting the app's paired computers. Production keeps the defaults above.
const defaultCredentials = credentials;
export type SessionRuntime = { credentials: Credentials; fetch: Fetch };
export function SessionProvider({ children, runtime }: { children: ReactNode; runtime?: SessionRuntime }) {
  const credentials = runtime?.credentials ?? defaultCredentials;
  const fetch = runtime?.fetch;
  const [host, setHost] = useState({ credentials, fetch, generation: 0 });
  if (host.credentials !== credentials || host.fetch !== fetch) setHost({ credentials, fetch, generation: host.generation + 1 });
  return <GatewayQueryProvider><SessionContent key={host.generation} runtime={runtime}>{children}</SessionContent></GatewayQueryProvider>;
}

function SessionContent({ children, runtime }: { children: ReactNode; runtime?: SessionRuntime }) {
  const credentials = runtime?.credentials ?? defaultCredentials;
  const fetch = runtime?.fetch;
  const { t } = useTranslation();
  const { computers, config, ready, revoked, newChatConnectionId } = useSyncExternalStore(credentials.subscribe, credentials.snapshot, credentials.snapshot);
  const [failure, setFailure] = useState<string | null>(null);
  const sessionOwner = useMemo(() => new SessionOwner((owner) => {
    const session = new ChatSession(owner, fetch, {}, (reason) => {
      const operation = reason === "revoked" ? credentials.clear(owner, true) : credentials.markInvalid(owner);
      void operation.catch(() => setFailure("无法保存服务器认证状态，请重新打开 App 后重试。"));
    }, resetConnections);
    session.onConversationDeleted = (id) => {
      try { discardConversationDraft(owner.computerId, id); }
      catch (error) { console.warn("Could not clear deleted conversation draft", error); }
    };
    session.onMessageConfirmed = (id, clientId) => {
      if (!session.conversations.has(id)) return;
      try { acknowledgeFirstSendDraft(owner.computerId, id, clientId); }
      catch (error) { console.warn("Could not clear confirmed first-send receipt", error); }
    };
    return session;
  }, suspendComputerUploads, ({ owner, session }) => {
    if (session.connection === "error") return;
    try { reconcileConversationDrafts(owner.computerId, session); }
    catch (error) { console.warn("Could not reconcile conversation drafts", error); }
  }), [credentials, fetch]);
  const active = useSyncExternalStore(sessionOwner.subscribe, sessionOwner.snapshot, sessionOwner.snapshot);
  // One mounted bridge owns the credentials subscription and serial session selection.
  // Local metadata still publishes, but SessionOwner admits only a changed connection identity.
  useMountEffect(() => {
    let attached = true;
    const select = () => {
      const config = credentials.snapshot().config;
      void sessionOwner.select(config?.authStatus === "invalid" ? null : config).catch(() => {
        if (attached) setFailure("无法结束原服务器连接，请重新打开 App 后重试。");
      });
    };
    const unsubscribe = credentials.subscribe(select);
    select();
    void credentials.restore().catch(() => {
      if (attached) setFailure("无法读取已配对服务器，请重新打开 App 后重试。");
    });
    return () => {
      attached = false;
      unsubscribe();
      void sessionOwner.select(null).catch(error => console.warn("Could not close session owner", error));
    };
  });
  const authStatus = config?.authStatus;
  const recover = useEffectEvent((source: "foreground" | "network", backgroundMs: number) => {
    sessionOwner.snapshot()?.session.resume(source, backgroundMs);
  });
  // Same recovery thresholds/route comparison as the former local listeners; the shared adapter
  // additionally updates Query focus/online, without installing a second pair of native listeners.
  useMountEffect(() => subscribeQueryRecovery((source, backgroundMs) => recover(source, backgroundMs)));

  const configure = useCallback(async (next: ConnectionConfig, repairConnectionId?: string) => {
    await credentials.install(next, repairConnectionId);
    const selected = credentials.snapshot().config;
    await sessionOwner.select(selected?.authStatus === "invalid" ? null : selected);
  }, [sessionOwner, credentials]);
  const switchComputer = useCallback(async (id: string) => {
    await credentials.switchComputer(id);
    const selected = credentials.snapshot().config;
    await sessionOwner.select(selected?.authStatus === "invalid" ? null : selected);
  }, [sessionOwner, credentials]);
  const renameComputer = useCallback((id: string, name: string) => credentials.renameComputer(id, name), [credentials]);
  const rememberConversation = useCallback((connectionId: string, conversationId: string) =>
    credentials.rememberConversation(connectionId, conversationId), [credentials]);
  const disconnect = useCallback(async (id?: string, onRemoteFailed?: () => void) => {
    const snapshot = credentials.snapshot();
    const current = snapshot.computers.find((item) => item.computerId === (id ?? snapshot.currentId));
    if (!current) return;
    credentials.beginDisconnect(current);
    try {
      // Only a durable local deletion completes disconnect; remote availability is irrelevant.
      await credentials.finishDisconnect(current);
    } finally {
      credentials.endDisconnect(current);
    }
    if (current.pairingMethod !== "development") {
      // Keep the removed credential outside the session lifetime. revokeCurrent has a
      // 15-second deadline; closing the old session must not cancel this best-effort request.
      const api = new GatewayApi(current, fetch);
      void api.revokeCurrent().catch((error) => {
        if (!(error instanceof GatewayError) || error.status !== 401) onRemoteFailed?.();
      }).finally(() => api.close());
    }
    const selected = credentials.snapshot().config;
    void sessionOwner.select(selected?.authStatus === "invalid" ? null : selected)
      .catch(() => setFailure("无法结束原服务器连接，请重新打开 App 后重试。"));
  }, [sessionOwner, credentials, fetch]);

  if (failure) return <View className="flex-1 items-center justify-center bg-background px-6"><Text accessibilityRole="alert" className="text-destructive">{t(failure)}</Text></View>;
  return <SessionContext.Provider value={{ session: authStatus !== "invalid" && active?.owner.connectionId === config?.connectionId ? active?.session ?? null : null,
    sessionKey: authStatus === "invalid" ? 0 : active?.key ?? 0, computers, config, ready, revoked, newChatConnectionId, configure, switchComputer, renameComputer, disconnect, rememberConversation }}>
    {/* design.md: no notice is mounted at the root; pages own their notices. */}
    <View className="flex-1">{children}</View>
  </SessionContext.Provider>;
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
