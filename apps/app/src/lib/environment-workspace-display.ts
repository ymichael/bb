import type { EnvironmentWorkspaceDisplayKind } from "@bb/domain";
import { Container, FolderGit2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PersistentHostIcon } from "@/lib/host-display";

export function getEnvironmentWorkspaceDisplayIcon(
  kind: EnvironmentWorkspaceDisplayKind,
): LucideIcon | null {
  switch (kind) {
    case "sandbox":
      return Container;
    case "managed-worktree":
      return FolderGit2;
    case "unmanaged-worktree":
      return FolderGit2;
    case "other":
      return null;
  }
}

export function getEnvironmentWorkspaceLabelIcon(
  kind: EnvironmentWorkspaceDisplayKind,
): LucideIcon {
  return getEnvironmentWorkspaceDisplayIcon(kind) ?? PersistentHostIcon;
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
