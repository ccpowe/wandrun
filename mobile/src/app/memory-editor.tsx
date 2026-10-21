import { Redirect, router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
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
import { GatewayError } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { beginMemoryDraft, conflictMemory, memoryLength, normalizeMemory, observeMemory, reloadMemoryBase, type MemoryDraft } from "@/lib/agent-memory.ts";
import { ConnectionBanner } from "@/lib/connection-banner.tsx";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";

export default function MemoryEditorRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  if (!session) return <Redirect href="/" />;
  return <MemoryEditor key={id} id={id} session={session} />;
}

function MemoryEditor({ id, session }: { id: string; session: ChatSession }) {
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
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const { progress } = useReanimatedKeyboardAnimation();
  const editorInset = useAnimatedStyle(() => ({ paddingBottom: 12 + insets.bottom * (1 - progress.value) }));
  const revision = session.memoryRevisionFor(id);
  const connectionRevision = session.memoryConnectionRevision;
  const dirty = draft !== null && normalizeMemory(draft.content) !== draft.base.content;
  const count = draft ? memoryLength(draft.content) : 0;
  const limit = draft?.base.limit ?? 1000;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const currentRequest = ++request.current;
    void session.api.getAgentMemory(id).then(
      (snapshot) => {
        if (cancelled || !active.current || request.current !== currentRequest || session.agents.deletedIds.has(id) ||
          session.memoryRevisionFor(id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
        setDraft((current) => observeMemory(current, snapshot));
        setError("");
      },
      (reason: unknown) => {
        if (cancelled || !active.current || request.current !== currentRequest ||
          session.memoryRevisionFor(id) !== revision || session.memoryConnectionRevision !== connectionRevision) return;
        if (reason instanceof GatewayError && reason.status === 404) { router.dismissTo("/"); return; }
        setError(`无法加载记忆：${reason instanceof Error ? reason.message : String(reason)}`);
      },
    );
    return () => { cancelled = true; };
  }, [session, id, revision, connectionRevision, retry]);

  const back = () => {
    if (operation.current) return;
    if (!dirty) { router.back(); return; }
    Alert.alert(t("放弃未保存的记忆？"), t("草稿尚未保存。"), [
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
    const content = normalizeMemory(draft.content);
    try {
      const saved = await session.api.updateAgentMemory(id, content, draft.base.version);
      if (!active.current || session.agents.deletedIds.has(id)) return;
      setDraft(beginMemoryDraft(saved));
      router.back();
    } catch (reason) {
      if (!active.current) return;
      if (reason instanceof GatewayError && reason.status === 404) {
        router.dismissTo("/");
        return;
      }
      if (reason instanceof GatewayError && reason.status === 409) {
        setConflict(true);
        const current = conflictMemory(reason.details, id);
        if (current) {
          setDraft((state) => state ? observeMemory(state, current) : state);
        }
        setError("记忆已在别处更新，草稿仍在。请核对最新版本，重新加载后再保存。");
      } else {
        setError(`保存失败，草稿仍在：${reason instanceof Error ? reason.message : String(reason)}`);
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
    const fromRevision = session.memoryRevisionFor(id);
    const fromConnection = session.memoryConnectionRevision;
    try {
      const snapshot = await session.api.getAgentMemory(id);
      if (!active.current || request.current !== currentRequest || session.agents.deletedIds.has(id) ||
          session.memoryRevisionFor(id) !== fromRevision || session.memoryConnectionRevision !== fromConnection) return;
      setDraft((state) => state ? reloadMemoryBase(state, snapshot) : beginMemoryDraft(snapshot));
      setError("");
      setConflict(false);
      setShowCurrent(false);
    } catch (reason) {
      if (!active.current || request.current !== currentRequest ||
          session.memoryRevisionFor(id) !== fromRevision || session.memoryConnectionRevision !== fromConnection) return;
      if (reason instanceof GatewayError && reason.status === 404) { router.dismissTo("/"); return; }
      setReloadError(`重新载入失败，草稿仍在：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      operation.current = false;
      if (active.current) setReloading(false);
    }
  };

  if (session.agents.deletedIds.has(id)) return <Redirect href="/" />;
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <ScreenBar title={t("编辑记忆")} left={<Button testID="memory-editor-back" variant="ghost" size="icon" className="bg-transparent" accessibilityLabel={t("返回")} onPress={back}>
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
          <Text className="text-xs leading-[18px] text-muted-foreground">{t("这份记忆跨对话使用，成员各自独立。")}</Text>
          {draft.remote || conflict ? <View className="gap-2 rounded-[14px] border border-destructive p-3">
            <Text testID="memory-editor-conflict" className="text-sm">{draft.remote?.updated_by === "user" ? t("记忆已被用户更新。请先核对最新版本，再重新加载。") : t("记忆已在别处更新。请先核对最新版本，再重新加载。")}</Text>
            <View className="flex-row gap-2">
              <Button testID="memory-editor-view-current" variant="outline" size="sm" disabled={!draft.remote} onPress={() => setShowCurrent((value) => !value)}><Text>{showCurrent ? t("收起最新版本") : t("查看最新版本")}</Text></Button>
              <Button testID="memory-editor-reload" variant="outline" size="sm" disabled={reloading || saving} onPress={() => void reload()}><Text>{reloading ? t("加载中…") : t("重新加载")}</Text></Button>
            </View>
            <Text className="text-xs text-muted-foreground">{t("重新加载会保留草稿，之后保存将以草稿覆盖最新记忆，请先核对。")}</Text>
            {showCurrent && draft.remote ? <ScrollView testID="memory-editor-current" className="max-h-36 rounded-lg border border-border bg-card px-3 py-2">
              {draft.remote.content ? <AgentMemoryMarkdown content={draft.remote.content} /> : <Text className="text-sm text-muted-foreground">{t("当前记忆为空")}</Text>}
            </ScrollView> : null}
          </View> : null}
          {error ? <Text testID="memory-editor-error" className="text-sm text-destructive">{t(error)}</Text> : null}
          {reloadError ? <Text testID="memory-editor-reload-error" className="text-sm text-destructive">{t(reloadError)}</Text> : null}
          <Textarea testID="memory-editor-input" accessibilityLabel={t("记忆 Markdown")} editable={!saving && !reloading}
            value={draft.content} onChangeText={(content) => {
              setDraft((state) => state ? { ...state, content: normalizeMemory(content) } : state);
              setError("");
            }} placeholder={t("写下值得跨对话保留的背景…")}
            className="flex-1 border-0 bg-muted px-3.5 py-3 font-mono text-[13px] leading-[21px]" />
          <Text testID="memory-editor-count" className={`text-right text-xs ${count > limit ? "text-destructive" : "text-muted-foreground"}`}>
            {t("{count} / {limit} 字", { count, limit })}
          </Text>
          {count > limit ? <Text testID="memory-editor-overlimit" className="text-xs text-destructive">{t("超过上限 {count} 字，请自行精简，草稿不会截断。", { count: count - limit })}</Text> : null}
        </Animated.View>
      </KeyboardAvoidingView>}
    </View>
  );
}
