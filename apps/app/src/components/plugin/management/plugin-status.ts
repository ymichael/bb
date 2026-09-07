import type { PluginRuntimeStatus } from "@bb/server-contract";
import type { IconName } from "@bb/shared-ui/icon";
import type { PluginListItem } from "@/hooks/queries/plugin-settings-queries";

export interface PluginRuntimeStatusPresentation {
  icon: IconName;
  label: string;
  tone: "error" | "warning";
  condition: string;
  recovery: string;
}

type PluginRuntimeStatusDefinition = Omit<
  PluginRuntimeStatusPresentation,
  "condition" | "recovery"
>;

const PLUGIN_RUNTIME_STATUS_DEFINITIONS: Record<
  PluginRuntimeStatus,
  PluginRuntimeStatusDefinition | null
> = {
  running: null,
  error: { icon: "CircleX", label: "Failed", tone: "error" },
  incompatible: {
    icon: "AlertCircle",
    label: "Incompatible",
    tone: "error",
  },
  missing: { icon: "FileQuestion", label: "Missing", tone: "error" },
  disabled: null,
  "needs-configuration": {
    icon: "Settings",
    label: "Needs configuration",
    tone: "warning",
  },
  degraded: { icon: "AlertTriangle", label: "Degraded", tone: "warning" },
};

function pluginRuntimeRecovery(plugin: PluginListItem): string {
  switch (plugin.status) {
    case "error":
      if (plugin.source.startsWith("path:")) {
        return "Fix the plugin, then reload it.";
      }
      if (plugin.provenance === "builtin") {
        return "Reload the plugin. If it still fails, restart bb.";
      }
      return "Reload the plugin. If it still fails, remove it and install it again.";
    case "incompatible":
      return plugin.provenance === "builtin"
        ? "Update bb to load a compatible bundled plugin."
        : "Install a version compatible with this bb.";
    case "missing":
      return plugin.provenance === "builtin"
        ? "Restart bb. If the files are still missing, reinstall bb."
        : "Remove the plugin, then install it again from its source.";
    case "needs-configuration":
      return plugin.hasSettings
        ? "Complete the Configuration section; bb reloads the plugin after you save."
        : "Add the required configuration, then reload the plugin.";
    case "degraded":
      return "Wait a moment, then reload the plugin.";
    default:
      return "";
  }
}

function pluginRuntimeCondition(plugin: PluginListItem): string {
  switch (plugin.status) {
    case "error":
      return "The plugin couldn't start.";
    case "incompatible":
      return "This plugin version isn't compatible with your version of bb.";
    case "missing":
      return "The plugin's files are missing.";
    case "needs-configuration":
      return "Required settings are incomplete.";
    case "degraded":
      return "A background service is still stopping.";
    default:
      return "";
  }
}

export function pluginRuntimeStatusPresentation(
  plugin: PluginListItem,
): PluginRuntimeStatusPresentation | null {
  const definition = PLUGIN_RUNTIME_STATUS_DEFINITIONS[plugin.status];
  if (definition === null) return null;
  return {
    ...definition,
    condition: pluginRuntimeCondition(plugin),
    recovery: pluginRuntimeRecovery(plugin),
  };
}

export type PluginRowSignal =
  | { kind: "update"; version: string }
  | {
      kind: "status";
      icon: IconName;
      label: string;
      tone: "error" | "warning";
      detail: string | null;
    };

export function pluginRowSignal(
  plugin: PluginListItem,
): PluginRowSignal | null {
  const state = plugin.updateState;
  if (state.lastFailure !== null) {
    return {
      kind: "status",
      icon: "RotateCcw",
      label: "Update failed",
      tone: "error",
      detail:
        state.lastFailure.detail.length > 0
          ? state.lastFailure.detail
          : `Update to ${state.lastFailure.version} failed and was rolled back.`,
    };
  }
  const runtimeStatus = pluginRuntimeStatusPresentation(plugin);
  if (runtimeStatus !== null) {
    return {
      kind: "status",
      icon: runtimeStatus.icon,
      label: runtimeStatus.label,
      tone: runtimeStatus.tone,
      detail: plugin.statusDetail,
    };
  }
  if (state.outcome === "unavailable") {
    return {
      kind: "status",
      icon: "AlertTriangle",
      label: "Needs attention",
      tone: "warning",
      detail: state.detail,
    };
  }
  if (state.availableVersion !== null) {
    return { kind: "update", version: state.availableVersion };
  }
  return null;
}
