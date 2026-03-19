import {
  type EnvironmentProperties,
  type ThreadWorkStatus,
  type EnvironmentProvisioningEvent,
  type PersistedEnvironmentRecord,
  type PrimaryCheckoutStatus,
  type SystemEnvironmentInfo,
  type Thread,
  type ThreadChangeKind,
  type ThreadEnvironmentStartReason,
} from "@bb/core";
import {
  type CreateEnvironmentContext,
  type EnvironmentCheckoutSnapshot,
  type EnvironmentRegistry,
  type IEnvironment,
} from "@bb/environment";
import {
  removeEnvironmentDaemonDefaultLogArtifacts,
  type EnvironmentDaemonConnectionTarget,
} from "@bb/environment-daemon";
import type {
  EnvironmentRepository,
  ProjectRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
} from "@bb/db";
import {
  resolveProjectCheckoutSnapshotAsync,
  resolveProjectDefaultBranchCheckoutAsync,
} from "./git-project.js";
import { derivePersistedEnvironmentRecordFromDescriptor } from "./env-factory.js";

export interface ActiveEnvironmentRuntime {
  scopeKey: string;
  environment: IEnvironment;
  agentConnectionTarget: EnvironmentDaemonConnectionTarget;
  stopWatchingWorkspaceStatus?: () => void;
}

export interface PrimaryPromotionState {
  projectId: string;
  environmentId: string;
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
  onCleanupFailure: (threadId: string, environmentKind: string, error: unknown) => void;
  onPrimaryCheckoutDemoted: (args: {
    projectId: string;
    threadId: string;
    currentCheckout: EnvironmentCheckoutSnapshot;
  }) => void;
  runOptionalSetup: (
    threadId: string,
    environment: IEnvironment,
    projectRootPath: string,
    reason: ThreadEnvironmentStartReason,
  ) => Promise<void>;
  ensureManagedEnvironmentArtifacts?: (
    args: {
      threadId: string;
      environmentId: string;
      projectRootPath: string;
    },
  ) => Promise<{ created: boolean }>;
  cleanupManagedEnvironmentArtifacts?: (
    args: {
      threadId: string;
      environmentId: string;
      projectRootPath: string;
    },
  ) => Promise<void>;
}

interface EnsureThreadEnvironmentRuntimeResult {
  runtime: ActiveEnvironmentRuntime;
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
  readonly environmentRuntimeEnsuresByScopeKey = new Map<
    string,
    Promise<EnsureThreadEnvironmentRuntimeResult>
  >();
  readonly environmentRuntimeSuspendsByScopeKey = new Map<string, Promise<void>>();
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
    private readonly environmentRepo?: EnvironmentRepository,
    private readonly threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository,
  ) {}

  private resolveAttachedEnvironment(threadId: string): {
    environmentId: string;
    hasSiblingAttachments: boolean;
    preserveWorkspace: boolean;
    managed: boolean;
  } | undefined {
    if (!this.threadEnvironmentAttachmentRepo) {
      return undefined;
    }
    const attachment = this.threadEnvironmentAttachmentRepo.getByThreadId(threadId);
    if (!attachment) {
      return undefined;
    }
    const siblingAttachments = this.threadEnvironmentAttachmentRepo
      .listByEnvironmentId(attachment.environmentId)
      .filter((record) => record.threadId !== threadId);
    const environmentRecord = this.environmentRepo?.getById(attachment.environmentId);
    const hasSiblingAttachments = siblingAttachments.length > 0;
    return {
      environmentId: attachment.environmentId,
      hasSiblingAttachments,
      preserveWorkspace: hasSiblingAttachments || !(environmentRecord?.managed ?? false),
      managed: environmentRecord?.managed ?? false,
    };
  }

  private getRuntimeScopeKey(threadId: string): string {
    return this.resolveAttachedEnvironment(threadId)?.environmentId ?? `thread:${threadId}`;
  }

  private getThreadIdsForRuntimeScope(threadId: string): string[] {
    const attachedEnvironment = this.resolveAttachedEnvironment(threadId);
    if (!attachedEnvironment || !this.threadEnvironmentAttachmentRepo) {
      return [threadId];
    }
    return this.threadEnvironmentAttachmentRepo
      .listByEnvironmentId(attachedEnvironment.environmentId)
      .map((attachment) => attachment.threadId);
  }

  private getThreadIdsForRuntimeScopeKey(scopeKey: string): string[] {
    if (scopeKey.startsWith("thread:")) {
      return [scopeKey.slice("thread:".length)];
    }
    if (!this.threadEnvironmentAttachmentRepo) {
      return [];
    }
    return this.threadEnvironmentAttachmentRepo
      .listByEnvironmentId(scopeKey)
      .map((attachment) => attachment.threadId);
  }

  hasSharedAttachedEnvironment(threadId: string): boolean {
    return this.getThreadIdsForRuntimeScope(threadId).length > 1;
  }

  getAttachedEnvironmentId(threadId: string): string | undefined {
    if (this.threadEnvironmentAttachmentRepo) {
      return this.resolveAttachedEnvironment(threadId)?.environmentId;
    }
    return this.threadRepo.getById(threadId)?.environmentId;
  }

  private resolvePrimaryPromotionEnvironmentId(threadId: string): string | undefined {
    const attachedEnvironmentId = this.getAttachedEnvironmentId(threadId);
    if (attachedEnvironmentId) {
      return attachedEnvironmentId;
    }
    if (this.threadEnvironmentAttachmentRepo) {
      return undefined;
    }
    return threadId;
  }

  getAttachedThreadIdsForEnvironment(environmentId: string): string[] {
    if (!this.threadEnvironmentAttachmentRepo) {
      return this.threadRepo.list()
        .filter((thread) => thread.environmentId === environmentId)
        .map((thread) => thread.id);
    }
    return this.threadEnvironmentAttachmentRepo
      .listByEnvironmentId(environmentId)
      .map((attachment) => attachment.threadId);
  }

  isThreadAttachedToEnvironment(threadId: string, environmentId: string): boolean {
    return this.getAttachedEnvironmentId(threadId) === environmentId;
  }

  private resolveAttachedPersistedEnvironmentRecord(
    threadId: string,
  ): PersistedEnvironmentRecord | undefined {
    const attachedEnvironment = this.resolveAttachedEnvironment(threadId);
    if (!attachedEnvironment) {
      return undefined;
    }
    const attachedEnvironmentRecord = this.environmentRepo?.getById(attachedEnvironment.environmentId);
    if (attachedEnvironmentRecord) {
      if (attachedEnvironmentRecord.runtimeState) {
        return attachedEnvironmentRecord.runtimeState;
      }
      if (attachedEnvironmentRecord.descriptor) {
        const derivedRecord = derivePersistedEnvironmentRecordFromDescriptor({
          descriptor: attachedEnvironmentRecord.descriptor,
          projectRootPath:
            this.projectRepo.getById(attachedEnvironmentRecord.projectId)?.rootPath ??
            attachedEnvironmentRecord.descriptor.path,
        });
        if (derivedRecord) {
          return derivedRecord;
        }
      }
    }
    return undefined;
  }

  private resolveAttachedEnvironmentRecord(threadId: string) {
    const attachedEnvironment = this.resolveAttachedEnvironment(threadId);
    if (!attachedEnvironment) {
      return undefined;
    }
    return this.environmentRepo?.getById(attachedEnvironment.environmentId);
  }

  private resolveAttachedEnvironmentProperties(threadId: string): EnvironmentProperties | undefined {
    return this.resolveAttachedEnvironmentRecord(threadId)?.properties;
  }

  private resolveManagedEnvironmentArtifactArgs(
    threadId: string,
    projectRootPath: string,
  ): {
    threadId: string;
    environmentId: string;
    projectRootPath: string;
  } | undefined {
    const environmentId = this.resolveAttachedEnvironment(threadId)?.environmentId;
    if (!environmentId) {
      return undefined;
    }
    return {
      threadId,
      environmentId,
      projectRootPath,
    };
  }

  private resolveCleanupEnvironmentId(
    threadId: string,
  ): string | undefined {
    if (this.threadEnvironmentAttachmentRepo) {
      return this.resolveAttachedEnvironment(threadId)?.environmentId;
    }
    return this.threadRepo.getById(threadId)?.environmentId?.trim();
  }

  private isThreadIsolatedWorkspaceEnvironment(threadId: string): boolean {
    const properties = this.resolveAttachedEnvironmentProperties(threadId);
    if (!properties) {
      return false;
    }
    return properties.location === "docker" || properties.workspaceKind === "worktree";
  }

  private createRuntimeContext(
    threadId: string,
    projectRootPath: string,
    overrides?: {
      workspaceRootPath?: string;
      environmentId?: string;
      environmentProperties?: EnvironmentProperties;
    },
  ): CreateEnvironmentContext {
    const attachedEnvironmentRecord = this.resolveAttachedEnvironmentRecord(threadId);
    return {
      ...this.callbacks.createContext(threadId, projectRootPath),
      ...(attachedEnvironmentRecord ? { environmentId: attachedEnvironmentRecord.id } : {}),
      ...(attachedEnvironmentRecord?.descriptor
        ? { workspaceRootPath: attachedEnvironmentRecord.descriptor.path }
        : {}),
      ...(attachedEnvironmentRecord?.properties
        ? { environmentProperties: attachedEnvironmentRecord.properties }
        : {}),
      ...(overrides?.environmentId ? { environmentId: overrides.environmentId } : {}),
      ...(overrides?.workspaceRootPath ? { workspaceRootPath: overrides.workspaceRootPath } : {}),
      ...(overrides?.environmentProperties
        ? { environmentProperties: overrides.environmentProperties }
        : {}),
    };
  }

  private resolveThreadRuntimeKind(
    thread: Thread,
    projectRootPath: string,
  ): string {
    const attachedEnvironmentRecord = this.resolveAttachedPersistedEnvironmentRecord(thread.id);
    const candidateKinds = [
      attachedEnvironmentRecord?.kind,
      "local",
    ];
    for (const candidateKind of candidateKinds) {
      if (!candidateKind) {
        continue;
      }
      const normalized = candidateKind.trim();
      if (!normalized) {
        continue;
      }
      if (this.environmentRegistry.has(normalized)) {
        return normalized;
      }
      const derivedRecord = derivePersistedEnvironmentRecordFromDescriptor({
        descriptor: {
          type: "path",
          path: projectRootPath,
        },
        projectRootPath,
      });
      if (derivedRecord?.kind && this.environmentRegistry.has(derivedRecord.kind)) {
        return derivedRecord.kind;
      }
    }
    return "local";
  }

  listEnvironments(): SystemEnvironmentInfo[] {
    return this.environmentRegistry.list().map((environment: SystemEnvironmentInfo) => ({
      ...environment,
    }));
  }

  resolveRuntimeEnvironmentKind(value?: string): string {
    const normalized = (value ?? "local").trim();
    if (!normalized) return "local";
    if (!this.environmentRegistry.has(normalized)) {
      throw new Error(`Unsupported environment "${normalized}"`);
    }
    return normalized;
  }

  restoreThreadEnvironment(thread: Thread, projectRootPath: string): IEnvironment | undefined {
    const runtime = this.environmentRuntimes.get(this.getRuntimeScopeKey(thread.id));
    if (runtime) {
      this.restoreFailuresByThreadId.delete(thread.id);
      return runtime.environment;
    }
    const environmentRecord = this.resolveAttachedPersistedEnvironmentRecord(thread.id);
    if (!environmentRecord) {
      this.restoreFailuresByThreadId.delete(thread.id);
      return undefined;
    }
    try {
      const restored = this.environmentRegistry.restore(
        environmentRecord,
        this.createRuntimeContext(thread.id, projectRootPath),
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
    return this.environmentRuntimes.get(this.getRuntimeScopeKey(threadId));
  }

  async getProjectWorkspaceStatusAsync(projectId: string, rootPath: string): Promise<ThreadWorkStatus> {
    const environment = this.environmentRegistry.create(
      "local",
      this.createRuntimeContext(`project-status:${projectId}`, rootPath, {
        workspaceRootPath: rootPath,
      }),
    );
    try {
      return await environment.getWorkspaceStatus();
    } finally {
      void environment.destroy();
    }
  }

  private async prepareEnvironment(
    threadId: string,
    projectRootPath: string,
    environment: IEnvironment,
    reason: ThreadEnvironmentStartReason,
    materializedFreshEnvironment = false,
  ): Promise<{ existedBeforePrepare: boolean }> {
    const existedBeforePrepare = !materializedFreshEnvironment && environment.exists();
    if (typeof environment.prepare === "function") {
      await environment.prepare();
    }
    if (!existedBeforePrepare) {
      await this.callbacks.runOptionalSetup(threadId, environment, projectRootPath, reason);
    }
    return { existedBeforePrepare };
  }

  private async withThreadEnvironmentEnsure(
    threadId: string,
    createEnsurePromise: () => Promise<EnsureThreadEnvironmentRuntimeResult>,
  ): Promise<EnsureThreadEnvironmentRuntimeResult> {
    const scopeKey = this.getRuntimeScopeKey(threadId);
    const existingRuntime = this.environmentRuntimes.get(scopeKey);
    if (existingRuntime) {
      return {
        runtime: existingRuntime,
      };
    }

    const existingEnsure = this.environmentRuntimeEnsuresByScopeKey.get(scopeKey);
    if (existingEnsure) {
      return existingEnsure;
    }

    let ensurePromise: Promise<EnsureThreadEnvironmentRuntimeResult>;
    ensurePromise = createEnsurePromise().finally(() => {
      if (this.environmentRuntimeEnsuresByScopeKey.get(scopeKey) === ensurePromise) {
        this.environmentRuntimeEnsuresByScopeKey.delete(scopeKey);
      }
    });
    this.environmentRuntimeEnsuresByScopeKey.set(scopeKey, ensurePromise);
    return ensurePromise;
  }

  async provisionThreadEnvironment(
    threadId: string,
    projectRootPath: string,
    environmentKind: string,
    reason: ThreadEnvironmentStartReason,
  ): Promise<ActiveEnvironmentRuntime> {
    const ensured = await this.withThreadEnvironmentEnsure(threadId, async () => {
      await this.awaitEnvironmentRuntimeSuspension(threadId);
      const existingRuntime = this.getEnvironmentRuntime(threadId);
      if (existingRuntime) {
        return {
          runtime: existingRuntime,
        };
      }

      const artifactArgs = this.resolveManagedEnvironmentArtifactArgs(
        threadId,
        projectRootPath,
      );
      const materialization =
        artifactArgs
          ? await this.callbacks.ensureManagedEnvironmentArtifacts?.(artifactArgs) ??
            { created: false }
          : { created: false };

      const thread = this.threadRepo.getById(threadId);
      const environment =
        (thread ? this.restoreThreadEnvironment(thread, projectRootPath) : undefined) ??
        this.environmentRegistry.create(
          environmentKind,
          this.createRuntimeContext(threadId, projectRootPath),
        );
      try {
        await this.prepareEnvironment(
          threadId,
          projectRootPath,
          environment,
          reason,
          materialization.created,
        );
      } catch (error) {
        try {
          await Promise.resolve(environment.destroy());
        } catch {
          // Best-effort cleanup for partially provisioned environments.
        }
        if (materialization.created) {
          try {
            const artifactArgs = this.resolveManagedEnvironmentArtifactArgs(
              threadId,
              projectRootPath,
            );
            if (artifactArgs) {
              await this.callbacks.cleanupManagedEnvironmentArtifacts?.(artifactArgs);
            }
          } catch {
            // Best-effort cleanup for partially provisioned environments.
          }
        }
        throw error;
      }

      await this.registerPreparedEnvironmentRuntime(threadId, environment);
      const runtime = this.getEnvironmentRuntime(threadId);
      if (!runtime) {
        throw new Error(`Missing environment runtime for thread ${threadId}`);
      }
      return {
        runtime,
      };
    });

    return ensured.runtime;
  }

  async ensureThreadEnvironmentRuntime(
    thread: Thread,
    projectRootPath: string,
    reason: ThreadEnvironmentStartReason,
  ): Promise<EnsureThreadEnvironmentRuntimeResult> {
    await this.awaitEnvironmentRuntimeSuspension(thread.id);
    const existingRuntime = this.getEnvironmentRuntime(thread.id);
    if (existingRuntime) {
      return {
        runtime: existingRuntime,
      };
    }

    return this.withThreadEnvironmentEnsure(thread.id, async () => {
      const runtimeDuringEnsure = this.getEnvironmentRuntime(thread.id);
      if (runtimeDuringEnsure) {
        return {
          runtime: runtimeDuringEnsure,
        };
      }

      const artifactArgs = this.resolveManagedEnvironmentArtifactArgs(
        thread.id,
        projectRootPath,
      );
      const materialization =
        artifactArgs
          ? await this.callbacks.ensureManagedEnvironmentArtifacts?.(artifactArgs) ??
            { created: false }
          : { created: false };

      const environmentId = this.resolveThreadRuntimeKind(thread, projectRootPath);
      const environment =
        this.restoreThreadEnvironment(thread, projectRootPath) ??
        this.environmentRegistry.create(
          environmentId,
          this.createRuntimeContext(thread.id, projectRootPath),
        );

      try {
        await this.prepareEnvironment(
          thread.id,
          projectRootPath,
          environment,
          reason,
          materialization.created,
        );
      } catch (error) {
        try {
          await Promise.resolve(environment.destroy());
        } catch {
          // Best-effort cleanup for partially restored environments.
        }
        if (materialization.created) {
          try {
            const artifactArgs = this.resolveManagedEnvironmentArtifactArgs(
              thread.id,
              projectRootPath,
            );
            if (artifactArgs) {
              await this.callbacks.cleanupManagedEnvironmentArtifacts?.(artifactArgs);
            }
          } catch {
            // Best-effort cleanup for partially restored environments.
          }
        }
        throw error;
      }

      await this.registerPreparedEnvironmentRuntime(thread.id, environment);
      const runtime = this.getEnvironmentRuntime(thread.id);
      if (!runtime) {
        throw new Error(`Missing environment runtime for thread ${thread.id}`);
      }
      return {
        runtime,
      };
    });
  }

  setEnvironmentRuntime(threadId: string, environment: IEnvironment): void {
    const agentConnectionTarget = environment.getAgentConnectionTarget();
    this.installEnvironmentRuntime(threadId, environment, agentConnectionTarget);
  }

  private installEnvironmentRuntime(
    threadId: string,
    environment: IEnvironment,
    agentConnectionTarget: EnvironmentDaemonConnectionTarget,
  ): void {
    const scopeKey = this.getRuntimeScopeKey(threadId);
    const existingRuntime = this.detachEnvironmentRuntime(threadId);
    if (existingRuntime) {
      void this.suspendDetachedRuntime(threadId, existingRuntime);
    }
    const stopWatchingWorkspaceStatus = environment.watchWorkspaceStatus(() => {
      for (const scopedThreadId of this.getThreadIdsForRuntimeScopeKey(scopeKey)) {
        if (!this.threadRepo.getById(scopedThreadId)) {
          continue;
        }
        this.callbacks.onThreadChanged(scopedThreadId, ["work-status-changed"]);
      }
    });
    this.environmentRuntimes.set(scopeKey, {
      scopeKey,
      environment,
      agentConnectionTarget,
      stopWatchingWorkspaceStatus,
    });
  }

  private async registerPreparedEnvironmentRuntime(
    threadId: string,
    environment: IEnvironment,
  ): Promise<void> {
    this.setEnvironmentRuntime(threadId, environment);
  }

  detachEnvironmentRuntime(threadId: string): ActiveEnvironmentRuntime | undefined {
    return this.detachEnvironmentRuntimeByScopeKey(this.getRuntimeScopeKey(threadId));
  }

  private detachEnvironmentRuntimeByScopeKey(scopeKey: string): ActiveEnvironmentRuntime | undefined {
    const runtime = this.environmentRuntimes.get(scopeKey);
    if (runtime) {
      runtime.stopWatchingWorkspaceStatus?.();
      this.environmentRuntimes.delete(scopeKey);
    }
    return runtime;
  }

  suspendEnvironmentRuntime(threadId: string): void {
    this.trackEnvironmentRuntimeSuspension(
      threadId,
      this.suspendEnvironmentRuntimeAndWait(threadId),
    );
  }

  async suspendEnvironmentRuntimeAndWait(threadId: string): Promise<void> {
    const runtime = this.detachEnvironmentRuntime(threadId);
    if (runtime) {
      await this.suspendDetachedRuntime(threadId, runtime);
      return;
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      return;
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      return;
    }

    let environment: IEnvironment | undefined;
    try {
      environment = this.restoreThreadEnvironment(thread, project.rootPath);
    } catch (error) {
      this.callbacks.onCleanupFailure(
        threadId,
        this.resolveCleanupEnvironmentId(threadId) ?? "unknown",
        error,
      );
      return;
    }
    if (!environment) {
      return;
    }

    const environmentId = environment.kind;
    try {
      await Promise.resolve(environment.suspend());
    } catch (error) {
      this.callbacks.onCleanupFailure(threadId, environmentId, error);
    }
  }

  private async suspendDetachedRuntime(
    threadId: string,
    runtime: ActiveEnvironmentRuntime,
  ): Promise<void> {
    const environmentId = runtime.environment.kind;
    try {
      await Promise.resolve(runtime.environment.suspend());
    } catch (error) {
      this.callbacks.onCleanupFailure(threadId, environmentId, error);
    }
  }

  private async destroyDetachedRuntime(
    threadId: string,
    runtime: ActiveEnvironmentRuntime,
  ): Promise<void> {
    await Promise.resolve(runtime.environment.destroy());
    this.detachEnvironmentRuntimeByScopeKey(runtime.scopeKey);
  }

  private clearPersistedEnvironmentStateForRuntimeScope(
    scopeKey: string,
  ): void {
    const scopedThreadIds = this.getThreadIdsForRuntimeScopeKey(scopeKey);
    for (const scopedThreadId of scopedThreadIds) {
      this.clearPersistedEnvironmentState(scopedThreadId);
    }
  }

  private trackEnvironmentRuntimeSuspension(
    threadId: string,
    suspendPromise: Promise<void>,
  ): Promise<void> {
    const scopeKey = this.getRuntimeScopeKey(threadId);
    const tracked = suspendPromise.finally(() => {
      if (this.environmentRuntimeSuspendsByScopeKey.get(scopeKey) === tracked) {
        this.environmentRuntimeSuspendsByScopeKey.delete(scopeKey);
      }
    });
    this.environmentRuntimeSuspendsByScopeKey.set(scopeKey, tracked);
    return tracked;
  }

  private async awaitEnvironmentRuntimeSuspension(threadId: string): Promise<void> {
    await this.environmentRuntimeSuspendsByScopeKey.get(this.getRuntimeScopeKey(threadId));
  }

  async destroyThreadEnvironment(threadId: string): Promise<void> {
    const runtime = this.getEnvironmentRuntime(threadId);
    const attachedEnvironment = this.resolveAttachedEnvironment(threadId);
    const thread = this.threadRepo.getById(threadId);
    const projectRootPath = thread
      ? this.projectRepo.getById(thread.projectId)?.rootPath
      : undefined;

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
          reportFailure(this.resolveCleanupEnvironmentId(threadId) ?? "unknown", error);
          throw error;
        }
        return;
      }

      const environmentId = runtime.environment.kind;
      try {
        if (attachedEnvironment?.preserveWorkspace && attachedEnvironment.hasSiblingAttachments) {
          this.clearPersistedEnvironmentState(threadId);
        } else {
          await this.destroyDetachedRuntime(threadId, runtime);
          if (projectRootPath) {
            const artifactArgs = this.resolveManagedEnvironmentArtifactArgs(
              threadId,
              projectRootPath,
            );
            if (artifactArgs) {
              await this.callbacks.cleanupManagedEnvironmentArtifacts?.(artifactArgs);
            }
          }
          this.clearPersistedEnvironmentStateForRuntimeScope(runtime.scopeKey);
        }
      } catch (error) {
        reportFailure(environmentId, error);
        throw error;
      }
    } finally {
      refresh();
    }
  }

  async archiveThreadEnvironment(threadId: string): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    const attachedEnvironment = this.resolveAttachedEnvironment(threadId);
    const projectRootPath = this.projectRepo.getById(thread.projectId)?.rootPath;

    this.workspaceCleanupInFlightThreadIds.add(threadId);
    const refresh = () => {
      this.workspaceCleanupInFlightThreadIds.delete(threadId);
      if (this.threadRepo.getById(threadId)) {
        this.callbacks.onThreadChanged(threadId, ["work-status-changed"]);
      }
    };

    try {
      await this.suspendEnvironmentRuntimeAndWait(threadId);
      if (
        attachedEnvironment?.managed &&
        !attachedEnvironment.hasSiblingAttachments &&
        projectRootPath
      ) {
        await this.callbacks.cleanupManagedEnvironmentArtifacts?.({
          threadId,
          environmentId: attachedEnvironment.environmentId,
          projectRootPath,
        });
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
    const attachedEnvironment = this.resolveAttachedEnvironment(threadId);
    if (attachedEnvironment?.preserveWorkspace) {
      this.clearPersistedEnvironmentState(threadId);
      return;
    }
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
      if (project.rootPath) {
        const artifactArgs = this.resolveManagedEnvironmentArtifactArgs(
          threadId,
          project.rootPath,
        );
        if (artifactArgs) {
          await this.callbacks.cleanupManagedEnvironmentArtifacts?.(artifactArgs);
        }
      }
      this.clearPersistedEnvironmentState(threadId);
      return;
    }
    await Promise.resolve(environment.destroy());
    const artifactArgs = this.resolveManagedEnvironmentArtifactArgs(
      threadId,
      project.rootPath,
    );
    if (artifactArgs) {
      await this.callbacks.cleanupManagedEnvironmentArtifacts?.(artifactArgs);
    }
    this.clearPersistedEnvironmentState(threadId);
  }

  private clearPersistedEnvironmentState(threadId: string): void {
    const attachment = this.threadEnvironmentAttachmentRepo?.getByThreadId(threadId);
    const thread = this.threadRepo.getById(threadId);
    const projectRootPath = thread
      ? this.projectRepo.getById(thread.projectId)?.rootPath
      : undefined;
    const attachedEnvironmentRecord = attachment
      ? this.environmentRepo?.getById(attachment.environmentId)
      : undefined;
    this.threadEnvironmentAttachmentRepo?.deleteByThreadId(threadId);
    if (attachment) {
      const remainingAttachments = this.threadEnvironmentAttachmentRepo?.listByEnvironmentId(
        attachment.environmentId,
      ) ?? [];
      if (remainingAttachments.length === 0 && this.environmentRepo?.getById(attachment.environmentId)?.managed) {
        this.environmentRepo.delete(attachment.environmentId);
      }
    }
    this.restoreFailuresByThreadId.delete(threadId);
  }

  removeManagedThreadLogs(
    thread: Pick<Thread, "id" | "projectId" | "environmentId">,
  ): void {
    const environmentId = this.resolveCleanupEnvironmentId(
      thread.id,
    );
    if (!environmentId) {
      return;
    }

    try {
      removeEnvironmentDaemonDefaultLogArtifacts({
        projectId: thread.projectId,
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
    if (
      !environment ||
      !environment.exists() ||
      !this.isThreadIsolatedWorkspaceEnvironment(thread.id)
    ) {
      this.clearPrimaryPromotionState(projectId);
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }
    let workspaceCheckout: EnvironmentCheckoutSnapshot;
    try {
      workspaceCheckout = await environment.getCheckoutSnapshot();
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
    const promotionEnvironmentId = this.resolvePrimaryPromotionEnvironmentId(thread.id);
    if (!promotionEnvironmentId) {
      this.clearPrimaryPromotionState(projectId);
      this.primaryPromotionValidatedAtByProjectId.set(projectId, now);
      return;
    }
    this.setPrimaryPromotionState(project.id, {
      projectId: project.id,
      environmentId: promotionEnvironmentId,
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
      activeEnvironmentId: active.environmentId,
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
    reason?:
      | "already-promoted-same-thread"
      | "already-promoted-same-environment"
      | "already-promoted-other-thread";
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
      const attachedEnvironmentId = this.getAttachedEnvironmentId(args.thread.id);
      return {
        promoted: false,
        status: this.getPrimaryCheckoutStatus(project.id),
        state: existing,
        reason:
          existing.threadId === args.thread.id
            ? "already-promoted-same-thread"
            : attachedEnvironmentId === existing.environmentId
            ? "already-promoted-same-environment"
            : "already-promoted-other-thread",
      };
    }
    const promotionEnvironmentId = this.resolvePrimaryPromotionEnvironmentId(args.thread.id);
    if (!promotionEnvironmentId) {
      throw new Error("Thread is not attached to an environment");
    }
    const environment = this.restoreThreadEnvironment(args.thread, project.rootPath);
    if (!environment || !environment.supportsPromoteToActiveWorkspace()) {
      throw new Error("Promotion is not supported for this environment");
    }
    if (!this.isThreadIsolatedWorkspaceEnvironment(args.thread.id) || !environment.exists()) {
      throw new Error("Thread worktree is unavailable; reprovision the thread first");
    }
    const promoted = await environment.promoteToActiveWorkspace({
      activeWorkspaceRoot: project.rootPath,
    });
    const state: PrimaryPromotionState = {
      projectId: project.id,
      environmentId: promotionEnvironmentId,
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

  async demoteThreadEnvironment(args: {
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
    const attachedEnvironmentId = this.getAttachedEnvironmentId(args.thread.id);
    if (!attachedEnvironmentId || attachedEnvironmentId !== active.environmentId) {
      throw new Error(`Thread ${active.threadId} is currently promoted in primary checkout`);
    }
    const activeThread =
      this.threadRepo.getById(active.threadId) ??
      this.getAttachedThreadIdsForEnvironment(active.environmentId)
        .map((threadId) => this.threadRepo.getById(threadId))
        .find((thread): thread is Thread => Boolean(thread));
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
    await environment.demoteFromActiveWorkspace({
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

  detachAll(): void {
    for (const runtime of Array.from(this.environmentRuntimes.values())) {
      this.detachEnvironmentRuntimeByScopeKey(runtime.scopeKey);
    }
    this.environmentRuntimes.clear();
    this.stopAllPrimaryPromotionWatches();
    this.primaryPromotionByProjectId.clear();
    this.primaryPromotionValidatedAtByProjectId.clear();
    this.workspaceCleanupInFlightThreadIds.clear();
    this.restoreFailuresByThreadId.clear();
  }

  async teardownAllForTestsOnly(): Promise<void> {
    const runtimeScopeKeys = new Set(
      Array.from(this.environmentRuntimes.values()).map((runtime) => runtime.scopeKey),
    );
    const teardownTasks: Promise<void>[] = [];
    for (const runtime of Array.from(this.environmentRuntimes.values())) {
      const scopedThreadIds = this.getThreadIdsForRuntimeScopeKey(runtime.scopeKey);
      if (scopedThreadIds.length === 0) {
        teardownTasks.push(
          Promise.resolve(runtime.environment.destroy()).catch((error: unknown) => {
            this.callbacks.onCleanupFailure(runtime.scopeKey, runtime.environment.kind, error);
          }).finally(() => {
            this.detachEnvironmentRuntimeByScopeKey(runtime.scopeKey);
          }),
        );
        continue;
      }
      for (const scopedThreadId of scopedThreadIds) {
        teardownTasks.push(
          this.destroyThreadEnvironment(scopedThreadId).catch((error: unknown) => {
            const environmentId =
              this.resolveCleanupEnvironmentId(scopedThreadId) ?? "unknown";
            this.callbacks.onCleanupFailure(scopedThreadId, environmentId, error);
          }),
        );
      }
    }
    const projects = this.projectRepo.list();
    if (!Array.isArray(projects) || projects.length === 0) {
      await Promise.allSettled(teardownTasks);
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
        this.threadRepo.listProjectNonArchivedIdsWithEnvironmentRecord(project.id);
      for (const threadId of threadIds) {
        const scopeKey = this.getRuntimeScopeKey(threadId);
        if (runtimeScopeKeys.has(scopeKey)) continue;
        teardownTasks.push(
          this.destroyPersistedEnvironment(threadId).catch((error: unknown) => {
            const environmentId = this.resolveCleanupEnvironmentId(threadId) ?? "unknown";
            this.callbacks.onCleanupFailure(threadId, environmentId, error);
          }),
        );
      }
    }
    await Promise.allSettled(teardownTasks);
    this.environmentRuntimes.clear();
    this.stopAllPrimaryPromotionWatches();
    this.primaryPromotionByProjectId.clear();
    this.primaryPromotionValidatedAtByProjectId.clear();
    this.workspaceCleanupInFlightThreadIds.clear();
    this.restoreFailuresByThreadId.clear();
  }

  private startPrimaryPromotionWatch(projectId: string): void {
    if (this.primaryPromotionWatchersByProjectId.has(projectId)) return;
    const project = this.projectRepo.getById(projectId);
    if (!project) return;
    const environment = this.environmentRegistry.create(
      "local",
      this.createRuntimeContext(`primary-checkout-watch:${projectId}`, project.rootPath, {
        workspaceRootPath: project.rootPath,
      }),
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

  stopAllPrimaryPromotionWatches(): void {
    for (const watcher of this.primaryPromotionWatchersByProjectId.values()) {
      watcher();
    }
    this.primaryPromotionWatchersByProjectId.clear();
  }
}
