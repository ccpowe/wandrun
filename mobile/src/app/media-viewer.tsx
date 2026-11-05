import { router, Stack, useLocalSearchParams } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AttachmentGallery, ZoomablePicture } from '@/components/media-viewer-view.tsx';
import { ImageActions } from '@/components/image-actions.tsx';
import { MermaidViewer } from '@/components/rich-message/mermaid.tsx';
import { viewerMedia } from '@/components/rich-message/media-viewer-source.ts';
import { attachmentFiles, mediaViewerLocation, type MediaViewerParams } from '@/lib/media-viewer.ts';
import { Button } from '@/components/ui/button.tsx';
import { Icon } from '@/components/ui/icon.tsx';
import { Text } from '@/components/ui/text.tsx';
import { useSession } from '@/lib/session-context.tsx';
import { viewerIndex } from '@/lib/attachment-grid.ts';
import { useTranslation } from '@/lib/i18n.ts';
import { useImmersiveStatusBar } from '@/lib/use-status-bar-appearance.tsx';
import type { ChatSession } from '@/gateway/session.ts';
/** Fullscreen route keeps only opaque message coordinates or file IDs in navigation, never URLs or tokens. */
export default function MediaViewer() {
  const params = useLocalSearchParams<MediaViewerParams>();
  const session = useSession();
  return <MediaViewerScreen key={session?.queryIdentity ?? 'none'} params={params} session={session} />;
}

/** Scene and Router use the same projection; media owners remain inside their renderer boundaries. */
export function MediaViewerScreen({ params, session }: { params: MediaViewerParams; session?: ChatSession | null }) {
  const { t } = useTranslation();
  const { id, seq, block, element, index, alt, file_id, file_ids } = params;
  const insets = useSafeAreaInsets();
  const numericSeq = Number(seq);
  const numericIndex = Number(index ?? 0);
  const location = useMemo(() => mediaViewerLocation({ id, seq, block, element, index }), [id, seq, block, element, index]);
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
  useImmersiveStatusBar(attachmentMode);
  const richKey = location ? JSON.stringify([location, selected?.fileId]) : '';
  return <View className={attachmentMode ? "flex-1 bg-immersive-surface" : "flex-1 bg-background"} style={{ paddingTop: insets.top, paddingBottom: insets.bottom }} testID="media-viewer">
    <Stack.Screen options={{ headerShown: false }} />
    {mermaid !== undefined && location && selected
      ? <MermaidViewer key={`${id}:${seq}:${block}:${element}:${index}`} source={mermaid} title={alt || t('流程图')} full onBack={() => router.back()} />
      : attachmentMode
        ? <AttachmentGallery key={`${session?.queryIdentity}:${file_id}:${file_ids}:${attachmentStart}`} api={session?.api} files={attachmentImages} initialIndex={attachmentStart} onBack={() => router.back()} />
        : <>
          <View className="flex-row items-center gap-2 border-b border-border px-4 py-2">
            <Button intent="quiet" size="icon" aria-label={t('返回')} onPress={() => router.back()}><Icon as={ArrowLeft} className="size-5" /></Button>
            <Text numberOfLines={1} className="min-w-0 flex-1 text-lg font-medium">{alt || t('高清查看')}</Text>
            {location && selected && <ImageActions key={richKey} api={session?.api}
              source={selected.fileId ? { fileId: selected.fileId } : { location }} />}
          </View>
          <View className="min-h-0 flex-1 p-3">{location && selected
            ? <ZoomablePicture key={richKey} api={session?.api} location={location} fileId={selected.fileId} alt={alt ?? t('媒体')} />
            : <Text className="p-4 text-destructive">{t('媒体位置无效或图片已不可用')}</Text>}</View>
          {selected?.caption ? <ScrollView className="max-h-[40%] border-t border-border px-4 py-3" testID="media-viewer-caption">
            <Text selectable className="text-sm leading-6">{selected.caption}</Text>
          </ScrollView> : null}
        </>}
  </View>;
}


