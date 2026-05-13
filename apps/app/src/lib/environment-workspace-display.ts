import type { EnvironmentWorkspaceDisplayKind } from "@bb/domain";
import type { IconName } from "@/components/ui";
import { PersistentHostIconName } from "@/lib/host-display";

export function getEnvironmentWorkspaceDisplayIconName(
  kind: EnvironmentWorkspaceDisplayKind,
): IconName | null {
  switch (kind) {
    case "sandbox":
      return "Container";
    case "managed-worktree":
      return "FolderGit2";
    case "unmanaged-worktree":
      return "FolderGit2";
    case "other":
      return null;
  }
}

export function getEnvironmentWorkspaceLabelIconName(
  kind: EnvironmentWorkspaceDisplayKind,
): IconName {
  return getEnvironmentWorkspaceDisplayIconName(kind) ?? PersistentHostIconName;
}

export function getEnvironmentWorkspaceDisplayIconLabel(
  kind: EnvironmentWorkspaceDisplayKind,
): string | null {
  switch (kind) {
    case "sandbox":
      return "Sandbox environment";
    case "managed-worktree":
      return "Managed worktree environment";
    case "unmanaged-worktree":
      return "Git worktree environment";
    case "other":
      return null;
  }
}
