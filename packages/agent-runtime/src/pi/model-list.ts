import { resolvePiDefaultModelId } from "@bb/agent-providers";
import type { AvailableModel, ModelReasoningEffort } from "@bb/domain";
import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
} from "../shared/adapter-utils.js";

export interface PiCatalogModel {
  id: string;
  input: string[];
  name: string;
  provider: string;
  reasoning: boolean;
  supportsXhigh: boolean;
}

export interface BuildPiAvailableModelsArgs<TProvider extends string> {
  providers: TProvider[];
  getModels: (provider: TProvider) => PiCatalogModel[];
  hasAuth: (provider: TProvider) => boolean;
}

export interface BuildPiAvailableModelsResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

/**
 * Model IDs ending with a `-YYYYMMDD` date suffix are pinned versions; we
 * exclude them from the picker and surface aliases only. Dated versions are
 * returned in the selected-only bucket so a previously stored selection can
 * still render with its catalog metadata. pi-mono uses this heuristic for
 * resolution preference (preferring aliases over dated versions when multiple
 * models match a pattern); we go further and exclude dated versions from the
 * active picker since our UI is a picker not a fuzzy resolver.
 * See `isAlias` in pi-mono's model-resolver.ts:
 * https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/model-resolver.ts
 */
const DATE_SUFFIX_PATTERN = /-\d{8}$/;

function isModelAlias(id: string): boolean {
  if (id.endsWith("-latest")) return true;
  return !DATE_SUFFIX_PATTERN.test(id);
}

function buildPiAvailableModel<TProvider extends string>(
  provider: TProvider,
  model: PiCatalogModel,
): AvailableModel {
  const canonicalId = toCanonicalPiModelId(provider, model.id);
  return {
    id: canonicalId,
    model: canonicalId,
    displayName: model.name,
    description: describePiModel(model),
    supportedReasoningEfforts: getPiReasoningEfforts(model),
    defaultReasoningEffort: model.reasoning ? "medium" : "low",
    isDefault: false,
  };
}

export function buildPiAvailableModels<TProvider extends string>(
  args: BuildPiAvailableModelsArgs<TProvider>,
): BuildPiAvailableModelsResult {
  const models: AvailableModel[] = [];
  const selectedOnlyModels: AvailableModel[] = [];
  for (const provider of args.providers) {
    if (!args.hasAuth(provider)) {
      continue;
    }
    for (const model of args.getModels(provider)) {
      const built = buildPiAvailableModel(provider, model);
      if (isModelAlias(model.id)) {
        models.push(built);
      } else {
        selectedOnlyModels.push(built);
      }
    }
  }

  const defaultId = resolveDefaultPiModelId(models);
  return {
    models: models.map((model) =>
      model.id === defaultId ? { ...model, isDefault: true } : model,
    ),
    selectedOnlyModels,
  };
}

export function toCanonicalPiModelId(
  provider: string,
  modelId: string,
): string {
  return modelId.includes("/") ? modelId : `${provider}/${modelId}`;
}

function getPiReasoningEfforts(model: PiCatalogModel): ModelReasoningEffort[] {
  if (!model.reasoning) {
    return [LOW_REASONING_EFFORT];
  }

  const efforts = [
    LOW_REASONING_EFFORT,
    MEDIUM_REASONING_EFFORT,
    HIGH_REASONING_EFFORT,
  ];
  if (model.supportsXhigh) {
    efforts.push(XHIGH_REASONING_EFFORT);
  }
  return efforts;
}

function describePiModel(model: PiCatalogModel): string {
  const capabilities: string[] = [];
  capabilities.push(model.reasoning ? "reasoning" : "non-reasoning");
  if (model.input.includes("image")) {
    capabilities.push("multimodal");
  }

  const provider =
    model.provider.length > 0
      ? model.provider[0].toUpperCase() + model.provider.slice(1)
      : model.provider;
  return `${provider} ${capabilities.join(", ")} model via Pi`;
}

function resolveDefaultPiModelId(models: AvailableModel[]): string | undefined {
  // Try the per-provider default for each provider represented in the list
  for (const model of models) {
    const provider = model.id.split("/")[0];
    const defaultId = resolvePiDefaultModelId(provider);
    if (defaultId && model.id === toCanonicalPiModelId(provider, defaultId)) {
      return model.id;
    }
  }
  return models[0]?.id;
}
