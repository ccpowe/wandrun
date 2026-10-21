import { GatewayError, type GatewayEvent, type Skill, type SkillDetail } from "../gateway/api.ts";
import { t } from "./i18n.ts";

export const SKILL_IMPORT_PROMPT = "帮我导入这个技能：";

/** Preserve an existing unsent conversation draft when the import shortcut reuses a blank conversation. */
export function importSkillDraft(existing: string): string {
  if (existing.includes(SKILL_IMPORT_PROMPT)) return existing;
  return existing ? `${existing}\n${SKILL_IMPORT_PROMPT}` : SKILL_IMPORT_PROMPT;
}

/** A request belongs to one focused visit, not to the screen if it is later focused again. */
export class SkillActionScope {
  private focused = false;
  private epoch = 0;

  focus(): void { this.focused = true; this.epoch++; }
  blur(): void { this.focused = false; this.epoch++; }
  current(): () => boolean {
    const epoch = this.epoch;
    return () => this.focused && this.epoch === epoch;
  }
}

/** Create or reuse an empty chat, preserving its draft only while the initiating visit is current. */
export async function openSkillImport(
  current: () => boolean,
  create: () => Promise<string>,
  addPrompt: (id: string) => void,
  navigate: (id: string) => void,
  reportError: (message: string) => void,
): Promise<void> {
  try {
    const id = await create();
    if (!current()) return;
    addPrompt(id);
    if (current()) navigate(id);
  } catch (reason) {
    if (current()) reportError(reason instanceof Error ? reason.message : String(reason));
  }
}

/** A delayed deletion preflight must not open a portal or navigate from a previous visit. */
export async function preflightSkillDeletion(
  current: () => boolean,
  getSkill: () => Promise<SkillDetail>,
  show: (detail: SkillDetail) => void,
  missing: () => void,
  reportError: (message: string) => void,
): Promise<void> {
  try {
    const detail = await getSkill();
    if (current()) show(detail);
  } catch (reason) {
    if (!current()) return;
    if (reason instanceof GatewayError && reason.status === 404) missing();
    else reportError(t("无法检查删除条件：{error}", { error: t(reason instanceof Error ? reason.message : String(reason)) }));
  }
}

/** A committed delete updates shared state even after blur, but never the old page's UI. */
export async function commitSkillDeletion(
  current: () => boolean,
  remove: () => Promise<{ event: GatewayEvent | null }>,
  changed: (event: GatewayEvent | null) => void,
  dismissed: () => void,
  blocked: (users: { id: string; name: string }[]) => void,
  reportError: (message: string) => void,
): Promise<void> {
  try {
    const { event } = await remove();
    changed(event);
    if (current()) dismissed();
  } catch (reason) {
    if (!current()) return;
    if (reason instanceof GatewayError && reason.status === 409) blocked(skillDeletionUsers(reason.details));
    else reportError(reason instanceof Error ? reason.message : String(reason));
  }
}

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
