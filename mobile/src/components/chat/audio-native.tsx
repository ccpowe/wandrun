import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { router } from "expo-router";
import { Pause, Play } from "lucide-react-native";
import { useEffect, useLayoutEffect, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import Slider from "@react-native-community/slider";

import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { GatewayApi } from "@/gateway/api.ts";
import type { AttachmentFile } from "@/lib/attachment-grid.ts";
import { formatDuration } from "@/lib/attachment-grid.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { claimAudioPlayer, releaseAudioPlayer, stopActiveAudio } from "@/lib/audio-playback.ts";
import { useFilePreview, type PreviewOverrides } from "@/components/chat/attachment-media.tsx";

export function AudioCard({ file, api, previewOverrides, compact = false }: {
  file: AttachmentFile; api?: GatewayApi; previewOverrides?: PreviewOverrides; compact?: boolean;
}) {
  const { t } = useTranslation();
  const preview = useFilePreview(api, file.id, previewOverrides);
  const player = useAudioPlayer(api ? { uri: api.fileContentUrl(file.id), headers: api.headers(), name: file.name } : null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [seeking, setSeeking] = useState<number | null>(null);
  useLayoutEffect(() => () => {
    releaseAudioPlayer(player);
  }, [player]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") stopActiveAudio();
    });
    return () => {
      subscription.remove();
    };
  }, [player]);
  if (preview.failed && api) return <AttachmentFallbackRow file={file} />;
  const duration = preview.preview?.duration_ms ? preview.preview.duration_ms / 1000 : status.duration;
  const current = seeking ?? status.currentTime;
  const canSeek = Number.isFinite(duration) && duration > 0;
  const playLabel = status.playing ? t("暂停音频 {name}") : t("播放音频 {name}");
  return <View testID={`attachment-audio-${file.id}`} style={{ width: compact ? undefined : 300 }} className={compact ? "px-3 py-2" : "mt-2 rounded-2xl border border-border bg-card px-2.5 py-2.5"}>
    <View className="flex-row items-center gap-2.5">
      <Pressable accessibilityRole="button" accessibilityLabel={playLabel} disabled={!api} onPress={() => {
        if (status.playing) player.pause();
        else { claimAudioPlayer(player); if (status.didJustFinish) void player.seekTo(0); player.play(); }
      }} className="size-11 items-center justify-center rounded-full bg-primary">
        <Icon as={status.playing ? Pause : Play} className="size-5 text-primary-foreground" fill="currentColor" />
      </Pressable>
      <View className="min-w-0 flex-1"><Text numberOfLines={1} className="font-medium">{file.name}</Text>
        <Text className="text-xs text-muted-foreground">{formatDuration(Math.round(current * 1000)) ?? "0:00"} / {formatDuration(Math.round(duration * 1000)) ?? "--:--"}</Text></View>
    </View>
    <Slider accessibilityLabel={t("音频进度")}
      disabled={!canSeek} minimumValue={0} maximumValue={canSeek ? duration : 1} value={Math.min(canSeek ? duration : 1, Math.max(0, current))}
      minimumTrackTintColor="#6b7280" maximumTrackTintColor="#d1d5db" thumbTintColor="#111827"
      onValueChange={(value) => setSeeking(value)} onSlidingComplete={(value) => { setSeeking(null); void player.seekTo(value); }} />
    {!api ? <Text className="text-xs text-muted-foreground">{t("无网关不可播放")}</Text> : null}
  </View>;
}

function AttachmentFallbackRow({ file }: { file: AttachmentFile }) {
  return <Pressable onPress={() => router.push({ pathname: "/files/[id]", params: { id: file.id } })} className="mt-2 min-h-[52px] flex-row items-center gap-2.5 rounded-2xl border border-border bg-card px-3">
    <View className="size-8 items-center justify-center rounded-[9px] bg-muted"><FileTypeIcon mediaType={file.media_type} className="size-[18px] text-muted-foreground" /></View>
    <Text numberOfLines={1} className="min-w-0 flex-1 text-sm">{file.name}</Text><Icon as={Play} className="size-4 text-muted-foreground" />
  </Pressable>;
}
