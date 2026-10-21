import assert from "node:assert/strict";
import test from "node:test";

import { GatewayError, type Skill, type SkillDetail } from "../src/gateway/api.ts";
import { commitSkillDeletion, importSkillDraft, openSkillImport, preflightSkillDeletion, selectableSkills, SkillActionScope, skillDeletionUsers, skillMarkdown, SKILL_IMPORT_PROMPT } from "../src/lib/skills.ts";

const valid: Skill = {
  name: "source-check", description: "核对来源",
  used_by: [{ id: "agent-1", name: "研究员" }], status: "ok", error: null,
};
const invalid: Skill = {
  name: "missing-skill", description: "",
  used_by: [], status: "error", error: "缺少 SKILL.md",
};

test("Malformed skills are visible in catalog but cannot become a new Agent selection", () => {
  assert.deepEqual(selectableSkills([valid, invalid], []).map(({ skill }) => skill.name), ["source-check"]);
  assert.deepEqual(selectableSkills([valid, invalid], ["missing-skill"]).map(({ skill, removableOnly }) => [skill.name, removableOnly]), [
    ["source-check", false], ["missing-skill", true],
  ]);
  assert.deepEqual(selectableSkills([valid], ["gone"])[1], {
    skill: { name: "gone", description: "", used_by: [], status: "error", error: "当前技能目录中不可用" },
    removableOnly: true,
  });
});

test("Import shortcut preserves an unsent draft and does not duplicate its prompt", () => {
  assert.equal(importSkillDraft(""), SKILL_IMPORT_PROMPT);
  assert.equal(importSkillDraft("原有草稿"), `原有草稿\n${SKILL_IMPORT_PROMPT}`);
  assert.equal(importSkillDraft(importSkillDraft("原有草稿")), `原有草稿\n${SKILL_IMPORT_PROMPT}`);
});

test("Deletion conflict names only valid Agent users from gateway details", () => {
  assert.deepEqual(skillDeletionUsers({ used_by: [
    { id: "agent-1", name: "研究员" }, { id: "", name: "仍存在" },
    { id: 5, name: "无效" }, { id: "agent-2", name: null },
  ] }), [{ id: "agent-1", name: "研究员" }, { id: "", name: "仍存在" }]);
  assert.deepEqual(skillDeletionUsers({ used_by: "broken" }), []);
  assert.deepEqual(skillDeletionUsers(null), []);
});

const detail: SkillDetail = {
  ...valid, path: ".wandrun/skills/source-check", mtime: 1,
  content: "---\nname: source-check\ndescription: 核对来源\n---\n# 正文\n内容\n",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("Normal skill Markdown omits only YAML frontmatter; malformed entries retain original bytes", () => {
  assert.equal(skillMarkdown(detail), "# 正文\n内容\n");
  assert.equal(skillMarkdown({ ...detail, content: "---\n\nname: source-check\ndescription: 核对\n---\n# 正文\n---\n后续" }), "# 正文\n---\n后续");
  assert.equal(skillMarkdown({ ...detail, content: "---\r\nname: source-check\r\n---\r\nbody" }), "body");
  assert.equal(skillMarkdown({ ...detail, content: "plain Markdown" }), "plain Markdown");
  assert.equal(skillMarkdown({ ...detail, status: "error" }), detail.content);
  assert.equal(skillMarkdown({ ...detail, content: null }), null);
});

test("Late import creation cannot modify an old draft, navigate, or alert after blur and refocus", async () => {
  const scope = new SkillActionScope();
  const effects: string[] = [];
  scope.focus();
  const success = deferred<string>();
  const oldSuccess = openSkillImport(scope.current(), () => success.promise,
    (id) => effects.push(`draft:${id}`), (id) => effects.push(`navigate:${id}`), (error) => effects.push(`alert:${error}`));
  scope.blur();
  scope.focus();
  success.resolve("old");
  await oldSuccess;
  assert.equal(effects.length, 0);

  const failure = deferred<string>();
  const oldFailure = openSkillImport(scope.current(), () => failure.promise,
    (id) => effects.push(`draft:${id}`), (id) => effects.push(`navigate:${id}`), (error) => effects.push(`alert:${error}`));
  scope.blur();
  scope.focus();
  failure.reject(new Error("offline"));
  await oldFailure;
  assert.equal(effects.length, 0);

  await openSkillImport(scope.current(), async () => "new",
    (id) => effects.push(`draft:${id}`), (id) => effects.push(`navigate:${id}`), (error) => effects.push(`alert:${error}`));
  assert.deepEqual(effects, ["draft:new", "navigate:new"]);
});

test("Late skill deletion preflight drops success, failure, and 404 across focus visits", async () => {
  const scope = new SkillActionScope();
  const effects: string[] = [];
  const show = (value: SkillDetail) => effects.push(`dialog:${value.name}`);
  const missing = () => effects.push("dismiss");
  const error = (message: string) => effects.push(`error:${message}`);
  scope.focus();
  for (const result of [detail, new Error("offline"), new GatewayError(404, "not_found", "gone")]) {
    const pending = deferred<SkillDetail>();
    const action = preflightSkillDeletion(scope.current(), () => pending.promise, show, missing, error);
    scope.blur();
    scope.focus();
    if (result instanceof Error) pending.reject(result);
    else pending.resolve(result);
    await action;
    assert.deepEqual(effects, []);
  }

  await preflightSkillDeletion(scope.current(), async () => detail, show, missing, error);
  assert.deepEqual(effects, ["dialog:source-check"]);
  await preflightSkillDeletion(scope.current(), async () => { throw new GatewayError(404, "not_found", "gone"); }, show, missing, error);
  assert.deepEqual(effects, ["dialog:source-check", "dismiss"]);
});

test("Committed deletion updates shared state but stale responses never dismiss or restore a conflict dialog", async () => {
  const scope = new SkillActionScope();
  const effects: string[] = [];
  const event = { seq: 5, type: "resource.changed", at: 1, data: { kind: "skill", id: "source-check", op: "deleted" } };
  const changed = () => effects.push("shared");
  const dismissed = () => effects.push("dismiss");
  const blocked = (users: { id: string; name: string }[]) => effects.push(`blocked:${users[0]?.name}`);
  const error = (message: string) => effects.push(`error:${message}`);
  scope.focus();
  const pending = deferred<{ event: typeof event | null }>();
  const success = commitSkillDeletion(scope.current(), () => pending.promise, changed, dismissed, blocked, error);
  scope.blur();
  scope.focus();
  pending.resolve({ event });
  await success;
  assert.deepEqual(effects, ["shared"]);

  const conflict = deferred<{ event: typeof event | null }>();
  const stale = commitSkillDeletion(scope.current(), () => conflict.promise, changed, dismissed, blocked, error);
  scope.blur();
  scope.focus();
  conflict.reject(new GatewayError(409, "in_use", "busy", { used_by: [{ id: "a", name: "研究员" }] }));
  await stale;
  assert.deepEqual(effects, ["shared"]);

  await commitSkillDeletion(scope.current(), async () => { throw new GatewayError(409, "in_use", "busy", { used_by: [{ id: "a", name: "研究员" }] }); },
    changed, dismissed, blocked, error);
  assert.deepEqual(effects, ["shared", "blocked:研究员"]);
});

