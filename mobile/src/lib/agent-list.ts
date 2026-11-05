// 对话活动时间格式。不依赖 React Native；Agent 显示顺序见 new-chat-agents.ts。

import { getLocale, t } from "./i18n.ts";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 对话活动时间（seconds 为网关的 Unix 秒）：1 分钟内“刚刚”，1 小时内“N 分钟前”，今天“HH:mm”，
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
