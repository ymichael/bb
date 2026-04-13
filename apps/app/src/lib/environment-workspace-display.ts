import type { EnvironmentWorkspaceDisplayKind } from "@bb/domain";
import { Container, FolderGit2, Monitor } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export function getEnvironmentWorkspaceDisplayIcon(
  kind: EnvironmentWorkspaceDisplayKind,
): LucideIcon | null {
  switch (kind) {
    case "sandbox":
      return Container;
    case "git-worktree":
      return FolderGit2;
    case "primary-checkout":
      return Monitor;
    case "other":
      return null;
  }
}

export function getEnvironmentWorkspaceDisplayIconLabel(
  kind: EnvironmentWorkspaceDisplayKind,
): string | null {
  switch (kind) {
    case "sandbox":
      return "Sandbox environment";
    case "git-worktree":
      return "Git worktree environment";
    case "primary-checkout":
      return "Primary checkout environment";
    case "other":
      return null;
  }
}
