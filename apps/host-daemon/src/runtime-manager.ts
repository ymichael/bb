import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type AgentRuntimeSkillRoot,
  type AgentRuntimeProcessExitInfo,
  type ReapedIdleProviderSession,
} from "@bb/agent-runtime";
import type { Logger } from "@bb/logger";
import { killProcessesWithCwdUnder } from "@bb/process-utils";
import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
  ThreadEvent,
  WorkspaceProvisionType,
} from "@bb/domain";
import { threadScope, turnScope } from "@bb/domain";
import type {
  HostDaemonActiveThread,
  HostDaemonEnvironmentChange,
  HostDaemonLoadedEnvironment,
  HostDaemonInjectedSkillSource,
} from "@bb/host-daemon-contract";
import type {
  DataDirSkillsWatchError,
  HostWatcher,
  InjectedSkillsObservedChange,
} from "@bb/host-watcher";
import {
  provisionWorkspace,
  WorkspaceError,
  type DestroyWorkspaceArgs,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import {
  cleanupInjectedSkillStagingDirs,
  EMPTY_SKILL_CATALOG_HASH,
  stageInjectedSkillSources,
  type InjectedSkillsLogger,
} from "./injected-skills.js";
import { reconnectProvisionArgs } from "./workspace-provision-target.js";
import {
  createProviderInstallationGate,
  PROVIDER_INSTALLATION_GATE_TTL_MS,
  type ProviderInstallationGate,
} from "./provider-installation-gate.js";
import type { FetchSkillTree } from "./skill-trees.js";
import { userExecutableProcessOptions } from "./user-executable-env.js";

type StopWatching = () => void | Promise<void>;

const STOP_WATCHING: StopWatching = () => undefined;
const PROVIDER_MAINTENANCE_WORKSPACE_DIR = "provider-maintenance-workspace";
const PROVIDER_MAINTENANCE_IDLE_TIMEOUT_MS = 60_000;
const PROVIDER_PROCESS_EXIT_DETAIL_MAX_LENGTH = 4000;

interface RuntimeSkillConfig {
  catalogHash: string;
  skillRoots: readonly AgentRuntimeSkillRoot[];
}

interface CreateEntryArgs extends Omit<
  EnsureEnvironmentArgs,
  "injectedSkillSources" | "targetThreadId"
> {
  provisionSignal: AbortSignal;
  skillConfig: RuntimeSkillConfig | null;
}

interface ApplyExistingEnvironmentProvisionArgs {
  entry: RuntimeEntry;
  provision: ProvisionWorkspaceArgs | undefined;
  signal: AbortSignal;
}

interface EnsureCompatibleEntryArgs {
  entry: RuntimeEntry;
  skillConfig: RuntimeSkillConfig | null;
  targetThreadId?: string;
}

interface ReplaceEntryForSkillCatalogArgs {
  entry: RuntimeEntry;
  skillConfig: RuntimeSkillConfig;
  targetThreadId?: string;
}

interface SkillCatalogConflictErrorArgs {
  environmentId: string;
  activeCatalogHash: string | null;
  requestedCatalogHash: string;
}

export class SkillCatalogConflictError extends Error {
  constructor(args: SkillCatalogConflictErrorArgs) {
    super(
      `Daemon bug: a command targeting no thread carried injected skill sources into busy environment ${args.environmentId} (active catalog ${args.activeCatalogHash ?? "none"}, requested ${args.requestedCatalogHash})`,
    );
    this.name = "SkillCatalogConflictError";
  }
}

function formatProviderProcessExitStatus(
  info: AgentRuntimeProcessExitInfo,
): string {
  if (info.signal) {
    return `signal ${info.signal}`;
  }
  if (info.code !== null) {
    return `code ${info.code}`;
  }
  return "unknown status";
}

function buildProviderProcessExitMessage(
  info: AgentRuntimeProcessExitInfo,
): string {
  return `Provider "${info.providerId}" exited unexpectedly with ${formatProviderProcessExitStatus(info)}`;
}

function buildProviderProcessExitDetail(
  info: AgentRuntimeProcessExitInfo,
): string | undefined {
  if (!info.stderr) {
    return undefined;
  }
  return `stderr:\n${info.stderr.slice(-PROVIDER_PROCESS_EXIT_DETAIL_MAX_LENGTH)}`;
}

export interface RuntimeEntry {
  environmentId: string;
  runtime: AgentRuntime;
  skillCatalogHash: string | null;
  lastWarnedStaleSkillCatalogHash: string | null;
  stopWatchingStatus: StopWatching;
  workspace: HostWorkspace;
  path: string;
  terminals: Set<string>;
}

interface InjectedSkillsChangedNotification {
  changedPaths: string[];
  sourceType: InjectedSkillsObservedChange["sourceType"];
}

export interface EnsureEnvironmentArgs {
  environmentId: string;
  injectedSkillSources?: readonly HostDaemonInjectedSkillSource[];
  personalWorkspaceRoot?: string;
  targetThreadId?: string;
  workspacePath?: string;
  workspaceProvisionType?: WorkspaceProvisionType;
  provision?: ProvisionWorkspaceArgs;
}

interface CancelEnvironmentProvisionArgs {
  environmentId: string;
}

interface CancelEnvironmentProvisionResult {
  aborted: boolean;
}

interface RefreshEnvironmentWorkspaceArgs {
  environmentId: string;
  provision: ProvisionWorkspaceArgs;
  workspacePath: string;
}

export interface RuntimeManagerOptions {
  bridgeBundleDir?: AgentRuntimeOptions["bridgeBundleDir"];
  createRuntime?: (options: AgentRuntimeOptions) => AgentRuntime;
  dataDir?: string;
  dataDirSkillsRootPath?: string | null;
  fetchSkillTree?: FetchSkillTree;
  hostWatcher?: HostWatcher;
  logger?: Pick<Logger, "debug" | "warn">;
  provisionWorkspace?: (
    options: ProvisionWorkspaceArgs,
  ) => Promise<HostWorkspace>;
  providerInstallationGateTtlMs?: number;
  providerMaintenanceIdleTimeoutMs?: number;
  shellEnv?: AgentRuntimeOptions["shellEnv"];
  onEvent?: (args: { environmentId: string; event: ThreadEvent }) => void;
  threadStorageRootPath?: string | null;
  onInjectedSkillsChanged?: (args: InjectedSkillsChangedNotification) => void;
  onDataDirSkillsWatchError?: (args: {
    error: DataDirSkillsWatchError;
  }) => void;
  onWorkspaceStatusChanged?: (args: {
    changeKinds: HostDaemonEnvironmentChange[];
    environmentId: string;
  }) => void;
  onInteractiveRequest?: (
    request: PendingInteractionCreate,
  ) => Promise<PendingInteractionResolution>;
  onToolCall?: AgentRuntimeOptions["onToolCall"];
  onStderr?: AgentRuntimeOptions["onStderr"];
  onProcessExit?: AgentRuntimeOptions["onProcessExit"];
}

export interface RuntimeManagerReapIdleProviderSessionsArgs {
  idleForMs: number;
  nowMs: number;
}

interface RuntimeManagerReapedIdleProviderSession extends ReapedIdleProviderSession {
  environmentId: string;
}

export interface RuntimeManagerReapIdleProviderSessionsResult {
  reapedSessions: RuntimeManagerReapedIdleProviderSession[];
}

type ReleaseThreadActiveTurnPolicy = "interrupt" | "keep";

interface ReleaseThreadFromOtherEnvironmentsResult {
  activeTurnEnvironmentIds: string[];
  providerCheckpointId: string | null;
  releasedEnvironmentIds: string[];
}

interface RuntimeWorkspaceWriteRootsArgs {
  threadStorageRootPath: string | null | undefined;
  workspaceRoots: readonly string[];
}

interface PendingEnvironmentProvision {
  abortController: AbortController;
  done: Promise<unknown>;
}

interface PendingProviderMaintenanceRuntime {
  generation: number;
  promise: Promise<AgentRuntime>;
}

interface RunCancellableEnvironmentProvisionArgs {
  environmentId: string;
  work: (signal: AbortSignal) => Promise<void>;
}

function shellEnvEquals(
  left: NonNullable<AgentRuntimeOptions["shellEnv"]>,
  right: NonNullable<AgentRuntimeOptions["shellEnv"]>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value]) => right[key] === value);
}

function providerProcessEnvFromShellEnv(
  shellEnv: NonNullable<AgentRuntimeOptions["shellEnv"]>,
): Record<string, string> | null {
  const env: Record<string, string> = {};
  if (shellEnv.PATH) {
    env.PATH = shellEnv.PATH;
  }
  const recordDir = process.env.BB_PROVIDER_BRIDGE_RECORD_DIR;
  if (recordDir) {
    env.BB_PROVIDER_BRIDGE_RECORD_DIR = recordDir;
  }
  return Object.keys(env).length > 0 ? env : null;
}

export class RuntimeManager {
  private readonly createRuntime;
  private readonly hostWatcher;
  private readonly provisionWorkspace;
  private baseShellEnv;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingEntries = new Map<string, Promise<RuntimeEntry>>();
  private readonly pendingCatalogHashes = new Map<string, string>();
  private readonly pendingEnvironmentProvisions = new Map<
    string,
    PendingEnvironmentProvision
  >();
  private readonly pendingWorkspaceRefreshes = new Map<
    string,
    Promise<HostWorkspace>
  >();
  private readonly inFlightThreadCommandsByEnvironmentId = new Map<
    string,
    Map<string, number>
  >();
  private readonly inFlightThreadCommandCompletionsByEnvironmentId = new Map<
    string,
    Map<string, Set<Promise<void>>>
  >();
  private readonly threadControlTails = new Map<string, Promise<void>>();
  private providerMaintenanceRuntime: AgentRuntime | null = null;
  private pendingProviderMaintenanceRuntime: PendingProviderMaintenanceRuntime | null =
    null;
  private providerMaintenanceRuntimeGeneration = 0;
  private providerMaintenanceActiveRequests = 0;
  private providerMaintenanceIdleTimer: ReturnType<typeof setTimeout> | null =
    null;
  readonly providerInstallationGate: ProviderInstallationGate;
  private stopWatchingDataDirSkillsRoot: StopWatching = STOP_WATCHING;

  constructor(private readonly options: RuntimeManagerOptions = {}) {
    this.createRuntime = options.createRuntime ?? createAgentRuntime;
    this.hostWatcher = options.hostWatcher;
    this.provisionWorkspace = options.provisionWorkspace ?? provisionWorkspace;
    this.baseShellEnv = { ...(options.shellEnv ?? {}) };
    this.providerInstallationGate = createProviderInstallationGate({
      ttlMs:
        options.providerInstallationGateTtlMs ??
        PROVIDER_INSTALLATION_GATE_TTL_MS,
    });
    this.ensureDataDirSkillsWatcher();
  }

  private runtimeWorkspaceWriteRoots(
    args: RuntimeWorkspaceWriteRootsArgs,
  ): string[] {
    const roots = [...args.workspaceRoots];
    if (args.threadStorageRootPath) {
      roots.push(args.threadStorageRootPath);
    }
    return [...new Set(roots)];
  }

  get(environmentId: string): RuntimeEntry | undefined {
    return this.entries.get(environmentId);
  }

  async getOrAwait(environmentId: string): Promise<RuntimeEntry | undefined> {
    const existing = this.entries.get(environmentId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingEntries.get(environmentId);
    if (pending) {
      return pending;
    }

    return undefined;
  }

  private enqueueThreadControl<T>(
    threadId: string,
    work: () => T | PromiseLike<T>,
  ): Promise<T> {
    const previous = this.threadControlTails.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.threadControlTails.set(threadId, settled);
    void settled.then(() => {
      if (this.threadControlTails.get(threadId) === settled) {
        this.threadControlTails.delete(threadId);
      }
    });
    return next;
  }

  async releaseThreadFromOtherEnvironments(args: {
    activeTurn: ReleaseThreadActiveTurnPolicy;
    environmentId: string;
    threadId: string;
  }): Promise<ReleaseThreadFromOtherEnvironmentsResult> {
    await this.waitForThreadCommandsInOtherEnvironments(args);
    return this.enqueueThreadControl(args.threadId, () =>
      this.releaseThreadFromOtherEnvironmentsOnce(args),
    );
  }

  private async waitForThreadCommandsInOtherEnvironments(args: {
    environmentId: string;
    threadId: string;
  }): Promise<void> {
    for (;;) {
      const inFlightOldCommands = [
        ...this.inFlightThreadCommandCompletionsByEnvironmentId.entries(),
      ].flatMap(([environmentId, commandsByThreadId]) =>
        environmentId === args.environmentId
          ? []
          : [...(commandsByThreadId.get(args.threadId) ?? [])],
      );
      if (inFlightOldCommands.length === 0) {
        return;
      }
      await Promise.all(inFlightOldCommands);
    }
  }

  private async releaseThreadFromOtherEnvironmentsOnce(args: {
    activeTurn: ReleaseThreadActiveTurnPolicy;
    environmentId: string;
    threadId: string;
  }): Promise<ReleaseThreadFromOtherEnvironmentsResult> {
    const staleEntries = [...this.entries.values()].filter(
      (entry) =>
        entry.environmentId !== args.environmentId &&
        entry.runtime.hasThread(args.threadId),
    );
    const keptEntries =
      args.activeTurn === "interrupt"
        ? []
        : staleEntries.filter(
            (entry) => entry.runtime.getActiveTurnId(args.threadId) !== null,
          );
    const releasedEntries = staleEntries.filter(
      (entry) => !keptEntries.includes(entry),
    );

    const stopResults = await Promise.all(
      releasedEntries.map((entry) =>
        entry.runtime.stopThread({ threadId: args.threadId }),
      ),
    );
    const providerCheckpointIds = new Set(
      stopResults.flatMap((result) =>
        result.providerCheckpointId === null
          ? []
          : [result.providerCheckpointId],
      ),
    );
    return {
      activeTurnEnvironmentIds: keptEntries.map((entry) => entry.environmentId),
      providerCheckpointId:
        providerCheckpointIds.size === 1
          ? (providerCheckpointIds.values().next().value ?? null)
          : null,
      releasedEnvironmentIds: releasedEntries.map(
        (entry) => entry.environmentId,
      ),
    };
  }

  listThreadOwnerEntries(threadId: string): RuntimeEntry[] {
    return [...this.entries.values()].filter((entry) =>
      entry.runtime.hasThread(threadId),
    );
  }

  markTerminalActive(environmentId: string, terminalId: string): void {
    this.entries.get(environmentId)?.terminals.add(terminalId);
  }

  markTerminalInactive(environmentId: string, terminalId: string): void {
    this.entries.get(environmentId)?.terminals.delete(terminalId);
  }

  async retainEnvironmentForThreadCommand(
    environmentId: string,
    threadId: string,
  ): Promise<() => void> {
    return this.enqueueThreadControl(threadId, () => {
      const commandsByThreadId =
        this.inFlightThreadCommandsByEnvironmentId.get(environmentId) ??
        new Map<string, number>();
      commandsByThreadId.set(
        threadId,
        (commandsByThreadId.get(threadId) ?? 0) + 1,
      );
      this.inFlightThreadCommandsByEnvironmentId.set(
        environmentId,
        commandsByThreadId,
      );

      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const completionsByThreadId =
        this.inFlightThreadCommandCompletionsByEnvironmentId.get(
          environmentId,
        ) ?? new Map<string, Set<Promise<void>>>();
      const completions =
        completionsByThreadId.get(threadId) ?? new Set<Promise<void>>();
      completions.add(completion);
      completionsByThreadId.set(threadId, completions);
      this.inFlightThreadCommandCompletionsByEnvironmentId.set(
        environmentId,
        completionsByThreadId,
      );

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;

        const activeCommands =
          this.inFlightThreadCommandsByEnvironmentId.get(environmentId);
        if (activeCommands) {
          const count = activeCommands.get(threadId) ?? 0;
          if (count <= 1) {
            activeCommands.delete(threadId);
          } else {
            activeCommands.set(threadId, count - 1);
          }
          if (activeCommands.size === 0) {
            this.inFlightThreadCommandsByEnvironmentId.delete(environmentId);
          }
        }

        const activeCompletions =
          this.inFlightThreadCommandCompletionsByEnvironmentId.get(
            environmentId,
          );
        const threadCompletions = activeCompletions?.get(threadId);
        threadCompletions?.delete(completion);
        if (threadCompletions?.size === 0) {
          activeCompletions?.delete(threadId);
        }
        if (activeCompletions?.size === 0) {
          this.inFlightThreadCommandCompletionsByEnvironmentId.delete(
            environmentId,
          );
        }
        resolveCompletion();
      };
    });
  }

  listActiveThreads(): HostDaemonActiveThread[] {
    const activeThreads: HostDaemonActiveThread[] = [];
    for (const entry of this.entries.values()) {
      for (const threadId of entry.runtime.getLiveThreadIds()) {
        activeThreads.push({
          threadId,
        });
      }
    }
    return activeThreads;
  }

  listLoadedEnvironments(): HostDaemonLoadedEnvironment[] {
    return [...this.entries.keys()].map((environmentId) => ({
      environmentId,
    }));
  }

  async reapIdleProviderSessions(
    args: RuntimeManagerReapIdleProviderSessionsArgs,
  ): Promise<RuntimeManagerReapIdleProviderSessionsResult> {
    const reapedSessions: RuntimeManagerReapedIdleProviderSession[] = [];
    for (const entry of this.entries.values()) {
      const result = await entry.runtime.reapIdleProviderSessions({
        ...args,
        runThreadExclusive: (threadId, work) =>
          this.enqueueThreadControl(threadId, () => {
            if (this.entryHasInFlightThreadCommand(entry, threadId)) {
              return null;
            }
            return work();
          }),
      });
      for (const session of result.reapedSessions) {
        reapedSessions.push({
          ...session,
          environmentId: entry.environmentId,
        });
      }
    }
    return { reapedSessions };
  }

  getShellEnv(): NonNullable<AgentRuntimeOptions["shellEnv"]> {
    return { ...this.baseShellEnv };
  }

  async replaceBaseShellEnv(
    shellEnv: NonNullable<AgentRuntimeOptions["shellEnv"]>,
  ): Promise<void> {
    if (shellEnvEquals(this.baseShellEnv, shellEnv)) {
      return;
    }

    this.baseShellEnv = { ...shellEnv };
    this.providerInstallationGate.clear();
    await this.shutdownProviderMaintenanceRuntime();
    await this.evictIdleRuntimeEntries();
  }

  private getInjectedSkillsLogger(): InjectedSkillsLogger | undefined {
    return this.options.logger;
  }

  private async resolveRuntimeSkillConfig(
    args: EnsureEnvironmentArgs,
  ): Promise<RuntimeSkillConfig | null> {
    if (args.injectedSkillSources === undefined) {
      return null;
    }
    if (args.injectedSkillSources.length === 0) {
      return {
        catalogHash: EMPTY_SKILL_CATALOG_HASH,
        skillRoots: [],
      };
    }
    if (!this.options.dataDir) {
      throw new Error("Runtime skill staging requires a host dataDir");
    }
    return stageInjectedSkillSources({
      dataDir: this.options.dataDir,
      injectedSkillSources: args.injectedSkillSources,
      ...(this.options.fetchSkillTree !== undefined
        ? { fetchSkillTree: this.options.fetchSkillTree }
        : {}),
      logger: this.getInjectedSkillsLogger(),
    });
  }

  private entryHasActiveRuntimeWork(entry: RuntimeEntry): boolean {
    return (
      entry.terminals.size > 0 ||
      entry.runtime.getLiveThreadIds().length > 0 ||
      entry.runtime.hasOpenBackgroundWork()
    );
  }

  private hasInFlightThreadCommand(
    entry: RuntimeEntry,
    excludingThreadId?: string,
  ): boolean {
    const commandsByThreadId = this.inFlightThreadCommandsByEnvironmentId.get(
      entry.environmentId,
    );
    if (!commandsByThreadId) {
      return false;
    }
    return [...commandsByThreadId.keys()].some(
      (threadId) => threadId !== excludingThreadId,
    );
  }

  private entryHasInFlightThreadCommand(
    entry: RuntimeEntry,
    threadId: string,
  ): boolean {
    return (
      this.inFlightThreadCommandsByEnvironmentId
        .get(entry.environmentId)
        ?.has(threadId) ?? false
    );
  }

  private entryHasActiveEnvironmentWork(entry: RuntimeEntry): boolean {
    return (
      this.entryHasActiveRuntimeWork(entry) ||
      this.hasInFlightThreadCommand(entry)
    );
  }

  private async cleanupUnusedInjectedSkillStagingDirs(
    pendingCatalogHashes: readonly string[],
  ): Promise<void> {
    if (!this.options.dataDir) {
      return;
    }
    try {
      await cleanupInjectedSkillStagingDirs({
        dataDir: this.options.dataDir,
        keepCatalogHashes: [
          ...pendingCatalogHashes,
          ...this.pendingCatalogHashes.values(),
          ...[...this.entries.values()].flatMap((entry) =>
            entry.skillCatalogHash === null ? [] : [entry.skillCatalogHash],
          ),
        ],
        logger: this.getInjectedSkillsLogger(),
      });
    } catch (error) {
      this.options.logger?.warn(
        {
          reason:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Unable to clean injected skill staging directories",
        },
        "Failed to clean injected skill staging directories",
      );
    }
  }

  private async replaceEntryForSkillCatalog(
    args: ReplaceEntryForSkillCatalogArgs,
  ): Promise<void> {
    if (
      this.entryHasActiveRuntimeWork(args.entry) ||
      this.hasInFlightThreadCommand(args.entry, args.targetThreadId)
    ) {
      throw new SkillCatalogConflictError({
        environmentId: args.entry.environmentId,
        activeCatalogHash: args.entry.skillCatalogHash,
        requestedCatalogHash: args.skillConfig.catalogHash,
      });
    }

    this.entries.delete(args.entry.environmentId);
    await this.stopWatchingStatus(args.entry);
    await args.entry.runtime.shutdown();
    await this.cleanupUnusedInjectedSkillStagingDirs([
      args.skillConfig.catalogHash,
    ]);
  }

  private async ensureCompatibleEntry(
    args: EnsureCompatibleEntryArgs,
  ): Promise<RuntimeEntry | null> {
    if (
      args.skillConfig === null ||
      args.entry.skillCatalogHash === args.skillConfig.catalogHash ||
      (args.entry.skillCatalogHash === null &&
        args.skillConfig.skillRoots.length === 0)
    ) {
      return args.entry;
    }

    if (
      args.targetThreadId !== undefined &&
      (this.entryHasActiveRuntimeWork(args.entry) ||
        this.hasInFlightThreadCommand(args.entry, args.targetThreadId))
    ) {
      if (
        args.entry.lastWarnedStaleSkillCatalogHash !==
        args.skillConfig.catalogHash
      ) {
        args.entry.lastWarnedStaleSkillCatalogHash =
          args.skillConfig.catalogHash;
        this.options.logger?.warn(
          {
            environmentId: args.entry.environmentId,
            threadId: args.targetThreadId,
            activeCatalogHash: args.entry.skillCatalogHash,
            requestedCatalogHash: args.skillConfig.catalogHash,
          },
          "Deferring injected skill catalog refresh for busy runtime",
        );
      }
      return args.entry;
    }

    await this.replaceEntryForSkillCatalog({
      entry: args.entry,
      skillConfig: args.skillConfig,
      ...(args.targetThreadId !== undefined
        ? { targetThreadId: args.targetThreadId }
        : {}),
    });
    return null;
  }

  async invalidateProviderMaintenanceRuntime(): Promise<void> {
    this.providerInstallationGate.clear();
    try {
      await this.shutdownProviderMaintenanceRuntime();
    } catch (error) {
      this.options.logger?.warn(
        { err: error },
        "Failed to shut down provider maintenance runtime during invalidation",
      );
    }
  }

  private async shutdownProviderMaintenanceRuntime(): Promise<void> {
    this.clearProviderMaintenanceIdleTimer();
    const existingRuntime = this.providerMaintenanceRuntime;
    const pendingRuntime = this.pendingProviderMaintenanceRuntime;
    this.providerMaintenanceRuntimeGeneration += 1;
    this.providerMaintenanceRuntime = null;
    if (this.pendingProviderMaintenanceRuntime === pendingRuntime) {
      this.pendingProviderMaintenanceRuntime = null;
    }

    const resolvedPendingRuntime = pendingRuntime
      ? await pendingRuntime.promise.catch(() => null)
      : null;
    if (
      resolvedPendingRuntime &&
      this.providerMaintenanceRuntime === resolvedPendingRuntime
    ) {
      this.providerMaintenanceRuntime = null;
    }

    const runtimes = [...new Set([existingRuntime, resolvedPendingRuntime])];
    await Promise.all(
      runtimes.map((runtime) => runtime?.shutdown() ?? Promise.resolve()),
    );
  }

  private clearProviderMaintenanceIdleTimer(): void {
    if (this.providerMaintenanceIdleTimer === null) return;
    clearTimeout(this.providerMaintenanceIdleTimer);
    this.providerMaintenanceIdleTimer = null;
  }

  private scheduleProviderMaintenanceIdleShutdown(): void {
    this.clearProviderMaintenanceIdleTimer();
    if (
      this.providerMaintenanceActiveRequests > 0 ||
      (this.providerMaintenanceRuntime === null &&
        this.pendingProviderMaintenanceRuntime === null)
    ) {
      return;
    }

    const timeoutMs =
      this.options.providerMaintenanceIdleTimeoutMs ??
      PROVIDER_MAINTENANCE_IDLE_TIMEOUT_MS;
    this.providerMaintenanceIdleTimer = setTimeout(() => {
      this.providerMaintenanceIdleTimer = null;
      if (this.providerMaintenanceActiveRequests > 0) return;
      void this.shutdownProviderMaintenanceRuntime().catch((error) => {
        this.options.logger?.warn(
          { err: error },
          "Failed to shut down idle provider maintenance runtime",
        );
      });
    }, timeoutMs);
    this.providerMaintenanceIdleTimer.unref();
  }

  private async evictIdleRuntimeEntries(): Promise<void> {
    const idleEntries = [...this.entries.values()].filter(
      (entry) => !this.entryHasActiveEnvironmentWork(entry),
    );

    for (const entry of idleEntries) {
      await this.stopWatchingStatus(entry);
      this.entries.delete(entry.environmentId);
    }

    await Promise.all(idleEntries.map((entry) => entry.runtime.shutdown()));
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  async ensureProviderMaintenanceRuntime(args: {
    dataDir: string;
  }): Promise<AgentRuntime> {
    if (this.providerMaintenanceRuntime) {
      return this.providerMaintenanceRuntime;
    }
    if (this.pendingProviderMaintenanceRuntime) {
      return this.pendingProviderMaintenanceRuntime.promise;
    }

    const generation = this.providerMaintenanceRuntimeGeneration;
    let pendingRuntime!: PendingProviderMaintenanceRuntime;
    const promise = Promise.resolve()
      .then(() => this.createProviderMaintenanceRuntime(args))
      .then((runtime) => {
        if (
          this.pendingProviderMaintenanceRuntime === pendingRuntime &&
          this.providerMaintenanceRuntimeGeneration === generation
        ) {
          this.providerMaintenanceRuntime = runtime;
        }
        return runtime;
      })
      .finally(() => {
        if (this.pendingProviderMaintenanceRuntime === pendingRuntime) {
          this.pendingProviderMaintenanceRuntime = null;
        }
      });
    pendingRuntime = {
      generation,
      promise,
    };
    this.pendingProviderMaintenanceRuntime = pendingRuntime;
    return promise;
  }

  async withProviderMaintenanceRuntime<TResult>(
    args: { dataDir: string },
    request: (runtime: AgentRuntime) => Promise<TResult>,
  ): Promise<TResult> {
    this.clearProviderMaintenanceIdleTimer();
    this.providerMaintenanceActiveRequests += 1;
    try {
      const runtime = await this.ensureProviderMaintenanceRuntime(args);
      return await request(runtime);
    } finally {
      this.providerMaintenanceActiveRequests -= 1;
      if (this.providerMaintenanceActiveRequests === 0) {
        this.scheduleProviderMaintenanceIdleShutdown();
      }
    }
  }

  async ensureEnvironment(args: EnsureEnvironmentArgs): Promise<RuntimeEntry> {
    const skillConfig = await this.resolveRuntimeSkillConfig(args);
    const existing = this.entries.get(args.environmentId);
    if (existing) {
      await this.runCancellableEnvironmentProvision({
        environmentId: args.environmentId,
        work: (signal) =>
          this.applyExistingEnvironmentProvision({
            entry: existing,
            provision: args.provision,
            signal,
          }),
      });
      const compatible = await this.ensureCompatibleEntry({
        entry: existing,
        skillConfig,
        ...(args.targetThreadId !== undefined
          ? { targetThreadId: args.targetThreadId }
          : {}),
      });
      if (compatible) {
        return compatible;
      }
    }

    const pending = this.pendingEntries.get(args.environmentId);
    if (pending) {
      const entry = await pending;
      const compatible = await this.ensureCompatibleEntry({
        entry,
        skillConfig,
        ...(args.targetThreadId !== undefined
          ? { targetThreadId: args.targetThreadId }
          : {}),
      });
      if (compatible) {
        return compatible;
      }
    }

    const pendingProvision = this.createPendingEnvironmentProvision(
      args.environmentId,
    );
    const creation = Promise.resolve()
      .then(() =>
        this.createEntry({
          ...args,
          provisionSignal: pendingProvision.abortController.signal,
          skillConfig,
        }),
      )
      .then((entry) => {
        this.entries.set(args.environmentId, entry);
        return entry;
      })
      .finally(() => {
        this.pendingEntries.delete(args.environmentId);
        this.pendingCatalogHashes.delete(args.environmentId);
        this.clearPendingEnvironmentProvision(
          args.environmentId,
          pendingProvision,
        );
      });
    pendingProvision.done = creation;
    this.pendingEntries.set(args.environmentId, creation);
    if (skillConfig !== null) {
      this.pendingCatalogHashes.set(
        args.environmentId,
        skillConfig.catalogHash,
      );
    }

    return creation;
  }

  async refreshEnvironmentWorkspace(
    args: RefreshEnvironmentWorkspaceArgs,
  ): Promise<HostWorkspace> {
    const pending = this.pendingWorkspaceRefreshes.get(args.environmentId);
    if (pending) {
      return pending;
    }

    const refresh = this.refreshEnvironmentWorkspaceOnce(args).finally(() => {
      if (this.pendingWorkspaceRefreshes.get(args.environmentId) === refresh) {
        this.pendingWorkspaceRefreshes.delete(args.environmentId);
      }
    });
    this.pendingWorkspaceRefreshes.set(args.environmentId, refresh);
    return refresh;
  }

  private async refreshEnvironmentWorkspaceOnce(
    args: RefreshEnvironmentWorkspaceArgs,
  ): Promise<HostWorkspace> {
    const entry = await this.getOrAwait(args.environmentId);
    if (entry && entry.path !== args.workspacePath) {
      throw new Error(
        `Cannot refresh environment ${args.environmentId} at ${args.workspacePath}; it is bound to ${entry.path}`,
      );
    }

    const workspace = await this.provisionHostWorkspace(args.provision);
    if (workspace.path !== args.workspacePath) {
      throw new Error(
        `Workspace refresh for ${args.environmentId} returned ${workspace.path}, not ${args.workspacePath}`,
      );
    }
    if (entry) {
      entry.workspace = workspace;
    }
    return workspace;
  }

  async cancelEnvironmentProvision(
    args: CancelEnvironmentProvisionArgs,
  ): Promise<CancelEnvironmentProvisionResult> {
    const pending = this.pendingEnvironmentProvisions.get(args.environmentId);
    if (!pending) {
      return { aborted: false };
    }

    pending.abortController.abort(
      new WorkspaceError(
        "provision_cancelled",
        "Environment provisioning was cancelled",
      ),
    );
    return { aborted: true };
  }

  private async runCancellableEnvironmentProvision(
    args: RunCancellableEnvironmentProvisionArgs,
  ): Promise<void> {
    const existing = this.pendingEnvironmentProvisions.get(args.environmentId);
    if (existing) {
      await existing.done;
      return;
    }

    const pending = this.createPendingEnvironmentProvision(args.environmentId);
    const done = Promise.resolve().then(() =>
      args.work(pending.abortController.signal),
    );
    pending.done = done;
    try {
      return await done;
    } finally {
      this.clearPendingEnvironmentProvision(args.environmentId, pending);
    }
  }

  private createPendingEnvironmentProvision(
    environmentId: string,
  ): PendingEnvironmentProvision {
    const pending: PendingEnvironmentProvision = {
      abortController: new AbortController(),
      done: Promise.resolve(),
    };
    this.pendingEnvironmentProvisions.set(environmentId, pending);
    return pending;
  }

  private clearPendingEnvironmentProvision(
    environmentId: string,
    pending: PendingEnvironmentProvision,
  ): void {
    if (this.pendingEnvironmentProvisions.get(environmentId) === pending) {
      this.pendingEnvironmentProvisions.delete(environmentId);
    }
  }

  private async applyExistingEnvironmentProvision(
    args: ApplyExistingEnvironmentProvisionArgs,
  ): Promise<void> {
    if (
      args.provision?.workspaceProvisionType !== "unmanaged" ||
      !args.provision.checkout
    ) {
      return;
    }
    if (args.provision.path !== args.entry.path) {
      throw new Error(
        `Cannot reprovision existing environment ${args.entry.environmentId} at a different path`,
      );
    }

    await this.provisionHostWorkspace({
      ...args.provision,
      signal: args.signal,
    });
    this.options.onWorkspaceStatusChanged?.({
      environmentId: args.entry.environmentId,
      changeKinds: ["work-status-changed", "git-refs-changed"],
    });
  }

  async destroyEnvironment(
    environmentId: string,
    args: DestroyWorkspaceArgs,
  ): Promise<void> {
    const existing = this.entries.get(environmentId);
    const pending = this.pendingEntries.get(environmentId);
    const entry = existing ?? (pending ? await pending : undefined);

    if (!entry) {
      return;
    }

    this.entries.delete(environmentId);
    await this.stopWatchingStatus(entry);
    await entry.runtime.shutdown();
    await this.killManagedWorkspaceProcesses(entry);
    await entry.workspace.destroy(args);
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  private async killManagedWorkspaceProcesses(
    entry: RuntimeEntry,
  ): Promise<void> {
    if (!entry.workspace.managed) {
      return;
    }
    try {
      const killed = await killProcessesWithCwdUnder({
        directory: entry.workspace.path,
      });
      if (killed.length > 0) {
        this.options.logger?.warn(
          {
            environmentId: entry.environmentId,
            workspacePath: entry.workspace.path,
            pids: killed.map((process) => process.pid),
          },
          "Killed processes still running in a destroyed environment",
        );
      }
    } catch (error) {
      this.options.logger?.warn(
        {
          environmentId: entry.environmentId,
          reason: error instanceof Error ? error.message : String(error),
        },
        "Failed to reap processes in a destroyed environment",
      );
    }
  }

  async forgetEnvironment(environmentId: string): Promise<void> {
    const existing = this.entries.get(environmentId);
    const pending = this.pendingEntries.get(environmentId);
    let entry = existing;
    if (!entry && pending) {
      try {
        entry = await pending;
      } catch {
        entry = undefined;
      }
    }

    if (!entry) {
      return;
    }

    this.entries.delete(environmentId);
    await this.stopWatchingStatus(entry);
    await entry.runtime.shutdown();
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  async evictIdleEnvironments(): Promise<string[]> {
    if (this.pendingEntries.size > 0) {
      return [];
    }

    const idleEntries = [...this.entries.values()].filter(
      (entry) => !this.entryHasActiveEnvironmentWork(entry),
    );

    for (const entry of idleEntries) {
      await this.stopWatchingStatus(entry);
      this.entries.delete(entry.environmentId);
    }

    const shutdownResults = await Promise.allSettled(
      idleEntries.map(async (entry) => {
        await entry.runtime.shutdown();
        return entry.environmentId;
      }),
    );
    const firstRejected = shutdownResults.find(
      (result) => result.status === "rejected",
    );
    if (firstRejected && firstRejected.status === "rejected") {
      throw firstRejected.reason;
    }

    await this.cleanupUnusedInjectedSkillStagingDirs([]);
    return shutdownResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
  }

  async shutdownAll(): Promise<void> {
    const entries = [...this.entries.values()];
    for (const pending of this.pendingEntries.values()) {
      try {
        entries.push(await pending);
      } catch {}
    }
    this.entries.clear();
    this.pendingEntries.clear();

    for (const entry of entries) {
      await this.stopWatchingStatus(entry);
      await entry.runtime.shutdown();
    }
    await this.shutdownProviderMaintenanceRuntime();
    await this.stopWatchingDataDirSkillsRoot();
    this.stopWatchingDataDirSkillsRoot = STOP_WATCHING;
    await this.cleanupUnusedInjectedSkillStagingDirs([]);
  }

  private buildUnexpectedProviderExitEvents(
    info: AgentRuntimeProcessExitInfo,
  ): ThreadEvent[] {
    const message = buildProviderProcessExitMessage(info);
    const detail = buildProviderProcessExitDetail(info);
    const events: ThreadEvent[] = [];

    for (const thread of info.threads) {
      if (thread.activeTurnId === null) {
        if (thread.pendingTurnStart) {
          events.push({
            type: "system/error",
            threadId: thread.threadId,
            scope: threadScope(),
            code: "provider_process_exited",
            message,
            ...(detail ? { detail } : {}),
          });
        }
        continue;
      }

      if (thread.providerThreadId === null) {
        continue;
      }

      events.push({
        type: "turn/completed",
        threadId: thread.threadId,
        providerThreadId: thread.providerThreadId,
        scope: turnScope(thread.activeTurnId),
        status: "failed",
        error: { message },
      });
      events.push({
        type: "system/error",
        threadId: thread.threadId,
        scope: turnScope(thread.activeTurnId),
        code: "provider_process_exited",
        message,
        ...(detail ? { detail } : {}),
      });
    }

    return events;
  }

  private async createProviderMaintenanceRuntime(args: {
    dataDir: string;
  }): Promise<AgentRuntime> {
    const workspacePath = path.join(
      args.dataDir,
      PROVIDER_MAINTENANCE_WORKSPACE_DIR,
    );
    await mkdir(workspacePath, { recursive: true });

    let runtime: AgentRuntime | null = null;
    const shellEnv = this.getShellEnv();
    const providerProcessEnv = providerProcessEnvFromShellEnv(shellEnv);
    runtime = this.createRuntime({
      workspacePath,
      additionalWorkspaceWriteRoots: [],
      ...(providerProcessEnv ? { env: providerProcessEnv } : {}),
      shellEnv,
      threadStorageRootPath: this.options.threadStorageRootPath ?? undefined,
      bridgeBundleDir: this.options.bridgeBundleDir,
      onEvent: (event) => {
        this.options.onStderr?.(
          `Dropping provider maintenance event ${event.type}; no environment owns provider-only maintenance commands.`,
          event.threadId,
        );
      },
      onToolCall:
        this.options.onToolCall ??
        (async () => ({
          contentItems: [],
          success: true,
        })),
      onInteractiveRequest: this.options.onInteractiveRequest,
      onStderr: this.options.onStderr,
      onProcessExit: (info) => {
        if (
          runtime &&
          this.providerMaintenanceRuntime === runtime &&
          runtime.listRunningProviders().length === 0
        ) {
          this.providerMaintenanceRuntime = null;
        }
        this.options.onProcessExit?.(info);
      },
    });
    return runtime;
  }

  private async createEntry(args: CreateEntryArgs): Promise<RuntimeEntry> {
    const provision =
      args.provision ??
      (args.workspacePath
        ? reconnectProvisionArgs({
            environmentId: args.environmentId,
            ...(args.personalWorkspaceRoot !== undefined
              ? { personalWorkspaceRoot: args.personalWorkspaceRoot }
              : {}),
            workspacePath: args.workspacePath,
            workspaceProvisionType: args.workspaceProvisionType ?? "unmanaged",
          })
        : null);

    if (!provision) {
      throw new Error(
        `Missing workspace path for environment ${args.environmentId}`,
      );
    }

    const workspace = await this.provisionHostWorkspace({
      ...provision,
      signal: args.provisionSignal,
    });
    const workspaceWriteRoots =
      await workspace.getAdditionalWorkspaceWriteRoots();
    const additionalWorkspaceWriteRoots = this.runtimeWorkspaceWriteRoots({
      threadStorageRootPath: this.options.threadStorageRootPath,
      workspaceRoots: workspaceWriteRoots,
    });
    let runtime: AgentRuntime | null = null;
    const shellEnv = this.getShellEnv();
    const providerProcessEnv = providerProcessEnvFromShellEnv(shellEnv);
    runtime = this.createRuntime({
      workspacePath: workspace.path,
      additionalWorkspaceWriteRoots,
      ...(args.skillConfig ? { skillRoots: args.skillConfig.skillRoots } : {}),
      ...(providerProcessEnv ? { env: providerProcessEnv } : {}),
      shellEnv,
      threadStorageRootPath: this.options.threadStorageRootPath ?? undefined,
      bridgeBundleDir: this.options.bridgeBundleDir,
      onEvent: (event) => {
        this.options.onEvent?.({
          environmentId: args.environmentId,
          event,
        });
      },
      onToolCall:
        this.options.onToolCall ??
        (async () => ({
          contentItems: [],
          success: true,
        })),
      onInteractiveRequest: this.options.onInteractiveRequest,
      onStderr: this.options.onStderr,
      onProviderRecovery: (hint) => {
        this.options.logger?.debug(
          {
            environmentId: args.environmentId,
            providerId: hint.providerId,
            threadId: hint.threadId,
            kind: hint.kind,
            retryable: hint.retryable,
            message: hint.message,
          },
          "Provider bridge raised a recovery hint",
        );
      },
      onProcessExit: (info) => {
        if (!info.expected) {
          for (const event of this.buildUnexpectedProviderExitEvents(info)) {
            this.options.onEvent?.({
              environmentId: args.environmentId,
              event,
            });
          }
        }
        const current = this.entries.get(args.environmentId);
        if (
          !info.expected &&
          current?.runtime === runtime &&
          runtime.listRunningProviders().length === 0
        ) {
          this.entries.delete(args.environmentId);
        }
        this.options.onProcessExit?.(info);
      },
    });

    return {
      environmentId: args.environmentId,
      runtime,
      skillCatalogHash: args.skillConfig?.catalogHash ?? null,
      lastWarnedStaleSkillCatalogHash: null,
      stopWatchingStatus: STOP_WATCHING,
      terminals: new Set<string>(),
      workspace,
      path: workspace.path,
    };
  }

  private provisionHostWorkspace(
    provision: ProvisionWorkspaceArgs,
  ): Promise<HostWorkspace> {
    return this.provisionWorkspace({
      ...provision,
      ...userExecutableProcessOptions(this.getShellEnv()),
    });
  }

  private async stopWatchingStatus(entry: RuntimeEntry): Promise<void> {
    const stopWatchingStatus = entry.stopWatchingStatus;
    entry.stopWatchingStatus = STOP_WATCHING;
    await stopWatchingStatus();
  }

  private ensureDataDirSkillsWatcher(): void {
    if (
      !this.hostWatcher?.watchDataDirSkillsRoot ||
      this.stopWatchingDataDirSkillsRoot !== STOP_WATCHING
    ) {
      return;
    }

    const dataDirSkillsRootPath = this.options.dataDirSkillsRootPath;
    if (!dataDirSkillsRootPath) {
      return;
    }

    this.stopWatchingDataDirSkillsRoot =
      this.hostWatcher.watchDataDirSkillsRoot({
        dataDirSkillsRootPath,
        onChange: (event) => {
          this.options.onInjectedSkillsChanged?.({
            changedPaths: event.changedPaths,
            sourceType: event.sourceType,
          });
        },
        onWatchError: (error) => {
          this.options.onDataDirSkillsWatchError?.({
            error,
          });
        },
      });
  }
}
