import type { FileRecord } from '../gateway/api.ts';
import type { MediaLocation } from '../components/rich-message/media.tsx';

export type ViewerAttachment = Pick<FileRecord, 'id' | 'name' | 'media_type'>;
export type MediaViewerParams = {
  id?: string; seq?: string; block?: string; element?: string; index?: string; alt?: string; file_id?: string; file_ids?: string;
};

export function mediaViewerLocation(params: MediaViewerParams): MediaLocation | undefined {
  const { id, seq, block, element, index } = params;
  const messageSeq = Number(seq);
  const imageIndex = Number(index ?? 0);
  const messageBlock = block === 'markdown' ? 'markdown' : Number(block);
  if (!id || !seq || block === undefined || !element || !Number.isSafeInteger(messageSeq) || messageSeq <= 0 ||
    !Number.isSafeInteger(imageIndex) || imageIndex < 0 ||
    messageBlock !== 'markdown' && (!Number.isSafeInteger(messageBlock) || messageBlock < 0)) return undefined;
  return { conversationId: id, messageSeq, block: messageBlock, element, index: imageIndex };
}

export function attachmentFiles(raw: unknown, serializedIds: string | undefined, selectedId: string | undefined): ViewerAttachment[] {
  const metadata = Array.isArray(raw) ? raw.filter((file): file is ViewerAttachment => !!file && typeof file === 'object' &&
    typeof (file as Record<string, unknown>).id === 'string' && typeof (file as Record<string, unknown>).media_type === 'string' &&
    String((file as Record<string, unknown>).media_type).toLowerCase().startsWith('image/')).map(file => ({
      id: file.id, name: file.name || file.id, media_type: file.media_type,
    })) : [];
  let ids: string[] = [];
  if (serializedIds) {
    try {
      const parsed: unknown = JSON.parse(serializedIds);
      if (Array.isArray(parsed)) ids = parsed.filter((value): value is string => typeof value === 'string');
    } catch { /* Invalid route data falls back to message attachments. */ }
  }
  const byId = new Map(metadata.map(file => [file.id, file]));
  const ordered = (ids.length ? ids : metadata.map(file => file.id)).map(id => byId.get(id) ?? { id, name: id, media_type: 'image/*' });
  if (selectedId && !ordered.some(file => file.id === selectedId)) ordered.push({ id: selectedId, name: selectedId, media_type: 'image/*' });
  return ordered;
}

export type GalleryState = { status: 'browsing'; page: number } | { status: 'zoomed'; page: number };
export type GalleryEvent =
  | { type: 'scroll' | 'momentum-end'; page: number }
  | { type: 'zoom'; page: number; zoom: number };

export function galleryReducer(state: GalleryState, event: GalleryEvent): GalleryState {
  switch (state.status) {
    case 'browsing':
      switch (event.type) {
        case 'scroll': return { ...state, page: event.page };
        case 'momentum-end': return { status: 'browsing', page: event.page };
        case 'zoom': return event.page === state.page && event.zoom > 1.01 ? { status: 'zoomed', page: state.page } : state;
      }
      break;
    case 'zoomed':
      switch (event.type) {
        case 'scroll': return { ...state, page: event.page };
        case 'momentum-end': return { status: 'browsing', page: event.page };
        case 'zoom': return event.page === state.page && event.zoom <= 1.01 ? { status: 'browsing', page: state.page } : state;
      }
  }
  return state;
}

export function galleryPage(offset: number, width: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.round(offset / Math.max(1, width))));
}
