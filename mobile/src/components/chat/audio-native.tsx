import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { router, useFocusEffect } from "expo-router";
import { Pause, Play } from "lucide-react-native";
import { useCallback, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import Slider from "@react-native-community/slider";
import { useCSSVariable } from "uniwind";

import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { GatewayApi } from "@/gateway/api.ts";
import type { AttachmentFile } from "@/lib/attachment-grid.ts";
import { formatDuration } from "@/lib/attachment-grid.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { claimAudioPlayer, releaseAudioPlayer } from "@/lib/audio-playback.ts";
import { useFilePreview, type PreviewOverrides } from "@/components/chat/attachment-media.tsx";
import { DrawerNativeControlGesture } from "@/components/chat/drawer-horizontal-gesture.tsx";

export function AudioCard({ file, api, previewOverrides, compact = false }: {
  file: AttachmentFile; api?: GatewayApi; previewOverrides?: PreviewOverrides; compact?: boolean;
}) {
  return <AudioCardResource key={`${api?.resourceIdentity}:${file.id}`} file={file} api={api} previewOverrides={previewOverrides} compact={compact} />;
}
function AudioCardResource({ file, api, previewOverrides, compact }: {
  file: AttachmentFile; api?: GatewayApi; previewOverrides?: PreviewOverrides; compact: boolean;
}) {
  const { t } = useTranslation();
  const [foreground, mutedForeground, border] = useCSSVariable(["--color-foreground", "--color-muted-foreground", "--color-border"]);
  const preview = useFilePreview(api, file.id, previewOverrides);
  const player = useAudioPlayer(api ? { uri: api.fileContentUrl(file.id), headers: api.headers(), name: file.name } : null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [seeking, setSeeking] = useState<number | null>(null);
  useFocusEffect(useCallback(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state !== "active") releaseAudioPlayer(player);
    });
    return () => { subscription.remove(); releaseAudioPlayer(player); };
  }, [player]));
  if (preview.failed && api) return <AttachmentFallbackRow file={file} />;
  const duration = preview.preview?.duration_ms ? preview.preview.duration_ms / 1000 : status.duration;
  const current = seeking ?? status.currentTime;
  const canSeek = Number.isFinite(duration) && duration > 0;
  const playLabel = t(status.playing ? "暂停音频 {name}" : "播放音频 {name}", { name: file.name });
  return <View testID={`attachment-audio-${file.id}`} style={{ width: compact ? undefined : 300 }} className={compact ? "px-3 py-2" : "mt-2 rounded-lg bg-card p-3"}>
    <View className="flex-row items-center gap-2.5">
      <Pressable accessibilityRole="button" accessibilityLabel={playLabel} disabled={!api} onPress={() => {
        if (status.playing) player.pause();
        else { claimAudioPlayer(player); if (status.didJustFinish) void player.seekTo(0); player.play(); }
      }} className="size-12 items-center justify-center rounded-full bg-primary">
        <Icon as={status.playing ? Pause : Play} className="size-5 text-primary-foreground" fill="currentColor" />
      </Pressable>
      <View className="min-w-0 flex-1"><Text variant="body" numberOfLines={1}>{file.name}</Text>
        <Text className="text-xs text-muted-foreground">{formatDuration(Math.round(current * 1000)) ?? "0:00"} / {formatDuration(Math.round(duration * 1000)) ?? "--:--"}</Text></View>
    </View>
    <DrawerNativeControlGesture><Slider accessibilityLabel={t("音频进度")}
      disabled={!canSeek} minimumValue={0} maximumValue={canSeek ? duration : 1} value={Math.min(canSeek ? duration : 1, Math.max(0, current))}
      minimumTrackTintColor={String(mutedForeground)} maximumTrackTintColor={String(border)} thumbTintColor={String(foreground)}
      onValueChange={(value) => setSeeking(value)} onSlidingComplete={(value) => { setSeeking(null); void player.seekTo(value); }} /></DrawerNativeControlGesture>
    {!api ? <Text className="text-xs text-muted-foreground">{t("无网关不可播放")}</Text> : null}
  </View>;
}

function AttachmentFallbackRow({ file }: { file: AttachmentFile }) {
  return <Pressable onPress={() => router.push({ pathname: "/files/[id]", params: { id: file.id } })} className="mt-2 min-h-[52px] flex-row items-center gap-3 rounded-lg bg-card px-3">
    <View className="size-8 items-center justify-center rounded-md bg-muted"><FileTypeIcon mediaType={file.media_type} name={file.name} className="size-5 text-muted-foreground" /></View>
    <Text variant="body" numberOfLines={1} className="min-w-0 flex-1">{file.name}</Text><Icon as={Play} className="size-4 text-muted-foreground" />
  </Pressable>;
}
