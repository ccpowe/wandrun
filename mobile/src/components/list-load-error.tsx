import { View } from "react-native";

import { Button } from "@/components/ui/button.tsx";
import { Text } from "@/components/ui/text.tsx";
import { useTranslation } from "@/lib/i18n.ts";

type Props = {
  /** 已经有可显示的旧列表：提示“可能不是最新”；否则是首次加载失败，页面上没有别的内容。 */
  hasData: boolean;
  onRetry: () => void;
};

/** Agent 列表拉取失败的提示与重试入口（失败时 AgentList 也会自动退避重试，这里让用户能立刻再试）。 */
export function ListLoadError({ hasData, onRetry }: Props) {
  const { t } = useTranslation();
  return (
    <View className="mx-4 mb-2 flex-row items-center gap-3 rounded-md border border-destructive px-3.5 py-2.5">
      <Text className="flex-1 text-sm">{t(hasData ? "列表可能不是最新" : "没能加载 Agent 列表")}</Text>
      <Button variant="outline" size="sm" onPress={onRetry}>
        <Text>{t("重试")}</Text>
      </Button>
    </View>
  );
}
