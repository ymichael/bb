import type { ProviderModelCatalogScope } from "./provider-types.js";

export function providerModelCatalogDependsOnWorkspace(
  scope: ProviderModelCatalogScope | undefined,
): boolean {
  return scope !== "host";
}
