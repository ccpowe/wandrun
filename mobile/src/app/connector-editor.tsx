import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EditorRow } from "@/components/agent-editor-controls.tsx";
import { ConnectorOAuth } from "@/components/connector-oauth.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Text } from "@/components/ui/text.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import type { Connector, ConnectorTestResult, PatchConnectorInput } from "@/gateway/api.ts";
import { createResultUnknown, GatewayError } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { useConnectorCatalog } from "@/lib/connector-catalog.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { blankConnectorDraft, connectorDeletionUsers, connectorFields, connectorStatus, draftFromConnector, prepareConnectorCreateCommand, validateConnectorDraft, type ConnectorCreateCommand, type ConnectorDraft, type SecretRow } from "@/lib/connectors.ts";
import { useSession } from "@/lib/session-context.tsx";
import { cn } from "@/lib/utils.ts";

const RESTART_WARNING = "测试的是当前运行的旧参数，新参数重启网关后生效。";

export default function ConnectorEditorRoute() {
  const { id, fromApp } = useLocalSearchParams<{ id?: string; fromApp?: string }>();
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <ConnectorEditor key={`${id ?? "new"}:${fromApp ?? ""}`} session={session} id={id} fromApp={fromApp} />;
}

function ConnectorEditor({ session, id, fromApp }: { session: ChatSession; id?: string; fromApp?: string }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const [missing, setMissing] = useState(false);
  const catalog = useConnectorCatalog(session);
  const [draft, setDraft] = useState<ConnectorDraft | null>(id ? null : blankConnectorDraft);
  const [original, setOriginal] = useState<Connector | null>(null);
  const [live, setLive] = useState<Connector | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [loadError, setLoadError] = useState("");
  const [loadRetry, setLoadRetry] = useState(0);
  const [externalChange, setExternalChange] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [createUnknown, setCreateUnknown] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const [testResult, setTestResult] = useState<ConnectorTestResult | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<"confirm" | "blocked" | null>(null);
  const [deleteUsers, setDeleteUsers] = useState<{ id: string; name: string }[]>([]);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const command = useRef<ConnectorCreateCommand | null>(null);
  const loadedDefinitionSeq = useRef(0);
  const operation = useRef(false);
  const mounted = useRef(true);
  const deletionNavigated = useRef(false);
  const focusedRef = useRef(isFocused);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { focusedRef.current = isFocused; }, [isFocused]);
  const acceptLive = useCallback((value: Connector) => {
    setLive(value);
    if (original && (definitionChanged(original, value) ||
        (session.connectorDefinitionSeq.get(value.id) ?? 0) > loadedDefinitionSeq.current)) setExternalChange(true);
  }, [original, session]);
  const missingConnector = useCallback(() => setMissing(true), []);

  const deleted = missing || (!!id && (session.deletedConnectorIds.has(id) || (catalog.loaded && !catalog.connectors.some((connector) => connector.id === id))));
  const leaveDeleted = useCallback(() => {
    if (deletionNavigated.current) return;
    deletionNavigated.current = true;
    if ((fromApp || original?.app_id) && router.canGoBack()) router.back();
    else router.dismissTo("/settings-connectors");
  }, [fromApp, original?.app_id]);
  // A background detail may sit below an Agent draft. Deletion must not dismiss that draft.
  useEffect(() => { if (deleted && isFocused) leaveDeleted(); }, [deleted, isFocused, leaveDeleted]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    loadedDefinitionSeq.current = session.connectorDefinitionSeq.get(id) ?? 0;
    void session.api.getConnector(id).then(
      (value) => { if (active) { setOriginal(value); setLive(value); setDraft(draftFromConnector(value)); setLoadError(""); setLoading(false); } },
      (reason: unknown) => {
        if (!active) return;
        if (reason instanceof GatewayError && reason.status === 404) { setMissing(true); return; }
        setLoadError(reason instanceof Error ? reason.message : String(reason)); setLoading(false);
      },
    );
    return () => { active = false; };
  }, [session, id, loadRetry]);

  // OAuth controls own reads and command ordering for OAuth connectors. Plain connectors
  // still refresh their status here; neither path overwrites the editable draft.
  useEffect(() => {
    if (!id || !original || deleted || live?.auth_type === "oauth") return;
    let active = true;
    void session.api.getConnector(id).then((value) => {
      if (active) acceptLive(value);
    }, (reason: unknown) => {
      if (active && reason instanceof GatewayError && reason.status === 404) setMissing(true);
    });
    return () => { active = false; };
  }, [session, id, original, session.connectorRevision, deleted, live?.auth_type, acceptLive]);

  useEffect(() => {
    if (!isFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => createUnknown || operation.current);
    return () => subscription.remove();
  }, [createUnknown, isFocused]);

  const locked = createUnknown || saving || deleting || testing;
  const change = (update: Partial<ConnectorDraft>) => {
    if (locked) return;
    setDraft((current) => current ? { ...current, ...update } : null);
    setSaveError("");
  };
  const back = () => { if (!locked) router.back(); };
  const save = async () => {
    if (!draft || operation.current) return;
    if (!createUnknown) {
      const error = validateConnectorDraft(draft);
      if (error) { setSaveError(error); return; }
    }
    operation.current = true;
    setSaving(true);
    setSaveError("");
    try {
      if (id && original) {
        const latest = await session.api.getConnector(id);
        const fields = connectorFields(draft, original, latest) as PatchConnectorInput;
        if (!Object.keys(fields).length) { router.back(); return; }
        const result = await session.api.updateConnector(id, fields);
        session.connectorChanged(result.event);
        if (mounted.current) { setOriginal(result.connector); setExternalChange(false); }
      } else if (!id) {
        // Unknown success is retried with the *same* body and client_id, never with a newly edited draft.
        const prepared = prepareConnectorCreateCommand(draft, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`, command.current);
        command.current = prepared;
        const result = await session.api.createConnector(prepared.clientId, prepared.fields);
        session.connectorChanged(result.event);
        command.current = null;
        if (mounted.current) setCreateUnknown(false);
      }
      if (mounted.current) {
        if (original?.app_id && router.canGoBack()) router.back();
        else router.dismissTo("/settings-connectors");
      }
    } catch (reason) {
      if (!id) {
        const unknown = createResultUnknown(reason, createUnknown);
        if (!unknown) command.current = null;
        if (mounted.current) setCreateUnknown(unknown);
      }
      if (mounted.current) setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operation.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const test = async () => {
    if (!id || operation.current) return;
    operation.current = true;
    setTesting(true);
    setTestError("");
    setTestResult(null);
    try {
      const result = await session.api.testConnector(id);
      if (mounted.current) setTestResult(result);
      catalog.refresh();
    } catch (reason) {
      if (mounted.current) setTestError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      operation.current = false;
      if (mounted.current) setTesting(false);
    }
  };
  const requestDeletion = async () => {
    if (!id || operation.current) return;
    operation.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      const current = await session.api.getConnector(id);
      if (!mounted.current) return;
      setDeleteUsers(current.used_by);
      setDeleteDialog(current.used_by.length ? "blocked" : "confirm");
    } catch {
      if (mounted.current) setSaveError("无法检查删除条件，请检查网关连接后重试。");
    } finally {
      operation.current = false;
      if (mounted.current) setDeleting(false);
    }
  };
  const remove = async () => {
    if (!id || operation.current) return;
    operation.current = true;
    setDeleting(true);
    setDeleteError("");
    try {
      const { event } = await session.api.deleteConnector(id);
      session.connectorChanged(event);
      if (mounted.current) {
        setDeleteDialog(null);
        if (focusedRef.current) leaveDeleted();
      }
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof GatewayError && reason.code === "remote_revocation_failed") {
        setDeleteDialog("confirm");
        setDeleteError("本地授权已清除，但远端撤销失败，连接器仍保留。请到服务方设置里断开后重试删除。");
        session.refreshConnectors();
        catalog.refresh();
      } else if (reason instanceof GatewayError && reason.code === "rejected" &&
          connectorDeletionUsers(reason.details).length > 0) {
        setDeleteUsers(connectorDeletionUsers(reason.details));
        setDeleteDialog("blocked");
      } else if (reason instanceof GatewayError && reason.status === 404) {
        setMissing(true);
      } else setDeleteError("删除未完成，请刷新连接器状态后重试。");
    } finally {
      operation.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  const secrets = draft ? draft.mode === "local" ? draft.env : draft.headers : [];
  const setSecrets = (rows: SecretRow[]) => change(draft?.mode === "local" ? { env: rows } : { headers: rows });
  const status = live ? connectorStatus(live) : null;
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false, gestureEnabled: !locked }} />
    <ScreenBar title={id ? live?.name ?? t("编辑连接器") : t("添加连接器")}
      left={<Button testID="connector-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回")} disabled={locked} onPress={back}><Icon as={ChevronLeft} className="size-[22px]" /></Button>}
      right={draft ? <Button testID="connector-save" variant="outline" size="sm" className="h-8 border-foreground bg-background" disabled={saving || deleting || testing} onPress={() => void save()}><Text>{saving ? t("保存中…") : id ? t("保存") : t("创建")}</Text></Button> : null} />
    <ConnectionBanner session={session} />
    {createUnknown ? <Text className="mx-6 my-2 text-sm leading-5 text-destructive">{t("创建结果尚未确认。请点“创建”用同一次命令重试；确认结果前不能修改字段或退出。")}</Text> : null}
    {saveError ? <Text testID="connector-error" className="mx-6 my-2 text-sm text-destructive">{t(saveError)}</Text> : null}
    {loading ? <Text className="mt-12 text-center text-sm text-muted-foreground">{t("正在加载连接器…")}</Text> : loadError || !draft ?
      <View className="mx-6 mt-12 items-center gap-3"><Text className="text-sm text-destructive">{t(loadError || "无法加载连接器")}</Text><Button variant="outline" onPress={() => { setLoading(true); setLoadRetry((value) => value + 1); }}><Text>{t("重试")}</Text></Button></View> :
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={12} contentContainerStyle={{ paddingBottom: insets.bottom + 26 }}>
        {externalChange ? <Text testID="connector-external-change" className="mx-5 my-2 rounded-md border border-destructive px-3 py-2 text-sm leading-5 text-destructive">{t("连接器已在别处修改，草稿保留。保存将本页改动应用到当前配置；或返回列表重新打开。")}</Text> : null}
        <Field label={t("名称")}><Input testID="connector-name" accessibilityLabel={t("名称")} editable={!locked} value={draft.name} onChangeText={(name) => change({ name })} placeholder={t("例如 docs")} /></Field>
        <Field label={t("说明")}><Input testID="connector-description" accessibilityLabel={t("说明")} editable={!locked} value={draft.description} onChangeText={(description) => change({ description })} placeholder={t("工具及使用场景")} /></Field>
        <Text className="mx-5 mb-2 mt-4 text-[13px] text-muted-foreground">{t("连接方式")}</Text>
        <View className="mx-4 flex-row rounded-md bg-muted p-[3px]">
          {(["local", "remote"] as const).map((mode) => <Pressable key={mode} testID={`connector-${mode}`} accessibilityRole="radio" accessibilityState={{ selected: draft.mode === mode, disabled: locked || !!original?.app_id }} disabled={locked || !!original?.app_id}
            onPress={() => change({ mode, ...(mode === "local" ? { auth_type: "none" as const } : {}) })} className={cn("h-[38px] flex-1 items-center justify-center rounded-[10px]", draft.mode === mode && "border border-border bg-card")}><Text className={cn("text-sm", draft.mode === mode ? "font-semibold" : "text-muted-foreground")}>{t(mode === "local" ? "本地命令" : "远程地址")}</Text></Pressable>)}
        </View>
        {draft.mode === "local" ? <>
          <Field label={t("命令（在电脑上运行）")}><Input testID="connector-command" accessibilityLabel={t("命令")} editable={!locked} value={draft.command} onChangeText={(command) => change({ command })} placeholder={t("例如 npx")} autoCapitalize="none" className="font-mono" /></Field>
          <Field label={t("参数（逐项编辑，保留空值和换行）")}>
            {draft.args.map((arg, index) => <View key={index} className="flex-row items-start gap-2">
              <Textarea testID={`connector-arg-${index}`} accessibilityLabel={t("参数 {number}", { number: index + 1 })} editable={!locked} value={arg}
                onChangeText={(value) => change({ args: draft.args.map((item, i) => i === index ? value : item) })}
                placeholder={t("空参数")} autoCapitalize="none" className="min-h-16 min-w-0 flex-1 font-mono" />
              <Button testID={`connector-arg-delete-${index}`} variant="ghost" size="icon" disabled={locked} accessibilityLabel={t("删除参数 {number}", { number: index + 1 })}
                onPress={() => change({ args: draft.args.filter((_, i) => i !== index) })}><Icon as={Trash2} className="size-[18px] text-destructive" /></Button>
            </View>)}
            <Button testID="connector-arg-add" variant="outline" disabled={locked} onPress={() => change({ args: [...draft.args, ""] })}><Text>{t("添加参数")}</Text></Button>
          </Field>
        </> : <>
          <Field label={t("地址")}><Input testID="connector-url" accessibilityLabel={t("地址")} editable={!locked && !original?.app_id} value={draft.url} onChangeText={(url) => change({ url })} placeholder="https://example.com/mcp" autoCapitalize="none" keyboardType="url" className="font-mono" /></Field>
        </>}
        {draft.mode === "remote" ? <View className="mx-5 mt-4 gap-2">
          <Text className="text-[13px] text-muted-foreground">{t(original?.app_id ? "授权方式（应用目录管理）" : "授权方式")}</Text>
          <View className="flex-row gap-2">{(["none", "oauth"] as const).map((auth) =>
            <Button key={auth} testID={`connector-auth-${auth}`} variant="outline" size="sm" accessibilityRole="radio"
              accessibilityState={{ selected: draft.auth_type === auth, disabled: locked || !!original?.app_id }}
              disabled={locked || !!original?.app_id} className={cn("flex-1", draft.auth_type === auth ? "border-foreground bg-muted" : "border-border bg-background")}
              onPress={() => change({ auth_type: auth })}><Text>{auth === "oauth" ? "OAuth" : t("无")}</Text></Button>)}</View>
          {draft.auth_type === "oauth" && !id ? <Text className="text-xs text-muted-foreground">{t("保存后可发起授权。不会自动授予任何 Agent。")}</Text> : null}
          {draft.auth_type === "oauth" && original?.transport === "sse" ? <Text className="text-xs leading-[18px] text-muted-foreground">{t("保存后将此连接器从 SSE 切换为 Streamable HTTP；服务须支持该传输。")}</Text> : null}
          {draft.auth_type === "oauth" && !!original && original.auth_type !== "oauth" ? <Text className="text-xs leading-[18px] text-muted-foreground">{t("切换到 OAuth 会移除原有静态请求头；保存后再显式发起授权。")}</Text> : null}
        </View> : null}
        {draft.mode !== "remote" || draft.auth_type !== "oauth" ? <>
        <ListGroup label={t(draft.mode === "local" ? "环境变量" : "请求头")}>
          {secrets.map((row, index) => <View key={`${row.existing ? "existing" : "new"}-${index}`} className="gap-2 px-4 py-3">
            <View className="flex-row items-center gap-2">
              <Input testID={`connector-secret-key-${index}`} accessibilityLabel={t("{kind}键名 {number}", { kind: t(draft.mode === "local" ? "环境变量" : "请求头"), number: index + 1 })} editable={!locked && !row.existing && !row.deleted}
                value={row.key} onChangeText={(key) => setSecrets(secrets.map((item, i) => i === index ? { ...item, key } : item))} placeholder={t("键名")} autoCapitalize="none" className={cn("min-w-0 flex-1 font-mono", row.existing && !row.deleted && "opacity-100")} />
              <Button testID={`connector-secret-delete-${index}`} variant="ghost" size="icon" disabled={locked} accessibilityLabel={row.deleted ? t("撤销删除") : t("删除此项")}
                onPress={() => row.existing ? setSecrets(secrets.map((item, i) => i === index ? { ...item, deleted: !item.deleted, value: "" } : item)) : setSecrets(secrets.filter((_, i) => i !== index))}>
                {row.deleted ? <Text className="text-xs">{t("撤销")}</Text> : <Icon as={Trash2} className="size-[18px] text-destructive" />}
              </Button>
            </View>
            {row.deleted ? <Text className="text-xs text-destructive">{t("保存后移除这一项")}</Text> : <Input testID={`connector-secret-value-${index}`} accessibilityLabel={t("{key}的值", { key: row.key || t("新项") })} editable={!locked}
              secureTextEntry value={row.value} onChangeText={(value) => setSecrets(secrets.map((item, i) => i === index ? { ...item, value } : item))}
              placeholder={row.existing ? t("已设置 · 留空保持不变") : t("输入密钥")} autoCapitalize="none" className="min-w-0 font-mono" />}
          </View>)}
          <Pressable testID="connector-secret-add" accessibilityRole="button" accessibilityLabel={t("添加一项")} disabled={locked}
            onPress={() => setSecrets([...secrets, { key: "", value: "", existing: false, deleted: false }])} className="min-h-[52px] flex-row items-center gap-2 px-4 active:bg-muted">
            <Icon as={Plus} className="size-[18px] text-muted-foreground" /><Text className="text-sm text-muted-foreground">{t("添加一项")}</Text>
          </Pressable>
        </ListGroup>
        <Text className="mx-8 mt-2 text-xs leading-[18px] text-muted-foreground">{t("密钥只写不读。已设置的值留空会保持不变；点删除才会移除。")}</Text>
        </> : null}
        {id && live?.auth_type === "oauth" ? <ListGroup label={t("OAuth 授权")}><ConnectorOAuth key={id} session={session} connector={live} onChange={acceptLive} onMissing={missingConnector} /></ListGroup> : null}
        <ListGroup label={t("Agent 使用")}>
          <EditorRow label={t("每个 Agent 可选择直接携带或按需搜索")} description={t("在 Agent 编辑 › 连接器中设置。")} />
          {live?.used_by.length ? live.used_by.map((agent) => <EditorRow key={agent.id} testID={`connector-agent-${agent.id}`} label={agent.name} onPress={() => router.push({ pathname: "/agents/[id]", params: { id: agent.id } })} />)
            : <EditorRow label={t("没有 Agent 使用")} />}
        </ListGroup>
        {live?.pending_restart || testResult?.pending_restart ? <Text testID="connector-restart-warning" className="mx-5 mt-4 rounded-md border border-border px-3 py-2 text-[13px] leading-[19px]">{t(RESTART_WARNING)}</Text> : null}
        {status?.failed ? <Text className="mx-5 mt-4 rounded-md border border-destructive px-3 py-2 text-[13px] leading-[19px] text-destructive">{t("上次连接失败：{error}", { error: t(live?.error || "未知原因") })}</Text> : null}
        {id ? <View className={cn("mx-5 mt-4 flex-row items-center gap-2 rounded-md p-3", testResult?.success ? "bg-muted" : "border border-border")}>
          <Text testID="connector-test-result" className={cn("min-w-0 flex-1 text-[13px] leading-[19px]", testResult && !testResult.success && "text-destructive")}>{testResult ? testResult.success ? t("连接成功 · {count} 个工具", { count: testResult.tool_count }) : t("连接失败：{error}", { error: t(testResult.error || "未知原因") }) : status?.label ?? t("测试当前连接")}</Text>
          <Button testID="connector-test" variant="outline" size="sm" disabled={locked} onPress={() => void test()}><Text>{testing ? t("测试中…") : testResult ? t("再测一次") : t("测试连接")}</Text></Button>
        </View> : <Text className="mx-8 mt-4 text-xs text-muted-foreground">{t("请先保存连接器再测试连接。")}</Text>}
        {id ? <Text className="mx-8 mt-2 text-xs leading-[17px] text-muted-foreground">{t("测试当前连接，不含本页未保存的修改。")}</Text> : null}
        {testError ? <Text testID="connector-test-error" className="mx-6 mt-2 text-sm text-destructive">{t("测试失败：{error}", { error: t(testError) })}</Text> : null}
        {id ? <Button testID="connector-delete" variant="ghost" disabled={locked} className="mt-6 self-center" onPress={() => void requestDeletion()}><Text className="text-destructive">{t("删除连接器")}</Text></Button> : null}
      </KeyboardAwareScrollView>}
    <AlertDialog open={deleteDialog !== null} onOpenChange={(open) => { if (!open && !operation.current) setDeleteDialog(null); }}>
      <AlertDialogContent overlayClassName="justify-end p-0" className="w-full rounded-b-none rounded-t-[24px] border-border bg-card" style={{ paddingBottom: insets.bottom + 20 }}>
        <View className="h-1 w-9 self-center rounded-full bg-border" />
        {deleteDialog === "blocked" ? <>
          <AlertDialogHeader><AlertDialogTitle>{t("现在不能删除")}</AlertDialogTitle><AlertDialogDescription>{t("连接器仍被 {names} 使用。先在对应 Agent 编辑里移除，再删除连接器。", { names: deleteUsers.map((user) => user.name).join("、") || "Agent" })}</AlertDialogDescription></AlertDialogHeader>
          <Button testID="connector-delete-blocked" variant="outline" className="border-foreground bg-card" onPress={() => setDeleteDialog(null)}><Text>{t("知道了")}</Text></Button>
        </> : <>
          <AlertDialogHeader><AlertDialogTitle>{t("删除{name}？", { name: live?.name ?? "" })}</AlertDialogTitle><AlertDialogDescription>{t("删除后无法恢复，但不会删除 Agent。")}</AlertDialogDescription></AlertDialogHeader>
          {deleteError ? <Text testID="connector-delete-error" className="text-sm text-destructive">{t(deleteError)}</Text> : null}
          <AlertDialogFooter className="flex-col-reverse gap-2">
            <AlertDialogCancel testID="connector-delete-cancel" disabled={deleting} className="border-foreground bg-card"><Text>{t("取消")}</Text></AlertDialogCancel>
            <Button testID="connector-delete-confirm" variant="outline" disabled={deleting} className="border-destructive bg-card" onPress={() => void remove()}><Text className="text-destructive">{deleting ? t("删除中…") : t("删除")}</Text></Button>
          </AlertDialogFooter>
        </>}
      </AlertDialogContent>
    </AlertDialog>
  </View>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View className="gap-1.5 px-4 pt-4"><Text className="px-1 text-[13px] text-muted-foreground">{label}</Text>{children}</View>;
}

function definitionChanged(before: Connector, after: Connector): boolean {
  return before.name !== after.name || before.description !== after.description || before.command !== after.command ||
    JSON.stringify(before.args ?? []) !== JSON.stringify(after.args ?? []) || before.url !== after.url ||
    before.auth_type !== after.auth_type || before.app_id !== after.app_id ||
    JSON.stringify(Object.keys(before.env ?? {}).sort()) !== JSON.stringify(Object.keys(after.env ?? {}).sort()) ||
    JSON.stringify(Object.keys(before.headers ?? {}).sort()) !== JSON.stringify(Object.keys(after.headers ?? {}).sort());
}
