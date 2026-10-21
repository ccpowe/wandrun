import { Pressable, ScrollView, View } from "react-native";

import { SelectionRow } from "@/components/agent-editor-controls.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { GatewayApi, ModelInfo } from "@/gateway/api.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { chooseModel, reasoningOptions, selectedModel, type ModelChoice } from "@/lib/model-selection.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { cn } from "@/lib/utils.ts";

export function ReasoningPicker({ model, effort, onChange, disabled = false, testIDPrefix }: {
  model: ModelInfo | undefined; effort: string | null; onChange: (effort: string) => void;
  disabled?: boolean; testIDPrefix: string;
}) {
  const { t, language } = useTranslation();
  const options = reasoningOptions(model);
  if (!model) return null;
  const selectedEffort = effort ?? model.default_reasoning_effort;
  return (
    <>
      <View className="mx-4 flex-row flex-wrap rounded-[14px] bg-muted p-[3px]">
        {options.map((option) => <Pressable key={option.value} testID={`${testIDPrefix}-${option.value}`}
          accessibilityRole="radio" accessibilityState={{ selected: selectedEffort === option.value, disabled }} accessibilityLabel={`${option.label}${selectedEffort === option.value ? t("，已选") : ""}`}
          // English options keep their content width and wrap as whole cells.
          disabled={disabled} onPress={() => onChange(option.value)}
          className={cn("min-h-[38px] min-w-[52px] items-center justify-center rounded-[11px] px-2",
            language === "en" ? "grow shrink-0 basis-auto" : "flex-1",
            selectedEffort === option.value && "border border-border bg-background")}
        ><Text className={cn("text-sm", selectedEffort !== option.value && "text-muted-foreground")}>{option.label}</Text></Pressable>)}
      </View>
      {effort !== null && !options.some((option) => option.value === effort) ? <Text className="mx-8 mt-2 text-xs text-muted-foreground">{t("当前强度为 {effort}，未选择新档位前保持原值。", { effort })}</Text> : null}
    </>
  );
}

/** Catalog-backed selection content; callers provide their own page header and commit behavior. */
export function ModelPicker({ api, model, reasoningEffort, onChange, disabled = false }: {
  api: GatewayApi; model: string; reasoningEffort: string | null;
  onChange: (value: ModelChoice) => void; disabled?: boolean;
}) {
  const { t, locale } = useTranslation();
  const { catalog, loading } = useModelCatalog(api, true);
  const models = catalog?.models ?? [];
  const current = selectedModel(models, model);
  return (
    <ScrollView keyboardShouldPersistTaps="handled" className="flex-1" contentContainerStyle={{ paddingBottom: 32 }}>
      <Text className="mx-6 mb-3 mt-2 text-sm text-muted-foreground">{t("选择使用的模型")}</Text>
      {!catalog && model ? <ListGroup>
        <View testID="model-current-unverified" className="min-h-[60px] justify-center px-4 py-2">
          <Text className="text-[15px] font-medium">{model}</Text>
          <Text className="text-[13px] text-muted-foreground">{t("当前模型 · 推理强度 {effort}", { effort: reasoningEffort ?? t("沿用默认") })}</Text>
        </View>
      </ListGroup> : null}
      {catalog && model && !current ? <ListGroup>
        <View testID="model-current-unlisted" className="min-h-[60px] justify-center px-4 py-2">
          <Text className="text-[15px] font-medium">{model}</Text>
          <Text className="text-[13px] text-muted-foreground">{t("当前模型（不在候选中）· 推理强度 {effort}", { effort: reasoningEffort ?? t("沿用默认") })}</Text>
        </View>
      </ListGroup> : null}
      <ListGroup>{models.map((item) => <SelectionRow key={item.id} testID={`model-row-${item.id}`} label={item.display_name || item.id} subtitle={item.description}
        selected={model === item.id} single disabled={disabled} onPress={() => onChange(chooseModel(item, reasoningEffort))} />)}</ListGroup>
      {current ? <Text className="mx-8 pb-2 pt-5 text-[13px] leading-[18px] text-muted-foreground">{t("推理强度")}</Text> : null}
      <ReasoningPicker model={current} effort={reasoningEffort} onChange={(reasoning_effort) => onChange({ model, reasoning_effort })}
        disabled={disabled || !catalog} testIDPrefix="model-effort" />
      {current ? <Text className="mx-8 mt-3 text-xs leading-[17px] text-muted-foreground">{t("推理越强，回答越慢、额度消耗越多。")}</Text> : null}
      {catalog ? <Text testID="model-catalog-updated" className="mx-8 mt-3 text-xs text-muted-foreground">
        {t("列表更新于 {time}", { time: new Date(catalog.fetched_at * 1000).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }) })}
      </Text> : null}
      {!catalog ? <Text testID="model-unavailable" className="mx-8 mt-4 text-sm text-muted-foreground">{loading ? t("正在获取模型列表…") : t("暂时无法获取模型列表")}</Text> : null}
    </ScrollView>
  );
}
