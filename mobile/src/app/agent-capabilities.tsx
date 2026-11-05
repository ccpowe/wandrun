import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useReducer, useSyncExternalStore } from "react";
import { AgentCapabilitiesView } from "@/components/agent-capabilities-view.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { useAgentCapabilities } from "@/lib/agent-capabilities.ts";
import { capabilityReducer, selectCapabilities } from "@/lib/agent-capabilities-state.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useSession } from "@/lib/session-context.tsx";

export default function AgentCapabilitiesRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const session = useSession();
  if (!session || !id) return <Redirect href="/" />;
  return <CapabilitiesScreen session={session} id={id} />;
}

export function CapabilitiesScreen({ session, id }: { session: ChatSession; id: string }) {
  return <CapabilitiesContainer key={`${session.queryIdentity}:${id}`} session={session} id={id} />;
}

function CapabilitiesContainer({ session, id }: { session: ChatSession; id: string }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const read = useAgentCapabilities(session, id);
  const [state, dispatch] = useReducer(capabilityReducer, { status: "closed" });
  const selection = selectCapabilities(state, read.capabilities, read.error, read.fetchStatus);
  // Revoke this local interaction once; re-enabling the capability must not reopen its old sheet.
  if (selection.revoke) dispatch(selection.revoke);
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <AgentCapabilitiesView selection={selection} readError={session.connection === "open" && !!read.error}
      connectionBanner={<ConnectionBanner session={session} />} onBack={() => router.back()}
      onOpen={id => { if (selection.enabled.some(item => item.id === id)) dispatch({ type: "open", id }); }}
      onClose={() => dispatch({ type: "close" })} />
  </>;
}
