import { AppState, ActivityIndicator, Pressable, View } from "react-native";
import { useEffect } from "react";
import { router, useIsFocused } from "expo-router";
import { useEvent } from "expo";
import { VideoView, useVideoPlayer } from "expo-video";
import { Play } from "lucide-react-native";

import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
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
  return <View style={{ width, height }} className="overflow-hidden bg-black">
    <ThumbnailImage file={file} api={api} width={width} height={height} onOpen={onOpen} previewOverrides={previewOverrides} isVideo />
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={t("播放视频 {name}", { name: file.name })}
      className="absolute left-1/2 top-1/2 size-[46px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/65">
      <Icon as={Play} className="ml-0.5 size-6 text-white" fill="white" />
    </Pressable>
    {formatDuration(preview.preview?.duration_ms) ? <View className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2 py-0.5">
      <Text className="text-xs font-medium text-white">{formatDuration(preview.preview?.duration_ms)}</Text>
    </View> : null}
  </View>;
}

export function VideoPlayerScreen({ fileId, api }: { fileId?: string; api?: GatewayApi }) {
  const { t } = useTranslation();
  const player = useVideoPlayer(api && fileId ? { uri: api.fileContentUrl(fileId), headers: api.headers() } : null);
  const status = useEvent(player, "statusChange", { status: "idle" as const });
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) {
      player.pause();
      return;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") player.pause();
    });
    return () => subscription.remove();
  }, [focused, player]);
  const failed = status.status === "error";
  return <View className="flex-1 bg-black" testID="video-player">
    <View className="flex-1 items-center justify-center">
      {api && fileId && !failed ? <VideoView player={player} contentFit="contain" nativeControls style={{ width: "100%", height: "100%" }} /> : null}
      {failed ? <View className="items-center gap-3 p-6"><Text className="text-center text-white">{t("视频无法播放")}</Text><Pressable onPress={() => router.replace({ pathname: "/files/[id]", params: { id: fileId ?? "" } })} className="rounded-lg bg-white px-4 py-2"><Text className="text-black">{t("打开文件")}</Text></Pressable></View> : null}
      {!api || !fileId ? <Text className="text-white">{t("视频暂不可用")}</Text> : null}
    </View>
  </View>;
}

export function VideoLoading({ width, height }: { width: number; height: number }) {
  return <View style={{ width, height }} className="items-center justify-center bg-muted"><ActivityIndicator /></View>;
}
