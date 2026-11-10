import { skipToken } from "@tanstack/react-query";
import { Redirect, router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useReducer, useRef, useState, useSyncExternalStore } from "react";

import { AgentEditorView } from "@/components/agent-editor-view.tsx";
import { AgentEditorLeaveBoundary, type AgentEditorLeaveControl } from "@/components/editor-leave-sheet.tsx";
import { ModelPicker } from "@/components/model-picker.tsx";
import { GatewayError } from "@/gateway/api.ts";
import { newClientId, type ChatSession } from "@/gateway/session.ts";
import { useAgentCapabilities } from "@/lib/agent-capabilities.ts";
import { agentEditorFeedback, agentEditorMemberNames, agentEditorReducer, blankAgentDraft, changedAgentFields, deletionConflictDetails, deletionReasons, draftFromAgent,
  prepareCreateCommand, selectAgentEditor, validateAgentSave, type AgentEditorExternal, type EditorPanel } from "@/lib/agent-editor.ts";
import { useConnectorListCatalog } from "@/lib/connector-catalog.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useExecutionEnvironmentCatalog } from "@/lib/execution-environment-catalog.ts";
import { agentDetailOptions, readAgentDeletionConstraints } from "@/lib/gateway-queries.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { useSession } from "@/lib/session-context.tsx";
import { useAgentCreationSettings } from "@/lib/settings-data.ts";
import { useSkillCatalog } from "@/lib/skill-catalog.ts";
import { useFocusedVisit } from "@/lib/use-focused-visit.ts";
import { useGatewayQuery } from "@/lib/use-gateway-query.ts";
import { userErrorMessage } from "@/lib/user-error.ts";

const fieldNames: Record<string, string> = { name: "名字", avatar: "头像", description: "说明", system_prompt: "提示词", model: "模型", reasoning_effort: "推理强度", fast_mode: "Fast", code_mode: "代码模式", environment: "执行环境", skills: "技能", workers: "团队成员", mcp_servers: "连接器", searchable_mcp_servers: "连接器" };

export default function AgentEditorRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <AgentEditor session={session} id={id} />;
}

/** Exported scene entry shares the same session/id remount boundary as the production route. */
export function AgentEditor({ session, id }: { session: ChatSession; id?: string }) {
  return <AgentEditorContainer key={`${session.queryIdentity}:${id ?? "new"}`} session={session} id={id} />;
}

/** Focus owns navigation rights; the destination acknowledges the expected owner, never mount/unmount cleanup. */
function AgentEditorOutcomeNavigation({ session, id, gone, handoffOperationId, handoffResourceId, receivedOperationId }: {
  session: ChatSession; id?: string; gone: boolean; handoffOperationId?: string; handoffResourceId?: string; receivedOperationId?: string;
}) {
  useFocusEffect(useCallback(() => {
    if (gone) { router.dismissTo("/"); return; }
    if (!id && handoffOperationId && handoffResourceId) {
      const creation = session.editorOperations.get("agent:new");
      if (creation?.operationId === handoffOperationId && creation.reconciled && creation.id === handoffResourceId
        && !session.agents.deletedIds.has(handoffResourceId)) router.setParams({ id: handoffResourceId });
    } else if (id && receivedOperationId) {
      session.editorOperations.handoffCreation("agent", receivedOperationId, id);
    }
  }, [gone, id, handoffOperationId, handoffResourceId, receivedOperationId, session]));
  return null;
}

function AgentEditorContainer({ session, id }: { session: ChatSession; id?: string }) {
  useSyncExternalStore(session.subscribe, session.getVersion);
  const [state, dispatch] = useReducer(agentEditorReducer, { status: "loading", sessionId: session.queryIdentity, resourceId: id ?? "new" });
  const [memberQuery, setMemberQuery] = useState("");
  const captureVisit = useFocusedVisit();
  const navigation = useNavigation();
  const operationKey = `agent:${id ?? "new"}`;
  const outcome = session.editorOperations.get(operationKey);
  const [attachedCreationId] = useState(() => !id && (outcome?.status === "pending" || outcome?.status === "unknown") ? outcome.operationId : undefined);
  const leaveControl = useRef<AgentEditorLeaveControl>(null);
  const offline = session.connection !== "open";
  const read = useGatewayQuery(id ? agentDetailOptions(session, id) : skipToken);
  const defaults = useAgentCreationSettings(id ? null : session);
  const skills = useSkillCatalog(session);
  const connectors = useConnectorListCatalog(session);
  const capabilityCatalog = useAgentCapabilities(session, id);
  const { catalog, loading: catalogLoading, error: catalogError } = useModelCatalog(session);
  const environmentCatalog = useExecutionEnvironmentCatalog(session);
  const agents = session.agents.agents;
  const deleted = !!id && read.error instanceof GatewayError && read.error.status === 404;
  const external: AgentEditorExternal = {
    sessionId: session.queryIdentity, resourceId: id ?? "new", offline, deleted, deletedIds: session.agents.deletedIds, outcome, attachedCreationId,
    initial: state.status !== "loading" ? undefined : id && read.isFetchedAfterMount && read.isSuccess && read.data
      ? { draft: draftFromAgent(read.data), resourceId: read.data.id }
      : !id && defaults.data && session.agents.loaded ? { draft: blankAgentDraft(defaults.data, agents), resourceId: "new" } : undefined,
  };
  const selection = selectAgentEditor(state, external);
  const { draft, panel } = selection;
  const fields = "original" in state ? changedAgentFields(state.original, state.draft) : {};
  const changes = [...new Set(Object.keys(fields).map((key) => fieldNames[key]))];

  // Navigation observes external facts, never consumes them in mount/unmount cleanup.
  const handoffOperationId = selection.handoff?.operationId;
  const handoffResourceId = selection.handoff?.resourceId;
  const gone = selection.phase === "gone";

  // These two pure, source-checked adoptions converge in one transition; ordinary snapshots never overwrite edits.
  if (selection.adoption) dispatch(selection.adoption);

  function currentSelection() {
    return selectAgentEditor(state, { ...external, offline: session.connection !== "open",
      outcome: session.editorOperations.get(operationKey) });
  }

  async function save(): Promise<boolean> {
    if (!currentSelection().canSave || state.status !== "editing") return false;
    const { draft, original } = state;
    const patch = changedAgentFields(original, draft);
    if (id && !Object.keys(patch).length) return true;
    const fastSupported = catalog?.capabilities?.fast_mode === true;
    const problem = validateAgentSave(draft, { creating: !id, offline, fastModeSupported: fastSupported,
      patch, connectors: connectors.data?.connectors });
    if (problem) { dispatch({ type: "validation-failed", ...problem }); return false; }
    const operationId = newClientId();
    const stillHere = captureVisit();
    dispatch({ type: "save-started", operationId });
    if (id && patch.environment !== undefined) session.cleanupResults.begin(operationId, "switch", id, stillHere, navigation);
    try {
      // Submitted fields remain solely for outcome comparison; no Agent draft survives page removal.
      const command = id ? null : prepareCreateCommand(draft, newClientId(), fastSupported);
      const result = await session.editorOperations.run(operationKey, { operationId, resource: "agent", id, action: "save",
        clientId: command?.clientId, fields: command?.fields ?? patch, baseline: id ? original : undefined },
      () => id ? session.api.updateAgent(id, patch) : session.api.createAgent(command!.clientId, command!.fields));
      if (!result) { session.cleanupResults.reject(operationId); dispatch({ type: "save-failed", operationId, message: "保存未完成" }); return false; }
      session.connectorChanged(result.event);
      if (!result.event || !id) session.agents.refresh();
      const canLeave = stillHere() && currentSelection().phase !== "gone";
      if (canLeave && patch.environment !== undefined) session.cleanupResults.confirm(operationId, result.event);
      dispatch({ type: "save-succeeded", operationId, current: result.agent, leave: canLeave });
      return canLeave;
    } catch (error) {
      const settled = session.editorOperations.get(operationKey);
      if (settled?.operationId !== operationId || !settled.reconciled && settled.status !== "unknown") {
        session.cleanupResults.reject(operationId);
        const duplicateName = error instanceof GatewayError && error.code === "agent_name_conflict";
        dispatch({ type: "save-failed", operationId, field: duplicateName ? "name" : undefined,
          message: duplicateName ? "已有同名 Agent" : userErrorMessage(error, "保存未完成") });
      }
      return false;
    }
  }

  const requestDeletion = async () => {
    if (!id || !currentSelection().canDeleteCheck) return;
    const operationId = newClientId();
    const stillHere = captureVisit();
    dispatch({ type: "delete-check-started", operationId });
    try {
      const current = await readAgentDeletionConstraints(session, id);
      if (!stillHere()) { dispatch({ type: "delete-check-failed", operationId, message: "" }); return; }
      const reasons = deletionReasons({ member_of: current.member_of.map(id => ({ id, name: id })) });
      dispatch({ type: "delete-checked", operationId, name: current.name, reasons });
    } catch (error) { dispatch({ type: "delete-check-failed", operationId, message: userErrorMessage(error, "无法检查删除条件，请重试") }); }
  };
  const remove = async () => {
    if (!id || !currentSelection().canDelete) return;
    const operationId = newClientId();
    session.cleanupResults.begin(operationId, "delete-agent", id, captureVisit(), navigation);
    dispatch({ type: "delete-started", operationId });
    try {
      const result = await session.editorOperations.run(operationKey, { operationId, resource: "agent", id, action: "delete" }, () => session.api.deleteAgent(id));
      if (!result) { session.cleanupResults.reject(operationId); dispatch({ type: "delete-failed", operationId, message: "删除未完成，请重新加载后重试" }); return; }
      session.connectorChanged(result.event);
      dispatch({ type: "delete-succeeded", operationId });
    } catch (error) {
      const settled = session.editorOperations.get(operationKey);
      if (settled?.operationId === operationId && (settled.status === "unknown" || settled.reconciled)) return;
      session.cleanupResults.reject(operationId);
      if (error instanceof GatewayError && error.status === 409) {
        const reasons = deletionReasons(deletionConflictDetails(error.details));
        dispatch({ type: "delete-conflict", operationId, reasons: reasons.length ? reasons : [{ kind: "other", title: "现在不能删除", description: error.message }] });
      } else dispatch({ type: "delete-failed", operationId, message: userErrorMessage(error, "删除未完成，请重新加载后重试") });
    }
  };
  const openPanel = (next: EditorPanel) => {
    if (!(next === "main" ? currentSelection().canFinishPanel : currentSelection().canChangePanel)) return;
    if (next === "skills") void skills.refresh();
    if (next === "connectors") void connectors.refresh();
    if (next === "environment" && !environmentCatalog.loading) environmentCatalog.refresh();
    dispatch({ type: "panel", panel: next });
  };
  const feedback = agentEditorFeedback(selection, {
    agent: read.error || defaults.error, model: catalogError, environment: environmentCatalog.error,
    skills: skills.error, connectors: connectors.error, members: session.agents.error, capabilities: capabilityCatalog.error,
  });
  return <>
    <Stack.Screen options={{ headerShown: false, gestureEnabled: !selection.busy }} />
    <AgentEditorOutcomeNavigation session={session} id={id} gone={gone} handoffOperationId={handoffOperationId}
      handoffResourceId={handoffResourceId} receivedOperationId={id && outcome?.reconciled ? outcome.operationId : undefined} />
    <AgentEditorView selection={selection} id={id} offline={offline} feedback={feedback}
      agents={agents} referencesLoaded={session.agents.loaded} referenceError={session.agents.error} memberQuery={memberQuery}
      memberNames={agentEditorMemberNames(session.agents, state)}
      catalog={catalog} catalogLoading={catalogLoading} skillCatalog={skills}
      connectorCatalog={{ connectors: connectors.data?.connectors ?? [], loaded: connectors.data !== undefined, error: connectors.error, fetchStatus: connectors.fetchStatus }}
      capabilityCatalog={capabilityCatalog} environments={environmentCatalog.environments} environmentsLoading={environmentCatalog.loading} environmentsError={environmentCatalog.error}
      connectionBanner={<ConnectionBanner session={session} />}
      modelPicker={draft && panel === "model" ? <ModelPicker session={session} model={draft.model} reasoningEffort={draft.reasoning_effort}
        disabled={!selection.canEdit} onChange={fields => { if (currentSelection().canEdit) dispatch({ type: "change", fields }); }} /> : null}
      onSave={() => void leaveControl.current?.submit()} onBack={() => leaveControl.current?.back()}
      onChange={fields => { if (currentSelection().canEdit) dispatch({ type: "change", fields }); }} onPanel={openPanel} onMemberQuery={setMemberQuery}
      onDeleteCheck={requestDeletion} onDelete={remove} onCloseDelete={() => { if (currentSelection().deleteDialog) dispatch({ type: "close-delete" }); }}
      onCapabilities={() => { if (id && currentSelection().canReadCapabilities) router.push({ pathname: "/agent-capabilities", params: { id } }); }} />
    <AgentEditorLeaveBoundary key={selection.leaveIdentity} ref={leaveControl} selection={selection}
      changes={changes} save={save} confirmEnvironment={!!id && fields.environment !== undefined} onMain={() => openPanel("main")} />
  </>;
}
