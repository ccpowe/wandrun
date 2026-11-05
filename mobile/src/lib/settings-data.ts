import { skipToken } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import type { ChatSession } from "../gateway/session.ts";
import { useConnectorListCatalog } from "./connector-catalog.ts";
import { useBuiltinSkillCatalog, useSkillCatalog } from "./skill-catalog.ts";
import { connectionOptions, memoryIndexOptions, settingsOptions, subscriptionOptions } from "./gateway-queries.ts";
import { useGatewayQuery } from "./use-gateway-query.ts";

const noopSubscribe = () => () => {};
const zero = () => 0;

export function useSettingsConnection(session: ChatSession | null) {
  return useGatewayQuery(session ? connectionOptions(session) : skipToken);
}

/** Global defaults and their editor share the same session-prefixed finite GET. */
export function useAgentCreationSettings(session: ChatSession | null) {
  const read = useGatewayQuery(session ? settingsOptions(session) : skipToken);
  return { data: read.isFetchedAfterMount && read.isSuccess ? read.data : undefined, error: read.error };
}
export function useSettingsData(session: ChatSession | null) {
  useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getVersion ?? zero);
  const workspaceSkills = useSkillCatalog(session);
  const builtinSkills = useBuiltinSkillCatalog(session);
  return {
    subscription: useGatewayQuery(session ? subscriptionOptions(session) : skipToken),
    skills: {
      data: workspaceSkills.loaded && builtinSkills.loaded ? {
        total: workspaceSkills.skills.length + builtinSkills.skills.length,
        failed: workspaceSkills.skills.filter((skill) => skill.status === "error").length,
      } : undefined,
      error: workspaceSkills.error || builtinSkills.error || null,
      fetchStatus: workspaceSkills.fetchStatus === "paused" || builtinSkills.fetchStatus === "paused" ? "paused" :
        workspaceSkills.fetchStatus === "fetching" || builtinSkills.fetchStatus === "fetching" ? "fetching" : "idle",
    },
    connectors: useConnectorListCatalog(session),
    profile: useGatewayQuery(session ? memoryIndexOptions(session, "profile", "profile") : skipToken),
  };
}
