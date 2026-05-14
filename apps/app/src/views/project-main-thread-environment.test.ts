import { describe, expect, it } from "vitest";
import {
  resolveProjectMainThreadEnvironment,
  type ProjectMainSelectedBranch,
} from "./project-main-thread-environment";

const projectId = "proj_123";
const hostWorktreeEnvironmentValue = "host:host_123:worktree";
const hostLocalEnvironmentValue = "host:host_123:local";
const sandboxEnvironmentValue = "sandbox:e2b";

function selectedBranch(name: string): ProjectMainSelectedBranch {
  return { name, isNew: false };
}

describe("resolveProjectMainThreadEnvironment", () => {
  it("omits unmanaged branch checkout when no current branch is known", () => {
    expect(
      resolveProjectMainThreadEnvironment({
        environmentValue: hostLocalEnvironmentValue,
        projectId,
        currentBranch: null,
        selectedBranch: null,
      }),
    ).toEqual({
      type: "host",
      hostId: "host_123",
      workspace: {
        type: "unmanaged",
        path: null,
      },
    });
  });

  it("uses the env's current branch (HEAD) for host local checkout", () => {
    expect(
      resolveProjectMainThreadEnvironment({
        environmentValue: hostLocalEnvironmentValue,
        projectId,
        currentBranch: "develop",
        selectedBranch: null,
      }),
    ).toMatchObject({
      workspace: {
        type: "unmanaged",
        branch: { kind: "existing", name: "develop" },
      },
    });
  });

  it("sends default base branch for managed worktrees without an explicit pick", () => {
    expect(
      resolveProjectMainThreadEnvironment({
        environmentValue: hostWorktreeEnvironmentValue,
        projectId,
        currentBranch: "master",
        selectedBranch: null,
      }),
    ).toMatchObject({
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    });
  });

  it("sends a named base branch when the selected branch matches the env's current", () => {
    expect(
      resolveProjectMainThreadEnvironment({
        environmentValue: hostWorktreeEnvironmentValue,
        projectId,
        currentBranch: "develop",
        selectedBranch: selectedBranch("develop"),
      }),
    ).toMatchObject({
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "develop" },
      },
    });
  });

  it("sends a named base branch for non-default sandbox branch picks", () => {
    expect(
      resolveProjectMainThreadEnvironment({
        environmentValue: sandboxEnvironmentValue,
        projectId,
        currentBranch: "main",
        selectedBranch: selectedBranch("release/2026-05"),
      }),
    ).toMatchObject({
      type: "sandbox-host",
      baseBranch: { kind: "named", name: "release/2026-05" },
    });
  });
});
