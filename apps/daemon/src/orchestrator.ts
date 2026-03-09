import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertNever,
  extractProviderThreadIdFromPersistedEventData,
  extractTurnIdFromPersistedEventData,
  getStringField,
  resolveProviderEventMethod,
  buildThreadDetailRows,
  buildSquashMergeConflictFollowUpInstruction,
  extractThreadContextWindowUsage,
  toRecord,
  toUIMessages,
  unwrapProviderEventPayload,
  type AvailableModel,
  type EnvironmentProvisioningEvent,
  type ProviderAdapter,
  type ProviderExecutionOptions,
  type ProviderThreadContext,
  type SchedulerService,
  type ServiceTier,
  type SystemProviderInfo,
  type SystemEnvironmentInfo,
  type ThreadOrchestrator,
  type ThreadTurnInitiator,
  type ThreadExecutionOptions,
  type ThreadWorkStatus,
  type Thread,
  type ThreadBuiltInAction,
  type ThreadBuiltInActionId,
  type ThreadEvent,
  type ThreadEventData,
  type ThreadEventDataForType,
  type ThreadEventType,
  type PromptInput,
  type SpawnThreadRequest,
  type TellThreadRequest,
  type ThreadProvisioningState,
  type PromoteThreadResponse,
  type DemotePrimaryResponse,
  type EnqueueThreadMessageRequest,
  type PrimaryCheckoutStatus,
  type ReasoningLevel,
  type SandboxMode,
  type SendQueuedThreadMessageRequest,
  type SendQueuedThreadMessageResponse,
  type ThreadOperationRequest,
  type ThreadOperationResponse,
  type ThreadOperationType,
  type ThreadTimelineResponse,
  type ThreadGitDiffResponse,
  type ThreadGitDiffSelection,
  type ThreadQueuedMessage,
  type ThreadToolGroupMessagesRequest,
  type ThreadToolGroupMessagesResponse,
  type ThreadChangeKind,
  type ThreadProvisioningReason,
  type ThreadEnvironmentStartReason,
} from "@beanbag/agent-core";
import {
  EnvironmentRegistry,
  createDefaultEnvironmentRegistry,
  type CreateEnvironmentContext,
  type EnvironmentCommitSummary,
  type EnvironmentCheckoutSnapshot,
  type EnvironmentSquashMergeMessageContext,
  type IEnvironment,
} from "@beanbag/environment";
import type { EnvironmentAgentConnectionTarget } from "@beanbag/environment-agent";
import type {
  EnvironmentAgentDeliveryResponse,
  EnvironmentAgentEventEnvelope,
  EnvironmentAgentStatusSnapshot,
} from "@beanbag/environment-agent";
import { ENVIRONMENT_AGENT_PROTOCOL_VERSION } from "@beanbag/environment-agent";
import type {
  ThreadRepository,
  EventRepository,
  ProjectRepository,
} from "@beanbag/db";
import {
  AgentServer,
  type AgentServerSessionConnection,
  type AgentServerNotification,
  AgentServerSessionError,
  type LlmCommitMessageGenerationArgs,
  type LlmCompletionService,
  createCodexProviderAdapter,
} from "@beanbag/agent-server";
import { createHttpEnvironmentAgentClient } from "@beanbag/environment-agent";
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
import {
  checkoutProjectSnapshot,
  detectProjectDefaultBranch,
  discardProjectLocalChanges,
  resolveProjectCheckoutSnapshot,
  resolveProjectDefaultBranchCheckout,
} from "./git-project.js";
import {
  EnvironmentService,
  type ActiveEnvironmentRuntime,
  type PrimaryPromotionState,
} from "./environment-service.js";

export type PromptExecutionOptions = ProviderExecutionOptions;

interface TellContext {
  initiator: ThreadTurnInitiator;
}

interface ThreadTimelineCacheEntry {
  latestSeq: number;
  threadStatus: Thread["status"] | undefined;
  byRequestKey: Map<string, ThreadTimelineResponse>;
}

interface QueuedThreadOperation {
  operationId: string;
  request: ThreadOperationRequest;
  requestedAt: number;
  demotedPrimaryCheckout: boolean;
}

type BootReconcileAction =
  | { kind: "schedule-provisioning" }
  | { kind: "mark-provisioning-failed" }
  | { kind: "attempt-resume" }
  | { kind: "set-idle" }
  | { kind: "noop" };

// Open provider/runtime event type set: unknown values are intentionally not filtered.
const TIMELINE_NOISE_EVENT_TYPES: readonly string[] = [
  "thread/started",
  "account/rateLimits/updated",
  "thread/tokenUsage/updated",
  "item/reasoning/summaryPartAdded",
];

const THREAD_STATUS_CHANGE_KINDS: readonly ThreadChangeKind[] = [
  "status-changed",
  "work-status-changed",
];
const ENV_SETUP_SCRIPT_NAME = ".bb-env-setup.sh";
const ENV_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const PRIMARY_CHECKOUT_VALIDATION_TTL_MS = 2_000;
const IDLE_NOISE_EVENT_KEEP_RECENT = 300;
const ARCHIVED_NOISE_EVENT_KEEP_RECENT = 120;
const ACTIVE_NOISE_EVENT_KEEP_RECENT = 1_000;
const ACTIVE_NOISE_PRUNE_MIN_SEQ_DELTA = 250;
const ACTIVE_NOISE_PRUNE_MIN_INTERVAL_MS = 30_000;
const PROVIDER_EVENTS_BROADCAST_COALESCE_MS = 30;
const PRUNABLE_NOISE_EVENT_TYPES: readonly string[] = [
  "account/ratelimits/updated",
  "thread/tokenusage/updated",
  "item/reasoning/summarypartadded",
  "turn/diff/updated",
];

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

function toServiceTier(
  value: unknown,
): ThreadExecutionOptions["serviceTier"] | undefined {
  if (value === "fast" || value === "flex") {
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

function extractFirstPromptText(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (const chunk of input) {
    const promptChunk = toRecord(chunk);
    if (!promptChunk) continue;
    if (getStringField(promptChunk, "type") !== "text") continue;
    const text = getStringField(promptChunk, "text");
    if (!text) continue;
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function normalizeQueuedReasoningLevel(
  value: ReasoningLevel | undefined,
): ReasoningLevel {
  return value ?? "medium";
}

function normalizeQueuedServiceTier(
  value: ServiceTier | undefined,
): ServiceTier | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case "fast":
    case "flex":
      return value;
    default:
      return assertNever(value);
  }
}

function normalizeQueuedSandboxMode(
  value: SandboxMode | undefined,
): SandboxMode {
  return value ?? "danger-full-access";
}

export class Orchestrator implements ThreadOrchestrator {
  private environmentService: EnvironmentService;
  /** Threads explicitly titled by the caller should not be overwritten by event heuristics. */
  private lockedTitleThreadIds = new Set<string>();
  /** Ensure automatic title generation is attempted at most once per thread. */
  private autoTitleAttemptedThreadIds = new Set<string>();
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
  /** Last event sequence where historical noise pruning ran for an active thread. */
  private lastNoisePruneSeqByThread = new Map<string, number>();
  /** Last wall-clock timestamp where historical noise pruning ran for an active thread. */
  private lastNoisePruneAtByThread = new Map<string, number>();
  /** Coalesced provider-originated thread change broadcasts keyed by thread id. */
  private queuedProviderBroadcastsByThread = new Map<
    string,
    {
      changes: Set<ThreadChangeKind>;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  /** Memoized timeline projection per thread until event sequence or thread status changes. */
  private timelineByThread = new Map<string, ThreadTimelineCacheEntry>();
  /** Cached prompt-derived fallback titles for untitled threads. */
  private titleFallbackByThreadId = new Map<string, string | null>();
  /** Latest replay cursor consumed from each environment-agent event log. */
  private environmentAgentReplayCursorByThreadId = new Map<string, number>();
  /** Cached provisioning completion state derived from provisioning lifecycle events. */
  private provisioningCompletionStateByThreadId = new Map<
    string,
    ThreadProvisioningState | null
  >();
  /** Per-project in-memory primary-checkout promotion status. */
  private primaryPromotionByProjectId: Map<string, PrimaryPromotionState>;
  /** Last successful external validation timestamp for active primary-checkout state. */
  private primaryPromotionValidatedAtByProjectId: Map<string, number>;
  /** Filesystem watchers keyed by project while primary checkout is active. */
  private primaryPromotionWatchersByProjectId: Map<string, () => void>;
  /** Per-project mutex for promote/demote transitions. */
  private primaryCheckoutTransitionsInFlight = new Set<string>();
  /** Prevents concurrent queued follow-up dispatch loops per thread. */
  private queueDispatchInFlight = new Set<string>();
  /** Pending deterministic thread git operations keyed by thread id. */
  private queuedOperationsByThreadId = new Map<string, QueuedThreadOperation[]>();
  /** Prevents concurrent operation queue-drain loops per thread. */
  private operationDispatchInFlight = new Set<string>();
  /** Ensures only one deterministic git operation mutates a project at a time. */
  private projectOperationTransitionsInFlight = new Set<string>();
  /** Tracks threads whose workspace deletion is in progress. */
  private workspaceCleanupInFlightThreadIds: Set<string>;
  private agentServer: AgentServer;
  private operationIdCounter = 0;
  private threadShellPath: string | undefined;
  private environmentCatalog: SystemEnvironmentInfo[];

  constructor(
    private threadRepo: ThreadRepository,
    private eventRepo: EventRepository,
    private projectRepo: ProjectRepository,
    private ws: WSManager,
    private llmCompletionService: LlmCompletionService,
    agentServerOrProvider?: AgentServer | ProviderAdapter,
    private runtimeEnv: NodeJS.ProcessEnv = process.env,
    private environmentRegistry: EnvironmentRegistry = createDefaultEnvironmentRegistry(),
    providerCatalog?: SystemProviderInfo[],
    environmentCatalog?: SystemEnvironmentInfo[],
    private scheduler: SchedulerService = new InMemorySchedulerService(),
  ) {
    this.threadShellPath = resolveThreadShellPath(this.runtimeEnv.PATH);
    this.environmentCatalog =
      environmentCatalog ??
      this.environmentRegistry.list();
    this.environmentService = new EnvironmentService(
      this.threadRepo,
      this.projectRepo,
      this.environmentRegistry,
      {
        createContext: (threadId, projectRootPath) =>
          this._createEnvironmentContext(threadId, projectRootPath),
        onProvisioningEvent: (threadId, event) =>
          this._appendEnvironmentProvisioningEvent(threadId, event),
        onThreadChanged: (threadId, changes) =>
          this._broadcastThreadChanged(threadId, changes),
        onCleanupFailure: (threadId, environmentId, error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[thread ${threadId}] environment cleanup failed (${environmentId}): ${message}`,
          );
          this._appendEvent(
            threadId,
            "system/provisioning/cleanup_failed",
            {
              environmentId,
              message: "Environment cleanup failed",
              detail: message,
            },
          );
        },
        onPrimaryCheckoutDemoted: ({ projectId, threadId, currentCheckout }) => {
          this._appendEvent(
            threadId,
            "system/primary_checkout/updated",
            {
              action: "demote",
              status: "completed",
              message: "Primary checkout changed outside Beanbag; marked as demoted",
              projectId,
              activeThreadId: threadId,
              ...(currentCheckout.branch ? { branch: currentCheckout.branch } : {}),
            },
            { broadcastChanges: ["events-appended"] },
          );
          this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
        },
        runOptionalSetup: (threadId, environment, reason) =>
          this._runOptionalEnvironmentSetup(threadId, environment, reason),
        spawnProviderProcess: ({ threadId, projectId, agentConnectionTarget }) => {
          return this._connectEnvironmentAgentSession({
            threadId,
            projectId,
            agentConnectionTarget,
          });
        },
      },
    );
    this.primaryPromotionByProjectId = this.environmentService.primaryPromotionByProjectId;
    this.primaryPromotionValidatedAtByProjectId =
      this.environmentService.primaryPromotionValidatedAtByProjectId;
    this.primaryPromotionWatchersByProjectId =
      this.environmentService.primaryPromotionWatchersByProjectId;
    this.workspaceCleanupInFlightThreadIds =
      this.environmentService.workspaceCleanupInFlightThreadIds;
    const provider =
      agentServerOrProvider instanceof AgentServer
        ? undefined
        : agentServerOrProvider;
    this.agentServer =
      agentServerOrProvider instanceof AgentServer
        ? agentServerOrProvider
        : new AgentServer({
        provider: provider ?? createCodexProviderAdapter(),
        ...(providerCatalog ? { providerCatalog } : {}),
        onNotification: (threadId, event) => {
          this._handleAgentServerNotification(threadId, event);
        },
        onSessionExit: (threadId, event) => {
          this._handleProcessExit(threadId, event.code, event.signal);
        },
        logger: console,
      });
  }

  /**
   * One-time startup reconciliation for persisted thread statuses.
   * Restart policy matrix:
   * - created: schedule provisioning (unless archived -> idle)
   * - provisioning: mark provisioning_failed (unless archived -> idle)
   * - active: attempt resume, otherwise idle (archived -> idle)
   * - idle: no-op
   * - provisioning_failed: no-op
   */
  async reconcileActiveThreadsOnBoot(): Promise<void> {
    this._rebuildPrimaryPromotionStateFromGit();
    const allThreads = this.threadRepo.list({
      includeArchived: true,
    });
    if (!Array.isArray(allThreads) || allThreads.length === 0) return;

    for (const thread of allThreads) {
      const action = this._resolveBootReconcileAction(thread);
      switch (action.kind) {
        case "schedule-provisioning":
          this._scheduleProvisioning(thread.id, {
            projectId: thread.projectId,
            environmentId: thread.environmentId,
          }, {
            reason: "boot-created-thread",
          });
          break;
        case "mark-provisioning-failed":
          this._cleanupThreadRuntime(thread.id);
          this._setThreadStatus(thread.id, "provisioning_failed", true, {
            touchUpdatedAt: false,
          });
          break;
        case "attempt-resume":
          await this._attemptResumeThreadOnBoot(thread);
          break;
        case "set-idle":
          this._setThreadStatus(thread.id, "idle", true, {
            touchUpdatedAt: false,
          });
          break;
        case "noop":
          break;
        default:
          assertNever(action);
      }

      const hydratedThread = this.threadRepo.getById(thread.id);
      if (
        hydratedThread &&
        hydratedThread.archivedAt === undefined &&
        hydratedThread.status === "idle" &&
        (hydratedThread.queuedMessages?.length ?? 0) > 0
      ) {
        this._scheduleQueuedFollowUpDispatch(thread.id);
      }
    }
  }

  private _resolveBootReconcileAction(thread: Thread): BootReconcileAction {
    if (thread.archivedAt !== undefined) {
      return thread.status === "idle" ? { kind: "noop" } : { kind: "set-idle" };
    }

    switch (thread.status) {
      case "created":
        return { kind: "schedule-provisioning" };
      case "provisioning":
        return { kind: "mark-provisioning-failed" };
      case "active":
        return { kind: "attempt-resume" };
      case "idle":
      case "provisioning_failed":
        return { kind: "noop" };
      default:
        return assertNever(thread.status);
    }
  }

  private async _attemptResumeThreadOnBoot(thread: Thread): Promise<void> {
    const project = this.projectRepo.getById(thread.projectId);
    const providerThreadId = this._resolvePersistedProviderThreadId(thread.id);
    const latestLifecycle = this._latestTurnLifecycleStatus(thread.id);
    const shouldAttemptResume = latestLifecycle !== "idle";

    if (!project || !providerThreadId || !shouldAttemptResume) {
      this._setThreadStatus(thread.id, "idle", true, { touchUpdatedAt: false });
      return;
    }

    try {
      const environmentKind = this._resolveRequestedEnvironmentId(
        thread.environmentRecord?.kind ?? thread.environmentId,
      );
      const environmentRuntime = await this._spawnProcess(
        thread.id,
        project.rootPath,
        environmentKind,
        "boot-active-resume",
      );
      const resumed = await this.agentServer.resumeSession({
        threadId: thread.id,
        connectSession: environmentRuntime.connectSession!,
        providerThreadId,
        context: this._buildProviderThreadContext({
          threadId: thread.id,
          projectId: thread.projectId,
        }),
      });

      const activeTurnId = this._resolvePersistedActiveTurnId(thread.id);
      if (activeTurnId) {
        this.agentServer.hydrateSessionState(thread.id, {
          providerThreadId: resumed.providerThreadId,
          activeTurnId,
        });
      }
      await this._nudgeEnvironmentAgentDelivery(thread.id);
    } catch {
      this._cleanupThreadRuntime(thread.id);
      this._setThreadStatus(thread.id, "idle", true, { touchUpdatedAt: false });
    }
  }

  private _rebuildPrimaryPromotionStateFromGit(): void {
    this.environmentService.rebuildPrimaryPromotionStateFromGit();
  }

  private _setPrimaryPromotionState(
    projectId: string,
    state: PrimaryPromotionState,
  ): void {
    this.environmentService.setPrimaryPromotionState(projectId, state);
  }

  private _clearPrimaryPromotionState(projectId: string): PrimaryPromotionState | undefined {
    return this.environmentService.clearPrimaryPromotionState(projectId);
  }

  private _startPrimaryPromotionWatch(projectId: string): void {
    void projectId;
  }

  private _stopPrimaryPromotionWatch(projectId: string): void {
    void projectId;
  }

  private _stopAllPrimaryPromotionWatches(): void {
    this.environmentService.stopPrimaryPromotionWatches();
  }

  private _ensurePrimaryPromotionStateIsCurrent(
    projectId: string,
    opts?: { force?: boolean },
  ): void {
    this.environmentService.ensurePrimaryPromotionStateIsCurrent(projectId, {
      force: opts?.force,
      ttlMs: PRIMARY_CHECKOUT_VALIDATION_TTL_MS,
    });
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
    const environmentId = this._resolveRequestedEnvironmentId(req.environmentId);
    const thread = this.threadRepo.create({
      projectId: req.projectId,
      ...(explicitTitle ? { title: explicitTitle } : {}),
      environmentId,
      ...(req.parentThreadId ? { parentThreadId: req.parentThreadId } : {}),
    });
    if (explicitTitle) {
      this.lockedTitleThreadIds.add(thread.id);
    }

    this._broadcastThreadChanged(thread.id, ["thread-created"]);
    this._scheduleProvisioning(
      thread.id,
      { ...req, environmentId },
      {
        rootPathHint: project.rootPath,
        reason: "thread-created",
      },
    );
    const hydratedThread = this._withPrimaryCheckoutState(thread);
    const promptTitleFallback = this._derivePromptFallbackTitle(req.input);
    if (!promptTitleFallback || hydratedThread.title) {
      return hydratedThread;
    }
    this.titleFallbackByThreadId.set(thread.id, promptTitleFallback);
    return {
      ...hydratedThread,
      titleFallback: promptTitleFallback,
    };
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

  enqueueFollowUp(
    threadId: string,
    request: EnqueueThreadMessageRequest,
  ): Thread {
    if (request.input.length === 0) {
      throw invalidRequestError("Queued follow-up input must be non-empty");
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }

    // Normalize now so we fail fast on unsupported prompt input shapes.
    this._normalizePromptInputForProvider(request.input);

    const defaultOptions = this.getDefaultExecutionOptions(threadId);
    this.threadRepo.enqueueQueuedMessage(threadId, {
      input: request.input,
      model: request.model ?? defaultOptions?.model,
      serviceTier: normalizeQueuedServiceTier(
        request.serviceTier ?? defaultOptions?.serviceTier,
      ),
      reasoningLevel: normalizeQueuedReasoningLevel(
        request.reasoningLevel ?? defaultOptions?.reasoningLevel,
      ),
      sandboxMode: normalizeQueuedSandboxMode(
        request.sandboxMode ?? defaultOptions?.sandboxMode,
      ),
    });

    this._broadcastThreadChanged(threadId, ["queue-changed"]);
    if (thread.status !== "active") {
      this._scheduleQueuedFollowUpDispatch(threadId);
    }

    const updatedThread = this.threadRepo.getById(threadId);
    if (!updatedThread) {
      throw threadNotFoundError(threadId);
    }
    return this._withPrimaryCheckoutState(updatedThread);
  }

  removeQueuedFollowUp(threadId: string, queuedMessageId: string): Thread {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }

    const deleted = this.threadRepo.deleteQueuedMessage(threadId, queuedMessageId);
    if (!deleted) {
      throw invalidRequestError(`Queued follow-up not found: ${queuedMessageId}`);
    }

    this._broadcastThreadChanged(threadId, ["queue-changed"]);
    const updatedThread = this.threadRepo.getById(threadId);
    if (!updatedThread) {
      throw threadNotFoundError(threadId);
    }
    return this._withPrimaryCheckoutState(updatedThread);
  }

  async sendQueuedFollowUp(
    threadId: string,
    queuedMessageId: string,
    request?: SendQueuedThreadMessageRequest,
  ): Promise<SendQueuedThreadMessageResponse> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }

    const queuedMessage = this.threadRepo.getQueuedMessage(threadId, queuedMessageId);
    if (!queuedMessage) {
      throw invalidRequestError(`Queued follow-up not found: ${queuedMessageId}`);
    }

    const requestedMode = request?.mode ?? "auto";
    let tellMode: TellThreadRequest["mode"];
    switch (requestedMode) {
      case "auto":
        tellMode = "auto";
        break;
      case "steer-if-active":
        tellMode = thread.status === "active" ? "steer" : "auto";
        break;
      case "steer":
        tellMode = "steer";
        break;
      default:
        assertNever(requestedMode);
    }

    await this._sendQueuedFollowUpMessage(threadId, queuedMessage, tellMode);
    this._scheduleQueuedFollowUpDispatch(threadId);
    return { ok: true, queuedMessage };
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
          serviceTier: options?.serviceTier,
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
    const activeTurnId =
      this.agentServer.getSessionState(threadId).activeTurnId ??
      this._resolvePersistedActiveTurnId(threadId);
    if (activeTurnId) {
      this.agentServer.hydrateSessionState(threadId, { activeTurnId });
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

    const turnParams = this._buildTurnStartParams(providerThreadId, providerInput, options);
    this._persistOutboundStartEvent(threadId, "client/turn/start", turnParams, requestedInput, {
      source: "tell",
      initiator: context.initiator,
    });
    try {
      await this.agentServer.sendTurn({
        threadId,
        input: providerInput,
        options,
        mode: tellMode === "steer" ? "steer" : tellMode === "auto" ? "auto" : "start",
      });
    } catch (error) {
      this._rethrowAgentServerError(threadId, error);
    }
  }

  private async _sendQueuedFollowUpMessage(
    threadId: string,
    queuedMessage: ThreadQueuedMessage,
    tellMode: TellThreadRequest["mode"],
  ): Promise<void> {
    const options: PromptExecutionOptions | undefined =
      tellMode === "steer"
        ? undefined
        : {
            ...(queuedMessage.model ? { model: queuedMessage.model } : {}),
            ...(queuedMessage.serviceTier
              ? { serviceTier: queuedMessage.serviceTier }
              : {}),
            reasoningLevel: queuedMessage.reasoningLevel,
            sandboxMode: queuedMessage.sandboxMode,
          };

    await this._tell(
      threadId,
      {
        input: queuedMessage.input,
        ...(tellMode ? { mode: tellMode } : {}),
      },
      options,
      { initiator: "agent" },
    );

    const deleted = this.threadRepo.deleteQueuedMessage(threadId, queuedMessage.id);
    if (deleted) {
      this._broadcastThreadChanged(threadId, ["queue-changed"]);
    }
  }

  private _scheduleQueuedFollowUpDispatch(threadId: string): void {
    if (this.queueDispatchInFlight.has(threadId)) return;
    this.queueDispatchInFlight.add(threadId);
    void this._drainQueuedFollowUps(threadId).finally(() => {
      this.queueDispatchInFlight.delete(threadId);
    });
  }

  private async _drainQueuedFollowUps(threadId: string): Promise<void> {
    while (true) {
      const thread = this.threadRepo.getById(threadId);
      if (!thread) return;
      if (thread.archivedAt !== undefined) return;
      if (thread.status === "active") return;
      if (thread.status === "created" || thread.status === "provisioning") return;

      const queuedMessage = thread.queuedMessages?.[0];
      if (!queuedMessage) return;

      try {
        await this._sendQueuedFollowUpMessage(threadId, queuedMessage, "auto");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[thread ${threadId}] queued follow-up dispatch failed: ${message}`);
        return;
      }
    }
  }

  private _nextOperationId(): string {
    this.operationIdCounter += 1;
    return `op-${this.operationIdCounter.toString(36)}`;
  }

  private _enqueueThreadOperation(
    threadId: string,
    request: ThreadOperationRequest,
    demotedPrimaryCheckout: boolean,
    operationId?: string,
  ): QueuedThreadOperation {
    const queuedOperation: QueuedThreadOperation = {
      operationId: operationId ?? this._nextOperationId(),
      request,
      requestedAt: Date.now(),
      demotedPrimaryCheckout,
    };
    const queue = this.queuedOperationsByThreadId.get(threadId) ?? [];
    queue.push(queuedOperation);
    this.queuedOperationsByThreadId.set(threadId, queue);
    return queuedOperation;
  }

  private _scheduleQueuedOperationDispatch(threadId: string): void {
    if (this.operationDispatchInFlight.has(threadId)) return;
    this.operationDispatchInFlight.add(threadId);
    setImmediate(() => {
      void this._drainQueuedOperations(threadId).finally(() => {
        this.operationDispatchInFlight.delete(threadId);
      });
    });
  }

  private async _drainQueuedOperations(threadId: string): Promise<void> {
    while (true) {
      const thread = this.threadRepo.getById(threadId);
      if (!thread) return;
      if (thread.archivedAt !== undefined) return;
      if (thread.status !== "idle") return;
      if (this.projectOperationTransitionsInFlight.has(thread.projectId)) return;

      const queue = this.queuedOperationsByThreadId.get(threadId);
      const nextOperation = queue?.[0];
      if (!nextOperation) return;

      queue?.shift();
      if (!queue || queue.length === 0) {
        this.queuedOperationsByThreadId.delete(threadId);
      } else {
        this.queuedOperationsByThreadId.set(threadId, queue);
      }

      await this._runQueuedThreadOperation(thread, nextOperation);
    }
  }

  private async _runQueuedThreadOperation(
    thread: Thread,
    queuedOperation: QueuedThreadOperation,
  ): Promise<void> {
    if (this.projectOperationTransitionsInFlight.has(thread.projectId)) {
      const queue = this.queuedOperationsByThreadId.get(thread.id) ?? [];
      queue.unshift(queuedOperation);
      this.queuedOperationsByThreadId.set(thread.id, queue);
      return;
    }

    this.projectOperationTransitionsInFlight.add(thread.projectId);
    this._appendThreadOperationEvent(
      thread.id,
      queuedOperation.request.operation,
      "running",
      {
        operationId: queuedOperation.operationId,
        message: this._threadOperationRunningMessage(queuedOperation.request.operation),
        demotedPrimaryCheckout: queuedOperation.demotedPrimaryCheckout,
      },
    );

    try {
      let completionMessage = "";
      switch (queuedOperation.request.operation) {
        case "commit": {
          const result = await this._runWorktreeCommitOperation(
            thread.id,
            queuedOperation.request.options,
          );
          completionMessage = result.message;
          break;
        }
        case "squash_merge": {
          const result = await this._runWorktreeSquashMergeOperation(
            thread.id,
            queuedOperation.request.options,
          );
          completionMessage = result.message;
          break;
        }
        default:
          assertNever(queuedOperation.request);
      }

      this._appendThreadOperationEvent(
        thread.id,
        queuedOperation.request.operation,
        "completed",
        {
          operationId: queuedOperation.operationId,
          message: completionMessage,
          demotedPrimaryCheckout: queuedOperation.demotedPrimaryCheckout,
        },
      );
    } catch (err) {
      this._appendThreadOperationEvent(
        thread.id,
        queuedOperation.request.operation,
        "failed",
        {
          operationId: queuedOperation.operationId,
          message: this._toErrorMessage(err),
          demotedPrimaryCheckout: queuedOperation.demotedPrimaryCheckout,
        },
      );
    } finally {
      this.projectOperationTransitionsInFlight.delete(thread.projectId);
      this._scheduleQueuedOperationDispatch(thread.id);
      for (const candidateThreadId of this.queuedOperationsByThreadId.keys()) {
        if (candidateThreadId === thread.id) continue;
        const candidateThread = this.threadRepo.getById(candidateThreadId);
        if (!candidateThread || candidateThread.projectId !== thread.projectId) continue;
        this._scheduleQueuedOperationDispatch(candidateThreadId);
      }
    }
  }

  private async _runWorktreeCommitOperation(
    threadId: string,
    request?: Extract<ThreadOperationRequest, { operation: "commit" }>["options"],
  ): Promise<{ message: string }> {
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
    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment) {
      throw invalidRequestError(this._restoreEnvironmentUnavailableMessage(threadId));
    }
    const defaultBranch = detectProjectDefaultBranch(project.rootPath);
    const result = await environment.commitWorkspace({
      defaultBranch,
      message: request?.message?.trim(),
      includeUnstaged: request?.includeUnstaged,
    });
    this._appendEvent(thread.id, "system/worktree/commit", {
      status: result.commitCreated ? "committed" : "noop",
      message: result.message,
      ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      ...(result.includeUnstaged !== undefined
        ? { includeUnstaged: result.includeUnstaged }
        : {}),
    }, { broadcastChanges: ["events-appended", "work-status-changed"] });

    if (
      result.commitCreated &&
      this._shouldAutoArchiveThread({
        thread,
        projectRootPath: project.rootPath,
        environment,
        requested: request?.autoArchiveOnSuccess,
      })
    ) {
      this.archive(thread.id);
    }

    return { message: result.message };
  }

  private async _runWorktreeSquashMergeOperation(
    threadId: string,
    request?: Extract<ThreadOperationRequest, { operation: "squash_merge" }>["options"],
  ): Promise<{ message: string }> {
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
    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment || !environment.supportsSquashMergeIntoDefaultBranch()) {
      throw invalidRequestError("Squash merge is not supported for this environment");
    }

    const options = request ?? {};
    const mergeResult = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: project.rootPath,
      defaultBranch: options.mergeBaseBranch?.trim() || undefined,
      message: options.squashMessage,
      commitIfNeeded: options.commitIfNeeded,
      commitMessage: options.commitMessage,
      includeUnstaged: options.includeUnstaged,
      resolveMessage: async ({ tempWorkspaceRoot }: EnvironmentSquashMergeMessageContext) =>
        this.llmCompletionService.generateCommitMessage({
          cwd: tempWorkspaceRoot,
          includeUnstaged: false,
        }),
    });
    if (mergeResult.prepCommit) {
      this._appendEvent(thread.id, "system/worktree/commit", {
        status: "committed",
        message: mergeResult.prepCommit.message,
        ...(mergeResult.prepCommit.commitSha
          ? { commitSha: mergeResult.prepCommit.commitSha }
          : {}),
        ...(mergeResult.prepCommit.includeUnstaged !== undefined
          ? { includeUnstaged: mergeResult.prepCommit.includeUnstaged }
          : {}),
      }, { broadcastChanges: ["events-appended", "work-status-changed"] });
    }
    this._appendEvent(thread.id, "system/worktree/squash_merge", {
      status: mergeResult.merged
        ? "merged"
        : mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0
          ? "conflict"
          : "noop",
      message: mergeResult.message,
      ...(mergeResult.committed !== undefined ? { committed: mergeResult.committed } : {}),
      ...(options.mergeBaseBranch?.trim()
        ? { mergeBaseBranch: options.mergeBaseBranch.trim() }
        : {}),
      ...(mergeResult.conflictFiles ? { conflictFiles: mergeResult.conflictFiles } : {}),
    }, { broadcastChanges: ["events-appended", "work-status-changed"] });

    if (!mergeResult.merged && mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0) {
      this._enqueueSquashMergeConflictFollowUp(thread.id, {
        operation: "squash_merge",
        ...(request ? { options: request } : {}),
      }, mergeResult.conflictFiles);
    }

    if (
      mergeResult.merged &&
      this._shouldAutoArchiveThread({
        thread,
        projectRootPath: project.rootPath,
        environment,
        mergeBaseBranch: options.mergeBaseBranch?.trim() || undefined,
        requested: options.autoArchiveOnSuccess,
      })
    ) {
      this.archive(thread.id);
    }

    return { message: mergeResult.message };
  }

  private _enqueueSquashMergeConflictFollowUp(
    threadId: string,
    request: Extract<ThreadOperationRequest, { operation: "squash_merge" }>,
    conflictFiles: string[],
  ): void {
    const input: PromptInput[] = [
      {
        type: "text",
        text: buildSquashMergeConflictFollowUpInstruction(request, { conflictFiles }),
      },
    ];

    this._normalizePromptInputForProvider(input);
    const defaultOptions = this.getDefaultExecutionOptions(threadId);
    this.threadRepo.enqueueQueuedMessage(threadId, {
      input,
      model: defaultOptions?.model,
      reasoningLevel: normalizeQueuedReasoningLevel(defaultOptions?.reasoningLevel),
      sandboxMode: normalizeQueuedSandboxMode(defaultOptions?.sandboxMode),
    });
    this._broadcastThreadChanged(threadId, ["queue-changed"]);
    this._scheduleQueuedFollowUpDispatch(threadId);
  }

  /**
   * Stop an active thread by killing its process.
   */
  stop(threadId: string): void {
    this.agentServer.stopSession(threadId, `[thread ${threadId}] Stopping thread`);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    this._cleanupEnvironmentRuntime(threadId);
    this.threadRepo.update(threadId, { status: "idle" });
    this._pruneHistoricalNoiseEvents(threadId, IDLE_NOISE_EVENT_KEEP_RECENT);
    this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
    this._scheduleQueuedFollowUpDispatch(threadId);
  }

  /**
   * Archive a thread and stop any active process.
   */
  archive(threadId: string): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;
    this.queuedOperationsByThreadId.delete(threadId);
    this.operationDispatchInFlight.delete(threadId);

    this.agentServer.stopSession(threadId, `[thread ${threadId}] Archiving thread`);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    const activePromotion = this.primaryPromotionByProjectId.get(thread.projectId);
    if (activePromotion?.threadId === threadId) {
      this._clearPrimaryPromotionState(thread.projectId);
    }
    this._cleanupEnvironmentRuntime(threadId, { destroyWorkspace: true });
    this.threadRepo.update(threadId, {
      status: "idle",
      archivedAt: thread.archivedAt ?? Date.now(),
    });
    this._pruneHistoricalNoiseEvents(threadId, ARCHIVED_NOISE_EVENT_KEEP_RECENT);
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
    }, {
      touchUpdatedAt: false,
    });
    this._broadcastThreadChanged(threadId, ["archived-changed"]);
    this._scheduleQueuedFollowUpDispatch(threadId);
  }

  requiresForceArchive(threadId: string): boolean {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      return false;
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      return false;
    }
    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    return environment?.isIsolatedWorkspace() === true;
  }

  updateThread(threadId: string, request: { title?: string }): Thread {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }

    let didChange = false;
    const nextTitle = this._normalizeThreadTitle(request.title);
    if (nextTitle && nextTitle !== thread.title) {
      this.threadRepo.update(threadId, { title: nextTitle });
      this.titleFallbackByThreadId.delete(threadId);
      this.lockedTitleThreadIds.add(threadId);
      const providerThreadId = this.agentServer.getSessionState(threadId).providerThreadId;
      if (providerThreadId) {
        this._sendThreadNameSet(threadId, providerThreadId, nextTitle);
      }
      didChange = true;
    }

    const updated = this.threadRepo.getById(threadId);
    if (!updated) {
      throw threadNotFoundError(threadId);
    }
    if (didChange) {
      this._broadcastThreadChanged(threadId, ["title-changed"]);
    }
    return this._withPrimaryCheckoutState(updated);
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

    return this._withPrimaryCheckoutState(updated);
  }

  markUnread(threadId: string): Thread {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }

    const nextLastReadAt = Math.max(0, thread.updatedAt - 1);
    if ((thread.lastReadAt ?? 0) <= nextLastReadAt) {
      return this._withPrimaryCheckoutState(thread);
    }

    const updated = this.threadRepo.update(threadId, { lastReadAt: nextLastReadAt }, {
      touchUpdatedAt: false,
    });
    if (!updated) {
      throw threadNotFoundError(threadId);
    }
    this._broadcastThreadChanged(threadId, ["read-state-changed"]);
    return this._withPrimaryCheckoutState(updated);
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
    const latestTokenUsageEvent = this.eventRepo.getLatestByType(
      threadId,
      "thread/tokenUsage/updated",
    );
    const contextWindowUsage = latestTokenUsageEvent
      ? extractThreadContextWindowUsage([latestTokenUsageEvent])
      : null;
    const timeline: ThreadTimelineResponse = contextWindowUsage
      ? { rows, contextWindowUsage }
      : { rows };

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

  getGitDiff(
    threadId: string,
    selection: ThreadGitDiffSelection = { type: "combined" },
    mergeBaseBranch?: string,
  ): ThreadGitDiffResponse {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }
    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment) {
      throw invalidRequestError(this._restoreEnvironmentUnavailableMessage(threadId));
    }
    if (environment.isIsolatedWorkspace()) {
      const defaultBranch = detectProjectDefaultBranch(project.rootPath);
      const status = environment.getWorkspaceStatus({
        defaultBranch,
        mergeBaseBranch,
      });
      const commits = environment.listWorkspaceCommitsSinceRef({
        baseRef: status.baseRef,
      });
      const hasSelectedCommit =
        selection.type === "commit" &&
        commits.some((commit: EnvironmentCommitSummary) => commit.sha === selection.sha);
      const normalizedSelection: ThreadGitDiffSelection = hasSelectedCommit
        ? selection
        : { type: "combined" };
      const diffResult =
        normalizedSelection.type === "combined" &&
        !status.hasUncommittedChanges &&
        !status.hasCommittedUnmergedChanges
          ? { diff: "", truncated: false }
          : normalizedSelection.type === "commit"
          ? environment.getWorkspaceDiff({
              type: "commit",
              commitSha: normalizedSelection.sha,
            })
          : environment.getWorkspaceDiff({
              type: "combined",
              baseRef: status.baseRef,
            });
      return {
        mode: "worktree_commits",
        commits,
        selection: normalizedSelection,
        diff: diffResult.diff,
        truncated: diffResult.truncated,
        ...(status.currentBranch ? { currentBranch: status.currentBranch } : {}),
        ...(status.mergeBaseBranch ? { mergeBaseBranch: status.mergeBaseBranch } : {}),
        ...(status.baseRef ? { mergeBaseRef: status.baseRef } : {}),
      };
    }

    const workspaceStatus = environment.getWorkspaceStatus();
    const diffResult = environment.getWorkspaceDiff({ type: "working_tree" });
    return {
      mode: "local_uncommitted",
      commits: [],
      selection: { type: "combined" },
      diff: diffResult.diff,
      truncated: diffResult.truncated,
    };
  }

  resolveThreadOpenPath(threadId: string, relativePath: string): string {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }
    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment) {
      throw invalidRequestError(this._restoreEnvironmentUnavailableMessage(threadId));
    }
    if (!environment.supportsHostFilesystemAccess()) {
      throw invalidRequestError("Thread path is not available on the host filesystem");
    }
    const trimmed = relativePath.trim();
    if (trimmed.length === 0) {
      throw invalidRequestError("Relative path is required");
    }
    if (isAbsolute(trimmed)) {
      throw invalidRequestError("Path must be relative to the thread workspace");
    }
    const workspaceRoot = environment.getWorkspaceRootUnsafe();
    const resolvedPath = resolve(workspaceRoot, trimmed);
    const relativePathFromRoot = relative(workspaceRoot, resolvedPath);
    if (
      relativePathFromRoot.startsWith("..") ||
      isAbsolute(relativePathFromRoot)
    ) {
      throw invalidRequestError("Path must stay within the thread workspace");
    }
    return resolvedPath;
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
      const output = this.agentServer.outputFromEvent(hydratedEvent);
      if (output !== undefined) return output;
    }
    return undefined;
  }

  /**
   * Lightweight thread lookup for route guards and internal checks that do not
   * need hydrated work status or built-in action state.
   */
  getRawById(threadId: string): Thread | undefined {
    return this.threadRepo.getById(threadId);
  }

  /**
   * Cheap primary-checkout activity check for request paths that only need to
   * know whether a demotion should be attempted.
   */
  isPrimaryCheckoutActive(threadId: string): boolean {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return false;
    this._ensurePrimaryPromotionStateIsCurrent(thread.projectId);
    const activePromotion = this.primaryPromotionByProjectId.get(thread.projectId);
    return activePromotion?.threadId === threadId;
  }

  /**
   * Get the thread record by id.
   */
  getById(threadId: string): Thread | undefined {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    return this._hydrateThreadState(thread);
  }

  getWorkStatus(threadId: string, mergeBaseBranch?: string) {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    return this._hydrateThreadState(thread, { mergeBaseBranch }).workStatus;
  }

  async getWorkStatusAsync(
    threadId: string,
    mergeBaseBranch?: string,
  ): Promise<ThreadWorkStatus | undefined> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return undefined;

    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment) return undefined;
    if (this._shouldForceDeletedWorkStatus(thread)) {
      return this._buildDeletedWorkStatus();
    }

    const defaultBranch = detectProjectDefaultBranch(project.rootPath);
    const workspaceStatus = environment.getWorkspaceStatus({
      defaultBranch,
      mergeBaseBranch,
    });
    return { ...workspaceStatus };
  }

  getProjectWorkspaceStatus(projectId: string, rootPath: string): ThreadWorkStatus {
    return this.environmentService.getProjectWorkspaceStatus(projectId, rootPath);
  }

  getPrimaryCheckoutStatus(projectId: string): PrimaryCheckoutStatus {
    this._ensurePrimaryPromotionStateIsCurrent(projectId);
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
    if (!filters?.includeWorkStatus) {
      return threads.map((thread) => this._withPrimaryCheckoutState(thread));
    }
    return threads.map((thread) => this._hydrateThreadState(thread));
  }

  async requestThreadOperation(
    threadId: string,
    request: ThreadOperationRequest,
  ): Promise<ThreadOperationResponse> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }
    if (request.operation === "squash_merge") {
      const project = this.projectRepo.getById(thread.projectId);
      if (!project) {
        throw projectNotFoundError(thread.projectId);
      }
      const environment = this._restoreThreadEnvironment(thread, project.rootPath);
      if (!environment || !environment.supportsSquashMergeIntoDefaultBranch()) {
        throw invalidRequestError("Squash merge is not supported for this environment");
      }
    }

    const requiresDemoteFirst =
      this.primaryPromotionByProjectId.get(thread.projectId)?.threadId === thread.id;
    const builtInAction = this._getThreadBuiltInAction(thread, request.operation);

    const operationId = this._nextOperationId();
    let demotedPrimaryCheckout = false;
    try {
      if (requiresDemoteFirst) {
        await this.demotePrimaryCheckout(thread.id);
        demotedPrimaryCheckout = true;
      }

      this._appendThreadOperationEvent(thread.id, request.operation, "requested", {
        operationId,
        message: this._threadOperationRequestedMessage(request.operation),
        demotedPrimaryCheckout,
      });
      this._enqueueThreadOperation(
        thread.id,
        request,
        demotedPrimaryCheckout,
        operationId,
      );

      const latestThread = this.threadRepo.getById(thread.id);
      const shouldQueue =
        builtInAction.queuesWhenActive ||
        latestThread?.status !== "idle" ||
        this.projectOperationTransitionsInFlight.has(thread.projectId);
      if (shouldQueue) {
        this._appendThreadOperationEvent(thread.id, request.operation, "queued", {
          operationId,
          message: this._threadOperationQueuedMessage(request.operation),
          demotedPrimaryCheckout,
        });
      }

      this._scheduleQueuedOperationDispatch(thread.id);

      return {
        ok: true,
        operationId,
        operation: request.operation,
        status: "accepted",
        executionStatus: shouldQueue ? "queued" : "running",
        queued: shouldQueue,
        message: shouldQueue
          ? this._threadOperationAcceptedQueuedMessage(request.operation)
          : this._threadOperationAcceptedRunningMessage(request.operation),
        demotedPrimaryCheckout,
      };
    } catch (err) {
      const message = this._toErrorMessage(err);
      this._appendThreadOperationEvent(thread.id, request.operation, "failed", {
        operationId,
        message,
        ...(demotedPrimaryCheckout ? { demotedPrimaryCheckout } : {}),
      });
      if (isDomainError(err)) {
        throw err;
      }
      throw invalidRequestError(message);
    }
  }

  async promoteThread(threadId: string): Promise<PromoteThreadResponse> {
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
    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment || !environment.supportsPromoteToActiveWorkspace()) {
      throw invalidRequestError("Promotion is not supported for this environment");
    }
    return this._runWithPrimaryCheckoutTransitionLock(project.id, async () => {
      this._ensurePrimaryPromotionStateIsCurrent(project.id, { force: true });
      const existingPromotion = this.primaryPromotionByProjectId.get(project.id);

      if (existingPromotion?.threadId === thread.id) {
        this._appendEvent(
          thread.id,
          "system/primary_checkout/updated",
          {
            action: "promote",
            status: "noop",
            message: "Primary checkout is already promoted to this thread",
            projectId: project.id,
            activeThreadId: thread.id,
            ...(existingPromotion.promotedCheckout.branch
              ? { branch: existingPromotion.promotedCheckout.branch }
              : {}),
          },
          { broadcastChanges: ["events-appended"] },
        );
        return {
          ok: true,
          promoted: false,
          message: "Primary checkout is already promoted to this thread",
          primaryStatus: this.getPrimaryCheckoutStatus(project.id),
        };
      }

      if (existingPromotion) {
        const activeThread = this.threadRepo.getById(existingPromotion.threadId);
        if (!activeThread) {
          throw invalidRequestError(
            `Thread ${existingPromotion.threadId} is currently promoted in primary checkout`,
          );
        }
        this._appendEvent(
          activeThread.id,
          "system/primary_checkout/updated",
          {
            action: "demote",
            status: "started",
            message: "Demoting primary checkout back to pre-promotion state",
            projectId: project.id,
            activeThreadId: activeThread.id,
          },
          { broadcastChanges: ["events-appended"] },
        );
        try {
          const demoteResult = await this.environmentService.demotePrimaryCheckout({
            thread: activeThread,
            ttlMs: PRIMARY_CHECKOUT_VALIDATION_TTL_MS,
          });
          this._appendEvent(
            activeThread.id,
            "system/primary_checkout/updated",
            {
              action: "demote",
              status: "completed",
              message: "Primary checkout restored from promoted state",
              projectId: project.id,
              ...(demoteResult.snapshot?.branch ? { branch: demoteResult.snapshot.branch } : {}),
            },
            { broadcastChanges: ["events-appended"] },
          );
          this._broadcastThreadChanged(activeThread.id, THREAD_STATUS_CHANGE_KINDS);
        } catch (err) {
          const message = this._toErrorMessage(err);
          this._appendEvent(
            activeThread.id,
            "system/primary_checkout/updated",
            {
              action: "demote",
              status: "failed",
              message,
              projectId: project.id,
              activeThreadId: activeThread.id,
            },
            { broadcastChanges: ["events-appended"] },
          );
          this._broadcastThreadChanged(activeThread.id, THREAD_STATUS_CHANGE_KINDS);
          throw invalidRequestError(message);
        }
      }

      const result = await this.environmentService.promoteThreadEnvironment({
        thread,
        ttlMs: PRIMARY_CHECKOUT_VALIDATION_TTL_MS,
      });

      if (result.reason === "already-promoted-same-thread" && result.state) {
        this._appendEvent(
          thread.id,
          "system/primary_checkout/updated",
          {
            action: "promote",
            status: "noop",
            message: "Primary checkout is already promoted to this thread",
            projectId: project.id,
            activeThreadId: thread.id,
            ...(result.state.promotedCheckout.branch
              ? { branch: result.state.promotedCheckout.branch }
              : {}),
          },
          { broadcastChanges: ["events-appended"] },
        );
        return {
          ok: true,
          promoted: false,
          message: "Primary checkout is already promoted to this thread",
          primaryStatus: result.status,
        };
      }

      if (
        !environment ||
        !environment.isIsolatedWorkspace()
      ) {
        throw invalidRequestError(
          "Thread worktree path is unavailable (workspace resolved to project root); reprovision before promoting",
        );
      }
      if (!environment.exists()) {
        throw invalidRequestError("Thread worktree is unavailable; reprovision the thread first");
      }
      this._appendEvent(
        thread.id,
        "system/primary_checkout/updated",
        {
          action: "promote",
          status: "started",
          message: "Promoting thread worktree into primary checkout",
          projectId: project.id,
          activeThreadId: thread.id,
        },
        { broadcastChanges: ["events-appended"] },
      );

      try {
        const promotedState = result.state;
        this._appendEvent(
          thread.id,
          "system/primary_checkout/updated",
          {
            action: "promote",
            status: "completed",
            message: "Primary checkout now reflects this thread worktree",
            projectId: project.id,
            activeThreadId: thread.id,
            ...(promotedState?.promotedCheckout.branch
              ? { branch: promotedState.promotedCheckout.branch }
              : {}),
          },
          { broadcastChanges: ["events-appended"] },
        );
        this._broadcastThreadChanged(thread.id, THREAD_STATUS_CHANGE_KINDS);
        return {
          ok: true,
          promoted: true,
          message: "Primary checkout promoted",
          primaryStatus: result.status,
        };
      } catch (err) {
        const message = this._toErrorMessage(err);
        this._appendEvent(
          thread.id,
          "system/primary_checkout/updated",
          {
            action: "promote",
            status: "failed",
            message,
            projectId: project.id,
            activeThreadId: thread.id,
          },
          { broadcastChanges: ["events-appended"] },
        );
        this._broadcastThreadChanged(thread.id, THREAD_STATUS_CHANGE_KINDS);
        throw invalidRequestError(message);
      }
    });
  }

  async demotePrimaryCheckout(threadId: string): Promise<DemotePrimaryResponse> {
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
    return this._runWithPrimaryCheckoutTransitionLock(project.id, async () => {
      this._ensurePrimaryPromotionStateIsCurrent(project.id, { force: true });
      const active = this.primaryPromotionByProjectId.get(project.id);
      if (!active) {
        this._appendEvent(
          thread.id,
          "system/primary_checkout/updated",
          {
            action: "demote",
            status: "noop",
            message: "Primary checkout is already demoted",
            projectId: project.id,
          },
          { broadcastChanges: ["events-appended"] },
        );
        return {
          ok: true,
          demoted: false,
          message: "Primary checkout is already demoted",
          primaryStatus: this.getPrimaryCheckoutStatus(project.id),
        };
      }

      if (active.threadId !== thread.id) {
        throw invalidRequestError(
          `Thread ${active.threadId} is currently promoted in primary checkout`,
        );
      }
      const activeThread = this.threadRepo.getById(active.threadId);
      this._appendEvent(
        active.threadId,
        "system/primary_checkout/updated",
        {
          action: "demote",
          status: "started",
          message: "Demoting primary checkout back to pre-promotion state",
          projectId: project.id,
          activeThreadId: active.threadId,
        },
        { broadcastChanges: ["events-appended"] },
      );

      try {
        const result = await this.environmentService.demotePrimaryCheckout({
          thread,
          ttlMs: PRIMARY_CHECKOUT_VALIDATION_TTL_MS,
        });
        this._appendEvent(
          active.threadId,
          "system/primary_checkout/updated",
          {
            action: "demote",
            status: "completed",
            message: "Primary checkout restored from promoted state",
            projectId: project.id,
            ...(result.snapshot?.branch ? { branch: result.snapshot.branch } : {}),
          },
          { broadcastChanges: ["events-appended"] },
        );

        if (activeThread) {
          this._broadcastThreadChanged(activeThread.id, THREAD_STATUS_CHANGE_KINDS);
        } else {
          this._broadcastThreadChanged(active.threadId, THREAD_STATUS_CHANGE_KINDS);
        }
        return {
          ok: true,
          demoted: true,
          message: "Primary checkout demoted",
          primaryStatus: result.status,
        };
      } catch (err) {
        const message = this._toErrorMessage(err);
        this._appendEvent(
          active.threadId,
          "system/primary_checkout/updated",
          {
            action: "demote",
            status: "failed",
            message,
            projectId: project.id,
            activeThreadId: active.threadId,
          },
          { broadcastChanges: ["events-appended"] },
        );
        this._broadcastThreadChanged(active.threadId, THREAD_STATUS_CHANGE_KINDS);
        throw invalidRequestError(message);
      }
    });
  }

  /**
   * Check if a thread's process is currently active.
   */
  isActive(threadId: string): boolean {
    return this.agentServer.isSessionActive(threadId);
  }

  /**
   * Get count of currently active (running) thread processes.
   */
  getActiveCount(): number {
    return this.agentServer.getActiveSessionCount();
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
    return this.agentServer.listModels();
  }

  getProviderInfo(): SystemProviderInfo {
    return this.agentServer.getProviderInfo();
  }

  listProviders(): SystemProviderInfo[] {
    return this.agentServer.listProviders();
  }

  listEnvironments(): SystemEnvironmentInfo[] {
    return this.environmentService.listEnvironments();
  }

  async getEnvironmentAgentStatus(
    threadId: string,
  ): Promise<EnvironmentAgentStatusSnapshot> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    try {
      return await this.agentServer.getEnvironmentAgentStatus(threadId);
    } catch (error) {
      this._rethrowAgentServerError(threadId, error);
    }
  }

  async replayEnvironmentAgentEvents(args: {
    threadId: string;
    afterSequence: number;
    limit?: number;
  }): Promise<{
    events: EnvironmentAgentEventEnvelope[];
    fromSequenceExclusive: number;
    toSequenceInclusive: number;
    hasMore: boolean;
  }> {
    const thread = this.threadRepo.getById(args.threadId);
    if (!thread) {
      throw threadNotFoundError(args.threadId);
    }
    try {
      return await this.agentServer.replayEnvironmentAgentEvents(args);
    } catch (error) {
      this._rethrowAgentServerError(args.threadId, error);
    }
  }

  async ingestEnvironmentAgentEvents(args: {
    threadId: string;
    authorizationHeader?: string;
    events: EnvironmentAgentEventEnvelope[];
  }): Promise<EnvironmentAgentDeliveryResponse> {
    const thread = this.threadRepo.getById(args.threadId);
    if (!thread) {
      throw threadNotFoundError(args.threadId);
    }

    this._assertEnvironmentAgentAuthorization(args.threadId, args.authorizationHeader);

    const persistedCursor =
      (this.threadRepo.getById(args.threadId) as
        | (Thread & { environmentAgentCursor?: number })
        | undefined)?.environmentAgentCursor ?? 0;
    const currentCursor =
      this.environmentAgentReplayCursorByThreadId.get(args.threadId) ?? persistedCursor;

    const newEvents: EnvironmentAgentEventEnvelope[] = [];
    let expectedSequence = currentCursor + 1;
    for (const event of args.events) {
      if (event.sequence < expectedSequence) {
        continue;
      }
      if (event.sequence !== expectedSequence) {
        break;
      }
      newEvents.push(event);
      expectedSequence += 1;
    }

    if (newEvents.length === 0) {
      return {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        threadId: args.threadId,
        acknowledgedSequence: currentCursor,
      };
    }

    try {
      await this.agentServer.ingestReplayedEnvironmentAgentEvents({
        threadId: args.threadId,
        events: newEvents,
      });
      const acknowledgedSequence = newEvents[newEvents.length - 1]!.sequence;
      this._setEnvironmentAgentReplayCursor(args.threadId, acknowledgedSequence);
      return {
        protocolVersion: ENVIRONMENT_AGENT_PROTOCOL_VERSION,
        threadId: args.threadId,
        acknowledgedSequence,
      };
    } catch (error) {
      this._rethrowAgentServerError(args.threadId, error);
    }
  }

  async retryEnvironmentAgentDelivery(
    threadId: string,
  ): Promise<EnvironmentAgentStatusSnapshot> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    try {
      return await this.agentServer.retryEnvironmentAgentDelivery(threadId);
    } catch (error) {
      this._rethrowAgentServerError(threadId, error);
    }
  }

  /**
   * Stop all active processes. Called during graceful shutdown.
   */
  stopAll(): void {
    const threadIds = new Set<string>(this.agentServer.listActiveSessionIds());
    const activeThreads = this.threadRepo.list({ includeArchived: true }) ?? [];
    for (const thread of activeThreads) {
      threadIds.add(thread.id);
    }
    for (const threadId of threadIds) {
      // Shutdown/restart should not create unread noise by touching thread.updatedAt.
      this.threadRepo.update(threadId, { status: "idle" }, {
        touchUpdatedAt: false,
      });
    }
    this.agentServer.stopAllSessions("Beanbag daemon shutdown");
    this.environmentService.stopAll();
    this.autoTitleAttemptedThreadIds.clear();
    this.titleFallbackByThreadId.clear();
    this.provisioningTasks.clear();
    this.eventSeqCounters.clear();
    this.lastNotifiedCompletionTurnIds.clear();
    this.turnLifecycleEpochs.clear();
    this.lastNotifiedCompletionEpochs.clear();
    this.queueDispatchInFlight.clear();
    this.queuedOperationsByThreadId.clear();
    this.operationDispatchInFlight.clear();
    this.projectOperationTransitionsInFlight.clear();
    this.environmentAgentReplayCursorByThreadId.clear();
    for (const queued of this.queuedProviderBroadcastsByThread.values()) {
      if (queued.timer !== null) {
        clearTimeout(queued.timer);
      }
    }
    this.queuedProviderBroadcastsByThread.clear();
  }

  private _scheduleProvisioning(
    threadId: string,
    req: SpawnThreadRequest,
    opts?: { rootPathHint?: string; reason: ThreadProvisioningReason },
  ): void {
    if (this.provisioningTasks.has(threadId)) return;

    let task: Promise<void>;
    task = new Promise<void>((resolveTask) => {
      setImmediate(() => {
        if (this.provisioningTasks.get(threadId) !== task) {
          resolveTask();
          return;
        }

        void this._provisionThread(threadId, req, opts)
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
            console.error(
              `[thread ${threadId}] provisioning failed${reason}: ${message}`,
            );
          })
          .finally(() => {
            if (this.provisioningTasks.get(threadId) === task) {
              this.provisioningTasks.delete(threadId);
            }
            resolveTask();
          });
      });
    });

    this.provisioningTasks.set(threadId, task);
  }

  private async _provisionThread(
    threadId: string,
    req: SpawnThreadRequest,
    opts?: { rootPathHint?: string; reason: ThreadProvisioningReason },
  ): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (thread?.archivedAt !== undefined) return;

    const project = this.projectRepo.getById(req.projectId);
    if (!project) {
      throw projectNotFoundError(req.projectId);
    }

    const requestedInput = req.input ?? [];
    const preProvisionDeveloperInstructions = this._buildDeveloperInstructions({
      projectInstructions: project.projectInstructions,
      requestDeveloperInstructions: req.developerInstructions,
    });
    const preProvisionRequest = preProvisionDeveloperInstructions
      ? { ...req, developerInstructions: preProvisionDeveloperInstructions }
      : req;
    const preProvisionThreadStartParams = this._buildThreadStartParams(
      preProvisionRequest,
      this._buildProviderThreadContext({
        threadId,
        projectId: req.projectId,
      }),
    );
    const provisioningReason = opts?.reason ?? "thread-created";
    const startSource = provisioningReason === "tell-after-provisioning-failure" ? "tell" : "spawn";
    const persistedThreadStartEvent = this._persistOutboundStartEvent(
      threadId,
      "client/thread/start",
      preProvisionThreadStartParams,
      requestedInput,
      {
        source: startSource,
        initiator: "agent",
      },
    );

    // Ensure provisioning starts from a clean runtime state.
    this._cleanupThreadRuntime(threadId);
    this._setThreadStatus(threadId, "provisioning", true, {
      force: true,
    });

    const requestedEnvironmentId = this._resolveRequestedEnvironmentId(
      req.environmentId ?? thread?.environmentId,
    );
    if (thread && thread.environmentId !== requestedEnvironmentId) {
      this.threadRepo.update(threadId, { environmentId: requestedEnvironmentId });
    }
    const requestedEnvironmentInfo = this.environmentRegistry.get(requestedEnvironmentId).info;
    this._appendEvent(threadId, "system/provisioning/started", {
      environmentId: requestedEnvironmentId,
      environmentDisplayName: requestedEnvironmentInfo.displayName,
      reason: provisioningReason,
    });

    const environmentRuntime = await this._spawnProcess(
      threadId,
      opts?.rootPathHint ?? project.rootPath,
      requestedEnvironmentId,
      provisioningReason,
    );
    this.threadRepo.update(threadId, {
      environmentId: environmentRuntime.environment.kind,
      environmentRecord: {
        kind: environmentRuntime.environment.kind,
        state: environmentRuntime.environment.serialize(),
      },
    });
    this._appendEvent(threadId, "system/provisioning/completed", {
      environmentId: environmentRuntime.environment.kind,
      reason: provisioningReason,
    });
    const hydratedThread = this.threadRepo.getById(threadId);
    if (hydratedThread) {
      this._broadcastThreadChanged(threadId, ["work-status-changed"]);
    }
    const providerInput = this._normalizePromptInputForProvider(requestedInput);

    const effectiveDeveloperInstructions = this._buildDeveloperInstructions({
      projectInstructions: project.projectInstructions,
      requestDeveloperInstructions: req.developerInstructions,
      environment: environmentRuntime.environment,
    });
    const effectiveRequest = effectiveDeveloperInstructions
      ? { ...req, developerInstructions: effectiveDeveloperInstructions }
      : req;
    const providerContext = this._buildProviderThreadContext({
      threadId,
      projectId: req.projectId,
    });
    const threadStartParams = this._buildThreadStartParams(
      effectiveRequest,
      providerContext,
    );
    this._amendOutboundStartEvent(
      threadId,
      persistedThreadStartEvent.id,
      "client/thread/start",
      threadStartParams,
      requestedInput,
      {
        source: startSource,
        initiator: "agent",
      },
    );
    const started = await this.agentServer.startSession({
      threadId,
      connectSession: environmentRuntime.connectSession!,
      request: effectiveRequest,
      context: providerContext,
    });
    await this._replayBufferedEnvironmentAgentEvents(threadId);
    const providerThreadId = started.providerThreadId;
    const hydratedThreadAfterStart = this.threadRepo.getById(threadId);
    if (
      hydratedThreadAfterStart?.title &&
      this.lockedTitleThreadIds.has(threadId)
    ) {
      this._sendThreadNameSet(threadId, providerThreadId, hydratedThreadAfterStart.title);
    }

    this._maybeAutogenerateThreadTitle(
      threadId,
      project.rootPath,
      providerThreadId,
      requestedInput,
    );

    if (requestedInput.length > 0) {
      this._setThreadStatus(threadId, "active");
      const turnStartParams = this._buildTurnStartParams(providerThreadId, providerInput, req);
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
      await this.agentServer.sendTurn({
        threadId,
        input: providerInput,
        options: req,
        mode: "start",
      });
      return;
    }

    this._setThreadStatus(threadId, "idle");
  }

  private _cleanupThreadRuntime(threadId: string): void {
    this.agentServer.stopSession(threadId);
    this.eventSeqCounters.delete(threadId);
    this.environmentAgentReplayCursorByThreadId.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    this.queuedOperationsByThreadId.delete(threadId);
    this.operationDispatchInFlight.delete(threadId);
    this.environmentService.cleanupEnvironmentRuntime(threadId);
  }

  private async _replayBufferedEnvironmentAgentEvents(
    threadId: string,
  ): Promise<void> {
    const persistedCursor =
      (
        this.threadRepo.getById(threadId) as
          | (Thread & { environmentAgentCursor?: number })
          | undefined
      )?.environmentAgentCursor ?? 0;
    const afterSequence =
      this.environmentAgentReplayCursorByThreadId.get(threadId) ?? persistedCursor;
    const replay = await this.agentServer.replayEnvironmentAgentEvents({
      threadId,
      afterSequence,
    });
    if (replay.events.length > 0) {
      await this.agentServer.ingestReplayedEnvironmentAgentEvents({
        threadId,
        events: replay.events,
      });
    }
    this._setEnvironmentAgentReplayCursor(
      threadId,
      Math.max(afterSequence, replay.toSequenceInclusive),
    );
  }

  private _setEnvironmentAgentReplayCursor(
    threadId: string,
    sequence: number,
  ): void {
    this.environmentAgentReplayCursorByThreadId.set(threadId, sequence);
    this.threadRepo.update(
      threadId,
      { environmentAgentCursor: sequence } as { environmentAgentCursor: number },
      { touchUpdatedAt: false },
    );
  }

  private _assertEnvironmentAgentAuthorization(
    threadId: string,
    authorizationHeader?: string,
  ): void {
    const expectedAuthorization = this._resolveEnvironmentAgentAuthorization(threadId);
    if (!expectedAuthorization || authorizationHeader !== expectedAuthorization) {
      throw invalidRequestError("Unauthorized environment-agent delivery");
    }
  }

  private _resolveEnvironmentAgentAuthorization(threadId: string): string | undefined {
    const runtime = this.environmentService.getEnvironmentRuntime(threadId);
    if (runtime?.agentConnectionTarget.headers?.authorization) {
      return runtime.agentConnectionTarget.headers.authorization;
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      return undefined;
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      return undefined;
    }

    try {
      const restored = this.environmentService.restoreThreadEnvironment(thread, project.rootPath);
      return restored?.getAgentConnectionTarget().headers?.authorization;
    } catch {
      return undefined;
    }
  }

  private async _nudgeEnvironmentAgentDelivery(threadId: string): Promise<void> {
    try {
      await this.agentServer.retryEnvironmentAgentDelivery(threadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[thread ${threadId}] Failed to nudge environment-agent delivery: ${message}`,
      );
    }
  }

  private _setEnvironmentRuntime(
    threadId: string,
    environment: IEnvironment,
  ): void {
    this.environmentService.setEnvironmentRuntime(threadId, environment);
  }

  private _cleanupEnvironmentRuntime(
    threadId: string,
    opts?: { destroyWorkspace?: boolean },
  ): void {
    this.environmentService.cleanupEnvironmentRuntime(threadId, opts);
  }

  private _cleanupPersistedWorkspace(threadId: string): void {
    this.environmentService.cleanupPersistedWorkspace(threadId);
  }

  private _appendEnvironmentProvisioningEvent(
    threadId: string,
    event: EnvironmentProvisioningEvent,
  ): void {
    this._appendEvent(threadId, "system/provisioning/env_setup", {
      status: event.status,
      scriptPath: event.scriptPath,
      ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.detail ? { detail: event.detail } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    });
  }

  private _createEnvironmentContext(
    threadId: string,
    projectRootPath: string,
  ): CreateEnvironmentContext {
    const thread = this.threadRepo.getById(threadId);
    return {
      projectId: thread?.projectId ?? "",
      threadId,
      projectRootPath,
      runtimeEnv: this.runtimeEnv,
      services: {
        llmCompletion: async ({ cwd, includeUnstaged }: LlmCommitMessageGenerationArgs) => {
          const generated = await this.llmCompletionService.generateCommitMessage({
            cwd,
            includeUnstaged,
          });
          const message = generated?.trim();
          if (!message) {
            throw new Error(
              `Failed to auto-generate commit message (${this.llmCompletionService.displayName})`,
            );
          }
          return message;
        },
      },
    };
  }

  private async _runOptionalEnvironmentSetup(
    threadId: string,
    environment: IEnvironment,
    reason: ThreadEnvironmentStartReason,
  ): Promise<void> {
    if (!environment.shouldRunSetupScript()) {
      return;
    }
    const scriptPath = join(
      environment.getWorkspaceRootUnsafe(),
      ENV_SETUP_SCRIPT_NAME,
    );
    if (!existsSync(scriptPath)) {
      return;
    }

    const startedAt = Date.now();
    const thread = this.threadRepo.getById(threadId);
    this._appendEnvironmentProvisioningEvent(threadId, {
      type: "env-setup",
      status: "started",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      reason,
    });
    let sawSetupOutput = false;
    const runEnvironmentCommand =
      typeof environment.runAsync === "function"
        ? environment.runAsync.bind(environment)
        : async (...args: Parameters<IEnvironment["run"]>) => environment.run(...args);
    const result = await runEnvironmentCommand(
      "bash",
      ["-x", `./${ENV_SETUP_SCRIPT_NAME}`],
      {
        timeoutMs: ENV_SETUP_TIMEOUT_MS,
        env: {
          ...(thread?.projectId ? { BB_PROJECT_ID: thread.projectId } : {}),
          BB_THREAD_ID: threadId,
          BB_ENV_SETUP_TIMEOUT_MS: String(ENV_SETUP_TIMEOUT_MS),
        },
        onStdoutLine: (line) => {
          if (line.length === 0) return;
          sawSetupOutput = true;
          this._appendEnvironmentProvisioningEvent(threadId, {
            type: "env-setup",
            status: "running",
            scriptPath: ENV_SETUP_SCRIPT_NAME,
            timeoutMs: ENV_SETUP_TIMEOUT_MS,
            detail: line,
            reason,
          });
        },
        onStderrLine: (line) => {
          if (line.length === 0) return;
          sawSetupOutput = true;
          this._appendEnvironmentProvisioningEvent(threadId, {
            type: "env-setup",
            status: "running",
            scriptPath: ENV_SETUP_SCRIPT_NAME,
            timeoutMs: ENV_SETUP_TIMEOUT_MS,
            detail: line,
            reason,
          });
        },
      },
    );
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout || "unknown error").trim();
      this._appendEnvironmentProvisioningEvent(threadId, {
        type: "env-setup",
        status: "failed",
        scriptPath: ENV_SETUP_SCRIPT_NAME,
        timeoutMs: ENV_SETUP_TIMEOUT_MS,
        durationMs: Date.now() - startedAt,
        ...(sawSetupOutput ? {} : { detail }),
        reason,
      });
      throw new Error(`${ENV_SETUP_SCRIPT_NAME} failed: ${detail}`);
    }
    this._appendEnvironmentProvisioningEvent(threadId, {
      type: "env-setup",
      status: "completed",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      durationMs: Date.now() - startedAt,
      reason,
    });
    if (this.threadRepo.getById(threadId)?.status !== "provisioning") {
      this._appendEvent(threadId, "system/provisioning/completed", {
        environmentId: environment.kind,
      });
    }
  }

  private async _spawnProcess(
    threadId: string,
    projectRootPath: string,
    environmentKind: string,
    reason: ThreadEnvironmentStartReason,
  ): Promise<ActiveEnvironmentRuntime> {
    return this.environmentService.provisionThreadEnvironment(
      threadId,
      projectRootPath,
      environmentKind,
      reason,
    );
  }

  private async _connectEnvironmentAgentSession(args: {
    threadId: string;
    projectId?: string;
    agentConnectionTarget: EnvironmentAgentConnectionTarget;
  }): Promise<AgentServerSessionConnection> {
    return {
      transport: "http",
      client: await createHttpEnvironmentAgentClient({
        baseUrl: args.agentConnectionTarget.baseUrl,
        ...(args.agentConnectionTarget.headers
          ? { headers: args.agentConnectionTarget.headers }
          : {}),
      }),
      ...(args.agentConnectionTarget.providerLaunch
        ? {
            providerLaunch: {
              command: args.agentConnectionTarget.providerLaunch.command,
              args: [...args.agentConnectionTarget.providerLaunch.args],
            },
          }
        : {}),
    };
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
    }
    return undefined;
  }

  private _resolvePersistedActiveTurnId(threadId: string): string | undefined {
    const thread = this.threadRepo.getById(threadId);
    if (thread && thread.status !== "active") {
      return undefined;
    }

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
      const normalizedType = this.agentServer.normalizeEventType(method);
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
    const sessionState = this.agentServer.getSessionState(threadId);
    const hasActiveProcess = sessionState.hasActiveRuntime;
    const inMemoryThreadId = sessionState.providerThreadId;
    const persistedThreadId =
      inMemoryThreadId ?? this._resolvePersistedProviderThreadId(threadId);

    if (hasActiveProcess) {
      if (inMemoryThreadId) return inMemoryThreadId;
      if (persistedThreadId) {
        this.agentServer.hydrateSessionState(threadId, {
          providerThreadId: persistedThreadId,
        });
        return persistedThreadId;
      }
      throw inactiveSessionError(this.agentServer.getInactiveSessionMessage(threadId));
    }

    if (!persistedThreadId) {
      throw inactiveSessionError(this.agentServer.getInactiveSessionMessage(threadId));
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
      const environmentKind = this._resolveRequestedEnvironmentId(
        thread.environmentRecord?.kind ?? thread.environmentId,
      );
      const environmentRuntime = await this._spawnProcess(
        threadId,
        project.rootPath,
        environmentKind,
        "resume-existing-provider-session",
      );
      const resumed = await this.agentServer.resumeSession({
        threadId,
        connectSession: environmentRuntime.connectSession!,
        providerThreadId: persistedThreadId,
        context: this._buildProviderThreadContext({
          threadId,
          projectId: thread.projectId,
        }),
        options,
      });
      await this._replayBufferedEnvironmentAgentEvents(threadId);
      return resumed.providerThreadId;
    } catch (err) {
      this._cleanupThreadRuntime(threadId);
      if (!this.agentServer.isMissingProviderThreadError(err)) {
        this._rethrowAgentServerError(threadId, err);
        throw err;
      }

      // Resume can fail when provider-side rollout state has been evicted.
      // Fall back to fresh provisioning so the pending tell can continue.
      await this._provisionThread(
        threadId,
        {
          projectId: thread.projectId,
          model: options?.model,
          serviceTier: options?.serviceTier,
          reasoningLevel: options?.reasoningLevel,
          sandboxMode: options?.sandboxMode,
          environmentId: thread.environmentId,
        },
        {
          rootPathHint: project.rootPath,
          reason: "resume-missing-provider-thread",
        },
      );
      const reprovisionedThreadId = this.agentServer.getSessionState(threadId).providerThreadId;
      if (reprovisionedThreadId) return reprovisionedThreadId;

      throw err;
    }
  }

  private _buildProviderThreadContext(args: {
    threadId: string;
    projectId: string;
  }): ProviderThreadContext {
    const environmentRuntime = this.environmentService.getEnvironmentRuntime(args.threadId);
    return {
      projectId: args.projectId,
      threadId: args.threadId,
      ...(this.threadShellPath ? { path: this.threadShellPath } : {}),
    };
  }

  private _buildThreadStartParams(
    request: SpawnThreadRequest,
    context: ProviderThreadContext,
  ): Record<string, unknown> {
    const defaultBaseInstructions =
      "You are a coding agent working on a project thread. Follow the instructions carefully and write clean, working code.";
    const baseInstructions = request.developerInstructions?.trim()
      ? request.developerInstructions.startsWith(defaultBaseInstructions)
        ? request.developerInstructions
        : `${defaultBaseInstructions}\n\n${request.developerInstructions}`
      : defaultBaseInstructions;
    return {
      approvalPolicy: "never",
      sandbox: request.sandboxMode ?? "danger-full-access",
      baseInstructions,
      ...(request.model ? { model: request.model } : {}),
      ...(request.serviceTier ? { service_tier: request.serviceTier } : {}),
      ...(request.reasoningLevel
        ? { config: { model_reasoning_effort: request.reasoningLevel } }
        : {}),
      ...(context.path
        ? {
            config: {
              ...(request.reasoningLevel
                ? { model_reasoning_effort: request.reasoningLevel }
                : {}),
              "shell_environment_policy.set.BB_PROJECT_ID": context.projectId,
              "shell_environment_policy.set.BB_THREAD_ID": context.threadId,
              "shell_environment_policy.set.PATH": context.path,
            },
          }
        : {}),
    };
  }

  private _buildTurnStartParams(
    providerThreadId: string,
    input: PromptInput[],
    options?: ProviderExecutionOptions,
  ): Record<string, unknown> {
    const sandboxMode = options?.sandboxMode ?? "danger-full-access";
    const sandboxPolicy =
      sandboxMode === "read-only"
        ? { type: "readOnly" }
        : sandboxMode === "workspace-write"
          ? {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            }
          : { type: "dangerFullAccess" };
    return {
      threadId: providerThreadId,
      input,
      approvalPolicy: "never",
      sandboxPolicy,
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.serviceTier ? { service_tier: options.serviceTier } : {}),
      ...(options?.reasoningLevel
        ? { config: { model_reasoning_effort: options.reasoningLevel } }
        : {}),
    };
  }

  private _resolveRequestedEnvironmentId(value?: string): string {
    try {
      return this.environmentService.resolveRequestedEnvironmentId(value);
    } catch (error) {
      throw invalidRequestError(error instanceof Error ? error.message : String(error));
    }
  }

  private _restoreThreadEnvironment(
    thread: Thread,
    projectRootPath: string,
  ): IEnvironment | undefined {
    try {
      return this.environmentService.restoreThreadEnvironment(thread, projectRootPath);
    } catch {
      return undefined;
    }
  }

  private _toErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private _restoreEnvironmentUnavailableMessage(threadId: string): string {
    return this.environmentService.getRestoreFailure(threadId) ??
      "Thread workspace is unavailable";
  }

  private _buildDeveloperInstructions(args: {
    projectInstructions?: string;
    requestDeveloperInstructions?: string;
    environment?: IEnvironment;
  }): string | undefined {
    const projectInstructions = args.projectInstructions?.trim();
    const requestInstructions = args.requestDeveloperInstructions?.trim();
    const baseInstructions = [projectInstructions, requestInstructions]
      .filter((value): value is string => Boolean(value))
      .join("\n\n")
      .trim();
    const currentInstructions = baseInstructions.length > 0
      ? baseInstructions
      : undefined;
    const environmentInstructions = args.environment?.buildAgentInstructions?.();
    if (!environmentInstructions) {
      return currentInstructions;
    }
    const customized = [currentInstructions, environmentInstructions]
      .filter((value): value is string => Boolean(value && value.trim().length > 0))
      .join("\n\n")
      .trim();
    return customized.length > 0 ? customized : undefined;
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

  private _handleAgentServerNotification(
    threadId: string,
    event: AgentServerNotification,
  ): void {
    const changes: ThreadChangeKind[] = [];
    let persistedEvent: ThreadEvent | undefined;

    if (event.shouldPersist) {
      if (event.shouldBroadcast) {
        changes.push("events-appended");
      }
      persistedEvent = this._appendEvent(threadId, event.eventType, event.eventData, {
        broadcastChanges: false,
      });
      this._maybePruneActiveThreadNoise(
        threadId,
        event.normalizedMethod,
        persistedEvent.seq,
      );
    }

    const titleChanged = this._syncTitleFromEvent(threadId, event);
    if (event.shouldBroadcast && titleChanged) {
      changes.push("title-changed");
    }

    const statusChanged = this._syncStatusFromEvent(threadId, event);
    if (event.shouldBroadcast && statusChanged) {
      changes.push(...THREAD_STATUS_CHANGE_KINDS);
    }

    this._syncActiveTurnFromEvent(threadId, event);
    if (persistedEvent) {
      this._maybeNotifyParentOnChildTurnCompletion(threadId, persistedEvent);
    }
    if (changes.length > 0) {
      this._enqueueProviderThreadChanged(threadId, changes);
    }
  }

  private _flushQueuedProviderThreadChanged(threadId: string): void {
    const queued = this.queuedProviderBroadcastsByThread.get(threadId);
    if (!queued) return;
    if (queued.timer !== null) {
      clearTimeout(queued.timer);
      queued.timer = null;
    }
    this.queuedProviderBroadcastsByThread.delete(threadId);
    const changes = Array.from(queued.changes);
    if (changes.length === 0) return;
    this._broadcastThreadChanged(threadId, changes);
  }

  private _enqueueProviderThreadChanged(
    threadId: string,
    changes: readonly ThreadChangeKind[],
  ): void {
    const uniqueChanges = Array.from(new Set(changes));
    if (uniqueChanges.length === 0) return;

    let queued = this.queuedProviderBroadcastsByThread.get(threadId);
    if (!queued) {
      queued = {
        changes: new Set<ThreadChangeKind>(),
        timer: null,
      };
      this.queuedProviderBroadcastsByThread.set(threadId, queued);
    }
    for (const change of uniqueChanges) {
      queued.changes.add(change);
    }

    const hasNonEventChange = uniqueChanges.some(
      (change) => change !== "events-appended",
    );
    if (hasNonEventChange) {
      this._flushQueuedProviderThreadChanged(threadId);
      return;
    }

    if (queued.timer !== null) {
      return;
    }
    queued.timer = setTimeout(() => {
      this._flushQueuedProviderThreadChanged(threadId);
    }, PROVIDER_EVENTS_BROADCAST_COALESCE_MS);
    queued.timer.unref?.();
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
    this._cacheProvisioningStateFromEvent(threadId, type, data);
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

  private _threadBuiltInAction(
    id: ThreadBuiltInActionId,
    args: {
      label: string;
      available: boolean;
      disabledReason?: string;
      queuesWhenActive: boolean;
      requiresDemoteFirst: boolean;
    },
  ): ThreadBuiltInAction {
    return {
      id,
      label: args.label,
      available: args.available,
      ...(args.disabledReason ? { disabledReason: args.disabledReason } : {}),
      queuesWhenActive: args.queuesWhenActive,
      requiresDemoteFirst: args.requiresDemoteFirst,
    };
  }

  private _threadActionStatusBlockReason(thread: Thread): string | undefined {
    switch (thread.status) {
      case "idle":
      case "active":
        return undefined;
      case "created":
      case "provisioning":
        return "Thread provisioning is in progress";
      case "provisioning_failed":
        return "Thread provisioning failed; reprovision the thread before requesting actions";
      default:
        return assertNever(thread.status);
    }
  }

  private _buildThreadBuiltInActions(args: {
    thread: Thread;
    environment?: IEnvironment;
    workStatus?: ThreadWorkStatus;
  }): ThreadBuiltInAction[] {
    this._ensurePrimaryPromotionStateIsCurrent(args.thread.projectId);
    const activePromotion = this.primaryPromotionByProjectId.get(args.thread.projectId);
    const primaryCheckoutActive = activePromotion?.threadId === args.thread.id;
    const requiresDemoteFirst = primaryCheckoutActive;
    const archivedReason =
      args.thread.archivedAt !== undefined ? "Archived threads cannot run built-in actions" : undefined;
    const statusReason = archivedReason ?? this._threadActionStatusBlockReason(args.thread);
    const environmentReason = this._restoreEnvironmentUnavailableMessage(args.thread.id);
    const environment = args.environment;
    const workStatus = args.workStatus;
    const isGitWorkspace = Boolean(workStatus && workStatus.state !== "untracked" && workStatus.state !== "deleted");
    const currentBranch = workStatus?.currentBranch;
    const defaultBranch = workStatus?.defaultBranch;

    const commitDisabledReason = (() => {
      if (statusReason) return statusReason;
      if (!environment) return environmentReason;
      if (!isGitWorkspace) return "Commit is only available inside a git repository";
      if (!workStatus?.hasUncommittedChanges) return "No uncommitted changes to commit";
      return undefined;
    })();

    const squashDisabledReason = (() => {
      if (statusReason) return statusReason;
      if (!environment) return environmentReason;
      if (!environment.supportsSquashMergeIntoDefaultBranch()) {
        return "Squash merge is not supported for this environment";
      }
      if (!isGitWorkspace) return "Squash merge is only available inside a git repository";
      if (!currentBranch || !defaultBranch) return "Could not determine the current branch";
      if (currentBranch === defaultBranch) {
        return "Squash merge is only available on non-default branches";
      }
      if (!workStatus?.hasCommittedUnmergedChanges) {
        return "No committed branch changes to merge";
      }
      return undefined;
    })();

    const promoteDisabledReason = (() => {
      if (archivedReason) return archivedReason;
      if (!environment) return environmentReason;
      if (!environment.isIsolatedWorkspace() || !environment.supportsPromoteToActiveWorkspace()) {
        return "Promotion is only available for isolated thread workspaces";
      }
      if (primaryCheckoutActive) {
        return "Primary checkout is already promoted to this thread";
      }
      if (args.thread.status !== "idle") {
        return "Promotion requires an idle thread";
      }
      return undefined;
    })();

    const demoteDisabledReason = (() => {
      if (archivedReason) return archivedReason;
      if (!environment) return environmentReason;
      if (!environment.supportsDemoteFromActiveWorkspace()) {
        return "Demotion is not supported for this environment";
      }
      if (!primaryCheckoutActive) {
        return "Primary checkout is already demoted";
      }
      return undefined;
    })();

    return [
      this._threadBuiltInAction("commit", {
        label: "Commit",
        available: commitDisabledReason === undefined,
        disabledReason: commitDisabledReason,
        queuesWhenActive: true,
        requiresDemoteFirst,
      }),
      this._threadBuiltInAction("squash_merge", {
        label: "Squash merge",
        available: squashDisabledReason === undefined,
        disabledReason: squashDisabledReason,
        queuesWhenActive: true,
        requiresDemoteFirst,
      }),
      this._threadBuiltInAction("promote", {
        label: "Promote",
        available: promoteDisabledReason === undefined,
        disabledReason: promoteDisabledReason,
        queuesWhenActive: false,
        requiresDemoteFirst: false,
      }),
      this._threadBuiltInAction("demote", {
        label: "Demote",
        available: demoteDisabledReason === undefined,
        disabledReason: demoteDisabledReason,
        queuesWhenActive: false,
        requiresDemoteFirst: false,
      }),
    ];
  }

  private _getThreadBuiltInAction(
    thread: Thread,
    actionId: ThreadBuiltInActionId,
  ): ThreadBuiltInAction {
    const hydrated = this._hydrateThreadState(thread);
    const action = hydrated.builtInActions?.find((candidate) => candidate.id === actionId);
    if (action) return action;
    return this._threadBuiltInAction(actionId, {
      label: actionId,
      available: false,
      disabledReason: "Action is unavailable",
      queuesWhenActive: false,
      requiresDemoteFirst: false,
    });
  }

  private _threadHasMeaningfulBranchWork(threadId: string): boolean {
    const events = this.eventRepo.listByThread(threadId);
    return events.some((event) => {
      if (event.type === "system/worktree/commit") {
        const data = toRecord(event.data);
        return getStringField(data, "status") === "committed";
      }
      if (event.type === "system/worktree/squash_merge") {
        const data = toRecord(event.data);
        const status = getStringField(data, "status");
        return status === "merged" || status === "conflict";
      }
      return false;
    });
  }

  private _shouldAutoArchiveThread(args: {
    thread: Thread;
    projectRootPath: string;
    environment: IEnvironment;
    mergeBaseBranch?: string;
    requested?: boolean;
  }): boolean {
    if (args.requested !== true) {
      return false;
    }

    const defaultBranch = detectProjectDefaultBranch(args.projectRootPath);
    const status = args.environment.getWorkspaceStatus({
      defaultBranch,
      mergeBaseBranch: args.mergeBaseBranch,
    });
    if (!status.currentBranch || !status.defaultBranch) {
      return false;
    }
    if (status.currentBranch === status.defaultBranch) {
      return false;
    }

    const hadMeaningfulBranchWork =
      status.behindCount > 0 || this._threadHasMeaningfulBranchWork(args.thread.id);
    if (!hadMeaningfulBranchWork) {
      return false;
    }

    return !status.hasUncommittedChanges && !status.hasCommittedUnmergedChanges;
  }

  private _threadOperationRequestedMessage(operation: ThreadOperationType): string {
    switch (operation) {
      case "commit":
        return "Commit operation requested";
      case "squash_merge":
        return "Squash-merge operation requested";
      default:
        return assertNever(operation);
    }
  }

  private _threadOperationQueuedMessage(operation: ThreadOperationType): string {
    switch (operation) {
      case "commit":
        return "Commit operation queued for deterministic execution";
      case "squash_merge":
        return "Squash-merge operation queued for deterministic execution";
      default:
        return assertNever(operation);
    }
  }

  private _threadOperationRunningMessage(operation: ThreadOperationType): string {
    switch (operation) {
      case "commit":
        return "Running commit operation";
      case "squash_merge":
        return "Running squash-merge operation";
      default:
        return assertNever(operation);
    }
  }

  private _threadOperationAcceptedQueuedMessage(operation: ThreadOperationType): string {
    switch (operation) {
      case "commit":
        return "Commit operation accepted and queued";
      case "squash_merge":
        return "Squash-merge operation accepted and queued";
      default:
        return assertNever(operation);
    }
  }

  private _threadOperationAcceptedRunningMessage(operation: ThreadOperationType): string {
    switch (operation) {
      case "commit":
        return "Commit operation accepted and running";
      case "squash_merge":
        return "Squash-merge operation accepted and running";
      default:
        return assertNever(operation);
    }
  }

  private _appendThreadOperationEvent(
    threadId: string,
    operation: ThreadOperationType,
    status: ThreadEventDataForType<"system/thread_operation">["status"],
    args: {
      message: string;
      operationId?: string;
      demotedPrimaryCheckout?: boolean;
    },
  ): void {
    this._appendEvent(
      threadId,
      "system/thread_operation",
      {
        operation,
        status,
        message: args.message,
        ...(args.operationId ? { operationId: args.operationId } : {}),
        ...(args.demotedPrimaryCheckout !== undefined
          ? { demotedPrimaryCheckout: args.demotedPrimaryCheckout }
          : {}),
      },
      { broadcastChanges: ["events-appended"] },
    );
  }

  private async _runWithPrimaryCheckoutTransitionLock<T>(
    projectId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.primaryCheckoutTransitionsInFlight.has(projectId)) {
      throw invalidRequestError(
        "Another primary-checkout promotion/demotion operation is already in progress for this project",
      );
    }

    this.primaryCheckoutTransitionsInFlight.add(projectId);
    try {
      return await fn();
    } finally {
      this.primaryCheckoutTransitionsInFlight.delete(projectId);
    }
  }

  private _hydrateThreadState(
    thread: Thread,
    opts?: { mergeBaseBranch?: string },
  ): Thread {
    const provisioningState = this._readProvisioningState(thread.id);
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      const hydrated: Thread = provisioningState
        ? {
            ...thread,
            provisioningState,
          }
        : thread;
      return this._withPrimaryCheckoutState(hydrated);
    }

    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment) {
      const hydrated: Thread = {
        ...thread,
        builtInActions: this._buildThreadBuiltInActions({ thread }),
        ...(provisioningState ? { provisioningState } : {}),
      };
      return this._withPrimaryCheckoutState(hydrated);
    }
    if (this._shouldForceDeletedWorkStatus(thread)) {
      const hydrated: Thread = {
        ...thread,
        workStatus: this._buildDeletedWorkStatus(),
        builtInActions: this._buildThreadBuiltInActions({
          thread,
          environment,
          workStatus: this._buildDeletedWorkStatus(),
        }),
        ...(provisioningState ? { provisioningState } : {}),
      };
      return this._withPrimaryCheckoutState(hydrated);
    }
    const defaultBranch = detectProjectDefaultBranch(project.rootPath);
    const workspaceStatus = environment
      ? environment.getWorkspaceStatus({
          defaultBranch,
          mergeBaseBranch: opts?.mergeBaseBranch,
        })
      : this._buildDeletedWorkStatus();
    const hydrated: Thread = {
      ...thread,
      workStatus: { ...workspaceStatus },
      builtInActions: this._buildThreadBuiltInActions({
        thread,
        environment,
        workStatus: workspaceStatus,
      }),
      ...(provisioningState ? { provisioningState } : {}),
    };
    return this._withPrimaryCheckoutState(hydrated);
  }

  private _shouldForceDeletedWorkStatus(thread: Thread): boolean {
    return this.workspaceCleanupInFlightThreadIds.has(thread.id);
  }

  private _buildDeletedWorkStatus(): ThreadWorkStatus {
    return {
      state: "deleted",
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      workspaceChangedFiles: 0,
      workspaceInsertions: 0,
      workspaceDeletions: 0,
      hasUncommittedChanges: false,
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
      behindCount: 0,
    };
  }

  private _withPrimaryCheckoutState(thread: Thread): Thread {
    this._ensurePrimaryPromotionStateIsCurrent(thread.projectId);
    const activePromotion = this.primaryPromotionByProjectId.get(thread.projectId);
    const isActivePrimary = activePromotion?.threadId === thread.id;
    const withPrimaryCheckout = !isActivePrimary
      ? thread
      : {
          ...thread,
          primaryCheckout: {
            isActive: true,
            ...(activePromotion ? { promotedAt: activePromotion.promotedAt } : {}),
          },
        };
    return this._withThreadTitleFallback(withPrimaryCheckout);
  }

  private _withThreadTitleFallback(thread: Thread): Thread {
    if (thread.title) return thread;
    const titleFallback = this._getThreadTitleFallback(thread.id);
    if (!titleFallback) return thread;
    return {
      ...thread,
      titleFallback,
    };
  }

  private _getThreadTitleFallback(threadId: string): string | undefined {
    if (this.titleFallbackByThreadId.has(threadId)) {
      const cached = this.titleFallbackByThreadId.get(threadId);
      return cached ?? undefined;
    }
    const fallback = this._readThreadTitleFallback(threadId);
    this.titleFallbackByThreadId.set(threadId, fallback ?? null);
    return fallback;
  }

  private _readThreadTitleFallback(threadId: string): string | undefined {
    const startEvent = this.eventRepo.getLatestByType(threadId, "client/thread/start");
    if (!startEvent) return undefined;
    const startData = toRecord(startEvent.data);
    return this._derivePromptFallbackTitle(startData?.input);
  }

  private _derivePromptFallbackTitle(input: unknown): string | undefined {
    const firstPromptText = extractFirstPromptText(input);
    if (!firstPromptText) return undefined;
    return this._normalizeThreadTitle(firstPromptText);
  }

  private _readProvisioningState(threadId: string): ThreadProvisioningState | undefined {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    const restoreFailure = this.environmentService.getRestoreFailure(threadId);
    if (restoreFailure) {
      return {
        readiness: "failed",
        message: "Environment restore failed",
        fallbackReason: restoreFailure,
      };
    }
    if (thread.status === "provisioning_failed") {
      return {
        readiness: "failed",
        message: "Provisioning failed",
      };
    }
    if (this.provisioningCompletionStateByThreadId.has(threadId)) {
      return this.provisioningCompletionStateByThreadId.get(threadId) ?? undefined;
    }
    return undefined;
  }

  private _cacheProvisioningStateFromEvent(
    threadId: string,
    type: ThreadEventType,
    data: ThreadEventData,
  ): void {
    if (type === "system/provisioning/completed") {
      const eventData = toRecord(data);
      const fallbackReason = getStringField(eventData, "fallbackReason");
      this.provisioningCompletionStateByThreadId.set(
        threadId,
        fallbackReason
          ? {
              readiness: "degraded",
              message: fallbackReason,
              fallbackReason,
            }
          : {
              readiness: "ready",
            },
      );
      return;
    }
    if (type === "system/provisioning/started") {
      this.provisioningCompletionStateByThreadId.delete(threadId);
    }
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
  ): ThreadEvent {
    if (type === "client/thread/start" && !this.titleFallbackByThreadId.has(threadId)) {
      const fallback = this._derivePromptFallbackTitle(input);
      if (fallback) {
        this.titleFallbackByThreadId.set(threadId, fallback);
      }
    }

    const eventData = this._buildOutboundStartEventData(type, params, input, meta);
    return this._appendEvent(threadId, type, eventData);
  }

  private _buildOutboundStartEventData(
    type: "client/thread/start" | "client/turn/start",
    params: Record<string, unknown>,
    input: PromptInput[] | undefined,
    meta: { source: "spawn" | "tell"; initiator: ThreadTurnInitiator },
  ): ThreadEventData {
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

    return eventData;
  }

  private _amendOutboundStartEvent(
    threadId: string,
    eventId: string | undefined,
    type: "client/thread/start" | "client/turn/start",
    params: Record<string, unknown>,
    input: PromptInput[] | undefined,
    meta: { source: "spawn" | "tell"; initiator: ThreadTurnInitiator },
  ): void {
    if (!eventId) return;
    const eventData = this._buildOutboundStartEventData(type, params, input, meta);
    this.eventRepo.updateData(eventId, eventData);
    this.timelineByThread.delete(threadId);
  }

  private _maybeNotifyParentOnChildTurnCompletion(
    childThreadId: string,
    event: ThreadEvent,
  ): void {
    const eventMethod = resolveProviderEventMethod(event.type, event.data);
    const normalizedType = this.agentServer.normalizeEventType(eventMethod);
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
    const serviceTier = toServiceTier(getStringField(params, "service_tier"));
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
      ...(serviceTier ? { serviceTier } : {}),
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
    _code: number | null,
    _signal: string | null,
  ): void {
    this.agentServer.stopSession(threadId);
    this.eventSeqCounters.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this._cleanupEnvironmentRuntime(threadId);

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

  private _syncStatusFromEvent(
    threadId: string,
    event: AgentServerNotification,
  ): boolean {
    const nextStatus = event.nextStatus;
    if (!nextStatus) return false;
    return this._setThreadStatus(threadId, nextStatus, false);
  }

  private _syncActiveTurnFromEvent(
    threadId: string,
    event: AgentServerNotification,
  ): void {
    const state = event.turnState;
    if (state === "active") {
      const nextEpoch = (this.turnLifecycleEpochs.get(threadId) ?? 0) + 1;
      this.turnLifecycleEpochs.set(threadId, nextEpoch);
      if (event.turnId) {
        this.agentServer.hydrateSessionState(threadId, { activeTurnId: event.turnId });
      }
      return;
    }
    if (state === "idle") {
      this.agentServer.hydrateSessionState(threadId, { activeTurnId: undefined });
    }
  }

  private _syncTitleFromEvent(
    threadId: string,
    event: AgentServerNotification,
  ): boolean {
    const title = event.title;
    if (!title) return false;
    const thread = this.threadRepo.getById(threadId);
    const changed = this._setThreadTitle(threadId, title, {
      // Provider title suggestions should only apply when no title has been set yet.
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
        providerMethod: event.method,
      },
      { broadcastChanges: false },
    );
    return true;
  }

  private _rethrowAgentServerError(threadId: string, error: unknown): never {
    if (!(error instanceof AgentServerSessionError)) {
      throw error;
    }
    switch (error.code) {
      case "inactive_session":
        throw inactiveSessionError(error.message);
      case "no_active_turn":
        throw noActiveTurnError(threadId);
      case "unsupported_operation":
        throw unsupportedOperationError(error.message);
      case "provider_rpc_error":
      case "missing_provider_thread":
        throw providerRpcError(error.message);
      case "provider_timeout":
        throw providerTimeoutError(error.message);
      case "provider_unavailable":
        throw providerUnavailableError(error.message);
      default:
        return assertNever(error.code);
    }
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
    this.titleFallbackByThreadId.delete(threadId);
    if (opts?.shouldBroadcast !== false) {
      this._broadcastThreadChanged(threadId, ["title-changed"]);
    }
    return true;
  }

  private _isPrunableNoiseEventType(normalizedType: string): boolean {
    if (normalizedType.includes("delta")) {
      return true;
    }
    return PRUNABLE_NOISE_EVENT_TYPES.includes(normalizedType);
  }

  private _maybePruneActiveThreadNoise(
    threadId: string,
    normalizedType: string,
    seq: number,
  ): void {
    if (!this._isPrunableNoiseEventType(normalizedType)) {
      return;
    }

    const thread = this.threadRepo.getById(threadId);
    if (!thread || thread.status !== "active" || thread.archivedAt !== undefined) {
      return;
    }

    const lastSeq = this.lastNoisePruneSeqByThread.get(threadId) ?? 0;
    if (seq - lastSeq < ACTIVE_NOISE_PRUNE_MIN_SEQ_DELTA) {
      return;
    }

    const now = Date.now();
    const lastAt = this.lastNoisePruneAtByThread.get(threadId) ?? 0;
    if (now - lastAt < ACTIVE_NOISE_PRUNE_MIN_INTERVAL_MS) {
      return;
    }

    this.lastNoisePruneSeqByThread.set(threadId, seq);
    this.lastNoisePruneAtByThread.set(threadId, now);
    this._pruneHistoricalNoiseEvents(threadId, ACTIVE_NOISE_EVENT_KEEP_RECENT);
  }

  private _pruneHistoricalNoiseEvents(
    threadId: string,
    keepRecent: number = IDLE_NOISE_EVENT_KEEP_RECENT,
  ): void {
    const repoMaintenance = (this.eventRepo as {
      pruneHistoricalNoiseByThread?: (threadId: string, keepRecent?: number) => number;
      reclaimStorageIfNeeded?: (opts?: {
        minFreelistPages?: number;
      }) => {
        ran: boolean;
      };
    }).pruneHistoricalNoiseByThread;
    if (!repoMaintenance) return;
    try {
      const removed = repoMaintenance.call(
        this.eventRepo,
        threadId,
        keepRecent,
      );
      if (removed > 0) {
        this.timelineByThread.delete(threadId);
        const reclaim = (this.eventRepo as {
          reclaimStorageIfNeeded?: (opts?: {
            minFreelistPages?: number;
          }) => {
            ran: boolean;
          };
        }).reclaimStorageIfNeeded;
        reclaim?.call(this.eventRepo, { minFreelistPages: 2_048 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[thread ${threadId}] failed to prune historical noise events: ${message}`);
    }
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
      this._pruneHistoricalNoiseEvents(threadId);
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
    if (nextStatus === "idle") {
      const updatedThread = this.threadRepo.getById(threadId);
      if (updatedThread && updatedThread.archivedAt === undefined) {
        this._scheduleQueuedFollowUpDispatch(threadId);
        this._scheduleQueuedOperationDispatch(threadId);
      }
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

    const thread = this.threadRepo.getById(threadId);
    if (thread?.title) return;

    // Title generation is a one-time attempt bound to the first input for the thread.
    this.autoTitleAttemptedThreadIds.add(threadId);

    const hasTextInput = input.some(
      (chunk) => chunk.type === "text" && chunk.text.trim().length > 0,
    );
    if (!hasTextInput) return;

    void this._runAutogeneratedThreadTitle(threadId, cwd, providerThreadId, input);
  }

  private async _runAutogeneratedThreadTitle(
    threadId: string,
    cwd: string,
    providerThreadId: string,
    input: PromptInput[],
  ): Promise<void> {
    try {
      const generatedTitle = await this.llmCompletionService.generateThreadTitle({
        input,
        cwd,
      });
      if (!generatedTitle) return;

      const threadBeforeUpdate = this.threadRepo.getById(threadId);
      if (!threadBeforeUpdate) return;

      const fallbackTitle =
        this.agentServer.deriveThreadTitle(input) ?? this._derivePromptFallbackTitle(input);
      if (
        threadBeforeUpdate.title &&
        (
          !fallbackTitle ||
          threadBeforeUpdate.title !== fallbackTitle
        )
      ) {
        return;
      }

      const changed = this._setThreadTitle(threadId, generatedTitle, {
        onlyIfMissing: false,
      });
      if (!changed) return;

      this.lockedTitleThreadIds.add(threadId);
      this._sendThreadNameSet(threadId, providerThreadId, generatedTitle);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown title generation error";
      console.error(
        `[thread ${threadId}] Failed to auto-generate title (${this.llmCompletionService.displayName}): ${message}`,
      );
    }
  }

  private _sendThreadNameSet(
    threadId: string,
    _providerThreadId: string,
    title: string,
  ): void {
    this.agentServer.renameSession(threadId, title);
  }

  private _normalizeThreadTitle(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;

    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    if (normalized.length <= 60) return normalized;
    return `${normalized.slice(0, 57).trimEnd()}...`;
  }

  private _normalizePromptInputForProvider(input: PromptInput[]): PromptInput[] {
    return this.agentServer.normalizePromptInput(input);
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
      const normalizedType = this.agentServer.normalizeEventType(method);
      const state = toTurnLifecycleState(normalizedType);
      if (state) return state;
    }
    return undefined;
  }

}
