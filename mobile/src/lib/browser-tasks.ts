import type { BrowserPage, BrowserTask } from "@/gateway/api.ts";
import { t } from "./i18n.ts";

export type ActiveBrowserPage = { task: BrowserTask; page: BrowserPage };
export type BrowserPageGroup = { agentId: string; agentName: string; pages: ActiveBrowserPage[] };

/** Only pages still owned by a live lease are navigable. Identity follows the entry Agent, not its delegate. */
export function activeBrowserPages(tasks: Iterable<BrowserTask>, entryAgentId?: string): ActiveBrowserPage[] {
  const pages: ActiveBrowserPage[] = [];
  for (const task of tasks) {
    if (task.state === "released" || (entryAgentId !== undefined && task.entry_agent_id !== entryAgentId)) continue;
    for (const page of task.pages) pages.push({ task, page });
  }
  return pages;
}

/** Requested leases take the prominent spot; within a lease its current page comes before secondary pages. */
export function prioritizeBrowserPages(pages: ActiveBrowserPage[]): ActiveBrowserPage[] {
  return [...pages].sort((a, b) =>
    Number(b.task.state === "requested") - Number(a.task.state === "requested") ||
    Number(b.page.id === b.task.current) - Number(a.page.id === a.task.current));
}

export function groupBrowserPages(pages: ActiveBrowserPage[]): BrowserPageGroup[] {
  const groups = new Map<string, BrowserPageGroup>();
  for (const item of pages) {
    let group = groups.get(item.task.entry_agent_id);
    if (!group) {
      group = { agentId: item.task.entry_agent_id, agentName: item.task.entry_agent_name, pages: [] };
      groups.set(group.agentId, group);
    }
    group.pages.push(item);
  }
  return [...groups.values()];
}

export function browserStateLabel(state: BrowserTask["state"]): string {
  switch (state) {
    case "agent": return t("Agent 操作中");
    case "requested": return t("等你接管");
    case "human": return t("你接管中");
    case "revoking": return t("交还中");
    case "stopping": return t("正在结束");
    case "released": return t("已结束");
  }
}

export function browserPageHost(page: BrowserPage): string {
  try { return new URL(page.url).host || page.url; }
  catch { return page.url; }
}

export function browserPageLabel(page: BrowserPage): string {
  const host = browserPageHost(page);
  const title = page.title.trim();
  return title && host && title !== host ? `${title} · ${host}` : title || host || t("新页面");
}
