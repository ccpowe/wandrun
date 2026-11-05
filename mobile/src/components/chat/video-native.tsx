import { AppState, Pressable, View } from "react-native";
import { useCallback } from "react";
import { router, useFocusEffect } from "expo-router";
import { useEvent } from "expo";
import { VideoView, useVideoPlayer } from "expo-video";
import { Play } from "lucide-react-native";

import { Icon } from "@/components/ui/icon.tsx";
import { ActivityIndicator } from "@/components/ui/activity-indicator.tsx";
import { Text } from "@/components/ui/text.tsx";
import { Button } from "@/components/ui/button.tsx";
import type { GatewayApi } from "@/gateway/api.ts";
import type { AttachmentFile } from "@/lib/attachment-grid.ts";
import { formatDuration } from "@/lib/attachment-grid.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { ThumbnailImage, useFilePreview, type PreviewOverrides } from "@/components/chat/attachment-media.tsx";

export type VideoGridCellProps = {
  file: AttachmentFile;
  api?: GatewayApi;
  width: number;
  height: number;
  onOpen: () => void;
  previewOverrides?: PreviewOverrides;
};

export function VideoGridCell({ file, api, width, height, onOpen, previewOverrides }: VideoGridCellProps) {
  const { t } = useTranslation();
  const preview = useFilePreview(api, file.id, previewOverrides);
  return <View style={{ width, height }} className="overflow-hidden bg-immersive-surface">
    <ThumbnailImage file={file} api={api} width={width} height={height} onOpen={onOpen} previewOverrides={previewOverrides} isVideo />
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t("播放视频 {name}", { name: file.name })}
      className="absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-immersive-scrim">
      <Icon as={Play} className="ml-0.5 size-6 text-immersive-foreground" fill="currentColor" />
    </Pressable>
    {formatDuration(preview.preview?.duration_ms) ? <View className="absolute bottom-2 right-2 rounded-full bg-immersive-scrim px-2 py-0.5">
      <Text variant="caption" className="text-immersive-foreground">{formatDuration(preview.preview?.duration_ms)}</Text>
    </View> : null}
  </View>;
}

export function VideoPlayerScreen({ fileId, api }: { fileId?: string; api?: GatewayApi }) {
  return <VideoPlayerResource key={`${api?.resourceIdentity}:${fileId}`} fileId={fileId} api={api} />;
}
function VideoPlayerResource({ fileId, api }: { fileId?: string; api?: GatewayApi }) {
  const { t } = useTranslation();
  const player = useVideoPlayer(api && fileId ? { uri: api.fileContentUrl(fileId), headers: api.headers() } : null);
  const status = useEvent(player, "statusChange", { status: "idle" as const });
  useFocusEffect(useCallback(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "active") player.pause();
    });
    return () => {
      subscription.remove();
      // The SDK may already have released the native object during final unmount.
      try { player.pause(); } catch { /* Native release has already stopped playback. */ }
    };
  }, [player]));
  const failed = status.status === "error";
  return <View className="flex-1 bg-immersive-surface" testID="video-player">
    <View className="flex-1 items-center justify-center">
      {api && fileId && !failed ? <VideoView player={player} contentFit="contain" nativeControls style={{ width: "100%", height: "100%" }} /> : null}
      {failed ? <View className="items-center gap-3 p-6"><Text className="text-center text-immersive-foreground">{t("视频无法播放")}</Text><Button intent="soft" onPress={() => router.replace({ pathname: "/files/[id]", params: { id: fileId ?? "" } })}><Text>{t("打开文件")}</Text></Button></View> : null}
      {!api || !fileId ? <Text className="text-immersive-foreground">{t("视频暂不可用")}</Text> : null}
    </View>
  </View>;
}

export function VideoLoading({ width, height }: { width: number; height: number }) {
  return <View style={{ width, height }} className="items-center justify-center bg-muted"><ActivityIndicator /></View>;
}
