import type { ProviderComposerCommand } from "@bb/domain";
import type { ProviderRegistryService } from "./provider-registry.js";

export function resolveProviderPlanCommand(
  registry: ProviderRegistryService,
  providerId: string,
): ProviderComposerCommand | null {
  const action = registry
    .get(providerId)
    ?.info.composerActions.find((entry) => entry.kind === "plan");
  return action?.kind === "plan" ? action.command : null;
}
