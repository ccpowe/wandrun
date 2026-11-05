import { ArrowLeft } from 'lucide-react-native';
import { useCallback, useMemo, useReducer, useState } from 'react';
import { FlatList, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { MediaPicture, type MediaLocation } from './rich-message/media.tsx';
import { MAX_MEDIA_ZOOM, moveMediaZoom, RESET_ZOOM, type Size } from './rich-message/media-zoom.ts';
import { ImageActions } from './image-actions.tsx';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/icon.tsx';
import { Text } from './ui/text.tsx';
import type { GatewayApi } from '../gateway/api.ts';
import { galleryPage, galleryReducer, type ViewerAttachment } from '../lib/media-viewer.ts';
import { useTranslation } from '../lib/i18n.ts';
export function AttachmentGallery({ api, files, initialIndex, onBack }: { api?: GatewayApi; files: readonly ViewerAttachment[]; initialIndex: number; onBack: () => void }) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const [state, dispatch] = useReducer(galleryReducer, { status: 'browsing', page: initialIndex });
  const currentFile = files[state.page];
  return <View className="flex-1 bg-immersive-surface" testID="media-attachment-gallery">
    <View className="z-10 flex-row items-center gap-2 px-4 py-2">
      <Button intent="quiet" size="icon" aria-label={t('返回')} onPress={onBack}><Icon as={ArrowLeft} className="size-5 text-immersive-foreground" /></Button>
      <Text variant="caption" className="text-immersive-foreground">{state.page + 1} / {files.length}</Text>
      <View className="min-w-0 flex-1" />
      {currentFile && <ImageActions key={`${api?.config.computerId}:${currentFile.id}`} api={api} source={{ fileId: currentFile.id }} light />}
    </View>
    <FlatList testID="media-gallery-list" className="min-h-0 flex-1" data={files} horizontal pagingEnabled scrollEnabled={state.status === 'browsing'}
      initialScrollIndex={initialIndex} keyExtractor={(file) => file.id} showsHorizontalScrollIndicator={false}
      windowSize={3} initialNumToRender={1} maxToRenderPerBatch={3}
      getItemLayout={(_, index) => ({ index, length: width, offset: index * width })}
      scrollEventThrottle={16}
      onScroll={(event) => {
        // The nearest visible image owns the actions even if native scrolling
        // is cancelled without either end event.
        dispatch({ type: 'scroll', page: galleryPage(event.nativeEvent.contentOffset.x, event.nativeEvent.layoutMeasurement.width, files.length) });
      }}
      onMomentumScrollEnd={(event) => {
        dispatch({ type: 'momentum-end', page: galleryPage(event.nativeEvent.contentOffset.x, event.nativeEvent.layoutMeasurement.width, files.length) });
      }}
      renderItem={({ item, index }) => <View style={{ width }} className="flex-1">
        <ZoomablePicture api={api} fileId={item.id} alt={item.name} onSwipeDown={onBack}
          onZoomChange={zoom => dispatch({ type: 'zoom', page: index, zoom })} />
      </View>} />
  </View>;
}

export function ZoomablePicture({ api, location, fileId, alt, onSwipeDown, onZoomChange }: {
  api?: GatewayApi; location?: MediaLocation; fileId?: string; alt: string;
  onSwipeDown?: () => void; onZoomChange?: (zoom: number) => void;
}) {
  const { t, locale } = useTranslation();
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
  // This viewport deliberately clips transformed pixels, not draggable list rows.
  return <View className="min-h-0 flex-1 overflow-hidden bg-immersive-surface" testID="media-zoom-viewport"
    onLayout={(event) => {
      const { width, height } = event.nativeEvent.layout;
      const current = viewport.get();
      if (width !== current.w || height !== current.h) {
        viewport.set({ w: width, h: height });
        view.set(RESET_ZOOM);
      }
    }}>
    <GestureDetector gesture={gesture}><View collapsable={false} className="h-full w-full">
      <Animated.View className="h-full w-full" style={transform}>
        <MediaPicture api={api} location={location} fileId={fileId} alt={alt} full onDimensions={onDimensions} />
      </Animated.View>
    </View></GestureDetector>
    <View className="absolute bottom-2 right-2 flex-row items-center gap-2 rounded-lg bg-card">
      <Button intent="quiet" size="sm" testID="media-zoom-out" accessibilityLabel={t("缩小图片")} disabled={zoom <= 1} onPress={() => adjustZoom(0.5)}><Text>−</Text></Button>
      <Text testID="media-zoom-value" accessibilityLiveRegion="polite">{zoom.toLocaleString(locale)}×</Text>
      <Button intent="quiet" size="sm" testID="media-zoom-in" accessibilityLabel={t("放大图片")} disabled={zoom >= MAX_MEDIA_ZOOM} onPress={() => adjustZoom(2)}><Text>＋</Text></Button>
      <Button intent="quiet" size="sm" testID="media-zoom-reset" accessibilityLabel={t("重置图片缩放")} onPress={() => { view.set(RESET_ZOOM); }}><Text>{t("重置缩放")}</Text></Button>
    </View>
  </View>;
}
