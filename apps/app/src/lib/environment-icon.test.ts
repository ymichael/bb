import type { EnvironmentCapabilities } from "@bb/core"
import { Container, FolderGit2, Laptop } from "lucide-react"
import { describe, expect, it } from "vitest"
import { getEnvironmentIconInfo } from "./environment-icon"

function createCapabilities(
  overrides?: Partial<EnvironmentCapabilities>,
): EnvironmentCapabilities {
  return {
    host_filesystem: false,
    isolated_workspace: false,
    promote_primary_checkout: false,
    demote_primary_checkout: false,
    squash_merge: false,
    ...overrides,
  }
}

describe("getEnvironmentIconInfo", () => {
  it("uses the container icon for docker", () => {
    expect(
      getEnvironmentIconInfo({
        id: "docker",
        capabilities: createCapabilities({
          isolated_workspace: true,
        }),
      }),
    ).toMatchObject({
      icon: Container,
      ariaLabel: "Docker thread",
    })
  })

  it("uses the worktree icon for isolated workspaces", () => {
    expect(
      getEnvironmentIconInfo({
        capabilities: createCapabilities({
          isolated_workspace: true,
        }),
      }),
    ).toMatchObject({
      icon: FolderGit2,
      ariaLabel: "Worktree thread",
    })
  })

  it("uses the direct icon for host filesystem environments", () => {
    expect(
      getEnvironmentIconInfo({
        properties: {
          provisioningSystemKind: "direct-path",
          location: "localhost",
          workspaceKind: "arbitrary_path",
        },
        managed: false,
      }),
    ).toMatchObject({
      icon: Laptop,
      ariaLabel: "Direct thread",
    })
  })

  it("does not treat managed localhost environments as worktrees without worktree metadata", () => {
    expect(
      getEnvironmentIconInfo({
        properties: {
          provisioningSystemKind: "direct-path",
          location: "localhost",
          workspaceKind: "arbitrary_path",
        },
        managed: true,
      }),
    ).toMatchObject({
      icon: Laptop,
      ariaLabel: "Direct thread",
    })
  })

})
