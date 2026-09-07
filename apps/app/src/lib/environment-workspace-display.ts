import type { EnvironmentWorkspaceDisplayKind } from "@bb/domain";
import type { EnvironmentDisplayInfo } from "@bb/core-ui";
import type { IconName } from "@bb/shared-ui/icon";
import { PersistentHostIconName } from "@/lib/host-display";

export type EnvironmentWorkspaceTypeLabel =
  | "Local worktree"
  | "Remote worktree"
  | "Local"
  | "Remote";

interface EnvironmentWorkspaceSummaryDisplayArgs {
  display: EnvironmentDisplayInfo;
  environmentName: string | null;
  locality: "local" | "remote";
  hostName?: string;
  machinePrefix?: string;
}

export interface EnvironmentWorkspaceSummaryDisplay {
  label: string | undefined;
  compactLabel: string | undefined;
  icon: IconName;
  typeLabel: EnvironmentWorkspaceTypeLabel | undefined;
}

export function getEnvironmentWorkspaceSummaryDisplay({
  display,
  environmentName,
  locality,
  hostName,
  machinePrefix = "",
}: EnvironmentWorkspaceSummaryDisplayArgs): EnvironmentWorkspaceSummaryDisplay {
  if (display.lifecycle === "provisioning") {
    return {
      label: "Provisioning",
      compactLabel: "Provisioning",
      icon: "Loading",
      typeLabel: undefined,
    };
  }

  return {
    label:
      display.mode === "direct"
        ? hostName
        : environmentName === null
          ? hostName
          : `${machinePrefix}${display.modeLabel}`,
    compactLabel:
      display.mode === "direct"
        ? hostName
        : environmentName === null
          ? hostName
          : display.compactModeLabel,
    icon: getEnvironmentWorkspaceLabelIconName(display.workspaceDisplayKind),
    typeLabel: getEnvironmentWorkspaceTypeLabel(
      display.workspaceDisplayKind,
      locality,
    ),
  };
}

export function getEnvironmentWorkspaceTypeLabel(
  kind: EnvironmentWorkspaceDisplayKind,
  locality: "local" | "remote",
): EnvironmentWorkspaceTypeLabel {
  if (kind === "other") {
    return locality === "local" ? "Local" : "Remote";
  }
  return locality === "local" ? "Local worktree" : "Remote worktree";
}

export function getEnvironmentWorkspaceDisplayIconName(
  kind: EnvironmentWorkspaceDisplayKind,
): IconName | null {
  switch (kind) {
    case "managed-worktree":
      return "FolderGit";
    case "unmanaged-worktree":
      return "FolderGit";
    case "other":
      return null;
  }
}

export function getEnvironmentWorkspaceLabelIconName(
  kind: EnvironmentWorkspaceDisplayKind,
): IconName {
  return getEnvironmentWorkspaceDisplayIconName(kind) ?? PersistentHostIconName;
}
