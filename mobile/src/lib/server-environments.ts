import type { AgentSummary, BrowserTask, ExecutionEnvironment } from "../gateway/api.ts";
import { getLanguage, t } from "./i18n.ts";

/** Display state of one execution environment on the server page (settings-computer C / E). */
export type EnvironmentState = "local" | "running" | "starting" | "paused" | "unavailable";
export type EnvironmentFilter = "all" | "running" | "starting" | "paused" | "unavailable";
export type ServerEnvironmentRow = {
  id: string; name: string; state: EnvironmentState;
  /** Names of Agents configured to use it, in Agent list order; null while the Agent list is unknown (C6). */
  agents: string[] | null;
  browserPages: number;
};

/** Above this total (including the local machine), quiet paused environments fold into one summary row (C2). */
export const COLLAPSE_THRESHOLD = 8;
export const ENVIRONMENT_FILTERS: EnvironmentFilter[] = ["all", "running", "starting", "paused", "unavailable"];
const ORDER: EnvironmentState[] = ["local", "running", "starting", "unavailable", "paused"];

/** Instabox machine states (SDK 0.5.3 `MachineState`) mapped to the four words; unknown values are not trusted as usable. */
export function environmentState(environment: Pick<ExecutionEnvironment, "type" | "status">): EnvironmentState {
  if (environment.type === "local") return "local";
  switch (environment.status) {
    case "running": return "running";
    case "creating": case "starting": case "resuming": return "starting";
    case "suspending": case "suspended": case "stopping": case "stopped": return "paused";
    default: return "unavailable";
  }
}

export function environmentStateLabel(state: EnvironmentState): string | null {
  switch (state) {
    case "local": return null;
    case "running": return t("运行中");
    case "starting": return t("启动中");
    case "paused": return t("已暂停");
    case "unavailable": return t("不可用");
  }
}

export function environmentFilterLabel(filter: EnvironmentFilter): string {
  return filter === "all" ? t("全部") : environmentStateLabel(filter)!;
}

export function parseEnvironmentFilter(value: unknown): EnvironmentFilter {
  return ENVIRONMENT_FILTERS.includes(value as EnvironmentFilter) ? value as EnvironmentFilter : "all";
}

/** “状态 · wand、test 在用”; the local row has no state word, and an unknown Agent list says nothing about usage. */
export function environmentSubtitle(row: Pick<ServerEnvironmentRow, "state" | "agents">): string | undefined {
  const usage = row.agents === null ? null : row.agents.length
    ? t("{agents} 在用", { agents: row.agents.join(getLanguage() === "en" ? ", " : "、") }) : t("没有 Agent 在用");
  const state = environmentStateLabel(row.state);
  return [state, usage].filter(Boolean).join(" · ") || undefined;
}

/** Rows ordered local → running → starting → unavailable → paused; the gateway order is kept within each state (C3).
 * Agent references outside the catalog are not invented as rows (C7). */
export function serverEnvironmentRows(environments: ExecutionEnvironment[], agents: Pick<AgentSummary, "name" | "environment">[] | null,
  tasks: Iterable<Pick<BrowserTask, "state" | "environment_id" | "pages">>): ServerEnvironmentRow[] {
  const pages = new Map<string, number>();
  for (const task of tasks) if (task.state !== "released") pages.set(task.environment_id, (pages.get(task.environment_id) ?? 0) + task.pages.length);
  const rows = environments.map((environment): ServerEnvironmentRow => ({
    id: environment.id, name: environment.type === "local" ? t("本机") : environment.name, state: environmentState(environment),
    agents: agents && agents.filter(agent => agent.environment === environment.id).map(agent => agent.name),
    browserPages: pages.get(environment.id) ?? 0,
  }));
  return rows.map((row, index) => ({ row, index }))
    .sort((a, b) => ORDER.indexOf(a.row.state) - ORDER.indexOf(b.row.state) || a.index - b.index).map(({ row }) => row);
}

/** Main page: everything up to the threshold; beyond it only rows that need attention plus a paused count (C2). */
export function mainPageEnvironments(rows: ServerEnvironmentRow[]): { shown: ServerEnvironmentRow[]; hiddenPaused: number } {
  if (rows.length <= COLLAPSE_THRESHOLD) return { shown: rows, hiddenPaused: 0 };
  const shown = rows.filter(row => row.state !== "paused" || row.browserPages > 0);
  return { shown, hiddenPaused: rows.length - shown.length };
}

/** Subpage filter and case-insensitive name search; “运行中” includes the local machine (E2). */
export function filterEnvironments(rows: ServerEnvironmentRow[], filter: EnvironmentFilter, query: string): ServerEnvironmentRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter(row => (filter === "all" || row.state === filter || (filter === "running" && row.state === "local"))
    && (!needle || row.name.toLowerCase().includes(needle)));
}
