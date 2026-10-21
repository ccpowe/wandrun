import type { AgentUsage, GatewayApi, SubscriptionAuth, SubscriptionStatus, SubscriptionUsage } from "../gateway/api.ts";
import { getLanguage, getLocale, t } from "./i18n.ts";

/** A transport error clears current authentication evidence without discarding historical quota. */
export type SubscriptionView = { auth: SubscriptionAuth | null; usage: SubscriptionUsage | null; networkError: boolean };
const subscriptions = new WeakMap<GatewayApi, SubscriptionView>();
const requests = new WeakMap<GatewayApi, number>();

export function lastSubscriptionUsage(api: GatewayApi): SubscriptionView {
  return subscriptions.get(api) ?? { auth: null, usage: null, networkError: false };
}

export async function loadSubscriptionUsage(api: GatewayApi, refresh: boolean): Promise<SubscriptionView> {
  const request = (requests.get(api) ?? 0) + 1;
  requests.set(api, request);
  try {
    const response: SubscriptionStatus = await api.getSubscriptionUsage(refresh);
    const previous = lastSubscriptionUsage(api);
    const latest = request === requests.get(api);
    const auth = (latest || !previous.networkError) &&
      (!previous.auth || response.auth.checked_at > previous.auth.checked_at)
      ? response.auth : previous.auth;
    const usage = response.usage && (!previous.usage || response.usage.fetched_at > previous.usage.fetched_at)
      ? response.usage : previous.usage;
    const value = { auth, usage, networkError: latest ? false : previous.networkError };
    subscriptions.set(api, value);
    return value;
  } catch {
    if (request !== requests.get(api)) return lastSubscriptionUsage(api);
    const value = { auth: null, usage: lastSubscriptionUsage(api).usage, networkError: true };
    subscriptions.set(api, value);
    return value;
  }
}

export function subscriptionSummary(view: SubscriptionView): string {
  if (view.networkError) return t("登录状态暂不可检查");
  switch (view.auth?.status) {
    case "reauth_required": return t("需要重新登录");
    case "relogin_required": return t("凭据轮换结果不确定，需停止网关并重新登录");
    case "login_required": return t("尚未登录");
    case "temporarily_unavailable": return t("登录暂时不可用");
    case "refresh_due": return t("即将续期");
    case "refreshing": return t("正在续期");
    case "ready": return quotaSummary(view.usage) ?? t("已登录");
    default: return t("登录状态待检查");
  }
}

type UsageWindow = SubscriptionUsage["windows"][number];

/** Window durations come from Codex; labels do not assume primary=5h or secondary=7d. */
export function windowTitle(window: UsageWindow): string {
  const seconds = window.window_seconds;
  const duration = seconds > 0 && seconds % 86400 === 0
    ? t("{count} 天", { count: seconds / 86400 })
    : seconds > 0 && seconds % 3600 === 0
      ? t("{count} 小时", { count: seconds / 3600 })
      : seconds > 0 && seconds % 60 === 0
        ? t("{count} 分钟", { count: seconds / 60 })
        : t("{count} 秒", { count: seconds });
  const feature = window.name.includes(".") ? window.name.slice(0, window.name.lastIndexOf(".")) : "";
  return `${feature ? `${feature} · ` : ""}${t("额度（{duration}窗口）", { duration })}`;
}

export function resetLabel(resetAt: number): string {
  const date = new Date(resetAt * 1000);
  if (Number.isNaN(date.getTime())) return t("恢复时间未知");
  if (getLanguage() === "zh") return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} 恢复`;
  return t("{date} 恢复", { date: new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) });
}

export function usedPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function quotaSummary(usage: SubscriptionUsage | null): string | null {
  if (!usage) return null;
  if (usage.limit_reached === true || usage.allowed === false) return t("额度受限");
  if (!usage.windows.length) return null;
  let maximum = 0;
  for (const window of usage.windows) maximum = Math.max(maximum, usedPercent(window.used_percent));
  return t("额度 {percent}%", { percent: Math.round(maximum) });
}

/** Only explicit upstream refusal is blocking; a full-looking rounded meter is not proof of refusal. */
export function quotaWarning(usage: SubscriptionUsage | null, nowSeconds: number): string | null {
  if (!usage || (usage.limit_reached !== true && usage.allowed !== false)) return null;
  // When several windows are exhausted, all of them must recover before requests can resume.
  let recoveryAt = -Infinity;
  for (const window of usage.windows) {
    if (window.used_percent >= 100 && window.reset_at > nowSeconds) recoveryAt = Math.max(recoveryAt, window.reset_at);
  }
  return t("订阅额度当前不可用{recovery}。恢复前模型请求会失败。", { recovery: recoveryAt === -Infinity ? "" : t("，{time}", { time: resetLabel(recoveryAt) }) });
}

/** Gateway totals already include cached input and reasoning output; do not add either again. */
export function agentTokens(usage: Pick<AgentUsage, "input_tokens" | "output_tokens">): number {
  return usage.input_tokens + usage.output_tokens;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 999_950) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}K`;
  return String(tokens);
}
