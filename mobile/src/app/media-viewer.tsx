import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MediaPicture, type MediaLocation } from '@/components/rich-message/media.tsx';
import { MermaidViewer } from '@/components/rich-message/mermaid.tsx';
import { viewerMedia } from '@/components/rich-message/media-viewer-source.ts';
import { MAX_MEDIA_ZOOM, moveMediaZoom, RESET_ZOOM, type Size } from '@/components/rich-message/media-zoom.ts';
import { Button } from '@/components/ui/button.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import { useSession } from '@/lib/session-context.tsx';
import { viewerIndex } from '@/lib/attachment-grid.ts';
import { useTranslation } from '@/lib/i18n.ts';
import type { FileRecord, GatewayApi } from '@/gateway/api.ts';

type ViewerAttachment = Pick<FileRecord, 'id' | 'name' | 'media_type'>;

/** Fullscreen route keeps only opaque message coordinates or file IDs in navigation, never URLs or tokens. */
export default function MediaViewer() {
  const { t } = useTranslation();
  const { id, seq, block, element, index, alt, file_id, file_ids } = useLocalSearchParams<{
    id?: string; seq?: string; block?: string; element?: string; index?: string; alt?: string; file_id?: string; file_ids?: string;
  }>();
  const session = useSession();
  const insets = useSafeAreaInsets();
  const numericSeq = Number(seq);
  const numericIndex = Number(index ?? 0);
  const numericBlock: number | 'markdown' = block === 'markdown' ? 'markdown' : Number(block);
  const hasRichCoordinates = !!(id && seq && block !== undefined && element);
  const valid = hasRichCoordinates && Number.isSafeInteger(numericSeq) && numericSeq > 0 &&
    Number.isSafeInteger(numericIndex) && numericIndex >= 0 &&
    (numericBlock === 'markdown' || Number.isSafeInteger(numericBlock) && numericBlock >= 0);
  const location = useMemo<MediaLocation | undefined>(() => valid ? {
    conversationId: id!, messageSeq: numericSeq, block: numericBlock, element: element!, index: numericIndex,
  } : undefined, [valid, id, numericSeq, numericBlock, element, numericIndex]);
  const richEvent = session && id && location ? session.messageAt(id, numericSeq) : undefined;
  const event = session && id && file_id ? session.timeline(id).events.find((candidate) => candidate.seq === numericSeq) : undefined;
  const selected = useMemo(() => {
    if (!location) return null;
    return richEvent && typeof richEvent.data.text === 'string'
      ? viewerMedia(richEvent.data.text, location, Array.isArray(richEvent.data.ui) ? richEvent.data.ui : undefined,
        Array.isArray(richEvent.data.attachments) ? richEvent.data.attachments : undefined) : null;
  }, [richEvent, location]);
  const attachmentImages = useMemo(() => attachmentFiles(event?.data.attachments, file_ids, file_id), [event, file_ids, file_id]);
  const attachmentStart = viewerIndex(attachmentImages.map((file) => file.id), file_id, numericIndex);
  const attachment = file_id && attachmentImages[attachmentStart] ? attachmentImages[attachmentStart] : undefined;
  const mermaid = selected?.mermaid;
  const attachmentMode = !!file_id && !!attachment;
  return <View className={attachmentMode ? "flex-1 bg-black" : "flex-1 bg-background"} style={{ paddingTop: insets.top, paddingBottom: insets.bottom }} testID="media-viewer">
    <Stack.Screen options={{ headerShown: false }} />
    {mermaid !== undefined && location && selected
      ? <MermaidViewer key={`${id}:${seq}:${block}:${element}:${index}`} source={mermaid} title={alt || t('流程图')} full onBack={() => router.back()} />
      : attachmentMode
        ? <AttachmentGallery api={session?.api} files={attachmentImages} initialIndex={attachmentStart} onBack={() => router.back()} />
        : <>
          <View className="flex-row items-center gap-2 border-b border-border px-4 py-2">
            <Button variant="ghost" size="icon" aria-label={t('返回')} onPress={() => router.back()}><Icon as={ArrowLeft} className="size-5" /></Button>
            <Text numberOfLines={1} className="min-w-0 flex-1 font-semibold">{alt || t('高清查看')}</Text>
          </View>
          <View className="min-h-0 flex-1 p-3">{location && selected
            ? <ZoomablePicture key={`${id}:${seq}:${block}:${element}:${index}`} api={session?.api} location={location} fileId={selected.fileId} alt={alt ?? t('媒体')} />
            : <Text className="p-4 text-destructive">{t('媒体位置无效或图片已不可用')}</Text>}</View>
          {selected?.caption ? <ScrollView className="max-h-[40%] border-t border-border px-4 py-3" testID="media-viewer-caption">
            <Text selectable className="text-sm leading-6">{selected.caption}</Text>
          </ScrollView> : null}
        </>}
  </View>;
}

function attachmentFiles(raw: unknown, serializedIds: string | undefined, selectedId: string | undefined): ViewerAttachment[] {
  const metadata = Array.isArray(raw) ? raw.filter((file): file is ViewerAttachment => !!file && typeof file === 'object' &&
    typeof (file as Record<string, unknown>).id === 'string' && typeof (file as Record<string, unknown>).media_type === 'string' &&
    String((file as Record<string, unknown>).media_type).toLowerCase().startsWith('image/')).map((file) => ({
      id: file.id, name: file.name || file.id, media_type: file.media_type,
    })) : [];
  let ids: string[] = [];
  if (serializedIds) {
    try {
      const parsed: unknown = JSON.parse(serializedIds);
      if (Array.isArray(parsed)) ids = parsed.filter((value): value is string => typeof value === 'string');
    } catch {
      ids = [];
    }
  }
  const byId = new Map(metadata.map((file) => [file.id, file]));
  const ordered = (ids.length ? ids : metadata.map((file) => file.id)).map((id) => byId.get(id) ?? { id, name: id, media_type: 'image/*' });
  if (selectedId && !ordered.some((file) => file.id === selectedId)) ordered.push({ id: selectedId, name: selectedId, media_type: 'image/*' });
  return ordered;
}

function AttachmentGallery({ api, files, initialIndex, onBack }: { api?: GatewayApi; files: readonly ViewerAttachment[]; initialIndex: number; onBack: () => void }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const list = useRef<FlatList<ViewerAttachment>>(null);
  const [page, setPage] = useState(initialIndex);
  const [zoomedPage, setZoomedPage] = useState<number | null>(null);
  useEffect(() => {
    list.current?.scrollToIndex({ index: initialIndex, animated: false });
  }, [initialIndex]);
  return <View className="flex-1 bg-black" testID="media-attachment-gallery">
    <View className="z-10 flex-row items-center gap-2 px-4 py-2">
      <Button variant="ghost" size="icon" className="bg-transparent" aria-label={t('返回')} onPress={onBack}><Icon as={ArrowLeft} className="size-5 text-white" /></Button>
      <Text className="text-sm text-white">{page + 1} / {files.length}</Text>
    </View>
    <FlatList ref={list} className="min-h-0 flex-1" data={files} horizontal pagingEnabled scrollEnabled={zoomedPage === null}
      initialScrollIndex={initialIndex} keyExtractor={(file) => file.id} showsHorizontalScrollIndicator={false}
      windowSize={3} initialNumToRender={1} maxToRenderPerBatch={3}
      getItemLayout={(_, index) => ({ index, length: width, offset: index * width })}
      onMomentumScrollEnd={(event) => {
        const next = Math.min(files.length - 1, Math.max(0, Math.round(event.nativeEvent.contentOffset.x /
          Math.max(1, event.nativeEvent.layoutMeasurement.width))));
        setPage(next);
        setZoomedPage(null);
      }}
      renderItem={({ item, index }) => <View style={{ width }} className="flex-1">
        <ZoomablePicture api={api} fileId={item.id} alt={item.name} onSwipeDown={onBack}
          onZoomChange={(value) => {
            if (index === page) setZoomedPage(value > 1.01 ? index : null);
          }} />
      </View>} />
  </View>;
}

function ZoomablePicture({ api, location, fileId, alt, onSwipeDown, onZoomChange }: {
  api?: GatewayApi; location?: MediaLocation; fileId?: string; alt: string;
  onSwipeDown?: () => void; onZoomChange?: (zoom: number) => void;
}) {
  const { t, locale } = useTranslation();
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const image = useSharedValue<Size>({ w: 0, h: 0 });
  const viewport = useSharedValue<Size>({ w: 0, h: 0 });
  const view = useSharedValue(RESET_ZOOM);
  const last = useSharedValue({ x: 0, y: 0, scale: 1 });
  const [zoom, setZoom] = useState(1);
  const reportZoom = useCallback((value: number) => {
    setZoom(value);
    onZoomChange?.(value);
  }, [onZoomChange]);
  useAnimatedReaction(() => Math.round(view.get().z * 10) / 10, (value, previous) => {
    if (value !== previous) scheduleOnRN(reportZoom, value);
  }, [reportZoom]);
  const adjustZoom = (factor: number) => {
    const size = viewport.get();
    const center = { x: size.w / 2, y: size.h / 2 };
    view.set(moveMediaZoom(view.get(), center, center, factor, size, image.get()));
  };
  const onDimensions = useCallback((w: number, h: number) => {
    const current = image.get();
    if (current.w !== w || current.h !== h) {
      image.set({ w, h });
      view.set(RESET_ZOOM);
    }
  }, [image, view]);
  useEffect(() => {
    viewport.set(box);
    view.set(RESET_ZOOM);
  }, [box, viewport, view]);
  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onStart((event) => { last.set({ x: event.focalX, y: event.focalY, scale: 1 }); })
      .onUpdate((event) => {
        const previous = last.get();
        view.set(moveMediaZoom(view.get(), previous, { x: event.focalX, y: event.focalY }, event.scale / previous.scale, viewport.get(), image.get()));
        last.set({ x: event.focalX, y: event.focalY, scale: event.scale });
      });
    const closePan = Gesture.Pan().enabled(zoom <= 1.01).maxPointers(1).activeOffsetY([-10, 10]).failOffsetX([-12, 12])
      .onStart(() => { last.set({ x: 0, y: 0, scale: 1 }); })
      .onUpdate((event) => {
        const previous = last.get();
        view.set(moveMediaZoom(view.get(), { x: 0, y: 0 }, { x: event.translationX - previous.x, y: event.translationY - previous.y }, 1, viewport.get(), image.get()));
        last.set({ x: event.translationX, y: event.translationY, scale: 1 });
      })
      .onEnd((event) => {
        const current = view.get();
        if (onSwipeDown && current.z <= 1.01 && event.translationY > 80 && event.translationY > Math.abs(event.translationX)) scheduleOnRN(onSwipeDown);
      });
    const zoomPan = Gesture.Pan().enabled(zoom > 1.01).maxPointers(1).activeOffsetX([-10, 10]).activeOffsetY([-10, 10])
      .onStart(() => { last.set({ x: 0, y: 0, scale: 1 }); })
      .onUpdate((event) => {
        const previous = last.get();
        view.set(moveMediaZoom(view.get(), { x: 0, y: 0 }, { x: event.translationX - previous.x, y: event.translationY - previous.y }, 1, viewport.get(), image.get()));
        last.set({ x: event.translationX, y: event.translationY, scale: 1 });
      });
    return Gesture.Simultaneous(pinch, Gesture.Race(closePan, zoomPan));
  }, [image, last, onSwipeDown, view, viewport, zoom]);
  const transform = useAnimatedStyle(() => {
    const current = view.get();
    const size = viewport.get();
    return { transform: [{ translateX: current.tx + (current.z - 1) * size.w / 2 }, { translateY: current.ty + (current.z - 1) * size.h / 2 }, { scale: current.z }] };
  });
  return <View className="min-h-0 flex-1 overflow-hidden bg-black" testID="media-zoom-viewport"
    onLayout={(event) => {
      const { width, height } = event.nativeEvent.layout;
      if (width !== box.w || height !== box.h) setBox({ w: width, h: height });
    }}>
    <GestureDetector gesture={gesture}><View collapsable={false} className="h-full w-full">
      <Animated.View className="h-full w-full" style={transform}>
        <MediaPicture api={api} location={location} fileId={fileId} alt={alt} full onDimensions={onDimensions} />
      </Animated.View>
    </View></GestureDetector>
    <View className="absolute bottom-2 right-2 flex-row items-center gap-2 rounded-lg bg-card">
      <Button variant="ghost" size="sm" testID="media-zoom-out" accessibilityLabel={t("缩小图片")} disabled={zoom <= 1} onPress={() => adjustZoom(0.5)}><Text>−</Text></Button>
      <Text testID="media-zoom-value" accessibilityLiveRegion="polite">{zoom.toLocaleString(locale)}×</Text>
      <Button variant="ghost" size="sm" testID="media-zoom-in" accessibilityLabel={t("放大图片")} disabled={zoom >= MAX_MEDIA_ZOOM} onPress={() => adjustZoom(2)}><Text>＋</Text></Button>
      <Button variant="ghost" size="sm" testID="media-zoom-reset" accessibilityLabel={t("重置图片缩放")} onPress={() => { view.set(RESET_ZOOM); }}><Text>{t("重置缩放")}</Text></Button>
    </View>
  </View>;
}
