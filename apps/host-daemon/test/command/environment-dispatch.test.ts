import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceError } from "@bb/host-workspace";
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
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toMatchObject({
      path: sourcePath,
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      defaultBranch: "main",
    });
    expect(result.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "cwd", text: `cwd: ${sourcePath}` }),
        expect.objectContaining({
          key: "branch",
          text: expect.stringContaining("Branch: main"),
        }),
      ]),
    );
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
        onProgress: expect.any(Function),
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
        initiator: null,
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        setupScript: ".bb-env-setup.ts",
        setupTimeoutMs: 900000,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toMatchObject({
      path: "/tmp/worktree",
      isGitRepo: true,
      isWorktree: true,
      branchName: "main",
      defaultBranch: "main",
    });
    expect(result.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "branch",
          text: expect.stringContaining("Branch: main"),
        }),
      ]),
    );
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-worktree",
        sourcePath,
        targetPath: "/tmp/worktree",
        branchName: "bb/test",
        scriptName: ".bb-env-setup.ts",
        timeoutMs: 900000,
        onProgress: expect.any(Function),
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
        initiator: null,
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
        setupScript: ".bb-env-setup.ts",
        setupTimeoutMs: 900000,
      },
      { runtimeManager: harness.manager },
    );

    expect(result).toMatchObject({
      path: "/tmp/clone",
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      defaultBranch: "main",
    });
    expect(result.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "branch",
          text: expect.stringContaining("Branch: main"),
        }),
      ]),
    );
    expect(harness.provisions).toEqual([
      {
        workspaceProvisionType: "managed-clone",
        sourcePath,
        targetPath: "/tmp/clone",
        branchName: "bb/clone",
        scriptName: ".bb-env-setup.ts",
        timeoutMs: 900000,
        onProgress: expect.any(Function),
      },
    ]);
  });

  it("streams live events and flushes when initiator is provided", async () => {
    const harness = createHarness({ workspacePath: "/tmp/live-stream" });
    const sourcePath = await makeTempDir("bb-dispatch-stream-");
    const emittedEvents: Array<{ environmentId: string; threadId: string }> = [];
    let seeded: { threadId: string; sequence: number } | undefined;
    let flushCount = 0;

    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-stream",
        initiator: { threadId: "thr-initiator", eventSequence: 5 },
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      {
        runtimeManager: harness.manager,
        seedThreadHighWaterMark: (args) => { seeded = args; },
        eventSink: {
          emit: (event) => { emittedEvents.push(event); },
          flush: async () => { flushCount += 1; },
        },
      },
    );

    expect(seeded).toEqual({ threadId: "thr-initiator", sequence: 5 });
    expect(flushCount).toBe(1);
    expect(emittedEvents.length).toBeGreaterThan(0);
    expect(emittedEvents[0]?.threadId).toBe("thr-initiator");
    expect(emittedEvents[0]?.environmentId).toBe("env-stream");
    expect(result.transcript.length).toBeGreaterThan(0);
    expect(result.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "cwd" }),
        expect.objectContaining({ key: "branch" }),
      ]),
    );
  });

  it("flushes live events before surfacing provisioning failures", async () => {
    const emittedEvents: Array<{ environmentId: string; threadId: string }> = [];
    let flushCount = 0;
    const manager = new RuntimeManager({
      provisionWorkspace: async (options) => {
        options.onProgress?.({
          type: "step",
          key: "git-worktree",
          text: "git worktree add -B bb/failure /tmp/failure",
          status: "started",
          startedAt: Date.now(),
        });
        throw new WorkspaceError("git_command_failed", "git worktree add failed");
      },
      createRuntime: () => createFakeRuntime().runtime,
    });

    await expect(() =>
      dispatchCommand(
        {
          type: "environment.provision",
          environmentId: "env-failure",
          initiator: { threadId: "thr-failure", eventSequence: 8 },
          workspaceProvisionType: "managed-worktree",
          sourcePath: "/tmp/source",
          targetPath: "/tmp/failure",
          branchName: "bb/failure",
          setupScript: ".bb-env-setup.ts",
          setupTimeoutMs: 900000,
        },
        {
          runtimeManager: manager,
          eventSink: {
            emit: (event) => { emittedEvents.push(event); },
            flush: async () => { flushCount += 1; },
          },
        },
      ),
    ).rejects.toThrow("git worktree add failed");

    expect(emittedEvents).toEqual([
      expect.objectContaining({
        environmentId: "env-failure",
        threadId: "thr-failure",
      }),
    ]);
    expect(flushCount).toBe(1);
  });

  it("returns empty transcript when environment already exists", async () => {
    const harness = createHarness({ workspacePath: "/tmp/idempotent" });
    const sourcePath = await makeTempDir("bb-dispatch-idempotent-");

    // First provision
    await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-idempotent",
        initiator: null,
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      { runtimeManager: harness.manager },
    );

    // Second provision — same environment
    const result = await dispatchCommand(
      {
        type: "environment.provision",
        environmentId: "env-idempotent",
        initiator: { threadId: "thr-second", eventSequence: 3 },
        workspaceProvisionType: "unmanaged",
        path: sourcePath,
      },
      { runtimeManager: harness.manager },
    );

    expect(result.transcript).toEqual([]);
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
