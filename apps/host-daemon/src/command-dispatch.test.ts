import type { AgentRuntime } from "@bb/agent-runtime";
import type { HostWorkspace } from "@bb/host-workspace";
import { describe, expect, it, vi } from "vitest";
import { dispatchCommand } from "./command-dispatch.js";
import type { CommandOf } from "./command-dispatch-support.js";
import { RuntimeManager } from "./runtime-manager.js";

interface Deferred<TValue> {
  promise: Promise<TValue>;
  resolve: (value: TValue | PromiseLike<TValue>) => void;
  reject: (reason?: Error) => void;
}

function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: Deferred<TValue>["resolve"];
  let reject!: Deferred<TValue>["reject"];
  const promise = new Promise<TValue>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

async function unexpectedWorkspaceCall(): Promise<never> {
  throw new Error("Unexpected workspace call");
}

function createWorkspace(): HostWorkspace {
  return {
    path: "/tmp/bb-command-dispatch-test",
    managed: false,
    isGitRepo: false,
    isWorktree: false,
    getCurrentBranch: unexpectedWorkspaceCall,
    getHeadSha: unexpectedWorkspaceCall,
    getLocalStateFingerprint: unexpectedWorkspaceCall,
    getSharedGitRefsFingerprint: unexpectedWorkspaceCall,
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: unexpectedWorkspaceCall,
    getDiff: unexpectedWorkspaceCall,
    listBranches: unexpectedWorkspaceCall,
    listFiles: unexpectedWorkspaceCall,
    commit: unexpectedWorkspaceCall,
    reset: unexpectedWorkspaceCall,
    fetch: unexpectedWorkspaceCall,
    squashMerge: unexpectedWorkspaceCall,
    promote: unexpectedWorkspaceCall,
    demote: unexpectedWorkspaceCall,
    destroy: vi.fn(async () => undefined),
  };
}

function createRuntime(): AgentRuntime {
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async () => ({ providerThreadId: "provider-thread-1" })),
    resumeThread: vi.fn(async () => ({
      providerThreadId: "provider-thread-1",
    })),
    runTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => ({ status: "steered" as const })),
    stopThread: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    listRunningProviders: vi.fn(() => ["fake"]),
    shutdown: vi.fn(async () => undefined),
  };
}

describe("dispatchCommand", () => {
  it("flushes buffered events before reporting thread.stop success", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/bb-command-dispatch-test",
    });
    manager.markThreadActive("env-1", "thread-1", "provider-thread-1");

    const flushDeferred = createDeferred<void>();
    const flush = vi.fn(async () => flushDeferred.promise);
    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      environmentId: "env-1",
      threadId: "thread-1",
    };
    let resolved = false;
    const dispatchPromise = dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      eventSink: {
        emit: vi.fn(),
        flush,
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchRuntimeMaterial: async () => unexpectedWorkspaceCall(),
      persistRuntimeMaterial: async () => undefined,
      readPersistedRuntimeMaterial: async () => null,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    }).then(() => {
      resolved = true;
    });

    await vi.waitFor(() => {
      expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(flush).toHaveBeenCalledTimes(1);
    });
    expect(resolved).toBe(false);
    expect(manager.hasThread("env-1", "thread-1")).toBe(true);

    flushDeferred.resolve(undefined);
    await dispatchPromise;

    expect(resolved).toBe(true);
    expect(manager.hasThread("env-1", "thread-1")).toBe(false);
  });

  it("aborts a replay task before falling through to the runtime thread.stop path", async () => {
    const manager = new RuntimeManager({
      createRuntime: () => createRuntime(),
      provisionWorkspace: async () => createWorkspace(),
    });
    const abort = new AbortController();
    const replayTasks = new Map([
      ["thread-1", { abort, done: Promise.resolve() }],
    ]);
    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      environmentId: "env-1",
      threadId: "thread-1",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchRuntimeMaterial: async () => unexpectedWorkspaceCall(),
      persistRuntimeMaterial: async () => undefined,
      readPersistedRuntimeMaterial: async () => null,
      replayTasks,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({});
    expect(abort.signal.aborted).toBe(true);
  });
});
