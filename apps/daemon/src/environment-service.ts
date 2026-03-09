import {
  type ThreadWorkStatus,
  type EnvironmentProvisioningEvent,
  type PrimaryCheckoutStatus,
  type SystemEnvironmentInfo,
  type Thread,
  type ThreadChangeKind,
  type ThreadEnvironmentStartReason,
} from "@beanbag/agent-core";
import type { AgentServerSessionConnection } from "@beanbag/agent-server";
import {
  type CreateEnvironmentContext,
  type EnvironmentCheckoutSnapshot,
  type EnvironmentRegistry,
  type IEnvironment,
} from "@beanbag/environment";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";
import type { ProjectRepository, ThreadRepository } from "@beanbag/db";
import {
  resolveProjectCheckoutSnapshot,
  resolveProjectDefaultBranchCheckout,
} from "./git-project.js";

export interface ActiveEnvironmentRuntime {
  environment: IEnvironment;
  agentConnectionTarget: EnvironmentAgentConnectionTarget;
  stopWatchingWorkspaceStatus?: () => void;
  connectSession?: () =>
    | AgentServerSessionConnection
    | Promise<AgentServerSessionConnection>;
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
  }) => AgentServerSessionConnection | Promise<AgentServerSessionConnection>;
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

  getProjectWorkspaceStatus(projectId: string, rootPath: string): ThreadWorkStatus {
    const environment = this.environmentRegistry.create(
      "local",
      this.callbacks.createContext(`project-status:${projectId}`, rootPath),
    );
    try {
      return environment.getWorkspaceStatus();
    } finally {
      environment.dispose();
    }
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
      const existedBeforePrepare = environment.exists();
      if (typeof environment.prepare === "function") {
        await environment.prepare();
      }
      if (!existedBeforePrepare) {
        await this.callbacks.runOptionalSetup(threadId, environment, reason);
      }
    } catch (error) {
      try {
        await Promise.resolve(environment.dispose());
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
    runtime.connectSession = () => this.callbacks.spawnProviderProcess({
      threadId,
      projectId: thread?.projectId,
      agentConnectionTarget: runtime.agentConnectionTarget,
    });
    return runtime;
  }

  setEnvironmentRuntime(threadId: string, environment: IEnvironment): void {
    this.cleanupEnvironmentRuntime(threadId);
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

  cleanupEnvironmentRuntime(threadId: string, opts?: { destroyWorkspace?: boolean }): void {
    const runtime = this.environmentRuntimes.get(threadId);
    if (runtime) {
      runtime.stopWatchingWorkspaceStatus?.();
      this.environmentRuntimes.delete(threadId);
    }
    if (!opts?.destroyWorkspace) return;

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

    if (!runtime) {
      void this.cleanupPersistedWorkspace(threadId)
        .catch((error: unknown) => {
          reportFailure(this.threadRepo.getById(threadId)?.environmentId ?? "unknown", error);
        })
        .finally(refresh);
      return;
    }

    const environmentId = runtime.environment.kind;
    try {
      void Promise.resolve(runtime.environment.dispose())
        .catch((error: unknown) => reportFailure(environmentId, error))
        .finally(refresh);
    } catch (error) {
      reportFailure(environmentId, error);
      refresh();
    }
  }

  async cleanupPersistedWorkspace(threadId: string): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return;
    const environment = this.restoreThreadEnvironment(thread, project.rootPath);
    if (!environment || !environment.isIsolatedWorkspace()) {
      return;
    }
    await Promise.resolve(environment.dispose());
  }

  rebuildPrimaryPromotionStateFromGit(): void {
    this.stopAllPrimaryPromotionWatches();
    this.primaryPromotionByProjectId.clear();
    this.primaryPromotionValidatedAtByProjectId.clear();
    const projects = this.projectRepo.list();
    const allThreads = this.threadRepo.list({ includeArchived: true });
    if (!Array.isArray(projects) || !Array.isArray(allThreads)) return;

    for (const project of projects) {
      let projectCheckout: EnvironmentCheckoutSnapshot;
      try {
        projectCheckout = resolveProjectCheckoutSnapshot(project.rootPath);
      } catch {
        continue;
      }

      for (const thread of allThreads) {
        if (thread.projectId !== project.id || thread.archivedAt !== undefined) {
          continue;
        }
        const environment = this.restoreThreadEnvironment(thread, project.rootPath);
        if (!environment || !environment.exists() || !environment.isIsolatedWorkspace()) {
          continue;
        }
        let workspaceCheckout: EnvironmentCheckoutSnapshot;
        try {
          workspaceCheckout = environment.getCheckoutSnapshot();
        } catch {
          continue;
        }
        if (!checkoutSnapshotsMatch(projectCheckout, workspaceCheckout)) {
          continue;
        }
        this.setPrimaryPromotionState(project.id, {
          projectId: project.id,
          threadId: thread.id,
          promotedAt: Date.now(),
          promotedCheckout: workspaceCheckout,
          reconstructed: true,
        });
        break;
      }
    }
  }

  setPrimaryPromotionState(projectId: string, state: PrimaryPromotionState): void {
    this.primaryPromotionByProjectId.set(projectId, state);
    this.primaryPromotionValidatedAtByProjectId.set(projectId, Date.now());
    this.startPrimaryPromotionWatch(projectId);
  }

  clearPrimaryPromotionState(projectId: string): PrimaryPromotionState | undefined {
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
    const active = this.primaryPromotionByProjectId.get(projectId);
    if (!active) return;
    const now = Date.now();
    const lastValidatedAt = this.primaryPromotionValidatedAtByProjectId.get(projectId) ?? 0;
    const ttlMs = opts?.ttlMs ?? 2_000;
    if (!opts?.force && now - lastValidatedAt < ttlMs) {
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
      currentCheckout = resolveProjectCheckoutSnapshot(project.rootPath);
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
    this.ensurePrimaryPromotionStateIsCurrent(project.id, { force: true, ttlMs: args.ttlMs });
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
    const promoted = environment.promoteToActiveWorkspace({
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
    this.ensurePrimaryPromotionStateIsCurrent(project.id, { force: true, ttlMs: args.ttlMs });
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
    const fallbackDefaultCheckout = resolveProjectDefaultBranchCheckout(project.rootPath);
    const snapshot = active.previousCheckout ?? fallbackDefaultCheckout;
    if (!snapshot) {
      throw new Error("Could not determine a branch/commit to restore. Checkout manually and retry.");
    }
    environment.demoteFromActiveWorkspace({
      activeWorkspaceRoot: project.rootPath,
      snapshot,
    });
    this.clearPrimaryPromotionState(project.id);
    return {
      demoted: true,
      status: this.getPrimaryCheckoutStatus(project.id),
      snapshot,
      activeThreadId: active.threadId,
    };
  }

  stopAll(): void {
    for (const [threadId] of this.environmentRuntimes) {
      this.cleanupEnvironmentRuntime(threadId);
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
