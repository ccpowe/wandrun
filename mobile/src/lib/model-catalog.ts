import type { ChatSession } from "../gateway/session.ts";
import { modelCatalogOptions } from "./gateway-queries.ts";
import { useGatewayQuery } from "./use-gateway-query.ts";

/** The catalog is shared by all pickers and summaries in this session; failed refreshes keep known models. */
export function useModelCatalog(session: ChatSession) {
  const read = useGatewayQuery(modelCatalogOptions(session));
  return { catalog: read.data ?? null, loading: read.data === undefined && read.fetchStatus === "fetching", error: read.error !== null };
}
