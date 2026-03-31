import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceError } from "@bb/workspace";
import { dispatchCommand } from "../../src/command-dispatch.js";
import { cleanupTempDirs, createFakeRuntime, createFakeWorkspace, createHarness, makeTempDir } from "./dispatch-helpers.js";
import { RuntimeManager } from "../../src/runtime-manager.js";

afterEach(cleanupTempDirs);

describe("environment command dispatch", () => {
  it("covers environment.provision in unmanaged mode", async () => {
    const harness = createHarness({ workspacePath: "/tmp/unmanaged" });
    const sourcePath = await makeTempDir("bb-dispatch-unmanaged-");

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-unmanaged",
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
      defaultBranch: "main",
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
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        setupScript: ".bb-env-setup.sh",
        setupTimeoutMs: 900000,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: "/tmp/worktree",
      isGitRepo: true,
      isWorktree: true,
      branchName: "main",
      defaultBranch: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        scriptName: ".bb-env-setup.sh",
        timeoutMs: 900000,
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
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
        setupScript: ".bb-env-setup.sh",
        setupTimeoutMs: 900000,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({
      path: "/tmp/clone",
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      defaultBranch: "main",
      ranSetup: false,
    });
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
        scriptName: ".bb-env-setup.sh",
        timeoutMs: 900000,
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
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({});
    expect(harness.runtimeState.shutdownCount).toBe(1);
    expect(harness.workspaceState.destroyed).toBe(true);
  });

  it("destroys a managed environment after daemon restart (not in memory)", async () => {
    const harness = createHarness();
    // Environment is NOT in memory — simulates daemon restart.
    // The destroy command must reconnect using workspaceContext before destroying.
    const result = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-restart",
        workspaceContext: {
          workspacePath: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toEqual({});
    // The workspace was reconnected (lazy provision) then destroyed
    expect(harness.workspaceState.destroyed).toBe(true);
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "reconnect-managed-worktree",
        path: "/tmp/env-1",
      },
    ]);
  });

  it("treats a retry as success when the workspace was already removed", async () => {
    // Simulate: first destroy succeeds and removes the workspace,
    // then daemon crashes before reporting. On retry, the path is gone.
    let callCount = 0;
    const { workspace } = createFakeWorkspace("/tmp/env-retry");
    const { runtime } = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: async () => {
        callCount++;
        if (callCount > 1) {
          throw new WorkspaceError("path_not_found", "Managed workspace path does not exist: /tmp/env-retry");
        }
        return workspace;
      },
      createRuntime: () => runtime,
    });

    // First destroy: succeeds (workspace exists in memory after reconnect)
    await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-retry",
        workspaceContext: {
          workspacePath: "/tmp/env-retry",
          workspaceProvisionType: "managed-worktree",
        },
      },
      { runtimeManager: manager },
    );

    // Second destroy (retry): workspace path is gone, should succeed (idempotent)
    const retryResult = await dispatchCommand(
      {
        type: "environment.destroy",
        environmentId: "env-retry",
        workspaceContext: {
          workspacePath: "/tmp/env-retry",
          workspaceProvisionType: "managed-worktree",
        },
      },
      { runtimeManager: manager },
    );

    expect(retryResult).toEqual({});
  });
});
