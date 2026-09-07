import { createContext, useContext } from "react";

export const PluginContext = createContext<string | null>(null);

export interface PluginSlotOwnershipRegistry {
  register(owner: symbol, release: () => void): void;
  unregister(owner: symbol): void;
}

export const PluginSlotOwnershipContext =
  createContext<PluginSlotOwnershipRegistry | null>(null);

export function usePluginId(): string {
  const pluginId = useContext(PluginContext);
  if (pluginId === null) {
    throw new Error(
      "plugin SDK hooks can only be used inside a plugin slot component",
    );
  }
  return pluginId;
}
