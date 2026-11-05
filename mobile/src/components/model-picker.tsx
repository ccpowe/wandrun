import Slider from "@react-native-community/slider";
import { Zap } from "lucide-react-native";
import { Pressable, ScrollView, View } from "react-native";
import { useCSSVariable } from "uniwind";

import { GroupRow } from "@/components/group-row.tsx";
import { ListGroup } from "@/components/list-group.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { Text } from "@/components/ui/text.tsx";
import type { ModelInfo } from "@/gateway/api.ts";
import type { ChatSession } from "@/gateway/session.ts";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { chooseModel, reasoningOptions, selectedModel, type ModelChoice } from "@/lib/model-selection.ts";
import { useTranslation } from "@/lib/i18n.ts";
import { cn } from "@/lib/utils.ts";

/** Ordinals belong to this catalog, not a fixed effort scale; only deliberate interaction changes the draft. */
export function ReasoningPicker({ model, effort, onChange, disabled = false, testIDPrefix }: {
  model: ModelInfo | undefined; effort: string | null; onChange: (effort: string) => void;
  disabled?: boolean; testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const [foreground, border] = useCSSVariable(["--color-foreground", "--color-border"]);
  const options = reasoningOptions(model);
  const selectedEffort = effort ?? model?.default_reasoning_effort;
  const index = options.findIndex((option) => option.value === selectedEffort);
  const label = options[index]?.label ?? selectedEffort ?? t("沿用默认");
  const locked = disabled || options.length < 2;
  const select = (value: number) => {
    if (locked || !Number.isInteger(value)) return;
    const option = options[value];
    if (option) onChange(option.value);
  };
  return (
    <View className="gap-1">
      <View className="flex-row items-center justify-between gap-3">
        <Text variant="body">{t("推理强度")}</Text>
        <Text variant="caption" testID={`${testIDPrefix}-value`} className="shrink text-muted-foreground">{label}</Text>
      </View>
      {options.length > 1 ? <Slider testID={`${testIDPrefix}-slider`} style={{ width: "100%", height: 40 }}
        accessibilityLabel={t("推理强度")} accessibilityRole="adjustable"
        accessibilityState={{ disabled: locked }} accessibilityValue={{ min: 0, max: options.length - 1, ...(index >= 0 ? { now: index } : {}), text: label }}
        disabled={locked} minimumValue={0} maximumValue={options.length - 1} step={1} value={index < 0 ? 0 : index}
        minimumTrackTintColor={String(foreground)} maximumTrackTintColor={String(border)} thumbTintColor={String(foreground)}
        tapToSeek onValueChange={select} onSlidingComplete={select} /> : null}
      {selectedEffort != null && index < 0 && model ? <Text variant="caption" className="text-muted-foreground">{t("当前强度为 {effort}，未选择新档位前保持原值。", { effort: selectedEffort })}</Text> : null}
    </View>
  );
}

export function FastModeToggle({ enabled, disabled, disabledReason, onChange }: {
  enabled: boolean; disabled: boolean; disabledReason?: string; onChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  return <Pressable testID="editor-fast-mode" accessibilityRole="togglebutton" accessibilityLabel={t("Fast 模式")}
    accessibilityState={{ selected: enabled, checked: enabled, disabled }} aria-pressed={enabled} accessibilityHint={disabledReason}
    disabled={disabled} onPress={() => { if (!disabled) onChange(!enabled); }}
    className={cn("min-h-11 min-w-11 items-center justify-center active:opacity-60", disabled && "opacity-40")}>
    <Icon as={Zap} fill={enabled ? "currentColor" : "none"} className={cn("size-5", enabled ? "text-foreground" : "text-muted-foreground")} />
  </Pressable>;
}

/** Catalog-backed selection content; callers provide their own page header and commit behavior. */
export function ModelPicker({ session, model, reasoningEffort, onChange, disabled = false }: {
  session: ChatSession; model: string; reasoningEffort: string | null;
  onChange: (value: ModelChoice) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { catalog, loading, error } = useModelCatalog(session);
  const models = catalog?.models ?? [];
  const current = selectedModel(models, model);
  return (
    <ScrollView keyboardShouldPersistTaps="handled" className="flex-1" contentContainerStyle={{ paddingBottom: 32 }}>
      {!catalog && model ? <ListGroup inset="content">
        <View testID="model-current-unverified" className="min-h-[60px] justify-center px-4 py-2">
          <Text variant="body" className="font-medium">{model}</Text>
          <Text variant="caption" className="text-muted-foreground">{t("当前模型 · 推理强度 {effort}", { effort: reasoningEffort ?? t("沿用默认") })}</Text>
        </View>
      </ListGroup> : null}
      {catalog && model && !current ? <ListGroup inset="content">
        <View testID="model-current-unlisted" className="min-h-[60px] justify-center px-4 py-2">
          <Text variant="body" className="font-medium">{model}</Text>
          <Text variant="caption" className="text-muted-foreground">{t("当前模型（不在候选中）· 推理强度 {effort}", { effort: reasoningEffort ?? t("沿用默认") })}</Text>
        </View>
      </ListGroup> : null}
      <ListGroup inset="content">{models.map((item) => <GroupRow key={item.id} testID={`model-row-${item.id}`} title={item.display_name || item.id} description={item.description}
        selected={model === item.id} affordance="selected" disabled={disabled} onPress={() => onChange(chooseModel(item, reasoningEffort))} />)}</ListGroup>
      <View className="mx-8 pt-5">
        <ReasoningPicker model={current} effort={reasoningEffort} onChange={(reasoning_effort) => onChange({ model, reasoning_effort })}
          disabled={disabled || !catalog} testIDPrefix="model-effort" />
      </View>
      {!catalog && !error ? <Text variant="caption" testID="model-unavailable" className="mx-8 mt-4 text-muted-foreground">{loading ? t("正在获取模型列表…") : t("暂时无法获取模型列表")}</Text> : null}
      {catalog && !models.length ? <Text variant="caption" className="mx-8 mt-4 text-muted-foreground">{t("没有可选模型")}</Text> : null}
    </ScrollView>
  );
}
