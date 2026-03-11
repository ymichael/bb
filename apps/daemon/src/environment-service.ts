import {
  type ThreadWorkStatus,
  type EnvironmentProvisioningEvent,
  type PrimaryCheckoutStatus,
  type SystemEnvironmentInfo,
  type Thread,
  type ThreadChangeKind,
  type ThreadEnvironmentStartReason,
} from "@beanbag/agent-core";
import {
  type CreateEnvironmentContext,
  type EnvironmentCheckoutSnapshot,
  type EnvironmentRegistry,
  type IEnvironment,
} from "@beanbag/environment";
import {
  removeEnvironmentAgentDefaultLogArtifacts,
  type EnvironmentAgentClient,
  type EnvironmentAgentConnectionTarget,
} from "@beanbag/environment-agent";
import type { ProjectRepository, ThreadRepository } from "@beanbag/db";
import {
  resolveProjectCheckoutSnapshotAsync,
  resolveProjectDefaultBranchCheckoutAsync,
} from "./git-project.js";

export interface ActiveEnvironmentRuntime {
  environment: IEnvironment;
  agentConnectionTarget: EnvironmentAgentConnectionTarget;
  stopWatchingWorkspaceStatus?: () => void;
}

export interface EnvironmentAgentControlConnection {
  client: EnvironmentAgentClient;
  providerLaunch?: {
    command: string;
    args: string[];
  };
}

export interface PrimaryPromotionState {
  projectId: string;
  threadId: string;
  promotedAt: number;
  previousCheckout?: EnvironmentCheckoutSnapshot;
  promotedCheckout: EnvironmentCheckoutSnapshot;
  reconstructed: boolean;
}

interface EnvironmentServiceCallbacks {
  createContext: (threadId: string, projectRootPath: string) => CreateEnvironmentContext;
  onProvisioningEvent: (threadId: string, event: EnvironmentProvisioningEvent) => void;
  onThreadChanged: (threadId: string, changes: readonly ThreadChangeKind[]) => void;
  onCleanupFailure: (threadId: string, environmentId: string, error: unknown) => void;
  onPrimaryCheckoutDemoted: (args: {
    projectId: string;
    threadId: string;
    currentCheckout: EnvironmentCheckoutSnapshot;
  }) => void;
  runOptionalSetup: (
    threadId: string,
    environment: IEnvironment,
    reason: ThreadEnvironmentStartReason,
  ) => Promise<void>;
  spawnProviderProcess: (args: {
    threadId: string;
    projectId?: string;
    agentConnectionTarget: EnvironmentAgentConnectionTarget;
  }) => EnvironmentAgentControlConnection | Promise<EnvironmentAgentControlConnection>;
}

function isUnavailableCleanupTargetError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("workspace is unavailable");
}

function checkoutSnapshotsMatch(
  left: EnvironmentCheckoutSnapshot,
  right: EnvironmentCheckoutSnapshot,
): boolean {
  const branchMatches =
    Boolean(left.branch) &&
    Boolean(right.branch) &&
    left.branch === right.branch;
  const detachedHeadMatches =
    left.detached &&
    right.detached &&
    left.head === right.head;
  return branchMatches || detachedHeadMatches;
}

export class EnvironmentService {
  readonly environmentRuntimes = new Map<string, ActiveEnvironmentRuntime>();
  readonly primaryPromotionByProjectId = new Map<string, PrimaryPromotionState>();
  readonly primaryPromotionValidatedAtByProjectId = new Map<string, number>();
  readonly primaryPromotionWatchersByProjectId = new Map<string, () => void>();
  readonly primaryPromotionRefreshByProjectId = new Map<string, Promise<void>>();
  readonly workspaceCleanupInFlightThreadIds = new Set<string>();
  readonly restoreFailuresByThreadId = new Map<string, string>();

  constructor(
    private readonly threadRepo: ThreadRepository,
    private readonly projectRepo: ProjectRepository,
    private readonly environmentRegistry: EnvironmentRegistry,
    private readonly callbacks: EnvironmentServiceCallbacks,
  ) {}

  listEnvironments(): SystemEnvironmentInfo[] {
    return this.environmentRegistry.list().map((environment: SystemEnvironmentInfo) => ({
      ...environment,
    }));
  }

  resolveRequestedEnvironmentId(value?: string): string {
    const normalized = (value ?? process.env.BEANBAG_ENVIRONMENT ?? "local").trim();
    if (!normalized) return "local";
    if (!this.environmentRegistry.has(normalized)) {
      throw new Error(`Unsupported environment "${normalized}"`);
    }
    return normalized;
  }

  restoreThreadEnvironment(thread: Thread, projectRootPath: string): IEnvironment | undefined {
    const runtime = this.environmentRuntimes.get(thread.id);
    if (runtime) {
      this.restoreFailuresByThreadId.delete(thread.id);
      return runtime.environment;
    }
    const environmentRecord = thread.environmentRecord;
    if (!environmentRecord) {
      this.restoreFailuresByThreadId.delete(thread.id);
      return undefined;
    }
    try {
      const restored = this.environmentRegistry.restore(
        environmentRecord,
        this.callbacks.createContext(thread.id, projectRootPath),
      );
      this.restoreFailuresByThreadId.delete(thread.id);
      return restored;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.restoreFailuresByThreadId.set(thread.id, message);
      throw error;
    }
  }

  getRestoreFailure(threadId: string): string | undefined {
    return this.restoreFailuresByThreadId.get(threadId);
  }

  getEnvironmentRuntime(threadId: string): ActiveEnvironmentRuntime | undefined {
    return this.environmentRuntimes.get(threadId);
  }

  async getProjectWorkspaceStatusAsync(projectId: string, rootPath: string): Promise<ThreadWorkStatus> {
    const environment = this.environmentRegistry.create(
      "local",
      this.callbacks.createContext(`project-status:${projectId}`, rootPath),
    );
    try {
      return environment.getWorkspaceStatusAsync
        ? await environment.getWorkspaceStatusAsync()
        : environment.getWorkspaceStatus();
    } finally {
      void environment.destroy();
    }
  }

  private async prepareEnvironment(
    threadId: string,
    environment: IEnvironment,
    reason: ThreadEnvironmentStartReason,
  ): Promise<{ existedBeforePrepare: boolean }> {
    const existedBeforePrepare = environment.exists();
    if (typeof environment.prepare === "function") {
      await environment.prepare();
    }
    if (!existedBeforePrepare) {
      await this.callbacks.runOptionalSetup(threadId, environment, reason);
    }
    return { existedBeforePrepare };
  }

  async provisionThreadEnvironment(
    threadId: string,
    projectRootPath: string,
    environmentKind: string,
    reason: ThreadEnvironmentStartReason,
  ): Promise<ActiveEnvironmentRuntime> {
    const environment = this.environmentRegistry.create(
      environmentKind,
      this.callbacks.createContext(threadId, projectRootPath),
    );
    try {
      await this.prepareEnvironment(threadId, environment, reason);
    } catch (error) {
      try {
        await Promise.resolve(environment.destroy());
      } catch {
        // Best-effort cleanup for partially provisioned environments.
      }
      throw error;
    }

    this.setEnvironmentRuntime(threadId, environment);
    const thread = this.threadRepo.getById(threadId);
    const runtime = this.environmentRuntimes.get(threadId);
    if (!runtime) {
      throw new Error(`Missing environment runtime for thread ${threadId}`);
    }
    return runtime;
  }

  async ensureThreadEnvironmentRuntime(
    thread: Thread,
    projectRootPath: string,
    reason: ThreadEnvironmentStartReason,
  ): Promise<{ runtime: ActiveEnvironmentRuntime; resetReplayCursor: boolean }> {
    const existingRuntime = this.environmentRuntimes.get(thread.id);
    if (existingRuntime) {
      return { runtime: existingRuntime, resetReplayCursor: false };
    }

    const environmentId = thread.environmentRecord?.kind ?? thread.environmentId ?? "local";
    const environment =
      this.restoreThreadEnvironment(thread, projectRootPath) ??
      this.environmentRegistry.create(
        environmentId,
        this.callbacks.createContext(thread.id, projectRootPath),
      );

    let hadAgentTarget = false;
    try {
      environment.getAgentConnectionTarget();
      hadAgentTarget = true;
    } catch {
      hadAgentTarget = false;
    }

    try {
      await this.prepareEnvironment(thread.id, environment, reason);
    } catch (error) {
      try {
        await Promise.resolve(environment.destroy());
      } catch {
        // Best-effort cleanup for partially restored environments.
      }
      throw error;
    }

    this.setEnvironmentRuntime(thread.id, environment);
    const runtime = this.environmentRuntimes.get(thread.id);
    if (!runtime) {
      throw new Error(`Missing environment runtime for thread ${thread.id}`);
    }
    return {
      runtime,
      resetReplayCursor: thread.status === "idle" && !hadAgentTarget,
    };
  }

  setEnvironmentRuntime(threadId: string, environment: IEnvironment): void {
    this.suspendEnvironmentRuntime(threadId);
    const agentConnectionTarget = environment.getAgentConnectionTarget();
    const stopWatchingWorkspaceStatus = environment.watchWorkspaceStatus(() => {
      if (!this.threadRepo.getById(threadId)) {
        return;
      }
      this.callbacks.onThreadChanged(threadId, ["work-status-changed"]);
    });
    this.environmentRuntimes.set(threadId, {
      environment,
      agentConnectionTarget,
      stopWatchingWorkspaceStatus,
    });
  }

  detachEnvironmentRuntime(threadId: string): ActiveEnvironmentRuntime | undefined {
    const runtime = this.environmentRuntimes.get(threadId);
    if (runtime) {
      runtime.stopWatchingWorkspaceStatus?.();
      this.environmentRuntimes.delete(threadId);
    }
    return runtime;
  }

  suspendEnvironmentRuntime(threadId: string): void {
    const runtime = this.detachEnvironmentRuntime(threadId);
    if (!runtime) return;

    const environmentId = runtime.environment.kind;
    try {
      void Promise.resolve(runtime.environment.suspend()).catch((error: unknown) =>
        this.callbacks.onCleanupFailure(threadId, environmentId, error),
      );
    } catch (error) {
      this.callbacks.onCleanupFailure(threadId, environmentId, error);
    }
  }

  async destroyThreadEnvironment(threadId: string): Promise<void> {
    const runtime = this.environmentRuntimes.get(threadId);

    this.workspaceCleanupInFlightThreadIds.add(threadId);
    const refresh = () => {
      this.workspaceCleanupInFlightThreadIds.delete(threadId);
      if (this.threadRepo.getById(threadId)) {
        this.callbacks.onThreadChanged(threadId, ["work-status-changed"]);
      }
    };

    const reportFailure = (environmentId: string, error: unknown) => {
      this.callbacks.onCleanupFailure(threadId, environmentId, error);
    };

    try {
      if (!runtime) {
        try {
          await this.destroyPersistedEnvironment(threadId);
        } catch (error) {
          reportFailure(this.threadRepo.getById(threadId)?.environmentId ?? "unknown", error);
          throw error;
        }
        return;
      }

      const environmentId = runtime.environment.kind;
      try {
        await Promise.resolve(runtime.environment.destroy());
        this.detachEnvironmentRuntime(threadId);
        this.clearPersistedEnvironmentState(threadId);
      } catch (error) {
        reportFailure(environmentId, error);
        throw error;
      }
    } finally {
      refresh();
    }
  }

  destroyEnvironmentRuntime(threadId: string): void {
    void this.destroyThreadEnvironment(threadId).catch(() => {
      // Errors are already reported via onCleanupFailure.
    });
  }

  async destroyPersistedEnvironment(threadId: string): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return;
    let environment: IEnvironment | undefined;
    try {
      environment = this.restoreThreadEnvironment(thread, project.rootPath);
    } catch (error) {
      if (isUnavailableCleanupTargetError(error)) {
        this.clearPersistedEnvironmentState(threadId);
        return;
      }
      throw error;
    }
    if (!environment) {
      return;
    }
    await Promise.resolve(environment.destroy());
    this.clearPersistedEnvironmentState(threadId);
  }

  private clearPersistedEnvironmentState(threadId: string): void {
    this.threadRepo.update(
      threadId,
      {
        environmentRecord: null,
        environmentAgentCursor: null,
      },
      { touchUpdatedAt: false },
    );
    this.restoreFailuresByThreadId.delete(threadId);
  }

  removeManagedThreadLogs(
    thread: Pick<Thread, "id" | "projectId" | "environmentId">,
  ): void {
    const environmentId = thread.environmentId?.trim();
    if (!environmentId) {
      return;
    }

    try {
      removeEnvironmentAgentDefaultLogArtifacts({
        projectId: thread.projectId,
        threadId: thread.id,
        environmentId,
      });
    } catch (error) {
      this.callbacks.onCleanupFailure(thread.id, environmentId, error);
      throw error;
    }
  }

  rebuildPrimaryPromotionStateFromGit(): void {
    void this.rebuildPrimaryPromotionStateFromGitAsync();
  }

  async rebuildPrimaryPromotionStateFromGitAsync(): Promise<void> {
    this.stopAllPrimaryPromotionWatches();
    this.primaryPromotionByProjectId.clear();
    this.primaryPromotionValidatedAtByProjectId.clear();
    const projects = this.projectRepo.list();
    if (!Array.isArray(projects) || projects.length === 0) return;

    await Promise.all(
      projects.map((project) =>
        this.reconstructPrimaryPromotionStateForProject(project.id, { force: true })
      ),
    );
  }

  setPrimaryPromotionState(projectId: string, state: PrimaryPromotionState): void {
    this.projectRepo.update(
      projectId,
      { primaryCheckoutThreadId: state.threadId },
      { touchUpdatedAt: false },
    );
    this.primaryPromotionByProjectId.set(projectId, state);
    this.primaryPromotionValidatedAtByProjectId.set(projectId, Date.now());
    this.startPrimaryPromotionWatch(projectId);
  }

  clearPrimaryPromotionState(
    projectId: string,
    opts?: { persist?: boolean },
  ): PrimaryPromotionState | undefined {
    if (opts?.persist !== false) {
      this.projectRepo.update(
        projectId,
        { primaryCheckoutThreadId: null },
        { touchUpdatedAt: false },
      );
    }
    const existing = this.primaryPromotionByProjectId.get(projectId);
    this.primaryPromotionByProjectId.delete(projectId);
    this.primaryPromotionValidatedAtByProjectId.delete(projectId);
    this.stopPrimaryPromotionWatch(projectId);
    return existing;
  }

  ensurePrimaryPromotionStateIsCurrent(
    projectId: string,
    opts?: { force?: boolean; ttlMs?: number },
  ): void {
    void this.ensurePrimaryPromotionStateIsCurrentAsync(projectId, opts);
  }

  async ensurePrimaryPromotionStateIsCurrentAsync(
    projectId: string,
    opts?: { force?: boolean; ttlMs?: number },
  ): Promise<void> {
    const existingRefresh = this.primaryPromotionRefreshByProjectId.get(projectId);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }
    const refresh = this._ensurePrimaryPromotionStateIsCurrentAsync(projectId, opts)
      .finally(() => {
        this.primaryPromotionRefreshByProjectId.delete(projectId);
      });
    this.primaryPromotionRefreshByProjectId.set(projectId, refresh);
    await refresh;
  }

  private async _ensurePrimaryPromotionStateIsCurrentAsync(
    projectId: string,
    opts?: { force?: boolean; ttlMs?: number },
  ): Promise<void> {
    const now = Date.now();
    const ttlMs = opts?.ttlMs ?? 2_000;
    const active = this.primaryPromotionByProjectId.get(projectId);
    const lastValidatedAt = this.primaryPromotionValidatedAtByProjectId.get(projectId) ?? 0;
    if (!opts?.force && now - lastValidatedAt < ttlMs) {
      return;
    }
    if (!active) {
      await this.reconstructPrimaryPromotionStateForProject(projectId, {
        force: opts?.force,
        ttlMs,
      });
      return;
    }
    this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
    const project = this.projectRepo.getById(projectId);
    if (!project) {
      this.clearPrimaryPromotionState(projectId);
      return;
    }
    let currentCheckout: EnvironmentCheckoutSnapshot;
    try {
      currentCheckout = await resolveProjectCheckoutSnapshotAsync(project.rootPath);
    } catch {
      return;
    }
    if (checkoutSnapshotsMatch(currentCheckout, active.promotedCheckout)) {
      return;
    }
    const cleared = this.clearPrimaryPromotionState(projectId);
    this.callbacks.onPrimaryCheckoutDemoted({
      projectId,
      threadId: cleared?.threadId ?? active.threadId,
      currentCheckout,
    });
  }

  private async reconstructPrimaryPromotionStateForProject(
    projectId: string,
    opts?: { force?: boolean; ttlMs?: number },
  ): Promise<void> {
    const now = Date.now();
    const ttlMs = opts?.ttlMs ?? 2_000;
    const lastValidatedAt = this.primaryPromotionValidatedAtByProjectId.get(projectId) ?? 0;
    if (!opts?.force && now - lastValidatedAt < ttlMs) {
      return;
    }

    const project = this.projectRepo.getById(projectId);
    if (!project) {
      this.clearPrimaryPromotionState(projectId);
      return;
    }

    let projectCheckout: EnvironmentCheckoutSnapshot;
    try {
      projectCheckout = await resolveProjectCheckoutSnapshotAsync(project.rootPath);
    } catch {
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }

    const primaryThreadId = project.primaryCheckoutThreadId;
    if (!primaryThreadId) {
      this.clearPrimaryPromotionState(projectId, { persist: false });
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }

    const thread = this.threadRepo.getById(primaryThreadId);
    if (!thread || thread.archivedAt !== undefined || thread.projectId !== project.id) {
      this.clearPrimaryPromotionState(projectId);
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }

    const environment = this.restoreThreadEnvironment(thread, project.rootPath);
    if (!environment || !environment.exists() || !environment.isIsolatedWorkspace()) {
      this.clearPrimaryPromotionState(projectId);
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }
    let workspaceCheckout: EnvironmentCheckoutSnapshot;
    try {
      workspaceCheckout = environment.getCheckoutSnapshotAsync
        ? await environment.getCheckoutSnapshotAsync()
        : environment.getCheckoutSnapshot();
    } catch {
      this.clearPrimaryPromotionState(projectId);
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }
    if (!checkoutSnapshotsMatch(projectCheckout, workspaceCheckout)) {
      const cleared = this.clearPrimaryPromotionState(projectId);
      this.callbacks.onPrimaryCheckoutDemoted({
        projectId,
        threadId: cleared?.threadId ?? thread.id,
        currentCheckout: projectCheckout,
      });
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }
    this.setPrimaryPromotionState(project.id, {
      projectId: project.id,
      threadId: thread.id,
      promotedAt: Date.now(),
      promotedCheckout: workspaceCheckout,
      reconstructed: true,
    });
  }

  getPrimaryCheckoutStatus(projectId: string): PrimaryCheckoutStatus {
    const active = this.primaryPromotionByProjectId.get(projectId);
    if (!active) {
      return { projectId };
    }
    return {
      projectId,
      activeThreadId: active.threadId,
      promotedAt: active.promotedAt,
    };
  }

  async promoteThreadEnvironment(args: {
    thread: Thread;
    ttlMs?: number;
  }): Promise<{
    promoted: boolean;
    status: PrimaryCheckoutStatus;
    state?: PrimaryPromotionState;
    reason?: "already-promoted-same-thread" | "already-promoted-other-thread";
  }> {
    const project = this.projectRepo.getById(args.thread.projectId);
    if (!project) {
      throw new Error(`Project not found: ${args.thread.projectId}`);
    }
    await this.ensurePrimaryPromotionStateIsCurrentAsync(project.id, {
      force: true,
      ttlMs: args.ttlMs,
    });
    const existing = this.primaryPromotionByProjectId.get(project.id);
    if (existing) {
      return {
        promoted: false,
        status: this.getPrimaryCheckoutStatus(project.id),
        state: existing,
        reason:
          existing.threadId === args.thread.id
            ? "already-promoted-same-thread"
            : "already-promoted-other-thread",
      };
    }
    const environment = this.restoreThreadEnvironment(args.thread, project.rootPath);
    if (!environment || !environment.supportsPromoteToActiveWorkspace()) {
      throw new Error("Promotion is not supported for this environment");
    }
    if (!environment.isIsolatedWorkspace() || !environment.exists()) {
      throw new Error("Thread worktree is unavailable; reprovision the thread first");
    }
    const promoted = environment.promoteToActiveWorkspaceAsync
      ? await environment.promoteToActiveWorkspaceAsync({
          activeWorkspaceRoot: project.rootPath,
        })
      : environment.promoteToActiveWorkspace({
          activeWorkspaceRoot: project.rootPath,
        });
    const state: PrimaryPromotionState = {
      projectId: project.id,
      threadId: args.thread.id,
      promotedAt: Date.now(),
      previousCheckout: promoted.previousCheckout,
      promotedCheckout: promoted.promotedCheckout,
      reconstructed: false,
    };
    this.setPrimaryPromotionState(project.id, state);
    return {
      promoted: true,
      status: this.getPrimaryCheckoutStatus(project.id),
      state,
    };
  }

  async demotePrimaryCheckout(args: {
    thread: Thread;
    ttlMs?: number;
  }): Promise<{
    demoted: boolean;
    status: PrimaryCheckoutStatus;
    snapshot?: EnvironmentCheckoutSnapshot;
    activeThreadId?: string;
  }> {
    const project = this.projectRepo.getById(args.thread.projectId);
    if (!project) {
      throw new Error(`Project not found: ${args.thread.projectId}`);
    }
    await this.ensurePrimaryPromotionStateIsCurrentAsync(project.id, {
      force: true,
      ttlMs: args.ttlMs,
    });
    const active = this.primaryPromotionByProjectId.get(project.id);
    if (!active) {
      return { demoted: false, status: this.getPrimaryCheckoutStatus(project.id) };
    }
    if (active.threadId !== args.thread.id) {
      throw new Error(`Thread ${active.threadId} is currently promoted in primary checkout`);
    }
    const activeThread = this.threadRepo.getById(active.threadId);
    const environment = activeThread
      ? this.restoreThreadEnvironment(activeThread, project.rootPath)
      : undefined;
    if (!environment || !environment.supportsDemoteFromActiveWorkspace()) {
      throw new Error("Demotion is not supported for this environment");
    }
    const fallbackDefaultCheckout = await resolveProjectDefaultBranchCheckoutAsync(
      project.rootPath,
    );
    const snapshot = active.previousCheckout ?? fallbackDefaultCheckout;
    if (!snapshot) {
      throw new Error("Could not determine a branch/commit to restore. Checkout manually and retry.");
    }
    if (environment.demoteFromActiveWorkspaceAsync) {
      await environment.demoteFromActiveWorkspaceAsync({
        activeWorkspaceRoot: project.rootPath,
        snapshot,
      });
    } else {
      environment.demoteFromActiveWorkspace({
        activeWorkspaceRoot: project.rootPath,
        snapshot,
      });
    }
    this.clearPrimaryPromotionState(project.id);
    return {
      demoted: true,
      status: this.getPrimaryCheckoutStatus(project.id),
      snapshot,
      activeThreadId: active.threadId,
    };
  }

  stopAll(opts?: { preserveEnvironments?: boolean }): void {
    const preserveEnvironments = opts?.preserveEnvironments ?? false;
    const runtimeThreadIds = new Set(this.environmentRuntimes.keys());
    for (const [threadId] of this.environmentRuntimes) {
      if (preserveEnvironments) {
        this.detachEnvironmentRuntime(threadId);
      } else {
        this.destroyEnvironmentRuntime(threadId);
      }
    }
    if (!preserveEnvironments) {
      const projects = this.projectRepo.list();
      if (!Array.isArray(projects) || projects.length === 0) {
        this.environmentRuntimes.clear();
        this.stopAllPrimaryPromotionWatches();
        this.primaryPromotionByProjectId.clear();
        this.primaryPromotionValidatedAtByProjectId.clear();
        this.workspaceCleanupInFlightThreadIds.clear();
        this.restoreFailuresByThreadId.clear();
        return;
      }
      for (const project of projects) {
        const threadIds =
          typeof this.threadRepo.listProjectNonArchivedIdsWithEnvironmentRecord === "function"
            ? this.threadRepo.listProjectNonArchivedIdsWithEnvironmentRecord(project.id)
            : [];
        for (const threadId of threadIds) {
          if (runtimeThreadIds.has(threadId)) continue;
          void this.destroyPersistedEnvironment(threadId).catch((error: unknown) => {
            const environmentId = this.threadRepo.getById(threadId)?.environmentId ?? "unknown";
            this.callbacks.onCleanupFailure(threadId, environmentId, error);
          });
        }
      }
    }
    this.environmentRuntimes.clear();
    this.stopAllPrimaryPromotionWatches();
    this.primaryPromotionByProjectId.clear();
    this.primaryPromotionValidatedAtByProjectId.clear();
    this.workspaceCleanupInFlightThreadIds.clear();
    this.restoreFailuresByThreadId.clear();
  }

  stopPrimaryPromotionWatches(): void {
    this.stopAllPrimaryPromotionWatches();
  }

  private startPrimaryPromotionWatch(projectId: string): void {
    if (this.primaryPromotionWatchersByProjectId.has(projectId)) return;
    const project = this.projectRepo.getById(projectId);
    if (!project) return;
    const environment = this.environmentRegistry.create(
      "local",
      this.callbacks.createContext(`primary-checkout-watch:${projectId}`, project.rootPath),
    );
    const stopWatching = environment.watchWorkspaceStatus(() => {
      this.ensurePrimaryPromotionStateIsCurrent(projectId, { force: true });
    });
    this.primaryPromotionWatchersByProjectId.set(projectId, stopWatching);
  }

  private stopPrimaryPromotionWatch(projectId: string): void {
    const watcher = this.primaryPromotionWatchersByProjectId.get(projectId);
    if (!watcher) return;
    watcher();
    this.primaryPromotionWatchersByProjectId.delete(projectId);
  }

  private stopAllPrimaryPromotionWatches(): void {
    for (const watcher of this.primaryPromotionWatchersByProjectId.values()) {
      watcher();
    }
    this.primaryPromotionWatchersByProjectId.clear();
  }
}
