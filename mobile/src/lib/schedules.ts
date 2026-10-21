import type { Schedule, ScheduleFields, ScheduleRule, ScheduleRun } from "../gateway/api.ts";
import { getLanguage, getLocale, t } from "./i18n.ts";

export type ScheduleDraft = ScheduleFields;
export type CreateScheduleCommand = { clientId: string; fields: ScheduleFields };

export function newScheduleDraft(defaultTimezone: string | null): ScheduleDraft {
  return { name: "", content: "", rule: { kind: "once", local_at: "" }, timezone: defaultTimezone ?? "", enabled: true };
}

export function editableSchedule(schedule: Schedule): ScheduleDraft {
  return { name: schedule.name, content: schedule.content, rule: schedule.rule, timezone: schedule.timezone, enabled: schedule.enabled };
}

/** Only changed fields go to PATCH, so an unrelated edit cannot recompute the next trigger. */
export function changedScheduleFields(original: ScheduleDraft, draft: ScheduleDraft): Partial<ScheduleFields> {
  const changes: Partial<ScheduleFields> = {};
  if (draft.name !== original.name) changes.name = draft.name;
  if (draft.content !== original.content) changes.content = draft.content;
  if (JSON.stringify(draft.rule) !== JSON.stringify(original.rule)) changes.rule = draft.rule;
  if (draft.timezone !== original.timezone) changes.timezone = draft.timezone;
  if (draft.enabled !== original.enabled) changes.enabled = draft.enabled;
  return changes;
}

export function validateSchedule(draft: ScheduleDraft): string | null {
  if (!draft.name.trim() || /[\n\r\v\f\u0085\u2028\u2029]/u.test(draft.name) || Array.from(draft.name).length > 64) return t("请填写名称（单行，不超过 64 字）");
  if (!draft.content.trim() || Array.from(draft.content).length > 20_000) return t("请填写执行内容（不超过 20000 字）");
  if (!draft.timezone.trim()) return t("请输入 IANA 时区，例如 Asia/Shanghai");
  const rule = draft.rule;
  if (rule.kind === "once" && !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(rule.local_at)) return t("请输入日期时间，例如 2026-10-10T08:00");
  if ((rule.kind === "daily" || rule.kind === "weekly") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) return t("请输入时间，例如 08:00");
  if (rule.kind === "weekly" && !rule.weekdays.length) return t("请至少选择一天");
  if (rule.kind === "cron" && !rule.expression.trim()) return t("请输入五段 cron 表达式");
  return null; // Full time-zone, DST and cron validation belongs to the gateway.
}

export function scheduleRuleLabel(rule: ScheduleRule): string {
  switch (rule.kind) {
    case "once": return t("单次 {time}", { time: rule.local_at.replace("T", " ") });
    case "daily": return t("每天 {time}", { time: rule.time });
    case "weekly": return t("每周{days} {time}", { days: rule.weekdays.map((day) => t("一二三四五六日"[day - 1] ?? "?")).join(getLanguage() === "en" ? ", " : "、"), time: rule.time });
    case "cron": return `cron ${rule.expression}`;
  }
}

export function scheduleTime(epoch: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", timeZoneName: "shortOffset", hourCycle: "h23",
    }).format(new Date(epoch * 1000));
  } catch {
    return new Date(epoch * 1000).toISOString();
  }
}

export function scheduleNext(schedule: Pick<Schedule, "ended" | "rule" | "enabled" | "next_run_at" | "timezone">): string {
  if (schedule.ended) return t("已结束");
  if (!schedule.enabled) return t("已暂停");
  if (schedule.next_run_at === null) return schedule.rule.kind === "once" ? t("已结束") : t("暂无下次时间");
  return t("下次 {time}", { time: scheduleTime(schedule.next_run_at, schedule.timezone) });
}

export function scheduleRunLabel(run: ScheduleRun): string {
  return t(({ running: "进行中", completed: "已完成", failed: "失败", cancelled: "已取消", missed: "未运行" } as const)[run.status]);
}
