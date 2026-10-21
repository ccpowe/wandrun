export const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;

export type UploadItem = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  uploadUrl: string | null;
  fileId: string | null;
  progress: number;
  error: string | null;
};

/** A native read is limited independently of the logical file size or a caller's requested end. */
export function boundedReadRange(size: number, start: number, end: number): { count: number; done: boolean } {
  const count = Math.max(0, Math.min(size - start, end - start, UPLOAD_CHUNK_BYTES));
  return { count, done: start + count >= size };
}

export type UploadDraft = { text: string; items: UploadItem[] };

/** Alternating snapshots: replacing one slot must never destroy the other committed slot. */
export function latestDraft(snapshots: (string | null)[]): { generation: number; draft: UploadDraft } {
  let latest: { generation: number; draft: UploadDraft } | null = null;
  for (const text of snapshots) {
    if (text === null) continue;
    try {
      const value = JSON.parse(text) as { generation: number; draft: UploadDraft };
      if (!Number.isSafeInteger(value.generation) || value.generation < 1 ||
        typeof value.draft?.text !== "string" || !Array.isArray(value.draft.items) ||
        !value.draft.items.every((item) => typeof item.id === "string" && /^[a-z0-9-]+$/.test(item.id) &&
          typeof item.name === "string" && typeof item.mediaType === "string" &&
          Number.isSafeInteger(item.size) && item.size >= 0 &&
          (item.uploadUrl === null || typeof item.uploadUrl === "string") &&
          (item.fileId === null || typeof item.fileId === "string"))) continue;
      if (!latest || value.generation > latest.generation) latest = value;
    } catch {
      // A write interrupted in one slot does not invalidate the other slot.
    }
  }
  if (latest) return latest;
  if (snapshots.every((text) => text === null)) return { generation: 0, draft: { text: "", items: [] } };
  throw new Error("草稿快照无法读取");
}

/** Never infer completion from 100% progress: only the gateway's stable file id makes an item sendable. */
export function sendReadiness(draft: UploadDraft): { enabled: boolean; reason: string | null } {
  if (draft.items.some((item) => item.error)) return { enabled: false, reason: "附件上传失败，请重试或移除" };
  if (draft.items.some((item) => !item.fileId)) return { enabled: false, reason: "附件上传中，请等待全部完成" };
  if (!draft.text.trim() && draft.items.length === 0) return { enabled: false, reason: "输入消息或添加附件" };
  return { enabled: true, reason: null };
}

export function uploadMetadata(conversationId: string, item: Pick<UploadItem, "name" | "mediaType">): Record<string, string> {
  return { conversation_id: conversationId, filename: item.name, filetype: item.mediaType };
}

/** Local bytes and upload URL survive restart; transient progress is reconciled by tus HEAD. */
export function restoreDraft(value: UploadDraft): UploadDraft {
  return {
    text: value.text,
    items: value.items.map((item) => ({ ...item, progress: item.fileId ? item.size : 0, error: item.fileId ? null : item.error })),
  };
}

export function mimeForFile(name: string, provided?: string | null): string {
  if (provided && /^[\w.+-]+\/[\w.+-]+$/.test(provided)) return provided;
  const extension = name.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", mp4: "video/mp4", mov: "video/quicktime",
    pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json",
  };
  return types[extension ?? ""] ?? "application/octet-stream";
}
