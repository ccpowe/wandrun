import { authorizedImageFiles, splitAgentMessage } from '../../lib/agent-message.ts';
import { parseRichSpec } from './spec.ts';
import type { ImageItem, MediaLocation } from './media.tsx';
import type { FileRecord } from '@/gateway/api.ts';

/** Resolve the selected image from persisted message data, not untrusted route text or URLs. */
export function viewerMedia(text: string, location: MediaLocation,
  ui?: readonly { block: number; valid: boolean; files?: Record<string, string> }[],
  attachments?: readonly Pick<FileRecord, 'id' | 'media_type'>[],
): { caption?: string; fileId?: string; mermaid?: string } | null {
  if (location.block === 'markdown') return location.element === 'image' ? {} : null;
  const part = splitAgentMessage(text).find((item) => item.kind === 'ui' && item.block === location.block);
  if (!part || part.kind !== 'ui' || !part.closed) return null;
  const status = ui?.find((entry) => entry.block === location.block);
  if (status?.valid === false) return null;
  const node = parseRichSpec(part.source)?.elements[location.element];
  if (!node) return null;
  if (node.type === 'Mermaid') return location.index === 0 ? { mermaid: node.props.source } : null;
  let item: Pick<ImageItem, 'attachment' | 'caption'> | undefined;
  if (node.type === 'Gallery') item = node.props.items[location.index];
  else if ((node.type === 'Image' || node.type === 'MediaCard') && location.index === 0) item = node.props;
  else return null;
  if (!item) return null;
  const files = authorizedImageFiles(status, attachments);
  if (item.attachment && !files?.[item.attachment]) return null;
  return { caption: item.caption, fileId: item.attachment && files?.[item.attachment] };
}
