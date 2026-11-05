import assert from "node:assert/strict";
import test from "node:test";

import type { Skill, SkillDetail } from "../src/gateway/api.ts";
import { selectableSkills, skillDeletionUsers, skillMarkdown } from "../src/lib/skills.ts";

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

test("Normal skill Markdown omits only YAML frontmatter; malformed entries retain original bytes", () => {
  assert.equal(skillMarkdown(detail), "# 正文\n内容\n");
  assert.equal(skillMarkdown({ ...detail, content: "---\n\nname: source-check\ndescription: 核对\n---\n# 正文\n---\n后续" }), "# 正文\n---\n后续");
  assert.equal(skillMarkdown({ ...detail, content: "---\r\nname: source-check\r\n---\r\nbody" }), "body");
  assert.equal(skillMarkdown({ ...detail, content: "plain Markdown" }), "plain Markdown");
  assert.equal(skillMarkdown({ ...detail, status: "error" }), detail.content);
  assert.equal(skillMarkdown({ ...detail, content: null }), null);
});

