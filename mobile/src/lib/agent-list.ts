// 首页与“全部 Agent”的纯展示逻辑：分组、名字过滤、行的第二行文字、时间格式。不依赖 React Native。

import { getLocale, t } from "./i18n.ts";
import type { AgentSummary } from "../gateway/api.ts";
import { messagePreview } from "./message-preview.ts";

/** 首页：home=true 的 Agent，保持网关给的顺序（顺序由网关按最近产品活动排好，这里不重排）。 */
export function homeAgents(agents: AgentSummary[]): AgentSummary[] {
  return agents.filter((agent) => agent.home);
}

/** 全部 Agent：按名字（不区分大小写的子串）过滤后分成在首页 / 不在首页两组，组内保持网关顺序。 */
export function groupAgents(
  agents: AgentSummary[],
  query: string,
): { onHome: AgentSummary[]; hidden: AgentSummary[] } {
  const needle = query.trim().toLowerCase();
  const matched = needle ? agents.filter((agent) => agent.name.toLowerCase().includes(needle)) : agents;
  return { onHome: matched.filter((agent) => agent.home), hidden: matched.filter((agent) => !agent.home) };
}

export type RowText =
  /** 工作中：activity 是“正在做什么”，没有时只显示“工作中”。 */
  | { kind: "working"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "plain"; text: string };

/**
 * 首页一行的第二行。工作中与失败优先于最后一句，因为它们是用户此刻最需要知道的；
 * 没有消息可显示时退回 Agent 的说明（再没有则固定占位），行不留空。
 * offline：事件流不在线时缓存的“工作中”不再可信（断开期间可能已结束），如实说状态未知。
 */
export function homeRowText(agent: AgentSummary, activity: string | null, offline = false): RowText {
  const latest = agent.latest_conversation;
  if (offline && latest?.status === "working") return { kind: "plain", text: "断开后状态未知" };
  if (latest?.status === "working") return { kind: "working", text: activity ? `工作中 · ${activity}` : "工作中" };
  if (latest?.status === "failed") return { kind: "failed", text: "上一轮失败" };
  return { kind: "plain", text: messagePreview(latest?.last_text) || agent.description.trim() || t("还没有对话") };
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 首页时间（seconds 为网关的 Unix 秒）：1 分钟内“刚刚”，1 小时内“N 分钟前”，今天“HH:mm”，
 * 昨天“昨天”，一周内“周X”，今年“M月D日”，更早“YYYY/M/D”。日界按设备本地时区。
 * 时钟略快导致的未来时间按“刚刚”处理。
 */
export function formatActivityTime(seconds: number, now: Date, locale = getLocale()): string {
  const at = new Date(seconds * 1000);
  const elapsed = now.getTime() - at.getTime();
  if (elapsed < 60_000) return t("刚刚");
  if (elapsed < 3_600_000) return t("{count} 分钟前", { count: Math.floor(elapsed / 60_000) });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return t("昨天");
  if (days < 7) return locale === "zh-CN" ? WEEKDAYS[at.getDay()] : new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
  if (at.getFullYear() === now.getFullYear()) return locale === "zh-CN" ? `${at.getMonth() + 1}月${at.getDate()}日` : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);
  return locale === "zh-CN" ? `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}` : new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(at);
}
