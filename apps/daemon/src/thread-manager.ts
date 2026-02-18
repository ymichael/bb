import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import {
  assertNever,
  type AvailableModel,
  type ThreadTurnInitiator,
  type ThreadExecutionOptions,
  type SystemProviderInfo,
  type Thread,
  type ThreadEvent,
  type ThreadEventData,
  type ThreadEventType,
  type PromptInput,
  type SpawnThreadRequest,
  type TellThreadRequest,
} from "@beanbag/core";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import { WSManager } from "./ws.js";
import { createCodexProviderAdapter } from "./codex-provider-adapter.js";
import type {
  ProviderAdapter,
  ProviderExecutionOptions,
  ProviderThreadContext,
} from "./provider-adapter.js";
import {
  ProviderRuntime,
  ProviderRuntimeRpcError,
  ProviderRuntimeTimeoutError,
  ProviderRuntimeUnavailableError,
} from "./provider-runtime.js";
import {
  inactiveSessionError,
  invalidRequestError,
  noActiveTurnError,
  projectNotFoundError,
  providerRpcError,
  providerTimeoutError,
  providerUnavailableError,
  threadProvisioningError,
  threadProvisioningFailedError,
  threadArchivedError,
  threadNotFoundError,
  unsupportedOperationError,
} from "./domain-errors.js";
import { canTransitionThreadStatus } from "./thread-status-machine.js";

export type PromptExecutionOptions = ProviderExecutionOptions;

interface TellContext {
  initiator: ThreadTurnInitiator;
}

function resolveBbBinDir(pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  for (const pathEntry of pathValue.split(delimiter)) {
    if (!pathEntry) continue;
    const bbCandidate = join(pathEntry, "bb");
    try {
      accessSync(bbCandidate, constants.X_OK);
      return pathEntry;
    } catch {
      // continue
    }
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function shellEscapeDoubleQuoted(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("$", "\\$")
    .replaceAll("`", "\\`");
}

function resolveBbLaunchTarget():
  | { runnerPath: string; entryPath: string }
  | undefined {
  const cliDistPath = resolve(import.meta.dirname, "..", "..", "cli", "dist", "index.js");
  if (existsSync(cliDistPath)) {
    return {
      runnerPath: process.execPath,
      entryPath: cliDistPath,
    };
  }

  const cliSourcePath = resolve(import.meta.dirname, "..", "..", "cli", "src", "index.ts");
  if (!existsSync(cliSourcePath)) return undefined;

  const tsxRunnerCandidates = [
    resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx"),
    resolve(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx"),
  ];
  const tsxRunnerPath = tsxRunnerCandidates.find((candidate) => isExecutable(candidate));
  if (!tsxRunnerPath) return undefined;

  return {
    runnerPath: tsxRunnerPath,
    entryPath: cliSourcePath,
  };
}

function ensureBbShimBinDir(): string | undefined {
  const launchTarget = resolveBbLaunchTarget();
  if (!launchTarget) return undefined;

  const shimBinDir = join(tmpdir(), "beanbag", "bin");
  const shimPath = join(shimBinDir, "bb");
  const runnerPath = shellEscapeDoubleQuoted(launchTarget.runnerPath);
  const entryPath = shellEscapeDoubleQuoted(launchTarget.entryPath);
  const script = `#!/bin/sh
exec "${runnerPath}" "${entryPath}" "$@"
`;

  try {
    mkdirSync(shimBinDir, { recursive: true });
    writeFileSync(shimPath, script, { encoding: "utf-8", mode: 0o755 });
    return shimBinDir;
  } catch {
    return undefined;
  }
}

function prependPathEntry(
  pathValue: string | undefined,
  entryToPrepend: string,
): string {
  const entries = (pathValue ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && entry !== entryToPrepend);
  return [entryToPrepend, ...entries].join(delimiter);
}

function resolveThreadShellPath(pathValue: string | undefined): string | undefined {
  const bbBinDir = resolveBbBinDir(pathValue);
  if (bbBinDir) return prependPathEntry(pathValue, bbBinDir);

  const shimBinDir = ensureBbShimBinDir();
  if (!shimBinDir) return pathValue;

  return prependPathEntry(pathValue, shimBinDir);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toProviderEventType(method: string): ThreadEventType {
  // Open provider/runtime set: upstream providers can add event methods.
  return method as ThreadEventType;
}

function toProviderEventData(params: unknown): ThreadEventData {
  // Open provider/runtime set: preserve payload shape as delivered by provider.
  return (params ?? {}) as ThreadEventData;
}

function toReasoningLevel(
  value: unknown,
): ThreadExecutionOptions["reasoningLevel"] | undefined {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}

function toSandboxMode(
  value: unknown,
): ThreadExecutionOptions["sandboxMode"] | undefined {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }
  return undefined;
}

function toSandboxModeFromPolicy(
  policy: Record<string, unknown> | null,
): ThreadExecutionOptions["sandboxMode"] | undefined {
  const type = getStringField(policy, "type");
  switch (type) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "dangerFullAccess":
      return "danger-full-access";
    default:
      // Open provider/runtime set: tolerate unknown policy types intentionally.
      return undefined;
  }
}

function toTurnLifecycleState(
  normalizedType: string,
): "active" | "idle" | undefined {
  if (normalizedType === "turn/started" || normalizedType === "turn/start") {
    return "active";
  }
  if (normalizedType === "turn/completed" || normalizedType === "turn/end") {
    return "idle";
  }
  // Open provider/runtime set: ignore non-lifecycle event types intentionally.
  return undefined;
}

export class ThreadManager {
  private processes = new Map<string, ChildProcess>();
  private runtimes = new Map<string, ProviderRuntime>();
  /** Maps our internal thread ID to the provider thread ID */
  private providerThreadIds = new Map<string, string>();
  /** Tracks the currently active provider turn ID for each thread (when known). */
  private activeTurnIds = new Map<string, string>();
  /** Threads explicitly titled by the caller should not be overwritten by event heuristics. */
  private lockedTitleThreadIds = new Set<string>();
  /** Ensure auto-title generation runs at most once per thread. */
  private autoTitleAttemptedThreadIds = new Set<string>();
  /** Emit at most one refresh-token warning per thread process lifecycle. */
  private authRefreshWarningThreadIds = new Set<string>();
  /** Suppresses multiline JSON auth error payloads already summarized above. */
  private suppressedAuthStderrDepth = new Map<string, number>();
  /** Tracks in-flight provisioning operations by thread ID. */
  private provisioningTasks = new Map<string, Promise<void>>();
  /** Monotonic sequence counter per thread for persisted events (inbound + outbound). */
  private eventSeqCounters = new Map<string, number>();
  /** Dedupes parent completion notifications when providers emit duplicate completion events. */
  private lastNotifiedCompletionTurnIds = new Map<string, string>();
  /** Fallback dedupe when provider omits turn IDs on completion events. */
  private lastNotifiedCompletionSeqs = new Map<string, number>();
  private rpcIdCounter = 0;
  private threadShellPath: string | undefined;

  constructor(
    private threadRepo: ThreadRepository,
    private eventRepo: EventRepository,
    private projectRepo: ProjectRepository,
    private ws: WSManager,
    private provider: ProviderAdapter = createCodexProviderAdapter(),
    private runtimeEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.threadShellPath = resolveThreadShellPath(this.runtimeEnv.PATH);
  }

  /**
   * One-time startup reconciliation for persisted thread statuses.
   * - created: reprovision
   * - provisioning: mark failed (interrupted by restart)
   * - active: attempt resume, otherwise demote to idle
   */
  async reconcileActiveThreadsOnBoot(): Promise<void> {
    const createdThreads = this.threadRepo.list({
      status: "created",
      includeArchived: true,
    });
    for (const thread of createdThreads) {
      if (thread.archivedAt !== undefined) {
        this._setThreadStatus(thread.id, "idle");
        continue;
      }
      this._scheduleProvisioning(thread.id, { projectId: thread.projectId });
    }

    const provisioningThreads = this.threadRepo.list({
      status: "provisioning",
      includeArchived: true,
    });
    for (const thread of provisioningThreads) {
      this._cleanupThreadRuntime(thread.id);
      this._setThreadStatus(thread.id, "provisioning_failed");
    }

    const activeThreads = this.threadRepo.list({
      status: "active",
      includeArchived: true,
    });
    if (!Array.isArray(activeThreads) || activeThreads.length === 0) return;

    for (const thread of activeThreads) {
      // Archived threads are never considered running.
      if (thread.archivedAt !== undefined) {
        this.threadRepo.update(thread.id, { status: "idle" });
        this.ws.broadcast("thread", thread.id);
        continue;
      }

      const project = this.projectRepo.getById(thread.projectId);
      const providerThreadId = this._resolvePersistedProviderThreadId(thread.id);
      const latestLifecycle = this._latestTurnLifecycleStatus(thread.id);
      const shouldRemainActive = latestLifecycle === "active";

      if (!project || !providerThreadId || !shouldRemainActive) {
        this.threadRepo.update(thread.id, { status: "idle" });
        this.ws.broadcast("thread", thread.id);
        continue;
      }

      try {
        this._spawnProcess(thread.id, project.rootPath);
        this._sendInitialize(thread.id);
        const resumedThreadId = await this._sendRequestAndAwaitThreadId(
          thread.id,
          this.provider.threadResumeMethod,
          this.provider.createThreadResumeParams(
            providerThreadId,
            this._buildProviderThreadContext({
              threadId: thread.id,
              projectId: thread.projectId,
              taskId: thread.taskId,
            }),
          ),
        );
        this.providerThreadIds.set(thread.id, resumedThreadId);

        const activeTurnId = this._resolvePersistedActiveTurnId(thread.id);
        if (activeTurnId) {
          this.activeTurnIds.set(thread.id, activeTurnId);
        }
      } catch {
        this._cleanupThreadRuntime(thread.id);
        this.threadRepo.update(thread.id, { status: "idle" });
        this.ws.broadcast("thread", thread.id);
      }
    }
  }

  /**
   * Spawn a new provider child process for the given project.
   * Creates a Thread record, starts the process, sets up event streaming,
   * and optionally sends an initial prompt.
   */
  async spawn(req: SpawnThreadRequest): Promise<Thread> {
    // Validate the project exists.
    const project = this.projectRepo.getById(req.projectId);
    if (!project) {
      throw projectNotFoundError(req.projectId);
    }

    // Create thread record in DB
    const explicitTitle = this._normalizeThreadTitle(req.title);
    const derivedTitle = this.provider.deriveThreadTitle(req.input);
    const threadTitle = explicitTitle ?? derivedTitle;
    const thread = this.threadRepo.create({
      projectId: req.projectId,
      ...(threadTitle ? { title: threadTitle } : {}),
      ...(req.taskId ? { taskId: req.taskId } : {}),
      ...(req.taskRole ? { taskRole: req.taskRole } : {}),
      ...(req.agentRoleId ? { agentRoleId: req.agentRoleId } : {}),
      ...(req.parentThreadId ? { parentThreadId: req.parentThreadId } : {}),
    });
    // Treat only truly custom titles as locked. If caller title matches our
    // normal first-message derivation, keep it mutable so server events can refine it.
    if (explicitTitle && explicitTitle !== derivedTitle) {
      this.lockedTitleThreadIds.add(thread.id);
    }

    this.ws.broadcast("thread", thread.id);
    this._scheduleProvisioning(thread.id, req, { rootPathHint: project.rootPath });
    return thread;
  }

  /**
   * Send a message to an active thread via turn/start or turn/steer JSON-RPC.
   */
  async tell(
    threadId: string,
    request: TellThreadRequest,
    options?: PromptExecutionOptions,
    context?: { initiator?: ThreadTurnInitiator },
  ): Promise<void> {
    const initiator = context?.initiator ?? "agent";
    await this._tell(threadId, request, options, { initiator });
  }

  /**
   * Send an internal system-originated message to a thread.
   */
  async systemTell(
    threadId: string,
    request: TellThreadRequest,
    options?: PromptExecutionOptions,
  ): Promise<void> {
    await this._tell(threadId, request, options, { initiator: "system" });
  }

  private async _tell(
    threadId: string,
    request: TellThreadRequest,
    options: PromptExecutionOptions | undefined,
    context: TellContext,
  ): Promise<void> {
    const input = request.input;
    if (input.length === 0) {
      throw invalidRequestError("Tell payload input must be non-empty");
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }
    if (thread.status === "created" || thread.status === "provisioning") {
      throw threadProvisioningError(threadId);
    }
    if (thread.status === "provisioning_failed") {
      this._scheduleProvisioning(
        threadId,
        {
          projectId: thread.projectId,
          model: options?.model,
          reasoningLevel: options?.reasoningLevel,
          sandboxMode: options?.sandboxMode,
        },
        {
          reason: "tell-after-provisioning-failure",
        },
      );
      throw threadProvisioningFailedError(threadId);
    }

    const providerThreadId = await this._ensureProviderSession(threadId, options);
    const tellMode = request.mode ?? "auto";
    const hasExecutionOverrides = Boolean(
      options?.model || options?.reasoningLevel || options?.sandboxMode,
    );
    const activeTurnId =
      this.activeTurnIds.get(threadId) ?? this._resolvePersistedActiveTurnId(threadId);
    if (activeTurnId) {
      this.activeTurnIds.set(threadId, activeTurnId);
    }

    if (!this.provider.generateThreadTitle) {
      const suggestedTitle = this.provider.deriveThreadTitle(input);
      if (suggestedTitle) {
        this._setThreadTitle(threadId, suggestedTitle, {
          onlyIfMissing: true,
        });
      }
    }

    const project = this.projectRepo.getById(thread.projectId);
    if (project) {
      this._maybeAutogenerateThreadTitle(
        threadId,
        project.rootPath,
        providerThreadId,
        input,
      );
    }

    this._setThreadStatus(threadId, "active");

    const steerSupported = Boolean(
      this.provider.turnSteerMethod && this.provider.createTurnSteerParams,
    );
    const shouldUseSteer =
      steerSupported &&
      activeTurnId &&
      (
        tellMode === "steer" ||
        (tellMode === "auto" && !hasExecutionOverrides)
      );

    if (tellMode === "steer") {
      if (!steerSupported) {
        throw unsupportedOperationError(
          `${this.provider.displayName} does not support turn/steer`,
        );
      }
      if (!activeTurnId) {
        throw noActiveTurnError(threadId);
      }
      if (hasExecutionOverrides) {
        throw invalidRequestError(
          "Tell mode 'steer' does not support model or reasoning overrides",
        );
      }
    }

    if (shouldUseSteer && activeTurnId) {
      const steerMsg = {
        jsonrpc: "2.0",
        method: this.provider.turnSteerMethod!,
        id: ++this.rpcIdCounter,
        params: this.provider.createTurnSteerParams!(
          providerThreadId,
          activeTurnId,
          input,
        ),
      };
      this._sendToProcess(threadId, steerMsg);
      return;
    }

    const turnStartMsg = {
      jsonrpc: "2.0",
      method: this.provider.turnStartMethod,
      id: ++this.rpcIdCounter,
      params: this.provider.createTurnStartParams(providerThreadId, input, options),
    };
    this._persistOutboundStartEvent(
      threadId,
      "client/turn/start",
      turnStartMsg.params,
      {
        source: "tell",
        initiator: context.initiator,
      },
    );
    this._sendToProcess(threadId, turnStartMsg);
  }

  /**
   * Stop an active thread by killing its process.
   */
  stop(threadId: string): void {
    const child = this.processes.get(threadId);
    if (child) {
      child.kill("SIGTERM");
      // Give it a moment, then force kill
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }

    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close(new Error(`[thread ${threadId}] Stopping thread`));
      this.runtimes.delete(threadId);
    }

    this.activeTurnIds.delete(threadId);
    this.authRefreshWarningThreadIds.delete(threadId);
    this.suppressedAuthStderrDepth.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.lastNotifiedCompletionSeqs.delete(threadId);
    this.threadRepo.update(threadId, { status: "idle" });
    this.ws.broadcast("thread", threadId);
  }

  /**
   * Archive a thread and stop any active process.
   */
  archive(threadId: string): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    const child = this.processes.get(threadId);
    if (child) {
      child.kill("SIGTERM");
      // Give it a moment, then force kill
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
      this.processes.delete(threadId);
    }

    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close(new Error(`[thread ${threadId}] Archiving thread`));
      this.runtimes.delete(threadId);
    }

    this.providerThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
    this.authRefreshWarningThreadIds.delete(threadId);
    this.suppressedAuthStderrDepth.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.lastNotifiedCompletionSeqs.delete(threadId);
    this.threadRepo.update(threadId, {
      status: "idle",
      archivedAt: thread.archivedAt ?? Date.now(),
    });
    this.ws.broadcast("thread", threadId);
  }

  /**
   * Get events for a thread, optionally after a given sequence number.
   */
  getEvents(threadId: string, afterSeq?: number): ThreadEvent[] {
    return this.eventRepo.listByThread(threadId, afterSeq);
  }

  /**
   * Get the final output of a thread — the text from the last agentMessage
   * completion event recognized by the active provider adapter.
   */
  getOutput(threadId: string): string | undefined {
    const allEvents = this.eventRepo.listByThread(threadId);
    // Walk backwards to find the last output event.
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const output = this.provider.outputFromEvent(allEvents[i]);
      if (output !== undefined) return output;
    }
    return undefined;
  }

  /**
   * Get the thread record by id.
   */
  getById(threadId: string): Thread | undefined {
    return this.threadRepo.getById(threadId);
  }

  getDefaultExecutionOptions(
    threadId: string,
  ): ThreadExecutionOptions | undefined {
    return this.eventRepo.getLatestExecutionOptions(threadId);
  }

  /**
   * List threads with optional filters.
   */
  list(filters?: {
    projectId?: string;
    taskId?: string;
    taskRole?: "primary" | "worker";
    agentRoleId?: string;
    parentThreadId?: string;
    includeArchived?: boolean;
  }): Thread[] {
    return this.threadRepo.list(filters);
  }

  /**
   * Check if a thread's process is currently active.
   */
  isActive(threadId: string): boolean {
    return this.processes.has(threadId);
  }

  /**
   * Get count of currently active (running) thread processes.
   */
  getActiveCount(): number {
    return this.processes.size;
  }

  /**
   * Get count of threads currently marked as active.
   */
  getRunningCount(): number {
    return this.threadRepo.list({ status: "active" }).length;
  }

  /**
   * List available models from the active provider.
   */
  async listModels(): Promise<AvailableModel[]> {
    return this.provider.listModels();
  }

  getProviderInfo(): SystemProviderInfo {
    return {
      id: this.provider.id,
      displayName: this.provider.displayName,
      capabilities: { ...this.provider.capabilities },
    };
  }

  /**
   * Stop all active processes. Called during graceful shutdown.
   */
  stopAll(): void {
    for (const [threadId, child] of this.processes) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
      this.threadRepo.update(threadId, { status: "idle" });
    }
    for (const runtime of this.runtimes.values()) {
      runtime.close();
    }
    this.runtimes.clear();
    this.processes.clear();
    this.providerThreadIds.clear();
    this.activeTurnIds.clear();
    this.autoTitleAttemptedThreadIds.clear();
    this.authRefreshWarningThreadIds.clear();
    this.suppressedAuthStderrDepth.clear();
    this.provisioningTasks.clear();
    this.eventSeqCounters.clear();
    this.lastNotifiedCompletionTurnIds.clear();
    this.lastNotifiedCompletionSeqs.clear();
  }

  private _scheduleProvisioning(
    threadId: string,
    req: SpawnThreadRequest,
    opts?: { rootPathHint?: string; reason?: string },
  ): void {
    if (this.provisioningTasks.has(threadId)) return;

    const task = this._provisionThread(threadId, req, opts)
      .catch((err) => {
        this._cleanupThreadRuntime(threadId);
        this._setThreadStatus(threadId, "provisioning_failed", true, {
          force: true,
        });
        const message = err instanceof Error ? err.message : String(err);
        const reason = opts?.reason ? ` (${opts.reason})` : "";
        console.error(`[thread ${threadId}] provisioning failed${reason}: ${message}`);
      })
      .finally(() => {
        this.provisioningTasks.delete(threadId);
      });

    this.provisioningTasks.set(threadId, task);
  }

  private async _provisionThread(
    threadId: string,
    req: SpawnThreadRequest,
    opts?: { rootPathHint?: string },
  ): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (thread?.archivedAt !== undefined) return;

    const project = this.projectRepo.getById(req.projectId);
    if (!project) {
      throw projectNotFoundError(req.projectId);
    }

    // Ensure provisioning starts from a clean runtime state.
    this._cleanupThreadRuntime(threadId);
    this._setThreadStatus(threadId, "provisioning", true, {
      force: true,
    });

    this._spawnProcess(threadId, opts?.rootPathHint ?? project.rootPath);
    this._sendInitialize(threadId);

    const threadStartParams = this.provider.createThreadStartParams(
      req,
      this._buildProviderThreadContext({
        threadId,
        projectId: req.projectId,
        taskId: thread?.taskId ?? req.taskId,
      }),
    );
    this._persistOutboundStartEvent(
      threadId,
      "client/thread/start",
      threadStartParams,
      {
        source: "spawn",
        initiator: "agent",
      },
    );
    const providerThreadId = await this._sendRequestAndAwaitThreadId(
      threadId,
      this.provider.threadStartMethod,
      threadStartParams,
    );
    this.providerThreadIds.set(threadId, providerThreadId);

    const initialInput = req.input ?? [];
    this._maybeAutogenerateThreadTitle(
      threadId,
      project.rootPath,
      providerThreadId,
      initialInput,
    );

    if (initialInput.length > 0) {
      this._setThreadStatus(threadId, "active");
      const turnStartParams = this.provider.createTurnStartParams(
        providerThreadId,
        initialInput,
        req,
      );
      this._persistOutboundStartEvent(
        threadId,
        "client/turn/start",
        turnStartParams,
        {
          source: "spawn",
          initiator: "agent",
        },
      );
      const turnMsg = {
        jsonrpc: "2.0",
        method: this.provider.turnStartMethod,
        id: ++this.rpcIdCounter,
        params: turnStartParams,
      };
      this._sendToProcess(threadId, turnMsg);
      return;
    }

    this._setThreadStatus(threadId, "idle");
  }

  private _cleanupThreadRuntime(threadId: string): void {
    const child = this.processes.get(threadId);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore shutdown errors
      }
    }
    this.processes.delete(threadId);

    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close();
    }
    this.runtimes.delete(threadId);

    this.providerThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
    this.authRefreshWarningThreadIds.delete(threadId);
    this.suppressedAuthStderrDepth.delete(threadId);
    this.eventSeqCounters.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.lastNotifiedCompletionSeqs.delete(threadId);
  }

  private _spawnProcess(threadId: string, cwd: string): void {
    const thread = this.threadRepo.getById(threadId);
    const projectId = thread?.projectId;
    const taskId = thread?.taskId;
    const child = spawn(this.provider.processCommand, this.provider.processArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: {
        ...this.runtimeEnv,
        ...(this.threadShellPath ? { PATH: this.threadShellPath } : {}),
        ...(projectId ? { BB_PROJECT_ID: projectId } : {}),
        BB_THREAD_ID: threadId,
        ...(taskId ? { BB_TASK_ID: taskId } : {}),
      },
    });

    this.processes.set(threadId, child);
    const runtime = new ProviderRuntime({
      threadId,
      child,
      onNotification: (msg) => {
        this._handleProviderNotification(threadId, msg);
      },
      onUnmatchedRpcError: (requestId, errorMessage) => {
        console.error(
          `[thread ${threadId}] Provider RPC error (request ${requestId}):`,
          errorMessage,
        );
      },
      onStderrLine: (line) => {
        this._handleProviderStderrLine(threadId, line);
      },
    });
    this.runtimes.set(threadId, runtime);

    child.on("exit", (code, signal) => {
      this._handleProcessExit(threadId, code, signal);
    });

    child.on("error", (err) => {
      console.error(`[thread ${threadId}] Process error:`, err.message);
      runtime.close(
        new Error(`[thread ${threadId}] Process error: ${err.message}`),
      );
      this._handleProcessExit(threadId, 1, null);
    });
  }

  private _sendInitialize(threadId: string): void {
    const initMsg = {
      jsonrpc: "2.0",
      method: this.provider.initializeMethod,
      id: ++this.rpcIdCounter,
      params: {
        clientInfo: this.provider.clientInfo,
      },
    };
    this._sendToProcess(threadId, initMsg);
  }

  private _resolvePersistedProviderThreadId(threadId: string): string | undefined {
    const indexedLookup =
      typeof this.eventRepo.getLatestProviderThreadId === "function"
        ? this.eventRepo.getLatestProviderThreadId(threadId)
        : undefined;
    if (indexedLookup) return indexedLookup;

    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const providerThreadId = this.provider.extractThreadIdFromEventData(
        event.data,
      );
      if (providerThreadId) return providerThreadId;
    }
    return undefined;
  }

  private _resolvePersistedActiveTurnId(threadId: string): string | undefined {
    const latestLifecycle =
      typeof this.eventRepo.getLatestTurnLifecycle === "function"
        ? this.eventRepo.getLatestTurnLifecycle(threadId)
        : undefined;
    if (latestLifecycle) {
      const state = toTurnLifecycleState(latestLifecycle.normType);
      if (state === "active") {
        return latestLifecycle.turnId;
      }
      if (state === "idle") return undefined;
    }

    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      const normalizedType = this.provider.normalizeEventType(event.type);
      const state = toTurnLifecycleState(normalizedType);
      if (state === "idle") return undefined;
      if (state === "active") {
        return this._extractTurnIdFromEventData(event.data);
      }
    }
    return undefined;
  }

  private _extractTurnIdFromEventData(data: unknown): string | undefined {
    const payload = asRecord(data);
    if (!payload) return undefined;

    const directTurnId =
      getStringField(payload, "turnId") ?? getStringField(payload, "turn_id");
    if (directTurnId) return directTurnId;

    return getStringField(asRecord(payload.turn), "id");
  }

  private async _ensureProviderSession(
    threadId: string,
    options?: PromptExecutionOptions,
  ): Promise<string> {
    const hasActiveProcess = this.processes.has(threadId);
    const inMemoryThreadId = this.providerThreadIds.get(threadId);
    const persistedThreadId =
      inMemoryThreadId ?? this._resolvePersistedProviderThreadId(threadId);

    if (hasActiveProcess) {
      if (inMemoryThreadId) return inMemoryThreadId;
      if (persistedThreadId) {
        this.providerThreadIds.set(threadId, persistedThreadId);
        return persistedThreadId;
      }
      throw inactiveSessionError(this.provider.inactiveSessionErrorMessage(threadId));
    }

    if (!persistedThreadId) {
      throw inactiveSessionError(this.provider.inactiveSessionErrorMessage(threadId));
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }

    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }

    try {
      this._spawnProcess(threadId, project.rootPath);
      this._sendInitialize(threadId);
      const resumedThreadId = await this._sendRequestAndAwaitThreadId(
        threadId,
        this.provider.threadResumeMethod,
        this.provider.createThreadResumeParams(
          persistedThreadId,
          this._buildProviderThreadContext({
            threadId,
            projectId: thread.projectId,
            taskId: thread.taskId,
          }),
          options,
        ),
      );
      this.providerThreadIds.set(threadId, resumedThreadId);
      return resumedThreadId;
    } catch (err) {
      this._cleanupThreadRuntime(threadId);
      throw err;
    }
  }

  private _buildProviderThreadContext(args: {
    threadId: string;
    projectId: string;
    taskId?: string;
  }): ProviderThreadContext {
    return {
      projectId: args.projectId,
      threadId: args.threadId,
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(this.threadShellPath ? { path: this.threadShellPath } : {}),
    };
  }

  private _handleProviderNotification(
    threadId: string,
    msg: { method: unknown; params: unknown },
  ): void {
    if (typeof msg.method !== "string") {
      return;
    }

    const eventType = toProviderEventType(msg.method);
    const eventData = toProviderEventData(msg.params);

    const persistedEvent = this._appendEvent(threadId, eventType, eventData);

    this._syncTitleFromEvent(threadId, msg.method, eventData);
    this._syncStatusFromEvent(threadId, msg.method);
    this._syncActiveTurnFromEvent(threadId, msg.method, eventData);
    this._maybeNotifyParentOnChildTurnCompletion(threadId, persistedEvent);

    if (this.provider.shouldBroadcastForEvent(msg.method)) {
      this.ws.broadcast("thread", threadId);
    }
  }

  private _appendEvent(
    threadId: string,
    type: ThreadEventType,
    data: ThreadEventData,
  ): ThreadEvent {
    const seq = this._nextEventSeq(threadId);
    const created = this.eventRepo.create({
      threadId,
      seq,
      type,
      data,
    });
    if (created) return created;
    return {
      id: "",
      threadId,
      seq,
      type,
      data: data as ThreadEvent["data"],
      createdAt: Date.now(),
    };
  }

  private _nextEventSeq(threadId: string): number {
    const current =
      this.eventSeqCounters.get(threadId) ?? this.eventRepo.getLatestSeq(threadId);
    const next = current + 1;
    this.eventSeqCounters.set(threadId, next);
    return next;
  }

  private _persistOutboundStartEvent(
    threadId: string,
    type: "client/thread/start" | "client/turn/start",
    params: Record<string, unknown>,
    meta: { source: "spawn" | "tell"; initiator: ThreadTurnInitiator },
  ): void {
    const eventData: ThreadEventData = {
      direction: "outbound",
      source: meta.source,
      initiator: meta.initiator,
      request: {
        method: type === "client/thread/start" ? "thread/start" : "turn/start",
        params,
      },
      execution: this._extractExecutionOptionsFromParams(type, params),
    };

    this._appendEvent(threadId, type, eventData);
  }

  private _maybeNotifyParentOnChildTurnCompletion(
    childThreadId: string,
    event: ThreadEvent,
  ): void {
    const normalizedType = this.provider.normalizeEventType(event.type);
    if (normalizedType !== "turn/completed" && normalizedType !== "turn/end") {
      return;
    }

    const childThread = this.threadRepo.getById(childThreadId);
    if (!childThread) return;
    if (childThread.archivedAt !== undefined) return;
    const parentThreadId = childThread.parentThreadId;
    if (!parentThreadId) return;
    if (parentThreadId === childThreadId) return;

    const parentThread = this.threadRepo.getById(parentThreadId);
    if (!parentThread) return;
    if (parentThread.archivedAt !== undefined) return;

    const turnId = this._extractTurnIdFromEventData(event.data);
    if (turnId) {
      const lastTurnId = this.lastNotifiedCompletionTurnIds.get(childThreadId);
      if (lastTurnId === turnId) return;
      this.lastNotifiedCompletionTurnIds.set(childThreadId, turnId);
    } else {
      const lastSeq = this.lastNotifiedCompletionSeqs.get(childThreadId);
      if (lastSeq === event.seq) return;
      this.lastNotifiedCompletionSeqs.set(childThreadId, event.seq);
    }

    const notification = this._buildParentThreadCompletionNotification(childThread);
    void this.systemTell(parentThreadId, {
      input: [{ type: "text", text: notification }],
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[thread ${childThreadId}] failed to notify parent thread ${parentThreadId}: ${message}`,
      );
    });
  }

  private _buildParentThreadCompletionNotification(childThread: Thread): string {
    return `[bb system] Thread ${childThread.id} is done.`;
  }

  private _extractExecutionOptionsFromParams(
    type: "client/thread/start" | "client/turn/start",
    params: Record<string, unknown>,
  ): ThreadExecutionOptions {
    const model = getStringField(params, "model");
    const approvalPolicy = getStringField(params, "approvalPolicy");
    const config = asRecord(params.config);
    const reasoningLevel = toReasoningLevel(config?.model_reasoning_effort);

    let sandboxMode: ThreadExecutionOptions["sandboxMode"] | undefined;
    switch (type) {
      case "client/thread/start":
        sandboxMode = toSandboxMode(params.sandbox);
        break;
      case "client/turn/start":
        sandboxMode = toSandboxModeFromPolicy(asRecord(params.sandboxPolicy));
        break;
      default:
        return assertNever(type);
    }

    return {
      ...(model ? { model } : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
      ...(sandboxMode ? { sandboxMode } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    };
  }

  /**
   * Handle process exit: update thread status and clean up.
   */
  private _handleProcessExit(
    threadId: string,
    code: number | null,
    signal: string | null,
  ): void {
    this.processes.delete(threadId);
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      runtime.close(
        new Error(
          `[thread ${threadId}] Process exited (${signal ?? code ?? "unknown"})`,
        ),
      );
      this.runtimes.delete(threadId);
    }
    this.providerThreadIds.delete(threadId);
    this.activeTurnIds.delete(threadId);
    this.authRefreshWarningThreadIds.delete(threadId);
    this.suppressedAuthStderrDepth.delete(threadId);
    this.eventSeqCounters.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.lastNotifiedCompletionSeqs.delete(threadId);

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    if (thread.status === "active") {
      this._setThreadStatus(threadId, "idle", false);
    } else if (thread.status === "created" || thread.status === "provisioning") {
      this._setThreadStatus(threadId, "provisioning_failed", false);
    }

    this.ws.broadcast("thread", threadId);
  }

  private _handleProviderStderrLine(threadId: string, line: string): void {
    if (this._consumeSuppressedAuthStderrLine(threadId, line)) {
      return;
    }

    const normalized = line.toLowerCase();
    const isRefreshTokenConflict =
      normalized.includes("refresh_token_reused") ||
      normalized.includes("refresh token has already been used") ||
      normalized.includes("your access token could not be refreshed");
    const isRefreshTokenFailure = normalized.includes("failed to refresh token");

    if (isRefreshTokenFailure || isRefreshTokenConflict) {
      if (!this.authRefreshWarningThreadIds.has(threadId)) {
        this.authRefreshWarningThreadIds.add(threadId);
        console.warn(
          `[thread ${threadId}] provider auth refresh conflict (refresh token reused). ` +
            "Another Codex process likely refreshed credentials first. " +
            "If requests start failing, re-authenticate with `codex login` and restart Beanbag daemon.",
        );
      }

      if (isRefreshTokenFailure && line.includes("{")) {
        const depth = this._braceDepthDelta(line);
        if (depth > 0) {
          this.suppressedAuthStderrDepth.set(threadId, depth);
        }
      }
      return;
    }

    console.error(`[thread ${threadId}] stderr: ${line}`);
  }

  private _consumeSuppressedAuthStderrLine(threadId: string, line: string): boolean {
    const currentDepth = this.suppressedAuthStderrDepth.get(threadId);
    if (!currentDepth || currentDepth <= 0) return false;

    const nextDepth = currentDepth + this._braceDepthDelta(line);
    if (nextDepth > 0) {
      this.suppressedAuthStderrDepth.set(threadId, nextDepth);
    } else {
      this.suppressedAuthStderrDepth.delete(threadId);
    }
    return true;
  }

  private _braceDepthDelta(line: string): number {
    let delta = 0;
    for (const ch of line) {
      if (ch === "{") delta += 1;
      else if (ch === "}") delta -= 1;
    }
    return delta;
  }

  /**
   * Send a JSON-RPC message to a thread's process stdin.
   */
  private _sendToProcess(threadId: string, msg: object): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime) {
      try {
        runtime.send(msg);
      } catch (err) {
        if (err instanceof ProviderRuntimeUnavailableError) {
          throw providerUnavailableError(err.message);
        }
        throw err;
      }
      return;
    }

    // Compatibility fallback for tests and edge cases where a process exists
    // but a runtime has not been registered.
    const child = this.processes.get(threadId);
    if (!child || !child.stdin) {
      throw inactiveSessionError(
        this.provider.inactiveSessionErrorMessage(threadId),
      );
    }
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private async _sendRequestAndAwaitThreadId(
    threadId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const runtime = this.runtimes.get(threadId);
    if (!runtime) {
      throw providerUnavailableError(
        `[thread ${threadId}] No active provider runtime`,
      );
    }

    const requestId = ++this.rpcIdCounter;
    let result: unknown;
    try {
      result = await runtime.request({
        jsonrpc: "2.0",
        method,
        id: requestId,
        params,
      });
    } catch (err) {
      if (err instanceof ProviderRuntimeTimeoutError) {
        throw providerTimeoutError(err.message);
      }
      if (err instanceof ProviderRuntimeRpcError) {
        throw providerRpcError(err.message);
      }
      if (err instanceof ProviderRuntimeUnavailableError) {
        throw providerUnavailableError(err.message);
      }
      throw err;
    }

    const providerThreadId = this.provider.extractThreadIdFromResult(result);
    if (!providerThreadId) {
      throw providerRpcError(
        `[thread ${threadId}] RPC response missing thread ID. Response: ${JSON.stringify(result)}`,
      );
    }

    return providerThreadId;
  }

  private _syncStatusFromEvent(threadId: string, method: string): void {
    const nextStatus = this.provider.statusForEvent(method);
    if (!nextStatus) return;
    this._setThreadStatus(threadId, nextStatus, false);
  }

  private _syncActiveTurnFromEvent(
    threadId: string,
    method: string,
    data: unknown,
  ): void {
    const state = toTurnLifecycleState(this.provider.normalizeEventType(method));
    if (state === "active") {
      const turnId = this._extractTurnIdFromEventData(data);
      if (turnId) this.activeTurnIds.set(threadId, turnId);
      return;
    }
    if (state === "idle") {
      this.activeTurnIds.delete(threadId);
    }
  }

  private _syncTitleFromEvent(
    threadId: string,
    method: string,
    data: unknown,
  ): void {
    const title = this.provider.titleFromEvent(method, data);
    if (!title) return;
    this._setThreadTitle(threadId, title, {
      onlyIfMissing: false,
      shouldBroadcast: false,
    });
  }

  private _setThreadTitle(
    threadId: string,
    value: unknown,
    opts?: { onlyIfMissing?: boolean; shouldBroadcast?: boolean },
  ): void {
    const title = this._normalizeThreadTitle(value);
    if (!title) return;
    if (this.lockedTitleThreadIds.has(threadId)) return;

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;
    if (opts?.onlyIfMissing && thread.title) return;
    if (thread.title === title) return;

    this.threadRepo.update(threadId, { title });
    if (opts?.shouldBroadcast !== false) {
      this.ws.broadcast("thread", threadId);
    }
  }

  private _setThreadStatus(
    threadId: string,
    nextStatus: Thread["status"],
    shouldBroadcast = true,
    opts?: { force?: boolean },
  ): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      if (!opts?.force) return;
      this.threadRepo.update(threadId, { status: nextStatus });
      if (shouldBroadcast) {
        this.ws.broadcast("thread", threadId);
      }
      return;
    }
    if (thread.archivedAt !== undefined && nextStatus === "active") return;

    if (thread.status === nextStatus) return;
    if (!opts?.force && !canTransitionThreadStatus(thread.status, nextStatus)) {
      return;
    }

    this.threadRepo.update(threadId, { status: nextStatus });
    if (shouldBroadcast) {
      this.ws.broadcast("thread", threadId);
    }
  }

  private _maybeAutogenerateThreadTitle(
    threadId: string,
    cwd: string,
    providerThreadId: string,
    input: PromptInput[],
  ): void {
    if (this.lockedTitleThreadIds.has(threadId)) return;
    if (this.autoTitleAttemptedThreadIds.has(threadId)) return;
    if (input.length === 0) return;

    const fallbackTitle = this.provider.deriveThreadTitle(input);
    if (fallbackTitle) {
      this._setThreadTitle(threadId, fallbackTitle, {
        onlyIfMissing: true,
      });
    }

    // Title generation is a one-time attempt bound to the first user message,
    // even if that message has no text or generation later fails.
    this.autoTitleAttemptedThreadIds.add(threadId);

    const hasTextInput = input.some(
      (chunk) => chunk.type === "text" && chunk.text.trim().length > 0,
    );
    if (!hasTextInput) return;
    if (!this.provider.generateThreadTitle) return;
    void this._runAutogeneratedThreadTitle(threadId, cwd, providerThreadId, input);
  }

  private async _runAutogeneratedThreadTitle(
    threadId: string,
    cwd: string,
    providerThreadId: string,
    input: PromptInput[],
  ): Promise<void> {
    try {
      if (!this.provider.generateThreadTitle) return;
      const generatedTitle = await this.provider.generateThreadTitle({
        input,
        cwd,
      });

      if (!generatedTitle) return;

      this._setThreadTitle(threadId, generatedTitle, {
        onlyIfMissing: false,
      });
      // Preserve generated titles against provider-side default renames
      // (for example, first-message fallback names emitted later).
      this.lockedTitleThreadIds.add(threadId);
      this._sendThreadNameSet(threadId, providerThreadId, generatedTitle);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown title generation error";
      console.error(
        `[thread ${threadId}] Failed to auto-generate title (${this.provider.displayName}): ${message}`,
      );
    }
  }

  private _sendThreadNameSet(
    threadId: string,
    providerThreadId: string,
    title: string,
  ): void {
    if (!this.provider.threadNameSetMethod) return;
    if (!this.provider.createThreadNameSetParams) return;

    const child = this.processes.get(threadId);
    if (!child) return;

    try {
      this._sendToProcess(threadId, {
        jsonrpc: "2.0",
        method: this.provider.threadNameSetMethod,
        id: ++this.rpcIdCounter,
        params: this.provider.createThreadNameSetParams(providerThreadId, title),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(
        `[thread ${threadId}] Failed to send ${this.provider.threadNameSetMethod}: ${message}`,
      );
    }
  }

  private _normalizeThreadTitle(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;

    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    if (normalized.length <= 60) return normalized;
    return `${normalized.slice(0, 57).trimEnd()}...`;
  }

  private _latestTurnLifecycleStatus(
    threadId: string,
  ): Thread["status"] | undefined {
    const latestLifecycle =
      typeof this.eventRepo.getLatestTurnLifecycle === "function"
        ? this.eventRepo.getLatestTurnLifecycle(threadId)
        : undefined;
    if (latestLifecycle) {
      const state = toTurnLifecycleState(latestLifecycle.normType);
      if (state) return state;
    }

    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const normalizedType = this.provider.normalizeEventType(events[i].type);
      const state = toTurnLifecycleState(normalizedType);
      if (state) return state;
    }
    return undefined;
  }

}
