import { Children, type ReactNode } from "react";
import { View } from "react-native";

import { Separator } from "@/components/ui/separator.tsx";
import { Text } from "@/components/ui/text.tsx";
import { cn } from "@/lib/utils";

/** 无描边填充分组；divider 只控制分隔方式。 */
export function ListGroup({ label, children, surface = "filled", divider, inset = "icon", className }: {
  label?: string;
  children: ReactNode;
  surface?: "filled";
  divider?: "full" | "inset" | "gap" | "none";
  /** 无左图标的认证 / 工具行使用 content，分隔线从文字起点开始。 */
  inset?: "icon" | "content";
  className?: string;
}) {
  const items = Children.toArray(children);
  if (items.length === 0) return null;
  const filled = surface === "filled";
  const separator = divider ?? "inset";
  return (
    <View className={cn("mt-6", className)}>
      {label !== undefined && <Text className="mx-4 mb-2 px-4 text-xs text-muted-foreground">{label}</Text>}
      <View className={cn("mx-4 overflow-hidden rounded-lg", separator === "gap" && "gap-[3px]")}>
        {items.map((item, index) => (
          <View key={index} className={filled ? "bg-card" : undefined}>
            {index > 0 && separator === "full" ? <Separator /> : null}
            {index > 0 && separator === "inset" ? <View className={cn("mr-4 h-px bg-border/50", inset === "icon" ? "ml-12" : "ml-4")} /> : null}
            {item}
          </View>
        ))}
      </View>
    </View>
  );
}
