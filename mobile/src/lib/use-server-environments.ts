import type { ChatSession } from "../gateway/session.ts";
import { agentDisplayName } from "./agent-display-name.ts";
import { useExecutionEnvironmentCatalog } from "./execution-environment-catalog.ts";
import { serverEnvironmentRows } from "./server-environments.ts";

/** Provider reads are cheap GETs that never wake a machine; still poll only while the server pages are focused (settings-computer C). */
export const SERVER_ENVIRONMENTS_POLL_MS = 60_000;

/** Server page and its subpage share the picker's Query cache; rows are derived each render, never stored. */
export function useServerEnvironments(session: ChatSession) {
  const catalog = useExecutionEnvironmentCatalog(session, { refetchInterval: SERVER_ENVIRONMENTS_POLL_MS });
  const directory = session.agents;
  const agents = directory.loaded && !directory.error
    ? directory.agents.map(agent => ({ name: agentDisplayName(directory, agent.id, agent.name), environment: agent.environment })) : null;
  return { rows: serverEnvironmentRows(catalog.environments, agents, session.browserTasks.values()),
    loaded: catalog.loaded, error: catalog.errorDetail, retry: catalog.retry };
}
