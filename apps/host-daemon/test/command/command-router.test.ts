import type { AgentRuntime } from "@bb/agent-runtime";
import type { IWorkspace } from "@bb/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRouter } from "../../src/command-router.js";
import { RuntimeManager } from "../../src/runtime-manager.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createFakeWorkspace(path: string) {
  return {
    path,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    currentBranch: vi.fn(async () => "main"),
    getStatus: vi.fn(async () => null),
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
      commitSubject: "subject",
    })),
    reset: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => ({
      commitSha: "commit-2",
      branchName: "main",
      remoteName: "origin",
    })),
    squashMergeInto: vi.fn(async () => ({
      merged: true,
      commitSha: "commit-3",
      targetBranch: "main",
    })),
    promote: vi.fn(async () => undefined),
    demote: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  } as unknown as IWorkspace & {
    commit: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  };
}

function createFakeRuntime() {
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async ({ threadId }: { threadId: string }) => ({
      providerThreadId: `provider-${threadId}`,
    })),
    resumeThread: vi.fn(async ({ providerThreadId }: { providerThreadId?: string }) => ({
      providerThreadId,
    })),
    runTurn: vi.fn(async (_args: { threadId: string }) => undefined),
    steerTurn: vi.fn(async (_args: unknown) => undefined),
    stopThread: vi.fn(async (_args: unknown) => undefined),
    renameThread: vi.fn(async (_args: unknown) => undefined),
    listModels: vi.fn(async () => []),
    shutdown: vi.fn(async () => undefined),
  };
}

function createLogger() {
  return {
    warn: vi.fn(),
  };
}

describe("CommandRouter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes workspace commands per environment", async () => {
    const workspace = createFakeWorkspace("/tmp/env-1");
    const commitDeferred = createDeferred<{ commitSha: string; commitSubject: string }>();
    workspace.commit.mockReturnValueOnce(commitDeferred.promise);

    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => workspace),
      createRuntime: vi.fn(
        () => createFakeRuntime() as unknown as AgentRuntime,
      ),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const router = new CommandRouter({
      runtimeManager: manager,
      logger: createLogger(),
    });
    const handling = router.handleCommands([
      {
        id: "commit",
        cursor: 1,
        command: {
          type: "workspace.commit",
          environmentId: "env-1",
          threadId: "thread-1",
          message: "Commit",
        },
      },
      {
        id: "reset",
        cursor: 2,
        command: {
          type: "workspace.reset",
          environmentId: "env-1",
          threadId: "thread-1",
        },
      },
    ]);

    await vi.waitFor(() => {
      expect(workspace.commit).toHaveBeenCalledTimes(1);
    });
    expect(workspace.reset).not.toHaveBeenCalled();

    commitDeferred.resolve({
      commitSha: "commit-1",
      commitSubject: "subject",
    });
    await handling;

    expect(workspace.reset).toHaveBeenCalledTimes(1);
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
      createRuntime: vi.fn(() => runtime as unknown as AgentRuntime),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    manager.markThreadActive("env-1", "thread-a");
    manager.markThreadActive("env-1", "thread-b");

    const router = new CommandRouter({
      runtimeManager: manager,
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
          input: [{ type: "text", text: "A" }],
        },
      },
      {
        id: "run-b",
        cursor: 2,
        command: {
          type: "turn.run",
          environmentId: "env-1",
          threadId: "thread-b",
          input: [{ type: "text", text: "B" }],
        },
      },
    ]);

    await Promise.resolve();
    expect(runtime.runTurn).toHaveBeenCalledTimes(2);

    threadA.resolve(undefined);
    threadB.resolve(undefined);
    await handling;
  });

  it("reports completed commands in contiguous cursor order", async () => {
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
      createRuntime: vi.fn(() => runtime as unknown as AgentRuntime),
    });
    const reported: number[] = [];
    const router = new CommandRouter({
      runtimeManager: manager,
      logger: createLogger(),
      reportResult: async (result) => {
        reported.push(result.cursor);
      },
      initialCursor: 4,
    });

    const handling = router.handleCommands([
      {
        id: "cmd-5",
        cursor: 5,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-1",
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
      {
        id: "cmd-6",
        cursor: 6,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-2",
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
      {
        id: "cmd-7",
        cursor: 7,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-3",
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
    ]);

    threadThree.resolve({ providerThreadId: "provider-3" });
    await Promise.resolve();
    expect(reported).toEqual([]);

    threadOne.resolve({ providerThreadId: "provider-1" });
    await Promise.resolve();
    expect(reported).toEqual([]);

    threadTwo.resolve({ providerThreadId: "provider-2" });
    await handling;
    expect(reported).toEqual([5, 6, 7]);
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
      createRuntime: vi.fn(() => runtime as unknown as AgentRuntime),
    });
    let nowValue = 100;
    const results: Array<{ cursor: number; completedAt: number; ok: boolean }> = [];
    const router = new CommandRouter({
      runtimeManager: manager,
      logger: createLogger(),
      now: () => nowValue,
      reportResult: async (result) => {
        results.push({
          cursor: result.cursor,
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
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
      {
        id: "failure",
        cursor: 2,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-2",
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
    ]);

    nowValue = 200;
    success.resolve({ providerThreadId: "provider-1" });
    await vi.waitFor(() => {
      expect(results.some((result) => result.cursor === 1)).toBe(true);
    });

    nowValue = 300;
    failure.resolve({ providerThreadId: "provider-2" });
    await handling;

    expect(results).toEqual([
      { cursor: 1, completedAt: 200, ok: true },
      { cursor: 2, completedAt: 300, ok: false },
    ]);
  });

  it("cleans up environment lanes after environment.destroy", async () => {
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

    const router = new CommandRouter({
      runtimeManager: manager,
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

    expect(
      (
        router as unknown as { environmentLanes: Map<string, Promise<unknown>> }
      ).environmentLanes.has("env-1"),
    ).toBe(false);
  });

  it("warns on cursor gaps and holds later results until the gap closes", async () => {
    const logger = createLogger();
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => createFakeRuntime() as unknown as AgentRuntime),
    });
    const reported: number[] = [];
    const router = new CommandRouter({
      runtimeManager: manager,
      logger,
      reportResult: async (result) => {
        reported.push(result.cursor);
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
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
      {
        id: "cmd-3",
        cursor: 3,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-3",
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
    ]);

    expect(reported).toEqual([1]);
    expect(logger.warn.mock.calls[0]).toEqual([
      expect.objectContaining({
        cursor: 3,
        lastReportedCursor: 0,
      }),
      "gap detected in command cursor sequence",
    ]);
    expect(
      (
        router as unknown as { completedResults: Map<number, unknown> }
      ).completedResults.has(3),
    ).toBe(true);
  });

  it("recovers result reporting after a transient report failure", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => createFakeWorkspace("/tmp/env-1")),
      createRuntime: vi.fn(() => createFakeRuntime() as unknown as AgentRuntime),
    });
    const logger = createLogger();
    let shouldFail = true;
    const reported: number[] = [];
    const router = new CommandRouter({
      runtimeManager: manager,
      logger,
      reportResult: async (result) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("report failed");
        }
        reported.push(result.cursor);
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
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
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
          workspacePath: "/tmp/env-1",
          projectId: "project-1",
          providerId: "fake",
        },
      },
    ]);

    expect(reported).toEqual([1, 2]);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
      },
      "failed to report command results, will retry on next completion",
    );
  });
});
