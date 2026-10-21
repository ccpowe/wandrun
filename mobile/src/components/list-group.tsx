import { Children, type ReactNode } from "react";
import { View } from "react-native";

import { Separator } from "@/components/ui/separator.tsx";
import { Text } from "@/components/ui/text.tsx";

/** 分组（视觉方向 v1）：小字标题 + 圆角描边卡片，子项之间一条细线。子项为空时整组不显示。 */
export function ListGroup({ label, children }: { label?: string; children: ReactNode }) {
  const items = Children.toArray(children);
  if (items.length === 0) return null;
  return (
    <View>
      {label !== undefined && <Text className="px-8 pb-2 pt-5 text-[13px] leading-[18px] text-muted-foreground">{label}</Text>}
      <View className="mx-4 overflow-hidden rounded-md border border-border bg-card">
        {items.map((item, index) => (
          <View key={index}>
            {index > 0 ? <Separator /> : null}
            {item}
          </View>
        ))}
      </View>
    </View>
  );
}
