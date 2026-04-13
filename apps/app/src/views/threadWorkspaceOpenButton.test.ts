import type { Environment } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { resolveThreadWorkspaceOpenPath } from "./threadWorkspaceOpenButton";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    branchName: "feature/test",
    cleanupMode: null,
    cleanupRequestedAt: null,
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-1",
    id: "environment-1",
    isGitRepo: true,
    isWorktree: true,
    managed: true,
    mergeBaseBranch: "main",
    path: "/tmp/workspace",
    projectId: "project-1",
    status: "ready",
    updatedAt: 1,
    workspaceProvisionType: "managed-worktree",
    ...overrides,
  };
}

describe("resolveThreadWorkspaceOpenPath", () => {
  it("returns the ready local environment path when the capability is available", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBe("/tmp/workspace");
  });

  it("hides when the environment is remote", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: false,
      }),
    ).toBeNull();
  });

  it("hides when the environment is not ready", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment({ status: "provisioning" }),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBeNull();
  });

  it("hides when the environment has no path", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment({ path: null }),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBeNull();
  });

  it("hides when the daemon capability is unavailable", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: false,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: true,
        threadEnvironmentIsLocal: true,
      }),
    ).toBeNull();
  });

  it("hides when there are no available targets", () => {
    expect(
      resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: true,
        environment: makeEnvironment(),
        hasWorkspaceOpenTargets: false,
        threadEnvironmentIsLocal: true,
      }),
    ).toBeNull();
  });
});

