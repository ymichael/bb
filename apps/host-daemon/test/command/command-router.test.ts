import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import {
  readRuntimeMaterialState,
  writeRuntimeMaterialState,
} from "@bb/host-runtime-material";
import type { HostWorkspace } from "@bb/host-workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRouter } from "../../src/command-router.js";
import { RuntimeManager } from "../../src/runtime-manager.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

interface FakeWorkspace extends HostWorkspace {
  commit: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function createFakeWorkspace(path: string): FakeWorkspace {
  const workspace = {
    path,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    getCurrentBranch: vi.fn(async () => "main"),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn(
      async () => JSON.stringify({ currentBranch: "main", headSha: "commit-1" }),
    ),
    getSharedGitRefsFingerprint: vi.fn(async () =>
      JSON.stringify({ refs: [["refs/heads/main", "commit-1"]], remoteHead: null }),
    ),
    getStatus: vi.fn(async () => ({
      workingTree: {
        hasUncommittedChanges: false,
        state: "clean" as const,
        changedFiles: 0,
        insertions: 0,
        deletions: 0,
        files: [],
      },
      branch: {
        currentBranch: "main",
        defaultBranch: "main",
      },
      mergeBase: null,
    })),
    getDiff: vi.fn(async () => ({
      diff: "",
      truncated: false,
      shortstat: "",
      files: "",
    })),
    listBranches: vi.fn(async () => ["main"]),
    listFiles: vi.fn(async () => []),
    commit: vi.fn(async () => ({
      commitSha: "commit-1",
      commitSubject: "subject",
    })),
    reset: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    squashMerge: vi.fn(async () => ({
      merged: true,
      commitSha: "commit-3",
      targetBranch: "main",
    })),
    promote: vi.fn(async () => undefined),
    demote: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } satisfies FakeWorkspace;

  return workspace;
}

function createFakeRuntime(): AgentRuntime {
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async ({ threadId }: { threadId: string }) => ({
      providerThreadId: `provider-${threadId}`,
    })),
    resumeThread: vi.fn(async ({ providerThreadId }: { providerThreadId?: string }) => ({
      providerThreadId: providerThreadId ?? "provider-resumed",
    })),
    runTurn: vi.fn(async (_args: { threadId: string }) => undefined),
    steerTurn: vi.fn(async (_args: unknown) => undefined),
    stopThread: vi.fn(async (_args: unknown) => undefined),
    renameThread: vi.fn(async (_args: unknown) => undefined),
    listModels: vi.fn(async () => []),
    listRunningProviders: vi.fn(() => []),
    shutdown: vi.fn(async () => undefined),
  } satisfies AgentRuntime;
}

function createLogger() {
  return {
    warn: vi.fn(),
  };
}

function createStandardRuntimeCommandContext(args: {
  providerThreadId?: string;
  workspacePath: string;
}) {
  return {
    workspaceContext: { workspacePath: args.workspacePath, workspaceProvisionType: "unmanaged" as const },
    projectId: "project-1",
    providerId: "fake",
    ...(args.providerThreadId
      ? { providerThreadId: args.providerThreadId }
      : {}),
    options: {
      model: "gpt-5",
      serviceTier: "default" as const,
      reasoningLevel: "medium" as const,
      sandboxMode: "danger-full-access" as const,
    },
    instructions: "Be a helpful coding agent.",
    dynamicTools: [],
    instructionMode: "append" as const,
  };
}

describe("CommandRouter", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((tempDir) =>
        fs.rm(tempDir, { force: true, recursive: true })
      ),
    );
  });

  it("applies runtime material with real state persistence and evicts idle environments", async () => {
    const dataDir = await makeTempDir("bb-command-router-state-");
    const homeDir = await makeTempDir("bb-command-router-home-");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const workspace = createFakeWorkspace("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => workspace),
      createRuntime: vi.fn(() => runtime),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const snapshot = {
      env: {
        PI_CODING_AGENT_DIR: "~/.pi/agent",
      },
      files: [
        {
          contents: "{}\n",
          managedBy: "bb-runtime-material",
          mode: 0o600,
          path: "~/.codex/auth.json",
        },
      ],
      version: "runtime-version-1",
    } as const;
    const reportResult = vi.fn(async () => undefined);
    const router = new CommandRouter({
      fetchRuntimeMaterial: vi.fn(async () => snapshot),
      readPersistedRuntimeMaterial: async () => readRuntimeMaterialState(dataDir),
      persistRuntimeMaterial: async (nextSnapshot) =>
        writeRuntimeMaterialState(dataDir, nextSnapshot),
      reportResult,
      runtimeManager: manager,
      logger: createLogger(),
    });

    expect(manager.get("env-1")).toBeDefined();

    await router.handleCommands([
      {
        id: "runtime-sync",
        cursor: 1,
        command: {
          type: "host.sync_runtime_material",
          version: "runtime-version-1",
        },
      },
    ]);

    expect(manager.get("env-1")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    await expect(readRuntimeMaterialState(dataDir)).resolves.toEqual({
      files: [
        {
          managedBy: "bb-runtime-material",
          path: "~/.codex/auth.json",
        },
      ],
      version: "runtime-version-1",
    });
    await expect(
      fs.readFile(path.join(homeDir, ".codex", "auth.json"), "utf8"),
    ).resolves.toBe("{}\n");
    expect(reportResult).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "runtime-sync",
        ok: true,
      }),
    );
  });

  it("serializes host runtime material commands", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });
    const firstFetch = createDeferred<{
      env: Record<string, string>;
      files: Array<{
        contents: string;
        managedBy: "bb-runtime-material";
        mode: 0o600;
        path: string;
      }>;
      version: string;
    }>();
    const fetchRuntimeMaterial = vi
      .fn()
      .mockReturnValueOnce(firstFetch.promise)
      .mockResolvedValueOnce({
        env: {},
        files: [],
        version: "runtime-version-2",
      });
    const router = new CommandRouter({
      fetchRuntimeMaterial,
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      logger: createLogger(),
    });

    const handling = router.handleCommands([
      {
        id: "runtime-sync-1",
        cursor: 1,
        command: {
          type: "host.sync_runtime_material",
          version: "runtime-version-1",
        },
      },
      {
        id: "runtime-sync-2",
        cursor: 2,
        command: {
          type: "host.sync_runtime_material",
          version: "runtime-version-2",
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(fetchRuntimeMaterial).toHaveBeenCalledTimes(1);
    });
    expect(fetchRuntimeMaterial).not.toHaveBeenCalledWith("runtime-version-2");

    firstFetch.resolve({
      env: {},
      files: [],
      version: "runtime-version-1",
    });

    await vi.waitFor(() => {
      expect(fetchRuntimeMaterial).toHaveBeenCalledWith("runtime-version-2");
    });

    await handling;
  });

  it("serializes workspace commands per environment", async () => {
    const workspace = createFakeWorkspace("/tmp/env-1");
    const commitDeferred = createDeferred<{ commitSha: string; commitSubject: string }>();
    workspace.commit.mockReturnValueOnce(commitDeferred.promise);

    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => workspace),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const router = new CommandRouter({
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
    });
    const handling = router.handleCommands([
      {
        id: "commit",
        cursor: 1,
        command: {
          type: "workspace.commit",
          environmentId: "env-1",
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" as const },
          message: "Commit",
        },
      },
      {
        id: "status",
        cursor: 2,
        command: {
          type: "workspace.status",
          environmentId: "env-1",
          workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" as const },
          mergeBaseBranch: "main",
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(workspace.commit).toHaveBeenCalledTimes(1);
    });
    expect(workspace.getStatus).not.toHaveBeenCalled();

    commitDeferred.resolve({
      commitSha: "commit-1",
      commitSubject: "subject",
    });
    await handling;

    expect(workspace.getStatus).toHaveBeenCalledTimes(1);
  });

  it("runs provider commands for different threads concurrently", async () => {
    const runtime = createFakeRuntime();
    const threadA = createDeferred<undefined>();
    const threadB = createDeferred<undefined>();
    runtime.runTurn.mockImplementation(({ threadId }: { threadId: string }) => {
      return threadId === "thread-a" ? threadA.promise : threadB.promise;
    });

    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => runtime),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    manager.markThreadActive("env-1", "thread-a", "provider-a");
    manager.markThreadActive("env-1", "thread-b", "provider-b");

    const router = new CommandRouter({
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
    });
    const handling = router.handleCommands([
      {
        id: "run-a",
        cursor: 1,
        command: {
          type: "turn.run",
          environmentId: "env-1",
          threadId: "thread-a",
          eventSequence: 1,
          input: [{ type: "text", text: "A" }],
          options: {
            model: "gpt-5",
            serviceTier: "default" as const,
            reasoningLevel: "medium" as const,
            sandboxMode: "danger-full-access" as const,
          },
          resumeContext: {
            workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" as const },
            projectId: "project-1",
            providerId: "fake",
            providerThreadId: "provider-a",
            instructions: "Be a helpful coding agent.",
            dynamicTools: [],
            instructionMode: "append" as const,
          },
        },
      },
      {
        id: "run-b",
        cursor: 2,
        command: {
          type: "turn.run",
          environmentId: "env-1",
          threadId: "thread-b",
          eventSequence: 2,
          input: [{ type: "text", text: "B" }],
          options: {
            model: "gpt-5",
            serviceTier: "default" as const,
            reasoningLevel: "medium" as const,
            sandboxMode: "danger-full-access" as const,
          },
          resumeContext: {
            workspaceContext: { workspacePath: "/tmp/env-1", workspaceProvisionType: "unmanaged" as const },
            projectId: "project-1",
            providerId: "fake",
            providerThreadId: "provider-b",
            instructions: "Be a helpful coding agent.",
            dynamicTools: [],
            instructionMode: "append" as const,
          },
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(runtime.runTurn).toHaveBeenCalledTimes(2);
    });

    threadA.resolve(undefined);
    threadB.resolve(undefined);
    await handling;
  });

  it("reports completed commands in completion order", async () => {
    const runtime = createFakeRuntime();
    const threadOne = createDeferred<{ providerThreadId: string }>();
    const threadTwo = createDeferred<{ providerThreadId: string }>();
    const threadThree = createDeferred<{ providerThreadId: string }>();
    runtime.startThread
      .mockReturnValueOnce(threadOne.promise)
      .mockReturnValueOnce(threadTwo.promise)
      .mockReturnValueOnce(threadThree.promise);

    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => runtime),
    });
    const reported: string[] = [];
    const router = new CommandRouter({
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
      reportResult: async (result) => {
        reported.push(result.commandId);
      },
    });

    const handling = router.handleCommands([
      {
        id: "cmd-5",
        cursor: 5,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-1",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          eventSequence: 5,
          input: [{ type: "text", text: "start thread 1" }],
        },
      },
      {
        id: "cmd-6",
        cursor: 6,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-2",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          eventSequence: 6,
          input: [{ type: "text", text: "start thread 2" }],
        },
      },
      {
        id: "cmd-7",
        cursor: 7,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-3",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          eventSequence: 7,
          input: [{ type: "text", text: "start thread 3" }],
        },
      },
    ]);

    threadThree.resolve({ providerThreadId: "provider-3" });
    await vi.waitFor(() => {
      expect(reported).toEqual(["cmd-7"]);
    });

    threadOne.resolve({ providerThreadId: "provider-1" });
    await vi.waitFor(() => {
      expect(reported).toEqual(["cmd-7", "cmd-5"]);
    });

    threadTwo.resolve({ providerThreadId: "provider-2" });
    await handling;
    expect(reported).toEqual(["cmd-7", "cmd-5", "cmd-6"]);
  });

  it("captures completedAt after execution in success and error paths", async () => {
    const runtime = createFakeRuntime();
    const success = createDeferred<{ providerThreadId: string }>();
    const failure = createDeferred<{ providerThreadId: string }>();
    runtime.startThread
      .mockReturnValueOnce(success.promise)
      .mockImplementationOnce(async () => {
        await failure.promise;
        throw new Error("boom");
      });

    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => runtime),
    });
    let nowValue = 100;
    const results: Array<{ commandId: string; completedAt: number; ok: boolean }> = [];
    const router = new CommandRouter({
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
      now: () => nowValue,
      reportResult: async (result) => {
        results.push({
          commandId: result.commandId,
          completedAt: result.completedAt,
          ok: result.ok,
        });
      },
    });

    const handling = router.handleCommands([
      {
        id: "success",
        cursor: 1,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-1",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          eventSequence: 1,
          input: [{ type: "text", text: "start thread 1" }],
        },
      },
      {
        id: "failure",
        cursor: 2,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-2",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          eventSequence: 2,
          input: [{ type: "text", text: "start thread 2" }],
        },
      },
    ]);

    nowValue = 200;
    success.resolve({ providerThreadId: "provider-1" });
    await vi.waitFor(() => {
      expect(results.some((result) => result.commandId === "success")).toBe(true);
    });

    nowValue = 300;
    failure.resolve({ providerThreadId: "provider-2" });
    await handling;

    expect(results).toEqual([
      { commandId: "success", completedAt: 200, ok: true },
      { commandId: "failure", completedAt: 300, ok: false },
    ]);
  });

  it("allows subsequent commands after environment.destroy", async () => {
    const destroyedWorkspace = createFakeWorkspace("/tmp/env-1");
    const recreatedWorkspace = createFakeWorkspace("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: vi
        .fn()
        .mockResolvedValueOnce(destroyedWorkspace)
        .mockResolvedValueOnce(recreatedWorkspace),
      createRuntime: vi.fn(() => runtime),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const router = new CommandRouter({
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
    });
    await router.handleCommands([
      {
        id: "destroy",
        cursor: 1,
        command: {
          type: "environment.destroy",
          environmentId: "env-1",
          path: "/tmp/env-1",
          workspaceProvisionType: "managed-worktree",
        },
      },
    ]);

    expect(manager.get("env-1")).toBeUndefined();

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await router.handleCommands([
      {
        id: "status",
        cursor: 2,
        command: {
          type: "workspace.status",
          environmentId: "env-1",
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged" as const,
          },
          mergeBaseBranch: "main",
        },
      },
    ]);

    expect(recreatedWorkspace.getStatus).toHaveBeenCalledTimes(1);
  });

  it("recovers result reporting after a transient report failure", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });
    const logger = createLogger();
    let shouldFail = true;
    const reported: string[] = [];
    const router = new CommandRouter({
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger,
      reportResult: async (result) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("report failed");
        }
        reported.push(result.commandId);
      },
    });

    await router.handleCommands([
      {
        id: "cmd-1",
        cursor: 1,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-1",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          eventSequence: 1,
          input: [{ type: "text", text: "start thread 1" }],
        },
      },
    ]);

    expect(reported).toEqual([]);

    await router.handleCommands([
      {
        id: "cmd-2",
        cursor: 2,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-2",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          eventSequence: 2,
          input: [{ type: "text", text: "start thread 2" }],
        },
      },
    ]);

    expect(reported).toEqual(["cmd-1", "cmd-2"]);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
      },
      "failed to report command result, will retry on next completion",
    );
  });
});
