import type { NormalizedPluginMachineProvider } from "@get-bb/plugin-sdk/internal/host-policy";
import type { PluginHookInvocation } from "./plugin-hook-registry.js";

export interface PluginMachineProviderRecord {
  pluginId: string;
  provider: NormalizedPluginMachineProvider;
  icon?: { bytes: Uint8Array; contentType: string; hash: string };
}

export interface PluginMachineProviderBridge {
  listMachineProviders(): PluginMachineProviderRecord[];
  getMachineProvider(id: string): PluginMachineProviderRecord | undefined;
  invokeProvider<T>(
    pluginId: string,
    label: string,
    run: () => Promise<T>,
  ): Promise<PluginHookInvocation<T>>;
  readonly decisionTimeoutMs: number;
}

let bridge: PluginMachineProviderBridge | undefined;

export function setPluginMachineProviderBridge(
  next: PluginMachineProviderBridge | undefined,
): void {
  bridge = next;
}

export function listMachineProviders(): PluginMachineProviderRecord[] {
  return bridge?.listMachineProviders() ?? [];
}

export function getMachineProvider(
  id: string,
): PluginMachineProviderRecord | undefined {
  return bridge?.getMachineProvider(id);
}

export async function invokeMachineProvider<T>(
  record: PluginMachineProviderRecord,
  label: string,
  run: () => Promise<T>,
): Promise<PluginHookInvocation<T>> {
  if (bridge === undefined) {
    return { ok: false, error: "plugin runtime is not available" };
  }
  return bridge.invokeProvider(record.pluginId, label, run);
}

export function machineProviderDecisionTimeoutMs(): number {
  return bridge?.decisionTimeoutMs ?? 10_000;
}
