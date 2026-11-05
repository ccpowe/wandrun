import { skipToken } from "@tanstack/react-query";

import type { ChatSession } from "../gateway/session.ts";
import { agentCapabilityOptions } from "./gateway-queries.ts";
import { useGatewayQuery } from "./use-gateway-query.ts";
import { userErrorMessage } from "./user-error.ts";

/** Both consumers read one committed snapshot; editor drafts never feed this resource. */
export function useAgentCapabilities(session: ChatSession, id?: string) {
  const read = useGatewayQuery(id ? agentCapabilityOptions(session, id) : skipToken);
  return {
    capabilities: read.data?.capabilities ?? null,
    error: read.error ? userErrorMessage(read.error, "无法加载系统能力") : "",
    fetchStatus: read.fetchStatus,
    refresh: read.refresh,
  };
}
