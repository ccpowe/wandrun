import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { router } from 'expo-router';

import { Text } from '@/components/ui/text.tsx';
import { RichText } from '@/components/rich-message/math.tsx';
import { richGeometry, richRadius, richSpace, richType } from '@/components/rich-message/tokens.ts';
import { GatewayError, type GatewayApi } from '@/gateway/api.ts';
import { loadLocalImage } from '@/lib/local-image.ts';
import { t, useTranslation } from '@/lib/i18n.ts';

export type MediaLocation = { conversationId: string; messageSeq: number; block: number | 'markdown'; element: string; index: number };
export type ImageItem = { attachment?: string; url?: string; alt: string; caption?: string };

/** Keep remote error text within the gateway's classified code contract; never display source URLs. */
const mediaMessages: Record<string, string> = {
  invalid_media_url: '图片地址无效', unsafe_media_address: '图片地址不可访问',
  media_too_large: '图片超过大小限制', unsupported_media: '不支持的图片格式',
  media_timeout: '图片获取超时', media_redirect: '图片重定向失败',
  media_busy: '图片请求过多', media_unavailable: '图片源站或网关暂不可用',
  media_not_found: '消息媒体不存在或无效',
};

export function mediaErrorMessage(cause: unknown): string {
  if (cause instanceof GatewayError) {
    return t(mediaMessages[cause.code] ?? '媒体暂不可用（错误码 {status}）', { status: cause.status });
  }
  return t('无法连接网关获取媒体');
}

export function MediaPicture({ api, location, fileId, alt, height = richGeometry.imageHeight, full = false, contentFit = 'contain', radius, onOpen, onErrorMessage, onDimensions }: {
  api?: GatewayApi; location?: MediaLocation; fileId?: string; alt: string;
  /** Auto fits the available width using gateway dimensions; loading/error uses the standard image-height placeholder. */
  height?: number | `${number}%` | 'auto'; full?: boolean; contentFit?: 'contain' | 'cover'; radius?: number;
  onOpen?: () => void; onErrorMessage?: (message: string) => void;
  /** Intrinsic dimensions for the full-screen viewer's fitted zoom bounds. */
  onDimensions?: (width: number, height: number) => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ key: string; error: string | null; dimensions: { width: number; height: number } | null } | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; path: string; uri: string } | null>(null);
  const key = api ? JSON.stringify([api.config.computerId, fileId, location]) : '';
  const conversationId = location?.conversationId;
  const messageSeq = location?.messageSeq;
  const block = location?.block;
  const element = location?.element;
  const index = location?.index;
  useEffect(() => {
    if (fileId || !api || conversationId === undefined || messageSeq === undefined || block === undefined || element === undefined || index === undefined) return;
    let active = true;
    void api.getMessageMedia(conversationId, messageSeq, block, element, index)
      .then(({ width, height }) => { if (active && !api.signal.aborted) { setResult({ key, error: null, dimensions: { width, height } }); onDimensions?.(width, height); } })
      .catch((cause: unknown) => { if (active && !api.signal.aborted) {
        const message = mediaErrorMessage(cause);
        setResult({ key, error: message, dimensions: null });
        onErrorMessage?.(message);
      } });
    return () => { active = false; };
  }, [api, fileId, conversationId, messageSeq, block, element, index, key, onErrorMessage, onDimensions]);
  const error = result?.key === key ? result.error : null;
  const ready = !!(api && (fileId || (location && result?.key === key && result.dimensions)));
  const path = error || !api ? null : fileId ? `/files/${encodeURIComponent(fileId)}/content` :
    ready && conversationId !== undefined && messageSeq !== undefined && block !== undefined && element !== undefined && index !== undefined
      ? api.mediaContentPath(conversationId, messageSeq, block, element, index) : null;
  useEffect(() => {
    if (!api || !path) return;
    let active = true;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void loadLocalImage(api, path, controller.signal).then((lease) => {
      dispose = lease.dispose;
      if (active && !api.signal.aborted) setLoaded({ key, path, uri: lease.uri });
      else lease.dispose();
    }, (cause: unknown) => {
      if (!active || api.signal.aborted) return;
      const message = mediaErrorMessage(cause);
      setResult({ key, error: message, dimensions: null });
      onErrorMessage?.(message);
    });
    return () => {
      active = false;
      controller.abort();
      dispose?.();
    };
  }, [api, path, key, onErrorMessage]);
  const source = loaded?.key === key && loaded.path === path ? { uri: loaded.uri } : null;
  const dimensions = result?.key === key ? result.dimensions : null;
  const frame = !full && height === 'auto' && dimensions
    ? { width: '100%' as const, aspectRatio: dimensions.width / dimensions.height }
    : { height: full ? '100%' as const : height === 'auto' ? richGeometry.imageHeight : height };
  const preview = __DEV__ && !api && (fileId === 'rich-preview-image' || fileId?.startsWith('attachment-preview-image-'));
  const open = full ? undefined : onOpen ?? (location ? () => router.push({ pathname: '/media-viewer', params: {
    id: location.conversationId, seq: String(location.messageSeq), block: String(location.block),
    element: location.element, index: String(location.index), alt,
  } }) : fileId ? () => router.push({ pathname: '/files/[id]', params: { id: fileId } }) : undefined);
  // Full-screen sits on the viewer's black stage: no card fill or corners there.
  return <View className={full ? 'items-center justify-center overflow-hidden' : 'bg-muted items-center justify-center overflow-hidden'}
    style={{ ...frame, ...(full && radius === undefined ? {} : { borderRadius: radius ?? richRadius.small }) }} testID="media-image">
    {source || preview ? <Pressable onPress={open} disabled={!open} accessibilityRole="button" accessibilityLabel={t('查看图片 {alt}', { alt })} testID="media-image-open" className="h-full w-full">
      <ExpoImage source={preview ? require('../../../assets/empty-together.png') : source!} alt={alt} contentFit={contentFit} cachePolicy="none" allowDownscaling={!full} style={{ width: '100%', height: '100%' }}
        onLoad={fileId && onDimensions && !api?.signal.aborted ? ({ source: image }) => onDimensions(image.width, image.height) : undefined}
        onError={() => { if (!api?.signal.aborted) { const message = t('图片内容暂不可用'); setResult({ key, error: message, dimensions: null }); onErrorMessage?.(message); } }} />
    </Pressable> : error ? <Text className="text-center text-destructive" style={{ ...richType.subtle, paddingHorizontal: richSpace.md }} testID="media-image-error">{t(error)}</Text>
      : api && (location || fileId) ? <ActivityIndicator /> : <Text className="text-center text-muted-foreground" style={{ ...richType.subtle, paddingHorizontal: richSpace.md }}>{t('图片附件不可用')}</Text>}
    {error && alt ? <Text className="text-center text-muted-foreground" style={{ ...richType.subtle, paddingHorizontal: richSpace.md }}>{alt}</Text> : null}
  </View>;
}

export function MediaCard({ item, title, description, tags, direction, api, location, fileId }: {
  item: ImageItem; title: string; description?: string; tags?: string[]; direction?: 'horizontal' | 'vertical';
  api?: GatewayApi; location?: MediaLocation; fileId?: string;
}) {
  const horizontal = direction === 'horizontal';
  return <View className={`border-border overflow-hidden border bg-card ${horizontal ? 'flex-row' : ''}`}
    style={{ borderRadius: richRadius.medium }} testID="rich-media-card">
    <View style={horizontal ? { width: '42%' } : undefined}><MediaPicture api={api} location={location} fileId={fileId} alt={item.alt}
      height={horizontal ? richGeometry.horizontalImageHeight : richGeometry.imageHeight} /></View>
    <View className="min-w-0 flex-1" style={{ gap: richSpace.sm, padding: richSpace.md }}><RichText style={richType.title}>{title}</RichText>
      {description ? <RichText className="text-muted-foreground" style={richType.subtle}>{description}</RichText> : null}
      {tags?.length ? <View className="flex-row flex-wrap" style={{ gap: richSpace.xs }}>{tags.map((tag, i) => <View key={i} className="bg-muted"
        style={{ borderRadius: richRadius.full, paddingHorizontal: richSpace.sm, paddingVertical: richSpace.xs }}>
        <RichText style={richType.subtle}>{tag}</RichText></View>)}</View> : null}
      {item.caption ? <RichText className="text-muted-foreground" style={richType.subtle}>{item.caption}</RichText> : null}</View>
  </View>;
}

export function MediaGallery({ items, api, locate, fileFor }: {
  items: readonly ImageItem[]; api?: GatewayApi; locate: (index: number) => MediaLocation | undefined;
  fileFor: (item: ImageItem) => string | undefined;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const selectedPage = useRef(0);
  const previousWidth = useRef(0);
  const list = useRef<FlatList<ImageItem>>(null);
  const scrollable = items.length >= 3;
  const gap = richSpace.sm;
  const tileWidth = scrollable ? Math.round(width * 0.46) : items.length === 1 ? width : (width - gap) / 2;
  const interval = tileWidth + gap;
  useEffect(() => {
    // The first list mount starts at zero. Only a later width change needs to
    // reposition the selected image using the new tile interval.
    if (scrollable && width > 0 && previousWidth.current > 0 && previousWidth.current !== width) {
      list.current?.scrollToIndex({ index: selectedPage.current, animated: false });
    }
    previousWidth.current = width;
  }, [scrollable, width]);
  const observePage = (offset: number) => {
    const next = Math.min(items.length - 1, Math.max(0, Math.round(offset / interval)));
    selectedPage.current = next;
    setPage(next);
  };
  const picture = (item: ImageItem, index: number) =>
    <View key={index} style={{ width: tileWidth, ...(Platform.OS === 'web' ? { scrollSnapAlign: 'start' as const } : {}) }}>
      <MediaPicture api={api} location={locate(index)} fileId={fileFor(item)} alt={item.alt} height={richGeometry.galleryHeight} />
      {!scrollable && item.caption ? <RichText className="text-muted-foreground" style={{ ...richType.subtle, marginTop: richSpace.sm }}>{item.caption}</RichText> : null}
    </View>;
  return <View className="border-border border bg-card" style={{ gap: richSpace.sm, borderRadius: richRadius.medium, padding: richSpace.sm }}
    onLayout={(event) => setWidth(event.nativeEvent.layout.width - 2 * richSpace.sm - 2)} testID="rich-gallery">
    {width > 0 ? scrollable
      ? <FlatList ref={list} horizontal data={items} keyExtractor={(_, index) => String(index)}
        style={{ height: richGeometry.galleryHeight, ...(Platform.OS === 'web' ? { scrollSnapType: 'x mandatory' as const } : {}) }}
        contentContainerStyle={{ paddingRight: width - tileWidth }} ItemSeparatorComponent={() => <View style={{ width: gap }} />}
        initialNumToRender={3} maxToRenderPerBatch={3} windowSize={3} showsHorizontalScrollIndicator={false}
        snapToInterval={interval} decelerationRate="fast" snapToAlignment="start"
        onScroll={Platform.OS === 'web' ? (event) => observePage(event.nativeEvent.contentOffset.x) : undefined}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(event) => { if (Platform.OS !== 'web') observePage(event.nativeEvent.contentOffset.x); }}
        getItemLayout={(_, index) => ({ index, length: interval, offset: index * interval })}
        renderItem={({ item, index }) => picture(item, index)} />
      : <View className="flex-row" style={{ gap }}>{items.map(picture)}</View> : null}
    {scrollable && items[page]?.caption ? <RichText testID="rich-gallery-caption" className="text-muted-foreground"
      style={{ ...richType.subtle, paddingHorizontal: richSpace.xs }}>{items[page].caption}</RichText> : null}
    {scrollable ? <View className="flex-row items-center justify-between"><Text style={richType.subtle}>{page + 1} / {items.length}</Text>
      <View className="flex-row" style={{ gap: richSpace.md }}>{[-1, 1].map((step) => <Pressable key={step} accessibilityRole="button" accessibilityLabel={step < 0 ? t('上一张图片') : t('下一张图片')}
        disabled={page + step < 0 || page + step >= items.length} onPress={() => {
          const next = page + step;
          if (next >= 0 && next < items.length) {
            selectedPage.current = next;
            setPage(next);
            list.current?.scrollToIndex({ index: next, animated: false });
          }
        }}>
        <Text className={page + step < 0 || page + step >= items.length ? 'text-muted-foreground' : 'text-foreground'}
          style={richType.body}>{step < 0 ? '‹' : '›'}</Text>
      </Pressable>)}</View></View> : null}
  </View>;
}
