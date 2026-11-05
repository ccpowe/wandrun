import type { ReactNode } from "react";
import { View, type GestureResponderEvent } from "react-native";

import { Text, TextClassContext } from "@/components/ui/text.tsx";
import { SurfacePressable } from "@/components/ui/surface-pressable";
import { cn } from "@/lib/utils.ts";
import { useTranslation } from "@/lib/i18n.ts";

type Props = {
  testID?: string;
  accessibilityLabel?: string;
  /** 头像或占位；尺寸由场景调用方决定。 */
  leading?: ReactNode;
  title: string;
  /** 标题右侧的小字，如时间。 */
  meta?: string | null;
  /** 第二行内容：一般是 RowSubtitle，需要进度点等时自己组合。 */
  subtitle: ReactNode;
  /** 红点：需要用户处理（未读等）。 */
  alert?: boolean;
  /** drawer：无行首头像；body 标题、xs 元数据、72 最小高、行间 4。 */
  density?: "compact" | "drawer";
  selected?: boolean;
  pressedPreview?: boolean;
  className?: string;
  trailing?: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  onLongPress?: (event: GestureResponderEvent) => void;
};

/** 默认填充紧凑双行；抽屉密度不放行首大头像，保留自己的元数据结构。 */
export function ListRow({ testID, accessibilityLabel, leading, title, meta, subtitle, alert, trailing, disabled, onPress, onLongPress, density = "compact", selected, pressedPreview, className }: Props) {
  const { t } = useTranslation();
  if (density === "drawer") return <SurfacePressable testID={testID} disabled={disabled} accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled, selected }} onPress={onPress} onLongPress={onLongPress} pressedPreview={pressedPreview}
    className={cn("mx-3 mb-1 rounded-md", selected && "bg-secondary", className)}>
    <View className="min-h-[72px] flex-row items-center gap-3 px-3 py-3">
      <View className="min-w-0 flex-1 gap-2">
        <View className="flex-row items-center gap-2">
          <Text variant="body" numberOfLines={1} className="min-w-0 flex-1">{title}</Text>
          {alert ? <View accessibilityLabel={t("需要处理")} className="size-1.5 rounded-full bg-destructive" /> : null}
        </View>
        <TextClassContext.Provider value="text-xs text-muted-foreground">
          <View className="flex-row items-center gap-1.5">{subtitle}{meta ? <Text className="shrink" numberOfLines={1}>{meta}</Text> : null}</View>
        </TextClassContext.Provider>
      </View>
      {trailing}
    </View>
  </SurfacePressable>;
  return (
    <SurfacePressable
      testID={testID}
      disabled={disabled}
      accessibilityRole={onPress || onLongPress ? "button" : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      onPress={onPress}
      onLongPress={onLongPress}
      pressedPreview={pressedPreview}
      className={cn("flex-row items-center gap-3 bg-card px-4 py-2", subtitle ? "min-h-[60px]" : "min-h-[50px]", selected && "bg-secondary", className)}
    >
      {leading}
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-2">
          <Text variant="body" className="min-w-0 flex-1" numberOfLines={1}>
            {title}
          </Text>
          {meta ? <Text variant="caption" className="text-muted-foreground">{meta}</Text> : null}
        </View>
        <View className="flex-row items-center gap-2">
          <TextClassContext.Provider value="text-caption text-muted-foreground"><View className="min-w-0 flex-1 flex-row items-center gap-2">{subtitle}</View></TextClassContext.Provider>
          {alert ? <View accessibilityLabel={t("需要处理")} className="size-1.5 rounded-full bg-destructive" /> : null}
        </View>
      </View>
      {trailing}
    </SurfacePressable>
  );
}

/** 第二行文字：单行省略；tone 区分普通 / 进行中（前景色）/ 出错（红色）。 */
export function RowSubtitle({ text, tone = "muted" }: { text: string; tone?: "muted" | "active" | "error" }) {
  return (
    <Text
      numberOfLines={1}
      className={cn(
        "min-w-0 shrink text-caption",
        tone === "muted" && "text-muted-foreground",
        tone === "active" && "text-foreground",
        tone === "error" && "text-destructive",
      )}
    >
      {text}
    </Text>
  );
}
