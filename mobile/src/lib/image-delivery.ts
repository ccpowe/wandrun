import * as Sharing from "expo-sharing";

import type { GatewayApi } from "../gateway/api.ts";
import type { MediaLocation } from "../components/rich-message/media.tsx";
import { messageImageFile, type CachedDownload } from "./file-delivery.ts";
import { nativeDeliveryCache } from "./native-delivery-cache.ts";
import { saveNativeFile } from "./native-file-save.ts";
import { UserFacingError } from "./user-error.ts";

export type ImageSource = { fileId: string; location?: never } | { location: MediaLocation; fileId?: never };
export type ImageAction = "download" | "share";

/** Resolve a current original before the native handoff; previews are never delivery inputs.
 * Returns true only for a completed save. A picker cancellation or expired owner returns false.
 */
export async function deliverImage(api: GatewayApi, source: ImageSource, action: ImageAction, canStart: () => boolean): Promise<boolean> {
  if (!canStart()) return false;
  let file: { name: string; media_type: string };
  let url: string;
  if (source.fileId !== undefined) {
    const detail = await api.getFile(source.fileId);
    if (!canStart()) return false;
    if (!detail.available || !detail.media_type.split(";", 1)[0].trim().toLowerCase().startsWith("image/")) {
      throw new UserFacingError(detail.error_message || "图片附件不可用");
    }
    file = { name: detail.name, media_type: detail.media_type };
    url = api.fileContentUrl(source.fileId, true);
  } else {
    const location = source.location;
    const metadata = await api.getMessageMedia(location.conversationId, location.messageSeq, location.block, location.element, location.index);
    if (!canStart()) return false;
    file = messageImageFile(location, metadata.mime);
    url = `${api.config.baseUrl}${api.mediaContentPath(location.conversationId, location.messageSeq, location.block, location.element, location.index)}`;
  }
  const headers = api.headers();
  if (action === "download") return saveNativeFile(url, headers, file, canStart, api.signal);
  if (!await Sharing.isAvailableAsync()) throw new UserFacingError("此设备不支持系统文件分享");
  if (!canStart()) return false;
  const computerId = api.config.computerId;
  if (!computerId) throw new UserFacingError("图片需要有效的电脑连接");
  let cached: CachedDownload | null = null;
  try {
    cached = await nativeDeliveryCache(computerId).download(url, file, headers, api.signal);
    if (!canStart()) return false;
    // Once native receives the URI, its lease survives blur, page and computer switches.
    await cached.share((uri) => Sharing.shareAsync(uri, { mimeType: file.media_type, dialogTitle: file.name }));
    return false;
  } finally {
    cached?.release();
  }
}
