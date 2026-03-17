import type { EnvironmentRecord, SystemEnvironmentInfo } from "@bb/core"
import { Container, FolderGit2, Laptop, type LucideIcon } from "lucide-react"

interface EnvironmentIconInfo {
  icon: LucideIcon
  ariaLabel: string
}

type EnvironmentIconSource =
  | (Pick<SystemEnvironmentInfo, "capabilities"> & { id?: string })
  | Pick<EnvironmentRecord, "managed" | "properties">

export function getEnvironmentIconInfo(
  environment?: EnvironmentIconSource | null,
): EnvironmentIconInfo | undefined {
  if (!environment) return undefined

  if (
    ("id" in environment && environment.id === "docker") ||
    ("properties" in environment && environment.properties?.location === "docker")
  ) {
    return {
      icon: Container,
      ariaLabel: "Docker thread",
    }
  }

  if (
    ("capabilities" in environment && environment.capabilities.isolated_workspace) ||
    ("properties" in environment && environment.properties?.workspaceKind === "worktree")
  ) {
    return {
      icon: FolderGit2,
      ariaLabel: "Worktree thread",
    }
  }

  if (
    ("capabilities" in environment && environment.capabilities.host_filesystem) ||
    ("properties" in environment && environment.properties?.location === "localhost")
  ) {
    return {
      icon: Laptop,
      ariaLabel: "Direct thread",
    }
  }

  return undefined
}
