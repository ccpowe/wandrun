import { type AgentDeleteConflictDetails, type AgentDetail, type AgentEditableFields, type AgentSummary, type Connector, type ModelSettings } from "../gateway/api.ts";
import type { AgentList } from "../gateway/agents.ts";
import type { EditorOperation } from "../gateway/editor-operation.ts";
import { t } from "./i18n.ts";
import { validateConnectorSelection } from "./agent-connectors.ts";
import { agentDisplayName } from "./agent-display-name.ts";

export type AgentDraft = AgentEditableFields & { mcp_servers: string[]; searchable_mcp_servers: string[] };
export type CreateCommand = { clientId: string; fields: Omit<AgentDraft, "model" | "fast_mode"> & { model?: string; fast_mode?: boolean } };

/** Build one explicit creation attempt; unknown outcomes are reconciled by the session, never replayed. */
export function prepareCreateCommand(draft: AgentDraft, clientId: string, fastModeSupported = false): CreateCommand {
  const { model, fast_mode, ...fields } = draft;
  return { clientId, fields: { ...fields, name: draft.name.trim(), ...(model ? { model } : {}), ...(fastModeSupported ? { fast_mode } : {}), skills: [...draft.skills], workers: [...draft.workers],
    mcp_servers: [...draft.mcp_servers], searchable_mcp_servers: [...draft.searchable_mcp_servers] } };
}


export function blankAgentDraft(settings: ModelSettings, agents: Pick<AgentSummary, "avatar">[]): AgentDraft {
  return {
    name: "", avatar: leastUsedAvatar(agents), description: "", system_prompt: "",
    model: settings.default_model ?? "", reasoning_effort: settings.default_reasoning_effort,
    fast_mode: false, code_mode: true, environment: "local", skills: [], workers: [], mcp_servers: [], searchable_mcp_servers: [],
  };
}

/** Mirror the gateway's display-name boundary, counting Unicode characters rather than UTF-16 units. */
export function validateAgentName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t("请填写 Agent 名字");
  if (Array.from(trimmed).length > 64 || /[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u.test(trimmed)) return t("名字必须是单行且不超过 64 个字符");
  return null;
}

/** Only mobile-editable fields participate in PATCH; arrays compare by sequence (their order is significant). */
export function draftFromAgent(agent: AgentDetail): AgentDraft {
  return {
    name: agent.name, avatar: agent.avatar, description: agent.description,
    system_prompt: agent.system_prompt, model: agent.model, reasoning_effort: agent.reasoning_effort,
    fast_mode: agent.fast_mode === true, code_mode: agent.code_mode, environment: agent.environment,
    skills: [...agent.skills], workers: [...agent.workers],
    mcp_servers: [...agent.mcp_servers], searchable_mcp_servers: [...agent.searchable_mcp_servers],
  };
}

export function changedAgentFields(before: AgentDraft, after: AgentDraft): Partial<AgentEditableFields> {
  const patch: Partial<AgentEditableFields> = {};
  for (const key of ["name", "avatar", "description", "system_prompt", "model", "reasoning_effort", "fast_mode", "code_mode", "environment"] as const) {
    if (before[key] !== after[key]) (patch as Record<string, unknown>)[key] = key === "name" ? after.name.trim() : after[key];
  }
  for (const key of ["skills", "workers", "mcp_servers", "searchable_mcp_servers"] as const) {
    if (before[key].length !== after[key].length || before[key].some((item, index) => item !== after[key][index])) patch[key] = after[key];
  }
  return patch;
}

/** Preselect the least-used of the eight bundled avatars; ties choose the smallest number. */
export function leastUsedAvatar(agents: Pick<AgentSummary, "avatar">[]): number {
  const counts = Array<number>(8).fill(0);
  for (const agent of agents) {
    if (Number.isInteger(agent.avatar) && agent.avatar >= 0 && agent.avatar < 8) counts[agent.avatar]++;
  }
  return counts.indexOf(Math.min(...counts));
}


export function toggleSelection(items: readonly string[], item: string): string[] {
  return items.includes(item) ? items.filter((value) => value !== item) : [...items, item];
}

/** Present each gateway deletion constraint as its own reason in the blocked sheet. */
export type DeletionReason = { kind: "members" | "work" | "other"; title: string; description: string; members?: { id: string; name: string }[] };
const memberRemovalDescription = (names: string[]) =>
  t("{names}。先在它们的“团队成员”里移除它。", { names: names.join("、") });

/** Names are already resolved by the container; rendering never reparses deletion constraints. */
export function deletionReasonDescription(reason: DeletionReason, names: Record<string, string>): string {
  return reason.members ? memberRemovalDescription(reason.members.map(member => names[member.id] ?? member.name)) : reason.description;
}

export function deletionReasons(details: Partial<AgentDeleteConflictDetails>): DeletionReason[] {
  const reasons: DeletionReason[] = [];
  const members = details.member_of ?? [];
  if (members.length) reasons.push({
    kind: "members", title: t("它是 {count} 个团队的成员", { count: members.length }),
    members,
    description: memberRemovalDescription(members.map((member) => member.name)),
  });
  if ((details.running_conversations ?? 0) > 0) reasons.push({
    kind: "work", title: t("它正在工作"),
    description: t("有 {count} 个对话还在运行{tasks}。等它结束或先停止。", { count: details.running_conversations!, tasks: (details.running_tasks ?? 0) > 0 ? t("（{count} 个任务）", { count: details.running_tasks! }) : "" }),
  });
  else if ((details.running_tasks ?? 0) > 0) reasons.push({
    kind: "work", title: t("它正在工作"), description: t("有 {count} 个任务还在运行。等它结束或先停止。", { count: details.running_tasks! }),
  });
  return reasons;
}

export function deletionConflictDetails(value: unknown): Partial<AgentDeleteConflictDetails> {
  if (!value || typeof value !== "object") return {};
  const details = value as Record<string, unknown>;
  const member_of = Array.isArray(details.member_of)
    ? details.member_of.filter((member): member is { id: string; name: string } => !!member && typeof member === "object" && typeof member.name === "string" && typeof member.id === "string")
    : [];
  return {
    member_of,
    running_conversations: typeof details.running_conversations === "number" ? details.running_conversations : 0,
    running_tasks: typeof details.running_tasks === "number" ? details.running_tasks : 0,
  };
}

export type EditorPanel = "main" | "avatar" | "prompt" | "model" | "skills" | "members" | "connectors" | "environment";
export type AgentReconciliationNotice = "" | "confirmed" | "synced" | "not-saved" | "changed";

/** Describes the current snapshot, not historical proof that a mismatching command never ran. */
export function agentReconciliationNotice(current: AgentDraft, confirmed: boolean, baseline?: Record<string, unknown>): AgentReconciliationNotice {
  if (confirmed) return "confirmed";
  if (!baseline) return "synced";
  return Object.entries(baseline).every(([field, value]) => JSON.stringify(current[field as keyof AgentDraft]) === JSON.stringify(value))
    ? "not-saved" : "changed";
}

export type AgentEditorIdentity = Readonly<{ sessionId: string; resourceId: string }>;
type EditorForm = AgentEditorIdentity & {
  original: AgentDraft;
  draft: AgentDraft;
  panel: EditorPanel;
  notice: AgentReconciliationNotice;
  adoptedRecoveryId?: string;
};
export type AgentEditorState =
  | (AgentEditorIdentity & { status: "loading" })
  | (EditorForm & { status: "editing"; error: string; errorField?: "name" })
  | (EditorForm & { status: "saving"; operationId: string })
  | (EditorForm & { status: "checking-delete"; operationId: string })
  | (EditorForm & { status: "delete-confirm"; name: string; error: string })
  | (EditorForm & { status: "deleting"; name: string; operationId: string })
  | (EditorForm & { status: "delete-blocked"; reasons: DeletionReason[] })
  | (EditorForm & { status: "closed" });

type InitialAdoption = AgentEditorIdentity & {
  type: "adopt-initial"; draft: AgentDraft; notice: AgentReconciliationNotice; seenRecoveryId?: string;
};
type RecoveryAdoption = AgentEditorIdentity & {
  type: "adopt-recovery"; operationId: string; current: AgentDetail; confirmed: boolean; baseline?: Record<string, unknown>;
};
export type AgentEditorEvent =
  | InitialAdoption | RecoveryAdoption
  | { type: "change"; fields: Partial<AgentDraft> }
  | { type: "panel"; panel: EditorPanel }
  | { type: "validation-failed"; message: string; panel?: EditorPanel }
  | { type: "save-started" | "delete-check-started" | "delete-started"; operationId: string }
  | { type: "save-succeeded"; operationId: string; current: AgentDetail; leave: boolean }
  | { type: "delete-succeeded"; operationId: string }
  | { type: "save-failed" | "delete-check-failed" | "delete-failed"; operationId: string; message: string; field?: "name" }
  | { type: "delete-checked"; operationId: string; name: string; reasons: DeletionReason[] }
  | { type: "delete-conflict"; operationId: string; reasons: DeletionReason[] }
  | { type: "close-delete" };

function sameEditor(a: AgentEditorIdentity, b: AgentEditorIdentity): boolean {
  return a.sessionId === b.sessionId && a.resourceId === b.resourceId;
}
function formOf(state: EditorForm): EditorForm {
  const { sessionId, resourceId, original, draft, panel, notice, adoptedRecoveryId } = state;
  return { sessionId, resourceId, original, draft, panel, notice, adoptedRecoveryId };
}
function adoptRecovery(state: Extract<AgentEditorState, { draft: AgentDraft }>, event: RecoveryAdoption): AgentEditorState {
  if (!sameEditor(state, event) || event.current.id !== state.resourceId || event.operationId === state.adoptedRecoveryId
    || "operationId" in state && event.operationId !== state.operationId) return state;
  const original = draftFromAgent(event.current);
  return { ...formOf(state), status: "editing", original, draft: original, error: "",
    adoptedRecoveryId: event.operationId, notice: agentReconciliationNotice(original, event.confirmed, event.baseline) };
}

/** Local interaction only. External phases are projected; only named adoptions can establish a draft baseline. */
export function agentEditorReducer(state: AgentEditorState, event: AgentEditorEvent): AgentEditorState {
  switch (state.status) {
    case "loading":
      if (event.type !== "adopt-initial" || !sameEditor(state, event)) return state;
      return { ...state, status: "editing", original: event.draft, draft: event.draft, panel: "main",
        error: "", notice: event.notice, adoptedRecoveryId: event.seenRecoveryId };
    case "editing":
      switch (event.type) {
        case "adopt-recovery": return adoptRecovery(state, event);
        case "change": return { ...state, draft: { ...state.draft, ...event.fields }, notice: "",
          ...(state.errorField === "name" && event.fields.name === undefined ? {} : { error: "", errorField: undefined }) };
        case "panel": return { ...state, panel: event.panel };
        case "validation-failed": return { ...state, error: event.message, errorField: undefined, panel: event.panel ?? state.panel };
        case "save-started": return { ...formOf(state), status: "saving", operationId: event.operationId };
        case "delete-check-started": return { ...formOf(state), status: "checking-delete", operationId: event.operationId };
        default: return state;
      }
    case "saving":
      switch (event.type) {
        case "adopt-recovery": return adoptRecovery(state, event);
        case "save-succeeded": {
          if (event.operationId !== state.operationId) return state;
          if (event.leave) return { ...formOf(state), status: "closed" };
          const current = draftFromAgent(event.current);
          return { ...formOf(state), status: "editing", original: current, draft: current, error: "", notice: "" };
        }
        case "save-failed": return event.operationId === state.operationId
          ? { ...formOf(state), status: "editing", error: event.message, errorField: event.field,
            panel: event.field === "name" ? "main" : state.panel } : state;
        default: return state;
      }
    case "checking-delete":
      switch (event.type) {
        case "delete-checked":
          if (event.operationId !== state.operationId) return state;
          return event.reasons.length ? { ...formOf(state), status: "delete-blocked", reasons: event.reasons }
            : { ...formOf(state), status: "delete-confirm", name: event.name, error: "" };
        case "delete-check-failed": return event.operationId === state.operationId
          ? { ...formOf(state), status: "editing", error: event.message } : state;
        default: return state;
      }
    case "delete-confirm":
      switch (event.type) {
        case "adopt-recovery": return adoptRecovery(state, event);
        case "delete-started": return { ...formOf(state), name: state.name, status: "deleting", operationId: event.operationId };
        case "close-delete": return { ...formOf(state), status: "editing", error: "" };
        default: return state;
      }
    case "deleting":
      switch (event.type) {
        case "adopt-recovery": return adoptRecovery(state, event);
        case "delete-succeeded": return event.operationId === state.operationId
          ? { ...formOf(state), status: "closed" } : state;
        case "delete-failed": return event.operationId === state.operationId
          ? { ...formOf(state), status: "delete-confirm", name: state.name, error: event.message } : state;
        case "delete-conflict": return event.operationId === state.operationId
          ? { ...formOf(state), status: "delete-blocked", reasons: event.reasons } : state;
        default: return state;
      }
    case "delete-blocked":
      switch (event.type) {
        case "adopt-recovery": return adoptRecovery(state, event);
        case "close-delete": return { ...formOf(state), status: "editing", error: "" };
        default: return state;
      }
    case "closed": return state;
  }
}

export type AgentEditorExternal = AgentEditorIdentity & {
  offline: boolean;
  deleted: boolean;
  deletedIds?: ReadonlySet<string>;
  outcome?: Readonly<EditorOperation>;
  /** Only this visit's successful read; absence after adoption cannot revoke the form. */
  initial?: { draft: AgentDraft; resourceId: string };
  attachedCreationId?: string;
};

function matchingOutcome(local: AgentEditorState, external: AgentEditorExternal): Readonly<EditorOperation> | undefined {
  const outcome = external.outcome;
  return sameEditor(local, external) && outcome?.resource === "agent"
    && (local.resourceId === "new" ? outcome.operationId === external.attachedCreationId
      || "operationId" in local && outcome.operationId === local.operationId : outcome.id === local.resourceId)
    ? outcome : undefined;
}

/** A recovered creation's target can already have a tombstone before the new-route handoff. */
function agentEditorResourceGone(local: AgentEditorState, external: AgentEditorExternal, outcome: Readonly<EditorOperation> | undefined): boolean {
  return external.deleted || external.deletedIds?.has(local.resourceId) === true
    || outcome?.reconciled === true && (outcome.value === null || outcome.id !== undefined && external.deletedIds?.has(outcome.id) === true);
}

/** A successful initial adoption records an already-seen terminal id, so an older read-back cannot replace the new GET. */
export function selectAgentEditorAdoption(local: AgentEditorState, external: AgentEditorExternal): InitialAdoption | RecoveryAdoption | null {
  if (!sameEditor(local, external) || local.status === "closed") return null;
  const outcome = matchingOutcome(local, external);
  if (agentEditorResourceGone(local, external, outcome)) return null;
  if (local.status === "loading") {
    const initial = external.initial;
    if (!initial || initial.resourceId !== local.resourceId) return null;
    return { type: "adopt-initial", sessionId: local.sessionId, resourceId: local.resourceId, draft: initial.draft,
      seenRecoveryId: outcome?.reconciled ? outcome.operationId : undefined,
      notice: outcome?.reconciled ? agentReconciliationNotice(initial.draft, outcome.status === "confirmed", outcome.baseline) : "" };
  }
  if (!outcome?.reconciled || local.resourceId === "new" || local.status === "checking-delete"
    || outcome.operationId === local.adoptedRecoveryId
    || "operationId" in local && outcome.operationId !== local.operationId) return null;
  const current = outcome.value as AgentDetail | undefined;
  if (!current || current.id !== local.resourceId) return null;
  return { type: "adopt-recovery", sessionId: local.sessionId, resourceId: local.resourceId,
    operationId: outcome.operationId, current, confirmed: outcome.status === "confirmed", baseline: outcome.baseline };
}

export type AgentEditorSelection = {
  phase: AgentEditorState["status"] | "gone" | "unknown" | "pending" | "adopting";
  adoption: InitialAdoption | RecoveryAdoption | null;
  handoff: { operationId: string; resourceId: string } | null;
  busy: boolean; loading: boolean; draft: AgentDraft | null; panel: EditorPanel;
  canEdit: boolean; canSave: boolean; canDeleteCheck: boolean; canDelete: boolean;
  canBack: boolean; canChangePanel: boolean; canFinishPanel: boolean; canReadCapabilities: boolean;
  autoSaveOnLeave: boolean;
  leaveKind: "ordinary" | "unknown" | "none"; leaveIdentity: string; previousUnknown: boolean;
  saveError: string; nameError: string; notice: AgentReconciliationNotice;
  deleteDialog: "blocked" | "confirm" | null; deleteName: string; deleteReasons: DeletionReason[]; deleteError: string;
};
/** One conflict policy for fields, commands, navigation and all dialogs. Owner.run remains the final write admission. */
export function selectAgentEditor(local: AgentEditorState, external: AgentEditorExternal): AgentEditorSelection {
  const outcome = matchingOutcome(local, external);
  const gone = agentEditorResourceGone(local, external, outcome);
  const adoption = selectAgentEditorAdoption(local, external);
  const localBusy = local.status === "saving" || local.status === "deleting" || local.status === "checking-delete";
  const phase = gone ? "gone" : local.status === "closed" ? "closed" : outcome?.status === "unknown" ? "unknown"
    : adoption?.type === "adopt-recovery" ? "adopting" : outcome?.status === "pending" ? "pending" : local.status;
  const busy = !gone && phase !== "closed" && phase !== "unknown" && (localBusy || phase === "pending" || phase === "adopting");
  const editable = phase === "editing" && sameEditor(local, external);
  const handoff = !gone && phase !== "closed" && local.resourceId === "new" && outcome?.reconciled && outcome.id
    ? { operationId: outcome.operationId, resourceId: outcome.id } : null;
  const deleteDialog = phase === "delete-blocked" ? "blocked" : phase === "delete-confirm" || phase === "deleting" ? "confirm" : null;
  const canSave = editable && !external.offline;
  return {
    phase, adoption, handoff, busy, loading: local.status === "loading" && !gone,
    draft: "draft" in local ? local.draft : null, panel: "panel" in local ? local.panel : "main" as EditorPanel,
    canEdit: editable, canSave,
    canDeleteCheck: editable && local.resourceId !== "new" && !external.offline,
    canDelete: phase === "delete-confirm" && !external.offline,
    canBack: !busy && phase !== "gone" && phase !== "closed",
    canChangePanel: editable, canFinishPanel: !busy && phase !== "gone" && phase !== "closed",
    canReadCapabilities: phase !== "gone" && phase !== "closed" && local.resourceId !== "new",
    autoSaveOnLeave: canSave && local.resourceId !== "new" && local.status === "editing" && !local.error,
    leaveKind: phase === "unknown" ? "unknown" as const : phase === "gone" || phase === "closed" ? "none" as const : "ordinary" as const,
    leaveIdentity: phase === "unknown" ? `unknown:${outcome!.operationId}` : phase === "gone" ? phase
      : `ordinary:${"adoptedRecoveryId" in local ? local.adoptedRecoveryId ?? "" : ""}`,
    previousUnknown: phase === "unknown" && (!("operationId" in local) || local.operationId !== outcome!.operationId),
    saveError: phase === "editing" && local.status === "editing" && !local.errorField ? local.error : "",
    nameError: phase === "editing" && local.status === "editing" && local.errorField === "name" ? local.error : "",
    notice: "notice" in local ? local.notice : "",
    deleteDialog, deleteName: "name" in local ? local.name : "",
    deleteReasons: deleteDialog === "blocked" && local.status === "delete-blocked" ? local.reasons : [],
    deleteError: deleteDialog === "confirm" && local.status === "delete-confirm" ? local.error : "",
  };
}

/** Validate an attempted write; an unchanged existing form is not a write attempt. */
export function validateAgentSave(draft: AgentDraft, context: {
  creating: boolean; offline: boolean; fastModeSupported: boolean;
  patch: Partial<AgentEditableFields>; connectors: Pick<Connector, "id" | "name" | "description">[] | undefined;
}): { message: string; panel?: EditorPanel } | null {
  if (context.offline) return { message: "网络连接失败，未保存", panel: "main" };
  const nameError = validateAgentName(draft.name);
  if (nameError) return { message: nameError, panel: "main" };
  if ((context.creating ? draft.fast_mode : context.patch.fast_mode !== undefined) && !context.fastModeSupported) {
    return { message: "当前网关尚未确认支持 Fast，请更新网关并重新加载后再保存。" };
  }
  if (!draft.system_prompt.trim()) return { message: "请填写 Agent 提示词", panel: "prompt" };
  if (!draft.description.trim()) return { message: "请填写 Agent 说明", panel: "main" };
  if (context.creating || context.patch.mcp_servers !== undefined || context.patch.searchable_mcp_servers !== undefined) {
    const hasSelection = draft.mcp_servers.length + draft.searchable_mcp_servers.length > 0;
    const message = hasSelection && context.connectors === undefined ? "连接器目录尚未加载，请稍后保存"
      : validateConnectorSelection(draft, context.connectors ?? []);
    if (message) return { message, panel: "connectors" };
  }
  return null;
}

export type AgentEditorFeedback = Readonly<{ title: string; description?: string; persistent?: string }>;
export type AgentEditorReadErrors = Partial<Record<"agent" | "model" | "environment" | "skills" | "connectors" | "members" | "capabilities", unknown>>;
const outcomeFeedback = {
  unknown: { title: "结果未确认，恢复连接后会核对", description: "离开后本次修改不会保留，不会自动再次提交。", persistent: "unknown" },
  previous: { title: "上次保存结果未确认，正在核对。", description: "离开后本次修改不会保留，不会自动再次提交。", persistent: "previous" },
  confirmed: { title: "已核对，操作已完成。" },
  "not-saved": { title: "上次修改未保存。" },
  changed: { title: "内容已被修改，已同步服务器上的当前内容。" },
  synced: { title: "已核对服务器上的当前内容，请检查后再保存。" },
} satisfies Record<string, AgentEditorFeedback>;

/** One precedence for the live container and static view stories; values remain translation keys. */
export function agentEditorFeedback(selection: AgentEditorSelection, errors: AgentEditorReadErrors = {}): AgentEditorFeedback | null {
  if (selection.phase === "gone" || selection.phase === "closed") return null;
  if (selection.phase === "unknown") return outcomeFeedback[selection.previousUnknown ? "previous" : "unknown"];
  if (selection.saveError) return { title: selection.saveError };
  const { panel } = selection;
  const failure = errors.agent ? "无法加载 Agent，正在重试…" : errors.model ? "无法加载模型，正在重试…" :
    panel === "environment" && errors.environment ? "无法加载机器列表，正在重试…" :
    panel === "skills" && errors.skills ? "无法加载技能，正在重试…" :
    panel === "connectors" && errors.connectors ? "无法加载连接器，正在重试…" :
    panel === "members" && errors.members ? "无法加载成员，正在重试…" :
    panel === "main" && errors.capabilities ? "无法加载系统能力，正在重试…" : "";
  if (failure) return { title: failure, description: selection.draft ? "内容可能不是最新的" : undefined, persistent: errors.agent ? "agent" : errors.model ? "model" : panel };
  return selection.notice ? outcomeFeedback[selection.notice] : null;
}

/** One name projection for selected workers and team-deletion constraints, including late directories. */
export function agentEditorMemberNames(directory: Pick<AgentList, "agents" | "loaded" | "error" | "deletedIds">, state: AgentEditorState): Record<string, string> {
  const names: Record<string, string> = Object.create(null);
  for (const agent of directory.agents) names[agent.id] = agentDisplayName(undefined, agent.id, agent.name);
  if ("draft" in state) for (const id of state.draft.workers) {
    if (!Object.hasOwn(names, id)) names[id] = agentDisplayName(directory, id);
  }
  if (state.status === "delete-blocked") for (const reason of state.reasons) {
    for (const member of reason.members ?? []) {
      if (!Object.hasOwn(names, member.id)) names[member.id] = agentDisplayName(directory, member.id, member.name);
    }
  }
  return names;
}
