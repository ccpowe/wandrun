import { router } from 'expo-router';
import { ChevronRight, ImageOff } from 'lucide-react-native';
import { lazy, Suspense, useCallback, useMemo, useReducer, useState, useSyncExternalStore } from 'react';
import { PixelRatio, Pressable, View } from 'react-native';
import type { ImageProps } from 'expo-image';
import type { VideoGridCellProps } from './video-native.tsx';
import { FileTypeIcon } from '@/components/file-type-icon.tsx';
import { ActivityIndicator } from '@/components/ui/activity-indicator.tsx';
import { SurfacePressable } from '@/components/ui/surface-pressable.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import type { FilePreview, GatewayApi } from '@/gateway/api.ts';
import { thumbnailWidthForPixels, type AttachmentFile } from '@/lib/attachment-grid.ts';
import { leaseReducer, type LeaseState } from '@/lib/delivery-action.ts';
import { loadLocalImage, type LocalImageLease } from '@/lib/local-image.ts';
import { useMountEffect } from '@/lib/use-mount-effect.ts';
import { useTranslation } from '@/lib/i18n.ts';

// Native image/player modules are deferred for the legacy Node host, which has no Expo native view managers.
const LazyExpoImage = lazy(async () => ({ default: (await import('expo-image')).Image }));
function MediaImage(props: ImageProps) {
  return <Suspense fallback={<ActivityIndicator />}><LazyExpoImage {...props} /></Suspense>;
}
export type PreviewOverrides = Readonly<Record<string, FilePreview>>;
type PreviewState = { key: string; preview: FilePreview | null; failed: boolean };
const unavailable = { preview: null, failed: true };

/** Metadata stays in GatewayApi's existing owner; subscribe to it rather than mirror promises in an effect. */
export function useFilePreview(api: GatewayApi | undefined, fileId: string, overrides?: PreviewOverrides): PreviewState {
  const override = overrides?.[fileId];
  const fixed = useMemo(() => override ? { preview: override, failed: false } : unavailable, [override]);
  const subscribe = useCallback((listener: () => void) => api && !override ? api.subscribeFilePreview(fileId, listener) : () => {}, [api, fileId, override]);
  const snapshot = useCallback(() => api && !override ? api.filePreviewSnapshot(fileId) : fixed, [api, fileId, override, fixed]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { ...state, key: `${api?.resourceIdentity ?? 'dev'}:${fileId}` };
}

/** Only keyed resource children call this hook. Cleanup never publishes a released URI. */
function useImageLease(api: GatewayApi, load: (signal: AbortSignal) => Promise<LocalImageLease>) {
  const [state, dispatch] = useReducer(leaseReducer<string>, { status: 'loading' } as LeaseState<string>);
  useMountEffect(() => {
    let active = true;
    const controller = new AbortController();
    let lease: LocalImageLease | undefined;
    void load(controller.signal).then(value => {
      lease = value;
      if (active && !api.signal.aborted) dispatch({ type: 'ready', value: value.uri });
      else value.dispose();
    }, () => {
      if (active && !api.signal.aborted) dispatch({ type: 'failed', error: '' });
    });
    return () => { active = false; controller.abort(); lease?.dispose(); };
  });
  return { state, fail: () => dispatch({ type: 'failed', error: '' }) };
}

type ThumbnailProps = {
  file: AttachmentFile; api?: GatewayApi; width: number; height: number; onOpen(): void;
  previewOverrides?: PreviewOverrides; isVideo?: boolean; reloadOnActive?: boolean;
};
export function ThumbnailImage(props: ThumbnailProps) {
  const bucket = thumbnailWidthForPixels(props.width, PixelRatio.get());
  const [attempt, setAttempt] = useState(0);
  const retry = () => { props.api?.invalidateFileThumbnail(props.file.id, bucket); setAttempt(value => value + 1); };
  const key = `${props.api?.resourceIdentity}:${props.file.id}:${bucket}:${props.reloadOnActive ?? true}:${attempt}`;
  return <ThumbnailAccess key={key} {...props} bucket={bucket} onRetry={retry} />;
}
function ThumbnailAccess({ file, api, width, height, onOpen, bucket, isVideo = false, onRetry }: ThumbnailProps & {
  bucket: 240 | 480 | 960; onRetry(): void;
}) {
  const { t } = useTranslation();
  if (!api) return <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t(isVideo ? '播放视频 {name}' : '查看图片 {alt}', { name: file.name, alt: file.name })} style={{ width, height }}>
    {__DEV__ ? <MediaImage source={require('../../../assets/empty-together.png')} contentFit="cover" style={{ width: '100%', height: '100%' }} /> : null}
  </Pressable>;
  return <ThumbnailResource file={file} api={api} width={width} height={height} onOpen={onOpen} bucket={bucket} isVideo={isVideo} onRetry={onRetry} />;
}
function ThumbnailResource({ file, api, width, height, onOpen, bucket, isVideo, onRetry }: {
  file: AttachmentFile; api: GatewayApi; width: number; height: number; onOpen(): void;
  bucket: 240 | 480 | 960; isVideo: boolean; onRetry(): void;
}) {
  const { t } = useTranslation();
  const { state, fail } = useImageLease(api, signal => api.loadFileThumbnail(file.id, bucket, signal));
  if (state.status === 'failed' && !isVideo) return <View style={{ width, height }}><FallbackOriginalImage file={file} api={api} onOpen={onOpen} onRetry={onRetry} /></View>;
  if (state.status === 'loading' && !isVideo) return <View style={{ width, height }}><ActivityIndicator /></View>;
  return <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t(isVideo ? '播放视频 {name}' : '查看图片 {alt}', { name: file.name, alt: file.name })}
    className="items-center justify-center" style={{ width, height }}>
    {state.status === 'ready' ? <MediaImage source={{ uri: state.value }} contentFit="cover" cachePolicy="none" style={{ width: '100%', height: '100%' }} onError={() => { api.invalidateFileThumbnail(file.id, bucket); fail(); }} />
      : <FileTypeIcon mediaType={file.media_type} name={file.name} className="size-8 text-muted-foreground" />}
  </Pressable>;
}
function FallbackOriginalImage({ file, api, onOpen, onRetry }: { file: AttachmentFile; api: GatewayApi; onOpen(): void; onRetry(): void }) {
  const { t } = useTranslation();
  const { state, fail } = useImageLease(api, signal => loadLocalImage(api, `/files/${encodeURIComponent(file.id)}/content`, signal));
  if (state.status === 'loading') return <ActivityIndicator />;
  if (state.status === 'failed') return <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel={t('重新加载图片 {name}', { name: file.name })} testID="attachment-image-error" className="h-full w-full items-center justify-center bg-muted"><Icon as={ImageOff} className="size-6 text-muted-foreground" /></Pressable>;
  return <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t('查看图片 {alt}', { alt: file.name })} className="h-full w-full">
    <MediaImage source={{ uri: state.value }} contentFit="cover" cachePolicy="none" style={{ width: '100%', height: '100%' }} onError={fail} />
  </Pressable>;
}

export function openVideo(fileId: string): void {
  router.push({ pathname: '/video-player', params: { file_id: fileId } });
}
const LazyVideoGridCell = lazy(async () => ({ default: (await import('./video-native.tsx')).VideoGridCell }));
const LazyVideoPlayerScreen = lazy(async () => ({ default: (await import('./video-native.tsx')).VideoPlayerScreen }));
const LazyAudioCard = lazy(async () => ({ default: (await import('./audio-native.tsx')).AudioCard }));
export function VideoGridCell(props: VideoGridCellProps) {
  return <Suspense fallback={<View style={{ width: props.width, height: props.height }} className="items-center justify-center bg-muted"><ActivityIndicator /></View>}><LazyVideoGridCell {...props} /></Suspense>;
}
export function VideoPlayerScreen({ fileId, api }: { fileId?: string; api?: GatewayApi }) {
  return <Suspense fallback={<View className="flex-1 bg-immersive-surface" />}><LazyVideoPlayerScreen fileId={fileId} api={api} /></Suspense>;
}
export function AudioCard(props: { file: AttachmentFile; api?: GatewayApi; previewOverrides?: PreviewOverrides; compact?: boolean }) {
  return <Suspense fallback={<View className={props.compact ? 'px-3 py-2' : 'mt-2'}><ActivityIndicator /></View>}><LazyAudioCard {...props} /></Suspense>;
}

export function PdfCard({ file, api, previewOverrides, compact = false }: {
  file: AttachmentFile; api?: GatewayApi; previewOverrides?: PreviewOverrides; compact?: boolean;
}) {
  const { t } = useTranslation();
  const preview = useFilePreview(api, file.id, previewOverrides);
  if (preview.failed && api) return <AttachmentFallbackRow file={file} />;
  return <SurfacePressable testID={`attachment-pdf-${file.id}`} accessibilityRole="button" accessibilityLabel={t('查看文件 {name}', { name: file.name })} onPress={() => router.push({ pathname: '/files/[id]', params: { id: file.id } })}
    style={{ width: compact ? undefined : 300 }} className={compact ? 'flex-row items-center gap-3 px-3 py-2' : 'mt-2 flex-row items-center gap-3 rounded-lg bg-card p-3'}>
    <View className="h-[62px] w-12 items-center justify-center overflow-hidden rounded-sm bg-muted">
      {preview.preview ? api ? <PdfThumbnail key={`${api.resourceIdentity}:${file.id}`} api={api} fileId={file.id} /> : __DEV__ ? <MediaImage source={require('../../../assets/empty-together.png')} contentFit="cover" style={{ width: 48, height: 62 }} /> : <FileTypeIcon mediaType="application/pdf" name={file.name} className="size-6 text-muted-foreground" /> : <ActivityIndicator />}
    </View>
    <View className="min-w-0 flex-1"><Text variant="body" numberOfLines={1}>{file.name}</Text><Text variant="caption" className="text-muted-foreground">{preview.preview?.page_count ? t('{count} 页', { count: preview.preview.page_count }) : t('PDF')} · {Math.ceil(file.size / 1024)} KB</Text></View>
    <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
  </SurfacePressable>;
}
function PdfThumbnail({ api, fileId }: { api: GatewayApi; fileId: string }) {
  const { state, fail } = useImageLease(api, signal => api.loadFileThumbnail(fileId, 240, signal));
  return state.status === 'ready' ? <MediaImage source={{ uri: state.value }} contentFit="cover" cachePolicy="none" style={{ width: 48, height: 62 }} onError={fail} /> : <FileTypeIcon mediaType="application/pdf" name={fileId} className="size-6 text-muted-foreground" />;
}
function AttachmentFallbackRow({ file }: { file: AttachmentFile }) {
  return <SurfacePressable onPress={() => router.push({ pathname: '/files/[id]', params: { id: file.id } })} className="mt-2 min-h-[52px] flex-row items-center gap-3 rounded-lg bg-card px-3">
    <View className="size-8 items-center justify-center rounded-md bg-muted"><FileTypeIcon mediaType={file.media_type} name={file.name} className="size-5 text-muted-foreground" /></View>
    <Text variant="body" numberOfLines={1} className="min-w-0 flex-1">{file.name}</Text><Icon as={ChevronRight} className="size-4 text-muted-foreground" />
  </SurfacePressable>;
}
