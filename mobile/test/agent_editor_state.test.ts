import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDetail } from "../src/gateway/api.ts";
import type { EditorOperation } from "../src/gateway/editor-operation.ts";
import { agentEditorReducer, agentEditorFeedback, selectAgentEditor, selectAgentEditorAdoption, validateAgentSave,
  type AgentDraft, type AgentEditorEvent, type AgentEditorExternal, type AgentEditorState } from "../src/lib/agent-editor.ts";

const identity = { sessionId: "session-1", resourceId: "agent-7" };
const baseline: AgentDraft = {
  name: "研究员", avatar: 3, description: "查证", system_prompt: "给出来源",
  model: "model-a", reasoning_effort: "medium", fast_mode: false, code_mode: true,
  environment: "local", skills: ["browser"], workers: ["writer"], mcp_servers: ["secret"], searchable_mcp_servers: [],
};
const detail: AgentDetail = { ...baseline, id: identity.resourceId, member_of: ["team"] };
const blockers = [{ kind: "members" as const, title: "仍是团队成员", description: "先从团队移除" }];
const loading: AgentEditorState = { ...identity, status: "loading" };
function external(fields: Partial<AgentEditorExternal> = {}): AgentEditorExternal {
  return { ...identity, offline: false, deleted: false, ...fields };
}
function outcome(fields: Partial<EditorOperation> = {}): EditorOperation {
  return { operationId: "save-1", resource: "agent", id: identity.resourceId, action: "save", status: "unknown", error: "", reconciled: false, ...fields };
}
function at<S extends AgentEditorState["status"]>(state: AgentEditorState, status: S): Extract<AgentEditorState, { status: S }> {
  assert.equal(state.status, status);
  return state as Extract<AgentEditorState, { status: S }>;
}
function editing() {
  return at(agentEditorReducer(loading, { type: "adopt-initial", ...identity, draft: baseline, notice: "" }), "editing");
}
function dirty() {
  return at(agentEditorReducer(editing(), { type: "change", fields: { name: "未保存的名字" } }), "editing");
}
function saving() {
  return at(agentEditorReducer(dirty(), { type: "save-started", operationId: "save-1" }), "saving");
}
function checking() {
  return at(agentEditorReducer(dirty(), { type: "delete-check-started", operationId: "check-1" }), "checking-delete");
}
function confirming() {
  return at(agentEditorReducer(checking(), { type: "delete-checked", operationId: "check-1", name: "最新名字", reasons: [] }), "delete-confirm");
}
function deleting() {
  return at(agentEditorReducer(confirming(), { type: "delete-started", operationId: "delete-1" }), "deleting");
}
const closed = agentEditorReducer(saving(), { type: "save-succeeded", operationId: "save-1", current: detail, leave: true });
const locals = [loading, editing(), saving(), checking(), confirming(), deleting(),
  agentEditorReducer(checking(), { type: "delete-checked", operationId: "check-1", name: "最新名字", reasons: blockers }), closed];

test("A1 A2 A3 初次采纳闭环、来源校验和单调初始化", () => {
  const inputs = external({ initial: { resourceId: identity.resourceId, draft: baseline } });
  assert.equal(selectAgentEditorAdoption(loading, external()), null);
  for (const wrong of [{ sessionId: "old-session" }, { resourceId: "other-agent" }, { initial: { resourceId: "other-agent", draft: baseline } }]) {
    assert.equal(selectAgentEditorAdoption(loading, { ...inputs, ...wrong }), null);
  }
  const pending = selectAgentEditorAdoption(loading, inputs)!;
  assert.equal(pending.type, "adopt-initial");
  const adopted = at(agentEditorReducer(loading, pending), "editing");
  assert.equal(selectAgentEditorAdoption(adopted, inputs), null);
  for (const wrong of [{ sessionId: "old-session" }, { resourceId: "other-agent" }]) {
    assert.equal(agentEditorReducer(loading, { ...pending, ...wrong }), loading);
  }
  const changed = at(agentEditorReducer(adopted, { type: "change", fields: { description: "本地说明" } }), "editing");
  assert.equal(agentEditorReducer(changed, pending), changed);
  assert.equal(selectAgentEditor(changed, external()).phase, "editing");
  assert.equal(selectAgentEditor(changed, external()).draft?.description, "本地说明");
  assert.equal(selectAgentEditorAdoption(changed, external({ initial: { resourceId: identity.resourceId, draft: { ...baseline, name: "刷新结果" } } })), null);
  assert.equal(changed.original, baseline);
});

test("A1 重入以本次 GET 建稿并标记已见终态，不用较旧核对值覆盖", () => {
  const current = { ...baseline, name: "本次新 GET" };
  const inputs = external({ outcome: outcome({ reconciled: true, status: "synced", value: detail, baseline }), initial: { resourceId: identity.resourceId, draft: current } });
  const adopted = at(agentEditorReducer(loading, selectAgentEditorAdoption(loading, inputs)!), "editing");
  assert.equal(adopted.draft, current);
  assert.equal(adopted.adoptedRecoveryId, "save-1");
  assert.equal(selectAgentEditorAdoption(adopted, inputs), null);
});

for (const local of locals) {
  for (const remote of ["none", "offline", "pending", "unknown", "deleted", "deleted-unknown", "deleted-recovery"] as const) {
    test(`A4 A6 T2 投影矩阵 ${local.status} × ${remote}`, () => {
      const inputs = external({ offline: remote === "offline", deleted: remote === "deleted",
        deletedIds: remote === "deleted-unknown" ? new Set([identity.resourceId]) : undefined,
        outcome: remote === "deleted-recovery" ? outcome({ status: "synced", reconciled: true, value: null })
          : remote === "unknown" || remote === "deleted-unknown" || remote === "pending" ? outcome({ status: remote === "pending" ? "pending" : "unknown" }) : undefined });
      const selected = selectAgentEditor(local, inputs);
      const expected = remote.startsWith("deleted") ? "gone" : local.status === "closed" ? "closed"
        : remote === "unknown" ? "unknown" : remote === "pending" ? "pending" : local.status;
      assert.equal(selected.phase, expected);
      assert.equal(selected.canEdit, expected === "editing");
      assert.equal(selected.canSave, expected === "editing" && remote !== "offline");
      assert.equal(selected.canDeleteCheck, expected === "editing" && remote !== "offline");
      assert.equal(selected.canDelete, expected === "delete-confirm" && remote !== "offline");
      const busy = ["saving", "checking-delete", "deleting", "pending"].includes(expected);
      assert.equal(selected.busy, busy);
      assert.equal(selected.canBack, !busy && expected !== "gone" && expected !== "closed");
      assert.equal(selected.autoSaveOnLeave, expected === "editing" && remote !== "offline");
      assert.equal(selected.canChangePanel, expected === "editing");
      assert.equal(selected.leaveKind, expected === "unknown" ? "unknown" : ["gone", "closed"].includes(expected) ? "none" : "ordinary");
      assert.equal(selected.deleteDialog, expected === "delete-blocked" ? "blocked" : ["delete-confirm", "deleting"].includes(expected) ? "confirm" : null);
      assert.equal(selected.draft, "draft" in local ? local.draft : null);
      assert.equal(selected.adoption, null);
    });
  }
}

test("T2 核对采纳闭环、全量实际值、面板保留、重复通知不抹输入", () => {
  const local = agentEditorReducer(saving(), { type: "panel", panel: "prompt" });
  const onPanel = { ...local, panel: "prompt" as const };
  const actual = { ...detail, name: "另一设备名字", description: "实际说明", workers: [] };
  const inputs = external({ outcome: outcome({ status: "synced", reconciled: true, value: actual, baseline }) });
  const pending = selectAgentEditorAdoption(onPanel, inputs)!;
  assert.equal(pending.type, "adopt-recovery");
  assert.equal(selectAgentEditor(onPanel, inputs).phase, "adopting");
  assert.equal(selectAgentEditor(onPanel, inputs).canEdit, false);
  for (const wrong of [{ sessionId: "old-session" }, { resourceId: "other-agent" }, { operationId: "old-operation" }, { current: { ...actual, id: "other-agent" } }]) {
    assert.equal(agentEditorReducer(onPanel, { ...pending, ...wrong }), onPanel);
  }
  for (const wrong of [{ sessionId: "old-session" }, { resourceId: "other-agent" }, { outcome: outcome({ ...inputs.outcome, operationId: "old-operation" }) }]) {
    assert.equal(selectAgentEditorAdoption(onPanel, { ...inputs, ...wrong }), null);
  }
  const adopted = at(agentEditorReducer(onPanel, pending), "editing");
  assert.equal(selectAgentEditorAdoption(adopted, inputs), null);
  assert.equal(adopted.panel, "prompt");
  assert.equal(adopted.error, "");
  assert.equal(adopted.notice, "changed");
  assert.deepEqual(adopted.draft, { ...baseline, name: "另一设备名字", description: "实际说明", workers: [] });
  assert.equal(adopted.draft, adopted.original);
  const changed = at(agentEditorReducer(adopted, { type: "change", fields: { system_prompt: "核对后输入" } }), "editing");
  assert.equal(agentEditorReducer(changed, pending), changed);
  assert.equal(selectAgentEditorAdoption(changed, inputs), null);
  assert.equal(changed.draft.system_prompt, "核对后输入");
  assert.notEqual(selectAgentEditor(onPanel, external({ outcome: outcome() })).leaveIdentity, selectAgentEditor(adopted, inputs).leaveIdentity);
});

for (const start of [editing(), confirming(), deleting(), locals[6]]) {
  test(`T2 ${start.status} 核对采纳关闭旧错误和删除层`, () => {
    const inputs = external({ outcome: outcome({ operationId: "operationId" in start ? start.operationId : "recovery", status: "confirmed", reconciled: true, value: detail }) });
    const adopted = at(agentEditorReducer(start, selectAgentEditorAdoption(start, inputs)!), "editing");
    assert.equal(adopted.notice, "confirmed");
    assert.equal(selectAgentEditor(adopted, inputs).deleteDialog, null);
    assert.equal(selectAgentEditorAdoption(adopted, inputs), null);
  });
}

test("T2 404 优先于保存中与核对，closed 不复活，错资源终态不采纳", () => {
  const missing = external({ outcome: outcome({ reconciled: true, value: null, status: "synced" }) });
  assert.equal(selectAgentEditor(saving(), missing).phase, "gone");
  assert.equal(selectAgentEditor(saving(), missing).canBack, false);
  assert.equal(agentEditorFeedback(selectAgentEditor(saving(), missing)), null);
  assert.equal(selectAgentEditorAdoption(saving(), missing), null);
  const inputs = external({ outcome: outcome({ reconciled: true, value: detail, status: "confirmed" }) });
  assert.equal(selectAgentEditorAdoption(closed, inputs), null);
  assert.equal(selectAgentEditor(closed, inputs).phase, "closed");
  assert.equal(selectAgentEditorAdoption(saving(), external({ outcome: outcome({ id: "wrong", value: detail, reconciled: true }) })), null);
});

test("A3 B5 新访问不接续已完成创建，附着访问才交接，删除优先", () => {
  const local: AgentEditorState = { ...identity, resourceId: "new", status: "loading" };
  const recovered = outcome({ id: "created", status: "confirmed", reconciled: true, value: { ...detail, id: "created" } });
  const inputs = external({ resourceId: "new", outcome: recovered });
  assert.equal(selectAgentEditor(local, inputs).handoff, null);
  assert.deepEqual(selectAgentEditor(local, { ...inputs, attachedCreationId: recovered.operationId }).handoff, { operationId: "save-1", resourceId: "created" });
  assert.equal(selectAgentEditor(local, { ...inputs, attachedCreationId: "old" }).handoff, null);
  assert.equal(selectAgentEditor(local, { ...inputs, attachedCreationId: recovered.operationId, deleted: true }).handoff, null);
  const deletedTarget = selectAgentEditor(local, { ...inputs, attachedCreationId: recovered.operationId, deletedIds: new Set(["created"]) });
  assert.equal(deletedTarget.phase, "gone");
  assert.equal(deletedTarget.handoff, null);
  assert.equal(deletedTarget.canSave, false);
});

test("T1 B2 子面板编辑仅改草稿；校验与明确失败保留输入，修改清错误", () => {
  const panel = at(agentEditorReducer(dirty(), { type: "panel", panel: "members" }), "editing");
  const changed = at(agentEditorReducer(panel, { type: "change", fields: { workers: ["helper"] } }), "editing");
  const completed = at(agentEditorReducer(changed, { type: "panel", panel: "main" }), "editing");
  assert.deepEqual(completed.draft.workers, ["helper"]);
  assert.equal(completed.original, baseline);
  const invalid = at(agentEditorReducer(completed, { type: "validation-failed", message: "提示词空", panel: "prompt" }), "editing");
  assert.equal(invalid.panel, "prompt");
  assert.equal(invalid.error, "提示词空");
  const fixed = at(agentEditorReducer(invalid, { type: "change", fields: { system_prompt: "补充" } }), "editing");
  assert.equal(fixed.error, "");
  assert.equal(fixed.panel, "prompt");
});

test("B7 T4 重名仅定位名字；保留全部输入、拒绝旧响应、改名字清错", () => {
  const local = { ...saving(), panel: "prompt" as const };
  const failure = { type: "save-failed" as const, operationId: "save-1", message: "已有同名 Agent", field: "name" as const };
  assert.equal(agentEditorReducer(local, { ...failure, operationId: "old" }), local);
  const failed = at(agentEditorReducer(local, failure), "editing");
  assert.equal(failed.draft, local.draft);
  assert.equal(failed.panel, "main");
  assert.equal(selectAgentEditor(failed, external()).nameError, "已有同名 Agent");
  assert.equal(selectAgentEditor(failed, external()).saveError, "");
  assert.equal(selectAgentEditor(failed, external()).autoSaveOnLeave, false);
  const description = at(agentEditorReducer(failed, { type: "change", fields: { description: "保留提示" } }), "editing");
  assert.equal(selectAgentEditor(description, external()).nameError, "已有同名 Agent");
  const renamed = at(agentEditorReducer(description, { type: "change", fields: { name: "新名称" } }), "editing");
  assert.equal(selectAgentEditor(renamed, external()).nameError, "");
  assert.equal(selectAgentEditor(renamed, external()).autoSaveOnLeave, true);
  assert.equal(agentEditorReducer(renamed, failure), renamed);
});

test("B3 B4 当前保存成功关闭；失焦成功采用实际值；明确失败可重试且拒绝迟到结果", () => {
  const local = saving();
  const success = { type: "save-succeeded" as const, operationId: "save-1", current: { ...detail, name: "实际名字" }, leave: true };
  assert.equal(agentEditorReducer(local, { ...success, operationId: "old" }), local);
  assert.equal(agentEditorReducer(local, success).status, "closed");
  const stayed = at(agentEditorReducer(local, { ...success, leave: false }), "editing");
  assert.equal(stayed.draft.name, "实际名字"); assert.equal(stayed.original, stayed.draft);
  const failed = at(agentEditorReducer(local, { type: "save-failed", operationId: "save-1", message: "拒绝" }), "editing");
  assert.equal(failed.draft, local.draft); assert.equal(failed.error, "拒绝");
  const retry = agentEditorReducer(failed, { type: "save-started", operationId: "save-2" });
  assert.equal(agentEditorReducer(retry, success), retry);
  assert.equal(agentEditorReducer(retry, { type: "save-failed", operationId: "save-1", message: "旧失败" }), retry);
});

test("H1 H2 H3 删除检查失败、阻止与确认取消均保留本地输入", () => {
  const local = checking();
  assert.equal(agentEditorReducer(local, { type: "delete-checked", operationId: "old", name: "旧", reasons: [] }), local);
  const failed = at(agentEditorReducer(local, { type: "delete-check-failed", operationId: "check-1", message: "失败" }), "editing");
  assert.equal(failed.draft, local.draft); assert.equal(failed.error, "失败");
  const blocked = at(agentEditorReducer(local, { type: "delete-checked", operationId: "check-1", name: "新", reasons: blockers }), "delete-blocked");
  assert.deepEqual(blocked.reasons, blockers);
  for (const sheet of [blocked, confirming()]) {
    const dismissed = at(agentEditorReducer(sheet, { type: "close-delete" }), "editing");
    assert.equal(dismissed.draft, local.draft === sheet.draft ? local.draft : sheet.draft);
    assert.equal(dismissed.error, "");
  }
});

test("H4 H5 T3 删除明确失败留层、最终 409 阻止、成功关闭，仅当前操作有效", () => {
  const local = deleting();
  for (const event of [
    { type: "delete-succeeded", operationId: "old" }, { type: "delete-failed", operationId: "old", message: "旧" },
    { type: "delete-conflict", operationId: "old", reasons: blockers },
  ] satisfies AgentEditorEvent[]) assert.equal(agentEditorReducer(local, event), local);
  const failed = at(agentEditorReducer(local, { type: "delete-failed", operationId: "delete-1", message: "拒绝" }), "delete-confirm");
  assert.equal(failed.name, "最新名字"); assert.equal(failed.error, "拒绝"); assert.equal(failed.draft, local.draft);
  const retry = agentEditorReducer(failed, { type: "delete-started", operationId: "delete-2" });
  assert.equal(agentEditorReducer(retry, { type: "delete-succeeded", operationId: "delete-1" }), retry);
  assert.equal(agentEditorReducer(retry, { type: "delete-succeeded", operationId: "delete-2" }).status, "closed");
  assert.deepEqual(at(agentEditorReducer(local, { type: "delete-conflict", operationId: "delete-1", reasons: blockers }), "delete-blocked").reasons, blockers);
});

test("B3 H4 closed 和不匹配的本地阶段拒绝命令与迟到应答", () => {
  const events: AgentEditorEvent[] = [
    { type: "change", fields: { name: "不应变化" } }, { type: "panel", panel: "skills" },
    { type: "save-started", operationId: "other" }, { type: "delete-started", operationId: "other" },
    { type: "delete-check-started", operationId: "other" }, { type: "close-delete" },
  ];
  for (const event of events) assert.equal(agentEditorReducer(closed, event), closed);
  for (const local of [loading, saving(), checking(), deleting()]) {
    for (const event of events) assert.equal(agentEditorReducer(local, event), local);
  }
  const recovery = selectAgentEditorAdoption(saving(), external({ outcome: outcome({ value: detail, reconciled: true }) }))!;
  assert.equal(agentEditorReducer(closed, recovery), closed);
});

test("B2 C6 E5 保存校验只约束本次写入，优先可行动字段", () => {
  const valid = { ...baseline, mcp_servers: [], searchable_mcp_servers: [] };
  const context = { creating: false, offline: false, fastModeSupported: true, patch: {}, connectors: undefined };
  assert.equal(validateAgentSave(baseline, context), null);
  assert.equal(validateAgentSave(valid, { ...context, creating: true }), null);
  assert.equal(validateAgentSave({ ...valid, name: "", system_prompt: "" }, context)?.panel, "main");
  assert.equal(validateAgentSave({ ...valid, system_prompt: "", description: "" }, context)?.panel, "prompt");
  assert.equal(validateAgentSave({ ...valid, description: "" }, context)?.panel, "main");
  assert.equal(validateAgentSave(valid, { ...context, offline: true })?.panel, "main");
  assert.equal(validateAgentSave({ ...baseline, fast_mode: true }, { ...context, fastModeSupported: false }), null);
  assert.ok(validateAgentSave(baseline, { ...context, fastModeSupported: false, patch: { fast_mode: false } }));
  assert.equal(validateAgentSave(baseline, { ...context, patch: { mcp_servers: ["secret"] } })?.panel, "connectors");
});

test("A1 T2 反馈按未知、本次错误、面板读取错误、已采纳提示排序", () => {
  assert.equal(agentEditorFeedback(selectAgentEditor(saving(), external({ outcome: outcome() })), { agent: true })?.title, "结果未确认，恢复连接后会核对");
  assert.equal(agentEditorFeedback(selectAgentEditor(loading, external({ outcome: outcome() })))?.title, "上次保存结果未确认，正在核对。");
  const local = { ...editing(), notice: "not-saved" as const };
  assert.equal(agentEditorFeedback(selectAgentEditor({ ...local, error: "拒绝" }, external()), { agent: true })?.title, "拒绝");
  assert.equal(agentEditorFeedback(selectAgentEditor(local, external()), { skills: true })?.title, "上次修改未保存。");
  assert.equal(agentEditorFeedback(selectAgentEditor({ ...local, panel: "skills" }, external()), { skills: true })?.title, "无法加载技能，正在重试…");
  const changed = agentEditorReducer(local, { type: "change", fields: { name: "本轮" } });
  assert.equal(agentEditorFeedback(selectAgentEditor(changed, external())), null);
});
