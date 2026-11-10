import assert from "node:assert/strict";
import { test } from "node:test";

import { type AgentDetail, type ModelInfo } from "../src/gateway/api.ts";
import { blankAgentDraft, changedAgentFields, draftFromAgent, leastUsedAvatar, prepareCreateCommand, toggleSelection, validateAgentName } from "../src/lib/agent-editor.ts";
import { chooseModel, modelName, reasoningOptions, selectedModel } from "../src/lib/model-selection.ts";

const detail: AgentDetail = {
  id: "agent-7", name: "研究员", avatar: 3, description: "查证", system_prompt: "给出来源",
  model: "model-a", reasoning_effort: "medium", fast_mode: false, skills: ["browser"], workers: ["writer"],
  mcp_servers: ["secret"], searchable_mcp_servers: [], code_mode: true, environment: "local", member_of: ["team"],
};

test("agent-editor.B2 Display names trim boundaries and validate line and Unicode length", () => {
  for (const name of ["", " ", "a\nb", "a\u2028b", "a\u0085b", "字".repeat(65)]) {
    assert.notEqual(validateAgentName(name), null, JSON.stringify(name));
  }
  for (const name of [" 研究员", "研究员 ", "研究 员", "字".repeat(64), "😀".repeat(64)]) assert.equal(validateAgentName(name), null);
  assert.notEqual(validateAgentName("😀".repeat(65)), null);
});

test("agent-editor.B2 create and rename commands trim names without changing case or drafts", () => {
  const draft = { ...draftFromAgent(detail), name: " Test " };
  assert.equal(prepareCreateCommand(draft, "trim").fields.name, "Test");
  assert.deepEqual(changedAgentFields(draftFromAgent(detail), draft), { name: "Test" });
  assert.equal(draft.name, " Test ");
});

test("Agent PATCH only includes changed editable fields, preserving server-owned definitions", () => {
  const before = draftFromAgent(detail);
  const after = { ...before, name: "研究", avatar: 7, reasoning_effort: "xhigh", skills: ["browser", "search"], workers: [] };
  assert.deepEqual(changedAgentFields(before, after), {
    name: "研究", avatar: 7, reasoning_effort: "xhigh", skills: ["browser", "search"], workers: [],
  });
  assert.deepEqual(changedAgentFields(before, { ...before, skills: [...before.skills], workers: [...before.workers] }), {});
  assert.deepEqual(changedAgentFields(before, { ...before, system_prompt: "", description: "", reasoning_effort: null }), {
    description: "", system_prompt: "", reasoning_effort: null,
  });
  assert.deepEqual(changedAgentFields(before, { ...before, workers: ["writer", "helper"] }), { workers: ["writer", "helper"] });
  const legacy = draftFromAgent({ ...detail, reasoning_effort: "minimal" });
  assert.deepEqual(changedAgentFields(legacy, { ...legacy, name: "新名字" }), { name: "新名字" });
  const defaultEffort = draftFromAgent({ ...detail, reasoning_effort: null });
  assert.deepEqual(changedAgentFields(defaultEffort, { ...defaultEffort, avatar: 0 }), { avatar: 0 });
});

test("agent-editor.D1 D3 Backend edits preserve unrelated fields and allow explicit Local selection", () => {
  const blank = blankAgentDraft({ default_model: null, default_reasoning_effort: null }, []);
  assert.equal(blank.environment, "local");
  const before = draftFromAgent({ ...detail, environment: "cloud" });
  assert.deepEqual(changedAgentFields(before, { ...before, name: "改名" }), { name: "改名" });
  assert.deepEqual(changedAgentFields(before, { ...before, environment: "local" }), { environment: "local" });
  const selected = { ...blank, environment: "cloud" };
  const pending = prepareCreateCommand(selected, "cloud-create");
  assert.equal(pending.fields.environment, "cloud");
});

test("Code Mode drafts default on, preserve stored off, and diff only a changed boolean", () => {
  const blank = blankAgentDraft({ default_model: null, default_reasoning_effort: null }, []);
  assert.equal(blank.code_mode, true);
  assert.equal(prepareCreateCommand(blank, "new-on").fields.code_mode, true);
  const storedOff = { ...detail, code_mode: false };
  const original = draftFromAgent(storedOff);
  assert.equal(original.code_mode, false);
  assert.deepEqual(changedAgentFields(original, { ...original, name: "重命名" }), { name: "重命名" });
  const unsaved = { ...original, code_mode: true };
  assert.deepEqual(changedAgentFields(original, unsaved), { code_mode: true });
  assert.deepEqual(changedAgentFields(unsaved, { ...unsaved, code_mode: false }), { code_mode: false });
  assert.equal(prepareCreateCommand({ ...blank, code_mode: false }, "new-off").fields.code_mode, false);
});

test("agent-editor.C5 C6 Fast changes remain independent and unsupported gateways receive no Fast field", () => {
  const blank = blankAgentDraft({ default_model: "model-a", default_reasoning_effort: "high" }, []);
  assert.equal(blank.fast_mode, false);
  assert.equal("fast_mode" in prepareCreateCommand(blank, "unsupported").fields, false);
  const original = draftFromAgent({ ...detail, fast_mode: true });
  assert.equal(original.fast_mode, true);
  assert.deepEqual(changedAgentFields(original, { ...original, reasoning_effort: "max" }), { reasoning_effort: "max" });
  assert.deepEqual(changedAgentFields(original, { ...original, fast_mode: false }), { fast_mode: false });
  assert.deepEqual(draftFromAgent({ ...detail, fast_mode: true }), original);
  const command = prepareCreateCommand({ ...blank, fast_mode: true }, "fast-create", true);
  assert.equal(command.fields.fast_mode, true);
});

test("Removing a connector remains a PATCH even if another device has already removed the same relationship", () => {
  const original = draftFromAgent(detail);
  const patch = changedAgentFields(original, { ...original, mcp_servers: [] });
  assert.deepEqual(patch, { mcp_servers: [] });
  assert.deepEqual(changedAgentFields(draftFromAgent({ ...detail, mcp_servers: [] }), original), {
    mcp_servers: ["secret"],
  });
});

test("New Agent preselects least-used of eight avatars, ties prefer smallest and invalid indexes do not count", () => {
  assert.equal(leastUsedAvatar([]), 0);
  assert.equal(leastUsedAvatar([{ avatar: 0 }, { avatar: 1 }, { avatar: 1 }, { avatar: -1 }, { avatar: 8 }]), 2);
  assert.equal(leastUsedAvatar([0, 1, 2, 3, 4, 5, 6, 7, 0].map((avatar) => ({ avatar }))), 1);
});

test("Model selection respects catalog absence, display names, effort compatibility and defaults", () => {
  const models: ModelInfo[] = [
    { id: "astra", display_name: "Astra", description: "", default_reasoning_effort: "medium",
      supported_reasoning_efforts: [{ effort: "medium", description: "常规" }, { effort: "high", description: "深入思考" }, { effort: "ultra", description: "上游专用" }] },
    { id: "beta", display_name: "", description: "", default_reasoning_effort: "max",
      supported_reasoning_efforts: [{ effort: "high", description: "深入思考" }, { effort: "max", description: "最高" }] },
  ];
  assert.equal(selectedModel(models, "retired"), undefined);
  assert.equal(modelName(models, "retired"), "retired");
  assert.equal(modelName(models, "astra"), "Astra");
  assert.equal(modelName(models, "beta"), "beta");
  assert.deepEqual(chooseModel(models[1], "high"), { model: "beta", reasoning_effort: "high" });
  assert.deepEqual(chooseModel(models[1], "medium"), { model: "beta", reasoning_effort: "max" });
  assert.deepEqual(chooseModel(models[0], null), { model: "astra", reasoning_effort: "medium" });
  assert.deepEqual(chooseModel(models[0], "ultra"), { model: "astra", reasoning_effort: "medium" });
  assert.deepEqual(reasoningOptions(models[0]).map(({ value }) => value), ["medium", "high"]);
  assert.deepEqual(chooseModel({ ...models[1], default_reasoning_effort: null }, "medium"), { model: "beta", reasoning_effort: null });
  assert.equal(prepareCreateCommand(blankAgentDraft({ default_model: null, default_reasoning_effort: null }, []), "new").fields.model, undefined);
});

test("Skills and workers toggle independently without duplicates", () => {
  assert.deepEqual(toggleSelection(["browser", "search"], "browser"), ["search"]);
  assert.deepEqual(toggleSelection(["browser"], "search"), ["browser", "search"]);
});


