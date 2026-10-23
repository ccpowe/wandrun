import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, BackHandler, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { ScreenBar } from "@/components/screen-bar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { GatewayError, type MemoryScope } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { beginMemoryDraft, conflictMemory, memoryError, memoryLength, normalizeMemory, observeMemory, reloadMemoryBase, type MemoryDraft } from "@/lib/agent-memory.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { memoryIndexEntries } from "@/lib/memory-index.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function MemoryEditorRoute() {
  const { id, scope } = useLocalSearchParams<{ id: string; scope: MemoryScope }>();
  const session = useSession();
  if (!session || !id || (scope !== "profile" && scope !== "work")) return <Redirect href="/" />;
  return <MemoryEditor key={`${scope}:${id}`} id={id} scope={scope} session={session} />;
}

function MemoryEditor({ id, scope, session }: { id: string; scope: MemoryScope; session: ChatSession }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<MemoryDraft | null>(null);
  const [error, setError] = useState("");
  const [reloadError, setReloadError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [showCurrent, setShowCurrent] = useState(false);
  const operation = useRef(false);
  const active = useRef(true);
  const request = useRef(0);
  const observed = useRef(0);
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { progress } = useReanimatedKeyboardAnimation();
  const editorInset = useAnimatedStyle(() => ({ paddingBottom: 12 + insets.bottom * (1 - progress.value) }));
  const revision = session.memoryRevisionFor(scope, id);
  const connectionRevision = session.memoryConnectionRevision;
  const dirty = draft !== null && normalizeMemory(draft.content) !== draft.base.content;
  const count = draft ? memoryLength(draft.content) : 0;
  const limit = draft?.base.limit ?? 1000;
  const activeIndex = draft?.remote ?? draft?.base;
  const indexContent = draft?.content;
  const unreferenced = useMemo(() => {
    if (!activeIndex || indexContent === undefined) return [];
    const referenced = new Set(memoryIndexEntries(indexContent, activeIndex).map((entry) => entry.slug));
    return Object.keys(activeIndex.details).filter((slug) => !referenced.has(slug));
  }, [indexContent, activeIndex]);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const currentRequest = ++request.current;
    void session.api.getMemory(scope, id).then(
      (snapshot) => {
        if (cancelled || !active.current || request.current !== currentRequest || (scope === "work" && session.agents.deletedIds.has(id)) ||
          session.memoryRevisionFor(scope, id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
        ++observed.current;
        setDraft((current) => observeMemory(current, snapshot));
        setError("");
      },
      (reason: unknown) => {
        if (cancelled || !active.current || request.current !== currentRequest ||
          session.memoryRevisionFor(scope, id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
        if (scope === "work" && reason instanceof GatewayError && reason.status === 404) { router.dismissTo("/"); return; }
        setError(`无法加载记忆：${memoryError(reason)}`);
      },
    );
    return () => { cancelled = true; };
  }, [session, id, scope, revision, connectionRevision, retry, focused]);

  // The pending index operation owns the next navigation, including before its busy render commits.
  const openDetail = (slug?: string) => {
    if (operation.current || !active.current) return;
    router.push({ pathname: "/memory-detail", params: { scope, id, ...(slug ? { slug } : { create: "1" }) } });
  };

  const back = () => {
    if (operation.current) return;
    if (!dirty) { router.back(); return; }
    Alert.alert(t("放弃未保存的记忆？"), "", [
      { text: t("继续编辑"), style: "cancel" },
      { text: t("放弃"), style: "destructive", onPress: () => router.back() },
    ]);
  };
  useEffect(() => {
    if (!focused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => { back(); return true; });
    return () => subscription.remove();
  });

  const save = async () => {
    if (!draft || operation.current || count > limit || draft.remote || conflict) return;
    operation.current = true;
    setSaving(true);
    setError("");
    const submitted = {
      revision: session.memoryRevisionFor(scope, id), connection: session.memoryConnectionRevision,
      observed: observed.current, request: request.current,
    };
    const content = normalizeMemory(draft.content);
    try {
      const saved = await session.api.updateMemory(scope, id, content, draft.base.version);
      if (!active.current || (scope === "work" && session.agents.deletedIds.has(id))) return;
      setDraft(beginMemoryDraft(saved));
      router.back();
    } catch (reason) {
      if (!active.current) return;
      if (scope === "work" && reason instanceof GatewayError && reason.status === 404) {
        router.dismissTo("/");
        return;
      }
      if (reason instanceof GatewayError && reason.status === 409) {
        setConflict(true);
        const current = conflictMemory(reason.details, scope, id);
        const stillCurrent = () => active.current && (scope !== "work" || !session.agents.deletedIds.has(id)) &&
          session.memoryRevisionFor(scope, id) === submitted.revision &&
          session.memoryConnectionRevision === submitted.connection &&
          observed.current === submitted.observed && request.current === submitted.request;
        if (current && stillCurrent()) {
          setDraft((state) => stillCurrent() && state ? observeMemory(state, current) : state);
        }
        setError("草稿仍在，重新加载后可保存。");
      } else {
        setError(`保存失败，草稿仍在：${memoryError(reason)}`);
      }
    } finally {
      operation.current = false;
      if (active.current) setSaving(false);
    }
  };

  const reload = async () => {
    if (!draft || operation.current) return;
    operation.current = true;
    setReloading(true);
    setReloadError("");
    const currentRequest = ++request.current;
    const fromRevision = session.memoryRevisionFor(scope, id);
    const fromConnection = session.memoryConnectionRevision;
    try {
      const snapshot = await session.api.getMemory(scope, id);
      if (!active.current || request.current !== currentRequest || (scope === "work" && session.agents.deletedIds.has(id)) ||
          session.memoryRevisionFor(scope, id) !== fromRevision || session.memoryConnectionRevision !== fromConnection) return;
      ++observed.current;
      setDraft((state) => state ? reloadMemoryBase(state, snapshot) : beginMemoryDraft(snapshot));
      setError("");
      setConflict(false);
      setShowCurrent(false);
    } catch (reason) {
      if (!active.current || request.current !== currentRequest ||
          session.memoryRevisionFor(scope, id) !== fromRevision || session.memoryConnectionRevision !== fromConnection) return;
      if (scope === "work" && reason instanceof GatewayError && reason.status === 404) { router.dismissTo("/"); return; }
      setReloadError(`重新载入失败，草稿仍在：${memoryError(reason)}`);
    } finally {
      operation.current = false;
      if (active.current) setReloading(false);
    }
  };

  if (scope === "work" && session.agents.deletedIds.has(id)) return <Redirect href="/" />;
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <ScreenBar title={scope === "profile" ? t("编辑关于你") : t("编辑工作记忆")} left={<Button testID="memory-editor-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回")} onPress={back}>
        <Icon as={ChevronLeft} className="size-[22px]" />
      </Button>} right={<Button testID="memory-editor-save" variant="outline" size="sm" className="h-8 border-foreground bg-background"
        disabled={!draft || saving || reloading || count > limit || !!draft.remote || conflict} onPress={() => void save()}>
        <Text>{saving ? t("保存中…") : t("保存")}</Text>
      </Button>} />
      <ConnectionBanner session={session} />
      {!draft ? (
        <View className="mx-6 mt-12 items-center gap-3">
          <Text className="text-sm text-muted-foreground">{error ? t(error) : t("正在加载记忆…")}</Text>
          {error ? <Button testID="memory-editor-retry" variant="outline" onPress={() => setRetry((value) => value + 1)}><Text>{t("重试")}</Text></Button> : null}
        </View>
      ) : <KeyboardAvoidingView behavior="padding" className="flex-1">
        <Animated.View className="flex-1 gap-2 px-4 pt-3" style={editorInset}>
          {draft.remote || conflict ? <View className="gap-2 rounded-[14px] border border-destructive p-3">
            <Text testID="memory-editor-conflict" className="text-sm">{draft.remote?.updated_by === "user" ? t("记忆已被用户更新。请先核对最新版本，再重新加载。") : t("记忆已在别处更新。请先核对最新版本，再重新加载。")}</Text>
            <View className="flex-row gap-2">
              <Button testID="memory-editor-view-current" variant="outline" size="sm" disabled={!draft.remote} onPress={() => setShowCurrent((value) => !value)}><Text>{showCurrent ? t("收起最新版本") : t("查看最新版本")}</Text></Button>
              <Button testID="memory-editor-reload" variant="outline" size="sm" disabled={reloading || saving} onPress={() => void reload()}><Text>{reloading ? t("加载中…") : t("重新加载")}</Text></Button>
            </View>
            <Text className="text-xs text-muted-foreground">{t("重新加载会保留草稿，之后保存将以草稿覆盖最新记忆，请先核对。")}</Text>
            {showCurrent && draft.remote ? <ScrollView testID="memory-editor-current" className="max-h-36 rounded-lg border border-border bg-card px-3 py-2">
              {draft.remote.content ? <AgentMemoryMarkdown content={draft.remote.content}
                managedMemory={{ memory: draft.remote, onOpen: openDetail }} />
                : <Text className="text-sm text-muted-foreground">{t("当前记忆为空")}</Text>}
            </ScrollView> : null}
          </View> : null}
          {error ? <Text testID="memory-editor-error" className="text-sm text-destructive">{t(error)}</Text> : null}
          {reloadError ? <Text testID="memory-editor-reload-error" className="text-sm text-destructive">{t(reloadError)}</Text> : null}
          <Textarea testID="memory-editor-input" accessibilityLabel={scope === "profile" ? t("关于你 Markdown") : t("工作记忆 Markdown")} editable={!saving && !reloading}
            value={draft.content} onChangeText={(content) => {
              setDraft((state) => state ? { ...state, content: normalizeMemory(content) } : state);
              setError("");
            }} placeholder={scope === "profile" ? t("稳定偏好或背景…") : t("对这个 Agent 的反馈…")}
            className="flex-1 border-0 bg-muted px-3.5 py-3 font-mono text-[13px] leading-[21px]" />
          <Text testID="memory-editor-count" className={`text-right text-xs ${count > limit ? "text-destructive" : "text-muted-foreground"}`}>
            {t("{count} / {limit} 字", { count, limit })}
          </Text>
          {count > limit ? <Text testID="memory-editor-overlimit" className="text-xs text-destructive">{t("超过上限 {count} 字，请自行精简，草稿不会截断。", { count: count - limit })}</Text> : null}
          {unreferenced.length ? <View className="gap-1">
            <Text className="text-sm font-medium text-muted-foreground">{t("未被索引引用的详情")}</Text>
            <ScrollView className="max-h-36">
              {unreferenced.map((slug) => <Button key={slug} testID={`memory-editor-detail-${slug}`} variant="ghost"
                disabled={saving || reloading} className="min-h-11 flex-row justify-between" onPress={() => openDetail(slug)}>
                <Text className="flex-1 text-left">{slug}</Text><Icon as={ChevronRight} className="size-4 text-muted-foreground" />
              </Button>)}
            </ScrollView>
          </View> : null}
          <Button testID="memory-editor-new-detail" variant="outline" className="self-center" disabled={saving || reloading} onPress={() => openDetail()}>
            <Text>{t("新建详情")}</Text>
          </Button>
        </Animated.View>
      </KeyboardAvoidingView>}
    </View>
  );
}
