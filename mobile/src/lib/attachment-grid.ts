import type { FileRecord, GatewayApi } from "@/gateway/api.ts";

export const ATTACHMENT_GRID = {
  maxWidth: 300,
  mineWidth: 240,
  gap: 3,
  radius: 16,
  singleMaxHeight: 240,
  twoRowHeight: 148,
  threeHeight: 200,
  compactRowHeight: 52,
  maxVisibleImages: 9,
  maxVisibleFiles: 4,
} as const;

export type AttachmentFile = Pick<FileRecord, "id" | "name" | "size" | "media_type">
  & Partial<Pick<FileRecord, "remote_environment">>;
export function attachmentDisplayWidth(screenWidth: number, mine: boolean): number {
  const maxWidth = mine ? ATTACHMENT_GRID.mineWidth : ATTACHMENT_GRID.maxWidth;
  return Math.min(maxWidth, Math.max(1, screenWidth - 32));
}

export type AttachmentGroups = {
  images: AttachmentFile[];
  files: AttachmentFile[];
};

export function normalizedMediaType(mediaType: string): string {
  return mediaType.split(";", 1)[0].trim().toLowerCase();
}

export function isImageAttachment(file: Pick<AttachmentFile, "media_type" | "remote_environment">): boolean {
  return !file.remote_environment && normalizedMediaType(file.media_type).startsWith("image/");
}

export function isVideoAttachment(file: Pick<AttachmentFile, "media_type" | "remote_environment">): boolean {
  return !file.remote_environment && normalizedMediaType(file.media_type).startsWith("video/");
}

export function isGridMediaAttachment(file: Pick<AttachmentFile, "media_type" | "remote_environment">): boolean {
  return isImageAttachment(file) || isVideoAttachment(file);
}

export function isAudioAttachment(file: Pick<AttachmentFile, "media_type" | "remote_environment">): boolean {
  return !file.remote_environment && normalizedMediaType(file.media_type).startsWith("audio/");
}

export function isPdfAttachment(file: Pick<AttachmentFile, "media_type" | "remote_environment">): boolean {
  return !file.remote_environment && normalizedMediaType(file.media_type) === "application/pdf";
}

export function groupAttachments(files: readonly AttachmentFile[]): AttachmentGroups {
  return files.reduce<AttachmentGroups>((groups, file) => {
    (isGridMediaAttachment(file) ? groups.images : groups.files).push(file);
    return groups;
  }, { images: [], files: [] });
}

export function thumbnailWidthForPixels(width: number, devicePixelRatio: number): 240 | 480 | 960 {
  const pixels = Math.max(0, width) * Math.max(1, devicePixelRatio);
  return pixels <= 240 ? 240 : pixels <= 480 ? 480 : 960;
}

export function formatDuration(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type GridCell = { index: number; x: number; y: number; width: number; height: number };

/** Return deterministic cell rectangles for the selected design width. */
export function imageGridCells(count: number, width: number): GridCell[] {
  const visible = Math.min(Math.max(0, count), ATTACHMENT_GRID.maxVisibleImages);
  const safeWidth = Math.min(Math.max(0, width), ATTACHMENT_GRID.maxWidth);
  if (visible === 0) return [];
  if (visible === 1) return [{ index: 0, x: 0, y: 0, width: safeWidth, height: ATTACHMENT_GRID.singleMaxHeight }];
  if (visible === 3) {
    const scale = safeWidth / ATTACHMENT_GRID.maxWidth;
    const totalHeight = ATTACHMENT_GRID.threeHeight * scale;
    const rightWidth = (safeWidth - ATTACHMENT_GRID.gap) / 3;
    const leftWidth = rightWidth * 2;
    const rightHeight = (totalHeight - ATTACHMENT_GRID.gap) / 2;
    return [
      { index: 0, x: 0, y: 0, width: leftWidth, height: totalHeight },
      { index: 1, x: leftWidth + ATTACHMENT_GRID.gap, y: 0, width: rightWidth, height: rightHeight },
      { index: 2, x: leftWidth + ATTACHMENT_GRID.gap, y: rightHeight + ATTACHMENT_GRID.gap, width: rightWidth, height: rightHeight },
    ];
  }
  const columns = visible >= 5 ? 3 : 2;
  const cellWidth = (safeWidth - ATTACHMENT_GRID.gap * (columns - 1)) / columns;
  const cellHeight = columns === 2 ? ATTACHMENT_GRID.twoRowHeight * safeWidth / ATTACHMENT_GRID.maxWidth : cellWidth;
  return Array.from({ length: visible }, (_, index) => ({
    index,
    x: (index % columns) * (cellWidth + ATTACHMENT_GRID.gap),
    y: Math.floor(index / columns) * (cellHeight + ATTACHMENT_GRID.gap),
    width: cellWidth,
    height: cellHeight,
  }));
}

export function imageGridHeight(count: number, width: number): number {
  const cells = imageGridCells(count, width);
  return cells.reduce((height, cell) => Math.max(height, cell.y + cell.height), 0);
}

export function singleImageSize(width: number, intrinsic: { width: number; height: number }): { width: number; height: number } {
  const maxWidth = Math.min(Math.max(0, width), ATTACHMENT_GRID.maxWidth);
  if (intrinsic.width <= 0 || intrinsic.height <= 0) return { width: maxWidth, height: Math.min(180, ATTACHMENT_GRID.singleMaxHeight) };
  const scale = Math.min(maxWidth / intrinsic.width, ATTACHMENT_GRID.singleMaxHeight / intrinsic.height, 1);
  return { width: intrinsic.width * scale, height: intrinsic.height * scale };
}

export function visibleFileCount(total: number): { visible: number; hidden: number } {
  const visible = Math.min(Math.max(0, total), ATTACHMENT_GRID.maxVisibleFiles);
  return { visible, hidden: Math.max(0, total - visible) };
}

export function moreImagesCount(total: number): number {
  return Math.max(0, total - ATTACHMENT_GRID.maxVisibleImages);
}

export function viewerIndex(fileIds: readonly string[], selectedId: string | undefined, fallback = 0): number {
  const selected = selectedId ? fileIds.indexOf(selectedId) : -1;
  return selected >= 0 ? selected : Math.min(Math.max(0, fallback), Math.max(0, fileIds.length - 1));
}

/** Decode a bounded UTF-8 prefix without exposing a replacement character at its byte boundary. */
export function decodeUtf8Prefix(bytes: ArrayBuffer | Uint8Array, maxBytes = 4096): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let end = Math.min(view.byteLength, Math.max(0, maxBytes));
  while (end >= 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(view.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

export const MARKDOWN_PREFIX_BYTES = 4096;

/** Reads only the head of a Markdown attachment for the summary card. */
export async function loadMarkdownPrefix(api: GatewayApi, fileId: string, fileSize: number): Promise<string> {
  if (fileSize === 0) return "";
  // consumeResponse takes a gateway path; fileContentUrl() is the absolute URL players need.
  return api.consumeResponse(`/files/${encodeURIComponent(fileId)}/content`, { headers: api.headers({ Range: `bytes=0-${MARKDOWN_PREFIX_BYTES - 1}` }) }, async (response) => {
    if (!response.ok) throw new Error("无法预览文件");
    return decodeUtf8Prefix(await response.arrayBuffer(), MARKDOWN_PREFIX_BYTES);
  });
}
