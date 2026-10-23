import { router } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import { lazy, Suspense, useEffect, useState } from "react";
import { Pressable, useWindowDimensions, View } from "react-native";
import { AgentMemoryMarkdown } from "@/components/agent-memory-markdown.tsx";
import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { AudioCard, PdfCard, ThumbnailImage, VideoGridCell, openVideo, type PreviewOverrides, useFilePreview } from "@/components/chat/attachment-media.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { FileDetail, FileRecord } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { attachmentDisplayWidth, groupAttachments, loadMarkdownPrefix, imageGridCells, imageGridHeight, isAudioAttachment, isImageAttachment, isPdfAttachment, isVideoAttachment, moreImagesCount, singleImageSize, ATTACHMENT_GRID, type AttachmentFile } from "@/lib/attachment-grid.ts";
import { useTranslation } from "@/lib/i18n.ts";
// These UI-only modules are deferred because Node unit-test host stubs do not provide Expo image or accordion hosts.
const LazyAccordion = lazy(async () => ({ default: (await import("@/components/ui/accordion.tsx")).Accordion }));
const LazyAccordionContent = lazy(async () => ({ default: (await import("@/components/ui/accordion.tsx")).AccordionContent }));
const LazyAccordionItem = lazy(async () => ({ default: (await import("@/components/ui/accordion.tsx")).AccordionItem }));
const LazyAccordionTrigger = lazy(async () => ({ default: (await import("@/components/ui/accordion.tsx")).AccordionTrigger }));


type CardFile = Pick<FileRecord, "id" | "name" | "size" | "media_type"> & Partial<Pick<FileRecord, "remote_environment">>;
/** Attachment lookup uses the message's visible timeline, not its root resource conversation. */
export type AttachmentOwner = { timelineId?: string; messageSeq?: number };

type FileNotice = { api: ChatSession["api"]; id: string; text: string } | null;

function useFileNotice(file: CardFile, api: ChatSession["api"]): string | null {
  const [notice, setNotice] = useState<FileNotice>(null);
  const { t } = useTranslation();
  useEffect(() => {
    if (!file.remote_environment) return;
    let active = true;
    void api.getFile(file.id).then((detail: FileDetail) => {
      if (active && !api.signal.aborted) setNotice({ api, id: file.id, text: detail.available ? "" : detail.error_message ?? "文件暂不可用" });
    }).catch((cause: unknown) => {
      if (active && !api.signal.aborted) setNotice({ api, id: file.id, text: cause instanceof Error ? cause.message : "无法读取文件信息" });
    });
    return () => { active = false; };
  }, [api, file.id, file.remote_environment]);
  const text = file.remote_environment && notice?.api === api && notice.id === file.id ? notice.text : null;
  return text ? t(text) : null;
}

function openFile(file: CardFile): void {
  router.push({ pathname: "/files/[id]", params: { id: file.id } });
}

function FileCard({ file, api, mine = false }: { file: CardFile; api: ChatSession["api"]; mine?: boolean }) {
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const explanation = useFileNotice(file, api);
  return <Pressable testID={`attachment-${file.id}`} accessibilityRole="button"
    accessibilityLabel={t("查看文件 {name}", { name: file.name })} onPress={() => openFile(file)}
    style={{ width: attachmentDisplayWidth(screenWidth, mine) }}
    className="mt-2 flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3 active:bg-muted">
    <View className="size-12 items-center justify-center rounded-xl bg-muted">
      <FileTypeIcon mediaType={file.media_type} className="size-6 text-muted-foreground" />
    </View>
    <View className="min-w-0 flex-1">
      <Text numberOfLines={1} className="font-medium">{file.name}</Text>
      <Text className="text-xs text-muted-foreground">{Math.ceil(file.size / 1024)} KB · {file.remote_environment ? t("远端文件") : t("原文件")}</Text>
      {explanation ? <Text testID={`attachment-unavailable-${file.id}`} className="mt-1 text-xs text-muted-foreground">{explanation}</Text> : null}
    </View>
    <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
  </Pressable>;
}

function openImage(owner: AttachmentOwner | undefined, images: readonly CardFile[], index: number): void {
  const file = images[index];
  if (!file) return;
  const params = owner?.timelineId && owner.messageSeq !== undefined
    ? { id: owner.timelineId, seq: String(owner.messageSeq), file_id: file.id, index: String(index) }
    : { file_id: file.id, file_ids: JSON.stringify(images.map((entry) => entry.id)), index: String(index) };
  router.push({ pathname: "/media-viewer", params });
}

function ImageCell({ file, api, width, height, onOpen, previewOverrides }: {
  file: CardFile; api: ChatSession["api"]; width: number; height: number; onOpen: () => void; previewOverrides?: PreviewOverrides;
}) {
  const video = isVideoAttachment(file);
  return <View style={{ width, height }} testID={`attachment-${video ? "video" : "image"}-${file.id}`}>
    {video
      ? <VideoGridCell file={file} api={api} width={width} height={height} onOpen={onOpen} previewOverrides={previewOverrides} />
      : <ThumbnailImage file={file} api={api} width={width} height={height} onOpen={onOpen} previewOverrides={previewOverrides} />}
  </View>;
}

function ImageGrid({ images, session, owner, mine, previewOverrides }: {
  images: readonly CardFile[]; session: ChatSession; owner?: AttachmentOwner; mine: boolean; previewOverrides?: PreviewOverrides;
}) {
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const width = attachmentDisplayWidth(screenWidth, mine);
  const first = images[0];
  const firstPreview = useFilePreview(session.api, first?.id ?? "", previewOverrides);
  const imageFiles = images.filter(isImageAttachment);
  const single = images.length === 1;
  if (single && first && isVideoAttachment(first)) {
    return <View testID="attachment-video-card" className="mt-2 overflow-hidden rounded-2xl" style={{ width, height: 168 }}>
      <VideoGridCell file={first} api={session.api} width={width} height={168} onOpen={() => openVideo(first.id)} previewOverrides={previewOverrides} />
    </View>;
  }
  if (single && first) {
    const intrinsic = firstPreview.preview?.width && firstPreview.preview.height
      ? { width: firstPreview.preview.width, height: firstPreview.preview.height } : null;
    const size = intrinsic ? singleImageSize(width, intrinsic) : { width, height: 180 };
    return <View testID="attachment-image-grid" className="mt-2 overflow-hidden rounded-2xl" style={{ width: size.width, height: size.height }}>
      <ThumbnailImage file={first} api={session.api} width={size.width} height={size.height}
        onOpen={() => openImage(owner, imageFiles, 0)} previewOverrides={previewOverrides} />
    </View>;
  }
  const cells = imageGridCells(images.length, width);
  const byIndex = new Map(cells.map((cell) => [cell.index, cell]));
  const height = imageGridHeight(images.length, width);
  const moreCell = byIndex.get(ATTACHMENT_GRID.maxVisibleImages - 1);
  const open = (file: CardFile, index: number) => {
    if (isVideoAttachment(file)) return openVideo(file.id);
    const imageIndex = imageFiles.findIndex((entry) => entry.id === file.id);
    if (imageIndex >= 0) openImage(owner, imageFiles, imageIndex);
  };
  return <View testID="attachment-image-grid" className="mt-2 overflow-hidden rounded-2xl" style={{ width, height }}>
    {images.slice(0, ATTACHMENT_GRID.maxVisibleImages).map((file, index) => {
      const cell = byIndex.get(index)!;
      return <View key={file.id} style={{ position: "absolute", left: cell.x, top: cell.y }}>
        <ImageCell file={file} api={session.api} width={cell.width} height={cell.height} previewOverrides={previewOverrides} onOpen={() => open(file, index)} />
      </View>;
    })}
    {moreImagesCount(images.length) > 0 && moreCell ? <Pressable testID="attachment-image-more" accessibilityRole="button"
      accessibilityLabel={t("查看第 {index} 个媒体", { index: ATTACHMENT_GRID.maxVisibleImages })}
      onPress={() => open(images[ATTACHMENT_GRID.maxVisibleImages - 1], ATTACHMENT_GRID.maxVisibleImages - 1)}
      className="items-center justify-center" style={{ position: "absolute", left: moreCell.x, top: moreCell.y, width: moreCell.width, height: moreCell.height, backgroundColor: "rgba(0,0,0,0.58)" }}>
      <Text className="text-[22px] font-semibold text-white">+{moreImagesCount(images.length)}</Text>
    </Pressable> : null}
  </View>;
}

function FileRow({ file, api }: { file: CardFile; api: ChatSession["api"] }) {
  const { t } = useTranslation();
  const explanation = useFileNotice(file, api);
  return <Pressable testID={`attachment-compact-${file.id}`} accessibilityRole="button"
    accessibilityLabel={t("查看文件 {name}", { name: file.name })} onPress={() => openFile(file)}
    className="min-h-[52px] flex-row items-center gap-2.5 px-3 active:bg-muted">
    <View className="size-8 items-center justify-center rounded-[9px] bg-muted">
      <FileTypeIcon mediaType={file.media_type} className="size-[18px] text-muted-foreground" />
    </View>
    <View className="min-w-0 flex-1">
      <Text numberOfLines={1} className="text-sm">{file.name}</Text>
      <Text numberOfLines={1} className="text-xs text-muted-foreground">{Math.ceil(file.size / 1024)} KB · {file.remote_environment ? t("远端文件") : t("原文件")}{explanation ? ` · ${explanation}` : ""}</Text>
    </View>
    <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
  </Pressable>;
}

function CompactFileGroup({ files, session, mine, previewOverrides }: {
  files: readonly CardFile[]; session: ChatSession; mine: boolean; previewOverrides?: PreviewOverrides;
}) {
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const hidden = Math.max(0, files.length - ATTACHMENT_GRID.maxVisibleFiles);
  const shown = files.slice(0, ATTACHMENT_GRID.maxVisibleFiles);
  const row = (file: CardFile) => isAudioAttachment(file)
    ? <AudioCard file={file} api={session.api} previewOverrides={previewOverrides} compact />
    : isPdfAttachment(file)
      ? <PdfCard file={file} api={session.api} previewOverrides={previewOverrides} compact />
      : <FileRow file={file} api={session.api} />;
  return <View testID="attachment-file-group" style={{ width: attachmentDisplayWidth(screenWidth, mine) }}
    className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
    {shown.map((file, index) => <View key={file.id} className={index ? "border-t border-border" : undefined}>{row(file)}</View>)}
    {hidden > 0 ? <Suspense fallback={<Text>{t("还有 {count} 个文件", { count: hidden })}</Text>}>
      <LazyAccordion type="single" collapsible>
        <LazyAccordionItem value="more" className="border-t-0">
          <LazyAccordionTrigger testID="attachment-file-more" className="min-h-[52px] px-3 py-0">
            <Text>{t("还有 {count} 个文件", { count: hidden })}</Text>
          </LazyAccordionTrigger>
          <LazyAccordionContent className="pb-0">
            {files.slice(ATTACHMENT_GRID.maxVisibleFiles).map((file) => <View key={file.id} className="border-t border-border">{row(file)}</View>)}
          </LazyAccordionContent>
        </LazyAccordionItem>
      </LazyAccordion>
    </Suspense> : null}
  </View>;
}

function isMarkdown(file: CardFile): boolean {
  const type = file.media_type.split(";", 1)[0].trim().toLowerCase();
  return type === "text/markdown" || /\.md(?:own)?$/i.test(file.name);
}

function MarkdownSummaryCard({ file, session, mine }: { file: CardFile; session: ChatSession; mine: boolean }) {
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const [state, setState] = useState<{ key: string; content: string | null; failed: boolean }>({ key: "", content: null, failed: false });
  const key = `${session.api.config.computerId}:${file.id}:${file.size}`;
  useEffect(() => {
    let active = true;
    void loadMarkdownPrefix(session.api, file.id, file.size).then((content) => {
      if (active && !session.api.signal.aborted) setState({ key, content, failed: false });
    }).catch(() => {
      if (active && !session.api.signal.aborted) setState({ key, content: null, failed: true });
    });
    return () => { active = false; };
  }, [file.id, file.size, session.api, key]);
  if (state.key === key && state.failed) return <FileCard file={file} api={session.api} mine={mine} />;
  return <Pressable testID={`attachment-markdown-${file.id}`} accessibilityRole="button"
    accessibilityLabel={t("查看文件 {name}", { name: file.name })} onPress={() => openFile(file)}
    style={{ width: attachmentDisplayWidth(screenWidth, mine) }}
    className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
    <View className="relative h-24 overflow-hidden bg-muted px-3.5 pt-3">
      {state.key === key && state.content !== null ? <View pointerEvents="none"><AgentMemoryMarkdown content={state.content} readOnly compact /></View> : <Text>{t("加载中…")}</Text>}
      <View pointerEvents="none" className="absolute bottom-0 left-0 right-0 h-7">
        <View className="h-2 bg-muted/20" />
        <View className="h-2 bg-muted/40" />
        <View className="h-2 bg-muted/60" />
        <View className="h-2 bg-muted/80" />
      </View>
    </View>
    <View className="flex-row items-center gap-2.5 px-3 py-2.5">
      <View className="size-8 items-center justify-center rounded-[9px] bg-muted">
        <FileTypeIcon mediaType={file.media_type} className="size-[18px] text-muted-foreground" />
      </View>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm">{file.name}</Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">{Math.ceil(file.size / 1024)} KB · {t("原文件")}</Text>
      </View>
      <Icon as={ChevronRight} className="size-4 text-muted-foreground" />
    </View>
  </Pressable>;
}

export function AttachmentPreview({ files, session, owner, mine = false, previewOverrides }: {
  files: readonly AttachmentFile[]; session: ChatSession; owner?: AttachmentOwner; mine?: boolean; previewOverrides?: PreviewOverrides;
}) {
  const { images, files: otherFiles } = groupAttachments(files);
  if (!files.length) return null;
  const singleOther = otherFiles[0];
  return <View className={mine ? "items-end" : undefined} testID="attachment-preview">
    {images.length ? <ImageGrid images={images} session={session} owner={owner} mine={mine} previewOverrides={previewOverrides} /> : null}
    {otherFiles.length === 1 && !singleOther.remote_environment && isMarkdown(singleOther)
      ? <MarkdownSummaryCard file={singleOther} session={session} mine={mine} />
      : otherFiles.length === 1 && isAudioAttachment(singleOther)
        ? <AudioCard file={singleOther} api={session.api} previewOverrides={previewOverrides} />
        : otherFiles.length === 1 && isPdfAttachment(singleOther)
          ? <PdfCard file={singleOther} api={session.api} previewOverrides={previewOverrides} />
          : otherFiles.length === 1
            ? <FileCard file={singleOther} api={session.api} mine={mine} />
            : otherFiles.length > 1 ? <CompactFileGroup files={otherFiles} session={session} mine={mine} previewOverrides={previewOverrides} /> : null}
  </View>;
}

