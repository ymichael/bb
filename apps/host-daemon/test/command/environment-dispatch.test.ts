import { afterEach, describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/command-dispatch.js";
import { cleanupTempDirs, createHarness, makeTempDir } from "./dispatch-helpers.js";

afterEach(cleanupTempDirs);

describe("environment command dispatch", () => {
  it("covers environment.provision in unmanaged mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/unmanaged" });
    const sourcePath = await makeTempDir("bb-dispatch-unmanaged-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-unmanaged",
        projectId: "project-1",
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: sourcePath,
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
    ]);
  });

  it("covers environment.provision in managed-worktree mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/worktree", isWorktree: true });
    const sourcePath = await makeTempDir("bb-dispatch-worktree-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-worktree",
        projectId: "project-1",
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        scriptName: "setup.sh",
        timeoutMs: 60_000,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: "/tmp/worktree",
      isGitRepo: true,
      isWorktree: true,
      branchName: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        scriptName: "setup.sh",
        timeoutMs: 60_000,
      },
    ]);
  });

  it("covers environment.provision in managed-clone mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/clone", isWorktree: false });
    const sourcePath = await makeTempDir("bb-dispatch-clone-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-clone",
        projectId: "project-1",
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: "/tmp/clone",
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
        scriptName: undefined,
        timeoutMs: undefined,
      },
    ]);
  });

  it("covers environment.destroy", async () => {
    const harness = createHarness();
    await harness.manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const result = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-1",
        path: "/tmp/env-1",
        workspaceProvisionType: "managed-worktree",
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({});
    expect(harness.runtimeState.shutdownCount).toBe(1);
    expect(harness.workspaceState.destroyed).toBe(true);
  });
});
