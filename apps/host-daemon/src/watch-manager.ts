import type { DiscoveredWorkspaceProperties } from "@bb/domain";
import {
  getPersonalWorkspaceRoot,
  provisionWorkspace,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import type {
  HostDaemonEnvironmentChange,
  HostDaemonWatchSet,
  HostDaemonWatchSetThreadStorageTarget,
  HostDaemonWatchSetWorkspaceTarget,
} from "@bb/host-daemon-contract";
import type {
  HostWatcher,
  ThreadStorageWatchError,
  WorkspaceStatusWatchChangeKind,
  WorkspaceWatchError,
} from "@bb/host-watcher";
import { reconnectProvisionArgsFromWorkspaceContext } from "./workspace-provision-target.js";
import { userExecutableProcessOptions } from "./user-executable-env.js";

type StopWatching = () => void | Promise<void>;

const STOP_WATCHING: StopWatching = () => undefined;
const LOCAL_WORKSPACE_WATCH_CHANGE_KINDS: readonly WorkspaceStatusWatchChangeKind[] =
  [
    "workspace-content-changed",
    "workspace-git-changed",
    "workspace-git-repository-created",
  ];

interface WorkspaceWatchState {
  lastLocalFingerprint: string | null;
  lastSharedRefsFingerprint: string | null;
  pendingKinds: Set<WorkspaceStatusWatchChangeKind>;
  processing: Promise<void> | null;
}

interface WorkspaceWatchEntry {
  stopWatchingStatus: StopWatching;
  target: HostDaemonWatchSetWorkspaceTarget;
  watchState: WorkspaceWatchState;
  workspace: HostWorkspace;
}

interface RefreshWorkspaceArgs {
  environmentId: string;
  provision: ProvisionWorkspaceArgs;
  workspacePath: string;
}

export interface WatchManagerOptions {
  dataDir?: string;
  hostWatcher?: HostWatcher;
  provisionWorkspace?: (
    options: ProvisionWorkspaceArgs,
  ) => Promise<HostWorkspace>;
  refreshWorkspace?: (args: RefreshWorkspaceArgs) => Promise<HostWorkspace>;
  shellEnv?: () => NodeJS.ProcessEnv;
  threadStorageRootPath?: string | null;
  onThreadStorageChanged?: (args: {
    environmentId: string;
    threadId: string;
  }) => void;
  onThreadStorageWatchError?: (args: {
    error: ThreadStorageWatchError;
  }) => void;
  onWorkspaceStatusChanged?: (args: {
    changeKinds: HostDaemonEnvironmentChange[];
    environmentId: string;
  }) => void;
  onWorkspaceMetadataChanged?: (args: {
    environmentId: string;
    workspace: DiscoveredWorkspaceProperties;
  }) => void;
  onWorkspaceStatusWatchError?: (args: { error: WorkspaceWatchError }) => void;
}

function toErrorMessage(error: Error): string {
  return error.message.trim().length > 0
    ? error.message
    : "Unknown workspace watch error";
}

function workspaceWatchKindsIncludeLocalState(
  changeKinds: readonly WorkspaceStatusWatchChangeKind[],
): boolean {
  return changeKinds.some((changeKind) =>
    LOCAL_WORKSPACE_WATCH_CHANGE_KINDS.includes(changeKind),
  );
}

function sameWorkspaceTarget(
  current: HostDaemonWatchSetWorkspaceTarget,
  next: HostDaemonWatchSetWorkspaceTarget,
): boolean {
  return (
    current.environmentId === next.environmentId &&
    current.workspaceContext.workspacePath ===
      next.workspaceContext.workspacePath &&
    current.workspaceContext.workspaceProvisionType ===
      next.workspaceContext.workspaceProvisionType
  );
}

export class WatchManager {
  private readonly hostWatcher;
  private readonly provisionWorkspace;
  private readonly refreshWorkspace;
  private readonly threadStorageTargets = new Map<
    string,
    HostDaemonWatchSetThreadStorageTarget
  >();
  private readonly workspaceEntries = new Map<string, WorkspaceWatchEntry>();
  private latestAppliedWatchSetGeneration = -1;
  private watchSetMutationTail: Promise<void> = Promise.resolve();
  private stopWatchingThreadStorageRoot: StopWatching = STOP_WATCHING;

  constructor(private readonly options: WatchManagerOptions = {}) {
    this.hostWatcher = options.hostWatcher;
    const provision = options.provisionWorkspace ?? provisionWorkspace;
    this.provisionWorkspace = (args: ProvisionWorkspaceArgs) =>
      provision({
        ...args,
        ...userExecutableProcessOptions(options.shellEnv?.() ?? {}),
      });
    this.refreshWorkspace =
      options.refreshWorkspace ??
      ((args: RefreshWorkspaceArgs) => this.provisionWorkspace(args.provision));
  }

  async replaceWatchSet(watchSet: HostDaemonWatchSet): Promise<void> {
    await this.enqueueWatchSetMutation(async () => {
      if (watchSet.generation <= this.latestAppliedWatchSetGeneration) {
        return;
      }
      await this.applyWatchSet(watchSet);
    });
  }

  async replaceAuthoritativeWatchSet(
    watchSet: HostDaemonWatchSet,
  ): Promise<void> {
    await this.enqueueWatchSetMutation(async () => {
      await this.applyWatchSet(watchSet);
    });
  }

  async removeEnvironmentWorkspaceWatch(environmentId: string): Promise<void> {
    await this.enqueueWatchSetMutation(async () => {
      await this.removeWorkspaceWatch(environmentId);
    });
  }

  async shutdown(): Promise<void> {
    await this.enqueueWatchSetMutation(async () => {
      const entries = [...this.workspaceEntries.values()];
      this.workspaceEntries.clear();
      this.threadStorageTargets.clear();
      await Promise.all(entries.map((entry) => this.stopWorkspaceWatch(entry)));
      await this.stopThreadStorageWatcher();
    });
  }

  workspaceWatchCount(): number {
    return this.workspaceEntries.size;
  }

  threadStorageWatchTargetCount(): number {
    return this.threadStorageTargets.size;
  }

  private async replaceWorkspaceTargets(
    targets: readonly HostDaemonWatchSetWorkspaceTarget[],
  ): Promise<void> {
    const nextTargets = new Map<string, HostDaemonWatchSetWorkspaceTarget>();
    for (const target of targets) {
      nextTargets.set(target.environmentId, target);
    }

    const stops: Promise<void>[] = [];
    for (const [environmentId, entry] of this.workspaceEntries) {
      const nextTarget = nextTargets.get(environmentId);
      if (nextTarget && sameWorkspaceTarget(entry.target, nextTarget)) {
        nextTargets.delete(environmentId);
        continue;
      }
      this.workspaceEntries.delete(environmentId);
      stops.push(this.stopWorkspaceWatch(entry));
    }
    await Promise.all(stops);

    for (const target of nextTargets.values()) {
      await this.startWorkspaceWatch(target);
    }
  }

  private async replaceThreadStorageTargets(
    targets: readonly HostDaemonWatchSetThreadStorageTarget[],
  ): Promise<void> {
    this.threadStorageTargets.clear();
    for (const target of targets) {
      this.threadStorageTargets.set(target.threadId, target);
    }

    if (this.threadStorageTargets.size > 0) {
      this.ensureThreadStorageWatcher();
      return;
    }
    await this.stopThreadStorageWatcher();
  }

  private enqueueWatchSetMutation(work: () => Promise<void>): Promise<void> {
    const next = this.watchSetMutationTail.then(work, work);
    this.watchSetMutationTail = next.catch(() => undefined);
    return next;
  }

  private async applyWatchSet(watchSet: HostDaemonWatchSet): Promise<void> {
    await this.replaceWorkspaceTargets(watchSet.workspaceTargets);
    await this.replaceThreadStorageTargets(watchSet.threadStorageTargets);
    this.latestAppliedWatchSetGeneration = watchSet.generation;
  }

  private async startWorkspaceWatch(
    target: HostDaemonWatchSetWorkspaceTarget,
  ): Promise<void> {
    if (!this.hostWatcher) {
      return;
    }

    try {
      const workspace = await this.provisionWorkspace(
        reconnectProvisionArgsFromWorkspaceContext({
          environmentId: target.environmentId,
          ...(this.options.dataDir
            ? {
                personalWorkspaceRoot: getPersonalWorkspaceRoot(
                  this.options.dataDir,
                ),
              }
            : {}),
          workspaceContext: target.workspaceContext,
        }),
      );
      const entry: WorkspaceWatchEntry = {
        stopWatchingStatus: STOP_WATCHING,
        target,
        watchState: {
          lastLocalFingerprint: null,
          lastSharedRefsFingerprint: null,
          pendingKinds: new Set(),
          processing: null,
        },
        workspace,
      };
      this.workspaceEntries.set(target.environmentId, entry);
      entry.stopWatchingStatus = this.hostWatcher.watchWorkspace({
        environmentId: target.environmentId,
        workspacePath: workspace.path,
        onChange: (event) => {
          this.queueWorkspaceWatchChange({
            changeKinds: event.changeKinds,
            entry,
          });
        },
        onReady: () => {
          this.queueWorkspaceWatchChange({
            changeKinds: ["workspace-content-changed"],
            entry,
          });
        },
        onWatchError: (error) => {
          this.options.onWorkspaceStatusWatchError?.({ error });
        },
      });
      void this.initializeWorkspaceWatchFingerprints(entry);
    } catch (error) {
      this.workspaceEntries.delete(target.environmentId);
      this.options.onWorkspaceStatusWatchError?.({
        error: {
          environmentId: target.environmentId,
          kind: "workspace-watch-error",
          message:
            error instanceof Error
              ? toErrorMessage(error)
              : "Unknown workspace watch error",
          rootPath: target.workspaceContext.workspacePath,
        },
      });
    }
  }

  private async initializeWorkspaceWatchFingerprints(
    entry: WorkspaceWatchEntry,
  ): Promise<void> {
    if (!entry.workspace.isGitRepo) {
      return;
    }
    try {
      const [lastLocalFingerprint, lastSharedRefsFingerprint] =
        await Promise.all([
          entry.workspace.getLocalStateFingerprint(),
          entry.workspace.getSharedGitRefsFingerprint(),
        ]);
      if (this.workspaceEntries.get(entry.target.environmentId) !== entry) {
        return;
      }
      entry.watchState.lastLocalFingerprint = lastLocalFingerprint;
      entry.watchState.lastSharedRefsFingerprint = lastSharedRefsFingerprint;
    } catch (error) {
      if (this.workspaceEntries.get(entry.target.environmentId) !== entry) {
        return;
      }
      this.reportWorkspaceWatchError(entry, error);
    }
  }

  private queueWorkspaceWatchChange(args: {
    changeKinds: readonly WorkspaceStatusWatchChangeKind[];
    entry: WorkspaceWatchEntry;
  }): void {
    if (
      this.workspaceEntries.get(args.entry.target.environmentId) !== args.entry
    ) {
      return;
    }
    if (args.changeKinds.includes("workspace-content-changed")) {
      this.options.onWorkspaceStatusChanged?.({
        changeKinds: ["work-status-changed"],
        environmentId: args.entry.target.environmentId,
      });
    }
    for (const changeKind of args.changeKinds) {
      args.entry.watchState.pendingKinds.add(changeKind);
    }
    if (args.entry.watchState.processing) {
      return;
    }
    this.flushWorkspaceWatchChanges(args);
  }

  private flushWorkspaceWatchChanges(args: {
    entry: WorkspaceWatchEntry;
  }): void {
    const processing = this.processWorkspaceWatchChanges(args).finally(() => {
      if (args.entry.watchState.processing === processing) {
        args.entry.watchState.processing = null;
      }
      if (args.entry.watchState.pendingKinds.size > 0) {
        this.flushWorkspaceWatchChanges(args);
      }
    });
    args.entry.watchState.processing = processing;
  }

  private async processWorkspaceWatchChanges(args: {
    entry: WorkspaceWatchEntry;
  }): Promise<void> {
    const pendingKinds = Array.from(args.entry.watchState.pendingKinds);
    args.entry.watchState.pendingKinds.clear();

    try {
      const changeKinds: HostDaemonEnvironmentChange[] = [];
      if (workspaceWatchKindsIncludeLocalState(pendingKinds)) {
        if (
          pendingKinds.includes("workspace-git-repository-created") &&
          !args.entry.workspace.isGitRepo
        ) {
          await this.refreshGitWorkspaceMetadata(args.entry);
        }
        const workspaceContentChanged = pendingKinds.includes(
          "workspace-content-changed",
        );
        if (args.entry.workspace.isGitRepo && !workspaceContentChanged) {
          const nextLocalFingerprint =
            await args.entry.workspace.getLocalStateFingerprint();
          if (
            args.entry.watchState.lastLocalFingerprint !== nextLocalFingerprint
          ) {
            args.entry.watchState.lastLocalFingerprint = nextLocalFingerprint;
            changeKinds.push("work-status-changed");
          }
        }
      }
      if (
        args.entry.workspace.isGitRepo &&
        pendingKinds.includes("shared-git-refs-changed")
      ) {
        const nextSharedRefsFingerprint =
          await args.entry.workspace.getSharedGitRefsFingerprint();
        if (
          args.entry.watchState.lastSharedRefsFingerprint !==
          nextSharedRefsFingerprint
        ) {
          args.entry.watchState.lastSharedRefsFingerprint =
            nextSharedRefsFingerprint;
          changeKinds.push("git-refs-changed");
        }
      }
      if (changeKinds.length === 0) {
        return;
      }
      this.options.onWorkspaceStatusChanged?.({
        changeKinds,
        environmentId: args.entry.target.environmentId,
      });
    } catch (error) {
      this.reportWorkspaceWatchError(args.entry, error);
    }
  }

  private reportWorkspaceWatchError(
    entry: WorkspaceWatchEntry,
    error: unknown,
  ): void {
    this.options.onWorkspaceStatusWatchError?.({
      error: {
        environmentId: entry.target.environmentId,
        kind: "workspace-watch-error",
        message:
          error instanceof Error
            ? toErrorMessage(error)
            : "Unknown workspace watch error",
        rootPath: entry.target.workspaceContext.workspacePath,
      },
    });
  }

  private async refreshGitWorkspaceMetadata(
    entry: WorkspaceWatchEntry,
  ): Promise<void> {
    if (entry.workspace.isGitRepo) {
      return;
    }
    const provision = reconnectProvisionArgsFromWorkspaceContext({
      environmentId: entry.target.environmentId,
      ...(this.options.dataDir
        ? {
            personalWorkspaceRoot: getPersonalWorkspaceRoot(
              this.options.dataDir,
            ),
          }
        : {}),
      workspaceContext: entry.target.workspaceContext,
    });
    const workspace = await this.refreshWorkspace({
      environmentId: entry.target.environmentId,
      provision,
      workspacePath: entry.target.workspaceContext.workspacePath,
    });
    if (!workspace.isGitRepo) {
      return;
    }

    const [branchName, resolvedDefaultBranch, sharedRefsFingerprint] =
      await Promise.all([
        workspace.getCurrentBranch(),
        workspace.getDefaultBranch(),
        workspace.getSharedGitRefsFingerprint(),
      ]);
    entry.workspace = workspace;
    entry.watchState.lastSharedRefsFingerprint = sharedRefsFingerprint;
    this.options.onWorkspaceMetadataChanged?.({
      environmentId: entry.target.environmentId,
      workspace: {
        path: workspace.path,
        isGitRepo: true,
        isWorktree: workspace.isWorktree,
        branchName,
        defaultBranch: resolvedDefaultBranch ?? branchName,
      },
    });
  }

  private async stopWorkspaceWatch(entry: WorkspaceWatchEntry): Promise<void> {
    const stopWatchingStatus = entry.stopWatchingStatus;
    entry.stopWatchingStatus = STOP_WATCHING;
    await stopWatchingStatus();
  }

  private async removeWorkspaceWatch(environmentId: string): Promise<void> {
    const entry = this.workspaceEntries.get(environmentId);
    if (!entry) {
      return;
    }
    this.workspaceEntries.delete(environmentId);
    await this.stopWorkspaceWatch(entry);
  }

  private ensureThreadStorageWatcher(): void {
    if (
      !this.hostWatcher ||
      this.stopWatchingThreadStorageRoot !== STOP_WATCHING
    ) {
      return;
    }

    const threadStorageRootPath = this.options.threadStorageRootPath;
    if (!threadStorageRootPath) {
      return;
    }

    this.stopWatchingThreadStorageRoot =
      this.hostWatcher.watchThreadStorageRoot({
        threadStorageRootPath,
        resolveThreadTarget: (threadId) =>
          this.threadStorageTargets.get(threadId) ?? null,
        onChange: (event) => {
          if (event.kind === "thread-storage-changed") {
            this.options.onThreadStorageChanged?.({
              environmentId: event.environmentId,
              threadId: event.threadId,
            });
          }
        },
        onWatchError: (error) => {
          this.options.onThreadStorageWatchError?.({
            error,
          });
        },
      });
  }

  private async stopThreadStorageWatcher(): Promise<void> {
    const stopWatchingThreadStorageRoot = this.stopWatchingThreadStorageRoot;
    this.stopWatchingThreadStorageRoot = STOP_WATCHING;
    await stopWatchingThreadStorageRoot();
  }
}
