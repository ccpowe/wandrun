import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { lazy, Suspense, useEffect, useState } from "react";
import * as ReactNative from "react-native";

import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { FilePreview, GatewayApi } from "@/gateway/api.ts";
import { thumbnailWidthForPixels, type AttachmentFile } from "@/lib/attachment-grid.ts";
import { useTranslation } from "@/lib/i18n.ts";
import type { ImageProps } from "expo-image";

const { ActivityIndicator, Pressable, View } = ReactNative;
function MediaImage(props: ImageProps) {
  return <Suspense fallback={<ActivityIndicator />}><LazyExpoImage {...props} /></Suspense>;
}

function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    void import("react-native").then((module) => {
      const value = module.PixelRatio?.get?.();
      if (value && Number.isFinite(value)) setRatio(value);
    }).catch(() => {});
  }, []);
  return ratio;
}
const LazyExpoImage = lazy(async () => {
  const module = await import("expo-image");
  return { default: module.Image };
});

export type PreviewOverrides = Readonly<Record<string, FilePreview>>;

type PreviewState = { key: string; preview: FilePreview | null; failed: boolean };

export function useFilePreview(api: GatewayApi | undefined, fileId: string, overrides?: PreviewOverrides): PreviewState {
  const override = overrides?.[fileId];
  const key = `${api?.config.computerId ?? "dev"}:${fileId}:${override ? JSON.stringify(override) : "gateway"}`;
  const [state, setState] = useState<PreviewState>({ key: "", preview: null, failed: false });
  useEffect(() => {
    if (!api || override) return;
    let active = true;
    void api.getFilePreview(fileId).then((preview) => {
      if (active && !api.signal.aborted) setState({ key, preview, failed: false });
    }).catch(() => {
      if (active && !api.signal.aborted) setState({ key, preview: null, failed: true });
    });
    return () => { active = false; };
  }, [api, fileId, key, override]);
  if (override) return { key, preview: override, failed: false };
  if (!api) return { key, preview: null, failed: true };
  return state.key === key ? state : { key, preview: null, failed: false };
}

export function ThumbnailImage({ file, api, width, height, onOpen, previewOverrides, isVideo = false }: {
  file: AttachmentFile;
  api?: GatewayApi;
  width: number;
  height: number;
  onOpen: () => void;
  previewOverrides?: PreviewOverrides;
  isVideo?: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ api?: GatewayApi; key: string; uri: string | null; failed: boolean }>({ key: "", uri: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  const bucket = thumbnailWidthForPixels(width, useDevicePixelRatio());
  const key = `${api?.config.computerId ?? "dev"}:${file.id}:${bucket}:${attempt}`;
  useEffect(() => {
    if (!api) return;
    let active = true;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void api.loadFileThumbnail(file.id, bucket, controller.signal).then((lease) => {
      dispose = lease.dispose;
      if (active && !api.signal.aborted) setState({ api, key, uri: lease.uri, failed: false });
      else lease.dispose();
    }).catch(() => {
      if (active && !api.signal.aborted) setState({ api, key, uri: null, failed: true });
    });
    return () => {
      active = false;
      controller.abort();
      dispose?.();
    };
  }, [api, bucket, file.id, key]);
  const source = state.api === api && state.key === key ? state.uri : null;
  const devPlaceholder = __DEV__ && !api && (file.id.startsWith("attachment-preview-image-") || file.id.startsWith("attachment-preview-video-"));
  const fallbackImage = !isVideo && state.api === api && state.key === key && state.failed;
  if (fallbackImage) {
    return <View style={{ width, height }}><MediaPictureFallback key={key} file={file} api={api} onOpen={onOpen}
      onRetry={() => {
        api?.invalidateFileThumbnail(file.id, bucket);
        setAttempt((value) => value + 1);
      }} /></View>;
  }
  if (!source && !devPlaceholder && !isVideo) return <View style={{ width, height }}><ActivityIndicator /></View>;
  return <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t(isVideo ? "播放视频 {name}" : "查看图片 {alt}", isVideo ? { name: file.name } : { alt: file.name })}
    className="h-full w-full items-center justify-center" style={{ width, height }}>
    {source || devPlaceholder ? <MediaImage source={devPlaceholder ? require("../../../assets/empty-together.png") : { uri: source! }} contentFit="cover" cachePolicy="none" style={{ width: "100%", height: "100%" }}
      onError={isVideo || devPlaceholder ? undefined : () => setState({ api, key, uri: null, failed: true })} /> : <FileTypeIcon mediaType={file.media_type} className="size-8 text-muted-foreground" />}
  </Pressable>;
}

function MediaPictureFallback({ file, api, onOpen, onRetry }: {
  file: AttachmentFile; api?: GatewayApi; onOpen: () => void; onRetry: () => void;
}) {
  if (!api) return <MediaImage source={require("../../../assets/empty-together.png")} contentFit="cover" style={{ width: "100%", height: "100%" }} />;
  return <FallbackOriginalImage file={file} api={api} onOpen={onOpen} onRetry={onRetry} />;
}

function FallbackOriginalImage({ file, api, onOpen, onRetry }: {
  file: AttachmentFile; api: GatewayApi; onOpen: () => void; onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ api?: GatewayApi; fileId?: string; uri: string | null; failed: boolean }>({ uri: null, failed: false });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let dispose: (() => void) | undefined;
    void import("@/lib/local-image.ts").then(({ loadLocalImage }) => loadLocalImage(api, `/files/${encodeURIComponent(file.id)}/content`, controller.signal)).then((lease) => {
      dispose = lease.dispose;
      if (active && !api.signal.aborted) setState({ api, fileId: file.id, uri: lease.uri, failed: false });
      else lease.dispose();
    }).catch(() => {
      if (active && !api.signal.aborted) setState({ api, fileId: file.id, uri: null, failed: true });
    });
    return () => { active = false; controller.abort(); dispose?.(); };
  }, [api, file.id]);
  if (state.api !== api || state.fileId !== file.id) return <ActivityIndicator />;
  if (state.failed) return <View className="h-full w-full items-center justify-center bg-muted px-2">
    <Text className="text-center text-xs text-destructive" testID="attachment-image-error">{t("图片暂不可用")}</Text>
    <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel={t("重试加载图片")} testID="attachment-image-retry" className="mt-2 rounded-lg bg-card px-3 py-2">
      <Text className="text-xs">{t("重试加载图片")}</Text>
    </Pressable>
  </View>;
  return state.uri ? <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t("查看图片 {alt}", { alt: file.name })} className="h-full w-full">
    <MediaImage source={{ uri: state.uri }} contentFit="cover" cachePolicy="none" style={{ width: "100%", height: "100%" }}
      onError={() => setState({ api, fileId: file.id, uri: null, failed: true })} />
  </Pressable> : <ActivityIndicator />;
}


export function openVideo(fileId: string): void {
  router.push({ pathname: "/video-player", params: { file_id: fileId } });
}
const LazyVideoGridCell = lazy(async () => {
  const module = await import("./video-native.tsx");
  return { default: module.VideoGridCell };
});
const LazyVideoPlayerScreen = lazy(async () => {
  const module = await import("./video-native.tsx");
  return { default: module.VideoPlayerScreen };
});
const LazyAudioCard = lazy(async () => {
  const module = await import("./audio-native.tsx");
  return { default: module.AudioCard };
});

export function VideoGridCell(props: import("./video-native.tsx").VideoGridCellProps) {
  return <Suspense fallback={<View style={{ width: props.width, height: props.height }} className="items-center justify-center bg-muted"><ActivityIndicator /></View>}>
    <LazyVideoGridCell {...props} />
  </Suspense>;
}

export function VideoPlayerScreen({ fileId, api }: { fileId?: string; api?: GatewayApi }) {
  return <Suspense fallback={<View className="flex-1 bg-black" />}><LazyVideoPlayerScreen fileId={fileId} api={api} /></Suspense>;
}

export function AudioCard(props: { file: AttachmentFile; api?: GatewayApi; previewOverrides?: PreviewOverrides; compact?: boolean }) {
  return <Suspense fallback={<View className={props.compact ? "px-3 py-2" : "mt-2"}><ActivityIndicator /></View>}><LazyAudioCard {...props} /></Suspense>;
}




export function PdfCard({ file, api, previewOverrides, compact = false }: {
  file: AttachmentFile; api?: GatewayApi; previewOverrides?: PreviewOverrides; compact?: boolean;
}) {
  const { t } = useTranslation();
  const preview = useFilePreview(api, file.id, previewOverrides);
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const key = `${api?.config.computerId ?? "dev"}:${file.id}:pdf`;
  const devThumbnail = __DEV__ && !api && preview.preview ? require("../../../assets/empty-together.png") : null;
  useEffect(() => {
    let active = true;
    if (!api || preview.failed || !preview.preview) return () => { active = false; };
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void api.loadFileThumbnail(file.id, 240, controller.signal).then((lease) => {
      dispose = lease.dispose;
      if (active) setThumbnail(lease.uri);
      else lease.dispose();
    }).catch(() => { if (active) setThumbnail(null); });
    return () => { active = false; controller.abort(); dispose?.(); };
  }, [api, file.id, key, preview.failed, preview.preview]);
  if (preview.failed && api) return <AttachmentFallbackRow file={file} />;
  return <Pressable testID={`attachment-pdf-${file.id}`} accessibilityRole="button" accessibilityLabel={`查看文件 ${file.name}`} onPress={() => router.push({ pathname: "/files/[id]", params: { id: file.id } })}
    style={{ width: compact ? undefined : 300 }} className={compact ? "flex-row items-center gap-3 px-3 py-2" : "mt-2 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-2.5 py-2.5 active:bg-muted"}>
    <View className="h-[62px] w-12 items-center justify-center overflow-hidden rounded bg-muted">
      {thumbnail || devThumbnail ? <MediaImage source={thumbnail ? { uri: thumbnail } : devThumbnail} contentFit="cover" cachePolicy="none" style={{ width: 48, height: 62 }} /> : preview.preview ? <FileTypeIcon mediaType="application/pdf" className="size-6 text-muted-foreground" /> : <ActivityIndicator />}
    </View>
    <View className="min-w-0 flex-1"><Text numberOfLines={1} className="font-medium">{file.name}</Text>
      <Text className="text-xs text-muted-foreground">{preview.preview?.page_count ? t("{count} 页", { count: preview.preview.page_count }) : t("PDF")} · {Math.ceil(file.size / 1024)} KB</Text></View>
    <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
  </Pressable>;
}

function AttachmentFallbackRow({ file }: { file: AttachmentFile }) {
  return <Pressable onPress={() => router.push({ pathname: "/files/[id]", params: { id: file.id } })} className="mt-2 min-h-[52px] flex-row items-center gap-2.5 rounded-2xl border border-border bg-card px-3">
    <View className="size-8 items-center justify-center rounded-[9px] bg-muted"><FileTypeIcon mediaType={file.media_type} className="size-[18px] text-muted-foreground" /></View>
    <Text numberOfLines={1} className="min-w-0 flex-1 text-sm">{file.name}</Text><Icon as={ChevronRight} className="size-4 text-muted-foreground" />
  </Pressable>;
}