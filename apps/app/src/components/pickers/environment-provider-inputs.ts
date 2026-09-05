import type { SystemEnvironmentProvider } from "@bb/server-contract";

export function providerInputsControlRequired(
  provider: SystemEnvironmentProvider,
): boolean {
  return provider.inputs !== null && !provider.acceptsEmptyInputs;
}
