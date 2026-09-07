import { useContext } from "react";
import { PluginContext } from "@/components/plugin/plugin-context";

export function usePortalScopeProps(): {
  "data-bb-portaled-overlay": "";
  "data-bb-plugin-root"?: "";
  "data-bb-plugin"?: string;
} {
  const pluginId = useContext(PluginContext);
  return pluginId === null
    ? { "data-bb-portaled-overlay": "" }
    : {
        "data-bb-portaled-overlay": "",
        "data-bb-plugin-root": "",
        "data-bb-plugin": pluginId,
      };
}
