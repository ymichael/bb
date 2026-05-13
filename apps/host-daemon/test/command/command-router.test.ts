import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import {
  readRuntimeMaterialState,
  writeRuntimeMaterialState,
} from "@bb/host-runtime-material";
import type { HostRuntimeMaterialSnapshot } from "@bb/host-daemon-contract";
import {
  encodeClientTurnRequestIdNumber,
  type ClientTurnRequestId,
} from "@bb/domain";
import type {
  CommitOptions,
  CommitResult,
  HostWorkspace,
  ProvisionWorkspaceArgs,
  SquashMergeOptions,
  SquashMergeResult,
} from "@bb/host-workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRouter } from "../../src/command-router.js";
import { noopEventSink } from "../../src/command-dispatch-support.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import { unexpectedProjectAttachmentFetch } from "./dispatch-helpers.js";

const tempDirs: string[] = [];
let nextClientRequestIdValue = 1;

type StartThreadArgs = Parameters<AgentRuntime["startThread"]>[0];
type StartThreadResult = Awaited<ReturnType<AgentRuntime["startThread"]>>;
type ResumeThreadArgs = Parameters<AgentRuntime["resumeThread"]>[0];
type ResumeThreadResult = Awaited<ReturnType<AgentRuntime["resumeThread"]>>;
type RunTurnArgs = Parameters<AgentRuntime["runTurn"]>[0];
type SteerTurnArgs = Parameters<AgentRuntime["steerTurn"]>[0];
type SteerTurnResult = Awaited<ReturnType<AgentRuntime["steerTurn"]>>;
type StopThreadArgs = Parameters<AgentRuntime["stopThread"]>[0];
type RenameThreadArgs = Parameters<AgentRuntime["renameThread"]>[0];
type ArchiveThreadArgs = Parameters<AgentRuntime["archiveThread"]>[0];
type UnarchiveThreadArgs = Parameters<AgentRuntime["unarchiveThread"]>[0];
type EnsureProviderArgs = Parameters<AgentRuntime["ensureProvider"]>[0];
type ListModelsArgs = Parameters<AgentRuntime["listModels"]>[0];
type ListModelsResult = Awaited<ReturnType<AgentRuntime["listModels"]>>;

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

function nextClientRequestId(): ClientTurnRequestId {
  const requestId = encodeClientTurnRequestIdNumber({
    value: nextClientRequestIdValue,
  });
  nextClientRequestIdValue += 1;
  return requestId;
}

// HostWorkspace exposes its scalar fields as readonly. The fake workspace lets
// tests reassign them where useful, so use the mutable equivalents and type
// each method as a vitest mock with the production signature.
interface FakeWorkspace {
  path: HostWorkspace["path"];
  managed: HostWorkspace["managed"];
  isGitRepo: HostWorkspace["isGitRepo"];
  isWorktree: HostWorkspace["isWorktree"];
  getCurrentBranch: ReturnType<typeof vi.fn<HostWorkspace["getCurrentBranch"]>>;
  getHeadSha: ReturnType<typeof vi.fn<HostWorkspace["getHeadSha"]>>;
  getLocalStateFingerprint: ReturnType<
    typeof vi.fn<HostWorkspace["getLocalStateFingerprint"]>
  >;
  getSharedGitRefsFingerprint: ReturnType<
    typeof vi.fn<HostWorkspace["getSharedGitRefsFingerprint"]>
  >;
  getAdditionalWorkspaceWriteRoots: ReturnType<
    typeof vi.fn<HostWorkspace["getAdditionalWorkspaceWriteRoots"]>
  >;
  getStatus: ReturnType<typeof vi.fn<HostWorkspace["getStatus"]>>;
  getDiff: ReturnType<typeof vi.fn<HostWorkspace["getDiff"]>>;
  listBranches: ReturnType<typeof vi.fn<HostWorkspace["listBranches"]>>;
  listFiles: ReturnType<typeof vi.fn<HostWorkspace["listFiles"]>>;
  commit: ReturnType<
    typeof vi.fn<(options: CommitOptions) => Promise<CommitResult>>
  >;
  reset: ReturnType<typeof vi.fn<HostWorkspace["reset"]>>;
  fetch: ReturnType<typeof vi.fn<HostWorkspace["fetch"]>>;
  squashMerge: ReturnType<
    typeof vi.fn<(options: SquashMergeOptions) => Promise<SquashMergeResult>>
  >;
  destroy: ReturnType<typeof vi.fn<HostWorkspace["destroy"]>>;
}

function createFakeWorkspace(path: string): FakeWorkspace {
  return {
    path,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    getCurrentBranch: vi.fn<HostWorkspace["getCurrentBranch"]>(
      async () => "main",
    ),
    getHeadSha: vi.fn<HostWorkspace["getHeadSha"]>(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn<HostWorkspace["getLocalStateFingerprint"]>(
      async () =>
        JSON.stringify({ currentBranch: "main", headSha: "commit-1" }),
    ),
    getSharedGitRefsFingerprint: vi.fn<
      HostWorkspace["getSharedGitRefsFingerprint"]
    >(async () =>
      JSON.stringify({
        refs: [["refs/heads/main", "commit-1"]],
        remoteHead: null,
      }),
    ),
    getAdditionalWorkspaceWriteRoots: vi.fn<
      HostWorkspace["getAdditionalWorkspaceWriteRoots"]
    >(async () => []),
    getStatus: vi.fn<HostWorkspace["getStatus"]>(async () => ({
      workingTree: {
        hasUncommittedChanges: false,
        state: "clean",
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
    getDiff: vi.fn<HostWorkspace["getDiff"]>(async () => ({
      diff: "",
      truncated: false,
      shortstat: "",
      files: "",
      mergeBaseRef: null,
    })),
    listBranches: vi.fn<HostWorkspace["listBranches"]>(async () => ["main"]),
    listFiles: vi.fn<HostWorkspace["listFiles"]>(async () => []),
    commit: vi.fn<(options: CommitOptions) => Promise<CommitResult>>(
      async () => ({
        commitSha: "commit-1",
        commitSubject: "subject",
      }),
    ),
    reset: vi.fn<HostWorkspace["reset"]>(async () => undefined),
    fetch: vi.fn<HostWorkspace["fetch"]>(async () => undefined),
    squashMerge: vi.fn<
      (options: SquashMergeOptions) => Promise<SquashMergeResult>
    >(async () => ({
      merged: true,
      commitSha: "commit-3",
      commitSubject: "squash subject",
      targetBranch: "main",
    })),
    destroy: vi.fn<HostWorkspace["destroy"]>(async () => undefined),
  };
}

interface FakeRuntime {
  ensureProvider: ReturnType<
    typeof vi.fn<(args: EnsureProviderArgs) => Promise<void>>
  >;
  startThread: ReturnType<
    typeof vi.fn<(args: StartThreadArgs) => Promise<StartThreadResult>>
  >;
  resumeThread: ReturnType<
    typeof vi.fn<(args: ResumeThreadArgs) => Promise<ResumeThreadResult>>
  >;
  runTurn: ReturnType<typeof vi.fn<(args: RunTurnArgs) => Promise<void>>>;
  steerTurn: ReturnType<
    typeof vi.fn<(args: SteerTurnArgs) => Promise<SteerTurnResult>>
  >;
  stopThread: ReturnType<typeof vi.fn<(args: StopThreadArgs) => Promise<void>>>;
  renameThread: ReturnType<
    typeof vi.fn<(args: RenameThreadArgs) => Promise<void>>
  >;
  archiveThread: ReturnType<
    typeof vi.fn<(args: ArchiveThreadArgs) => Promise<void>>
  >;
  unarchiveThread: ReturnType<
    typeof vi.fn<(args: UnarchiveThreadArgs) => Promise<void>>
  >;
  listModels: ReturnType<
    typeof vi.fn<(args: ListModelsArgs) => Promise<ListModelsResult>>
  >;
  listRunningProviders: ReturnType<typeof vi.fn<() => string[]>>;
  shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function createFakeRuntime(): FakeRuntime {
  return {
    ensureProvider: vi.fn<(args: EnsureProviderArgs) => Promise<void>>(
      async () => undefined,
    ),
    startThread: vi.fn<(args: StartThreadArgs) => Promise<StartThreadResult>>(
      async ({ threadId }) => ({
        providerThreadId: `provider-${threadId}`,
      }),
    ),
    resumeThread: vi.fn<
      (args: ResumeThreadArgs) => Promise<ResumeThreadResult>
    >(async ({ providerThreadId }) => ({
      providerThreadId: providerThreadId ?? "provider-resumed",
    })),
    runTurn: vi.fn<(args: RunTurnArgs) => Promise<void>>(async () => undefined),
    steerTurn: vi.fn<(args: SteerTurnArgs) => Promise<SteerTurnResult>>(
      async () => ({ status: "steered" }),
    ),
    stopThread: vi.fn<(args: StopThreadArgs) => Promise<void>>(
      async () => undefined,
    ),
    renameThread: vi.fn<(args: RenameThreadArgs) => Promise<void>>(
      async () => undefined,
    ),
    archiveThread: vi.fn<(args: ArchiveThreadArgs) => Promise<void>>(
      async () => undefined,
    ),
    unarchiveThread: vi.fn<(args: UnarchiveThreadArgs) => Promise<void>>(
      async () => undefined,
    ),
    listModels: vi.fn<(args: ListModelsArgs) => Promise<ListModelsResult>>(
      async () => [],
    ),
    listRunningProviders: vi.fn<() => string[]>(() => []),
    shutdown: vi.fn<() => Promise<void>>(async () => undefined),
  };
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
    workspaceContext: {
      workspacePath: args.workspacePath,
      workspaceProvisionType: "unmanaged" as const,
    },
    projectId: "project-1",
    providerId: "fake",
    ...(args.providerThreadId
      ? { providerThreadId: args.providerThreadId }
      : {}),
    options: {
      model: "gpt-5",
      serviceTier: "default" as const,
      reasoningLevel: "medium" as const,
      permissionMode: "full" as const,
      permissionEscalation: null,
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
      tempDirs
        .splice(0)
        .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
    );
  });

  it("applies runtime material with real state persistence and evicts idle environments", async () => {
    const dataDir = await makeTempDir("bb-command-router-state-");
    const homeDir = await makeTempDir("bb-command-router-home-");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    const workspace = createFakeWorkspace("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: async () => workspace,
      createRuntime: () => runtime,
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const snapshot: HostRuntimeMaterialSnapshot = {
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
    };
    const reportResult = vi.fn(async () => undefined);
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: async () => snapshot,
      readPersistedRuntimeMaterial: async () =>
        readRuntimeMaterialState(dataDir),
      persistRuntimeMaterial: async (nextSnapshot) =>
        writeRuntimeMaterialState(dataDir, nextSnapshot),
      reportResult,
      runtimeManager: manager,
      eventSink: noopEventSink,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
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

  it("does not flush unrelated buffered events before reporting read-only workspace command results", async () => {
    const calls: string[] = [];
    const flushDeferred = createDeferred<void>();
    const eventSink = {
      emit: vi.fn(),
      flush: vi.fn(async () => {
        calls.push("flush");
        await flushDeferred.promise;
      }),
    };
    const reportResult = vi.fn(async () => {
      calls.push("report");
    });
    const manager = new RuntimeManager({
      provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
      workspaceProvisionType: "unmanaged",
    });
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: async () => null,
      persistRuntimeMaterial: async () => undefined,
      reportResult,
      runtimeManager: manager,
      eventSink,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
    });

    await router.handleCommands([
      {
        id: "provider-list",
        cursor: 1,
        command: {
          type: "workspace.status",
          environmentId: "env-1",
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged",
          },
        },
      },
    ]);

    expect(calls).toEqual(["report"]);
    expect(eventSink.flush).not.toHaveBeenCalled();
    flushDeferred.resolve(undefined);
  });

  it("reports missing host file reads without warning", async () => {
    const rootPath = await makeTempDir("bb-command-router-read-file-");
    const missingPath = path.join(rootPath, "STATUS.md");
    const reportResult = vi.fn(async () => undefined);
    const logger = createLogger();
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: async () => null,
      persistRuntimeMaterial: async () => undefined,
      reportResult,
      runtimeManager: new RuntimeManager({
        provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
      }),
      eventSink: noopEventSink,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger,
    });

    await router.handleCommands([
      {
        id: "read-missing-status",
        cursor: 1,
        command: {
          type: "host.read_file",
          path: missingPath,
          rootPath,
        },
      },
    ]);

    expect(reportResult).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "read-missing-status",
        errorCode: "ENOENT",
        errorMessage: `Path does not exist: ${missingPath}`,
        ok: false,
        type: "host.read_file",
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("still warns for missing host file read roots", async () => {
    const parentPath = await makeTempDir("bb-command-router-root-");
    const rootPath = path.join(parentPath, "missing-root");
    const missingPath = path.join(rootPath, "STATUS.md");
    const reportResult = vi.fn(async () => undefined);
    const logger = createLogger();
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: async () => null,
      persistRuntimeMaterial: async () => undefined,
      reportResult,
      runtimeManager: new RuntimeManager({
        provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
      }),
      eventSink: noopEventSink,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger,
    });

    await router.handleCommands([
      {
        id: "read-missing-root",
        cursor: 1,
        command: {
          type: "host.read_file",
          path: missingPath,
          rootPath,
        },
      },
    ]);

    expect(reportResult).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "read-missing-root",
        errorCode: "ENOENT",
        errorMessage: `Path does not exist: ${missingPath}`,
        ok: false,
        type: "host.read_file",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "read-missing-root",
        type: "host.read_file",
      }),
      "command execution failed",
    );
  });

  it("flushes buffered provider events before reporting thread command results", async () => {
    const calls: string[] = [];
    const eventSink = {
      emit: vi.fn(),
      flush: vi.fn(async () => {
        calls.push("flush");
      }),
    };
    const reportResult = vi.fn(async () => {
      calls.push("report");
    });
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: async () => null,
      persistRuntimeMaterial: async () => undefined,
      reportResult,
      runtimeManager: new RuntimeManager({
        provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
        createRuntime: () => createFakeRuntime(),
      }),
      eventSink,
      logger: createLogger(),
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
    });

    await router.handleCommands([
      {
        id: "thread-start",
        cursor: 1,
        command: {
          type: "thread.start",
          environmentId: "env-1",
          threadId: "thread-1",
          ...createStandardRuntimeCommandContext({
            workspacePath: "/tmp/env-1",
          }),
          requestId: nextClientRequestId(),
          input: [{ type: "text", text: "start thread" }],
        },
      },
    ]);

    expect(calls).toEqual(["flush", "report"]);
    expect(eventSink.flush).toHaveBeenCalledTimes(1);
  });

  it("serializes host runtime material commands", async () => {
    const manager = new RuntimeManager({
      provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
      createRuntime: () => createFakeRuntime(),
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
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial,
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
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
    const commitDeferred = createDeferred<{
      commitSha: string;
      commitSubject: string;
    }>();
    workspace.commit.mockReturnValueOnce(commitDeferred.promise);

    const manager = new RuntimeManager({
      provisionWorkspace: async () => workspace,
      createRuntime: () => createFakeRuntime(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
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
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "unmanaged" as const,
          },
          message: "Commit",
        },
      },
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

  it("serializes thread.archive before environment.destroy for the same environment", async () => {
    const calls: string[] = [];
    const workspace = createFakeWorkspace("/tmp/env-1");
    workspace.destroy.mockImplementation(async () => {
      calls.push("destroy:workspace");
    });

    const runtime = createFakeRuntime();
    const archiveStarted = createDeferred<void>();
    const archiveDeferred = createDeferred<void>();
    runtime.archiveThread.mockImplementation(
      async (_args: ArchiveThreadArgs) => {
        calls.push("archive:start");
        archiveStarted.resolve(undefined);
        await archiveDeferred.promise;
        calls.push("archive:done");
      },
    );
    runtime.shutdown.mockImplementation(async () => {
      calls.push("destroy:runtime");
    });

    const manager = new RuntimeManager({
      provisionWorkspace: async () => workspace,
      createRuntime: () => runtime,
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
    });

    const workspaceContext = {
      workspacePath: "/tmp/env-1",
      workspaceProvisionType: "managed-worktree" as const,
    };
    const handling = router.handleCommands([
      {
        id: "archive",
        cursor: 1,
        command: {
          type: "thread.archive",
          environmentId: "env-1",
          threadId: "thread-1",
          workspaceContext,
          providerId: "fake",
          providerThreadId: "provider-thread-1",
        },
      },
      {
        id: "destroy",
        cursor: 2,
        command: {
          type: "environment.destroy",
          environmentId: "env-1",
          workspaceContext,
        },
      },
    ]);

    await archiveStarted.promise;

    expect(runtime.archiveThread).toHaveBeenCalledWith({
      providerId: "fake",
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
    });
    expect(runtime.shutdown).not.toHaveBeenCalled();
    expect(workspace.destroy).not.toHaveBeenCalled();

    archiveDeferred.resolve(undefined);
    await handling;

    expect(calls).toEqual([
      "archive:start",
      "archive:done",
      "destroy:runtime",
      "destroy:workspace",
    ]);
  });

  it("runs provider commands for different threads concurrently", async () => {
    const runtime = createFakeRuntime();
    const threadA = createDeferred<undefined>();
    const threadB = createDeferred<undefined>();
    runtime.runTurn.mockImplementation(({ threadId }: { threadId: string }) => {
      return threadId === "thread-a" ? threadA.promise : threadB.promise;
    });

    const manager = new RuntimeManager({
      provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
      createRuntime: () => runtime,
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    manager.markThreadActive("env-1", "thread-a", "provider-a");
    manager.markThreadActive("env-1", "thread-b", "provider-b");

    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
      threadStorageRootPath: "/tmp/bb-test-thread-storage",
      logger: createLogger(),
    });
    const handling = router.handleCommands([
      {
        id: "run-a",
        cursor: 1,
        command: {
          type: "turn.submit",
          environmentId: "env-1",
          threadId: "thread-a",
          requestId: nextClientRequestId(),
          input: [{ type: "text", text: "A" }],
          options: {
            model: "gpt-5",
            serviceTier: "default" as const,
            reasoningLevel: "medium" as const,
            permissionMode: "full" as const,
            permissionEscalation: null,
          },
          resumeContext: {
            workspaceContext: {
              workspacePath: "/tmp/env-1",
              workspaceProvisionType: "unmanaged" as const,
            },
            projectId: "project-1",
            providerId: "fake",
            providerThreadId: "provider-a",
            instructions: "Be a helpful coding agent.",
            dynamicTools: [],
            instructionMode: "append" as const,
          },
          target: { mode: "start" },
        },
      },
      {
        id: "run-b",
        cursor: 2,
        command: {
          type: "turn.submit",
          environmentId: "env-1",
          threadId: "thread-b",
          requestId: nextClientRequestId(),
          input: [{ type: "text", text: "B" }],
          options: {
            model: "gpt-5",
            serviceTier: "default" as const,
            reasoningLevel: "medium" as const,
            permissionMode: "full" as const,
            permissionEscalation: null,
          },
          resumeContext: {
            workspaceContext: {
              workspacePath: "/tmp/env-1",
              workspaceProvisionType: "unmanaged" as const,
            },
            projectId: "project-1",
            providerId: "fake",
            providerThreadId: "provider-b",
            instructions: "Be a helpful coding agent.",
            dynamicTools: [],
            instructionMode: "append" as const,
          },
          target: { mode: "start" },
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
      provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
      createRuntime: () => runtime,
    });
    const reported: string[] = [];
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
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
          requestId: nextClientRequestId(),
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
          requestId: nextClientRequestId(),
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
          requestId: nextClientRequestId(),
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
      provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
      createRuntime: () => runtime,
    });
    let nowValue = 100;
    const results: Array<{
      commandId: string;
      completedAt: number;
      ok: boolean;
    }> = [];
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
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
          requestId: nextClientRequestId(),
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
          requestId: nextClientRequestId(),
          input: [{ type: "text", text: "start thread 2" }],
        },
      },
    ]);

    nowValue = 200;
    success.resolve({ providerThreadId: "provider-1" });
    await vi.waitFor(() => {
      expect(results.some((result) => result.commandId === "success")).toBe(
        true,
      );
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
        .fn<(options: ProvisionWorkspaceArgs) => Promise<HostWorkspace>>()
        .mockResolvedValueOnce(destroyedWorkspace)
        .mockResolvedValueOnce(recreatedWorkspace),
      createRuntime: () => runtime,
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
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
          workspaceContext: {
            workspacePath: "/tmp/env-1",
            workspaceProvisionType: "managed-worktree",
          },
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
      provisionWorkspace: async () => createFakeWorkspace("/tmp/env-1"),
      createRuntime: () => createFakeRuntime(),
    });
    const logger = createLogger();
    let shouldFail = true;
    const reported: string[] = [];
    const router = new CommandRouter({
      dataDir: "/tmp/bb-test-data",
      fetchProjectAttachment: unexpectedProjectAttachmentFetch,
      fetchRuntimeMaterial: vi.fn(),
      readPersistedRuntimeMaterial: vi.fn(async () => null),
      persistRuntimeMaterial: vi.fn(async () => undefined),
      runtimeManager: manager,
      eventSink: noopEventSink,
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
          requestId: nextClientRequestId(),
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
          requestId: nextClientRequestId(),
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
