import type { ReactNode } from "react";
import { Image, View } from "react-native";

import { Text } from "@/components/ui/text.tsx";
import { useTranslation } from "@/lib/i18n.ts";

const ART = require("../../assets/empty-together.png");

type Props = { title: string; description?: string; children?: ReactNode };

/** 空状态（视觉方向 v1）：角色插画 + 标题 + 可选说明；children 放操作按钮（描边 Button，纵向排列）。 */
export function EmptyState({ title, description, children }: Props) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 items-center justify-center gap-3 px-8 pb-16">
      <Image source={ART} accessibilityLabel={t("两只小生物举着一张白纸")} className="h-[131px] w-[260px]" resizeMode="contain" />
      <Text className="mt-3 text-xl font-semibold">{title}</Text>
      {description ? <Text className="text-center text-sm text-muted-foreground">{description}</Text> : null}
      {children ? <View className="mt-2 items-center gap-3">{children}</View> : null}
    </View>
  );
}
