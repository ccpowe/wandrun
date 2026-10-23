import { RotateCw, X } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";

import { FileTypeIcon } from "@/components/file-type-icon.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { UploadItem } from "@/lib/upload-draft-state.ts";
import { useTranslation } from "@/lib/i18n.ts";

export function AttachmentDrafts({ items, onRetry, onRemove }: {
  items: UploadItem[]; onRetry(id: string): void; onRemove(id: string): void;
}) {
  const { t } = useTranslation();
  if (!items.length) return null;
  return (
    <ScrollView testID="attachment-drafts" className="max-h-48" contentContainerClassName="gap-2 px-3 pb-2 pt-1" keyboardShouldPersistTaps="handled">
      {items.map((item) => (
        <View key={item.id} className={`flex-row items-center gap-2 rounded-xl border bg-muted p-2 ${item.error ? "border-destructive" : "border-transparent"}`}>
          <View className="size-10 items-center justify-center rounded-lg bg-card">
            <FileTypeIcon mediaType={item.mediaType} className="size-5 text-muted-foreground" />
          </View>
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="font-medium">{item.name}</Text>
            {item.fileId ? <Text testID={`upload-ready-${item.name}`} className="text-xs text-muted-foreground">{t("已上传")}</Text>
              : item.error ? <Text testID={`upload-error-${item.id}`} className="text-xs text-destructive" numberOfLines={2}>{t(item.error)}</Text>
              : <Text testID={`upload-progress-${item.id}`} className="text-xs text-muted-foreground">{t("上传中 · {progress}%", { progress: item.size ? Math.floor(item.progress / item.size * 100) : 0 })}</Text>}
          </View>
          {item.error && <Pressable testID={`upload-retry-${item.id}`} accessibilityRole="button" accessibilityLabel={t("重试上传 {name}", { name: item.name })}
            onPress={() => onRetry(item.id)} className="size-10 items-center justify-center">
            <Icon as={RotateCw} className="size-5 text-foreground" />
          </Pressable>}
          <Pressable testID={`upload-remove-${item.id}`} accessibilityRole="button" accessibilityLabel={t("移除附件 {name}", { name: item.name })}
            onPress={() => onRemove(item.id)} className="size-10 items-center justify-center">
            <Icon as={X} className="size-5 text-muted-foreground" />
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}
