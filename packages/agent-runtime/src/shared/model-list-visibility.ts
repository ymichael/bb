import type { AvailableModel, ModelReasoningEffort } from "@bb/domain";

export interface IncludeSelectedOnlyModelsArgs {
  activeModels: readonly AvailableModel[];
  selectedModel?: string;
  selectedOnlyModels: readonly AvailableModel[];
}

function cloneReasoningEfforts(
  efforts: readonly ModelReasoningEffort[],
): ModelReasoningEffort[] {
  return efforts.map((effort) => ({ ...effort }));
}

function cloneAvailableModel(model: AvailableModel): AvailableModel {
  return {
    ...model,
    supportedReasoningEfforts: cloneReasoningEfforts(
      model.supportedReasoningEfforts,
    ),
  };
}

export function includeSelectedOnlyModels({
  activeModels,
  selectedModel,
  selectedOnlyModels,
}: IncludeSelectedOnlyModelsArgs): AvailableModel[] {
  const models = [...activeModels];
  if (
    !selectedModel ||
    models.some((model) => model.model === selectedModel)
  ) {
    return models;
  }

  const selectedOnlyModel = selectedOnlyModels.find(
    (model) => model.model === selectedModel,
  );
  if (!selectedOnlyModel) {
    return models;
  }

  return [cloneAvailableModel(selectedOnlyModel), ...models];
}
