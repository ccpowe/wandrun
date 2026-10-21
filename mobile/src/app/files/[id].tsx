import { Directory, File, Paths } from "expo-file-system";
import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from "expo-router";
import * as Sharing from "expo-sharing";
import { ArrowLeft, Download, Share2 } from "lucide-react-native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import type { FileDetail } from "@/gateway/api.ts";
import { DeliveryCache, previewKind, TEXT_PREVIEW_BYTES, type CachedDownload } from "@/lib/file-delivery.ts";
import { saveNativeFile } from "@/lib/native-file-save.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { useSession } from "@/lib/session-context.tsx";
import { UserFacingError, userErrorMessage } from "@/lib/user-error.ts";

const deliveryCaches = new Map<string, DeliveryCache>();
function nativeDeliveryCache(computerId: string): DeliveryCache {
  // Expo's web FileSystem has no Directory implementation. Never construct it
  // when a route module is imported by the web router/server renderer.
  let cache = deliveryCaches.get(computerId);
  if (!cache) {
    const directory = new Directory(Paths.cache, "wandrun-delivery", encodeURIComponent(computerId));
    cache = new DeliveryCache({
      create: () => directory.create({ intermediates: true, idempotent: true }),
      list: () => directory.list().filter((entry): entry is File => entry instanceof File),
      file: (name) => new File(directory, name),
      download: async (url, destination, headers) => {
        // SDK 57 Android may leave a cancelled buffered read unsettled. Let the
        // old request finish in its original computer's private cache instead.
        const task = File.createDownloadTask(url, new File(destination.uri), { headers });
        if (!await task.downloadAsync()) throw new Error("下载未完成");
      },
    });
    deliveryCaches.set(computerId, cache);
  }
  return cache;
}

type FileAction = "download" | "share";
type FileActionScope = { key: string; valid: boolean; pending: boolean; probe: AbortController };

export default function FileScreen() {
  const { t, locale } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const computerId = session?.api.config.computerId;
  const insets = useSafeAreaInsets();
  const [metadata, setMetadata] = useState<{ key: string; file: FileDetail | null; error: string | null }>({ key: "", file: null, error: null });
  const [preview, setPreview] = useState<{ key: string; content: string | null; imageUri: string | null; error: string | null }>({ key: "", content: null, imageUri: null, error: null });
  const [actionError, setActionError] = useState<{ key: string; message: string | null }>({ key: "", message: null });
  const [cacheError, setCacheError] = useState<{ key: string; message: string | null }>({ key: "", message: null });
  const [working, setWorking] = useState<{ key: string; action: FileAction } | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const focused = useIsFocused();
  const actionScope = useRef<FileActionScope | null>(null);

  useFocusEffect(useCallback(() => {
    refresh((value) => value + 1);
    if (Platform.OS !== "web" && computerId) {
      try {
        nativeDeliveryCache(computerId).prune();
        setCacheError({ key: `${computerId}:${id}`, message: null });
      } catch (cause) {
        setCacheError({ key: `${computerId}:${id}`, message: userErrorMessage(cause, "无法清理文件缓存，请重新打开文件后重试") });
      }
    }
  }, [id, computerId]));
  const requestKey = `${computerId}:${id}:${revision}`;
  // Layout-effect ownership ends at blur, unmount or a different file/revision.
  // No render reads or writes the ref; async work only holds its local scope.
  useLayoutEffect(() => {
    if (!focused) return;
    const scope: FileActionScope = { key: requestKey, valid: true, pending: false, probe: new AbortController() };
    actionScope.current = scope;
    const onApiClosed = () => { scope.valid = false; scope.probe.abort(); };
    session?.api.signal.addEventListener("abort", onApiClosed, { once: true });
    if (session?.api.signal.aborted) onApiClosed();
    return () => {
      scope.valid = false;
      scope.probe.abort();
      session?.api.signal.removeEventListener("abort", onApiClosed);
    };
  }, [requestKey, focused, session]);
  const busy = focused && working?.key === requestKey;
  useEffect(() => {
    if (!session || !computerId || !id || !focused || Platform.OS === "web") return;
    let active = true;
    void session.api.getFile(id).then((detail) => {
      if (active && !session.api.signal.aborted) setMetadata({ key: requestKey, file: detail, error: null });
    }).catch((cause: unknown) => {
      if (active && !session.api.signal.aborted) setMetadata({ key: requestKey, file: null, error: userErrorMessage(cause, "无法读取文件信息，请重试") });
    });
    return () => { active = false; };
  }, [session, computerId, id, requestKey, focused]);

  const file = metadata.key === requestKey ? metadata.file : null;
  const loading = metadata.key !== requestKey;
  const error = metadata.key === requestKey ? metadata.error : null;
  const kind = file ? previewKind(file) : "other";
  const fileId = file?.id;
  const fileName = file?.name;
  const fileSize = file?.size;
  const fileMediaType = file?.media_type;
  const fileAvailable = file?.available;
  const previewKey = `${requestKey}:${fileId}:${fileSize}:${fileMediaType}:${fileAvailable}`;
  const content = kind === "text" && fileSize === 0 ? "" : preview.key === previewKey ? preview.content : null;
  const imageUri = focused && preview.key === previewKey ? preview.imageUri : null;
  const previewError = preview.key === previewKey ? preview.error : null;
  useEffect(() => {
    if (Platform.OS === "web" || !focused || !session || !computerId || !fileId || fileName === undefined || !fileAvailable || kind === "other" ||
        (kind === "text" && fileSize === 0)) return;
    let active = true;
    const probe = new AbortController();
    const transfer = new AbortController();
    const onApiClosed = () => transfer.abort();
    session.api.signal.addEventListener("abort", onApiClosed, { once: true });
    if (session.api.signal.aborted) transfer.abort();
    let cached: CachedDownload | null = null;
    const options = kind === "text"
      ? session.api.headers({ Range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` })
      : session.api.headers();
    void (async () => {
      try {
        cached = await nativeDeliveryCache(computerId).download(session.api.fileContentUrl(fileId),
          { name: fileName, media_type: fileMediaType! }, options, transfer.signal);
        if (!active || session.api.signal.aborted) return;
        if (kind === "text") {
          const body = await cached.file.text();
          if (active && !session.api.signal.aborted) setPreview({ key: previewKey, content: body, imageUri: null, error: null });
        } else setPreview({ key: previewKey, content: null, imageUri: cached.file.uri, error: null });
      } catch (cause) {
        if (active && !session.api.signal.aborted) {
          setPreview({ key: previewKey, content: null, imageUri: null, error: userErrorMessage(cause, "无法预览文件，请重试或下载后打开") });
          void session.api.getFile(fileId).then((detail) => {
            if (active && !session.api.signal.aborted) setMetadata({ key: requestKey, file: detail, error: null });
          }).catch(() => {});
          void session.api.checkUnauthorized(probe.signal);
        }
      } finally {
        if (!active || session.api.signal.aborted || kind === "text") cached?.release();
      }
    })();
    return () => {
      active = false;
      probe.abort();
      transfer.abort();
      session.api.signal.removeEventListener("abort", onApiClosed);
      // The native Image may read its URI until the view unmounts.
      cached?.release();
    };
  }, [session, computerId, focused, fileId, fileName, fileSize, fileMediaType, fileAvailable, kind, previewKey, requestKey]);

  const openNative = async (action: FileAction) => {
    const scope = actionScope.current;
    if (Platform.OS === "web" || !session || !computerId || !file || !focused || !scope?.valid || scope.key !== requestKey || scope.pending) return;
    const current = () => scope.valid && actionScope.current === scope;
    scope.pending = true;
    setWorking({ key: requestKey, action });
    setSavedKey(null);
    setActionError({ key: requestKey, message: null });
    let cached: CachedDownload | null = null;
    let operationFailed = false;
    try {
      const detail = await session.api.getFile(file.id);
      if (!current()) return;
      setMetadata({ key: requestKey, file: detail, error: null });
      if (!detail.available) return;
      if (action === "download") {
        const saved = await saveNativeFile(session.api.fileContentUrl(file.id, true),
          session.api.headers(), detail, current, session.api.signal);
        if (saved && current()) setSavedKey(requestKey);
        return;
      }
      if (!await Sharing.isAvailableAsync()) throw new UserFacingError("此设备不支持系统文件分享");
      if (!current()) return;
      cached = await nativeDeliveryCache(computerId).download(session.api.fileContentUrl(file.id, true),
        detail, session.api.headers(), session.api.signal);
      // Blur, unmount or a different file invalidates only a handoff not yet
      // started. Once native receives the URI, share() owns its read lease.
      if (!current()) return;
      await cached.share((uri) => Sharing.shareAsync(uri, { mimeType: detail.media_type, dialogTitle: detail.name }));
    } catch (cause) {
      operationFailed = true;
      if (current()) {
        setActionError({ key: requestKey, message: userErrorMessage(cause, action === "download" ? "无法保存文件，请检查网络、存储空间和文件权限后重试" : "无法分享文件，请重新打开文件后重试") });
        // A once-registered original may have disappeared between metadata and download.
        void session.api.getFile(file.id).then((detail) => {
          if (current()) setMetadata({ key: requestKey, file: detail, error: null });
        }).catch(() => {});
        void session.api.checkUnauthorized(scope.probe.signal);
      }
    } finally {
      try {
        cached?.release();
      } catch (cause) {
        if (current() && !operationFailed) setActionError({ key: requestKey, message: userErrorMessage(cause, "无法清理文件缓存，请重新打开文件后重试") });
      } finally {
        scope.pending = false;
        if (current()) setWorking(null);
      }
    }
  };

  const agentName = session?.agents.agents.find((agent) => agent.id === file?.agent_id)?.name;
  const sourceId = file?.conversation_id && !session?.isDeleted(file.conversation_id) ? file.conversation_id : null;
  const conversation = sourceId ? session?.conversations.get(sourceId) : null;
  if (Platform.OS === "web") return <View className="flex-1 items-center justify-center bg-background p-8">
    <Stack.Screen options={{ headerShown: false }} />
    <Text className="text-center text-muted-foreground">{t("文件预览与系统分享仅支持移动设备")}</Text>
  </View>;
  return <View className="flex-1 bg-background" style={{ paddingBottom: insets.bottom }}>
    <Stack.Screen options={{ headerShown: false }} />
    <View className="flex-row items-center gap-3 border-b border-border px-4 py-3" style={{ paddingTop: insets.top + 12 }}>
      <Button variant="ghost" size="icon" aria-label={t("返回")} onPress={() => router.back()}><Icon as={ArrowLeft} className="size-5" /></Button>
      <Text numberOfLines={1} className="min-w-0 flex-1 text-lg font-semibold">{file?.name ?? t("文件")}</Text>
      <View className="flex-row items-center gap-1">
        <Button testID="file-download" variant="ghost" size="icon" className="size-11 bg-transparent"
          aria-label={busy && working.action === "download" ? t("正在保存文件") : t("下载文件")}
          disabled={!file?.available || busy} onPress={() => void openNative("download")}>
          {busy && working.action === "download" ? <ActivityIndicator size="small" /> : <Icon as={Download} className="size-5" />}
        </Button>
        <Button testID="file-share" variant="ghost" size="icon" className="size-11 bg-transparent"
          aria-label={busy && working.action === "share" ? t("正在准备分享") : t("分享文件")}
          disabled={!file?.available || busy} onPress={() => void openNative("share")}>
          {busy && working.action === "share" ? <ActivityIndicator size="small" /> : <Icon as={Share2} className="size-5" />}
        </Button>
      </View>
    </View>
    {cacheError.key === `${computerId}:${id}` && cacheError.message && <Text testID="file-cache-error" className="px-5 py-2 text-center text-destructive">{t(cacheError.message)}</Text>}
    {file?.available !== false && actionError.key === requestKey && actionError.message && <Text testID="file-action-error" accessibilityLiveRegion="polite" className="px-5 py-2 text-center text-destructive">{t(actionError.message)}</Text>}
    {savedKey === requestKey && <Text testID="file-saved" accessibilityLiveRegion="polite" className="px-5 py-2 text-center text-muted-foreground">{t("已保存到所选位置")}</Text>}
    {loading ? <ActivityIndicator className="mt-20" /> : error ? <View className="items-center gap-3 p-8"><Text className="text-destructive">{t(error)}</Text><Button variant="outline" onPress={() => refresh((value) => value + 1)}><Text>{t("重试")}</Text></Button></View> : file && <>
      <View className="border-b border-border px-5 py-4">
        <Text className="text-sm text-muted-foreground">{file.source === "user_upload" ? t("我上传的文件") : agentName ?? t("Agent 暂不可用")} · {conversation?.title ?? (sourceId ? t("来源对话") : file.conversation_id ? t("来源对话已删除") : t("无来源对话"))} · {new Date(file.created_at * 1000).toLocaleString(locale)}</Text>
        <Text className="mt-1 text-xs text-muted-foreground">{file.name} · {Math.ceil(file.size / 1024)} KB</Text>
      </View>
      <ScrollView className="flex-1" contentContainerClassName="min-h-full px-5 py-6">
        {!file.available ? <View testID="file-unavailable" className="items-center gap-3 rounded-2xl border border-border bg-muted p-8"><FileTypeIcon mediaType={file.media_type} className="size-8 text-muted-foreground" /><Text className="text-center font-medium">{file.error_message ? t(file.error_message) : t("文件暂不可用")}</Text></View>
          : kind === "other" ? <View className="items-center gap-3 rounded-2xl border border-border bg-card p-8"><FileTypeIcon mediaType={file.media_type} className="size-9 text-muted-foreground" /><Text className="font-medium">{t("此格式不支持应用内预览")}</Text><Text className="text-center text-sm text-muted-foreground">{t("可下载文件，或分享给其他应用打开。")}</Text></View>
          : kind === "image" ? imageUri ? <Image testID="file-image-preview" source={{ uri: imageUri }} resizeMode="contain" className="w-full" style={{ height: 440 }} /> : !previewError ? <ActivityIndicator /> : null
          : content !== null ? <View testID="file-text-preview">{file.media_type.split(";", 1)[0].toLowerCase() === "text/markdown"
              ? <AgentMemoryMarkdown content={content} />
              : <Text selectable className="text-base leading-7">{content}</Text>}
              {file.size > TEXT_PREVIEW_BYTES && <Text className="mt-4 text-sm text-muted-foreground">{t("仅预览前 1 MB，下载查看完整内容。")}</Text>}
            </View> : !previewError ? <ActivityIndicator /> : null}
        {file.available && previewError && <Text className="mt-3 text-center text-destructive">{t(previewError)}</Text>}
      </ScrollView>
    </>}
  </View>;
}
