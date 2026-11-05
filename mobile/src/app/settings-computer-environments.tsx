import { Redirect, router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { SettingsComputerEnvironmentsView } from "@/components/settings-computer-environments-view.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { filterEnvironments, parseEnvironmentFilter } from "@/lib/server-environments.ts";
import { useServerEnvironments } from "@/lib/use-server-environments.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function SettingsComputerEnvironments() {
  const session = useSession();
  const { filter } = useLocalSearchParams<{ filter?: string }>();
  if (!session) return <Redirect href="/settings" />;
  return <EnvironmentsScreen key={session.queryIdentity} session={session} initialFilter={filter} />;
}
/** Search text and filter are this visit's UI state only (E5); environment facts stay in the shared Query cache. */
function EnvironmentsScreen({ session, initialFilter }: { session: ChatSession; initialFilter?: string }) {
  const environments = useServerEnvironments(session);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(() => parseEnvironmentFilter(initialFilter));
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <SettingsComputerEnvironmentsView banner={<ConnectionBanner session={session} />} rows={filterEnvironments(environments.rows, filter, query)}
      loaded={environments.loaded} error={environments.error} query={query} filter={filter}
      onQuery={setQuery} onFilter={setFilter} onRetry={() => void environments.retry()} onBack={() => router.back()} />
  </>;
}
