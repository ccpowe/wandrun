import type { Skill, SkillDetail } from "../gateway/api.ts";
import { t } from "./i18n.ts";

/** The gateway already validated the frontmatter for normal skills; error entries retain their raw file. */
export function skillMarkdown(detail: Pick<SkillDetail, "status" | "content">): string | null {
  if (detail.content === null || detail.status === "error") return detail.content;
  const match = /^---\s*\n[\s\S]*?\n---\s*\n/.exec(detail.content);
  return match ? detail.content.slice(match[0].length) : detail.content;
}

/** A malformed skill remains visible but cannot become a new Agent selection. */
export function selectableSkills(skills: Skill[], selected: string[]): { skill: Skill; removableOnly: boolean }[] {
  const items = skills.filter((skill) => skill.status === "ok" || selected.includes(skill.name))
    .map((skill) => ({ skill, removableOnly: skill.status !== "ok" }));
  for (const name of selected) {
    if (!skills.some((skill) => skill.name === name)) {
      items.push({ skill: { name, description: "", used_by: [], status: "error", error: t("当前技能目录中不可用") }, removableOnly: true });
    }
  }
  return items;
}

/** Only the gateway's structured 409 usage list is authoritative, not a stale detail snapshot. */
export function skillDeletionUsers(details: unknown): { id: string; name: string }[] {
  if (!details || typeof details !== "object" || !("used_by" in details) || !Array.isArray(details.used_by)) return [];
  return details.used_by.filter((user: unknown): user is { id: string; name: string } =>
    !!user && typeof user === "object" && "id" in user && typeof user.id === "string" &&
    "name" in user && typeof user.name === "string");
}
