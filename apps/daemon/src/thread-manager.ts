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
  createProviderEventEnvelope,
  extractProviderThreadIdFromPersistedEventData,
  extractTurnIdFromPersistedEventData,
  getStringField,
  resolveProviderEventMethod,
  buildThreadDetailRows,
  toRecord,
  toUIMessages,
  unwrapProviderEventPayload,
  type AvailableModel,
  type EnvironmentAdapter,
  type EnvironmentSession,
  type ProviderAdapter,
  type ProviderExecutionOptions,
  type ProviderThreadContext,
  type SchedulerService,
  type SystemEnvironmentInfo,
  type SystemProviderInfo,
  type ThreadOrchestrator,
  type ThreadTurnInitiator,
  type ThreadExecutionOptions,
  type Thread,
  type ThreadEvent,
  type ThreadEventData,
  type ThreadEventDataForType,
  type ThreadEventType,
  type PromptInput,
  type SpawnThreadRequest,
  type TellThreadRequest,
  type ThreadProvisioningState,
  type CommitThreadRequest,
  type CommitThreadResponse,
  type MergeThreadResponse,
  type SquashMergeThreadRequest,
  type SquashMergeThreadResponse,
  type ThreadTimelineResponse,
  type ThreadToolGroupMessagesRequest,
  type ThreadToolGroupMessagesResponse,
  type ThreadChangeKind,
} from "@beanbag/agent-core";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import {
  createCodexProviderAdapter,
  createEnvironmentAdapter,
  createLocalEnvironmentAdapter,
  ProviderRuntime,
  ProviderRuntimeRpcError,
  ProviderRuntimeTimeoutError,
  ProviderRuntimeUnavailableError,
} from "@beanbag/agent-server";
import { WSManager } from "./ws.js";
import {
  isDomainError,
  inactiveSessionError,
  invalidRequestError,
  noActiveTurnError,
  projectNotFoundError,
  providerRpcError,
  providerTimeoutError,
  providerUnavailableError,
  threadProvisioningError,
  threadArchivedError,
  threadNotFoundError,
  unsupportedOperationError,
} from "./domain-errors.js";
import { InMemorySchedulerService } from "./scheduler-service.js";
import { canTransitionThreadStatus } from "./thread-status-machine.js";
import { ThreadGitStatusService } from "./thread-git-status.js";
import { ThreadAttributedDiffService } from "./thread-attributed-diff.js";

export type PromptExecutionOptions = ProviderExecutionOptions;

interface TellContext {
  initiator: ThreadTurnInitiator;
}

interface ActiveEnvironmentRuntime {
  adapter: EnvironmentAdapter;
  session: EnvironmentSession;
}

interface ThreadTimelineCacheEntry {
  latestSeq: number;
  threadStatus: Thread["status"] | undefined;
  byRequestKey: Map<string, ThreadTimelineResponse>;
}

// Open provider/runtime event type set: unknown values are intentionally not filtered.
const TIMELINE_NOISE_EVENT_TYPES: readonly string[] = [
  "thread/started",
  "thread/name/updated",
  "account/rateLimits/updated",
  "thread/tokenUsage/updated",
  "item/reasoning/summaryPartAdded",
  "codex/event/agent_message_delta",
  "codex/event/agent_message_content_delta",
  "codex/event/agent_reasoning_delta",
  "codex/event/reasoning_content_delta",
  "codex/event/exec_command_output_delta",
];

const THREAD_STATUS_CHANGE_KINDS: readonly ThreadChangeKind[] = [
  "status-changed",
  "work-status-changed",
];

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

function toProviderEventType(method: string): ThreadEventType {
  // Open provider/runtime set: upstream providers can add event methods.
  return method as ThreadEventType;
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

export class ThreadManager implements ThreadOrchestrator {
  private processes = new Map<string, ChildProcess>();
  private runtimes = new Map<string, ProviderRuntime>();
  private environmentRuntimes = new Map<string, ActiveEnvironmentRuntime>();
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
  /** Lifecycle epoch counter, incremented on each turn/start or turn/started event. */
  private turnLifecycleEpochs = new Map<string, number>();
  /** Fallback dedupe keyed by turn lifecycle epoch when completion events omit turn IDs. */
  private lastNotifiedCompletionEpochs = new Map<string, number>();
  /** Memoized timeline projection per thread until event sequence or thread status changes. */
  private timelineByThread = new Map<string, ThreadTimelineCacheEntry>();
  private rpcIdCounter = 0;
  private threadShellPath: string | undefined;
  private providerCatalog: SystemProviderInfo[];
  private environmentCatalog: SystemEnvironmentInfo[];
  private gitStatusService = new ThreadGitStatusService();
  private attributedDiffService = new ThreadAttributedDiffService();

  constructor(
    private threadRepo: ThreadRepository,
    private eventRepo: EventRepository,
    private projectRepo: ProjectRepository,
    private ws: WSManager,
    private provider: ProviderAdapter = createCodexProviderAdapter(),
    private runtimeEnv: NodeJS.ProcessEnv = process.env,
    private environmentAdapter: EnvironmentAdapter = createLocalEnvironmentAdapter(),
    providerCatalog?: SystemProviderInfo[],
    environmentCatalog?: SystemEnvironmentInfo[],
    private scheduler: SchedulerService = new InMemorySchedulerService(),
  ) {
    this.threadShellPath = resolveThreadShellPath(this.runtimeEnv.PATH);
    this.providerCatalog =
      providerCatalog ??
      [
        {
          id: this.provider.id,
          displayName: this.provider.displayName,
          capabilities: { ...this.provider.capabilities },
        },
      ];
    this.environmentCatalog =
      environmentCatalog ??
      [
        {
          ...this.environmentAdapter.info,
          capabilities: { ...this.environmentAdapter.info.capabilities },
        },
      ];
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
        this._setThreadStatus(thread.id, "idle", true, { touchUpdatedAt: false });
        continue;
      }
      this._scheduleProvisioning(thread.id, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
      });
    }

    const provisioningThreads = this.threadRepo.list({
      status: "provisioning",
      includeArchived: true,
    });
    for (const thread of provisioningThreads) {
      this._cleanupThreadRuntime(thread.id);
      this._setThreadStatus(thread.id, "provisioning_failed", true, {
        touchUpdatedAt: false,
      });
    }

    const activeThreads = this.threadRepo.list({
      status: "active",
      includeArchived: true,
    });
    if (!Array.isArray(activeThreads) || activeThreads.length === 0) return;

    for (const thread of activeThreads) {
      // Archived threads are never considered running.
      if (thread.archivedAt !== undefined) {
        this.threadRepo.update(thread.id, { status: "idle" }, { touchUpdatedAt: false });
        this._broadcastThreadChanged(thread.id, THREAD_STATUS_CHANGE_KINDS);
        continue;
      }

      const project = this.projectRepo.getById(thread.projectId);
      const providerThreadId = this._resolvePersistedProviderThreadId(thread.id);
      const latestLifecycle = this._latestTurnLifecycleStatus(thread.id);
      const shouldRemainActive = latestLifecycle === "active";

      if (!project || !providerThreadId || !shouldRemainActive) {
        this.threadRepo.update(thread.id, { status: "idle" }, { touchUpdatedAt: false });
        this._broadcastThreadChanged(thread.id, THREAD_STATUS_CHANGE_KINDS);
        continue;
      }

      try {
        const environmentAdapter = this._resolveThreadEnvironmentAdapter({
          thread,
        });
        this._spawnProcess(thread.id, project.rootPath, environmentAdapter);
        this._sendInitialize(thread.id);
        const resumedThreadId = await this._sendRequestAndAwaitThreadId(
          thread.id,
          this.provider.threadResumeMethod,
          this.provider.createThreadResumeParams(
            providerThreadId,
            this._buildProviderThreadContext({
              threadId: thread.id,
              projectId: thread.projectId,
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
        this.threadRepo.update(thread.id, { status: "idle" }, { touchUpdatedAt: false });
        this._broadcastThreadChanged(thread.id, THREAD_STATUS_CHANGE_KINDS);
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
    const environmentId = this._resolveRequestedEnvironmentId(req.environmentId);
    const thread = this.threadRepo.create({
      projectId: req.projectId,
      ...(threadTitle ? { title: threadTitle } : {}),
      environmentId,
      ...(req.parentThreadId ? { parentThreadId: req.parentThreadId } : {}),
    });
    // Treat only truly custom titles as locked. If caller title matches our
    // normal first-message derivation, keep it mutable so server events can refine it.
    if (explicitTitle && explicitTitle !== derivedTitle) {
      this.lockedTitleThreadIds.add(thread.id);
    }

    this._broadcastThreadChanged(thread.id, ["thread-created"]);
    this._scheduleProvisioning(
      thread.id,
      { ...req, environmentId },
      { rootPathHint: project.rootPath },
    );
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
    const requestedInput = request.input;
    if (requestedInput.length === 0) {
      throw invalidRequestError("Tell payload input must be non-empty");
    }
    const providerInput = this._normalizePromptInputForProvider(requestedInput);

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
          input: requestedInput,
          model: options?.model,
          reasoningLevel: options?.reasoningLevel,
          sandboxMode: options?.sandboxMode,
          environmentId: thread.environmentId,
        },
        {
          reason: "tell-after-provisioning-failure",
        },
      );
      return;
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
      const suggestedTitle = this.provider.deriveThreadTitle(requestedInput);
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
        requestedInput,
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
          providerInput,
        ),
      };
      this._sendToProcess(threadId, steerMsg);
      return;
    }

    const turnStartMsg = {
      jsonrpc: "2.0",
      method: this.provider.turnStartMethod,
      id: ++this.rpcIdCounter,
      params: this.provider.createTurnStartParams(
        providerThreadId,
        providerInput,
        options,
      ),
    };
    this._persistOutboundStartEvent(
      threadId,
      "client/turn/start",
      turnStartMsg.params,
      requestedInput,
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
    const thread = this.threadRepo.getById(threadId);
    if (thread) {
      this._invalidateThreadWorkStatus(thread);
    }
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
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this._cleanupEnvironmentSession(threadId);
    this.threadRepo.update(threadId, { status: "idle" });
    this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
  }

  /**
   * Archive a thread and stop any active process.
   */
  archive(threadId: string): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;
    this._invalidateThreadWorkStatus(thread);

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
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this._cleanupEnvironmentSession(threadId, { destroyWorkspace: true });
    this.threadRepo.update(threadId, {
      status: "idle",
      archivedAt: thread.archivedAt ?? Date.now(),
    });
    this._broadcastThreadChanged(threadId, [
      ...THREAD_STATUS_CHANGE_KINDS,
      "archived-changed",
    ]);
  }

  unarchive(threadId: string): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread || thread.archivedAt === undefined) return;
    this.threadRepo.update(threadId, {
      archivedAt: null,
    });
    this._broadcastThreadChanged(threadId, ["archived-changed"]);
  }


  markRead(threadId: string): Thread {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }

    const updated = this.threadRepo.markRead(threadId, thread.updatedAt);
    if (!updated) {
      throw threadNotFoundError(threadId);
    }

    if ((thread.lastReadAt ?? 0) !== updated.lastReadAt) {
      this._broadcastThreadChanged(threadId, ["read-state-changed"]);
    }

    return updated;
  }

  /**
   * Get events for a thread, optionally after a given sequence number.
   */
  getEvents(threadId: string, afterSeq?: number, limit?: number): ThreadEvent[] {
    return this.eventRepo.listByThread(threadId, afterSeq, limit);
  }

  getTimeline(
    threadId: string,
    limit?: number,
    includeToolGroupMessages: boolean = false,
  ): ThreadTimelineResponse {
    const thread = this.threadRepo.getById(threadId);
    const latestSeq = this.eventRepo.getLatestSeq(threadId);
    const requestKey = `${limit ?? "all"}:${includeToolGroupMessages ? "with-tool-messages" : "summary-only"}`;
    const existingCache = this.timelineByThread.get(threadId);
    if (
      existingCache &&
      existingCache.latestSeq === latestSeq &&
      existingCache.threadStatus === thread?.status
    ) {
      const cached = existingCache.byRequestKey.get(requestKey);
      if (cached) {
        return cached;
      }
    }

    const events = this.eventRepo.listByThread(
      threadId,
      undefined,
      limit,
      TIMELINE_NOISE_EVENT_TYPES,
    );
    const uiMessages = toUIMessages(events, {
      includeDebugRawEvents: false,
      includeOptionalOperations: false,
      threadStatus: thread?.status,
    });
    const visibleMessages = uiMessages.filter(
      (entry) => entry.kind !== "assistant-reasoning",
    );
    const rows = buildThreadDetailRows(visibleMessages, {
      includeToolGroupMessages,
    });
    const timeline = { rows };

    if (
      !existingCache ||
      existingCache.latestSeq !== latestSeq ||
      existingCache.threadStatus !== thread?.status
    ) {
      this.timelineByThread.set(threadId, {
        latestSeq,
        threadStatus: thread?.status,
        byRequestKey: new Map([[requestKey, timeline]]),
      });
    } else {
      existingCache.byRequestKey.set(requestKey, timeline);
    }

    return timeline;
  }

  getToolGroupMessages(
    threadId: string,
    request: ThreadToolGroupMessagesRequest,
  ): ThreadToolGroupMessagesResponse {
    const sourceSeqStart = Math.max(1, request.sourceSeqStart);
    const sourceSeqEnd = Math.max(sourceSeqStart, request.sourceSeqEnd);
    const range = sourceSeqEnd - sourceSeqStart + 1;
    const thread = this.threadRepo.getById(threadId);
    const eventsInRange = this.eventRepo
      .listByThread(threadId, sourceSeqStart - 1, range)
      .filter((event) => event.seq >= sourceSeqStart && event.seq <= sourceSeqEnd);
    const uiMessages = toUIMessages(eventsInRange, {
      includeDebugRawEvents: false,
      includeOptionalOperations: false,
      threadStatus: thread?.status,
    });
    const rowMessages = uiMessages.filter((entry) => {
      if (entry.kind === "assistant-reasoning") return false;
      if ((entry.turnId ?? null) !== request.turnId) return false;
      return (
        entry.sourceSeqStart >= sourceSeqStart &&
        entry.sourceSeqEnd <= sourceSeqEnd
      );
    });
    const messages = buildThreadDetailRows(rowMessages, {
      includeToolGroupMessages: true,
    })
      .flatMap((entry) => (entry.kind === "message" ? [entry.message] : entry.messages))
      .filter((entry) => entry.kind !== "assistant-text");
    return {
      messages,
    };
  }

  /**
   * Get the final output of a thread — the text from the last agentMessage
   * completion event recognized by the active provider adapter.
   */
  getOutput(threadId: string): string | undefined {
    const allEvents = this.eventRepo.listByThread(threadId);
    // Walk backwards to find the last output event.
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const hydratedEvent: ThreadEvent = {
        ...allEvents[i],
        data: unwrapProviderEventPayload(allEvents[i].data) as ThreadEvent["data"],
      };
      const output = this.provider.outputFromEvent(hydratedEvent);
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

  getWorkStatus(threadId: string) {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    return this._hydrateThreadState(thread, { includeAttributedDiff: true }).workStatus;
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
    parentThreadId?: string;
    includeArchived?: boolean;
    includeWorkStatus?: boolean;
  }): Thread[] {
    const threads = this.threadRepo.list(filters);
    if (!filters?.includeWorkStatus) return threads;
    return threads.map((thread) =>
      this._hydrateThreadState(thread, { includeAttributedDiff: false })
    );
  }

  async commitThread(
    threadId: string,
    request?: CommitThreadRequest,
  ): Promise<CommitThreadResponse> {
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
    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
    let message = request?.message?.trim();
    if (!message && this.provider.generateCommitMessage) {
      try {
        message = (await this.provider.generateCommitMessage({ cwd: workspaceRoot }))?.trim();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[thread ${thread.id}] Failed to auto-generate commit message (${this.provider.displayName}): ${detail}`,
        );
      }
    }
    const result = this.gitStatusService.commit({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
      ...(message ? { message } : {}),
      includeUnstaged: request?.includeUnstaged,
    });
    this._appendEvent(
      thread.id,
      "system/worktree/commit",
      {
        status: result.commitCreated ? "committed" : "noop",
        message: result.message,
        ...(result.commitSha ? { commitSha: result.commitSha } : {}),
        ...(request?.includeUnstaged !== undefined
          ? { includeUnstaged: request.includeUnstaged }
          : {}),
      },
      { broadcastChanges: ["events-appended", "work-status-changed"] },
    );
    return result;
  }

  mergeThread(threadId: string): MergeThreadResponse {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }
    if (thread.environmentId !== "worktree") {
      throw invalidRequestError("Merge is only available for worktree threads");
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }
    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
    const mergeResult = this.gitStatusService.mergeWorktreeIntoDefaultBranch({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
    });
    this.gitStatusService.invalidate(workspaceRoot);
    const workStatus = this.gitStatusService.getStatus({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
    });
    this._broadcastThreadChanged(thread.id, ["work-status-changed"]);
    return {
      ok: true,
      merged: mergeResult.merged,
      message: mergeResult.message,
      workStatus,
    };
  }

  async squashMergeThread(
    threadId: string,
    request?: SquashMergeThreadRequest,
  ): Promise<SquashMergeThreadResponse> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }
    if (thread.environmentId !== "worktree") {
      throw invalidRequestError("Squash merge is only available for worktree threads");
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }

    let committed = false;
    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
    const before = this.gitStatusService.getStatus({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
    });
    const commitIfNeeded = request?.commitIfNeeded === true;
    if (before.hasUncommittedChanges) {
      if (!commitIfNeeded) {
        throw invalidRequestError("Workspace has uncommitted changes; commit first");
      }
      const commitResult = await this.commitThread(threadId, {
        includeUnstaged: request?.includeUnstaged,
        message: request?.commitMessage,
      });
      committed = commitResult.commitCreated;
    }

    const mergeResult = this.gitStatusService.squashMergeWorktreeIntoDefaultBranch({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
      message: request?.squashMessage,
    });
    this.gitStatusService.invalidate(workspaceRoot);
    const workStatus = this.gitStatusService.getStatus({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
    });
    this._appendEvent(
      thread.id,
      "system/worktree/squash_merge",
      {
        status: mergeResult.merged
          ? "merged"
          : mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0
            ? "conflict"
            : "noop",
        message: mergeResult.message,
        committed,
        ...(mergeResult.conflictFiles ? { conflictFiles: mergeResult.conflictFiles } : {}),
      },
      { broadcastChanges: ["events-appended", "work-status-changed"] },
    );
    return {
      ok: true,
      merged: mergeResult.merged,
      committed,
      message: mergeResult.message,
      ...(mergeResult.conflictFiles ? { conflictFiles: mergeResult.conflictFiles } : {}),
      workStatus,
    };
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
    if (!this.provider.capabilities.supportsModelList) {
      return [];
    }
    return this.provider.listModels();
  }

  getProviderInfo(): SystemProviderInfo {
    return {
      id: this.provider.id,
      displayName: this.provider.displayName,
      capabilities: { ...this.provider.capabilities },
    };
  }

  listProviders(): SystemProviderInfo[] {
    return this.providerCatalog.map((provider) => ({
      ...provider,
      capabilities: { ...provider.capabilities },
    }));
  }

  getEnvironmentInfo(): SystemEnvironmentInfo {
    return {
      ...this.environmentAdapter.info,
      capabilities: { ...this.environmentAdapter.info.capabilities },
    };
  }

  listEnvironments(): SystemEnvironmentInfo[] {
    return this.environmentCatalog.map((environment) => ({
      ...environment,
      capabilities: { ...environment.capabilities },
    }));
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
    for (const [threadId] of this.environmentRuntimes) {
      this._cleanupEnvironmentSession(threadId);
    }
    this.environmentRuntimes.clear();
    this.providerThreadIds.clear();
    this.activeTurnIds.clear();
    this.autoTitleAttemptedThreadIds.clear();
    this.authRefreshWarningThreadIds.clear();
    this.suppressedAuthStderrDepth.clear();
    this.provisioningTasks.clear();
    this.eventSeqCounters.clear();
    this.lastNotifiedCompletionTurnIds.clear();
    this.turnLifecycleEpochs.clear();
    this.lastNotifiedCompletionEpochs.clear();
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
        this._appendEvent(
          threadId,
          "system/error",
          this._createProvisioningFailureEventData(err, req.projectId),
        );
        const message = this._toErrorMessage(err);
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

    const environmentAdapter = this._resolveThreadEnvironmentAdapter({
      thread,
      requestedEnvironmentId: req.environmentId,
    });
    const requestedEnvironmentId =
      req.environmentId ??
      thread?.environmentId ??
      environmentAdapter.info.id;
    if (thread && thread.environmentId !== requestedEnvironmentId) {
      this.threadRepo.update(threadId, { environmentId: requestedEnvironmentId });
    }
    this._appendEvent(threadId, "system/provisioning/started", {
      environmentId: requestedEnvironmentId,
      environmentDisplayName: environmentAdapter.info.displayName,
    });

    const environmentRuntime = this._spawnProcess(
      threadId,
      opts?.rootPathHint ?? project.rootPath,
      environmentAdapter,
    );
    this._sendInitialize(threadId);
    const effectiveEnvironmentId = this._resolveEffectiveEnvironmentId(
      environmentRuntime.adapter,
      environmentRuntime.session,
    );
    const fallbackReason = environmentRuntime.session.metadata?.fallbackReason;
    if (fallbackReason && effectiveEnvironmentId !== requestedEnvironmentId) {
      this._appendEvent(threadId, "system/provisioning/fallback", {
        requestedEnvironmentId,
        fallbackEnvironmentId: effectiveEnvironmentId,
        reason: fallbackReason,
      });
    }
    this._appendEvent(threadId, "system/provisioning/completed", {
      environmentId: effectiveEnvironmentId,
      workspaceRoot: environmentRuntime.session.cwd,
      mode: environmentRuntime.session.metadata?.mode,
      ...(fallbackReason ? { fallbackReason } : {}),
    });
    const hydratedThread = this.threadRepo.getById(threadId);
    if (hydratedThread) {
      this._invalidateThreadWorkStatus(hydratedThread);
    }
    const requestedInput = req.input ?? [];
    const providerInput = this._normalizePromptInputForProvider(requestedInput);

    const effectiveDeveloperInstructions = this._buildDeveloperInstructions({
      projectWorkflowInstructions: project.workflowInstructions,
      requestDeveloperInstructions: req.developerInstructions,
    });
    const threadStartParams = this.provider.createThreadStartParams(
      effectiveDeveloperInstructions
        ? { ...req, developerInstructions: effectiveDeveloperInstructions }
        : req,
      this._buildProviderThreadContext({
        threadId,
        projectId: req.projectId,
      }),
    );
    this._persistOutboundStartEvent(
      threadId,
      "client/thread/start",
      threadStartParams,
      requestedInput,
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

    this._maybeAutogenerateThreadTitle(
      threadId,
      project.rootPath,
      providerThreadId,
      requestedInput,
    );

    if (requestedInput.length > 0) {
      this._setThreadStatus(threadId, "active");
      const turnStartParams = this.provider.createTurnStartParams(
        providerThreadId,
        providerInput,
        req,
      );
      this._persistOutboundStartEvent(
        threadId,
        "client/turn/start",
        turnStartParams,
        requestedInput,
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
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this._cleanupEnvironmentSession(threadId);
  }

  private _setEnvironmentSession(
    threadId: string,
    adapter: EnvironmentAdapter,
    session: EnvironmentSession,
  ): void {
    this._cleanupEnvironmentSession(threadId);
    this.environmentRuntimes.set(threadId, { adapter, session });
  }

  private _cleanupEnvironmentSession(
    threadId: string,
    opts?: { destroyWorkspace?: boolean },
  ): void {
    const runtime = this.environmentRuntimes.get(threadId);
    if (!runtime) return;
    this.environmentRuntimes.delete(threadId);
    if (!opts?.destroyWorkspace) return;
    const { adapter, session } = runtime;
    if (!session.cleanup) return;
    try {
      const maybePromise = session.cleanup();
      if (
        maybePromise &&
        typeof maybePromise === "object" &&
        "then" in maybePromise &&
        typeof maybePromise.then === "function"
      ) {
        void maybePromise.catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[thread ${threadId}] environment cleanup failed (${adapter.info.id}): ${message}`,
          );
          this._appendEvent(
            threadId,
            "system/provisioning/cleanup_failed",
            {
              environmentId: adapter.info.id,
              message: "Environment cleanup failed",
              detail: message,
            },
          );
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[thread ${threadId}] environment cleanup failed (${adapter.info.id}): ${message}`,
      );
      this._appendEvent(
        threadId,
        "system/provisioning/cleanup_failed",
        {
          environmentId: adapter.info.id,
          message: "Environment cleanup failed",
          detail: message,
        },
      );
    }
  }

  private _resolveEffectiveEnvironmentId(
    adapter: EnvironmentAdapter,
    session: EnvironmentSession,
  ): string {
    const mode = session.metadata?.mode;
    if (adapter.info.id === "worktree" && mode === "local") {
      return "local";
    }
    return adapter.info.id;
  }

  private _spawnProcess(
    threadId: string,
    projectRootPath: string,
    environmentAdapter: EnvironmentAdapter,
  ): ActiveEnvironmentRuntime {
    const thread = this.threadRepo.getById(threadId);
    const projectId = thread?.projectId;
    const environmentSession = environmentAdapter.prepare({
      projectId: projectId ?? "",
      threadId,
      projectRootPath,
      runtimeEnv: this.runtimeEnv,
    });
    this._setEnvironmentSession(threadId, environmentAdapter, environmentSession);
    const effectiveEnvironmentId = this._resolveEffectiveEnvironmentId(
      environmentAdapter,
      environmentSession,
    );
    const sessionEnv = {
      ...this.runtimeEnv,
      ...(environmentSession.env ?? {}),
    };
    const effectivePath = this.threadShellPath ?? sessionEnv.PATH;
    const child = spawn(this.provider.processCommand, this.provider.processArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: environmentSession.cwd,
      env: {
        ...sessionEnv,
        ...(effectivePath ? { PATH: effectivePath } : {}),
        ...(projectId ? { BB_PROJECT_ID: projectId } : {}),
        BB_THREAD_ID: threadId,
        BB_ENVIRONMENT_ID: effectiveEnvironmentId,
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

    return {
      adapter: environmentAdapter,
      session: environmentSession,
    };
  }

  private _sendInitialize(threadId: string): void {
    const defaultParams = {
      clientInfo: this.provider.clientInfo,
    };
    const params =
      this.provider.createInitializeParams?.(this.provider.clientInfo) ??
      defaultParams;
    const initMsg = {
      jsonrpc: "2.0",
      method: this.provider.initializeMethod,
      id: ++this.rpcIdCounter,
      params,
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
      const normalizedProviderThreadId = extractProviderThreadIdFromPersistedEventData(
        event.data,
      );
      if (normalizedProviderThreadId) return normalizedProviderThreadId;

      const providerThreadId = this.provider.extractThreadIdFromEventData(
        unwrapProviderEventPayload(event.data),
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
      const method = resolveProviderEventMethod(event.type, event.data);
      const normalizedType = this.provider.normalizeEventType(method);
      const state = toTurnLifecycleState(normalizedType);
      if (state === "idle") return undefined;
      if (state === "active") {
        return this._extractTurnIdFromEventData(event.data);
      }
    }
    return undefined;
  }

  private _extractTurnIdFromEventData(data: unknown): string | undefined {
    return extractTurnIdFromPersistedEventData(data);
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
      const environmentAdapter = this._resolveThreadEnvironmentAdapter({
        thread,
      });
      this._spawnProcess(threadId, project.rootPath, environmentAdapter);
      this._sendInitialize(threadId);
      const resumedThreadId = await this._sendRequestAndAwaitThreadId(
        threadId,
        this.provider.threadResumeMethod,
        this.provider.createThreadResumeParams(
          persistedThreadId,
          this._buildProviderThreadContext({
            threadId,
            projectId: thread.projectId,
          }),
          options,
        ),
      );
      this.providerThreadIds.set(threadId, resumedThreadId);
      return resumedThreadId;
    } catch (err) {
      this._cleanupThreadRuntime(threadId);
      if (!this._isMissingProviderThreadError(err)) {
        throw err;
      }

      // Resume can fail when provider-side rollout state has been evicted.
      // Fall back to fresh provisioning so the pending tell can continue.
      await this._provisionThread(
        threadId,
        {
          projectId: thread.projectId,
          model: options?.model,
          reasoningLevel: options?.reasoningLevel,
          sandboxMode: options?.sandboxMode,
          environmentId: thread.environmentId,
        },
        { rootPathHint: project.rootPath },
      );
      const reprovisionedThreadId = this.providerThreadIds.get(threadId);
      if (reprovisionedThreadId) return reprovisionedThreadId;

      throw err;
    }
  }

  private _buildProviderThreadContext(args: {
    threadId: string;
    projectId: string;
  }): ProviderThreadContext {
    const environmentRuntime = this.environmentRuntimes.get(args.threadId);
    const environmentSession = environmentRuntime?.session;
    const environmentId = environmentRuntime
      ? this._resolveEffectiveEnvironmentId(
          environmentRuntime.adapter,
          environmentRuntime.session,
        )
      : this.threadRepo.getById(args.threadId)?.environmentId ??
        this.environmentAdapter.info.id;
    return {
      projectId: args.projectId,
      threadId: args.threadId,
      ...(this.threadShellPath ? { path: this.threadShellPath } : {}),
      ...(environmentSession?.cwd
        ? { workspaceRoot: environmentSession.cwd }
        : {}),
      environmentId,
    };
  }

  private _resolveRequestedEnvironmentId(value?: string): string {
    const normalized = (value ?? this.environmentAdapter.info.id).trim().toLowerCase();
    if (!normalized) return this.environmentAdapter.info.id;
    this._resolveEnvironmentAdapter(normalized);
    return normalized;
  }

  private _resolveEnvironmentAdapter(environmentId: string): EnvironmentAdapter {
    if (environmentId === this.environmentAdapter.info.id) {
      return this.environmentAdapter;
    }
    try {
      return createEnvironmentAdapter({ environmentId });
    } catch {
      throw invalidRequestError(
        `Unsupported environment "${environmentId}"`,
      );
    }
  }

  private _resolveThreadEnvironmentAdapter(args: {
    thread?: Thread;
    requestedEnvironmentId?: string;
  }): EnvironmentAdapter {
    const environmentId =
      args.requestedEnvironmentId ??
      args.thread?.environmentId ??
      this.environmentAdapter.info.id;
    return this._resolveEnvironmentAdapter(environmentId);
  }

  private _toErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private _buildDeveloperInstructions(args: {
    projectWorkflowInstructions?: string;
    requestDeveloperInstructions?: string;
  }): string | undefined {
    const projectInstructions = args.projectWorkflowInstructions?.trim();
    const requestInstructions = args.requestDeveloperInstructions?.trim();

    if (projectInstructions && requestInstructions) {
      return `${projectInstructions}\n\n${requestInstructions}`;
    }
    if (requestInstructions) {
      return requestInstructions;
    }
    if (projectInstructions) {
      return projectInstructions;
    }
    return undefined;
  }

  private _isMissingProviderThreadError(err: unknown): boolean {
    if (!isDomainError(err) || err.code !== "provider_rpc_error") return false;
    const normalized = err.message.toLowerCase();
    return normalized.includes("no rollout found for thread id");
  }

  private _createProvisioningFailureEventData(
    err: unknown,
    projectId: string,
  ): ThreadEventDataForType<"system/error"> {
    const project = this.projectRepo.getById(projectId);
    if (project && !existsSync(project.rootPath)) {
      return {
        code: "project_root_missing",
        message: `Project folder not found: ${project.rootPath}`,
        detail:
          "This project points to a folder that no longer exists. " +
          "Update the project path and retry by sending your prompt again.",
      };
    }

    const message = this._toErrorMessage(err);
    return {
      code: "thread_provisioning_failed",
      message: `Thread provisioning failed for project ${projectId}`,
      detail: message,
    };
  }

  private _handleProviderNotification(
    threadId: string,
    msg: { method: unknown; params: unknown },
  ): void {
    if (typeof msg.method !== "string") {
      return;
    }

    if (this.provider.shouldPersistEvent?.(msg.method, msg.params) === false) {
      return;
    }

    const eventType = toProviderEventType(msg.method);
    const providerPayload = msg.params ?? {};
    const eventData: ThreadEventData = createProviderEventEnvelope({
      providerId: this.provider.id,
      method: msg.method,
      payload: providerPayload,
    });

    const shouldBroadcast = this.provider.shouldBroadcastForEvent(msg.method);
    const changes: ThreadChangeKind[] = [];
    if (shouldBroadcast) {
      changes.push("events-appended");
    }

    const persistedEvent = this._appendEvent(threadId, eventType, eventData, {
      broadcastChanges: false,
    });

    const titleChanged = this._syncTitleFromEvent(threadId, msg.method, providerPayload);
    if (shouldBroadcast && titleChanged) {
      changes.push("title-changed");
    }

    const statusChanged = this._syncStatusFromEvent(threadId, msg.method);
    if (shouldBroadcast && statusChanged) {
      changes.push(...THREAD_STATUS_CHANGE_KINDS);
    }

    this._syncActiveTurnFromEvent(threadId, msg.method, providerPayload);
    this._maybeNotifyParentOnChildTurnCompletion(threadId, persistedEvent);
    const thread = this.threadRepo.getById(threadId);
    if (thread) {
      this._invalidateThreadWorkStatus(thread);
    }

    if (changes.length > 0) {
      this._broadcastThreadChanged(threadId, changes);
    }
  }

  private _appendEvent(
    threadId: string,
    type: ThreadEventType,
    data: ThreadEventData,
    opts?: { broadcastChanges?: readonly ThreadChangeKind[] | false },
  ): ThreadEvent {
    const seq = this._nextEventSeq(threadId);
    const created = this.eventRepo.create({
      threadId,
      seq,
      type,
      data,
    });
    this.timelineByThread.delete(threadId);
    const broadcastChanges = opts?.broadcastChanges ?? ["events-appended"];
    if (broadcastChanges !== false) {
      this._broadcastThreadChanged(threadId, broadcastChanges);
    }
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

  private _hydrateThreadState(
    thread: Thread,
    opts?: { includeAttributedDiff?: boolean },
  ): Thread {
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return thread;

    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
    const workspaceStatus = this.gitStatusService.getStatus({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
    });
    const workStatus = { ...workspaceStatus };

    if (opts?.includeAttributedDiff) {
      if (thread.agentDiffStats) {
        workStatus.changedFiles = thread.agentDiffStats.changedFiles;
        workStatus.insertions = thread.agentDiffStats.insertions;
        workStatus.deletions = thread.agentDiffStats.deletions;
      } else {
        const shouldComputeFallback =
          thread.environmentId !== "worktree" && thread.status === "active";
        if (shouldComputeFallback) {
          const events = this.eventRepo.listByThread(thread.id);
          const attributedDiff = this.attributedDiffService.compute(events);
          workStatus.changedFiles = attributedDiff.changedFiles;
          workStatus.insertions = attributedDiff.insertions;
          workStatus.deletions = attributedDiff.deletions;
          workStatus.files = attributedDiff.files;
        }
      }
    }

    return {
      ...thread,
      workStatus,
      provisioningState: this._readProvisioningState(thread.id),
    };
  }

  private _resolveThreadWorkspaceRoot(thread: Thread, projectRoot: string): string {
    const runtime = this.environmentRuntimes.get(thread.id);
    if (runtime?.session?.cwd) {
      return runtime.session.cwd;
    }

    const latestProvisioningCompleted = this.eventRepo.getLatestByType(
      thread.id,
      "system/provisioning/completed",
    );
    if (latestProvisioningCompleted) {
      const data = toRecord(latestProvisioningCompleted.data);
      const workspaceRoot = getStringField(data, "workspaceRoot");
      if (workspaceRoot) return workspaceRoot;
    }

    return projectRoot;
  }

  private _readProvisioningState(threadId: string): ThreadProvisioningState | undefined {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    if (thread.status === "provisioning_failed") {
      return {
        readiness: "failed",
        message: "Provisioning failed",
      };
    }

    const latestProvisioningCompleted = this.eventRepo.getLatestByType(
      threadId,
      "system/provisioning/completed",
    );
    if (latestProvisioningCompleted) {
      const data = toRecord(latestProvisioningCompleted.data);
      const fallbackReason = getStringField(data, "fallbackReason");
      const mode = getStringField(data, "mode");
      if (fallbackReason) {
        return {
          readiness: "degraded",
          message: fallbackReason,
          fallbackReason,
          ...(mode ? { mode } : {}),
        };
      }
      return {
        readiness: "ready",
        ...(mode ? { mode } : {}),
      };
    }

    return undefined;
  }

  private _invalidateThreadWorkStatus(thread: Thread): void {
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return;
    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    this.gitStatusService.invalidate(workspaceRoot);
  }

  private _captureAgentDiffStats(thread: Thread): void {
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return;

    if (thread.environmentId === "worktree") {
      const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
      const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
      const workspaceStatus = this.gitStatusService.getStatus({
        workspaceRoot,
        projectRoot: project.rootPath,
        defaultBranch,
      });
      this.threadRepo.update(
        thread.id,
        {
          agentDiffStats: {
            source: "worktree_snapshot",
            changedFiles: workspaceStatus.workspaceChangedFiles,
            insertions: workspaceStatus.workspaceInsertions,
            deletions: workspaceStatus.workspaceDeletions,
            capturedAt: Date.now(),
          },
        },
        { touchUpdatedAt: false },
      );
      return;
    }

    const events = this.eventRepo.listByThread(thread.id);
    const attributedDiff = this.attributedDiffService.compute(events);
    this.threadRepo.update(
      thread.id,
      {
        agentDiffStats: {
          source: "local_tally",
          changedFiles: attributedDiff.changedFiles,
          insertions: attributedDiff.insertions,
          deletions: attributedDiff.deletions,
          capturedAt: Date.now(),
        },
      },
      { touchUpdatedAt: false },
    );
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
    input: PromptInput[] | undefined,
    meta: { source: "spawn" | "tell"; initiator: ThreadTurnInitiator },
  ): void {
    const eventData: ThreadEventData = {
      direction: "outbound",
      source: meta.source,
      initiator: meta.initiator,
      ...(input && input.length > 0 ? { input } : {}),
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
    const eventMethod = resolveProviderEventMethod(event.type, event.data);
    const normalizedType = this.provider.normalizeEventType(eventMethod);
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
    if (parentThread.projectId !== childThread.projectId) return;

    const turnId = this._extractTurnIdFromEventData(event.data);
    if (turnId) {
      const lastTurnId = this.lastNotifiedCompletionTurnIds.get(childThreadId);
      if (lastTurnId === turnId) return;
      this.lastNotifiedCompletionTurnIds.set(childThreadId, turnId);
    } else {
      const lifecycleEpoch = this.turnLifecycleEpochs.get(childThreadId) ?? 0;
      const lastEpoch = this.lastNotifiedCompletionEpochs.get(childThreadId);
      if (lastEpoch === lifecycleEpoch) return;
      this.lastNotifiedCompletionEpochs.set(childThreadId, lifecycleEpoch);
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
    const config = toRecord(params.config);
    const reasoningLevel = toReasoningLevel(config?.model_reasoning_effort);

    let sandboxMode: ThreadExecutionOptions["sandboxMode"] | undefined;
    switch (type) {
      case "client/thread/start":
        sandboxMode = toSandboxMode(params.sandbox);
        break;
      case "client/turn/start":
        sandboxMode = toSandboxModeFromPolicy(toRecord(params.sandboxPolicy));
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
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this._cleanupEnvironmentSession(threadId);

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    let statusChanged = false;
    if (thread.status === "active") {
      statusChanged = this._setThreadStatus(threadId, "idle", false);
    } else if (thread.status === "created" || thread.status === "provisioning") {
      statusChanged = this._setThreadStatus(threadId, "provisioning_failed", false);
    }

    if (statusChanged) {
      this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
    }
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

  private _syncStatusFromEvent(threadId: string, method: string): boolean {
    const nextStatus = this.provider.statusForEvent(method);
    if (!nextStatus) return false;
    return this._setThreadStatus(threadId, nextStatus, false);
  }

  private _syncActiveTurnFromEvent(
    threadId: string,
    method: string,
    data: unknown,
  ): void {
    const state = toTurnLifecycleState(this.provider.normalizeEventType(method));
    if (state === "active") {
      const nextEpoch = (this.turnLifecycleEpochs.get(threadId) ?? 0) + 1;
      this.turnLifecycleEpochs.set(threadId, nextEpoch);
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
  ): boolean {
    const title = this.provider.titleFromEvent(method, data);
    if (!title) return false;
    const thread = this.threadRepo.getById(threadId);
    const changed = this._setThreadTitle(threadId, title, {
      // Thread titles are auto-assigned only once; subsequent provider
      // rename suggestions are intentionally ignored.
      onlyIfMissing: true,
      shouldBroadcast: false,
    });
    if (!changed) return false;
    this._appendEvent(
      threadId,
      "system/thread-title/updated",
      {
        title,
        ...(thread?.title ? { previousTitle: thread.title } : {}),
        source: "provider",
        providerMethod: method,
      },
      { broadcastChanges: false },
    );
    return true;
  }

  private _setThreadTitle(
    threadId: string,
    value: unknown,
    opts?: { onlyIfMissing?: boolean; shouldBroadcast?: boolean },
  ): boolean {
    const title = this._normalizeThreadTitle(value);
    if (!title) return false;
    if (this.lockedTitleThreadIds.has(threadId)) return false;

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return false;
    if (opts?.onlyIfMissing && thread.title) return false;
    if (thread.title === title) return false;

    this.threadRepo.update(threadId, { title });
    if (opts?.shouldBroadcast !== false) {
      this._broadcastThreadChanged(threadId, ["title-changed"]);
    }
    return true;
  }

  private _setThreadStatus(
    threadId: string,
    nextStatus: Thread["status"],
    shouldBroadcast = true,
    opts?: { force?: boolean; touchUpdatedAt?: boolean },
  ): boolean {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      if (!opts?.force) return false;
      if (opts?.touchUpdatedAt !== undefined) {
        this.threadRepo.update(threadId, { status: nextStatus }, {
          touchUpdatedAt: opts.touchUpdatedAt,
        });
      } else {
        this.threadRepo.update(threadId, { status: nextStatus });
      }
      if (shouldBroadcast) {
        this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
      }
      return true;
    }
    if (thread.archivedAt !== undefined && nextStatus === "active") return false;

    if (thread.status === nextStatus) return false;
    if (!opts?.force && !canTransitionThreadStatus(thread.status, nextStatus)) {
      return false;
    }
    if (thread.status === "active" && nextStatus === "idle") {
      this._captureAgentDiffStats(thread);
    }

    if (opts?.touchUpdatedAt !== undefined) {
      this.threadRepo.update(threadId, { status: nextStatus }, {
        touchUpdatedAt: opts.touchUpdatedAt,
      });
    } else {
      this.threadRepo.update(threadId, { status: nextStatus });
    }
    if (shouldBroadcast) {
      this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
    }
    return true;
  }

  private _broadcastThreadChanged(
    threadId: string,
    changes: readonly ThreadChangeKind[],
  ): void {
    const uniqueChanges = Array.from(new Set(changes));
    if (uniqueChanges.length === 0) return;
    this.ws.broadcast("thread", threadId, uniqueChanges);
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

  private _normalizePromptInputForProvider(input: PromptInput[]): PromptInput[] {
    const normalized: PromptInput[] = [];
    for (const chunk of input) {
      switch (chunk.type) {
        case "text":
          normalized.push(chunk);
          break;
        case "localFile":
          // No currently integrated runtime supports native local file prompt parts.
          // Preserve intent via deterministic text annotations.
          normalized.push({
            type: "text",
            text: `Attached local file: ${chunk.path}`,
          });
          break;
        case "image":
          if (this.provider.capabilities.supportsMultimodalInput) {
            normalized.push(chunk);
          } else {
            normalized.push({
              type: "text",
              text: `Attached image URL: ${chunk.url}`,
            });
          }
          break;
        case "localImage":
          if (this.provider.capabilities.supportsMultimodalInput) {
            normalized.push(chunk);
          } else {
            normalized.push({
              type: "text",
              text: `Attached local image: ${chunk.path}`,
            });
          }
          break;
        default:
          assertNever(chunk);
      }
    }

    return normalized;
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
      const method = resolveProviderEventMethod(events[i].type, events[i].data);
      const normalizedType = this.provider.normalizeEventType(method);
      const state = toTurnLifecycleState(normalizedType);
      if (state) return state;
    }
    return undefined;
  }

}
