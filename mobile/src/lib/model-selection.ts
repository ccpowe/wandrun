import type { ModelInfo } from "../gateway/api.ts";
import { t } from "./i18n.ts";

export type ModelChoice = { model: string; reasoning_effort: string | null };

/** A saved model may disappear from the catalog; it is displayed separately, never offered as a new choice. */
export function selectedModel(models: readonly ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((model) => model.id === id);
}

export function modelName(models: readonly ModelInfo[], id: string): string {
  return selectedModel(models, id)?.display_name || id;
}

/** The gateway validates efforts against the selected model. Never expose upstream-only ultra. */
export function reasoningOptions(model: ModelInfo | undefined): { value: string; label: string; description: string }[] {
  return model?.supported_reasoning_efforts.filter(({ effort }) => effort !== "ultra").map(({ effort, description }) => ({
    value: effort,
    label: t(({ low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" } as Record<string, string>)[effort] ?? effort),
    description,
  })) ?? [];
}

/** Keep the previous effort on a model change only when the new catalog entry advertises it. */
export function chooseModel(model: ModelInfo, previousEffort: string | null): ModelChoice {
  const supported = reasoningOptions(model);
  return {
    model: model.id,
    reasoning_effort: previousEffort !== null && supported.some(({ value }) => value === previousEffort)
      ? previousEffort
      : model.default_reasoning_effort !== "ultra" && supported.some(({ value }) => value === model.default_reasoning_effort)
        ? model.default_reasoning_effort
        : null,
  };
}
