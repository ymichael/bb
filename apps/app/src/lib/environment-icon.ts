import type { EnvironmentRecord, SystemEnvironmentInfo } from "@bb/core"
import { Container, FolderGit2, Laptop, type LucideIcon } from "lucide-react"

interface EnvironmentIconInfo {
  icon: LucideIcon
  ariaLabel: string
}

type EnvironmentIconSource =
  | Pick<SystemEnvironmentInfo, "id" | "capabilities">
  | Pick<EnvironmentRecord, "managed">

export function getEnvironmentIconInfo(
  environment?: EnvironmentIconSource | null,
): EnvironmentIconInfo | undefined {
  if (!environment) return undefined

  // Environment ids are open_external runtime values, so only known special
  // cases get id-specific icons. Unknown ids intentionally fall back to
  // capability-based icons when possible.
  if ("id" in environment && environment.id === "docker") {
    return {
      icon: Container,
      ariaLabel: "Docker thread",
    }
  }

  if ("managed" in environment && environment.managed) {
    return {
      icon: FolderGit2,
      ariaLabel: "Managed environment",
    }
  }

  if ("capabilities" in environment && environment.capabilities.isolated_workspace) {
    return {
      icon: FolderGit2,
      ariaLabel: "Worktree thread",
    }
  }

  if (
    ("capabilities" in environment && environment.capabilities.host_filesystem) ||
    ("managed" in environment && !environment.managed)
  ) {
    return {
      icon: Laptop,
      ariaLabel: "Direct thread",
    }
  }

  return undefined
}
