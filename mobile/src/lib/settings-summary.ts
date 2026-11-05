import type { Connector } from "../gateway/api.ts";
import { t } from "./i18n.ts";
import { subscriptionSummary, type SubscriptionView } from "./model-usage.ts";
import { connectorListRowState } from "./connector-list-state.ts";

export type SettingsSummary = { text: string; danger: boolean };

export function modelSettingsSummary(view: SubscriptionView): SettingsSummary {
  const auth = view.networkError ? null : view.auth;
  const danger = auth?.status === "login_required" || auth?.status === "reauth_required" || auth?.status === "relogin_required"
    || auth?.status === "ready" && (view.usage?.allowed === false || view.usage?.limit_reached === true);
  const text = subscriptionSummary(view);
  return { text: auth?.status === "ready" && view.usage?.plan_type && !danger ? `Codex ${view.usage.plan_type} · ${text}` : text, danger };
}
export function connectorSettingsSummary(rows: Connector[]): SettingsSummary {
  const failed = rows.filter((row) => connectorListRowState(row).failed).length;
  const reauthorize = rows.filter((row) => row.auth_type === "oauth" && row.auth.status === "reauthorization_required").length;
  return {
    text: failed ? t("{failed} 个失败 · 共 {total}", { failed, total: rows.length }) : reauthorize ? t("{count} 个需重新授权 · 共 {total}", { count: reauthorize, total: rows.length }) : String(rows.length),
    danger: failed > 0 || reauthorize > 0,
  };
}
