import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, Monitor, Search, Users, X } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { KeyboardAwareScrollView, KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EditorRow, SelectionRow } from "./agent-editor-controls.tsx";
import { StatusBanner } from "./status-banner.tsx";
import { LoadingState } from "./loading-state.tsx";
import { ListGroup } from "./list-group.tsx";
import { FastModeToggle, ReasoningPicker } from "./model-picker.tsx";
import { ScreenBar } from "./screen-bar.tsx";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Input } from "./ui/input.tsx";
import { Text } from "./ui/text.tsx";
import { Switch } from "./ui/switch.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { AVATAR_COUNT, WandrunAvatar } from "./wandrun-avatar.tsx";
import type { AgentCapability, AgentSummary, Connector, ExecutionEnvironment, ModelCatalog, Skill } from "../gateway/api.ts";
import { deletionReasonDescription, toggleSelection, type AgentDraft, type AgentEditorFeedback, type AgentEditorSelection, type EditorPanel } from "../lib/agent-editor.ts";
import { selectConnector } from "../lib/agent-connectors.ts";
import { agentDisplayName } from "../lib/agent-display-name.ts";
import { connectorAuthLabel, connectorStatus } from "../lib/connectors.ts";
import { useTranslation } from "../lib/i18n.ts";
import { modelName, selectedModel } from "../lib/model-selection.ts";
import { selectableSkills } from "../lib/skills.ts";
import { cn } from "../lib/utils.ts";
import { useDelayedNotice } from "../lib/use-delayed-notice.ts";

/** Pure presentation seam: server snapshots/slots and semantic callbacks, never a session or API. */
export type AgentEditorViewProps = {
  selection: AgentEditorSelection; id?: string; offline: boolean;
  feedback: AgentEditorFeedback | null;
  agents: AgentSummary[]; referencesLoaded: boolean; referenceError: string | null;
  memberNames: Record<string, string>; memberQuery: string;
  catalog: ModelCatalog | null; catalogLoading: boolean;
  skillCatalog: { skills: Skill[]; loaded: boolean; error: unknown; fetchStatus: string };
  connectorCatalog: { connectors: Connector[]; loaded: boolean; error: unknown; fetchStatus: string };
  capabilityCatalog: { capabilities: AgentCapability[] | null; error: string };
  environments: ExecutionEnvironment[]; environmentsLoading: boolean; environmentsError: string;
  connectionBanner: ReactNode; modelPicker: ReactNode;
  onSave: () => void;
  onBack: () => void; onChange: (fields: Partial<AgentDraft>) => void;
  onPanel: (panel: EditorPanel) => void; onMemberQuery: (query: string) => void;
  onDeleteCheck: () => void; onDelete: () => void; onCloseDelete: () => void;
  onCapabilities: () => void;
};

export function AgentEditorView(props: AgentEditorViewProps) {
  const { t, language } = useTranslation();
  const insets = useSafeAreaInsets();
  const { selection, id, offline, feedback, agents, referencesLoaded, referenceError,
    memberNames, memberQuery, catalog, catalogLoading, skillCatalog, connectorCatalog, capabilityCatalog,
    environments, environmentsLoading, environmentsError } = props;
  const { draft, panel, deleteDialog, deleteReasons, deleteError } = selection;
  const showPersistent = useDelayedNotice(feedback?.persistent ? `${id ?? "new"}:${feedback.persistent}` : null);
  const loading = selection.loading;
  const saving = selection.phase === "saving";
  const deleting = selection.phase === "checking-delete" || selection.phase === "deleting";
  const draftLocked = !selection.canEdit;
  const fastModeSupported = catalog?.capabilities?.fast_mode === true;
  const fastModeDisabledReason = fastModeSupported ? undefined : t(catalogLoading
    ? "正在检查 Fast 支持…"
    : catalog ? "当前网关不支持 Fast，请更新网关。" : "无法确认 Fast 支持，请重新加载模型列表。");
  const currentModel = draft ? selectedModel(catalog?.models ?? [], draft.model) : undefined;
  const availableSkills = draft ? selectableSkills(skillCatalog.skills, draft.skills) : [];
  const environmentName = environments.find((item) => item.id === draft?.environment)?.name
    || t(environmentsLoading ? "正在加载机器名称…" : "机器名称不可用");
  const members = agents.filter((agent) => agent.id !== id && (`${agent.name} ${agent.description}`).toLowerCase().includes(memberQuery.trim().toLowerCase()));
  const title = panel === "main" ? id ? t("编辑 Agent") : t("新建 Agent") :
    t(({ avatar: "更换头像", prompt: "提示词", model: "模型", skills: "技能", members: "团队成员", connectors: "连接器", environment: "执行环境" } as const)[panel]);
  const done = panel === "main" ? props.onSave : () => props.onPanel("main");
  const actionLabel = panel === "main" ? id ? t("保存") : t("创建") : t("完成");
  const { onBack: back, onChange: change, onPanel: setPanel, onMemberQuery: setMemberQuery,
    onDeleteCheck: requestDeletion, onDelete: remove } = props;
  const openEnvironment = () => setPanel("environment");
  return (
    <View className="flex-1 bg-background">
      <ScreenBar title={title} subtitle={panel === "prompt" ? agentDisplayName(undefined, id, draft?.name) : undefined} left={<Button testID="editor-back" intent="quiet" size="icon" className="bg-card/0" disabled={!selection.canBack} accessibilityLabel={panel === "main" ? t("取消") : t("返回")} onPress={back}><Icon as={panel === "main" ? X : ChevronLeft} className="size-[22px]" /></Button>} right={draft && !loading ? <Button testID={panel === "main" ? "editor-save" : "editor-done"} intent="soft" size="sm" className="h-8 border-foreground bg-background" disabled={panel === "main" ? !selection.canSave : !selection.canFinishPanel} onPress={() => void done()}><Text>{saving ? t("请稍候…") : actionLabel}</Text></Button> : null} />
      {props.connectionBanner}
      {!offline && feedback && (!feedback.persistent || showPersistent) ? <StatusBanner icon={CircleAlert} accessibilityRole="alert" title={t(feedback.title)} description={feedback.description ? t(feedback.description) : undefined} /> : null}
      {loading && !draft ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载 Agent…")}</Text> : !draft ? null
      : panel === "prompt" ? (
        <KeyboardAvoidingView behavior="padding" className="flex-1">
          <View className="flex-1 gap-2 px-4 pt-2" style={{ paddingBottom: insets.bottom + 12 }}>
            <Textarea testID="editor-prompt-input" accessibilityLabel={t("提示词")} editable={!draftLocked} value={draft.system_prompt} onChangeText={(system_prompt) => change({ system_prompt })}
              className="flex-1 border-0 bg-muted px-3.5 py-3 font-mono text-[13px] leading-[21px]" />
            <Text className="mx-3 text-xs leading-[17px] text-muted-foreground">{t("修改从下一轮生效。")}</Text>
          </View>
        </KeyboardAvoidingView>
      ) : panel === "main" ? (
        <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 30 }}>
          {id ? <View className="items-center gap-1.5 pb-3 pt-2">
            <Pressable testID="editor-avatar" accessibilityLabel={t("更换头像")} disabled={draftLocked} onPress={() => setPanel("avatar")}>
              <WandrunAvatar index={draft.avatar} alt={draft.name || "Agent"} size={76} className="border border-border" />
            </Pressable>
            <Button  intent="quiet" size="sm" className="h-8 bg-card/0" disabled={draftLocked} onPress={() => setPanel("avatar")}><Text className="text-sm text-muted-foreground">{t("更换头像")}</Text></Button>
          </View> : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentOffset={{ x: Math.max(0, draft.avatar - 3) * 72, y: 0 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 20, paddingVertical: 14 }}>
            {Array.from({ length: AVATAR_COUNT }, (_, index) => <Pressable key={index} testID={`editor-avatar-${index + 1}`} accessibilityRole="radio"
              accessibilityState={{ selected: draft.avatar === index, disabled: draftLocked }} accessibilityLabel={t(draft.avatar === index ? "头像 {number}，已选" : "头像 {number}", { number: index + 1 })}
              disabled={draftLocked} onPress={() => change({ avatar: index })} className={cn("rounded-full border-2 p-0.5", draft.avatar === index ? "border-foreground" : "border-border/0")}>
              <WandrunAvatar index={index} alt={t("头像 {number}", { number: index + 1 })} size={52} className="border border-border" />
            </Pressable>)}
          </ScrollView>}
          <ListGroup>
            <View className="min-h-[52px] flex-row items-center gap-3 px-4">
              <Text className={cn("text-sm text-muted-foreground", language === "en" ? "min-w-24 shrink-0" : "w-11")}>{t("名字")}</Text><Input testID="editor-name" accessibilityLabel={t("名字")} editable={!draftLocked} value={draft.name} onChangeText={(name) => change({ name })} autoCorrect={false} className="min-h-[48px] flex-1 border-0 bg-card/0 px-0" />
            </View>
            {selection.nameError ? <Text testID="editor-name-error" accessibilityRole="alert" accessibilityLiveRegion="polite"
              variant="caption" className="px-4 pb-2 text-destructive">{t(selection.nameError)}</Text> : null}
            <View className="min-h-[52px] flex-row items-center gap-3 px-4">
              <Text className={cn("text-sm text-muted-foreground", language === "en" ? "min-w-24 shrink-0" : "w-11")}>{t("说明")}</Text><Input testID="editor-description" accessibilityLabel={t("说明")} editable={!draftLocked} value={draft.description} onChangeText={(description) => change({ description })} className="min-h-[48px] flex-1 border-0 bg-card/0 px-0" />
            </View>
            <Pressable testID="editor-prompt" accessibilityRole="button" accessibilityLabel={t("提示词")} disabled={draftLocked} onPress={() => setPanel("prompt")} className="gap-1 px-4 py-3 active:bg-muted">
              <View className="flex-row items-center"><Text className="flex-1 text-[15px]">{t("提示词")}</Text><Icon as={ChevronRight} className="size-[18px] text-muted-foreground" /></View>
              <Text numberOfLines={2} className="text-sm leading-5 text-muted-foreground">{draft.system_prompt || t("填写提示词")}</Text>
            </Pressable>
          </ListGroup>
          <ListGroup label={t("模型")}>
            <View className="min-h-[52px] flex-row items-center px-4 py-1">
              <Pressable testID="editor-model" accessibilityRole="button" accessibilityLabel={t("模型")}
                accessibilityState={{ disabled: draftLocked }} disabled={draftLocked} onPress={() => setPanel("model")}
                className="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 active:bg-muted">
                <Text className="text-[15px]">{t("模型")}</Text>
                <Text numberOfLines={1} className="min-w-0 flex-1 text-right text-sm text-muted-foreground">{draft.model ? modelName(catalog?.models ?? [], draft.model) : t("沿用默认模型")}</Text>
                <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" />
              </Pressable>
              <FastModeToggle enabled={draft.fast_mode} disabled={draftLocked || !fastModeSupported}
                disabledReason={fastModeDisabledReason} onChange={(fast_mode) => change({ fast_mode })} />
            </View>
            <View className="min-h-[52px] px-4 py-2">
              <ReasoningPicker model={currentModel} effort={draft.reasoning_effort} onChange={(reasoning_effort) => change({ reasoning_effort })}
                disabled={draftLocked || !catalog} testIDPrefix="editor-reasoning" />
            </View>
          </ListGroup>
          <ListGroup label={t("执行环境")}>
            <EditorRow testID="editor-environment" label={t("执行环境")}
              value={environmentName}
              description={t("旧文件不会自动迁移。")}
              onPress={draftLocked ? undefined : openEnvironment} />
          </ListGroup>
          {fastModeDisabledReason ? <Text testID="editor-fast-unavailable" className="mx-8 mt-2 text-xs leading-[17px] text-muted-foreground">{fastModeDisabledReason}</Text> : null}
          {draft.fast_mode && fastModeSupported ? <Text testID="editor-fast-note" accessibilityLiveRegion="polite" className="mx-8 mt-2 text-xs leading-[17px] text-muted-foreground">{t("Fast 已开启 · 请求优先处理，可能消耗更多订阅额度。")}</Text> : null}
          <ListGroup label={t("能力")}>
            <View className="min-h-[72px] flex-row items-center gap-3 px-4 py-2.5">
              <View className="min-w-0 flex-1">
                <Text className="text-[15px]">{t("代码模式")}</Text>
                <Text className="text-xs leading-[18px] text-muted-foreground">{t("脚本批量调用工具、处理文件，仅向模型返回结果。")}</Text>
              </View>
              <Switch testID="editor-code-mode" accessibilityLabel={t("代码模式")} checked={draft.code_mode}
                disabled={draftLocked} onCheckedChange={(code_mode) => change({ code_mode })} />
            </View>
            <EditorRow testID="editor-skills" label={t("技能")} value={draft.skills.join("、") || t("无")} onPress={draftLocked ? undefined : () => setPanel("skills")} />
            <EditorRow testID="editor-connectors" label={t("连接器")} value={[...draft.mcp_servers, ...draft.searchable_mcp_servers].map((connectorId) => connectorCatalog.connectors.find((item) => item.id === connectorId)?.name ?? connectorId).join("、") || t("无")} onPress={draftLocked ? undefined : () => setPanel("connectors")} />
            <EditorRow testID="editor-members" label={t("团队成员")} value={draft.workers.map((worker) => memberNames[worker] ?? worker).join("、") || t("无")} onPress={draftLocked ? undefined : () => setPanel("members")} />
            {id ? <EditorRow testID="editor-system-capabilities" label={t("系统能力")}
              value={capabilityCatalog.capabilities ? t("{count} 项已启用", { count: capabilityCatalog.capabilities.filter((item) => item.status === "enabled").length }) : capabilityCatalog.error ? t("无法加载") : t("加载中")}
              onPress={selection.canReadCapabilities ? props.onCapabilities : undefined} /> : null}
          </ListGroup>
          {id ? <Button testID="editor-delete" intent="quiet" className="mt-3 self-center bg-card/0" disabled={!selection.canDeleteCheck} onPress={() => void requestDeletion()}><Text className="font-normal text-destructive">{t("删除 Agent")}</Text></Button> : null}
        </KeyboardAwareScrollView>
      ) : panel === "model" ? (
        props.modelPicker
      ) : (
        <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          {panel === "avatar" && <>
            <View className="mx-4 mt-4 flex-row flex-wrap justify-center gap-4">
              {Array.from({ length: AVATAR_COUNT }, (_, index) => index).map((index) => (
                <Pressable key={index} testID={`editor-avatar-${index + 1}`} accessibilityRole="radio" accessibilityState={{ selected: draft.avatar === index, disabled: draftLocked }} accessibilityLabel={t(draft.avatar === index ? "头像 {number}，已选" : "头像 {number}", { number: index + 1 })}
                  disabled={draftLocked} onPress={() => change({ avatar: index })} className={cn("rounded-full border-2 p-0.5", draft.avatar === index ? "border-foreground" : "border-border/0")}
                ><WandrunAvatar index={index} alt={t("头像 {number}", { number: index + 1 })} size={52} className="border border-border" /></Pressable>
              ))}
            </View>
          </>}
          {panel === "environment" && <>
            <Text className="mx-6 mb-3 mt-2 text-sm leading-5 text-muted-foreground">{t("只选择已有机器；不会创建、删除或修改云机器。切换后旧文件不会自动迁移。")}</Text>
            <ListGroup>
              {environments.map((environment) => <SelectionRow key={environment.id} single
                testID={`editor-environment-${environment.id}`} label={environment.name}
                subtitle={environment.type === "instabox" ? `Instabox · ${environment.status ?? ""}` : undefined}
                selected={draft.environment === environment.id} disabled={draftLocked}
                onPress={() => change({ environment: environment.id })} />)}
              {!environments.some((item) => item.id === draft.environment) ? <SelectionRow single
                testID="editor-environment-current" label={environmentName} subtitle={t("当前选择；机器列表尚未确认此环境")}
                selected disabled onPress={() => change({ environment: draft.environment })} /> : null}
            </ListGroup>
            {environmentsLoading ? <Text testID="editor-environments-loading" className="mx-8 mt-3 text-sm text-muted-foreground">{t("正在加载 Instabox 机器…")}</Text> : null}
            {!environmentsLoading && !environmentsError && !environments.some((item) => item.type === "instabox")
              ? <Text testID="editor-environments-empty" className="mx-8 mt-3 text-sm text-muted-foreground">{t("没有已有的 Instabox 机器，仍可使用 Local。")}</Text> : null}
          </>}
          {panel === "connectors" && <>
            <Text className="mx-6 mb-3 mt-2 text-sm leading-5 text-muted-foreground">{t("直接携带从首次请求加载全部工具；按需搜索找到后才加载。")}</Text>
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
                    <Button testID={`editor-connector-direct-${connector.id}`} intent={direct ? "primary" : "soft"} size="sm"
                      accessibilityRole="radio" accessibilityState={{ selected: direct }} disabled={draftLocked}
                      className={language === "en" ? "grow shrink-0 basis-auto" : "flex-1"}
                      onPress={() => change(selectConnector(draft, connector.id, "direct"))}><Text>{t("直接携带")}</Text></Button>
                    <Button testID={`editor-connector-search-${connector.id}`} intent={searched ? "primary" : "soft"} size="sm"
                      accessibilityRole="radio" accessibilityState={{ selected: searched }} disabled={draftLocked || !connector.description.trim()}
                      className={language === "en" ? "grow shrink-0 basis-auto" : "flex-1"}
                      onPress={() => change(selectConnector(draft, connector.id, "search"))}><Text>{t("按需搜索")}</Text></Button>
                  </View>
                  {!connector.description.trim() ? <Text className="text-xs leading-[17px] text-muted-foreground">{t("按需搜索需填写说明，请在设置 › 连接器中补充。")}</Text> : null}
                </View> : null}
              </View>;
            })}</ListGroup>
            {[...draft.mcp_servers, ...draft.searchable_mcp_servers].filter((connectorId) => connectorCatalog.loaded && !connectorCatalog.connectors.some((item) => item.id === connectorId)).map((connectorId) =>
              <ListGroup key={connectorId}><SelectionRow testID={`editor-connector-${connectorId}`} label={connectorId} subtitle={t("连接器已不可用，请取消勾选")} selected disabled={draftLocked} onPress={() => change(selectConnector(draft, connectorId, null))} /></ListGroup>)}
            {!connectorCatalog.loaded && !connectorCatalog.error && connectorCatalog.fetchStatus !== "paused" ? <View className="mx-8 mt-3"><LoadingState /></View> : null}
            {connectorCatalog.loaded && connectorCatalog.fetchStatus !== "paused" && !connectorCatalog.error && !connectorCatalog.connectors.length ? <Text className="mx-8 mt-3 text-sm text-muted-foreground">{t("暂无连接器，请在设置 › 连接器添加。")}</Text> : null}
          </>}
          {panel === "skills" && <>
            <Text className="mx-6 mb-3 mt-2 text-sm text-muted-foreground">{t("无法加载的技能不能新选，已选的可取消。")}</Text>
            <ListGroup>{availableSkills.map(({ skill, removableOnly }) => <SelectionRow key={skill.name} testID={`editor-skill-${skill.name}`} label={skill.name}
              subtitle={removableOnly ? t("无法加载：{error} · 仅可取消勾选", { error: t(skill.error || "当前技能不可用") }) : skill.description}
              selected={draft.skills.includes(skill.name)} disabled={draftLocked}
              onPress={() => change({ skills: toggleSelection(draft.skills, skill.name) })} />)}</ListGroup>
            {!skillCatalog.loaded && !skillCatalog.error && skillCatalog.fetchStatus !== "paused" ? <View className="mx-8 mt-3"><LoadingState /></View> : null}
            {skillCatalog.loaded && skillCatalog.fetchStatus !== "paused" && availableSkills.length === 0 && !skillCatalog.error ? <Text className="mx-8 mt-3 text-sm text-muted-foreground">{t("没有可用技能")}</Text> : null}
          </>}
          {panel === "members" && <>
            <Text className="mx-6 mb-3 mt-2 text-sm leading-5 text-muted-foreground">{t("成员按各自设置运行。")}</Text>
            <View className="mx-4 mb-2 flex-row items-center gap-2 rounded-[12px] border border-input px-3">
              <Icon as={Search} className="size-[18px] text-muted-foreground" />
              <Input testID="editor-member-search" value={memberQuery} editable={!draftLocked} onChangeText={setMemberQuery} placeholder={t("搜索 Agent")} accessibilityLabel={t("搜索 Agent")} className="flex-1 border-0 bg-card/0 px-0" />
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
            {!referencesLoaded && !agents.length && !referenceError ? <Text className="mx-8 mt-3 text-sm text-muted-foreground">{t("正在加载成员…")}</Text> : null}
            {referencesLoaded && !members.length && !referenceError ? <Text className="mx-8 mt-3 text-sm text-muted-foreground">{t(memberQuery.trim() ? "没有匹配的 Agent" : "没有其他 Agent")}</Text> : null}
          </>}
        </KeyboardAwareScrollView>
      )}
      <AlertDialog open={deleteDialog !== null} onOpenChange={(open) => { if (!open && !deleting) props.onCloseDelete(); }}>
        <AlertDialogContent overlayClassName="justify-end p-0" className="w-full rounded-b-none rounded-t-[24px] border-border bg-card" style={{ paddingBottom: insets.bottom + 20 }}>
          <View className="h-1 w-9 self-center rounded-full bg-border" />
          {deleteDialog === "blocked" ? <>
            <AlertDialogHeader><AlertDialogTitle>{t("现在不能删除")}</AlertDialogTitle></AlertDialogHeader>
            <View>{deleteReasons.map((reason, index) => (
              <View key={reason.kind} className={cn("flex-row gap-3 py-3", index > 0 && "border-t border-border")}>
                <Icon as={reason.kind === "members" ? Users : Monitor} className="mt-0.5 size-[22px]" />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-[15px] font-semibold">{t(reason.title)}</Text>
                  <Text className="text-sm leading-5 text-muted-foreground">{t(deletionReasonDescription(reason, memberNames))}</Text>
                </View>
              </View>
            ))}</View>
            <Button testID="editor-delete-blocked-ack" intent="soft" className="border-foreground bg-card" onPress={props.onCloseDelete}><Text>{t("知道了")}</Text></Button>
          </> : <>
            <AlertDialogHeader><AlertDialogTitle>{t("删除{name}？", { name: selection.deleteName })}</AlertDialogTitle>
              <AlertDialogDescription>{t("它的对话、定时和工作记忆会一并删除，无法恢复；共享用户画像、团队成员和对话中的文件保留。")}</AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? <Text testID="editor-delete-error" className="text-sm text-destructive">{t(deleteError)}</Text> : null}
            <AlertDialogFooter className="flex-col-reverse gap-2">
              <AlertDialogCancel testID="editor-delete-cancel" disabled={deleting} className="border-foreground bg-card"><Text>{t("取消")}</Text></AlertDialogCancel>
              <Button testID="editor-delete-confirm" intent="soft" disabled={!selection.canDelete} className="border-destructive bg-card" onPress={() => void remove()}><Text className="text-destructive">{deleting ? t("删除中…") : t("删除")}</Text></Button>
            </AlertDialogFooter>
          </>}
        </AlertDialogContent>
      </AlertDialog>
    </View>
  );
}
