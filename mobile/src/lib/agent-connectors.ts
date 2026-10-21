import type { Connector } from "../gateway/api.ts";
import { t } from "./i18n.ts";

export type ConnectorSelection = { mcp_servers: string[]; searchable_mcp_servers: string[] };
export type ConnectorMode = "direct" | "search";

/** Moving between modes removes the old reference; unselecting removes both. */
export function selectConnector(selection: ConnectorSelection, id: string, mode: ConnectorMode | null): ConnectorSelection {
  return {
    mcp_servers: [...selection.mcp_servers.filter((value) => value !== id), ...(mode === "direct" ? [id] : [])],
    searchable_mcp_servers: [...selection.searchable_mcp_servers.filter((value) => value !== id), ...(mode === "search" ? [id] : [])],
  };
}

/** Validate only when editing references; an unavailable catalog must not block unrelated Agent edits. */
export function validateConnectorSelection(selection: ConnectorSelection, connectors: Pick<Connector, "id" | "name" | "description">[]): string | null {
  const direct = new Set(selection.mcp_servers);
  for (const id of selection.searchable_mcp_servers) {
    if (direct.has(id)) return t("同一连接器不能同时直接携带和按需搜索");
  }
  for (const id of [...selection.mcp_servers, ...selection.searchable_mcp_servers]) {
    const connector = connectors.find((item) => item.id === id);
    if (!connector) return t("连接器 {id} 已不可用，请取消勾选", { id });
    if (selection.searchable_mcp_servers.includes(id) && !connector.description.trim()) return t("{name} 缺少说明，请先在设置 › 连接器补充说明，或改为直接携带", { name: connector.name });
  }
  return null;
}
