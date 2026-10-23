import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, BackHandler, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { GatewayError, type AgentMemory, type MemoryDetail, type MemoryScope } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { agentDisplayName } from "@/lib/agent-display-name.ts";
import { conflictMemory, detailBytes, memoryError, memoryLength, memoryModified, newDetailIndex, normalizeMemory, withoutDetailLink } from "@/lib/agent-memory.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { memoryIndexEntries } from "@/lib/memory-index.ts";
import { useSession } from "@/lib/session-context.tsx";

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

type DetailDraft = {
  base: AgentMemory; detail: MemoryDetail | null; slug: string; content: string;
  remote: AgentMemory | null; remoteDetail?: MemoryDetail | null;
};
type SubmissionGeneration = { revision: number; connection: number; observed: number; request: number };

export default function MemoryDetailRoute() {
  const { id, scope, slug, create } = useLocalSearchParams<{ id: string; scope: MemoryScope; slug?: string; create?: string }>();
  const session = useSession();
  if (!session || !id || (scope !== "profile" && scope !== "work") || (create !== "1" && !slug)) return <Redirect href="/" />;
  return <MemoryDetailScreen key={`${scope}:${id}:${slug ?? "new"}`} session={session} id={id} scope={scope} slug={slug} creating={create === "1"} />;
}

function MemoryDetailScreen({ session, id, scope, slug, creating }: {
  session: ChatSession; id: string; scope: MemoryScope; slug?: string; creating: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DetailDraft | null>(null);
  const [deleteIndex, setDeleteIndex] = useState<string | null>(null);
  const reviewingDeletion = deleteIndex !== null;
  const [editing, setEditing] = useState(creating);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const active = useRef(true);
  const operation = useRef(false);
  const request = useRef(0);
  const observed = useRef(0);
  const focused = useIsFocused();
  const revision = session.memoryRevisionFor(scope, id);
  const connectionRevision = session.memoryConnectionRevision;
  const count = detailBytes(draft?.content ?? "");
  const limit = draft?.detail?.limit ?? 65536;
  const dirty = !!draft && (draft.content !== (draft.detail?.content ?? "") || (creating && !!draft.slug));
  const agentName = scope === "work" ? agentDisplayName(session.agents, id) : undefined;
  const modified = draft ? memoryModified(draft.base, agentName) : null;
  const baseIndex = draft?.base;
  const detailSlug = draft?.slug ?? slug ?? "";
  const entryTitle = useMemo(() => creating ? t("新建详情") :
    baseIndex ? memoryIndexEntries(baseIndex.content, baseIndex).find((entry) => entry.slug === detailSlug)?.title ?? detailSlug : detailSlug,
  [creating, baseIndex, detailSlug, t]);
  const owner = scope === "profile" ? t("关于你") : t("{name} 的工作记忆", { name: agentName ?? "" });

  useEffect(() => {
    // A remount starts a new observation generation before replies can be accepted.
    ++request.current;
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    const sequence = ++request.current;
    void (async () => {
      const index = await session.api.getMemory(scope, id);
      const detail = creating || !index.details[slug!] ? null : await session.api.getMemoryDetail(scope, id, slug!);
      if (detail && detail.version !== index.version) throw new Error(t("详情已变化，请重试"));
      if (cancelled || !active.current || sequence !== request.current || (scope === "work" && session.agents.deletedIds.has(id)) ||
        session.memoryRevisionFor(scope, id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
      ++observed.current;
      setDraft((old) => !creating && !detail && !old ? null : old ? !editing && !reviewingDeletion && !creating && detail ? {
        ...old, base: index, detail, content: detail.content, remote: null, remoteDetail: undefined,
      } : {
        ...old,
        remote: !creating && !detail || old.base.version !== index.version ? index : null,
        remoteDetail: !creating && !detail || old.base.version !== index.version ? detail : undefined,
      } : { base: index, detail, slug: slug ?? "", content: detail?.content ?? "", remote: null });
      setError(!creating && !detail ? t(editing || reviewingDeletion ? "详情已删除，草稿仍在。" : "详情已删除") : "");
    })().catch((reason: unknown) => {
      if (cancelled || !active.current || sequence !== request.current ||
        session.memoryRevisionFor(scope, id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
      setError(t("无法加载详情：{error}", { error: memoryError(reason) }));
    });
    return () => { cancelled = true; };
  }, [session, id, scope, slug, creating, editing, reviewingDeletion, revision, connectionRevision, retry, focused, t]);

  const back = () => {
    if (operation.current) return;
    if (!(editing && dirty) && !reviewingDeletion) { router.back(); return; }
    Alert.alert(t("放弃未保存的详情？"), "", [
      { text: t("继续编辑"), style: "cancel" },
      { text: t("放弃"), style: "destructive", onPress: () => router.back() },
    ]);
  };
  useEffect(() => {
    if (!focused) return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => listener.remove();
  });

  const reload = async () => {
    if (!draft || operation.current) return;
    operation.current = true; setBusy(true); setError("");
    const sequence = ++request.current;
    const fromRevision = session.memoryRevisionFor(scope, id);
    const fromConnection = session.memoryConnectionRevision;
    try {
      const index = await session.api.getMemory(scope, id);
      const detail = creating || !index.details[slug!] ? null : await session.api.getMemoryDetail(scope, id, slug!);
      if (detail && detail.version !== index.version) throw new Error(t("详情已变化，请重试"));
      if (!active.current || sequence !== request.current || session.memoryRevisionFor(scope, id) !== fromRevision ||
        session.memoryConnectionRevision !== fromConnection) return;
      if (!creating && !detail) {
        ++observed.current;
        setDraft((state) => state && { ...state, remote: index, remoteDetail: null });
        setError(t("详情已删除，草稿仍在。"));
        return;
      }
      // An explicit reload adopts the new document version; only an editing draft keeps its text.
      ++observed.current;
      setDraft((state) => state && { ...state, base: index, detail, content: editing ? state.content : detail?.content ?? "", remote: null, remoteDetail: undefined });
      if (reviewingDeletion && draft?.detail) {
        const suggested = withoutDetailLink(draft.base.content, draft.detail.path);
        if (deleteIndex === suggested) setDeleteIndex(withoutDetailLink(index.content, detail?.path ?? ""));
      }
      setConflict(false);
    } catch (reason) {
      if (active.current && sequence === request.current && session.memoryRevisionFor(scope, id) === fromRevision &&
        session.memoryConnectionRevision === fromConnection) {
        setError(t("重新载入失败，草稿仍在：{error}", { error: memoryError(reason) }));
      }
    } finally { operation.current = false; if (active.current) setBusy(false); }
  };

  const showConflict = async (reason: GatewayError, source: DetailDraft, submitted: SubmissionGeneration) => {
    setConflict(true);
    const current = conflictMemory(reason.details, scope, id);
    const stillCurrent = () => active.current && (scope !== "work" || !session.agents.deletedIds.has(id)) &&
      session.memoryRevisionFor(scope, id) === submitted.revision &&
      session.memoryConnectionRevision === submitted.connection &&
      observed.current === submitted.observed && request.current === submitted.request;
    if (!current || !stillCurrent()) return;
    setDraft((state) => stillCurrent() && state ? {
      ...state, remote: current, remoteDetail: current.details[source.slug] ? undefined : null,
    } : state);
    if (creating || !current.details[source.slug]) return;
    try {
      const latest = await session.api.getMemoryDetail(scope, id, source.slug);
      if (latest.version === current.version && stillCurrent()) {
        setDraft((state) => stillCurrent() && state?.remote?.version === current.version
          ? { ...state, remoteDetail: latest } : state);
      }
    } catch { /* A changed document is not an adopted baseline; reload fetches it explicitly. */ }
  };

  const save = async () => {
    if (!draft || operation.current || draft.remote || conflict || !SLUG.test(draft.slug) || count > limit) return;
    if (creating && draft.base.details[draft.slug]) { setError(t("条目标识已存在，请换一个")); return; }
    const indexContent = creating ? newDetailIndex(draft.base.content, scope, draft.slug) : undefined;
    if (indexContent && memoryLength(indexContent) > draft.base.limit) {
      setError(t("索引超过上限，请先精简索引")); return;
    }
    const submitted: SubmissionGeneration = {
      revision: session.memoryRevisionFor(scope, id), connection: session.memoryConnectionRevision,
      observed: observed.current, request: request.current,
    };
    operation.current = true; setBusy(true); setError("");
    try {
      await session.api.updateMemoryDetail(scope, id, draft.slug, normalizeMemory(draft.content), draft.base.version, indexContent);
      if (active.current) router.back();
    } catch (reason) {
      if (!active.current) return;
      if (reason instanceof GatewayError && reason.status === 409) {
        await showConflict(reason, draft, submitted);
        if (active.current) setError(t("草稿仍在，重新加载后可保存。"));
      } else setError(t("保存失败，草稿仍在：{error}", { error: memoryError(reason) }));
    } finally { operation.current = false; if (active.current) setBusy(false); }
  };

  const remove = () => {
    if (!draft?.detail || operation.current || draft.remote || conflict) return;
    if (deleteIndex === null) {
      setDeleteIndex(withoutDetailLink(draft.base.content, draft.detail.path));
      setError("");
      return;
    }
    // The host accepts titled, reference-style and other Markdown forms. Review the
    // complete index instead of pretending a partial inline-link regex can edit them.
    if (deleteIndex.includes(draft.detail.path)) {
      setError(t("请先从索引中移除该详情的所有链接"));
      return;
    }
    if (memoryLength(deleteIndex) > draft.base.limit) {
      setError(t("索引超过上限，请先精简索引"));
      return;
    }
    Alert.alert(t("删除详情？"), t("详情及索引中所做的修改会一同保存，无法恢复。"), [
      { text: t("取消"), style: "cancel" },
      { text: t("删除"), style: "destructive", onPress: () => void (async () => {
        const submitted: SubmissionGeneration = {
          revision: session.memoryRevisionFor(scope, id), connection: session.memoryConnectionRevision,
          observed: observed.current, request: request.current,
        };
        operation.current = true; setBusy(true); setError("");
        try {
          await session.api.deleteMemoryDetail(scope, id, draft.slug, normalizeMemory(deleteIndex), draft.base.version);
          if (active.current) router.back();
        } catch (reason) {
          if (!active.current) return;
          if (reason instanceof GatewayError && reason.status === 409) await showConflict(reason, draft, submitted);
          if (active.current) setError(t("删除未完成，请重新加载后重试"));
        } finally { operation.current = false; if (active.current) setBusy(false); }
      })() },
    ]);
  };

  if (scope === "work" && session.agents.deletedIds.has(id)) return <Redirect href="/" />;
  return <View className="flex-1 bg-background">
    <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
    <ScreenBar title={entryTitle} subtitle={owner} left={<Button testID="memory-detail-back" variant="ghost" size="icon" accessibilityLabel={t("返回")} onPress={back}>
      <Icon as={ChevronLeft} className="size-[22px]" />
    </Button>} right={draft && editing ? <Button testID="memory-detail-save" variant="outline" size="sm" disabled={busy || !!draft.remote || conflict || !SLUG.test(draft.slug) || count > limit} onPress={() => void save()}><Text>{t("保存")}</Text></Button>
      : draft && !reviewingDeletion ? <Button testID="memory-detail-edit" variant="outline" size="sm" className="h-8 border-foreground bg-background"
        disabled={busy || !!draft.remote || conflict} onPress={() => setEditing(true)}><Text>{t("编辑")}</Text></Button> : null} />
    <ConnectionBanner session={session} />
    {!draft ? <View className="mx-6 mt-12 gap-3"><Text>{error || t("正在加载详情…")}</Text>
      {error ? <Button testID="memory-detail-retry" variant="outline" onPress={() => setRetry((n) => n + 1)}><Text>{t("重试")}</Text></Button> : null}
    </View> : <KeyboardAvoidingView behavior="padding" className="flex-1">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3 px-5 pb-12 pt-4">
        {creating ? <Textarea testID="memory-detail-slug" accessibilityLabel={t("条目标识")} value={draft.slug} onChangeText={(value) => setDraft((state) => state && { ...state, slug: value })}
          placeholder={t("条目标识（英文、数字、-、_）")} className="min-h-12 bg-muted p-3" /> : null}
        {modified ? <Text testID="memory-detail-modified" className="text-xs text-muted-foreground">{modified}</Text> : null}
        {draft.remote || conflict ? <View className="gap-2 rounded-xl border border-destructive p-3">
          <Text testID="memory-detail-conflict">{t("详情已在别处更新，草稿仍在。")}</Text>
          {draft.remote && (creating ? <Text testID="memory-detail-current" className="text-sm text-muted-foreground">{draft.remote.content}</Text>
            : draft.remoteDetail === null ? <Text testID="memory-detail-current" className="text-sm text-muted-foreground">{t("最新详情已删除")}</Text>
              : draft.remoteDetail ? <ScrollView testID="memory-detail-current" className="max-h-36 rounded-lg border border-border bg-card p-2">
                <Text className="text-sm">{draft.remoteDetail.content}</Text>
              </ScrollView> : <Text className="text-sm text-muted-foreground">{t("最新详情暂不可用，请重新加载")}</Text>)}
          {reviewingDeletion && draft.remote ? <View className="gap-1">
            <Text className="font-semibold">{t("最新索引 Markdown")}</Text>
            <Text testID="memory-detail-current-index" selectable>{draft.remote.content}</Text>
          </View> : null}
          <Button testID="memory-detail-reload" variant="outline" disabled={busy} onPress={() => void reload()}><Text>{t("重新加载")}</Text></Button>
          <Text className="text-xs text-muted-foreground">{t("重新加载保留草稿；保存前请核对最新内容。")}</Text>
        </View> : null}
        {error ? <Text testID="memory-detail-error" className="text-sm text-destructive">{error}</Text> : null}
        {editing ? <>
          <Textarea testID="memory-detail-input" accessibilityLabel={t("详情 Markdown")} value={draft.content} editable={!busy}
            onChangeText={(value) => setDraft((state) => state && { ...state, content: normalizeMemory(value) })}
            className="min-h-[280px] bg-muted p-3 font-mono text-sm" />
          <Text testID="memory-detail-count" className={`text-right text-xs ${count > limit ? "text-destructive" : "text-muted-foreground"}`}>{t("{count} / {limit} 字节", { count, limit })}</Text>
          {count > limit ? <Text testID="memory-detail-overlimit" className="text-destructive">{t("详情超过上限，请精简，草稿不会截断。")}</Text> : null}
        </> : <>
          <View testID="memory-detail-content"><AgentMemoryMarkdown content={draft.content} managedMemory={{ memory: draft.base, onOpen: (next) => {
            if (!operation.current) router.push({ pathname: "/memory-detail", params: { scope, id, slug: next } });
          } }} /></View>
          {!reviewingDeletion ? <View className="items-center pt-7">
            <Button testID="memory-detail-delete" variant="ghost" disabled={busy || !!draft.remote || conflict} onPress={remove}>
              <Text className="text-destructive">{t("删除详情")}</Text>
            </Button>
          </View> : <View className="gap-2">
            <Text className="font-semibold">{t("删除前核对索引")}</Text>
            <Text>{t("请从索引中移除该详情的所有链接，再删除详情。其他修改也会一同保存。")}</Text>
            <Text selectable className="text-xs text-muted-foreground">{draft.detail?.path}</Text>
            <Text className="font-semibold">{t("当前索引 Markdown")}</Text>
            <Text testID="memory-detail-base-index" selectable className="text-xs text-muted-foreground">{draft.base.content}</Text>
            <Textarea testID="memory-detail-delete-index" accessibilityLabel={t("删除后的索引 Markdown")}
              value={deleteIndex} editable={!busy} onChangeText={(value) => { setDeleteIndex(normalizeMemory(value)); setError(""); }}
              className="min-h-[220px] bg-muted p-3 font-mono text-sm" />
            <Text testID="memory-detail-delete-count" className={`text-right text-xs ${memoryLength(deleteIndex) > draft.base.limit ? "text-destructive" : "text-muted-foreground"}`}>
              {t("{count} / {limit} 字", { count: memoryLength(deleteIndex), limit: draft.base.limit })}
            </Text>
            <View className="flex-row gap-3">
              <Button testID="memory-detail-delete-cancel" variant="outline" disabled={busy} onPress={() => { setDeleteIndex(null); setError(""); }}><Text>{t("取消")}</Text></Button>
              <Button testID="memory-detail-delete-confirm" variant="outline" disabled={busy || !!draft.remote || conflict || memoryLength(deleteIndex) > draft.base.limit}
                onPress={remove}><Text>{t("删除详情")}</Text></Button>
            </View>
          </View>}
        </>}
      </ScrollView>
    </KeyboardAvoidingView>}
  </View>;
}
