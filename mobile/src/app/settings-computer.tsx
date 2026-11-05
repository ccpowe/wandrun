import { Redirect, router, Stack, useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { SettingsComputerView } from "@/components/settings-computer-view.tsx";
import type { ChatSession } from "@/gateway/session.ts";
import { activeBrowserPages, groupBrowserPages } from "@/lib/browser-tasks.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useSession } from "@/lib/session-context.tsx";
import { computerStatusOptions } from "@/lib/gateway-queries.ts";
import { useGatewayQuery } from "@/lib/use-gateway-query.ts";
import { useBrowserTaskClose } from "@/lib/use-browser-task-close.ts";
import { useServerEnvironments } from "@/lib/use-server-environments.ts";
import { mainPageEnvironments } from "@/lib/server-environments.ts";

export default function SettingsComputer() {
  const session = useSession();
  if (!session) return <Redirect href="/settings" />;
  return <ComputerScreen key={session.queryIdentity} session={session} />;
}
export function ComputerScreen({ session }: { session: ChatSession }) {
  const computer = useGatewayQuery(computerStatusOptions(session));
  const pages = activeBrowserPages(session.browserTasks.values());
  const browserClose = useBrowserTaskClose(session, pages.map(({ task }) => task.id));
  const closeDisabledIds = new Set(pages.filter(({ task }) => !browserClose.canClose(task.id)).map(({ task }) => task.id));
  useFocusEffect(useCallback(() => { void session.refreshBrowserTasks(); }, [session]));
  const environments = useServerEnvironments(session);
  const main = mainPageEnvironments(environments.rows);
  const groups = groupBrowserPages(pages).map(group => ({ ...group, agentName: agentDisplayName(session.agents, group.agentId, group.agentName) }));
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <SettingsComputerView status={computer.data ?? null} online={session.connection === "open"} banner={<ConnectionBanner session={session} />}
      resourceError={computer.error?.message} browserError={session.browserError} browserLoading={session.browserRevision === 0} groups={groups}
      closeDisabledIds={closeDisabledIds} closeBlockedReasons={browserClose.blockedReasons} closeUnknown={browserClose.unknown} closeError={browserClose.error}
      environments={{ ...main, total: environments.rows.length, loaded: environments.loaded, error: environments.error }}
      onRetryEnvironments={() => void environments.retry()}
      onOpenPausedEnvironments={() => router.push({ pathname: "/settings-computer-environments", params: { filter: "paused" } })} onBack={() => router.back()} onRefreshBrowser={() => void session.refreshBrowserTasks()}
      onClose={taskId => void browserClose.close(taskId)} onOpen={({ task, page }) => router.push({ pathname: "/browser-viewer", params: { id: task.id, page: page.id } })} />
  </>;
}
