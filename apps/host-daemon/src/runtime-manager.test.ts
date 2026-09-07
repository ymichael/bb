import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRuntime, AgentRuntimeOptions } from "@bb/agent-runtime";
import type { ThreadEvent } from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import type { HostWatcher } from "@bb/host-watcher";
import {
  provisionWorkspace,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import {
  createDeferredPromise,
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeManager,
  SkillCatalogConflictError,
} from "./runtime-manager.js";

type GetCurrentBranchArgs = Parameters<HostWorkspace["getCurrentBranch"]>;
type GetStatusResult = Awaited<ReturnType<HostWorkspace["getStatus"]>>;
type GetDiffResult = Awaited<ReturnType<HostWorkspace["getDiff"]>>;
type GetLocalStateFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getLocalStateFingerprint"]>
>;
type GetSharedGitRefsFingerprintResult = Awaited<
  ReturnType<HostWorkspace["getSharedGitRefsFingerprint"]>
>;
type CommitArgs = Parameters<HostWorkspace["commit"]>;
type ProvisionWorkspaceMockArgs = Parameters<
  (options: ProvisionWorkspaceArgs) => Promise<HostWorkspace>
>;
type EnsureProviderArgs = Parameters<AgentRuntime["ensureProvider"]>[0];
type StartThreadArgs = Parameters<AgentRuntime["startThread"]>[0];
type ResumeThreadArgs = Parameters<AgentRuntime["resumeThread"]>[0];
type RunTurnArgs = Parameters<AgentRuntime["runTurn"]>[0];
type SteerTurnArgs = Parameters<AgentRuntime["steerTurn"]>[0];
type StopThreadArgs = Parameters<AgentRuntime["stopThread"]>[0];
type RenameThreadArgs = Parameters<AgentRuntime["renameThread"]>[0];
type ListModelsArgs = Parameters<AgentRuntime["listModels"]>[0];
interface RunGitOptions {
  cwd: string;
}

interface WriteInjectedSkillSourceArgs {
  dataDir: string;
  name: string;
  token: string;
}

interface RuntimeOptionsRef {
  current: AgentRuntimeOptions | null;
}

interface RuntimeManagerProviderMaintenanceInternals {
  createProviderMaintenanceRuntime: (args: {
    dataDir: string;
  }) => Promise<AgentRuntime>;
  providerMaintenanceRuntime: AgentRuntime | null;
}

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runGit(
  args: readonly string[],
  options: RunGitOptions,
): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: options.cwd,
  });
  return result.stdout;
}

async function initRepo(): Promise<string> {
  const repoPath = await makeTempDir("bb-runtime-manager-repo-");
  await runGit(["init", "-b", "main"], { cwd: repoPath });
  await runGit(["config", "user.name", "BB Tests"], { cwd: repoPath });
  await runGit(["config", "user.email", "bb@example.com"], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, "README.md"), "hello\n", "utf8");
  await runGit(["add", "."], { cwd: repoPath });
  await runGit(["commit", "-m", "Initial commit"], { cwd: repoPath });
  return repoPath;
}

async function writeInjectedSkillSource(
  args: WriteInjectedSkillSourceArgs,
): Promise<Extract<HostDaemonInjectedSkillSource, { kind: "workspace-path" }>> {
  const sourceRootPath = path.join(args.dataDir, "skills", args.name);
  await fs.mkdir(sourceRootPath, { recursive: true });
  await fs.writeFile(
    path.join(sourceRootPath, "SKILL.md"),
    [
      "---",
      `name: ${args.name}`,
      `description: Use ${args.name} when runtime manager tests run.`,
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
    name: args.name,
    description: `Use ${args.name} when runtime manager tests run.`,
    sourceRootPath,
    skillFilePath: path.join(sourceRootPath, "SKILL.md"),
  };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function getProvisionWorkspacePath(args: ProvisionWorkspaceArgs): string {
  switch (args.workspaceProvisionType) {
    case "managed-worktree":
    case "personal":
      return args.targetPath;
    case "reconnect-managed-worktree":
    case "unmanaged":
      return args.path;
  }
}

function createFakeWorkspace(
  path: string,
  isGitRepo = true,
  options: { managed?: boolean } = {},
) {
  const status: GetStatusResult = makeWorkspaceStatus({
    mergeBase: makeWorkspaceMergeBase(),
  });
  const diff: GetDiffResult = {
    diff: "",
    truncated: false,
    shortstat: "",
    files: "",
    mergeBaseRef: null,
  };
  let localStateFingerprint: GetLocalStateFingerprintResult = `local:${path}:initial`;
  let localStateFingerprintError: Error | null = null;
  let sharedGitRefsFingerprint: GetSharedGitRefsFingerprintResult = `refs:${path}:initial`;
  let sharedGitRefsFingerprintError: Error | null = null;
  const workspace = {
    path,
    managed: options.managed ?? false,
    isGitRepo,
    isWorktree: false,
    getDefaultBranch: vi.fn(async () => "main"),
    getCurrentBranch: vi.fn(async (..._args: GetCurrentBranchArgs) => "main"),
    getHeadSha: vi.fn(async () => "commit-1"),
    getLocalStateFingerprint: vi.fn(async () => {
      if (localStateFingerprintError) {
        throw localStateFingerprintError;
      }
      return localStateFingerprint;
    }),
    getSharedGitRefsFingerprint: vi.fn(async () => {
      if (sharedGitRefsFingerprintError) {
        throw sharedGitRefsFingerprintError;
      }
      return sharedGitRefsFingerprint;
    }),
    getAdditionalWorkspaceWriteRoots: vi.fn(async () => []),
    getStatus: vi.fn(async () => status),
    getDiff: vi.fn(async () => diff),
    diffFiles: vi.fn(async () => ({
      files: [],
      shortstat: "",
      mergeBaseRef: null,
      truncated: false,
    })),
    diffPatch: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({ outcome: "none" as const })),
    runPullRequestAction: vi.fn(async () => undefined),
    listFiles: vi.fn(async () => []),
    commit: vi.fn(async (..._args: CommitArgs) => ({
      commitSha: "commit-1",
      commitSubject: "commit",
    })),
    reset: vi.fn(async () => undefined),
    setLocalStateFingerprint(value: GetLocalStateFingerprintResult) {
      localStateFingerprint = value;
    },
    setLocalStateFingerprintError(value: Error | null) {
      localStateFingerprintError = value;
    },
    setSharedGitRefsFingerprint(value: GetSharedGitRefsFingerprintResult) {
      sharedGitRefsFingerprint = value;
    },
    setSharedGitRefsFingerprintError(value: Error | null) {
      sharedGitRefsFingerprintError = value;
    },
    destroy: vi.fn(async () => undefined),
  } satisfies HostWorkspace & {
    setLocalStateFingerprint: (value: GetLocalStateFingerprintResult) => void;
    setLocalStateFingerprintError: (value: Error | null) => void;
    setSharedGitRefsFingerprint: (
      value: GetSharedGitRefsFingerprintResult,
    ) => void;
    setSharedGitRefsFingerprintError: (value: Error | null) => void;
  };

  return workspace;
}

interface FakeAgentRuntime extends AgentRuntime {
  endActiveTurn: (threadId: string) => void;
  setActiveTurn: (threadId: string, turnId: string) => void;
  setOpenBackgroundWork: (hasOpenWork: boolean) => void;
  setPendingTurnStart: (threadId: string, hasPending: boolean) => void;
}

function createFakeRuntime() {
  const activeTurnsByThreadId = new Map<string, string>();
  let openBackgroundWork = false;
  const pendingTurnStartThreadIds = new Set<string>();
  return {
    ensureProvider: vi.fn(async (_args: EnsureProviderArgs) => undefined),
    startThread: vi.fn(async (_args: StartThreadArgs) => ({
      providerThreadId: "provider-1",
    })),
    prepareThreadRewind: vi.fn(async () => ({
      providerThreadId: "provider-rewind-1",
    })),
    discardThreadRewind: vi.fn(async () => undefined),
    resumeThread: vi.fn(async (_args: ResumeThreadArgs) => ({
      providerThreadId: "provider-1",
    })),
    runTurn: vi.fn(async (_args: RunTurnArgs) => undefined),
    steerTurn: vi.fn(async (_args: SteerTurnArgs) => ({
      status: "steered" as const,
    })),
    stopThread: vi.fn(async (_args: StopThreadArgs) => ({
      providerCheckpointId: null,
    })),
    clearThreadGoal: vi.fn(async () => ({ cleared: true })),
    renameThread: vi.fn(async (_args: RenameThreadArgs) => undefined),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    listModels: vi.fn(async (_args: ListModelsArgs) => ({
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
    listRunningProviders: vi.fn((): string[] => []),
    getActiveTurnId: (threadId) => activeTurnsByThreadId.get(threadId) ?? null,
    waitForActiveTurn: async (threadId) =>
      activeTurnsByThreadId.get(threadId) ?? null,
    getProviderSession: () => null,
    reapIdleProviderSessions: vi.fn<AgentRuntime["reapIdleProviderSessions"]>(
      async () => ({ reapedSessions: [] }),
    ),
    hasThread: (threadId) => activeTurnsByThreadId.has(threadId),
    getLiveThreadIds: () => [
      ...new Set([
        ...activeTurnsByThreadId.keys(),
        ...pendingTurnStartThreadIds,
      ]),
    ],
    hasOpenBackgroundWork: () => openBackgroundWork,
    shutdown: vi.fn(async () => undefined),
    endActiveTurn: (threadId) => {
      activeTurnsByThreadId.delete(threadId);
    },
    setActiveTurn: (threadId, turnId) => {
      activeTurnsByThreadId.set(threadId, turnId);
    },
    setOpenBackgroundWork: (hasOpenWork) => {
      openBackgroundWork = hasOpenWork;
    },
    setPendingTurnStart: (threadId, hasPending) => {
      if (hasPending) {
        pendingTurnStartThreadIds.add(threadId);
      } else {
        pendingTurnStartThreadIds.delete(threadId);
      }
    },
  } satisfies FakeAgentRuntime;
}

function createProvisionWorkspaceMock(path: string) {
  return vi.fn(async (..._args: ProvisionWorkspaceMockArgs) =>
    createFakeWorkspace(path),
  );
}

describe("RuntimeManager", () => {
  it("creates a runtime the first time an environment is requested", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
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

  it("refreshes the workspace on the resident runtime entry", async () => {
    const plainWorkspace = createFakeWorkspace("/tmp/env-refresh", false);
    const gitWorkspace = createFakeWorkspace("/tmp/env-refresh");
    const provisionWorkspace = vi
      .fn<(options: ProvisionWorkspaceArgs) => Promise<HostWorkspace>>()
      .mockResolvedValueOnce(plainWorkspace)
      .mockResolvedValueOnce(gitWorkspace);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => createFakeRuntime(),
    });
    const entry = await manager.ensureEnvironment({
      environmentId: "env-refresh",
      workspacePath: "/tmp/env-refresh",
    });

    const refreshed = await manager.refreshEnvironmentWorkspace({
      environmentId: "env-refresh",
      provision: {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-refresh",
      },
      workspacePath: "/tmp/env-refresh",
    });

    expect(refreshed).toBe(gitWorkspace);
    expect(entry.workspace).toBe(gitWorkspace);
    expect(manager.get("env-refresh")?.workspace).toBe(gitWorkspace);
    expect(provisionWorkspace).toHaveBeenCalledTimes(2);
  });

  it("reaps idle provider sessions from loaded runtimes", async () => {
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    firstRuntime.reapIdleProviderSessions.mockResolvedValue({
      reapedSessions: [
        {
          idleForMs: 1_500,
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          threadId: "thread-1",
        },
      ],
    });
    secondRuntime.reapIdleProviderSessions.mockResolvedValue({
      reapedSessions: [
        {
          idleForMs: 2_500,
          providerId: "codex",
          providerThreadId: "provider-thread-2",
          threadId: "thread-2",
        },
      ],
    });
    const runtimes = [firstRuntime, secondRuntime];
    const createRuntime = vi.fn(() => {
      const runtime = runtimes.shift();
      if (!runtime) {
        throw new Error("Unexpected runtime creation");
      }
      return runtime;
    });
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await manager.ensureEnvironment({
      environmentId: "env-2",
      workspacePath: "/tmp/env-2",
    });

    await expect(
      manager.reapIdleProviderSessions({
        idleForMs: 1_000,
        nowMs: 5_000,
      }),
    ).resolves.toEqual({
      reapedSessions: [
        {
          environmentId: "env-1",
          idleForMs: 1_500,
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          threadId: "thread-1",
        },
        {
          environmentId: "env-2",
          idleForMs: 2_500,
          providerId: "codex",
          providerThreadId: "provider-thread-2",
          threadId: "thread-2",
        },
      ],
    });
    expect(firstRuntime.reapIdleProviderSessions).toHaveBeenCalledWith({
      idleForMs: 1_000,
      nowMs: 5_000,
      runThreadExclusive: expect.any(Function),
    });
    expect(secondRuntime.reapIdleProviderSessions).toHaveBeenCalledWith({
      idleForMs: 1_000,
      nowMs: 5_000,
      runThreadExclusive: expect.any(Function),
    });
  });

  it("does not release a session while its thread command is in flight", async () => {
    const runtime = createFakeRuntime();
    const releaseWork = vi.fn(async () => ({
      idleForMs: 2_000,
      providerId: "claude-code",
      providerThreadId: "provider-thread-1",
      threadId: "thread-1",
    }));
    runtime.reapIdleProviderSessions.mockImplementation(async (args) => {
      if (!args.runThreadExclusive) {
        throw new Error("Expected thread control callback");
      }
      const released = await args.runThreadExclusive("thread-1", releaseWork);
      return { reapedSessions: released ? [released] : [] };
    });
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime: () => runtime,
    });
    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const finishCommand = await manager.retainEnvironmentForThreadCommand(
      "env-1",
      "thread-1",
    );

    const result = await manager.reapIdleProviderSessions({
      idleForMs: 1_000,
      nowMs: 5_000,
    });

    expect(result.reapedSessions).toEqual([]);
    expect(releaseWork).not.toHaveBeenCalled();
    finishCommand();
  });

  it("passes staged injected skill roots to created runtimes", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntime();
      },
    });

    const entry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });

    expect(entry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtimeOptions.current?.skillRoots).toEqual([
      {
        id: `global-skills:${entry.skillCatalogHash}`,
        path: path.join(
          dataDir,
          "runtime",
          "global-skills",
          entry.skillCatalogHash ?? "",
          "skills",
        ),
        skills: [
          {
            description: "Use release-notes when runtime manager tests run.",
            name: "release-notes",
          },
        ],
      },
    ]);
  });

  it("loads a thread command's skill catalog while that command retains an idle runtime", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-command-skills-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(firstRuntime)
      .mockReturnValueOnce(secondRuntime);
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const initialEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      workspacePath: "/tmp/env-1",
    });
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-skills",
      "thread-1",
    );
    try {
      const configuredEntry = await manager.ensureEnvironment({
        environmentId: "env-skills",
        injectedSkillSources: [source],
        targetThreadId: "thread-1",
        workspacePath: "/tmp/env-1",
      });

      expect(configuredEntry).not.toBe(initialEntry);
      expect(configuredEntry.skillCatalogHash).not.toBeNull();
      expect(firstRuntime.shutdown).toHaveBeenCalledTimes(1);
      expect(createRuntime).toHaveBeenCalledTimes(2);
    } finally {
      release();
    }
  });

  it("does not reuse an idle runtime with a stale skill catalog hash", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-stale-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimes = [createFakeRuntime(), createFakeRuntime()];
    const createRuntime = vi.fn(() => {
      const runtime = runtimes.shift();
      if (!runtime) {
        throw new Error("Unexpected runtime creation");
      }
      return runtime;
    });
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    await fs.writeFile(
      source.skillFilePath,
      [
        "---",
        "name: release-notes",
        "description: Use release-notes when runtime manager tests run.",
        "---",
        "",
        "second-token",
        "",
      ].join("\n"),
      "utf8",
    );
    const secondEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });

    expect(secondEntry).not.toBe(firstEntry);
    expect(secondEntry.skillCatalogHash).not.toBe(firstEntry.skillCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(firstEntry.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("reuses a busy runtime with a stale skill catalog and refreshes it once idle", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-defer-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimes: ReturnType<typeof createFakeRuntime>[] = [];
    const createRuntime = vi.fn(() => {
      const runtime = createFakeRuntime();
      runtimes.push(runtime);
      return runtime;
    });
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    const firstCatalogHash = firstEntry.skillCatalogHash;
    runtimes[0]?.setActiveTurn("thread-1", "turn-1");
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    const busyEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(busyEntry).toBe(firstEntry);
    expect(busyEntry.skillCatalogHash).toBe(firstCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(firstEntry.runtime.shutdown).not.toHaveBeenCalled();

    runtimes[0]?.endActiveTurn("thread-1");
    const idleEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(idleEntry).not.toBe(firstEntry);
    expect(idleEntry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(idleEntry.skillCatalogHash).not.toBe(firstCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(firstEntry.runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("replaces an idle runtime that hosts the target thread and keeps the new staged catalog", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-idle-host-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    const secondEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(secondEntry).not.toBe(firstEntry);
    expect(firstEntry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondEntry.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondEntry.skillCatalogHash).not.toBe(firstEntry.skillCatalogHash);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(firstEntry.runtime.shutdown).toHaveBeenCalledTimes(1);

    const stagingRoot = path.join(dataDir, "runtime", "global-skills");
    const newCatalogStat = await fs.stat(
      path.join(stagingRoot, secondEntry.skillCatalogHash ?? ""),
    );
    expect(newCatalogStat.isDirectory()).toBe(true);
    await expect(
      fs.stat(path.join(stagingRoot, firstEntry.skillCatalogHash ?? "")),
    ).rejects.toThrow();
  });

  it("keeps the staged catalog of an environment still being created while another environment swaps catalogs", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-pending-");
    const sourceA = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "env-a-token",
    });
    const provisionStarted = createDeferredPromise<void>();
    const releaseProvision = createDeferredPromise<void>();
    const provisionWorkspace = vi.fn(
      async (options: ProvisionWorkspaceArgs) => {
        const targetPath = "path" in options ? options.path : undefined;
        if (targetPath === "/tmp/env-a") {
          provisionStarted.resolve();
          await releaseProvision.promise;
        }
        return createFakeWorkspace(targetPath ?? "/tmp/env");
      },
    );
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    const envA = manager.ensureEnvironment({
      environmentId: "env-a",
      injectedSkillSources: [sourceA],
      workspacePath: "/tmp/env-a",
    });
    await provisionStarted.promise;

    const sourceB = await writeInjectedSkillSource({
      dataDir,
      name: "other-notes",
      token: "env-b-first",
    });
    const firstB = await manager.ensureEnvironment({
      environmentId: "env-b",
      injectedSkillSources: [sourceB],
      workspacePath: "/tmp/env-b",
    });
    await writeInjectedSkillSource({
      dataDir,
      name: "other-notes",
      token: "env-b-second",
    });
    const secondB = await manager.ensureEnvironment({
      environmentId: "env-b",
      injectedSkillSources: [sourceB],
      targetThreadId: "thread-b",
      workspacePath: "/tmp/env-b",
    });
    expect(secondB.skillCatalogHash).not.toBe(firstB.skillCatalogHash);

    releaseProvision.resolve();
    const entryA = await envA;
    expect(entryA.skillCatalogHash).toMatch(/^[a-f0-9]{64}$/u);
    const stagingRoot = path.join(dataDir, "runtime", "global-skills");
    const catalogAStat = await fs.stat(
      path.join(stagingRoot, entryA.skillCatalogHash ?? ""),
    );
    expect(catalogAStat.isDirectory()).toBe(true);
    await expect(
      fs.stat(path.join(stagingRoot, firstB.skillCatalogHash ?? "")),
    ).rejects.toThrow();
  });

  it("reuses a busy runtime for a target thread it does not host yet", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-unhosted-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const createRuntime = vi.fn(() => runtime);
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    runtime.setActiveTurn("other-thread", "turn-1");
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    const secondEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(secondEntry).toBe(firstEntry);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(firstEntry.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("reuses a runtime pinned busy by a terminal when a thread brings skill sources", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-terminal-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const terminalEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      workspacePath: "/tmp/env-1",
    });
    manager.markTerminalActive("env-skills", "terminal-1");

    const threadEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      targetThreadId: "thread-1",
      workspacePath: "/tmp/env-1",
    });

    expect(threadEntry).toBe(terminalEntry);
    expect(threadEntry.skillCatalogHash).toBeNull();
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(terminalEntry.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("rejects a stale skill catalog on a busy runtime when no thread targets it", async () => {
    const dataDir = await makeTempDir("bb-runtime-manager-skills-conflict-");
    const source = await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "first-token",
    });
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const createRuntime = vi.fn(() => runtime);
    const manager = new RuntimeManager({
      dataDir,
      provisionWorkspace,
      createRuntime,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-skills",
      injectedSkillSources: [source],
      workspacePath: "/tmp/env-1",
    });
    runtime.setActiveTurn("thread-1", "turn-1");
    await writeInjectedSkillSource({
      dataDir,
      name: "release-notes",
      token: "second-token",
    });

    await expect(
      manager.ensureEnvironment({
        environmentId: "env-skills",
        injectedSkillSources: [source],
        workspacePath: "/tmp/env-1",
      }),
    ).rejects.toBeInstanceOf(SkillCatalogConflictError);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(firstEntry.runtime.shutdown).not.toHaveBeenCalled();
  });

  it("applies unmanaged checkout provisioning to existing runtime entries", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const onWorkspaceStatusChanged = vi.fn();
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      onWorkspaceStatusChanged,
    });

    const firstEntry = await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const secondEntry = await manager.ensureEnvironment({
      environmentId: "env-1",
      provision: {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-1",
        checkout: { kind: "existing", name: "feature-existing" },
      },
    });

    expect(secondEntry).toBe(firstEntry);
    expect(createRuntime).toHaveBeenCalledTimes(1);
    expect(provisionWorkspace).toHaveBeenCalledTimes(2);
    expect(provisionWorkspace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-1",
        checkout: { kind: "existing", name: "feature-existing" },
      }),
    );
    expect(onWorkspaceStatusChanged).toHaveBeenCalledWith({
      environmentId: "env-1",
      changeKinds: ["work-status-changed", "git-refs-changed"],
    });
  });

  it("registers existing environment provisioning before invoking work", async () => {
    let manager: RuntimeManager;
    let callCount = 0;
    let cancelDuringWork: Promise<{ aborted: boolean }> | null = null;
    const workspace = createFakeWorkspace("/tmp/env-1");
    const provisionWorkspace = vi.fn(
      async (options: ProvisionWorkspaceArgs) => {
        callCount += 1;
        if (callCount === 1) {
          return workspace;
        }

        cancelDuringWork = manager.cancelEnvironmentProvision({
          environmentId: "env-1",
        });
        if (!options.signal?.aborted) {
          throw new Error("Expected provision signal to be aborted");
        }
        throw options.signal.reason;
      },
    );
    manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await expect(
      manager.ensureEnvironment({
        environmentId: "env-1",
        provision: {
          workspaceProvisionType: "unmanaged",
          path: "/tmp/env-1",
          checkout: { kind: "existing", name: "feature-existing" },
        },
      }),
    ).rejects.toMatchObject({ code: "provision_cancelled" });
    if (!cancelDuringWork) {
      throw new Error("Expected cancellation to be requested during provision");
    }
    await expect(cancelDuringWork).resolves.toEqual({ aborted: true });
  });

  it("shares existing environment provisioning cancellation across concurrent callers", async () => {
    const provisionStarted = createDeferredPromise<void>();
    const provisionSignals: AbortSignal[] = [];
    let callCount = 0;
    const workspace = createFakeWorkspace("/tmp/env-1");
    const provisionWorkspace = vi.fn(
      async (options: ProvisionWorkspaceArgs) => {
        callCount += 1;
        if (callCount === 1) {
          return workspace;
        }
        if (!options.signal) {
          throw new Error("Expected provision signal");
        }
        provisionSignals.push(options.signal);
        provisionStarted.resolve();
        return new Promise<HostWorkspace>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: vi.fn(() => createFakeRuntime()),
    });
    const provision: ProvisionWorkspaceArgs = {
      workspaceProvisionType: "unmanaged",
      path: "/tmp/env-1",
      checkout: { kind: "existing", name: "feature-existing" },
    };

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const first = manager.ensureEnvironment({
      environmentId: "env-1",
      provision,
    });
    await provisionStarted.promise;
    const second = manager.ensureEnvironment({
      environmentId: "env-1",
      provision,
    });
    const firstCancelled = expect(first).rejects.toMatchObject({
      code: "provision_cancelled",
    });
    const secondCancelled = expect(second).rejects.toMatchObject({
      code: "provision_cancelled",
    });

    await expect(
      manager.cancelEnvironmentProvision({
        environmentId: "env-1",
      }),
    ).resolves.toEqual({ aborted: true });
    await firstCancelled;
    await secondCancelled;
    expect(provisionWorkspace).toHaveBeenCalledTimes(2);
    expect(provisionSignals).toHaveLength(1);
    expect(provisionSignals[0]?.aborted).toBe(true);
  });

  it("passes managed worktree git metadata roots to created runtimes", async () => {
    const repoPath = await initRepo();
    const parentDir = await makeTempDir("bb-runtime-manager-worktree-");
    const targetPath = path.join(parentDir, "env");
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntime();
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-roots",
      provision: {
        workspaceProvisionType: "managed-worktree",
        sourcePath: repoPath,
        targetPath,
        branchName: "bb/env-roots",
        baseBranch: "main",
        timeoutMs: 900000,
      },
    });
    const gitDir = (
      await runGit(["rev-parse", "--absolute-git-dir"], { cwd: targetPath })
    ).trim();
    const commonGitDir = path.resolve(
      targetPath,
      (
        await runGit(["rev-parse", "--git-common-dir"], { cwd: targetPath })
      ).trim(),
    );

    expect(runtimeOptions.current?.additionalWorkspaceWriteRoots).toEqual([
      path.resolve(gitDir),
      path.join(commonGitDir, "objects"),
      path.join(commonGitDir, "refs"),
      path.join(commonGitDir, "logs"),
    ]);
  });

  it("passes unmanaged linked worktree git metadata roots to created runtimes", async () => {
    const repoPath = await initRepo();
    const parentDir = await makeTempDir("bb-runtime-manager-unmanaged-wt-");
    const worktreePath = path.join(parentDir, "env");
    await runGit(["worktree", "add", "-B", "bb/unmanaged", worktreePath], {
      cwd: repoPath,
    });
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntime();
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-unmanaged-roots",
      provision: {
        workspaceProvisionType: "unmanaged",
        path: worktreePath,
      },
    });
    const gitDir = (
      await runGit(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath })
    ).trim();
    const commonGitDir = path.resolve(
      worktreePath,
      (
        await runGit(["rev-parse", "--git-common-dir"], { cwd: worktreePath })
      ).trim(),
    );

    expect(runtimeOptions.current?.additionalWorkspaceWriteRoots).toEqual([
      path.resolve(gitDir),
      path.join(commonGitDir, "objects"),
      path.join(commonGitDir, "refs"),
      path.join(commonGitDir, "logs"),
    ]);
  });

  it("passes thread storage root to created runtimes as a workspace-write root", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtimeOptions: RuntimeOptionsRef = { current: null };
    const manager = new RuntimeManager({
      provisionWorkspace,
      threadStorageRootPath: "/tmp/bb-thread-storage",
      createRuntime: (options) => {
        runtimeOptions.current = options;
        return createFakeRuntime();
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-thread-storage-root",
      workspacePath: "/tmp/env-1",
    });

    expect(runtimeOptions.current?.additionalWorkspaceWriteRoots).toEqual([
      "/tmp/bb-thread-storage",
    ]);
  });

  it("passes shell env through to created runtimes", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/usr/bin",
        BB_SERVER_URL: "http://127.0.0.1:3334",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        shellEnv: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_SERVER_URL: "http://127.0.0.1:3334",
        },
      }),
    );
  });

  it("forwards the bridge record-mode directory to provider processes but not the shell env", async () => {
    vi.stubEnv("BB_PROVIDER_BRIDGE_RECORD_DIR", "/tmp/provider-recordings/raw");
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PATH: "/tmp/bb-bin:/usr/bin",
          BB_PROVIDER_BRIDGE_RECORD_DIR: "/tmp/provider-recordings/raw",
        },
        shellEnv: { PATH: "/tmp/bb-bin:/usr/bin" },
      }),
    );
  });

  it("passes the resolved shell PATH to managed worktree setup", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const manager = new RuntimeManager({
      provisionWorkspace,
      shellEnv: {
        PATH: "/resolved/user/bin:/usr/bin:/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      provision: {
        workspaceProvisionType: "managed-worktree",
        sourcePath: "/tmp/source",
        targetPath: "/tmp/env-1",
        branchName: "bb/env-1",
        baseBranch: "main",
        timeoutMs: 900000,
      },
    });

    expect(provisionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        shellPath: "/resolved/user/bin:/usr/bin:/bin",
      }),
    );
  });

  it("passes the resolved shell PATH to unmanaged workspace Git", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const manager = new RuntimeManager({
      provisionWorkspace,
      shellEnv: {
        PATH: "/resolved/user/bin:/usr/bin:/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      provision: {
        workspaceProvisionType: "unmanaged",
        path: "/tmp/env-1",
      },
    });

    expect(provisionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        shellPath: "/resolved/user/bin:/usr/bin:/bin",
      }),
    );
  });

  it("passes shell PATH through to provider process env", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/tmp/bb-bin:/home/me/.local/bin:/usr/bin",
        BB_SERVER_URL: "http://127.0.0.1:3334",
        OPENAI_API_KEY: "test-openai-key",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          PATH: "/tmp/bb-bin:/home/me/.local/bin:/usr/bin",
        },
        shellEnv: {
          PATH: "/tmp/bb-bin:/home/me/.local/bin:/usr/bin",
          BB_SERVER_URL: "http://127.0.0.1:3334",
          OPENAI_API_KEY: "test-openai-key",
        },
      }),
    );
  });

  it("recreates the provider maintenance runtime after base shell env changes", async () => {
    const dataDir = await makeTempDir("bb-provider-maintenance-");
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(firstRuntime)
      .mockReturnValueOnce(secondRuntime);
    const manager = new RuntimeManager({
      createRuntime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await expect(
      manager.ensureProviderMaintenanceRuntime({ dataDir }),
    ).resolves.toBe(firstRuntime);
    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
      BB_SERVER_URL: "http://127.0.0.1:3334",
    });
    await expect(
      manager.ensureProviderMaintenanceRuntime({ dataDir }),
    ).resolves.toBe(secondRuntime);

    expect(firstRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        env: {
          PATH: "/new/bin:/usr/bin",
        },
        shellEnv: {
          PATH: "/new/bin:/usr/bin",
          BB_SERVER_URL: "http://127.0.0.1:3334",
        },
      }),
    );
  });

  it("shuts down provider maintenance workers after the request becomes idle", async () => {
    vi.useFakeTimers();
    try {
      const dataDir = await makeTempDir("bb-provider-maintenance-idle-");
      const runtime = createFakeRuntime();
      const request = createDeferredPromise<void>();
      const requestStarted = createDeferredPromise<void>();
      const manager = new RuntimeManager({
        createRuntime: () => runtime,
        providerMaintenanceIdleTimeoutMs: 100,
      });

      const activeRequest = manager.withProviderMaintenanceRuntime(
        { dataDir },
        async () => {
          requestStarted.resolve();
          return request.promise;
        },
      );
      await requestStarted.promise;
      await vi.advanceTimersByTimeAsync(200);
      expect(runtime.shutdown).not.toHaveBeenCalled();

      request.resolve();
      await activeRequest;
      await vi.advanceTimersByTimeAsync(99);
      expect(runtime.shutdown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.shutdown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let stale provider maintenance creation replace a newer runtime", async () => {
    const dataDir = await makeTempDir("bb-provider-maintenance-race-");
    const staleRuntime = createFakeRuntime();
    const currentRuntime = createFakeRuntime();
    const staleCreation = createDeferredPromise<AgentRuntime>();
    const manager = new RuntimeManager({
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });
    const managerInternals =
      manager as unknown as RuntimeManagerProviderMaintenanceInternals;
    vi.spyOn(managerInternals, "createProviderMaintenanceRuntime")
      .mockImplementationOnce(() => staleCreation.promise)
      .mockImplementationOnce(async () => currentRuntime);

    const staleRuntimePromise = manager.ensureProviderMaintenanceRuntime({
      dataDir,
    });
    const replaceShellEnvPromise = manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });
    const currentRuntimePromise = manager.ensureProviderMaintenanceRuntime({
      dataDir,
    });

    await expect(currentRuntimePromise).resolves.toBe(currentRuntime);
    expect(managerInternals.providerMaintenanceRuntime).toBe(currentRuntime);

    staleCreation.resolve(staleRuntime);
    await expect(staleRuntimePromise).resolves.toBe(staleRuntime);
    await replaceShellEnvPromise;

    expect(managerInternals.providerMaintenanceRuntime).toBe(currentRuntime);
    expect(staleRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(currentRuntime.shutdown).not.toHaveBeenCalled();
  });

  it("evicts idle environment runtimes after base shell env changes", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const firstRuntime = createFakeRuntime();
    const secondRuntime = createFakeRuntime();
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(firstRuntime)
      .mockReturnValueOnce(secondRuntime);
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(firstRuntime.shutdown).toHaveBeenCalledTimes(1);

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    expect(createRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        env: {
          PATH: "/new/bin:/usr/bin",
        },
        shellEnv: {
          PATH: "/new/bin:/usr/bin",
        },
      }),
    );
    expect(secondRuntime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps an environment runtime while a background task is still open", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => runtime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    runtime.setOpenBackgroundWork(true);

    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });

    expect(manager.get("env-1")?.runtime).toBe(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();

    runtime.setOpenBackgroundWork(false);
    await manager.replaceBaseShellEnv({
      PATH: "/newer/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps an environment runtime while a thread command is being prepared", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => runtime,
      shellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-1",
      "thread-1",
    );

    await manager.replaceBaseShellEnv({
      PATH: "/new/bin:/usr/bin",
    });

    expect(manager.get("env-1")?.runtime).toBe(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();

    release();
    await manager.replaceBaseShellEnv({
      PATH: "/newer/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("waits for an old-environment thread command before releasing a moved thread", async () => {
    const oldRuntime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-old"),
      createRuntime: () => oldRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/env-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-old",
      "thread-1",
    );
    const handoff = manager.releaseThreadFromOtherEnvironments({
      activeTurn: "interrupt",
      environmentId: "env-new",
      threadId: "thread-1",
    });

    await Promise.resolve();
    expect(oldRuntime.stopThread).not.toHaveBeenCalled();

    release();
    await handoff;

    expect(oldRuntime.stopThread).toHaveBeenCalledWith({
      threadId: "thread-1",
    });
  });

  it("releases a moved thread while another environment control waits", async () => {
    const oldRuntime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-old"),
      createRuntime: () => oldRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/env-old",
    });
    const release = await manager.retainEnvironmentForThreadCommand(
      "env-new",
      "thread-1",
    );
    const oldEnvironmentControl = manager.releaseThreadFromOtherEnvironments({
      activeTurn: "interrupt",
      environmentId: "env-old",
      threadId: "thread-1",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    const turnHandoff = manager
      .releaseThreadFromOtherEnvironments({
        activeTurn: "interrupt",
        environmentId: "env-new",
        threadId: "thread-1",
      })
      .then(() => {
        release();
      });

    await expect(
      Promise.all([oldEnvironmentControl, turnHandoff]),
    ).resolves.toBeDefined();
    await expect(
      manager.retainEnvironmentForThreadCommand("env-new", "thread-1"),
    ).resolves.toBeInstanceOf(Function);
  });

  it("keeps an old-environment turn when a control declines to interrupt it", async () => {
    const oldRuntime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-old"),
      createRuntime: () => oldRuntime,
    });

    await manager.ensureEnvironment({
      environmentId: "env-old",
      workspacePath: "/tmp/env-old",
    });
    oldRuntime.setActiveTurn("thread-1", "turn-old");

    const result = await manager.releaseThreadFromOtherEnvironments({
      activeTurn: "keep",
      environmentId: "env-new",
      threadId: "thread-1",
    });

    expect(oldRuntime.stopThread).not.toHaveBeenCalled();
    expect(result.activeTurnEnvironmentIds).toEqual(["env-old"]);
    expect(result.releasedEnvironmentIds).toEqual([]);
  });

  it("keeps an environment runtime while an accepted turn awaits its first event", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace,
      createRuntime: () => runtime,
      shellEnv: {
        PATH: "/tmp/fnm_multishells/first/bin:/usr/bin",
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    runtime.setPendingTurnStart("thread-1", true);

    await manager.replaceBaseShellEnv({
      PATH: "/tmp/fnm_multishells/second/bin:/usr/bin",
    });

    expect(manager.get("env-1")?.runtime).toBe(runtime);
    expect(runtime.shutdown).not.toHaveBeenCalled();

    runtime.setPendingTurnStart("thread-1", false);
    await manager.replaceBaseShellEnv({
      PATH: "/tmp/fnm_multishells/third/bin:/usr/bin",
    });

    expect(manager.get("env-1")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  it("reuses the existing runtime for subsequent requests", async () => {
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-1");
    const createRuntime = vi.fn(() => createFakeRuntime());
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

  it("evicts only idle environments and keeps their workspaces intact", async () => {
    const runtimes: ReturnType<typeof createFakeRuntime>[] = [];
    const workspaces: HostWorkspace[] = [];
    const createRuntime = vi.fn(() => {
      const runtime = createFakeRuntime();
      runtimes.push(runtime);
      return runtime;
    });
    const provisionWorkspace = vi.fn(
      async (...args: ProvisionWorkspaceMockArgs) => {
        const workspace = createFakeWorkspace(
          getProvisionWorkspacePath(args[0]),
        );
        workspaces.push(workspace);
        return workspace;
      },
    );
    const manager = new RuntimeManager({
      createRuntime,
      provisionWorkspace,
    });

    await manager.ensureEnvironment({
      environmentId: "env-idle",
      workspacePath: "/tmp/env-idle",
    });
    await manager.ensureEnvironment({
      environmentId: "env-active",
      workspacePath: "/tmp/env-active",
    });
    runtimes[1]?.setActiveTurn("thr-active", "turn-active");

    await expect(manager.evictIdleEnvironments()).resolves.toEqual([
      "env-idle",
    ]);

    expect(manager.get("env-idle")).toBeUndefined();
    expect(manager.get("env-active")).toBeDefined();
    expect(runtimes[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtimes[1]?.shutdown).not.toHaveBeenCalled();
    expect(workspaces[0]?.destroy).not.toHaveBeenCalled();
    expect(workspaces[1]?.destroy).not.toHaveBeenCalled();
  });

  it("skips idle eviction while environment creation is still pending", async () => {
    const deferredWorkspace = createDeferredPromise<HostWorkspace>();
    const manager = new RuntimeManager({
      provisionWorkspace: vi.fn(async () => deferredWorkspace.promise),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    const pendingEnvironment = manager.ensureEnvironment({
      environmentId: "env-pending",
      workspacePath: "/tmp/env-pending",
    });

    await expect(manager.evictIdleEnvironments()).resolves.toEqual([]);

    deferredWorkspace.resolve(createFakeWorkspace("/tmp/env-pending"));
    await expect(pendingEnvironment).resolves.toMatchObject({
      environmentId: "env-pending",
    });
    expect(manager.get("env-pending")).toBeDefined();
  });

  it("shuts down the runtime and destroys the workspace", async () => {
    const workspace = createFakeWorkspace("/tmp/env-1");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace:
        createProvisionWorkspaceMock("/tmp/env-1").mockResolvedValue(workspace),
      createRuntime: vi.fn(() => runtime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });
    await manager.destroyEnvironment("env-1", { timeoutMs: 900000 });

    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(workspace.destroy).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")(
    "kills detached processes rooted in a managed workspace before destroying it",
    async () => {
      const workspacePath = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "bb-destroy-env-")),
      );
      const managedWorkspace = createFakeWorkspace(workspacePath, true, {
        managed: true,
      });
      const runtime = createFakeRuntime();
      const manager = new RuntimeManager({
        provisionWorkspace:
          createProvisionWorkspaceMock(workspacePath).mockResolvedValue(
            managedWorkspace,
          ),
        createRuntime: vi.fn(() => runtime),
      });
      await manager.ensureEnvironment({
        environmentId: "env-procs",
        workspacePath,
      });
      const orphan = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], {
        cwd: workspacePath,
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      orphan.unref();
      const grandchildPid = Number(
        String((await once(orphan.stdout, "data"))[0]).trim(),
      );
      const isAlive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        expect(isAlive(grandchildPid)).toBe(true);

        await manager.destroyEnvironment("env-procs", { timeoutMs: 900000 });

        expect(managedWorkspace.destroy).toHaveBeenCalledTimes(1);
        const deadline = Date.now() + 5000;
        while (
          (isAlive(grandchildPid) || isAlive(orphan.pid ?? 0)) &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(isAlive(grandchildPid)).toBe(false);
        expect(isAlive(orphan.pid ?? 0)).toBe(false);
      } finally {
        for (const pid of [grandchildPid, orphan.pid ?? 0]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await fs.rm(workspacePath, { recursive: true, force: true });
      }
    },
  );

  it("forgets a retired environment without destroying its workspace", async () => {
    const workspace = createFakeWorkspace("/tmp/env-retired");
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace:
        createProvisionWorkspaceMock("/tmp/env-retired").mockResolvedValue(
          workspace,
        ),
      createRuntime: vi.fn(() => runtime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-retired",
      workspacePath: "/tmp/env-retired",
    });
    await manager.forgetEnvironment("env-retired");

    expect(manager.get("env-retired")).toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
    expect(workspace.destroy).not.toHaveBeenCalled();
  });

  it("does not start a workspace watcher when loading an environment", async () => {
    const hostWatcher = {
      watchWorkspace: vi.fn(() => () => undefined),
      watchThreadStorageRoot: vi.fn(() => () => undefined),
    } satisfies HostWatcher;
    const manager = new RuntimeManager({
      hostWatcher,
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-read"),
      createRuntime: vi.fn(() => createFakeRuntime()),
    });

    await manager.ensureEnvironment({
      environmentId: "env-read",
      workspacePath: "/tmp/env-read",
    });

    expect(hostWatcher.watchWorkspace).not.toHaveBeenCalled();
    expect(hostWatcher.watchThreadStorageRoot).not.toHaveBeenCalled();
  });

  it("lists live threads for session reconciliation before the first turn event", async () => {
    const runtime = createFakeRuntime();
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock("/tmp/env-1"),
      createRuntime: vi.fn(() => runtime),
    });

    await manager.ensureEnvironment({
      environmentId: "env-1",
      workspacePath: "/tmp/env-1",
    });

    runtime.setActiveTurn("thread-1", "turn-1");
    runtime.setPendingTurnStart("thread-2", true);
    expect(manager.listActiveThreads()).toEqual([
      {
        threadId: "thread-1",
      },
      {
        threadId: "thread-2",
      },
    ]);

    runtime.endActiveTurn("thread-1");
    runtime.setPendingTurnStart("thread-2", false);
    expect(manager.listActiveThreads()).toEqual([]);
  });

  it("removes stale entries when the provider process exits", async () => {
    const workspace = createFakeWorkspace("/tmp/env-exit");
    const runtime = createFakeRuntime();
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace:
        createProvisionWorkspaceMock("/tmp/env-exit").mockResolvedValue(
          workspace,
        ),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
    });

    await manager.ensureEnvironment({
      environmentId: "env-exit",
      workspacePath: "/tmp/env-exit",
    });

    onProcessExit?.({
      providerId: "fake",
      threads: [
        {
          threadId: "thread-1",
          activeTurnId: null,
          pendingTurnStart: false,
          providerThreadId: null,
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: null,
    });

    expect(manager.get("env-exit")).toBeUndefined();
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("keeps sibling provider threads running when one provider exits", async () => {
    const workspace = createFakeWorkspace("/tmp/env-shared");
    const runtime = createFakeRuntime();
    let runningProviders = ["fake-alpha", "fake-beta"];
    runtime.listRunningProviders.mockImplementation(() => runningProviders);
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace:
        createProvisionWorkspaceMock("/tmp/env-shared").mockResolvedValue(
          workspace,
        ),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
    });

    await manager.ensureEnvironment({
      environmentId: "env-shared",
      workspacePath: "/tmp/env-shared",
    });
    runningProviders = ["fake-beta"];
    onProcessExit?.({
      providerId: "fake-alpha",
      threads: [
        {
          threadId: "thread-a",
          activeTurnId: null,
          pendingTurnStart: false,
          providerThreadId: null,
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: null,
    });

    expect(manager.get("env-shared")).toBeDefined();
    expect(runtime.shutdown).not.toHaveBeenCalled();
  });

  it("emits failure events for active threads when a provider exits unexpectedly", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    const forwardedProcessExits: Parameters<
      NonNullable<AgentRuntimeOptions["onProcessExit"]>
    >[0][] = [];
    let onRuntimeEvent: AgentRuntimeOptions["onEvent"] | undefined;
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-provider-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-provider-exit")),
      createRuntime: vi.fn((options) => {
        onRuntimeEvent = options.onEvent;
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
      onProcessExit: (info) => {
        forwardedProcessExits.push(info);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-provider-exit",
      workspacePath: "/tmp/env-provider-exit",
    });
    if (!onRuntimeEvent || !onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }
    onRuntimeEvent({
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
    });

    onProcessExit({
      providerId: "codex",
      threads: [
        {
          threadId: "thread-1",
          activeTurnId: "turn-1",
          pendingTurnStart: false,
          providerThreadId: "provider-1",
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
    });

    expect(emittedEvents).toEqual([
      {
        environmentId: "env-provider-exit",
        event: {
          type: "turn/started",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
        },
      },
      {
        environmentId: "env-provider-exit",
        event: {
          type: "turn/completed",
          threadId: "thread-1",
          providerThreadId: "provider-1",
          scope: turnScope("turn-1"),
          status: "failed",
          error: {
            message: 'Provider "codex" exited unexpectedly with code 1',
          },
        },
      },
      {
        environmentId: "env-provider-exit",
        event: {
          type: "system/error",
          threadId: "thread-1",
          scope: turnScope("turn-1"),
          code: "provider_process_exited",
          message: 'Provider "codex" exited unexpectedly with code 1',
          detail:
            "stderr:\nOPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
        },
      },
    ]);
    expect(forwardedProcessExits).toEqual([
      expect.objectContaining({
        stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
      }),
    ]);
  });

  it("does not synthesize failure events for exited threads without an active turn", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-idle-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-idle-exit")),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-idle-exit",
      workspacePath: "/tmp/env-idle-exit",
    });
    if (!onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }

    onProcessExit({
      providerId: "codex",
      threads: [
        {
          threadId: "thread-idle",
          activeTurnId: null,
          pendingTurnStart: false,
          providerThreadId: "provider-idle",
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: null,
    });

    expect(emittedEvents).toEqual([]);
  });

  it("emits a thread failure when a provider exits before turn/started", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-pending-turn-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-pending-turn-exit")),
      createRuntime: vi.fn((options) => {
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-pending-turn-exit",
      workspacePath: "/tmp/env-pending-turn-exit",
    });
    if (!onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }

    onProcessExit({
      providerId: "claude-code",
      threads: [
        {
          threadId: "thread-pending",
          activeTurnId: null,
          pendingTurnStart: true,
          providerThreadId: "provider-pending",
        },
      ],
      code: 1,
      expected: false,
      signal: null,
      stderr: "provider failed before acknowledging the turn",
    });

    expect(emittedEvents).toEqual([
      {
        environmentId: "env-pending-turn-exit",
        event: {
          type: "system/error",
          threadId: "thread-pending",
          scope: threadScope(),
          code: "provider_process_exited",
          message: 'Provider "claude-code" exited unexpectedly with code 1',
          detail: "stderr:\nprovider failed before acknowledging the turn",
        },
      },
    ]);
  });

  it("does not emit failure events for expected provider exits", async () => {
    const emittedEvents: Array<{
      environmentId: string;
      event: ThreadEvent;
    }> = [];
    const runtime = createFakeRuntime();
    let onRuntimeEvent: AgentRuntimeOptions["onEvent"] | undefined;
    let onProcessExit:
      | NonNullable<AgentRuntimeOptions["onProcessExit"]>
      | undefined;
    const manager = new RuntimeManager({
      provisionWorkspace: createProvisionWorkspaceMock(
        "/tmp/env-expected-exit",
      ).mockResolvedValue(createFakeWorkspace("/tmp/env-expected-exit")),
      createRuntime: vi.fn((options) => {
        onRuntimeEvent = options.onEvent;
        onProcessExit = options.onProcessExit;
        return runtime;
      }),
      onEvent: (event) => {
        emittedEvents.push(event);
      },
    });

    await manager.ensureEnvironment({
      environmentId: "env-expected-exit",
      workspacePath: "/tmp/env-expected-exit",
    });
    if (!onRuntimeEvent || !onProcessExit) {
      throw new Error("Expected runtime callbacks to be captured");
    }
    onRuntimeEvent({
      type: "turn/started",
      threadId: "thread-1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
    });
    emittedEvents.splice(0, emittedEvents.length);

    onProcessExit({
      providerId: "codex",
      threads: [
        {
          threadId: "thread-1",
          activeTurnId: "turn-1",
          pendingTurnStart: false,
          providerThreadId: "provider-1",
        },
      ],
      code: null,
      expected: true,
      signal: "SIGTERM",
      stderr: null,
    });

    expect(emittedEvents).toEqual([]);
    expect(manager.get("env-expected-exit")).toBeDefined();
  });

  it("shuts down all tracked environments", async () => {
    const workspaceA = createFakeWorkspace("/tmp/env-a");
    const workspaceB = createFakeWorkspace("/tmp/env-b");
    const runtimeA = createFakeRuntime();
    const runtimeB = createFakeRuntime();
    const provisionWorkspace = createProvisionWorkspaceMock("/tmp/env-a")
      .mockResolvedValueOnce(workspaceA)
      .mockResolvedValueOnce(workspaceB);
    const createRuntime = vi
      .fn()
      .mockReturnValueOnce(runtimeA)
      .mockReturnValueOnce(runtimeB);
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
    expect(workspaceA.destroy).not.toHaveBeenCalled();
    expect(workspaceB.destroy).not.toHaveBeenCalled();
  });
});
