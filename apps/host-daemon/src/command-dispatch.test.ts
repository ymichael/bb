import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@bb/agent-runtime";
import type {
  HostDaemonInjectedSkillSource,
  ProviderCliInstallEvent,
  ProviderCliStatus,
} from "@bb/host-daemon-contract";
import type { HostWorkspace } from "@bb/host-workspace";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  dispatchCommand,
  dispatchOnlineRpcCommand,
} from "./command-dispatch.js";
import {
  DISPATCH_TEST_BRIDGE_LAUNCH,
  dispatchTestRuntimeBridgeLaunch,
  makeDispatchOptions,
  silentLogger,
  fetchDispatchTestArtifact,
  unexpectedProviderMaintenance,
} from "../test/command/dispatch-helpers.js";
import type { CommandOf } from "./command-dispatch-support.js";
import { RuntimeManager } from "./runtime-manager.js";

const WORKSPACE_PATH = "/tmp/bb-command-dispatch-test";

interface WriteInjectedSkillSourceArgs {
  dataDir: string;
  token: string;
}

interface BusySkillCatalogFixture {
  createRuntimeSpy: Mock<() => AgentRuntime>;
  dataDir: string;
  manager: RuntimeManager;
  originalCatalogHash: string | null;
  runtime: FakeDispatchRuntime;
  source: HostDaemonInjectedSkillSource;
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function writeInjectedSkillSource(
  args: WriteInjectedSkillSourceArgs,
): Promise<HostDaemonInjectedSkillSource> {
  const sourceRootPath = path.join(args.dataDir, "skills", "release-notes");
  await fs.mkdir(sourceRootPath, { recursive: true });
  await fs.writeFile(
    path.join(sourceRootPath, "SKILL.md"),
    [
      "---",
      "name: release-notes",
      "description: Use release-notes when command dispatch tests run.",
      "---",
      "",
      args.token,
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    kind: "workspace-path",
    sourceType: "project",
    name: "release-notes",
    description: "Use release-notes when command dispatch tests run.",
    sourceRootPath,
    skillFilePath: path.join(sourceRootPath, "SKILL.md"),
  };
}

async function setupBusySkillCatalogEnvironment(args: {
  activeThreadId: string;
}): Promise<BusySkillCatalogFixture> {
  const dataDir = await makeTempDir("bb-command-dispatch-skills-");
  const source = await writeInjectedSkillSource({
    dataDir,
    token: "first-token",
  });
  const runtime = createRuntime();
  const createRuntimeSpy = vi.fn(() => runtime);
  const manager = new RuntimeManager({
    dataDir,
    createRuntime: createRuntimeSpy,
    provisionWorkspace: async () => createWorkspace(),
  });
  const entry = await manager.ensureEnvironment({
    environmentId: "env-1",
    injectedSkillSources: [source],
    workspacePath: WORKSPACE_PATH,
  });
  runtime.setActiveTurn(args.activeThreadId, "turn-busy-1");
  await writeInjectedSkillSource({ dataDir, token: "second-token" });
  return {
    createRuntimeSpy,
    dataDir,
    manager,
    originalCatalogHash: entry.skillCatalogHash,
    runtime,
    source,
  };
}

async function unexpectedWorkspaceCall(): Promise<never> {
  throw new Error("Unexpected workspace call");
}

function createWorkspace(workspacePath = WORKSPACE_PATH): HostWorkspace {
  return {
    path: workspacePath,
    managed: false,
    isGitRepo: false,
    isWorktree: false,
    getDefaultBranch: unexpectedWorkspaceCall,
    getCurrentBranch: unexpectedWorkspaceCall,
    getHeadSha: unexpectedWorkspaceCall,
    getLocalStateFingerprint: unexpectedWorkspaceCall,
    getSharedGitRefsFingerprint: unexpectedWorkspaceCall,
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: unexpectedWorkspaceCall,
    getDiff: unexpectedWorkspaceCall,
    diffFiles: unexpectedWorkspaceCall,
    diffPatch: unexpectedWorkspaceCall,
    getPullRequest: unexpectedWorkspaceCall,
    runPullRequestAction: unexpectedWorkspaceCall,
    listFiles: unexpectedWorkspaceCall,
    commit: unexpectedWorkspaceCall,
    reset: unexpectedWorkspaceCall,
    destroy: vi.fn(async () => undefined),
  };
}

interface FakeDispatchRuntime extends AgentRuntime {
  setActiveTurn: (threadId: string, turnId: string) => void;
  setIdle: (threadId: string) => void;
}

function createRuntime(): FakeDispatchRuntime {
  const activeTurnsByThreadId = new Map<string, string>();
  const hostedThreadIds = new Set<string>();
  return {
    ensureProvider: vi.fn(async () => undefined),
    startThread: vi.fn(async (args: { threadId: string }) => {
      hostedThreadIds.add(args.threadId);
      return { providerThreadId: "provider-thread-1" };
    }),
    prepareThreadRewind: vi.fn(async () => ({
      providerThreadId: "provider-thread-rewind-1",
    })),
    discardThreadRewind: vi.fn(async () => undefined),
    resumeThread: vi.fn(async (args: { threadId: string }) => {
      hostedThreadIds.add(args.threadId);
      return { providerThreadId: "provider-thread-1" };
    }),
    runTurn: vi.fn(async () => undefined),
    steerTurn: vi.fn(async () => ({ status: "steered" as const })),
    stopThread: vi.fn(async (args: { threadId: string }) => {
      activeTurnsByThreadId.delete(args.threadId);
      hostedThreadIds.delete(args.threadId);
      return { providerCheckpointId: null };
    }),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async () => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async () => ({
      models: [],
      selectedOnlyModels: [],
    })),
    providerHealth: vi.fn(async () => ({ supported: false as const })),
    providerUsage: vi.fn(async () => ({ supported: false as const })),
    providerInstallationStatus: vi.fn(async () => {
      throw new Error("Unexpected provider installation status call");
    }),
    providerInstallationRun: vi.fn(async () => {
      throw new Error("Unexpected provider installation run call");
    }),
    listRunningProviders: vi.fn(() => ["fake"]),
    getActiveTurnId: (threadId) => activeTurnsByThreadId.get(threadId) ?? null,
    waitForActiveTurn: vi.fn(
      async (threadId: string) => activeTurnsByThreadId.get(threadId) ?? null,
    ),
    getProviderSession: (threadId) =>
      hostedThreadIds.has(threadId)
        ? { providerId: "fake", providerThreadId: "provider-thread-1" }
        : null,
    reapIdleProviderSessions: vi.fn(async () => ({ reapedSessions: [] })),
    hasThread: (threadId) => hostedThreadIds.has(threadId),
    getLiveThreadIds: vi.fn(() => [...activeTurnsByThreadId.keys()]),
    hasOpenBackgroundWork: () => false,
    shutdown: vi.fn(async () => undefined),
    setActiveTurn: (threadId, turnId) => {
      hostedThreadIds.add(threadId);
      activeTurnsByThreadId.set(threadId, turnId);
    },
    setIdle: (threadId: string) => {
      hostedThreadIds.add(threadId);
      activeTurnsByThreadId.delete(threadId);
    },
  };
}

function createTurnSubmitCommand(
  target: CommandOf<"turn.submit">["target"],
): CommandOf<"turn.submit"> {
  return {
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    type: "turn.submit",
    environmentId: "env-1",
    threadId: "thread-1",
    requestId: "creq_turn_submit",
    input: [{ type: "text", text: "follow up", mentions: [] }],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    resumeContext: {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    },
    target,
  };
}

function createProviderCliInstallEventStream(
  events: readonly ProviderCliInstallEvent[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
}

function claudeCodeStatus(args: {
  currentVersion: string;
  latestVersion: string | null;
}): ProviderCliStatus {
  return {
    displayName: "Claude Code",
    executableName: "claude",
    executablePath: "/Users/me/.local/bin/claude",
    installed: true,
    installSource: "external",
    currentVersion: args.currentVersion,
    latestVersion: args.latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: "@anthropic-ai/claude-code",
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "update",
      label: "Update",
      command: "claude update",
    },
    needsUpdate:
      args.latestVersion === null || args.currentVersion !== args.latestVersion,
    versionUnsupported: false,
  };
}

function supportedCodexInstallationStatus(): ProviderCliStatus {
  return {
    displayName: "Codex",
    executableName: "codex",
    executablePath: "/usr/local/bin/codex",
    installed: true,
    installSource: "npmGlobal",
    currentVersion: "0.146.0",
    latestVersion: null,
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: "0.146.0",
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
  };
}

function createInstallationGatedThreadStart(
  threadId: string,
  environmentId = "env-1",
): CommandOf<"thread.start"> {
  return {
    bridgeLaunch: {
      ...DISPATCH_TEST_BRIDGE_LAUNCH,
      capabilities: {
        ...DISPATCH_TEST_BRIDGE_LAUNCH.capabilities,
        providerInstallation: true,
      },
    },
    type: "thread.start",
    environmentId,
    threadId,
    workspaceContext: {
      workspacePath: WORKSPACE_PATH,
      workspaceProvisionType: "unmanaged",
    },
    projectId: "proj_1",
    providerId: "codex",
    requestId: `creq_${threadId}`,
    input: [{ type: "text", text: "hello", mentions: [] }],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    instructions: "Be concise.",
    dynamicTools: [],
    contributedEnv: [],
    injectedSkillSources: [],
    instructionMode: "append",
  };
}

async function runSuccessfulClaudeCodeUpdateVerification(args: {
  before: ProviderCliStatus;
  after: ProviderCliStatus;
}) {
  const dataDir = await makeTempDir("bb-command-dispatch-provider-cli-");
  const manager = new RuntimeManager({
    dataDir,
    createRuntime,
    provisionWorkspace: async () => createWorkspace(),
  });
  const providerInstallationStatus = vi.fn().mockResolvedValueOnce(args.after);
  const events: ProviderCliInstallEvent[] = [
    {
      type: "started",
      provider: "claude-code",
      command: "claude update",
    },
    {
      type: "completed",
      provider: "claude-code",
      exitCode: 0,
      signal: null,
      success: true,
    },
  ];
  const result = await dispatchOnlineRpcCommand(
    {
      type: "provider.installation.run",
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      providerId: "claude-code",
      action: "update",
    },
    {
      dataDir,
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      providerInstallationStatus,
      providerInstallationRun: async () => ({
        available: true,
        command: {
          command: "claude",
          args: ["update"],
          displayCommand: "claude update",
        },
        verification:
          args.before.latestVersion === null
            ? {
                kind: "version_changed",
                previousVersion: args.before.currentVersion ?? "unknown",
              }
            : {
                kind: "version_at_least",
                version: args.before.latestVersion,
              },
      }),
      runtimeManager: manager,
      streamProviderInstallation: () =>
        createProviderCliInstallEventStream(events),
      threadStorageRootPath: "/tmp/bb-thread-storage",
    },
  );
  return { events, providerInstallationStatus, result };
}

describe("dispatchCommand", () => {
  it("steers an auto submit when the active turn appears after the server snapshot", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");
    vi.mocked(runtime.getLiveThreadIds).mockReturnValueOnce(["thread-1"]);
    vi.mocked(runtime.waitForActiveTurn).mockImplementationOnce(
      async (threadId) => {
        runtime.setActiveTurn(threadId, "turn-starting");
        return "turn-starting";
      },
    );

    const result = await dispatchCommand(
      createTurnSubmitCommand({ mode: "auto", expectedTurnId: null }),
      {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ appliedAs: "steer" });
    expect(runtime.waitForActiveTurn).toHaveBeenCalledWith("thread-1", {
      timeoutMs: 5_000,
    });
    expect(runtime.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "creq_turn_submit",
        expectedTurnId: "turn-starting",
        threadId: "thread-1",
      }),
    );
    expect(runtime.runTurn).not.toHaveBeenCalled();
  });

  it("rebases auto input onto the daemon's newer active turn", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-new");

    const result = await dispatchCommand(
      createTurnSubmitCommand({
        mode: "auto",
        expectedTurnId: "turn-old",
      }),
      {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ appliedAs: "steer" });
    expect(runtime.steerTurn).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTurnId: "turn-new" }),
    );
    expect(runtime.runTurn).not.toHaveBeenCalled();
  });

  it("starts auto input immediately when the prior turn already completed", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");

    const result = await dispatchCommand(
      createTurnSubmitCommand({ mode: "auto", expectedTurnId: null }),
      {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(runtime.waitForActiveTurn).not.toHaveBeenCalled();
    expect(runtime.runTurn).toHaveBeenCalledOnce();
  });

  it("rejects auto input when a pending turn still has no id after the wait", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");
    vi.mocked(runtime.getLiveThreadIds).mockReturnValue(["thread-1"]);
    vi.mocked(runtime.waitForActiveTurn).mockResolvedValueOnce(null);

    await expect(
      dispatchCommand(
        createTurnSubmitCommand({ mode: "auto", expectedTurnId: null }),
        {
          dataDir: "/tmp/bb-data",
          logger: silentLogger,
          eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          ...unexpectedProviderMaintenance,
          runtimeManager: manager,
          threadStorageRootPath: "/tmp/bb-thread-storage",
        },
      ),
    ).rejects.toThrow(
      "Refusing to start a competing turn while thread-1 is still starting",
    );
    expect(runtime.runTurn).not.toHaveBeenCalled();
    expect(runtime.steerTurn).not.toHaveBeenCalled();
  });

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
    runtime.setActiveTurn("thread-1", "turn-1");

    const flushDeferred = createDeferredPromise<void>();
    const flush = vi.fn(async () => flushDeferred.promise);
    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      intent: "interrupt",
      environmentId: "env-1",
      threadId: "thread-1",
    };
    let resolved = false;
    const dispatchPromise = dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush,
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    }).then((result) => {
      resolved = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(flush).toHaveBeenCalledTimes(1);
    });
    expect(resolved).toBe(false);

    flushDeferred.resolve(undefined);
    await expect(dispatchPromise).resolves.toEqual({
      providerCheckpointId: null,
    });

    expect(resolved).toBe(true);
    expect(runtime.hasThread("thread-1")).toBe(false);
  });

  it("cancels Plan through the active provider runtime before flushing events", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-1");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
      },
      {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: true });
    expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("does not cancel Plan after its turn has already ended", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setIdle("thread-1");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-plan-1",
      },
      {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: false });
    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not cancel a newer turn when the Plan cancellation is stale", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: WORKSPACE_PATH,
    });
    runtime.setActiveTurn("thread-1", "turn-newer-2");
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(
      {
        type: "thread.plan.cancel",
        environmentId: "env-1",
        threadId: "thread-1",
        expectedTurnId: "turn-plan-1",
      },
      {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(result).toEqual({ cancelled: false });
    expect(runtime.getActiveTurnId("thread-1")).toBe("turn-newer-2");
    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("resumes a reaped Codex runtime before clearing its Goal", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const flush = vi.fn(async () => undefined);
    const command: CommandOf<"thread.goal.clear"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.goal.clear",
      environmentId: "env-1",
      threadId: "thread-1",
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: WORKSPACE_PATH,
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj-1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ cleared: true });
    expect(runtime.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        threadId: "thread-1",
      }),
    );
    expect(runtime.clearThreadGoal).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("releases a moved thread from its old environment before resuming it", async () => {
    const oldRuntime = createRuntime();
    const newRuntime = createRuntime();
    const createRuntimeSpy = vi
      .fn<() => AgentRuntime>()
      .mockReturnValueOnce(oldRuntime)
      .mockReturnValueOnce(newRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      provisionWorkspace: async (args) =>
        createWorkspace("path" in args ? args.path : args.targetPath),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/bb-command-dispatch-old",
    });
    oldRuntime.setIdle("thread-1");

    const command: CommandOf<"turn.submit"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "turn.submit",
      environmentId: "env-new",
      threadId: "thread-1",
      requestId: "creq_moved_thread",
      input: [{ type: "text", text: "follow up", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: "/tmp/bb-command-dispatch-new",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
      target: { mode: "start" },
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(createRuntimeSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspacePath: "/tmp/bb-command-dispatch-new",
      }),
    );
    expect(newRuntime.resumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        providerThreadId: "provider-thread-1",
        threadId: "thread-1",
      }),
    );
    expect(
      (oldRuntime.stopThread as unknown as Mock).mock.invocationCallOrder[0],
    ).toBeLessThan(
      (newRuntime.resumeThread as unknown as Mock).mock.invocationCallOrder[0],
    );
  });

  it("stops the old owner when the moved thread has no runtime yet", async () => {
    const oldRuntime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => oldRuntime,
      provisionWorkspace: async () => createWorkspace("/tmp/bb-stop-old"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/bb-stop-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");
    (oldRuntime.stopThread as Mock).mockResolvedValueOnce({
      providerCheckpointId: "pi-entry-at-stop",
    });

    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      intent: "interrupt",
      environmentId: "env-new",
      threadId: "thread-1",
    };
    const flush = vi.fn(async () => undefined);

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ providerCheckpointId: "pi-entry-at-stop" });
    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
    expect(flush).toHaveBeenCalledOnce();
  });

  it("releases an idle runtime without the active-turn wait", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace("/tmp/bb-release"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-release",
      workspacePath: "/tmp/bb-release",
    });
    runtime.setIdle("thread-1");

    const options = {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    };

    await dispatchCommand(
      {
        type: "thread.stop",
        intent: "release",
        environmentId: "env-release",
        threadId: "thread-1",
      },
      options,
    );
    expect(runtime.waitForActiveTurn).not.toHaveBeenCalled();
    expect(runtime.stopThread).toHaveBeenCalledWith({ threadId: "thread-1" });

    runtime.setIdle("thread-1");
    await dispatchCommand(
      {
        type: "thread.stop",
        intent: "interrupt",
        environmentId: "env-release",
        threadId: "thread-1",
      },
      options,
    );
    expect(runtime.waitForActiveTurn).toHaveBeenCalledWith("thread-1", {
      timeoutMs: expect.any(Number),
    });
  });

  it("skips a release when a turn started after the server read the thread", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace("/tmp/bb-release-race"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-release-race",
      workspacePath: "/tmp/bb-release-race",
    });
    runtime.setActiveTurn("thread-1", "turn-new");

    const result = await dispatchCommand(
      {
        type: "thread.stop",
        intent: "release",
        environmentId: "env-release-race",
        threadId: "thread-1",
      },
      {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(runtime.stopThread).not.toHaveBeenCalled();
    expect(runtime.getActiveTurnId("thread-1")).toBe("turn-new");
    expect(result).toEqual({ providerCheckpointId: null });
  });

  it("treats thread.stop as successful when no runtime holds the thread", async () => {
    const manager = new RuntimeManager({
      createRuntime: () => createRuntime(),
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.stop"> = {
      type: "thread.stop",
      intent: "interrupt",
      environmentId: "env-missing-runtime",
      threadId: "thread-1",
    };

    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      }),
    ).resolves.toEqual({ providerCheckpointId: null });
  });

  it("cancels a plan in the environment the thread moved away from", async () => {
    const oldRuntime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => oldRuntime,
      provisionWorkspace: async () => createWorkspace("/tmp/bb-plan-old"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/bb-plan-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const command: CommandOf<"thread.plan.cancel"> = {
      type: "thread.plan.cancel",
      environmentId: "env-new",
      threadId: "thread-1",
      expectedTurnId: "turn-old",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ cancelled: true });
    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
  });

  it("leaves a plan alone when no runtime runs the expected turn", async () => {
    const oldRuntime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => oldRuntime,
      provisionWorkspace: async () => createWorkspace("/tmp/bb-plan-old"),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/bb-plan-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-other");

    const command: CommandOf<"thread.plan.cancel"> = {
      type: "thread.plan.cancel",
      environmentId: "env-new",
      threadId: "thread-1",
      expectedTurnId: "turn-old",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ cancelled: false });
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
  });

  it("keeps an old-environment turn alive through a rename", async () => {
    const oldRuntime = createRuntime();
    const newRuntime = createRuntime();
    const createRuntimeSpy = vi
      .fn<() => AgentRuntime>()
      .mockReturnValueOnce(oldRuntime)
      .mockReturnValueOnce(newRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      provisionWorkspace: async (args) =>
        createWorkspace("path" in args ? args.path : args.targetPath),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/bb-rename-old",
    });
    await manager.ensureEnvironment({
      environmentId: "env-new",
      workspacePath: "/tmp/bb-rename-new",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const command: CommandOf<"thread.rename"> = {
      type: "thread.rename",
      environmentId: "env-new",
      threadId: "thread-1",
      title: "Renamed",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({});
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
    expect(oldRuntime.getActiveTurnId("thread-1")).toBe("turn-old");
    expect(newRuntime.renameThread).toHaveBeenCalledWith({
      threadId: "thread-1",
      title: "Renamed",
    });
  });

  it("refuses a goal clear while the old environment still runs the turn", async () => {
    const oldRuntime = createRuntime();
    const newRuntime = createRuntime();
    const createRuntimeSpy = vi
      .fn<() => AgentRuntime>()
      .mockReturnValueOnce(oldRuntime)
      .mockReturnValueOnce(newRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      provisionWorkspace: async (args) =>
        createWorkspace("path" in args ? args.path : args.targetPath),
    });
    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/bb-goal-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const command: CommandOf<"thread.goal.clear"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.goal.clear",
      environmentId: "env-new",
      threadId: "thread-1",
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: "/tmp/bb-goal-new",
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [],
        instructionMode: "append",
      },
    };

    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      }),
    ).rejects.toMatchObject({ code: "thread_busy_in_other_environment" });
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
    expect(newRuntime.clearThreadGoal).not.toHaveBeenCalled();
  });

  it("treats thread.rename as best-effort when the runtime is not loaded", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.rename"> = {
      type: "thread.rename",
      environmentId: "env-missing-runtime",
      threadId: "thread-1",
      title: "Renamed",
    };

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({});
    expect(runtime.renameThread).not.toHaveBeenCalled();
  });

  it("blocks any installation-managed provider whose bridge reports an unsupported version", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.start"> = {
      bridgeLaunch: {
        ...DISPATCH_TEST_BRIDGE_LAUNCH,
        capabilities: {
          ...DISPATCH_TEST_BRIDGE_LAUNCH.capabilities,
          providerInstallation: true,
        },
      },
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "example-agent",
      requestId: "creq_unsupported_provider",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };

    const unsupportedCodexStatus: ProviderCliStatus = {
      displayName: "Example Agent",
      executableName: "example-agent",
      executablePath: "/usr/local/bin/example-agent",
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "0.135.0",
      latestVersion: null,
      minimumSupportedVersion: "0.136.0",
      npmPackageName: "example-agent",
      npmGlobalPackageVersion: "0.135.0",
      installAction: {
        kind: "update",
        label: "Update",
        command: "example-agent update",
      },
      needsUpdate: false,
      versionUnsupported: true,
    };

    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: {
          emit: vi.fn(),
          flush: vi.fn(async () => undefined),
        },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        providerInstallationStatus: async () => unsupportedCodexStatus,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      }),
    ).rejects.toMatchObject({
      code: "provider_cli_unsupported_version",
    });

    expect(runtime.startThread).not.toHaveBeenCalled();
  });

  it("skips version checks when the provider declaration does not support installation", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.start"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "codex",
      requestId: "creq_unmanaged_provider",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "claude-sonnet-4-6",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };
    const providerInstallationStatus = vi.fn(async () => {
      throw new Error("Provider installation status should not be checked");
    });

    const result = await dispatchCommand(command, {
      dataDir: "/tmp/bb-data",
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      providerInstallationStatus,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ providerThreadId: "provider-thread-1" });
    expect(providerInstallationStatus).not.toHaveBeenCalled();
    expect(runtime.startThread).toHaveBeenCalledOnce();
  });

  it("prepares a Codex rewind through the requested retained turn", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const command: CommandOf<"thread.rewind.prepare"> = {
      bridgeLaunch: {
        ...DISPATCH_TEST_BRIDGE_LAUNCH,
        capabilities: {
          ...DISPATCH_TEST_BRIDGE_LAUNCH.capabilities,
          providerInstallation: true,
        },
      },
      type: "thread.rewind.prepare",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "codex",
      leaseId: "lease-1",
      sourceProviderThreadId: "provider-source-1",
      retainThroughProviderCheckpoint: "turn-before-edit",
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    };
    const supportedCodexStatus: ProviderCliStatus = {
      displayName: "Codex",
      executableName: "codex",
      executablePath: "/usr/local/bin/codex",
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "0.146.0",
      latestVersion: null,
      minimumSupportedVersion: "0.136.0",
      npmPackageName: "@openai/codex",
      npmGlobalPackageVersion: "0.146.0",
      installAction: null,
      needsUpdate: false,
      versionUnsupported: false,
    };

    const providerInstallationStatus = vi.fn(async () => supportedCodexStatus);
    await expect(
      dispatchCommand(command, {
        dataDir: "/tmp/bb-data",
        logger: silentLogger,
        eventSink: {
          emit: vi.fn(),
          flush: vi.fn(async () => undefined),
        },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        providerInstallationStatus,
        runtimeManager: manager,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      }),
    ).resolves.toEqual({ providerThreadId: "provider-thread-rewind-1" });
    expect(providerInstallationStatus).toHaveBeenCalledWith(
      expect.objectContaining({ requirement: "thread_rewind" }),
    );
    expect(runtime.prepareThreadRewind).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: "lease-1",
        sourceProviderThreadId: "provider-source-1",
        retainThroughProviderCheckpoint: "turn-before-edit",
        threadId: "thread-1",
      }),
    );
    await manager.invalidateProviderMaintenanceRuntime();
    await expect(
      dispatchCommand(
        { ...command, leaseId: "lease-old-codex" },
        {
          dataDir: "/tmp/bb-data",
          logger: silentLogger,
          eventSink: {
            emit: vi.fn(),
            flush: vi.fn(async () => undefined),
          },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          fetchPluginHostArtifact: fetchDispatchTestArtifact,
          ...unexpectedProviderMaintenance,
          providerInstallationStatus: async () => ({
            ...supportedCodexStatus,
            currentVersion: "0.140.0",
            minimumSupportedVersion: "0.143.0",
            npmGlobalPackageVersion: "0.140.0",
            versionUnsupported: true,
          }),
          runtimeManager: manager,
          threadStorageRootPath: "/tmp/bb-thread-storage",
        },
      ),
    ).rejects.toMatchObject({ code: "provider_cli_unsupported_version" });
    expect(runtime.prepareThreadRewind).toHaveBeenCalledOnce();

    await expect(
      dispatchCommand(
        {
          type: "thread.rewind.discard",
          environmentId: "env-1",
          threadId: "thread-1",
          leaseId: "lease-1",
        },
        {
          dataDir: "/tmp/bb-data",
          logger: silentLogger,
          eventSink: {
            emit: vi.fn(),
            flush: vi.fn(async () => undefined),
          },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          fetchPluginHostArtifact: fetchDispatchTestArtifact,
          ...unexpectedProviderMaintenance,
          runtimeManager: manager,
          threadStorageRootPath: "/tmp/bb-thread-storage",
        },
      ),
    ).resolves.toEqual({});
    expect(runtime.discardThreadRewind).toHaveBeenCalledWith({
      leaseId: "lease-1",
    });
  });

  it("reuses a supported installation probe across thread starts", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi.fn(async () =>
      supportedCodexInstallationStatus(),
    );
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });
    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-2"), options),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });

    expect(providerInstallationStatus).toHaveBeenCalledOnce();
    expect(runtime.startThread).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe between concurrent thread starts", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const probe = createDeferredPromise<ProviderCliStatus>();
    const providerInstallationStatus = vi.fn(() => probe.promise);
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    const starts = Promise.all([
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
      dispatchCommand(createInstallationGatedThreadStart("thread-2"), options),
    ]);
    await vi.waitFor(() =>
      expect(providerInstallationStatus).toHaveBeenCalledOnce(),
    );
    probe.resolve(supportedCodexInstallationStatus());

    await expect(starts).resolves.toEqual([
      { providerThreadId: "provider-thread-1" },
      { providerThreadId: "provider-thread-1" },
    ]);
    expect(providerInstallationStatus).toHaveBeenCalledOnce();
    expect(runtime.startThread).toHaveBeenCalledTimes(2);
  });

  it("retries concurrent thread starts when a shell env refresh interrupts their shared probe", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
      shellEnv: { PATH: "/old/bin" },
    });
    const staleProbe = createDeferredPromise<ProviderCliStatus>();
    const providerInstallationStatus = vi
      .fn<() => Promise<ProviderCliStatus>>()
      .mockReturnValueOnce(staleProbe.promise)
      .mockResolvedValueOnce(supportedCodexInstallationStatus());
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    const starts = Promise.all([
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
      dispatchCommand(createInstallationGatedThreadStart("thread-2"), options),
    ]);
    await vi.waitFor(() =>
      expect(providerInstallationStatus).toHaveBeenCalledOnce(),
    );

    await manager.replaceBaseShellEnv({ PATH: "/new/bin" });
    staleProbe.reject(new Error("Runtime shutting down"));

    await expect(starts).resolves.toEqual([
      { providerThreadId: "provider-thread-1" },
      { providerThreadId: "provider-thread-1" },
    ]);
    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(runtime.startThread).toHaveBeenCalledTimes(2);
  });

  it("does not remember an unsupported installation", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi
      .fn<() => Promise<ProviderCliStatus>>()
      .mockResolvedValueOnce({
        ...supportedCodexInstallationStatus(),
        currentVersion: "0.135.0",
        npmGlobalPackageVersion: "0.135.0",
        versionUnsupported: true,
      })
      .mockResolvedValue(supportedCodexInstallationStatus());
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
    ).rejects.toMatchObject({ code: "provider_cli_unsupported_version" });
    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });

    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(runtime.startThread).toHaveBeenCalledOnce();
  });

  it("keys the rewind requirement separately from thread start", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi.fn(async () =>
      supportedCodexInstallationStatus(),
    );
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });
    const start = createInstallationGatedThreadStart("thread-1");
    const rewind: CommandOf<"thread.rewind.prepare"> = {
      bridgeLaunch: start.bridgeLaunch,
      type: "thread.rewind.prepare",
      environmentId: start.environmentId,
      threadId: start.threadId,
      workspaceContext: start.workspaceContext,
      projectId: start.projectId,
      providerId: start.providerId,
      leaseId: "lease-1",
      sourceProviderThreadId: "provider-source-1",
      retainThroughProviderCheckpoint: "turn-before-edit",
      options: start.options,
      instructions: start.instructions,
      dynamicTools: start.dynamicTools,
      contributedEnv: [],
      injectedSkillSources: start.injectedSkillSources,
      instructionMode: start.instructionMode,
    };

    await dispatchCommand(start, options);
    await expect(dispatchCommand(rewind, options)).resolves.toEqual({
      providerThreadId: "provider-thread-rewind-1",
    });

    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(providerInstallationStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ requirement: "thread_rewind" }),
    );
  });

  it("re-probes and launches with the new PATH when the shell env refresh finds a change", async () => {
    const oldPath = "/usr/bin:/bin";
    const newPath = "/home/u/.local/bin:/usr/bin:/bin";
    const runtime = createRuntime();
    const createdRuntimeShellPaths: (string | undefined)[] = [];
    const manager = new RuntimeManager({
      createRuntime: (runtimeOptions) => {
        createdRuntimeShellPaths.push(runtimeOptions.shellEnv?.PATH);
        return runtime;
      },
      provisionWorkspace: async () => createWorkspace(),
      shellEnv: { PATH: oldPath },
    });
    let loginShellPath = oldPath;
    const refreshShellEnv = vi.fn(async () => {
      await manager.replaceBaseShellEnv({ PATH: loginShellPath });
    });
    const providerInstallationStatus = vi.fn(async () =>
      supportedCodexInstallationStatus(),
    );
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
      refreshShellEnv,
    });

    await dispatchCommand(
      createInstallationGatedThreadStart("thread-1"),
      options,
    );
    await dispatchCommand(
      createInstallationGatedThreadStart("thread-2"),
      options,
    );
    expect(providerInstallationStatus).toHaveBeenCalledOnce();

    loginShellPath = newPath;
    await dispatchCommand(
      createInstallationGatedThreadStart("thread-3", "env-2"),
      options,
    );

    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(manager.getShellEnv().PATH).toBe(newPath);
    expect(createdRuntimeShellPaths).toEqual([oldPath, newPath]);
    expect(refreshShellEnv).toHaveBeenCalledTimes(3);
  });

  it("remembers the first probe after a shell env change", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
      shellEnv: { PATH: "/old/bin" },
    });
    const refreshShellEnv = async () => {
      await manager.replaceBaseShellEnv({ PATH: "/new/bin" });
    };
    const providerInstallationStatus = vi.fn(async () => {
      await refreshShellEnv();
      return supportedCodexInstallationStatus();
    });
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
      refreshShellEnv,
    });

    await dispatchCommand(
      createInstallationGatedThreadStart("thread-1"),
      options,
    );
    await dispatchCommand(
      createInstallationGatedThreadStart("thread-2"),
      options,
    );

    expect(manager.getShellEnv().PATH).toBe("/new/bin");
    expect(providerInstallationStatus).toHaveBeenCalledOnce();
  });

  it("does not remember a not-installed provider that enforces a minimum version", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi
      .fn<() => Promise<ProviderCliStatus>>()
      .mockResolvedValueOnce({
        ...supportedCodexInstallationStatus(),
        installed: false,
        executablePath: null,
        currentVersion: null,
        npmGlobalPackageVersion: null,
        installAction: {
          kind: "install",
          label: "Install",
          command: "npm i -g @openai/codex",
        },
      })
      .mockResolvedValueOnce({
        ...supportedCodexInstallationStatus(),
        currentVersion: "0.135.0",
        npmGlobalPackageVersion: "0.135.0",
        versionUnsupported: true,
      });
    const options = makeDispatchOptions({
      runtimeManager: manager,
      providerInstallationStatus,
    });

    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-1"), options),
    ).resolves.toEqual({ providerThreadId: "provider-thread-1" });
    await expect(
      dispatchCommand(createInstallationGatedThreadStart("thread-2"), options),
    ).rejects.toMatchObject({ code: "provider_cli_unsupported_version" });

    expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    expect(runtime.startThread).toHaveBeenCalledOnce();
  });

  it("expires the remembered probe after the gate TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const runtime = createRuntime();
      const manager = new RuntimeManager({
        createRuntime: () => runtime,
        provisionWorkspace: async () => createWorkspace(),
        providerInstallationGateTtlMs: 100,
      });
      const providerInstallationStatus = vi.fn(async () =>
        supportedCodexInstallationStatus(),
      );
      const options = makeDispatchOptions({
        runtimeManager: manager,
        providerInstallationStatus,
      });

      const probedAt = Date.now();
      await dispatchCommand(
        createInstallationGatedThreadStart("thread-1"),
        options,
      );
      vi.setSystemTime(probedAt + 101);
      await dispatchCommand(
        createInstallationGatedThreadStart("thread-2"),
        options,
      );

      expect(providerInstallationStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates the provider maintenance runtime after a verified provider update", async () => {
    const dataDir = await makeTempDir("bb-command-dispatch-provider-cli-");
    const staleRuntime = createRuntime();
    const freshRuntime = createRuntime();
    const createRuntimeSpy = vi.fn(() => staleRuntime);
    createRuntimeSpy.mockReturnValueOnce(staleRuntime);
    createRuntimeSpy.mockReturnValueOnce(freshRuntime);
    const manager = new RuntimeManager({
      createRuntime: createRuntimeSpy,
      dataDir,
      provisionWorkspace: async () => createWorkspace(),
    });
    await manager.ensureProviderMaintenanceRuntime({ dataDir });

    const events: ProviderCliInstallEvent[] = [
      {
        type: "started",
        provider: "codex",
        command: "codex update",
      },
      {
        type: "completed",
        provider: "codex",
        exitCode: 0,
        signal: null,
        success: true,
      },
    ];
    const streamProviderInstallation = vi.fn(() =>
      createProviderCliInstallEventStream(events),
    );
    const command: CommandOf<"provider.installation.run"> = {
      type: "provider.installation.run",
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      providerId: "codex",
      action: "update",
    };

    const result = await dispatchOnlineRpcCommand(command, {
      dataDir,
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: manager,
      providerInstallationRun: async () => ({
        available: true,
        command: {
          command: "codex",
          args: ["update"],
          displayCommand: "codex update",
        },
        verification: { kind: "version_changed", previousVersion: "0.1.0" },
      }),
      providerInstallationStatus: async () => ({
        executableName: "codex",
        executablePath: "/usr/local/bin/codex",
        installed: true,
        installSource: "external",
        currentVersion: "0.2.0",
        latestVersion: "0.2.0",
        minimumSupportedVersion: null,
        npmPackageName: null,
        npmGlobalPackageVersion: null,
        installAction: null,
        needsUpdate: false,
        versionUnsupported: false,
      }),
      streamProviderInstallation,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ events });
    expect(streamProviderInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        plan: {
          command: "codex",
          args: ["update"],
          displayCommand: "codex update",
        },
      }),
    );
    expect(staleRuntime.shutdown).toHaveBeenCalledOnce();

    await manager.ensureProviderMaintenanceRuntime({ dataDir });
    expect(createRuntimeSpy).toHaveBeenCalledTimes(2);
    expect(freshRuntime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps the provider maintenance runtime after a failed provider update", async () => {
    const cases: Array<{
      action: CommandOf<"provider.installation.run">["action"];
      events: ProviderCliInstallEvent[];
      provider: CommandOf<"provider.installation.run">["providerId"];
    }> = [
      {
        action: "update",
        provider: "codex",
        events: [
          {
            type: "completed",
            provider: "codex",
            exitCode: 1,
            signal: null,
            success: false,
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const dataDir = await makeTempDir("bb-command-dispatch-provider-cli-");
      const runtime = createRuntime();
      const createRuntimeSpy = vi.fn(() => runtime);
      const manager = new RuntimeManager({
        createRuntime: createRuntimeSpy,
        dataDir,
        provisionWorkspace: async () => createWorkspace(),
      });
      await manager.ensureProviderMaintenanceRuntime({ dataDir });
      const streamProviderInstallation = vi.fn(() =>
        createProviderCliInstallEventStream(testCase.events),
      );
      const result = await dispatchOnlineRpcCommand(
        {
          type: "provider.installation.run",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
          providerId: testCase.provider,
          action: testCase.action,
        },
        {
          dataDir,
          logger: silentLogger,
          eventSink: {
            emit: vi.fn(),
            flush: vi.fn(async () => undefined),
          },
          fetchProjectAttachment: async () => {
            throw new Error("Unexpected project attachment fetch");
          },
          fetchPluginHostArtifact: fetchDispatchTestArtifact,
          ...unexpectedProviderMaintenance,
          providerInstallationRun: async () => ({
            available: true,
            command: {
              command: testCase.provider,
              args: [testCase.action],
              displayCommand: `${testCase.provider} ${testCase.action}`,
            },
            verification: {
              kind: "version_changed",
              previousVersion: "2.1.220",
            },
          }),
          runtimeManager: manager,
          streamProviderInstallation,
          threadStorageRootPath: "/tmp/bb-thread-storage",
        },
      );

      expect(result).toEqual({ events: testCase.events });
      expect(runtime.shutdown).not.toHaveBeenCalled();
      await expect(
        manager.ensureProviderMaintenanceRuntime({ dataDir }),
      ).resolves.toBe(runtime);
      expect(createRuntimeSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a successful Claude update command as failed when the active executable stays old", async () => {
    const dataDir = await makeTempDir("bb-command-dispatch-provider-cli-");
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      dataDir,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi.fn().mockResolvedValueOnce(
      claudeCodeStatus({
        currentVersion: "2.1.220",
        latestVersion: "2.1.227",
      }),
    );

    const result = await dispatchOnlineRpcCommand(
      {
        type: "provider.installation.run",
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        providerId: "claude-code",
        action: "update",
      },
      {
        dataDir,
        logger: silentLogger,
        eventSink: {
          emit: vi.fn(),
          flush: vi.fn(async () => undefined),
        },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        providerInstallationStatus,
        providerInstallationRun: async () => ({
          available: true,
          command: {
            command: "claude",
            args: ["update"],
            displayCommand: "claude update",
          },
          verification: { kind: "version_at_least", version: "2.1.227" },
        }),
        runtimeManager: manager,
        streamProviderInstallation: () =>
          createProviderCliInstallEventStream([
            {
              type: "started",
              provider: "claude-code",
              command: "claude update",
            },
            {
              type: "output",
              provider: "claude-code",
              stream: "stdout",
              text: "Successfully updated from 2.1.220 to version 2.1.227\n",
            },
            {
              type: "completed",
              provider: "claude-code",
              exitCode: 0,
              signal: null,
              success: true,
            },
          ]),
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(providerInstallationStatus).toHaveBeenCalledOnce();
    expect(result.events).toEqual([
      expect.objectContaining({ type: "started" }),
      expect.objectContaining({ type: "output" }),
      expect.objectContaining({
        type: "error",
        provider: "claude-code",
        message: expect.stringContaining(
          "could not verify the installed result",
        ),
      }),
      {
        type: "completed",
        provider: "claude-code",
        exitCode: 0,
        signal: null,
        success: false,
      },
    ]);
  });

  it("does not spawn when the provider withdraws a stale installation action", async () => {
    const dataDir = await makeTempDir("bb-command-dispatch-provider-cli-");
    const manager = new RuntimeManager({
      createRuntime,
      dataDir,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerInstallationStatus = vi.fn();
    const streamProviderInstallation = vi.fn();

    const result = await dispatchOnlineRpcCommand(
      {
        type: "provider.installation.run",
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        providerId: "claude-code",
        action: "update",
      },
      {
        dataDir,
        logger: silentLogger,
        eventSink: {
          emit: vi.fn(),
          flush: vi.fn(async () => undefined),
        },
        fetchProjectAttachment: async () => {
          throw new Error("Unexpected project attachment fetch");
        },
        fetchPluginHostArtifact: fetchDispatchTestArtifact,
        ...unexpectedProviderMaintenance,
        providerInstallationStatus,
        providerInstallationRun: async () => ({
          available: false,
          message: "Claude Code update is no longer available on this host.",
        }),
        runtimeManager: manager,
        streamProviderInstallation,
        threadStorageRootPath: "/tmp/bb-thread-storage",
      },
    );

    expect(providerInstallationStatus).not.toHaveBeenCalled();
    expect(streamProviderInstallation).not.toHaveBeenCalled();
    expect(result.events).toEqual([
      {
        type: "error",
        provider: "claude-code",
        message: "Claude Code update is no longer available on this host.",
      },
    ]);
  });

  it("accepts a Claude update that advances when the release channel is unknown", async () => {
    const verification = await runSuccessfulClaudeCodeUpdateVerification({
      before: claudeCodeStatus({
        currentVersion: "2.1.69",
        latestVersion: null,
      }),
      after: claudeCodeStatus({
        currentVersion: "2.1.221",
        latestVersion: null,
      }),
    });

    expect(verification.providerInstallationStatus).toHaveBeenCalledOnce();
    expect(verification.result).toEqual({ events: verification.events });
  });

  it("rejects a Claude update that does not advance when the release channel is unknown", async () => {
    const verification = await runSuccessfulClaudeCodeUpdateVerification({
      before: claudeCodeStatus({
        currentVersion: "2.1.69",
        latestVersion: null,
      }),
      after: claudeCodeStatus({
        currentVersion: "2.1.69",
        latestVersion: null,
      }),
    });

    expect(verification.result.events).toEqual([
      expect.objectContaining({ type: "started" }),
      expect.objectContaining({
        type: "error",
        provider: "claude-code",
        message: expect.stringContaining(
          "could not verify the installed result",
        ),
      }),
      {
        type: "completed",
        provider: "claude-code",
        exitCode: 0,
        signal: null,
        success: false,
      },
    ]);
  });

  it("reuses a busy runtime when thread.start carries a changed skill catalog", async () => {
    const fixture = await setupBusySkillCatalogEnvironment({
      activeThreadId: "sibling-thread",
    });
    const command: CommandOf<"thread.start"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "thread.start",
      environmentId: "env-1",
      threadId: "thread-1",
      workspaceContext: {
        workspacePath: WORKSPACE_PATH,
        workspaceProvisionType: "unmanaged",
      },
      projectId: "proj_1",
      providerId: "codex",
      requestId: "creq_2345678923",
      input: [{ type: "text", text: "hello", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      instructions: "Be concise.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [fixture.source],
      instructionMode: "append",
    };

    const result = await dispatchCommand(command, {
      dataDir: fixture.dataDir,
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      providerInstallationStatus: async () =>
        supportedCodexInstallationStatus(),
      runtimeManager: fixture.manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result.providerThreadId).toBe("provider-thread-1");
    expect(fixture.runtime.startThread).toHaveBeenCalledTimes(1);
    expect(fixture.createRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.shutdown).not.toHaveBeenCalled();
    expect(fixture.manager.get("env-1")?.skillCatalogHash).toBe(
      fixture.originalCatalogHash,
    );
  });

  it("reuses a busy runtime when turn.submit carries a changed skill catalog", async () => {
    const fixture = await setupBusySkillCatalogEnvironment({
      activeThreadId: "thread-1",
    });
    const command: CommandOf<"turn.submit"> = {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      type: "turn.submit",
      environmentId: "env-1",
      threadId: "thread-1",
      requestId: "creq_2345678923",
      input: [{ type: "text", text: "follow up", mentions: [] }],
      options: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        providerOptions: {},
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
      },
      resumeContext: {
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        workspaceContext: {
          workspacePath: WORKSPACE_PATH,
          workspaceProvisionType: "unmanaged",
        },
        projectId: "proj_1",
        providerId: "codex",
        providerThreadId: "provider-thread-1",
        instructions: "Be concise.",
        dynamicTools: [],
        contributedEnv: [],
        injectedSkillSources: [fixture.source],
        instructionMode: "append",
      },
      target: { mode: "start" },
    };

    const result = await dispatchCommand(command, {
      dataDir: fixture.dataDir,
      logger: silentLogger,
      eventSink: {
        emit: vi.fn(),
        flush: vi.fn(async () => undefined),
      },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      runtimeManager: fixture.manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    });

    expect(result).toEqual({ appliedAs: "new-turn" });
    expect(fixture.runtime.runTurn).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.resumeThread).not.toHaveBeenCalled();
    expect(fixture.createRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.shutdown).not.toHaveBeenCalled();
    expect(fixture.manager.get("env-1")?.skillCatalogHash).toBe(
      fixture.originalCatalogHash,
    );
  });

  it("routes provider health and usage to the targeted bridge runtime", async () => {
    const runtime = createRuntime();
    const manager = new RuntimeManager({
      createRuntime: () => runtime,
      provisionWorkspace: async () => createWorkspace(),
    });
    const providerHealth = vi.fn(async () => ({ supported: false as const }));
    const providerUsage = vi.fn(async () => ({ supported: false as const }));
    const options = {
      dataDir: "/tmp/bb-test-data",
      logger: silentLogger,
      eventSink: { emit: vi.fn(), flush: vi.fn(async () => undefined) },
      fetchProjectAttachment: async () => {
        throw new Error("Unexpected project attachment fetch");
      },
      fetchPluginHostArtifact: fetchDispatchTestArtifact,
      ...unexpectedProviderMaintenance,
      providerHealth,
      providerUsage,
      runtimeManager: manager,
      threadStorageRootPath: "/tmp/bb-thread-storage",
    };

    await expect(
      dispatchOnlineRpcCommand(
        {
          type: "provider.health",
          providerId: "pi",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
          cwd: "/tmp/workspace",
        },
        options,
      ),
    ).resolves.toEqual({ supported: false });
    await expect(
      dispatchOnlineRpcCommand(
        {
          type: "provider.usage",
          providerId: "pi",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
        },
        options,
      ),
    ).resolves.toEqual({ supported: false });

    expect(providerHealth).toHaveBeenCalledWith({
      providerId: "pi",
      cwd: "/tmp/workspace",
      bridgeLaunch: dispatchTestRuntimeBridgeLaunch(options.dataDir),
    });
    expect(providerUsage).toHaveBeenCalledWith({
      providerId: "pi",
      bridgeLaunch: dispatchTestRuntimeBridgeLaunch(options.dataDir),
    });
  });
});
