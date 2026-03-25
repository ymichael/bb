import type { AgentRuntime } from "@bb/agent-runtime";
import type { IWorkspace } from "@bb/workspace";
import { describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "./runtime-manager.js";

function createFakeWorkspace(path: string) {
  return {
    path,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    currentBranch: vi.fn(async () => "main"),
    getStatus: vi.fn(async () => ({
      state: "clean" as const,
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      workspaceChangedFiles: 0,
      workspaceInsertions: 0,
      workspaceDeletions: 0,
      hasUncommittedChanges: false,
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
      behindCount: 0,
      currentBranch: "main",
      defaultBranch: "main",
      mergeBaseBranch: "main",
      mergeBaseBranches: [],
      baseRef: "main",
      files: [],
    })),
    getDiff: vi.fn(async () => ({
      mode: "combined",
      currentBranch: "main",
      mergeBaseBranch: "main",
      mergeBaseRef: "main",
      commits: [],
      selection: { type: "combined" as const },
      diff: "",
      truncated: false,
    })),
    getBranches: vi.fn(async () => ["main"]),
    commit: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => ({
      commitSha: "commit-1",
      branchName: "main",
      remoteName: "origin",
    })),
    squashMergeInto: vi.fn(async () => ({
      merged: true,
      commitSha: "commit-1",
      targetBranch: "main",
    })),
    promote: vi.fn(async () => undefined),
    demote: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } as unknown as IWorkspace & {
    destroy: ReturnType<typeof vi.fn>;
  };
}

function createFakeRuntime() {
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async (_args: unknown) => ({ providerThreadId: "provider-1" })),
    resumeThread: vi.fn(async (_args: unknown) => ({ providerThreadId: "provider-1" })),
    runTurn: vi.fn(async (_args: unknown) => undefined),
    steerTurn: vi.fn(async (_args: unknown) => undefined),
    stopThread: vi.fn(async (_args: unknown) => undefined),
    renameThread: vi.fn(async (_args: unknown) => undefined),
    listModels: vi.fn(async () => []),
    shutdown: vi.fn(async () => undefined),
  };
}

describe("RuntimeManager", () => {
  it("creates a runtime the first time an environment is requested", async () => {
    const provisionWorkspace = vi.fn(async () => createFakeWorkspace("/tmp/env-1"));
    const createRuntime = vi.fn(() => createFakeRuntime() as unknown as AgentRuntime);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    const entry = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(entry.path).toBe("/tmp/env-1");
  });

  it("reuses the existing runtime for subsequent requests", async () => {
    const provisionWorkspace = vi.fn(async () => createFakeWorkspace("/tmp/env-1"));
    const createRuntime = vi.fn(() => createFakeRuntime() as unknown as AgentRuntime);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    const first = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const second = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(second).toBe(first);
    expect(provisionWorkspace).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it("shuts down the runtime and destroys the workspace", async () => {
    const workspace = createFakeWorkspace("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => workspace),
      createRuntime: vi.fn(() => runtime as unknown as AgentRuntime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await manager.destroyEnvironment("env-1");

    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it("tracks active threads for session reconciliation", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => createFakeRuntime() as unknown as AgentRuntime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    manager.markThreadActive("env-1", "thread-1", "provider-1");
    expect(manager.listActiveThreads()).toEqual([
      {
        environmentId: "env-1",
        threadId: "thread-1",
        providerThreadId: "provider-1",
      },
    ]);

    manager.markThreadInactive("env-1", "thread-1");
    expect(manager.listActiveThreads()).toEqual([]);
  });

  it("shuts down all tracked environments", async () => {
    const workspaceA = createFakeWorkspace("/tmp/env-a");
    const workspaceB = createFakeWorkspace("/tmp/env-b");
    const runtimeA = createFakeRuntime();
    const runtimeB = createFakeRuntime();
    const provisionWorkspace = vi
      .fn()
      .mockResolvedValueOnce(workspaceA)
      .mockResolvedValueOnce(workspaceB);
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(runtimeA as unknown as AgentRuntime)
      .mockReturnValueOnce(runtimeB as unknown as AgentRuntime);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-a",
      workspacePath: "/tmp/env-a",
    });
    await manager.ensureEnvironment({
      environmentId: "env-b",
      workspacePath: "/tmp/env-b",
    });

    await manager.shutdownAll();

    expect(runtimeA.shutdown).toHaveBeenCalledTimes(1);
    expect(runtimeB.shutdown).toHaveBeenCalledTimes(1);
    expect(workspaceA.destroy).toHaveBeenCalledTimes(1);
    expect(workspaceB.destroy).toHaveBeenCalledTimes(1);
  });
});
