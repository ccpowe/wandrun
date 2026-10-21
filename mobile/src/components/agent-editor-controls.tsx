import { Check, ChevronRight } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/utils.ts";

export function EditorRow({ label, value, description, testID, onPress, trailing }: {
  label: string; value?: string; description?: string; testID?: string;
  onPress?: () => void; trailing?: ReactNode;
}) {
  return (
    <Pressable testID={testID} accessibilityRole={onPress ? "button" : undefined} accessibilityLabel={label}
      onPress={onPress} className={cn("min-h-[52px] flex-row items-center gap-3 px-4 py-2.5", onPress && "active:bg-muted")}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-[15px]">{label}</Text>
        {description ? <Text className="text-xs leading-[18px] text-muted-foreground" numberOfLines={2}>{description}</Text> : null}
      </View>
      {value ? <Text className="max-w-[45%] text-sm text-muted-foreground" numberOfLines={1}>{value}</Text> : null}
      {trailing ?? (onPress ? <Icon as={ChevronRight} className="size-[18px] text-muted-foreground" /> : null)}
    </Pressable>
  );
}

export function SelectionRow({ label, subtitle, testID, selected, onPress, leading, single = false, disabled = false }: {
  label: string; subtitle?: string; testID: string; selected: boolean; onPress: () => void;
  leading?: ReactNode; single?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable testID={testID} accessibilityRole={single ? "radio" : "checkbox"} disabled={disabled}
      accessibilityState={{ selected, checked: selected, disabled }} accessibilityLabel={label}
      onPress={onPress} className="min-h-[60px] flex-row items-center gap-3 px-4 py-2 active:bg-muted"
    >
      {leading}
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-medium" numberOfLines={1}>{label}</Text>
        {subtitle ? <Text className="text-[13px] leading-[18px] text-muted-foreground" numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      <View className={cn("size-6 items-center justify-center rounded-full border-[1.5px]",
        single ? selected ? "border-foreground bg-card" : "border-border bg-card" : selected ? "border-foreground bg-foreground" : "border-border")}
      >{selected ? single ? <View className="size-3 rounded-full bg-foreground" /> : <Icon as={Check} className="size-4 text-background" strokeWidth={2.5} /> : null}</View>
    </Pressable>
  );
}
