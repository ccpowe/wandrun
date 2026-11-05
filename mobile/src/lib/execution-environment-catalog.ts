import type { ExecutionEnvironment } from "../gateway/api.ts";
import type { ChatSession } from "../gateway/session.ts";
import { executionEnvironmentOptions } from "./gateway-queries.ts";
import { useGatewayInfiniteQuery } from "./use-gateway-query.ts";

const LOCAL: ExecutionEnvironment = { id: "local", name: "Local", type: "local", status: null };

/** Query owns every page and cursor. A later-page failure keeps all successfully read machines available.
 * `refetchInterval` lets a status view poll while focused; pickers read on focus only. */
export function useExecutionEnvironmentCatalog(session: ChatSession, { refetchInterval }: { refetchInterval?: number } = {}) {
  const read = useGatewayInfiniteQuery({ ...executionEnvironmentOptions(session), refetchInterval });
  const environments = new Map<string, ExecutionEnvironment>([[LOCAL.id, LOCAL]]);
  for (const page of read.data?.pages ?? []) for (const environment of page.environments) environments.set(environment.id, environment);
  const last = read.data?.pages.at(-1);
  const repeated = !!last?.next_cursor && read.data!.pageParams.includes(last.next_cursor);
  const error = read.fetchStatus === "paused" ? "" : repeated ? "机器列表分页未完成，请重试"
    : read.error ? "无法加载 Instabox 机器，请重试" : "";
  return { environments: [...environments.values()], loading: read.fetchStatus === "fetching" && !error,
    /** No page has been read yet (first read in flight or failed). */
    loaded: read.data !== undefined,
    /** Gateway's own wording of the failure, for views that state the affected object themselves. */
    errorDetail: !error ? "" : repeated ? "机器列表分页未完成" : read.error?.message || error,
    error, refresh: read.refresh, retry: read.retry };
}
