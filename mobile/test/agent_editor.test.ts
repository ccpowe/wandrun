import assert from "node:assert/strict";
import { test } from "node:test";

import { GatewayApi, GatewayError, type AgentDetail, type ModelInfo } from "../src/gateway/api.ts";
import { blankAgentDraft, changedAgentFields, createResultUnknown, deletionConflictDetails, deletionReasons, draftFromAgent, leastUsedAvatar, prepareCreateCommand, toggleSelection, validateAgentName } from "../src/lib/agent-editor.ts";
import { chooseModel, modelName, reasoningOptions, selectedModel } from "../src/lib/model-selection.ts";

const detail: AgentDetail = {
  id: "agent-7", name: "研究员", avatar: 3, description: "查证", system_prompt: "给出来源",
  model: "model-a", reasoning_effort: "medium", skills: ["browser"], workers: ["writer"],
  mcp_servers: ["secret"], searchable_mcp_servers: [], code_mode: true, environment: "local", member_of: ["team"],
};

test("Display names enforce gateway whitespace, line and Unicode length boundaries", () => {
  for (const name of ["", " ", " 研究员", "研究员 ", "a\nb", "a\u2028b", "a\u0085b", "字".repeat(65)]) {
    assert.notEqual(validateAgentName(name), null, JSON.stringify(name));
  }
  for (const name of ["研究 员", "字".repeat(64), "😀".repeat(64)]) assert.equal(validateAgentName(name), null);
  assert.notEqual(validateAgentName("😀".repeat(65)), null);
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

test("Code Mode drafts default on, preserve stored off, and diff only a changed boolean", () => {
  const blank = blankAgentDraft({ default_model: null, default_reasoning_effort: null }, []);
  assert.equal(blank.code_mode, true);
  assert.equal(prepareCreateCommand(blank, "new-on", null).fields.code_mode, true);
  const storedOff = { ...detail, code_mode: false };
  const original = draftFromAgent(storedOff);
  assert.equal(original.code_mode, false);
  assert.deepEqual(changedAgentFields(original, { ...original, name: "重命名" }), { name: "重命名" });
  const unsaved = { ...original, code_mode: true };
  assert.deepEqual(changedAgentFields(original, unsaved), { code_mode: true });
  assert.deepEqual(changedAgentFields(unsaved, { ...unsaved, code_mode: false }), { code_mode: false });
  assert.equal(prepareCreateCommand({ ...blank, code_mode: false }, "new-off", null).fields.code_mode, false);
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
  assert.equal(prepareCreateCommand(blankAgentDraft({ default_model: null, default_reasoning_effort: null }, []), "new", null).fields.model, undefined);
});

test("Skills and workers toggle independently without duplicates", () => {
  assert.deepEqual(toggleSelection(["browser", "search"], "browser"), ["search"]);
  assert.deepEqual(toggleSelection(["browser"], "search"), ["browser", "search"]);
});

test("Unreadable 201 preserves the exact create command; only explicit HTTP refusal permits a new one", async () => {
  const requests: { client_id: string; name: string; skills: string[]; workers: string[] }[] = [];
  let responseNumber = 0;
  const api = new GatewayApi({ baseUrl: "https://gateway.test", token: "dev" }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (responseNumber++ === 0) return new Response('{"agent":', { status: 201 });
    return Response.json({ agent: { id: "created" }, event: { seq: 1 } }, { status: 201 });
  });
  const draft = draftFromAgent(detail);
  const command = prepareCreateCommand(draft, "command-1", null);
  await assert.rejects(api.createAgent(command.clientId, command.fields), (error: unknown) =>
    error instanceof GatewayError && error.code === "invalid_response" && createResultUnknown(error));
  draft.name = "第二个名字";
  draft.skills.push("later");
  draft.workers.push("later");
  const retry = prepareCreateCommand(draft, "command-2", command);
  assert.equal((await api.createAgent(retry.clientId, retry.fields)).agent.id, "created");
  assert.deepEqual(requests, [
    { ...command.fields, client_id: "command-1" },
    { ...command.fields, client_id: "command-1" },
  ]);
  assert.deepEqual(requests[1].skills, ["browser"]);
  assert.deepEqual(requests[1].workers, ["writer"]);
  assert.equal(createResultUnknown(new Error("unexpected parser failure")), true);
  assert.equal(createResultUnknown(new GatewayError(503, "unavailable", "retry")), true);
  const rejectedApi = new GatewayApi({ baseUrl: "https://gateway.test", token: "dev" }, async () =>
    new Response('{"error":', { status: 400, statusText: "Bad Request" }));
  await assert.rejects(rejectedApi.createAgent("refused", command.fields), (error: unknown) =>
    error instanceof GatewayError && error.status === 400 && !createResultUnknown(error));
  assert.equal(createResultUnknown(new GatewayError(409, "conflict", "refused")), false);
});

test("Deletion constraints retain separate headings and explanations for simultaneous blockers", () => {
  const parsed = deletionConflictDetails({ member_of: [{ id: "team", name: "自媒体团队" }, { id: "other", name: "写作团队" }], running_conversations: 2, running_tasks: 3 });
  const reasons = deletionReasons(parsed);
  assert.deepEqual(reasons.map(({ kind }) => kind), ["members", "work"]);
  for (const name of ["自媒体团队", "写作团队"]) assert.ok(reasons[0].description.includes(name));
  assert.match(reasons[0].title, /2/);
  assert.match(reasons[1].description, /2.*3/);
  const taskOnly = deletionReasons({ running_tasks: 1 });
  assert.deepEqual(taskOnly.map(({ kind }) => kind), ["work"]);
  assert.match(taskOnly[0].description, /1/);
  assert.deepEqual(deletionReasons(deletionConflictDetails(null)), []);
});
