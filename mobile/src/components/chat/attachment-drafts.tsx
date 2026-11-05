import { Image } from "expo-image";
import { Check, RotateCw, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { UploadItem } from "@/lib/upload-draft-state.ts";
import { useTranslation } from "@/lib/i18n.ts";

/** Chip height; the corner × and the retry button must not share any touch point (native hit order picks the later ×). */
export const CHIP = 56;
export const REMOVE = { size: 20, offset: 6, hitSlop: { top: 14, left: 14, right: 14, bottom: 6 } } as const;
/** Retry sits at the bottom of a failed chip, below the reach of the corner ×. */
export const RETRY = { size: 32, bottom: 4 } as const;

/** A failed thumbnail must not make the original attachment unsendable. */
function DraftPicture({ item }: { item: UploadItem }) {
  const [failed, setFailed] = useState(false);
  if (!item.previewUri || failed) {
    return <View accessible accessibilityRole="image" accessibilityLabel={item.name}>
      <FileTypeIcon mediaType={item.mediaType} name={item.name} className="size-6 text-muted-foreground" />
    </View>;
  }
  return <Image source={{ uri: item.previewUri }} contentFit="cover" cachePolicy="none"
    accessibilityLabel={item.name} onError={() => setFailed(true)}
    style={{ width: "100%", height: "100%" }} />;
}

export function AttachmentDrafts({ items, onRetry, onRemove, disabled = false }: {
  items: UploadItem[]; onRetry(id: string): void; onRemove(id: string): void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (!items.length) return null;
  // Inside the muted composer field: card chips without borders; failure is red text only (design.md §1).
  return (
    <ScrollView testID="attachment-drafts" horizontal showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2.5 px-2.5 pt-2.5" keyboardShouldPersistTaps="handled">
      {items.map((item) => {
        const picture = item.mediaType.startsWith("image/") && !item.error;
        const progress = item.size ? Math.min(100, Math.floor(item.progress / item.size * 100)) : 0;
        const extension = item.name.includes(".") ? item.name.split(".").at(-1) : null;
        const kind = extension && /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toUpperCase() : t("文件");
        const progressText = <Text testID={`upload-progress-${item.id}`} className="text-xs text-muted-foreground"
          accessibilityLabel={t("上传中 · {progress}%", { progress })}>{progress}%</Text>;
        const remove = <Pressable testID={`upload-remove-${item.id}`} disabled={disabled} accessibilityRole="button" accessibilityLabel={t("移除附件 {name}", { name: item.name })}
          hitSlop={REMOVE.hitSlop} onPress={() => onRemove(item.id)}
          style={{ position: "absolute", top: -REMOVE.offset, right: -REMOVE.offset, width: REMOVE.size, height: REMOVE.size }}
          className="items-center justify-center rounded-full bg-muted-foreground">
          <Icon as={X} size={12} className="text-background" />
        </Pressable>;
        if (picture) return <View key={item.id} style={{ width: CHIP, height: CHIP }}>
          <View className="flex-1 items-center justify-center overflow-hidden rounded-md bg-card">
            <DraftPicture key={item.previewUri ?? item.id} item={item} />
          </View>
          <View className="absolute bottom-1 left-1 rounded-sm bg-card px-1">
            {item.fileId ? <View testID={`upload-ready-${item.name}`} accessible accessibilityLabel={t("已上传")}>
              <Icon as={Check} className="size-3 text-muted-foreground" />
            </View> : progressText}
          </View>
          {remove}
        </View>;
        return <View key={item.id} className={`max-w-[220px] flex-row items-center gap-2 rounded-md bg-card pl-3 ${item.error ? "pr-1" : "pr-3"}`} style={{ height: CHIP }}>
          <FileTypeIcon mediaType={item.mediaType} name={item.name} className="size-5 shrink-0 text-muted-foreground" />
          <View className="min-w-0 shrink">
            <Text variant="caption" numberOfLines={1}>{item.name}</Text>
            {item.error
              ? <Text testID={`upload-error-${item.id}`} className="text-xs text-destructive" numberOfLines={1}>{t(item.error)}</Text>
              : item.fileId
                ? <View testID={`upload-ready-${item.name}`} accessible accessibilityLabel={`${kind} · ${t("已上传")}`} className="flex-row items-center gap-1">
                  <Text className="text-xs text-muted-foreground">{kind}</Text>
                  <Icon as={Check} className="size-3 text-muted-foreground" />
                </View>
                : progressText}
          </View>
          {item.error && <Button intent="quiet" size="icon-sm" disabled={disabled} testID={`upload-retry-${item.id}`}
            style={{ alignSelf: "flex-end", marginBottom: RETRY.bottom }}
            accessibilityLabel={t("重试上传 {name}", { name: item.name })} onPress={() => onRetry(item.id)}>
            <Icon as={RotateCw} size={18} />
          </Button>}
          {remove}
        </View>;
      })}
    </ScrollView>
  );
}
