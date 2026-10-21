import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Uniwind, useUniwind } from "uniwind";

import { AttachmentPreview } from "@/components/chat/attachment-preview.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { FilePreview } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import type { AttachmentFile } from "@/lib/attachment-grid.ts";
import type { PreviewOverrides } from "@/components/chat/attachment-media.tsx";

const previewSession = { api: undefined } as unknown as ChatSession;

function image(index: number): AttachmentFile {
  return { id: `attachment-preview-image-${index}`, name: `preview-${index}.png`, size: 1024, media_type: "image/png" };
}

function video(index: number): AttachmentFile {
  return { id: `attachment-preview-video-${index}`, name: `preview-${index}.mp4`, size: 2 * 1024 * 1024, media_type: "video/mp4" };
}

const scenarios = [
  ...[1, 2, 3, 4, 5, 9, 12].map((count) => ({
    id: String(count), title: `${count} 张`, files: Array.from({ length: count }, (_, index) => image(index + 1)),
  })),
  { id: "video", title: "单个视频", files: [video(1)] },
  { id: "video-mix", title: "视频 + 图片", files: [image(1), video(1), image(2), video(2)] },
  { id: "audio", title: "音频", files: [{ id: "attachment-preview-audio", name: "meeting.m4a", size: 3 * 1024 * 1024, media_type: "audio/mp4" }] },
  { id: "pdf", title: "PDF", files: [{ id: "attachment-preview-pdf", name: "brief.pdf", size: 820 * 1024, media_type: "application/pdf" }] },
] satisfies { id: string; title: string; files: AttachmentFile[] }[];

const mixedFiles: AttachmentFile[] = [
  image(1), video(3),
  { id: "attachment-preview-audio-mixed", name: "voice.m4a", size: 640 * 1024, media_type: "audio/mp4" },
  { id: "attachment-preview-pdf-mixed", name: "report.pdf", size: 1200 * 1024, media_type: "application/pdf" },
  { id: "attachment-preview-zip", name: "source.zip", size: 320 * 1024, media_type: "application/zip" },
];

const previewOverrides: PreviewOverrides = {
  ...Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`attachment-preview-video-${index + 1}`, {
    kind: "video", width: 1920, height: 1080, duration_ms: (index + 1) * 73_000, page_count: null,
  }] satisfies [string, FilePreview])),
  "attachment-preview-audio": { kind: "audio", width: null, height: null, duration_ms: 94_000, page_count: null },
  "attachment-preview-audio-mixed": { kind: "audio", width: null, height: null, duration_ms: 42_000, page_count: null },
  "attachment-preview-pdf": { kind: "pdf", width: 612, height: 792, duration_ms: null, page_count: 8 },
  "attachment-preview-pdf-mixed": { kind: "pdf", width: 612, height: 792, duration_ms: null, page_count: 14 },
};

export default function AttachmentPreviewRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <AttachmentPreviewDev />;
}

function AttachmentPreviewDev() {
  const insets = useSafeAreaInsets();
  const { theme, hasAdaptiveThemes } = useUniwind();
  const previousTheme = useRef<"light" | "dark" | "system">(hasAdaptiveThemes ? "system" : theme);
  const [selected, setSelected] = useState("5");
  useEffect(() => {
    const restore = previousTheme.current;
    return () => Uniwind.setTheme(restore);
  }, []);
  const scenario = scenarios.find((item) => item.id === selected);
  const files = selected === "mixed" ? mixedFiles : scenario?.files ?? scenarios[0].files;

  return <View className="flex-1 bg-background" style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}>
    <View className="gap-2 border-b border-border px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-lg font-semibold">附件宫格预览</Text>
        <Button size="sm" variant="outline" accessibilityLabel="切换预览主题"
          onPress={() => Uniwind.setTheme(theme === "dark" ? "light" : "dark")}>
          <Text>{theme === "dark" ? "浅色" : "深色"}</Text>
        </Button>
      </View>
      <Text className="text-xs text-muted-foreground">仅开发预览 · 缩略图/预览为本地 mock；无网关不可播放</Text>
      <View className="flex-row flex-wrap gap-2">
        {scenarios.map((item) => <Button key={item.id} size="sm" variant="outline"
          className={selected === item.id ? "border-foreground bg-muted" : "border-border"}
          accessibilityLabel={`预览${item.title}`} onPress={() => setSelected(item.id)}><Text>{item.title}</Text></Button>)}
        <Button size="sm" variant="outline" className={selected === "mixed" ? "border-foreground bg-muted" : "border-border"}
          accessibilityLabel="预览混合文件" onPress={() => setSelected("mixed")}><Text>混合文件</Text></Button>
      </View>
    </View>
    <ScrollView className="flex-1" contentContainerClassName="gap-4 px-4 py-4 pb-20">
      <Text className="text-xs text-muted-foreground">planner · {selected === "mixed" ? "图片 + 视频 + 音频 + PDF + 文件" : scenario?.title}</Text>
      <AttachmentPreview files={files} session={previewSession} previewOverrides={previewOverrides} />
    </ScrollView>
  </View>;
}
