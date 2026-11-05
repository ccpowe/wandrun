import { skipToken } from "@tanstack/react-query";

import type { ChatSession } from "../gateway/session.ts";
import { builtinSkillListOptions, skillListOptions } from "./gateway-queries.ts";
import { useGatewayQuery } from "./use-gateway-query.ts";

/** Shared by settings summary and Agent editing; no page owns the default-entry Agent policy. */
export function useSkillCatalog(session: ChatSession | null) {
  const read = useGatewayQuery(session ? skillListOptions(session) : skipToken);
  return {
    skills: read.data?.skills ?? [], defaultAgentId: read.data?.default_agent_id ?? null,
    loaded: read.data !== undefined, refreshing: read.fetchStatus === "fetching" && read.data !== undefined,
    fetchStatus: read.fetchStatus,
    error: read.error ? "无法加载技能，正在重试…" : "", refresh: read.refresh,
  };
}

/** A workspace read failure must not hide built-in system skills. */
export function useBuiltinSkillCatalog(session: ChatSession | null) {
  const read = useGatewayQuery(session ? builtinSkillListOptions(session) : skipToken);
  return {
    skills: read.data?.skills ?? [], loaded: read.data !== undefined,
    refreshing: read.fetchStatus === "fetching" && read.data !== undefined, fetchStatus: read.fetchStatus,
    error: read.error ? "无法加载技能，正在重试…" : "", refresh: read.refresh,
  };
}
