import { Redirect, router, Stack, useFocusEffect } from "expo-router";
import { CircleAlert } from "lucide-react-native";
import { useCallback, useReducer, useSyncExternalStore, type ReactNode } from "react";
import { BackHandler } from "react-native";

import { useEditorLeave } from "@/components/editor-leave-sheet.tsx";
import { ModelPicker } from "@/components/model-picker.tsx";
import { SettingsModelsView } from "@/components/settings-models-view.tsx";
import { StatusBanner } from "@/components/status-banner.tsx";
import { newClientId, type ChatSession } from "@/gateway/session.ts";
import { agentUsageView } from "@/lib/agent-usage-view.ts";
import { useConnectionLabel } from "@/lib/connection-banner.tsx";
import { agentUsageOptions, settingsOptions, subscriptionOptions } from "@/lib/gateway-queries.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { modelName, reasoningOptions, selectedModel } from "@/lib/model-selection.ts";
import { subscriptionView } from "@/lib/model-usage.ts";
import { useSession } from "@/lib/session-context.tsx";
import { modelSettingsOperationKey, modelSettingsReducer, selectModelSettings, type ModelSettingsSelection } from "@/lib/settings-models.ts";
import { useFocusedVisit } from "@/lib/use-focused-visit.ts";
import { useGatewayQuery } from "@/lib/use-gateway-query.ts";
import { useMinuteClock } from "@/lib/use-minute-clock.ts";
import { userErrorMessage } from "@/lib/user-error.ts";
import { useDelayedNotice } from "@/lib/use-delayed-notice.ts";

export default function SettingsModels() {
  const session = useSession();
  if (!session) return <Redirect href="/settings" />;
  return <ModelsScreen key={session.queryIdentity} session={session} />;
}

function ModelsScreen({ session }: { session: ChatSession }) {
  const { t, language } = useTranslation();
  useSyncExternalStore(session.subscribe, session.getVersion);
  const [state, dispatch] = useReducer(modelSettingsReducer, { status: "overview" });
  const captureVisit = useFocusedVisit();
  const now = useMinuteClock();
  const connectionLabel = useConnectionLabel(session);
  const outcome = session.editorOperations.get(modelSettingsOperationKey);
  const offline = session.connection !== "open";
  const selection = selectModelSettings(state, offline, outcome);
  const read = useGatewayQuery(settingsOptions(session));
  const settingsReady = read.data !== undefined && read.isFetchedAfterMount && read.isSuccess;
  const subscription = useGatewayQuery(subscriptionOptions(session));
  const usage = useGatewayQuery(agentUsageOptions(session));
  const { catalog, error: catalogError } = useModelCatalog(session);
  if (selection.adoption) dispatch(selection.adoption);

  const currentSelection = () => selectModelSettings(state, session.connection !== "open", session.editorOperations.get(modelSettingsOperationKey));
  async function save(): Promise<boolean> {
    const current = currentSelection();
    if (current.unknown || !current.dirty) return !current.busy;
    if (state.status !== "editing" || !current.canEdit) return false;
    if (session.connection !== "open" || !state.draft.default_model) {
      dispatch({ type: "rejected", message: session.connection !== "open" ? "网络连接失败，未保存" : "请选择默认模型" });
      return false;
    }
    const operationId = newClientId();
    const stillHere = captureVisit();
    dispatch({ type: "save-started", operationId });
    try {
      const result = await session.editorOperations.run(modelSettingsOperationKey, { operationId, resource: "settings", action: "save", fields: state.draft, baseline: state.original }, () => session.api.updateSettings(state.draft));
      if (!result) { dispatch({ type: "save-failed", operationId, message: "保存未完成" }); return false; }
      dispatch({ type: "save-succeeded", operationId, current: result });
      void read.refresh();
      return stillHere();
    } catch (error) {
      const settled = session.editorOperations.get(modelSettingsOperationKey);
      if (settled?.operationId === operationId && (settled.status === "unknown" || settled.reconciled)) return false;
      dispatch({ type: "save-failed", operationId, message: userErrorMessage(error, "保存未完成") });
      return false;
    }
  }
  const readFailures = [subscription.error ? t("登录状态") : "", read.error ? t("默认模型") : "",
    usage.error || session.agents.error ? t("用量") : "", catalogError ? t("模型目录") : ""].filter(Boolean);
  const readFailure = readFailures.length ? t("无法加载{items}，正在重试…", { items: readFailures.join(language === "en" ? ", " : "、") }) : "";
  const notice = selection.unknown ? t("结果未确认，恢复连接后会核对") : selection.notice ? t("已核对服务器上的当前内容，请检查后再保存。") : "";
  const readErrorIdentity = [subscription.error && "subscription", read.error && "settings", usage.error && "usage",
    session.agents.error && "agents", catalogError && "catalog"].filter(Boolean).join("|");
  const showReadError = useDelayedNotice(readErrorIdentity || null);
  const showUnknown = useDelayedNotice(selection.unknown ? "model-save" : null);
  const feedback = connectionLabel || (selection.unknown ? showUnknown ? notice : "" : readFailure ? showReadError ? readFailure : "" : notice);
  const stale = !!read.data || !!usage.data || !!subscription.data?.usage || !!catalog;
  const description = connectionLabel ? t("内容可能不是最新的") : selection.unknown ? t("可以直接离开，不会自动再次提交。") : readFailure && stale ? t("内容可能不是最新的") : undefined;
  const banner = feedback ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={feedback} description={description} /> : null;
  const model = selectedModel(catalog?.models ?? [], read.data?.default_model ?? "");
  const effort = read.data?.default_reasoning_effort ?? model?.default_reasoning_effort;
  const effortLabel = reasoningOptions(model).find(option => option.value === effort)?.label ?? effort;
  const defaultLabel = read.data ? `${read.data.default_model ? modelName(catalog?.models ?? [], read.data.default_model) : t("未设置")}${effortLabel ? ` · ${t(effortLabel)}` : ""}` : read.error ? t("暂不可用") : undefined;
  const close = () => {
    if (state.status === "saving" && currentSelection().unknown && outcome) dispatch({ type: "unknown-left", operationId: outcome.operationId });
    else dispatch({ type: "closed" });
  };
  const render = (back: () => void, submit: () => void) => <SettingsModelsView selection={selection} offline={offline} banner={banner}
    picker={selection.draft ? <ModelPicker session={session} model={selection.draft.default_model ?? ""} reasoningEffort={selection.draft.default_reasoning_effort}
      disabled={!selection.canEdit} onChange={({ model, reasoning_effort }) => { if (currentSelection().canEdit) dispatch({ type: "changed", fields: { default_model: model, default_reasoning_effort: reasoning_effort } }); }} /> : null}
    subscription={subscriptionView(subscription.data, offline || subscription.fetchStatus === "paused" || !!subscription.error)} subscriptionLoaded={subscription.data !== undefined || !!subscription.error} nowSeconds={now.getTime() / 1000}
    defaultLabel={defaultLabel} settingsLoaded={settingsReady} settingsPending={read.fetchStatus === "fetching" && !read.error}
    usage={agentUsageView(session.agents.loaded, session.agents.agents, usage.data ?? null, !!usage.error)}
    onBack={back} onSave={submit} onOpen={() => { if (settingsReady && read.data) dispatch({ type: "opened", current: read.data, seenRecoveryId: outcome?.reconciled ? outcome.operationId : undefined }); }} />;
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    {selection.panel ? <DefaultModelNavigation selection={selection} save={save} onClose={close}>{render}</DefaultModelNavigation>
      : render(() => router.back(), () => { void save(); })}
  </>;
}

/** Uses the existing autosave/native-removal boundary; no page-owned navigation or operation refs. */
function DefaultModelNavigation({ selection, save, onClose, children }: {
  selection: ModelSettingsSelection; save: () => Promise<boolean>; onClose(): void;
  children: (back: () => void, submit: () => void) => ReactNode;
}) {
  const leave = useEditorLeave(selection.dirty, selection.busy, onClose, selection.unknown, save, true);
  const back = () => leave.requestLocal(onClose);
  useFocusEffect(useCallback(() => {
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { leave.requestLocal(onClose); return true; });
    return () => listener.remove();
  }, [leave, onClose]));
  return children(back, () => { if (selection.canSave) leave.requestLocal(onClose); });
}
