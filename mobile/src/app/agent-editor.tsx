import { Redirect, router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, Clock3, Monitor, Search, Users, X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, View } from "react-native";
import { KeyboardAwareScrollView, KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EditorRow, SelectionRow } from "@/components/agent-editor-controls.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ModelPicker, ReasoningPicker } from "@/components/model-picker.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { AVATAR_COUNT, WandrunAvatar } from "@/components/wandrun-avatar.tsx";
import { type AgentDetail, type AgentSummary, GatewayError } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { useAgentCapabilities } from "@/lib/agent-capabilities.ts";
import { blankAgentDraft, changedAgentFields, createResultUnknown, deletionConflictDetails, deletionReasons, draftFromAgent, prepareCreateCommand, toggleSelection, validateAgentName, type AgentDraft, type CreateCommand, type DeletionReason } from "@/lib/agent-editor.ts";
import { selectConnector, validateConnectorSelection } from "@/lib/agent-connectors.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { useConnectorCatalog } from "@/lib/connector-catalog.ts";
import { connectorAuthLabel, connectorStatus } from "@/lib/connectors.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { modelName, selectedModel } from "@/lib/model-selection.ts";
import { useSkillCatalog } from "@/lib/skill-catalog.ts";
import { selectableSkills } from "@/lib/skills.ts";
import { useSession } from "@/lib/session-context.tsx";
import { cn } from "@/lib/utils.ts";
import { userErrorMessage } from "@/lib/user-error.ts";

type Panel = "main" | "avatar" | "prompt" | "model" | "skills" | "members" | "connectors";

export default function AgentEditorRoute() {
  const { id, section } = useLocalSearchParams<{ id?: string; section?: string }>();
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <AgentEditor key={`${id ?? "new"}:${section ?? ""}`} session={session} id={id} memberOnly={section === "members" && !!id} />;
}

function AgentEditor({ session, id, memberOnly }: { session: ChatSession; id?: string; memberOnly: boolean }) {
  const { t, language } = useTranslation();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [original, setOriginal] = useState<AgentDraft | null>(null);
  const [panel, setPanel] = useState<Panel>(memberOnly ? "members" : "main");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [retryLoad, setRetryLoad] = useState(0);
  const [referenceError, setReferenceError] = useState("");
  const [referenceRetry, setReferenceRetry] = useState(0);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const skillCatalog = useSkillCatalog(session);
  const capabilityCatalog = useAgentCapabilities(session, id);
  const [memberQuery, setMemberQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [nameError, setNameError] = useState("");
  const [deleteDialog, setDeleteDialog] = useState<"confirm" | "blocked" | null>(null);
  const [deleteReasons, setDeleteReasons] = useState<DeletionReason[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [createUnknown, setCreateUnknown] = useState(false);
  const createCommand = useRef<CreateCommand | null>(null);
  const operation = useRef(false);
  const focused = useRef(false);
  const mounted = useRef(false);
  const navigationEpoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const isFocused = useIsFocused();
  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => { focused.current = false; navigationEpoch.current++; };
  }, []));
  const insets = useSafeAreaInsets();
  const connectorCatalog = useConnectorCatalog(session);
  const { refresh: refreshConnectors } = connectorCatalog;
  useEffect(() => {
    if (panel === "connectors" && isFocused) refreshConnectors();
  }, [panel, isFocused, refreshConnectors]);
  const { refresh: refreshSkills } = skillCatalog;
  useEffect(() => {
    if (panel === "skills" && isFocused) refreshSkills();
  }, [panel, isFocused, refreshSkills]);

  const deleted = !!id && session.agents.deletedIds.has(id);
  useEffect(() => { if (deleted) router.dismissTo("/"); }, [deleted]);
  useEffect(() => {
    if (!isFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (operation.current) return true;
      if (panel !== "main" && !memberOnly) { setPanel("main"); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [isFocused, panel, memberOnly]);

  useEffect(() => {
    let active = true;
    const load = id
      ? session.api.getAgent(id).then((value) => {
        if (!active) return;
        setDetail(value);
        const fields = draftFromAgent(value);
        setOriginal(fields);
        setDraft(fields);
      })
      : Promise.all([session.api.getSettings(), session.api.listAgents()]).then(([settings, listed]) => {
        if (!active) return;
        setAgents(listed.agents);
        setDraft(blankAgentDraft(settings, listed.agents));
      });
    void load.then(() => { if (active) setLoading(false); }, (error: unknown) => {
      if (active) { setLoadError(userErrorMessage(error, "无法加载 Agent，请重试")); setLoading(false); }
    });
    return () => { active = false; };
  }, [session, id, retryLoad]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    void session.api.listAgents().then(
      ({ agents: listed }) => { if (active) { setAgents(listed); setReferenceError(""); } },
      (error: unknown) => { if (active) setReferenceError(userErrorMessage(error, "无法加载 Agent 列表，请重试")); },
    );
    return () => { active = false; };
  }, [session, id, referenceRetry]);



  const back = () => {
    if (operation.current) return;
    if (panel !== "main" && !memberOnly) { setPanel("main"); return; }
    router.back();
  };
  const change = (fields: Partial<AgentDraft>) => {
    if (operation.current || createUnknown || createdId) return;
    setDraft((current) => current ? { ...current, ...fields } : current);
    setSaveError("");
    setNameError("");
  };
  const openChat = async (agentId: string, epoch: number) => {
    if (!focused.current || navigationEpoch.current !== epoch) return;
    try {
      const conversationId = await session.blankConversation(agentId);
      if (!focused.current || navigationEpoch.current !== epoch) return;
      // The completed creation flow must not remain underneath the new conversation.
      router.dismissTo("/");
      router.push({ pathname: "/c/[id]", params: { id: conversationId } });
    } catch (error) {
      if (mounted.current) setSaveError(t("Agent 已创建，但打开聊天失败：{error}。点“进入聊天”重试。", { error: t(userErrorMessage(error, "请检查连接")) }));
    }
  };
  const save = async () => {
    if (!draft || operation.current) return;
    const epoch = navigationEpoch.current;
    if (createdId) {
      operation.current = true;
      setSaving(true);
      try { await openChat(createdId, epoch); }
      finally { operation.current = false; if (mounted.current) setSaving(false); }
      return;
    }
    const invalidName = memberOnly ? null : validateAgentName(draft.name);
    if (invalidName) { setNameError(invalidName); setPanel("main"); return; }
    const patch = original ? changedAgentFields(original, draft) : null;
    if (!memberOnly && !createCommand.current) {
      if (!draft.system_prompt.trim()) {
        setSaveError("请填写 Agent 提示词");
        setPanel("prompt");
        return;
      }
      if (!draft.description.trim()) {
        setSaveError("请填写 Agent 说明");
        setPanel("main");
        return;
      }
    }
    if (!memberOnly && !createCommand.current && (!id || patch?.mcp_servers !== undefined || patch?.searchable_mcp_servers !== undefined)) {
      const hasSelection = draft.mcp_servers.length + draft.searchable_mcp_servers.length > 0;
      const invalid = hasSelection && !connectorCatalog.loaded
        ? "连接器目录尚未加载，请重试后保存"
        : validateConnectorSelection(draft, connectorCatalog.connectors);
      if (invalid) { setSaveError(invalid); setPanel("connectors"); return; }
    }
    if (id && (!patch || (memberOnly ? patch.workers === undefined : Object.keys(patch).length === 0))) {
      router.back();
      return;
    }
    operation.current = true;
    setSaving(true);
    setSaveError("");
    try {
      if (id) {
        const result = await session.api.updateAgent(id, memberOnly ? { workers: draft.workers } : patch!);
        session.connectorChanged(result.event);
        if (!result.event) session.agents.refresh();
        if (focused.current && navigationEpoch.current === epoch && !session.agents.deletedIds.has(id)) router.back();
      } else {
        // An unreadable success response or unexpected exception leaves the result unknown.
        const command = createCommand.current ?? prepareCreateCommand(draft, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`, null);
        createCommand.current = command;
        const result = await session.api.createAgent(command.clientId, command.fields);
        session.connectorChanged(result.event);
        createCommand.current = null;
        if (mounted.current) {
          setCreatedId(result.agent.id);
          setCreateUnknown(false);
        }
        await openChat(result.agent.id, epoch);
      }
    } catch (error) {
      if (!id) {
        const unknown = createResultUnknown(error, createUnknown);
        if (!unknown) createCommand.current = null;
        if (mounted.current) setCreateUnknown(unknown);
      }
      if (mounted.current) setSaveError(userErrorMessage(error, "保存未完成，请重试当前操作或重新加载核对结果"));
    } finally {
      operation.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const requestDeletion = async () => {
    if (!id || operation.current) return;
    const epoch = navigationEpoch.current;
    operation.current = true;
    setDeleting(true);
    setSaveError("");
    try {
      // Membership can change elsewhere while this draft remains open. Refresh only the read-only constraints.
      const current = await session.api.getAgent(id);
      if (!focused.current || navigationEpoch.current !== epoch || session.agents.deletedIds.has(id)) return;
      setDetail(current);
      const known = deletionReasons({ member_of: current.member_of.map((memberId) => ({ id: memberId, name: agentDisplayName(session.agents, memberId, agents.find((agent) => agent.id === memberId)?.name) })) });
      setDeleteReasons(known);
      setDeleteError("");
      setDeleteDialog(known.length ? "blocked" : "confirm");
    } catch (error) {
      if (mounted.current) setSaveError(userErrorMessage(error, "无法检查删除条件，请重试"));
    } finally {
      operation.current = false;
      if (mounted.current) setDeleting(false);
    }
  };
  const remove = async () => {
    if (!id || operation.current) return;
    const epoch = navigationEpoch.current;
    operation.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      const result = await session.api.deleteAgent(id);
      session.agents.observe(result.event);
      if (mounted.current) setDeleteDialog(null);
      if (focused.current && navigationEpoch.current === epoch) router.dismissTo("/");
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof GatewayError && error.status === 409) {
        const reasons = deletionReasons(deletionConflictDetails(error.details));
        setDeleteReasons(reasons.length ? reasons : [{ kind: "other", title: "现在不能删除", description: error.message }]);
        setDeleteDialog("blocked");
      } else {
        setDeleteError(userErrorMessage(error, "删除未完成，请重新加载后重试"));
      }
    } finally {
      operation.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  const title = memberOnly ? t("团队成员") : panel === "main" ? id ? t("编辑 Agent") : t("新建 Agent") :
    t(({ avatar: "更换头像", prompt: "提示词", model: "模型", skills: "技能", members: "团队成员", connectors: "连接器" } as const)[panel]);
  const done = panel === "main" || memberOnly ? save : () => { setPanel("main"); };
  const actionLabel = createdId ? t("进入聊天") : memberOnly ? t("完成") : panel === "main" ? id ? t("保存") : t("创建") : t("完成");
  const draftLocked = saving || deleting || createUnknown || !!createdId;
  const { catalog } = useModelCatalog(session.api, false);
  const currentModel = draft ? selectedModel(catalog?.models ?? [], draft.model) : undefined;
  const availableSkills = draft ? selectableSkills(skillCatalog.skills, draft.skills) : [];
  const members = agents.filter((agent) => agent.id !== id && (`${agent.name} ${agent.description}`).toLowerCase().includes(memberQuery.trim().toLowerCase()));

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false, gestureEnabled: !saving && !deleting }} />
      <ScreenBar title={title} subtitle={panel === "prompt" ? agentDisplayName(undefined, id, draft?.name) : undefined} left={<Button testID="editor-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={panel === "main" ? t("取消") : t("返回")} onPress={back}>
        <Icon as={panel === "main" && !memberOnly ? X : ChevronLeft} className="size-[22px]" />
      </Button>} right={draft && !loading ? <Button testID={panel === "main" || memberOnly ? "editor-save" : "editor-done"} variant="outline" size="sm" className="h-8 border-foreground bg-background" disabled={saving || deleting} onPress={() => void done()}><Text>{saving ? t("请稍候…") : actionLabel}</Text></Button> : null} />
      <ConnectionBanner session={session} />
      {createUnknown ? <Text className="mx-6 my-2 text-sm text-destructive">{t("创建结果尚未确认。请点“创建”用同一次命令重试；确认结果前不能修改字段。")}</Text> : null}
      {saveError ? <Text testID="editor-error" className="mx-6 my-2 text-sm text-destructive">{t(saveError)}</Text> : null}
      {loading ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载 Agent…")}</Text> : loadError || !draft ? (
        <View className="mx-6 mt-10 items-center gap-3"><Text className="text-sm text-destructive">{t(loadError || "无法加载 Agent")}</Text><Button variant="outline" onPress={() => { setLoading(true); setLoadError(""); setRetryLoad((value) => value + 1); }}><Text>{t("重试")}</Text></Button></View>
      ) : panel === "prompt" ? (
        <KeyboardAvoidingView behavior="padding" className="flex-1">
          <View className="flex-1 gap-2 px-4 pt-2" style={{ paddingBottom: insets.bottom + 12 }}>
            <Textarea testID="editor-prompt-input" accessibilityLabel={t("提示词")} editable={!draftLocked} value={draft.system_prompt} onChangeText={(system_prompt) => change({ system_prompt })}
              className="flex-1 border-0 bg-muted px-3.5 py-3 font-mono text-[13px] leading-[21px]" />
            <Text className="mx-3 text-xs leading-[17px] text-muted-foreground">{t("提示词决定职责和做事方式，修改从下一轮生效。")}</Text>
          </View>
        </KeyboardAvoidingView>
      ) : panel === "main" ? (
        <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
          {id ? <View className="items-center gap-1.5 pb-3 pt-2">
            <Pressable testID="editor-avatar" accessibilityLabel={t("更换头像")} disabled={draftLocked} onPress={() => setPanel("avatar")}>
              <WandrunAvatar index={draft.avatar} alt={draft.name || "Agent"} size={76} className="border border-border" />
            </Pressable>
            <Button variant="ghost" size="sm" className="h-8 bg-transparent" disabled={draftLocked} onPress={() => setPanel("avatar")}><Text className="text-sm text-muted-foreground">{t("更换头像")}</Text></Button>
          </View> : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentOffset={{ x: Math.max(0, draft.avatar - 3) * 72, y: 0 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 20, paddingVertical: 14 }}>
            {Array.from({ length: AVATAR_COUNT }, (_, index) => <Pressable key={index} testID={`editor-avatar-${index + 1}`} accessibilityRole="radio"
              accessibilityState={{ selected: draft.avatar === index, disabled: draftLocked }} accessibilityLabel={t(draft.avatar === index ? "头像 {number}，已选" : "头像 {number}", { number: index + 1 })}
              disabled={draftLocked} onPress={() => change({ avatar: index })} className={cn("rounded-full border-2 p-0.5", draft.avatar === index ? "border-foreground" : "border-transparent")}>
              <WandrunAvatar index={index} alt={t("头像 {number}", { number: index + 1 })} size={52} className="border border-border" />
            </Pressable>)}
          </ScrollView>}
          <ListGroup>
            <View className="min-h-[52px] flex-row items-center gap-3 px-4">
              <Text className={cn("text-sm text-muted-foreground", language === "en" ? "min-w-24 shrink-0" : "w-11")}>{t("名字")}</Text><Input testID="editor-name" accessibilityLabel={t("名字")} editable={!draftLocked} value={draft.name} onChangeText={(name) => change({ name })} autoCorrect={false} className="min-h-[48px] flex-1 border-0 bg-transparent px-0" />
            </View>
            <View className="min-h-[52px] flex-row items-center gap-3 px-4">
              <Text className={cn("text-sm text-muted-foreground", language === "en" ? "min-w-24 shrink-0" : "w-11")}>{t("说明")}</Text><Input testID="editor-description" accessibilityLabel={t("说明")} editable={!draftLocked} value={draft.description} onChangeText={(description) => change({ description })} className="min-h-[48px] flex-1 border-0 bg-transparent px-0" />
            </View>
            <Pressable testID="editor-prompt" accessibilityRole="button" accessibilityLabel={t("提示词")} disabled={draftLocked} onPress={() => setPanel("prompt")} className="gap-1 px-4 py-3 active:bg-muted">
              <View className="flex-row items-center"><Text className="flex-1 text-[15px]">{t("提示词")}</Text><Icon as={ChevronRight} className="size-[18px] text-muted-foreground" /></View>
              <Text numberOfLines={2} className="text-sm leading-5 text-muted-foreground">{draft.system_prompt || t("填写职责和做事方式")}</Text>
            </Pressable>
          </ListGroup>
          {nameError ? <Text className="mx-8 mt-1 text-sm text-destructive">{t(nameError)}</Text> : null}
          <ListGroup label={t("模型")}>
            <EditorRow testID="editor-model" label={t("模型")} value={draft.model ? modelName(catalog?.models ?? [], draft.model) : t("沿用默认模型")} onPress={draftLocked ? undefined : () => setPanel("model")} />
            <View className="min-h-[52px] gap-2 px-4 py-2">
              <Text className="text-[15px]">{t("推理强度")}</Text>
              <ReasoningPicker model={currentModel} effort={draft.reasoning_effort} onChange={(reasoning_effort) => change({ reasoning_effort })}
                disabled={draftLocked || !catalog} testIDPrefix="editor-reasoning" />
              {!currentModel && draft.reasoning_effort !== null ? <Text className="text-xs text-muted-foreground">{t("当前强度为 {effort}；目录不可用时保持原值。", { effort: draft.reasoning_effort })}</Text> : null}
            </View>
          </ListGroup>
          <ListGroup label={t("能力")}>
            <View className="min-h-[72px] flex-row items-center gap-3 px-4 py-2.5">
              <View className="min-w-0 flex-1">
                <Text className="text-[15px]">{t("代码模式")}</Text>
                <Text className="text-xs leading-[18px] text-muted-foreground">{t("用脚本批量调用工具、处理文件，只把结果交给模型。")}</Text>
              </View>
              <Switch testID="editor-code-mode" accessibilityLabel={t("代码模式")} checked={draft.code_mode}
                disabled={draftLocked} onCheckedChange={(code_mode) => change({ code_mode })} />
            </View>
            <EditorRow testID="editor-skills" label={t("技能")} value={draft.skills.join("、") || t("无")} onPress={draftLocked ? undefined : () => setPanel("skills")} />
            <EditorRow testID="editor-connectors" label={t("连接器")} value={[...draft.mcp_servers, ...draft.searchable_mcp_servers].map((connectorId) => connectorCatalog.connectors.find((item) => item.id === connectorId)?.name ?? connectorId).join("、") || t("无")} onPress={draftLocked ? undefined : () => setPanel("connectors")} />
            <EditorRow testID="editor-members" label={t("团队成员")} value={draft.workers.map((worker) => agentDisplayName(session.agents, worker, agents.find((agent) => agent.id === worker)?.name)).join("、") || t("无")} onPress={draftLocked ? undefined : () => setPanel("members")} />
            {id ? <EditorRow testID="editor-system-capabilities" label={t("系统能力")}
              value={capabilityCatalog.capabilities ? t("{count} 项已启用", { count: capabilityCatalog.capabilities.filter((item) => item.status === "enabled").length }) : capabilityCatalog.error ? t("无法加载") : t("加载中")}
              onPress={() => router.push({ pathname: "/agent-capabilities", params: { id } })} /> : null}
          </ListGroup>
          {id ? <Text className="mx-8 mt-3 text-xs leading-[17px] text-muted-foreground">{t("修改会影响直接对话及所在团队，进行中的工作从下一轮生效。")}</Text> : null}
          {id ? <Button testID="editor-delete" variant="ghost" className="mt-3 self-center bg-transparent" disabled={saving || deleting} onPress={() => void requestDeletion()}><Text className="font-normal text-destructive">{t("删除 Agent")}</Text></Button> : null}
        </KeyboardAwareScrollView>
      ) : panel === "model" ? (
        <ModelPicker api={session.api} model={draft.model} reasoningEffort={draft.reasoning_effort}
          disabled={draftLocked} onChange={({ model, reasoning_effort }) => change({ model, reasoning_effort })} />
      ) : (
        <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          {panel === "avatar" && <>
            <View className="mx-4 mt-4 flex-row flex-wrap justify-center gap-4">
              {Array.from({ length: AVATAR_COUNT }, (_, index) => index).map((index) => (
                <Pressable key={index} testID={`editor-avatar-${index + 1}`} accessibilityRole="radio" accessibilityState={{ selected: draft.avatar === index, disabled: draftLocked }} accessibilityLabel={t(draft.avatar === index ? "头像 {number}，已选" : "头像 {number}", { number: index + 1 })}
                  disabled={draftLocked} onPress={() => change({ avatar: index })} className={cn("rounded-full border-2 p-0.5", draft.avatar === index ? "border-foreground" : "border-transparent")}
                ><WandrunAvatar index={index} alt={t("头像 {number}", { number: index + 1 })} size={52} className="border border-border" /></Pressable>
              ))}
            </View>
          </>}
          {panel === "connectors" && <>
            <Text className="mx-6 mb-3 mt-2 text-sm leading-5 text-muted-foreground">{t("直接携带：从首次请求起加载全部工具；按需搜索：找到后才加载。")}</Text>
            <ListGroup>{connectorCatalog.connectors.map((connector) => {
              const direct = draft.mcp_servers.includes(connector.id);
              const searched = draft.searchable_mcp_servers.includes(connector.id);
              const selected = direct || searched;
              const status = connectorStatus(connector);
              return <View key={connector.id}>
                <SelectionRow testID={`editor-connector-${connector.id}`} label={connector.name}
                  subtitle={`${connectorAuthLabel(connector)} · ${t(status.label)} · ${t("{count} 个工具", { count: connector.tool_count })}${connector.pending_restart ? ` · ${t("参数待重启生效")}` : ""}`}
                  selected={selected} disabled={draftLocked} onPress={() => change(selectConnector(draft, connector.id, selected ? null : "direct"))} />
                {selected ? <View className="gap-2 px-4 pb-3">
                  <View className={cn("flex-row gap-2", language === "en" && "flex-wrap")}>
                    <Button testID={`editor-connector-direct-${connector.id}`} variant="outline" size="sm"
                      accessibilityRole="radio" accessibilityState={{ selected: direct }} disabled={draftLocked}
                      className={cn(language === "en" ? "grow shrink-0 basis-auto" : "flex-1", direct ? "border-foreground bg-muted" : "border-border bg-background")}
                      onPress={() => change(selectConnector(draft, connector.id, "direct"))}><Text>{t("直接携带")}</Text></Button>
                    <Button testID={`editor-connector-search-${connector.id}`} variant="outline" size="sm"
                      accessibilityRole="radio" accessibilityState={{ selected: searched }} disabled={draftLocked || !connector.description.trim()}
                      className={cn(language === "en" ? "grow shrink-0 basis-auto" : "flex-1", searched ? "border-foreground bg-muted" : "border-border bg-background")}
                      onPress={() => change(selectConnector(draft, connector.id, "search"))}><Text>{t("按需搜索")}</Text></Button>
                  </View>
                  {!connector.description.trim() ? <Text className="text-xs leading-[17px] text-muted-foreground">{t("按需搜索需填写说明，请在设置 › 连接器中补充。")}</Text> : null}
                </View> : null}
              </View>;
            })}</ListGroup>
            {[...draft.mcp_servers, ...draft.searchable_mcp_servers].filter((connectorId) => connectorCatalog.loaded && !connectorCatalog.connectors.some((item) => item.id === connectorId)).map((connectorId) =>
              <ListGroup key={connectorId}><SelectionRow testID={`editor-connector-${connectorId}`} label={connectorId} subtitle={t("连接器已不可用，请取消勾选")} selected disabled={draftLocked} onPress={() => change(selectConnector(draft, connectorId, null))} /></ListGroup>)}
            {!connectorCatalog.loaded && !connectorCatalog.error ? <Text className="mx-8 mt-3 text-sm text-muted-foreground">{t("正在加载连接器…")}</Text> : null}
            {connectorCatalog.loaded && !connectorCatalog.connectors.length ? <Text className="mx-8 mt-3 text-sm text-muted-foreground">{t("暂无连接器，请在设置 › 连接器添加。")}</Text> : null}
            {connectorCatalog.error ? <View className="mx-6 mt-3 gap-2"><Text className="text-sm text-destructive">{t(connectorCatalog.error)}</Text><Button variant="outline" onPress={connectorCatalog.refresh}><Text>{t("重试")}</Text></Button></View> : null}
          </>}
          {panel === "skills" && <>
            <Text className="mx-6 mb-3 mt-2 text-sm text-muted-foreground">{t("选择 Agent 可用的技能；无法加载的技能不能新选，已选的可取消。")}</Text>
            <ListGroup>{availableSkills.map(({ skill, removableOnly }) => <SelectionRow key={skill.name} testID={`editor-skill-${skill.name}`} label={skill.name}
              subtitle={removableOnly ? t("无法加载：{error} · 仅可取消勾选", { error: t(skill.error || "当前技能不可用") }) : skill.description}
              selected={draft.skills.includes(skill.name)} disabled={draftLocked}
              onPress={() => change({ skills: toggleSelection(draft.skills, skill.name) })} />)}</ListGroup>
            {availableSkills.length === 0 && !skillCatalog.error ? <Text className="mx-8 mt-3 text-sm text-muted-foreground">{t("没有可用技能")}</Text> : null}
            {skillCatalog.error ? <View className="mx-6 mt-3 gap-2"><Text className="text-sm text-destructive">{t(skillCatalog.error)}</Text><Button variant="outline" size="sm" onPress={refreshSkills}><Text>{t("重试")}</Text></Button></View> : null}
          </>}
          {panel === "members" && <>
            <Text className="mx-6 mb-3 mt-2 text-sm leading-5 text-muted-foreground">{t("成员可接收{name}委派的工作，按各自设置运行。", { name: draft.name || t("它") })}</Text>
            <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-[12px] border border-input px-3">
              <Icon as={Search} className="size-[18px] text-muted-foreground" />
              <Input testID="editor-member-search" value={memberQuery} editable={!draftLocked} onChangeText={setMemberQuery} placeholder={t("搜索 Agent")} accessibilityLabel={t("搜索 Agent")} className="flex-1 border-0 bg-transparent px-0" />
            </View>
            <ListGroup label={t("成员 · {count}", { count: draft.workers.length })}>
              {members.filter((agent) => draft.workers.includes(agent.id)).map((agent) => <SelectionRow key={agent.id} testID={`editor-member-${agent.id}`} label={agent.name} subtitle={agent.description} selected disabled={draftLocked} onPress={() => change({ workers: toggleSelection(draft.workers, agent.id) })}
                leading={<WandrunAvatar index={agent.avatar} alt={agent.name} size={40} />} />)}
              {draft.workers.filter((worker) => worker !== id && !agents.some((agent) => agent.id === worker) && worker.toLowerCase().includes(memberQuery.trim().toLowerCase())).map((worker) => (
                <SelectionRow key={worker} testID={`editor-member-${worker}`} label={worker} subtitle={t("成员资料暂不可用")} selected disabled={draftLocked} onPress={() => change({ workers: toggleSelection(draft.workers, worker) })} />
              ))}
            </ListGroup>
            <ListGroup label={t("其他")}>
              {members.filter((agent) => !draft.workers.includes(agent.id)).map((agent) => <SelectionRow key={agent.id} testID={`editor-member-${agent.id}`} label={agent.name} subtitle={agent.description} selected={false} disabled={draftLocked} onPress={() => change({ workers: toggleSelection(draft.workers, agent.id) })}
                leading={<WandrunAvatar index={agent.avatar} alt={agent.name} size={40} />} />)}
            </ListGroup>
            {referenceError ? <View className="mx-6 mt-3 gap-2"><Text className="text-sm text-destructive">{t(referenceError)}</Text><Button variant="outline" size="sm" onPress={() => setReferenceRetry((value) => value + 1)}><Text>{t("重新加载")}</Text></Button></View> : null}
          </>}
        </KeyboardAwareScrollView>
      )}
      <AlertDialog open={deleteDialog !== null} onOpenChange={(open) => { if (!open && !operation.current) setDeleteDialog(null); }}>
        <AlertDialogContent overlayClassName="justify-end p-0" className="w-full rounded-b-none rounded-t-[24px] border-border bg-card" style={{ paddingBottom: insets.bottom + 20 }}>
          <View className="h-1 w-9 self-center rounded-full bg-border" />
          {deleteDialog === "blocked" ? <>
            <AlertDialogHeader><AlertDialogTitle>{t("现在不能删除")}</AlertDialogTitle></AlertDialogHeader>
            <View>{deleteReasons.map((reason, index) => (
              <View key={reason.kind} className={cn("flex-row gap-3 py-3", index > 0 && "border-t border-border")}>
                <Icon as={reason.kind === "members" ? Users : reason.kind === "work" ? Clock3 : Monitor} className="mt-0.5 size-[22px]" />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-[15px] font-semibold">{t(reason.title)}</Text>
                  <Text className="text-sm leading-5 text-muted-foreground">{t(reason.description)}</Text>
                </View>
              </View>
            ))}</View>
            <Button testID="editor-delete-blocked-ack" variant="outline" className="border-foreground bg-card" onPress={() => setDeleteDialog(null)}><Text>{t("知道了")}</Text></Button>
          </> : <>
            <AlertDialogHeader><AlertDialogTitle>{t("删除{name}？", { name: detail?.name ?? "" })}</AlertDialogTitle>
              <AlertDialogDescription>{t("它的对话、定时和记忆会一并删除，无法恢复；团队成员和对话中的文件保留。")}</AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? <Text testID="editor-delete-error" className="text-sm text-destructive">{t(deleteError)}</Text> : null}
            <AlertDialogFooter className="flex-col-reverse gap-2">
              <AlertDialogCancel testID="editor-delete-cancel" disabled={deleting} className="border-foreground bg-card"><Text>{t("取消")}</Text></AlertDialogCancel>
              <Button testID="editor-delete-confirm" variant="outline" disabled={deleting} className="border-destructive bg-card" onPress={() => void remove()}><Text className="text-destructive">{deleting ? t("删除中…") : t("删除")}</Text></Button>
            </AlertDialogFooter>
          </>}
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}
