import type { AvailableModel, ReasoningLevel } from "@bb/domain";
import type { SystemProviderInfo } from "@bb/server-contract";

const MANAGER_DEFAULT_PROVIDER_ID = "claude-code";
const MANAGER_DEFAULT_MODEL = "claude-opus-4-7[1m]";

export function resolvePreferredManagerProviderId(
  providers: readonly SystemProviderInfo[],
): string {
  return (
    providers.find((provider) => provider.id === MANAGER_DEFAULT_PROVIDER_ID)?.id ??
    providers[0]?.id ??
    ""
  );
}

export function resolvePreferredManagerModel(
  models: readonly AvailableModel[],
): string {
  return (
    models.find((model) => model.model === MANAGER_DEFAULT_MODEL)?.model ??
    models.find((model) => model.isDefault)?.model ??
    models[0]?.model ??
    ""
  );
}

export function resolvePreferredManagerReasoningLevel(
  model: AvailableModel | undefined,
): ReasoningLevel | "" {
  return model?.defaultReasoningEffort ?? "";
}
