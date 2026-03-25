import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeOptions,
} from "@bb/agent-runtime";
import type { ThreadEvent } from "@bb/domain";
import type { HostDaemonActiveThread } from "@bb/host-daemon-contract";
import {
  provisionWorkspace,
  type IWorkspace,
  type ProvisionWorkspaceOpts,
} from "@bb/workspace";

export interface RuntimeEntry {
  environmentId: string;
  runtime: AgentRuntime;
  workspace: IWorkspace;
  path: string;
  activeThreads: Map<string, { providerThreadId?: string }>;
}

export interface EnsureEnvironmentArgs {
  environmentId: string;
  workspacePath?: string;
  provision?: ProvisionWorkspaceOpts;
}

export interface RuntimeManagerOptions {
  createRuntime?: (options: AgentRuntimeOptions) => AgentRuntime;
  provisionWorkspace?: (options: ProvisionWorkspaceOpts) => Promise<IWorkspace>;
  adapterFactory?: AgentRuntimeOptions["adapterFactory"];
  onEvent?: (args: { environmentId: string; event: ThreadEvent }) => void;
  onToolCall?: AgentRuntimeOptions["onToolCall"];
  onStderr?: AgentRuntimeOptions["onStderr"];
  onProcessExit?: AgentRuntimeOptions["onProcessExit"];
}

export class RuntimeManager {
  private readonly createRuntime;
  private readonly provisionWorkspace;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingEntries = new Map<string, Promise<RuntimeEntry>>();

  constructor(private readonly options: RuntimeManagerOptions = {}) {
    this.createRuntime = options.createRuntime ?? createAgentRuntime;
    this.provisionWorkspace = options.provisionWorkspace ?? provisionWorkspace;
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
    return this.entries.get(environmentId)?.activeThreads.has(threadId) ?? false;
  }

  markThreadActive(
    environmentId: string,
    threadId: string,
    providerThreadId?: string,
  ): void {
    const entry = this.entries.get(environmentId);
    if (!entry) {
      return;
    }

    const current = entry.activeThreads.get(threadId) ?? {};
    entry.activeThreads.set(threadId, {
      providerThreadId: providerThreadId ?? current.providerThreadId,
    });
  }

  markThreadInactive(environmentId: string, threadId: string): void {
    this.entries.get(environmentId)?.activeThreads.delete(threadId);
  }

  listActiveThreads(): HostDaemonActiveThread[] {
    const activeThreads: HostDaemonActiveThread[] = [];
    for (const [environmentId, entry] of this.entries) {
      for (const [threadId, thread] of entry.activeThreads) {
        activeThreads.push({
          environmentId,
          threadId,
          providerThreadId: thread.providerThreadId,
        });
      }
    }
    return activeThreads;
  }

  async openWorkspace(path: string): Promise<IWorkspace> {
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
    await entry.runtime.shutdown();
    await entry.workspace.destroy();
  }

  async shutdownAll(): Promise<void> {
    const environmentIds = new Set<string>([
      ...this.entries.keys(),
      ...this.pendingEntries.keys(),
    ]);

    for (const environmentId of environmentIds) {
      await this.destroyEnvironment(environmentId);
    }
  }

  private async createEntry(args: EnsureEnvironmentArgs): Promise<RuntimeEntry> {
    const provision =
      args.provision ??
      (args.workspacePath
        ? {
            workspaceProvisionType: "unmanaged" as const,
            path: args.workspacePath,
          }
        : null);

    if (!provision) {
      throw new Error(`Missing workspace path for environment ${args.environmentId}`);
    }

    const workspace = await this.provisionWorkspace(provision);
    const runtime = this.createRuntime({
      workspacePath: workspace.path,
      adapterFactory: this.options.adapterFactory,
      onEvent: (event) => {
        if (event.type === "thread/identity") {
          this.markThreadActive(
            args.environmentId,
            event.threadId,
            event.providerThreadId,
          );
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
      onProcessExit: this.options.onProcessExit,
    });

    return {
      environmentId: args.environmentId,
      runtime,
      workspace,
      path: workspace.path,
      activeThreads: new Map(),
    };
  }
}
