import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeOptions,
} from "@bb/agent-runtime";
import type { ThreadEvent, WorkspaceProvisionType } from "@bb/domain";
import type {
  HostDaemonActiveThread,
  HostDaemonEnvironmentChange,
  HostDaemonTrackedThreadTarget,
} from "@bb/host-daemon-contract";
import type {
  HostWatcher,
  ThreadStorageWatchError,
  WorkspaceWatchError,
  WorkspaceStatusWatchChangeKind,
} from "@bb/host-watcher";
import {
  provisionWorkspace,
  type HostWorkspace,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";

const STOP_WATCHING = () => undefined;
const LOCAL_WORKSPACE_WATCH_CHANGE_KINDS: readonly WorkspaceStatusWatchChangeKind[] = [
  "workspace-content-changed",
  "workspace-git-changed",
];

interface RuntimeThreadState {
  providerThreadId: string;
  status: "active" | "idle";
}

interface ThreadStorageTarget {
  environmentId: string;
  threadId: string;
}

interface WorkspaceWatchState {
  lastLocalFingerprint: string | null;
  lastSharedRefsFingerprint: string | null;
  pendingKinds: Set<WorkspaceStatusWatchChangeKind>;
  processing: Promise<void> | null;
}

function lazyProvisionOpts(
  workspacePath: string,
  workspaceProvisionType: WorkspaceProvisionType,
): ProvisionWorkspaceArgs {
  switch (workspaceProvisionType) {
    case "unmanaged":
      return { workspaceProvisionType: "unmanaged", path: workspacePath };
    case "managed-worktree":
      return { workspaceProvisionType: "reconnect-managed-worktree", path: workspacePath };
    case "managed-clone":
      return { workspaceProvisionType: "reconnect-managed-clone", path: workspacePath };
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Unknown workspace watch error";
}

function workspaceWatchKindsIncludeLocalState(
  changeKinds: readonly WorkspaceStatusWatchChangeKind[],
): boolean {
  return changeKinds.some((changeKind) =>
    LOCAL_WORKSPACE_WATCH_CHANGE_KINDS.includes(changeKind)
  );
}

function workspaceWatchKindsIncludeSharedRefs(
  changeKinds: readonly WorkspaceStatusWatchChangeKind[],
): boolean {
  return changeKinds.includes("shared-git-refs-changed");
}

export interface RuntimeEntry {
  environmentId: string;
  runtime: AgentRuntime;
  stopWatchingStatus: () => void;
  workspace: HostWorkspace;
  path: string;
  threads: Map<string, RuntimeThreadState>;
}

export interface EnsureEnvironmentArgs {
  environmentId: string;
  workspacePath?: string;
  workspaceProvisionType?: WorkspaceProvisionType;
  provision?: ProvisionWorkspaceArgs;
}

export interface RuntimeManagerOptions {
  bridgeBundleDir?: AgentRuntimeOptions["bridgeBundleDir"];
  createRuntime?: (options: AgentRuntimeOptions) => AgentRuntime;
  hostWatcher?: HostWatcher;
  provisionWorkspace?: (
    options: ProvisionWorkspaceArgs,
  ) => Promise<HostWorkspace>;
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
  shellEnv?: AgentRuntimeOptions["shellEnv"];
  onEvent?: (args: { environmentId: string; event: ThreadEvent }) => void;
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
  onWorkspaceStatusWatchError?: (args: {
    error: WorkspaceWatchError;
  }) => void;
  onToolCall?: AgentRuntimeOptions["onToolCall"];
  onStderr?: AgentRuntimeOptions["onStderr"];
  onProcessExit?: AgentRuntimeOptions["onProcessExit"];
}

export class RuntimeManager {
  private readonly createRuntime;
  private readonly hostWatcher;
  private readonly provisionWorkspace;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingEntries = new Map<string, Promise<RuntimeEntry>>();
  private readonly trackedThreadStorageTargets = new Map<string, ThreadStorageTarget>();
  private stopWatchingThreadStorageRoot: () => void = STOP_WATCHING;

  constructor(private readonly options: RuntimeManagerOptions = {}) {
    this.createRuntime = options.createRuntime ?? createAgentRuntime;
    this.hostWatcher = options.hostWatcher;
    this.provisionWorkspace = options.provisionWorkspace ?? provisionWorkspace;
  }

  private async createWorkspaceWatchState(
    workspace: HostWorkspace,
  ): Promise<WorkspaceWatchState> {
    if (!workspace.isGitRepo) {
      return {
        lastLocalFingerprint: null,
        lastSharedRefsFingerprint: null,
        pendingKinds: new Set(),
        processing: null,
      };
    }

    const [lastLocalFingerprint, lastSharedRefsFingerprint] = await Promise.all([
      workspace.getLocalStateFingerprint(),
      workspace.getSharedGitRefsFingerprint(),
    ]);
    return {
      lastLocalFingerprint,
      lastSharedRefsFingerprint,
      pendingKinds: new Set(),
      processing: null,
    };
  }

  private queueWorkspaceWatchChange(args: {
    changeKinds: readonly WorkspaceStatusWatchChangeKind[];
    environmentId: string;
    workspace: HostWorkspace;
    workspacePath: string;
    workspaceWatchState: WorkspaceWatchState;
  }): void {
    for (const changeKind of args.changeKinds) {
      args.workspaceWatchState.pendingKinds.add(changeKind);
    }
    if (args.workspaceWatchState.processing) {
      return;
    }
    this.flushWorkspaceWatchChanges(args);
  }

  private flushWorkspaceWatchChanges(args: {
    environmentId: string;
    workspace: HostWorkspace;
    workspacePath: string;
    workspaceWatchState: WorkspaceWatchState;
  }): void {
    const processing = this.processWorkspaceWatchChanges(args).finally(() => {
      if (args.workspaceWatchState.processing === processing) {
        args.workspaceWatchState.processing = null;
      }
      if (args.workspaceWatchState.pendingKinds.size > 0) {
        this.flushWorkspaceWatchChanges(args);
      }
    });
    args.workspaceWatchState.processing = processing;
  }

  private async processWorkspaceWatchChanges(args: {
    environmentId: string;
    workspace: HostWorkspace;
    workspacePath: string;
    workspaceWatchState: WorkspaceWatchState;
  }): Promise<void> {
    const pendingKinds = Array.from(args.workspaceWatchState.pendingKinds);
    args.workspaceWatchState.pendingKinds.clear();

    try {
      const changeKinds: HostDaemonEnvironmentChange[] = [];
      if (workspaceWatchKindsIncludeLocalState(pendingKinds)) {
        const nextLocalFingerprint = await args.workspace.getLocalStateFingerprint();
        if (args.workspaceWatchState.lastLocalFingerprint !== nextLocalFingerprint) {
          args.workspaceWatchState.lastLocalFingerprint = nextLocalFingerprint;
          changeKinds.push("work-status-changed");
        }
      }
      if (workspaceWatchKindsIncludeSharedRefs(pendingKinds)) {
        const nextSharedRefsFingerprint =
          await args.workspace.getSharedGitRefsFingerprint();
        if (
          args.workspaceWatchState.lastSharedRefsFingerprint !==
          nextSharedRefsFingerprint
        ) {
          args.workspaceWatchState.lastSharedRefsFingerprint =
            nextSharedRefsFingerprint;
          changeKinds.push("git-refs-changed");
        }
      }
      if (changeKinds.length === 0) {
        return;
      }
      this.options.onWorkspaceStatusChanged?.({
        changeKinds,
        environmentId: args.environmentId,
      });
    } catch (error) {
      this.options.onWorkspaceStatusWatchError?.({
        error: {
          environmentId: args.environmentId,
          kind: "workspace-watch-error",
          message: toErrorMessage(error),
          rootPath: args.workspacePath,
        },
      });
    }
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

  hasThread(environmentId: string, threadId: string): boolean {
    return this.entries.get(environmentId)?.threads.has(threadId) ?? false;
  }

  markThreadActive(
    environmentId: string,
    threadId: string,
    providerThreadId: string,
  ): void {
    const entry = this.entries.get(environmentId);
    if (!entry) {
      return;
    }

    entry.threads.set(threadId, {
      providerThreadId,
      status: "active",
    });
    this.trackedThreadStorageTargets.set(threadId, {
      environmentId,
      threadId,
    });
    this.ensureThreadStorageWatcher();
  }

  markThreadInactive(environmentId: string, threadId: string): void {
    const current = this.entries.get(environmentId)?.threads.get(threadId);
    if (!current) {
      return;
    }

    this.entries.get(environmentId)?.threads.set(threadId, {
      ...current,
      status: "idle",
    });
  }

  listActiveThreads(): HostDaemonActiveThread[] {
    const activeThreads: HostDaemonActiveThread[] = [];
    for (const entry of this.entries.values()) {
      for (const [threadId, thread] of entry.threads) {
        if (thread.status !== "active") {
          continue;
        }
        activeThreads.push({
          threadId,
        });
      }
    }
    return activeThreads;
  }

  replaceTrackedThreadStorageTargets(
    targets: readonly HostDaemonTrackedThreadTarget[],
  ): void {
    this.trackedThreadStorageTargets.clear();
    for (const target of targets) {
      this.trackedThreadStorageTargets.set(target.threadId, {
        environmentId: target.environmentId,
        threadId: target.threadId,
      });
    }
    if (this.trackedThreadStorageTargets.size > 0) {
      this.ensureThreadStorageWatcher();
      return;
    }
    this.stopWatchingThreadStorageIfNoTrackedThreads();
  }

  async openWorkspace(path: string): Promise<HostWorkspace> {
    return this.provisionWorkspace({
      workspaceProvisionType: "unmanaged",
      path,
    });
  }

  async ensureEnvironment(args: EnsureEnvironmentArgs): Promise<RuntimeEntry> {
    const existing = this.entries.get(args.environmentId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingEntries.get(args.environmentId);
    if (pending) {
      return pending;
    }

    const creation = this.createEntry(args).finally(() => {
      this.pendingEntries.delete(args.environmentId);
    });
    this.pendingEntries.set(args.environmentId, creation);

    const entry = await creation;
    this.entries.set(args.environmentId, entry);
    return entry;
  }

  async destroyEnvironment(environmentId: string): Promise<void> {
    const existing = this.entries.get(environmentId);
    const pending = this.pendingEntries.get(environmentId);
    const entry = existing ?? (pending ? await pending : undefined);

    if (!entry) {
      return;
    }

    this.entries.delete(environmentId);
    this.removeTrackedThreadStorageTargetsForEnvironment(environmentId);
    this.stopWatchingStatus(entry);
    this.stopWatchingThreadStorageIfNoTrackedThreads();
    await entry.runtime.shutdown();
    await entry.workspace.destroy();
  }

  async shutdownAll(): Promise<void> {
    const entries = [...this.entries.values()];
    for (const pending of this.pendingEntries.values()) {
      try {
        entries.push(await pending);
      } catch {
        // Ignore failed provisions during shutdown
      }
    }
    this.entries.clear();
    this.pendingEntries.clear();
    this.trackedThreadStorageTargets.clear();

    for (const entry of entries) {
      this.stopWatchingStatus(entry);
      await entry.runtime.shutdown();
      // Do NOT call workspace.destroy() — the server owns managed workspace
      // lifecycle via explicit environment.destroy commands. Daemon shutdown
      // should only release in-memory state and stop provider processes.
    }
    this.stopWatchingThreadStorageRoot();
    this.stopWatchingThreadStorageRoot = STOP_WATCHING;
  }

  private async createEntry(args: EnsureEnvironmentArgs): Promise<RuntimeEntry> {
    const provision =
      args.provision ??
      (args.workspacePath
        ? lazyProvisionOpts(args.workspacePath, args.workspaceProvisionType ?? "unmanaged")
        : null);

    if (!provision) {
      throw new Error(`Missing workspace path for environment ${args.environmentId}`);
    }

    const workspace = await this.provisionWorkspace(provision);
    const workspaceWatchState = await this.createWorkspaceWatchState(workspace);
    const stopWatchingStatus = this.hostWatcher
      ? this.hostWatcher.watchWorkspace({
          environmentId: args.environmentId,
          workspacePath: workspace.path,
          onChange: (event) => {
            this.queueWorkspaceWatchChange({
              changeKinds: event.changeKinds,
              environmentId: args.environmentId,
              workspace,
              workspacePath: workspace.path,
              workspaceWatchState,
            });
          },
          onWatchError: (error) => {
            this.options.onWorkspaceStatusWatchError?.({
              error,
            });
          },
        })
      : () => undefined;
    const threads = new Map<string, RuntimeThreadState>();
    let runtime: AgentRuntime | null = null;
    try {
      runtime = this.createRuntime({
        workspacePath: workspace.path,
        adapterFactory: this.options.adapterFactory,
        shellEnv: this.options.shellEnv,
        bridgeBundleDir: this.options.bridgeBundleDir,
        onEvent: (event) => {
          if (event.type === "thread/identity") {
            this.markThreadActive(
              args.environmentId,
              event.threadId,
              event.providerThreadId,
            );
          } else if (event.type === "turn/completed") {
            this.markThreadInactive(args.environmentId, event.threadId);
          }
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
        onStderr: this.options.onStderr,
        onProcessExit: (info) => {
          for (const threadId of info.threadIds) {
            threads.delete(threadId);
          }
          const current = this.entries.get(args.environmentId);
          if (
            current?.runtime === runtime &&
            runtime?.listRunningProviders().length === 0
          ) {
            this.stopWatchingStatus(current);
            this.entries.delete(args.environmentId);
            this.stopWatchingThreadStorageIfNoTrackedThreads();
          }
          this.options.onProcessExit?.(info);
        },
      });
    } catch (error) {
      stopWatchingStatus();
      throw error;
    }

    return {
      environmentId: args.environmentId,
      runtime,
      stopWatchingStatus,
      workspace,
      path: workspace.path,
      threads,
    };
  }

  private stopWatchingStatus(entry: RuntimeEntry): void {
    const stopWatchingStatus = entry.stopWatchingStatus;
    entry.stopWatchingStatus = STOP_WATCHING;
    stopWatchingStatus();
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

    this.stopWatchingThreadStorageRoot = this.hostWatcher.watchThreadStorageRoot({
      threadStorageRootPath,
      resolveThreadTarget: (threadId) => this.findTrackedThreadTarget(threadId),
      onChange: (event) => {
        if (event.kind !== "thread-storage-changed") {
          return;
        }
        this.options.onThreadStorageChanged?.({
          environmentId: event.environmentId,
          threadId: event.threadId,
        });
      },
      onWatchError: (error) => {
        this.options.onThreadStorageWatchError?.({
          error,
        });
      },
    });
  }

  private findTrackedThreadTarget(threadId: string): ThreadStorageTarget | null {
    return this.trackedThreadStorageTargets.get(threadId) ?? null;
  }

  private removeTrackedThreadStorageTargetsForEnvironment(
    environmentId: string,
  ): void {
    for (const [threadId, target] of this.trackedThreadStorageTargets) {
      if (target.environmentId === environmentId) {
        this.trackedThreadStorageTargets.delete(threadId);
      }
    }
  }

  private stopWatchingThreadStorageIfNoTrackedThreads(): void {
    if (this.trackedThreadStorageTargets.size > 0) {
      return;
    }
    const stopWatchingThreadStorageRoot = this.stopWatchingThreadStorageRoot;
    this.stopWatchingThreadStorageRoot = STOP_WATCHING;
    stopWatchingThreadStorageRoot();
  }
}
