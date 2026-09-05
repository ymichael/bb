import type { SystemMachineProvider } from "@bb/server-contract";

export function machineProviderInputsControlRequired(
  provider: SystemMachineProvider,
): boolean {
  return provider.inputs !== null && !provider.acceptsEmptyInputs;
}
