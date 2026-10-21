import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/utils.ts";
import { useTranslation } from "@/lib/i18n.ts";

type Props = {
  testID?: string;
  /** 头像或占位；尺寸由调用方按 compact 选（52 / 40）。 */
  leading: ReactNode;
  title: string;
  /** 标题右侧的小字，如时间。 */
  meta?: string | null;
  /** 第二行内容：一般是 RowSubtitle，需要进度点等时自己组合。 */
  subtitle: ReactNode;
  /** 红点：需要用户处理（未读等）。 */
  alert?: boolean;
  /** 放在分组里的紧凑行（40px 头像、更小的副标题）；默认是首页的大行。 */
  compact?: boolean;
  trailing?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
};

/**
 * 列表行（视觉方向 v1）：头像、名字 + 时间、第二行 + 红点。背景由外层决定（分组卡片或页面），
 * 本身透明，所以放进左滑行时由 SwipeRow 给不透明底色。
 */
export function ListRow({ testID, leading, title, meta, subtitle, alert, compact, trailing, onPress, onLongPress }: Props) {
  const { t } = useTranslation();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      className={cn("flex-row items-center gap-3 px-4 py-2.5 active:bg-accent", compact ? "min-h-[60px]" : "min-h-[72px]")}
    >
      {leading}
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text className="min-w-0 flex-1 text-lg font-medium" numberOfLines={1}>
            {title}
          </Text>
          {meta ? <Text className="text-xs text-muted-foreground">{meta}</Text> : null}
        </View>
        <View className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1 flex-row items-center gap-2">{subtitle}</View>
          {alert ? <View accessibilityLabel={t("需要处理")} className="size-2 rounded-full bg-destructive" /> : null}
        </View>
      </View>
      {trailing}
    </Pressable>
  );
}

/** 第二行文字：单行省略；tone 区分普通 / 进行中（前景色）/ 出错（红色）。 */
export function RowSubtitle({ text, tone = "muted", compact }: { text: string; tone?: "muted" | "active" | "error"; compact?: boolean }) {
  return (
    <Text
      numberOfLines={1}
      className={cn(
        "min-w-0 shrink",
        compact ? "text-[13px] leading-[18px]" : "text-sm",
        tone === "muted" && "text-muted-foreground",
        tone === "active" && "text-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      {text}
    </Text>
  );
}
