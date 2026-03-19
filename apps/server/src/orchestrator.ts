import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertNever,
  createProviderEventEnvelope,
  DEFAULT_THREAD_PROVIDER_ID,
  decodeProviderEventEnvelope,
  extractProviderThreadIdFromPersistedEventData,
  extractTurnIdFromPersistedEventData,
  formatEnvironmentDisplayName,
  getStringField,
  isThreadProviderId,
  resolveProviderEventMethod,
  buildThreadDetailRows,
  extractThreadContextWindowUsage,
  toRecord,
  toUIMessages,
  unwrapProviderEventPayload,
  type AvailableModel,
  type EnvironmentCreationArgs,
  type EnvironmentDescriptor,
  type EnvironmentProvisioningEvent,
  type ProviderAdapter,
  type ProviderExecutionOptions,
  type ProviderThreadContext,
  type ProviderToolCallRequest,
  type ProviderToolCallResponse,
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
  type PromotePrimaryCheckoutResponse,
  type ProvisioningTranscriptEntry,
  type CommitEnvironmentOperationResponse,
  type DemotePrimaryCheckoutResponse,
  type EnvironmentOperationRequest,
  type EnvironmentOperationResponse,
  type EnvironmentOperationFailureDetails,
  type EnqueueThreadMessageRequest,
  type PrimaryCheckoutStatus,
  type ReasoningLevel,
  type SandboxMode,
  type SendQueuedThreadMessageRequest,
  type SendQueuedThreadMessageResponse,
  type SquashMergeEnvironmentOperationResponse,
  type ThreadTimelineResponse,
  type ThreadType,
  type ThreadGitDiffResponse,
  type ThreadGitDiffSelection,
  type ThreadQueuedMessage,
  type ThreadToolGroupMessagesRequest,
  type ThreadToolGroupMessagesResponse,
  type ThreadChangeKind,
  type ThreadProvisioningReason,
  type ThreadProvisioningProgressPhase,
  type ThreadEnvironmentStartReason,
  type ThreadProviderId,
} from "@bb/core";
import { resolveBbPath } from "@bb/core/storage-paths";
import { renderTemplate } from "@bb/templates";
import {
  EnvironmentRegistry,
  EnvironmentSquashMergeCommitFailureError,
  createDefaultEnvironmentRegistry,
  listGitWorkspaceMergeBaseBranchesAsync,
  type CreateEnvironmentContext,
  type EnvironmentCommitSummary,
  type EnvironmentSquashMergeMessageContext,
  type IEnvironment,
} from "@bb/environment";
import type {
  EnvironmentDaemonClient,
  EnvironmentDaemonConnectionTarget,
} from "@bb/environment-daemon";
import type {
  EnvironmentDaemonEventEnvelope,
  EnvironmentDaemonStatusSnapshot,
} from "@bb/environment-daemon";
import { ENVIRONMENT_DAEMON_PROTOCOL_VERSION } from "@bb/environment-daemon";
import type {
  DbConnection,
  EnvironmentDaemonSessionCloseReason,
  EnvironmentRepository,
  ThreadRepository,
  ThreadEnvironmentAttachmentRepository,
  EventRepository,
  ProjectRepository,
  EnvironmentDaemonSessionRepository,
} from "@bb/db";

type DbExecutor = Pick<DbConnection, "select" | "insert" | "update" | "delete">;
import {
  type LlmCommitMessageGenerationArgs,
  type LlmCompletionService,
  type ProviderToolHost,
  createProviderAdapter,
} from "@bb/provider-adapters";
import { WSManager } from "./ws.js";
import {
  ProviderSessionController,
  type ProviderSessionNotification,
  ProviderSessionError,
} from "./provider-session-controller.js";
import {
  DomainError,
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
import {
  EnvironmentFactory,
} from "./env-factory.js";
import {
  listBuiltInProvisioningSystemInfos,
  resolveProvisioningSelection,
} from "./environment-provisioning-systems.js";
import {
  EnvironmentDaemonCommandDispatcher,
  isEnvironmentDaemonSessionUnavailableError,
} from "./environment-daemon-command-dispatcher.js";
import type { EnvironmentDaemonSessionService } from "./environment-daemon-session-service.js";
import { EnvironmentDaemonSessionCommandClient } from "./environment-daemon-session-command-client.js";
import {
  reconcileManagedArtifactStorage,
  resolveArchivedEnvironmentDaemonLogRetentionMs,
} from "./managed-artifact-reconciler.js";
import { canTransitionThreadStatus } from "./thread-status-machine.js";
import {
  detectProjectDefaultBranch,
  detectProjectDefaultBranchAsync,
} from "./git-project.js";
import {
  EnvironmentService,
  type ActiveEnvironmentRuntime,
  type PrimaryPromotionState,
} from "./environment-service.js";
import {
  MANAGER_PREFERENCES_CONTENT_PLACEHOLDER,
  MANAGER_THREAD_ID_PLACEHOLDER,
  MANAGER_WORKSPACE_PATH_PLACEHOLDER,
  PROJECT_ID_PLACEHOLDER,
  PROJECT_NAME_PLACEHOLDER,
  PROJECT_ROOT_PATH_PLACEHOLDER,
  resolveManagerWorkspacePath,
} from "./manager-thread.js";
import { measureAsync, measureSync } from "./perf.js";

export type PromptExecutionOptions = ProviderExecutionOptions;

const BB_ENV_DAEMON_COMMAND_POLL_INTERVAL_MS =
  "BB_ENV_DAEMON_COMMAND_POLL_INTERVAL_MS";
const MODEL_LIST_CACHE_TTL_MS = 60_000;
const ENVIRONMENT_DAEMON_SESSION_RECOVERY_WAIT_MS = 1_000;
const ENVIRONMENT_DAEMON_SESSION_RECOVERY_RETRY_WAIT_MS = 5_000;

function parsePositiveIntegerEnv(
  rawValue: string | undefined,
): number | undefined {
  if (!rawValue) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

interface TellContext {
  initiator: ThreadTurnInitiator;
  awaitProviderStart: boolean;
}

interface ThreadTimelineCacheEntry {
  latestSeq: number;
  threadStatus: Thread["status"] | undefined;
  byRequestKey: Map<string, ThreadTimelineResponse>;
}

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

function resolveCliServerUrl(rawUrl: string | undefined): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/api\/v1\/?$/u, "");
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

  const shimBinDir = join(tmpdir(), "bb", "bin");
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

async function getEnvironmentCheckoutSummary(environment: IEnvironment): Promise<{
  branchName?: string;
  headSha?: string;
}> {
  try {
    const checkout = await environment.getCheckoutSnapshot();
    return {
      ...(checkout.branch?.trim() ? { branchName: checkout.branch.trim() } : {}),
      ...(checkout.head?.trim() ? { headSha: checkout.head.trim() } : {}),
    };
  } catch {
    try {
      const status = await environment.getWorkspaceStatus();
      const branchName = status.currentBranch?.trim();
      return branchName && branchName.length > 0 ? { branchName } : {};
    } catch {
      return {};
    }
  }
}

function createProvisioningTranscriptEntry(args: {
  key: string;
  text: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
}): ProvisioningTranscriptEntry {
  return {
    key: args.key,
    text: args.text,
    ...(args.metadata ? { metadata: args.metadata } : {}),
    ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {}),
  };
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    const seconds = durationMs / 1000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  return `${durationMs}ms`;
}

function createEnvironmentProvisioningTranscript(args: {
  environmentDisplayName: string;
  attachedEnvironmentId?: string;
  createdWorktree: boolean;
}): ProvisioningTranscriptEntry[] {
  const displayName =
    formatEnvironmentDisplayName({ displayName: args.environmentDisplayName }) ??
    args.environmentDisplayName;
  const transcript: ProvisioningTranscriptEntry[] = [
    createProvisioningTranscriptEntry({
      key: "environment",
      text: `environment: ${displayName}`,
      metadata: {
        environmentDisplayName: args.environmentDisplayName,
        ...(args.attachedEnvironmentId
          ? { attachedEnvironmentId: args.attachedEnvironmentId }
          : {}),
      },
    }),
  ];
  if (args.createdWorktree) {
    transcript.push(
      createProvisioningTranscriptEntry({
        key: "worktree",
        text: "creating worktree",
      }),
    );
  }
  return transcript;
}

function createProvisioningBranchTranscriptEntry(args: {
  branchName?: string;
  headSha?: string;
  checkedOutBranch: boolean;
}): ProvisioningTranscriptEntry | undefined {
  const branchName = args.branchName?.trim();
  const shortSha = args.headSha?.trim().slice(0, 7);
  if (!branchName && !shortSha) return undefined;

  if (branchName && shortSha) {
    return createProvisioningTranscriptEntry({
      key: "branch",
      text: args.checkedOutBranch
        ? `checked out branch ${branchName} (${shortSha})`
        : `on branch ${branchName} (${shortSha})`,
      metadata: {
        branchName,
        headSha: args.headSha,
      },
    });
  }
  if (branchName) {
    return createProvisioningTranscriptEntry({
      key: "branch",
      text: args.checkedOutBranch ? `checked out branch ${branchName}` : `on branch ${branchName}`,
      metadata: { branchName },
    });
  }
  return createProvisioningTranscriptEntry({
    key: "branch",
    text: args.checkedOutBranch ? `checked out commit ${shortSha}` : `on commit ${shortSha}`,
    metadata: args.headSha ? { headSha: args.headSha } : undefined,
  });
}

function createProvisioningProgressTranscriptEntry(args: {
  phase: ThreadProvisioningProgressPhase;
  status: "started" | "completed" | "failed";
  startedAt: number;
  durationMs?: number;
}): ProvisioningTranscriptEntry | undefined {
  switch (args.phase) {
    case "prepare_environment":
      return undefined;
    case "start_provider_session": {
      const durationText =
        args.durationMs !== undefined ? ` in ${formatDuration(args.durationMs)}` : "";
      const text =
        args.status === "started"
          ? "starting provider session"
          : args.status === "completed"
            ? `started provider session${durationText}`
            : `provider session start failed${durationText}`;
      return createProvisioningTranscriptEntry({
        key: "phase:start_provider_session",
        text,
        metadata: {
          phase: args.phase,
          status: args.status,
          ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
        },
        ...(args.status === "started" ? { startedAt: args.startedAt } : {}),
      });
    }
    default:
      return assertNever(args.phase);
  }
}

function createProvisioningSetupTranscriptEntry(args: {
  status: "started" | "running" | "completed" | "failed";
  scriptPath: string;
  startedAt: number;
  durationMs?: number;
  output?: string;
}): ProvisioningTranscriptEntry {
  const durationText =
    args.durationMs !== undefined ? ` in ${formatDuration(args.durationMs)}` : "";
  const text =
    args.status === "started" || args.status === "running"
      ? `running ${args.scriptPath}`
      : args.status === "completed"
        ? `ran ${args.scriptPath}${durationText}`
        : `setup script failed: ${args.scriptPath}${durationText}`;
  return createProvisioningTranscriptEntry({
    key: "setup",
    text,
    metadata: {
      status: args.status,
      scriptPath: args.scriptPath,
      ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
      ...(args.output ? { output: args.output } : {}),
    },
    ...((args.status === "started" || args.status === "running")
      ? { startedAt: args.startedAt }
      : {}),
  });
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
  private readonly envFactory: EnvironmentFactory;
  private managedArtifactReconcileInFlight: Promise<void> | null = null;
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
  /** Per-thread mutex for serializing _tell calls. */
  private tellInFlightByThreadId = new Map<string, Promise<void>>();
  /** Last known active turn id derived from delivered provider lifecycle events. */
  private activeTurnIdByThreadId = new Map<string, string>();
  /** Turn ids explicitly interrupted by the user; late events for them must be dropped. */
  private suppressedTurnIdsByThreadId = new Map<string, Set<string>>();
  /** After stop(), all late provider notifications are dropped until a new outbound turn starts. */
  private blockedProviderNotificationsByThreadId = new Set<string>();
  /** Provider thread ids attached in the current server process. */
  private providerThreadIdByThreadId = new Map<string, string>();
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
  /** Tracks threads whose workspace deletion is in progress. */
  private workspaceCleanupInFlightThreadIds: Set<string>;
  private readonly agentServerByProviderId = new Map<
    ThreadProviderId,
    ProviderSessionController
  >();
  private readonly providerAdapterByProviderId = new Map<
    ThreadProviderId,
    ProviderAdapter
  >();
  private readonly defaultProviderId: ThreadProviderId;
  private readonly providerCatalog: SystemProviderInfo[];
  private readonly providerToolHost?: ProviderToolHost;
  private readonly cachedModelsByRequestKey = new Map<
    string,
    { expiresAt: number; value: AvailableModel[] }
  >();
  private readonly pendingModelsRequestByRequestKey = new Map<
    string,
    Promise<AvailableModel[]>
  >();
  private threadShellPath: string | undefined;
  private environmentCatalog: SystemEnvironmentInfo[];
  private environmentDaemonCommandPollIntervalMs: number | undefined;

  private get agentServer(): ProviderSessionController {
    const server = this.agentServerByProviderId.get(this.defaultProviderId);
    if (!server) {
      throw new Error(`Missing agent server for provider "${this.defaultProviderId}"`);
    }
    return server;
  }

  constructor(
    private threadRepo: ThreadRepository,
    private eventRepo: EventRepository,
    private projectRepo: ProjectRepository,
    private ws: WSManager,
    private llmCompletionService: LlmCompletionService,
    agentServerOrProvider?: ProviderSessionController | ProviderAdapter,
    private runtimeEnv: NodeJS.ProcessEnv = process.env,
    private environmentRegistry: EnvironmentRegistry = createDefaultEnvironmentRegistry(),
    providerCatalog?: SystemProviderInfo[],
    environmentCatalog?: SystemEnvironmentInfo[],
    private scheduler: SchedulerService = new InMemorySchedulerService(),
    private environmentDaemonCommandDispatcher?: EnvironmentDaemonCommandDispatcher,
    private environmentDaemonSessionService?: EnvironmentDaemonSessionService,
    private environmentDaemonSessionRepo?: EnvironmentDaemonSessionRepository,
    private environmentRepo?: EnvironmentRepository,
    private threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository,
    providerToolHost?: ProviderToolHost,
  ) {
    this.envFactory = new EnvironmentFactory(
      this.environmentRepo,
      this.threadEnvironmentAttachmentRepo,
    );
    this.threadShellPath = resolveThreadShellPath(this.runtimeEnv.PATH);
    this.environmentDaemonCommandPollIntervalMs = parsePositiveIntegerEnv(
      this.runtimeEnv[BB_ENV_DAEMON_COMMAND_POLL_INTERVAL_MS],
    );
    this.environmentCatalog =
      environmentCatalog ??
      listBuiltInProvisioningSystemInfos();
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
        onCleanupFailure: (threadId, environmentKind, error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(
            `[thread ${threadId}] environment cleanup failed (${environmentKind}): ${message}`,
          );
          this._appendEvent(
            threadId,
            "system/provisioning/cleanup_failed",
            {
              message: "Environment cleanup failed",
              detail: message,
            },
            { broadcastChanges: ["events-appended"] },
          );
        },
        onPrimaryCheckoutDemoted: ({ projectId, threadId, currentCheckout }) => {
          this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
        },
        runOptionalSetup: (threadId, environment, projectRootPath, reason) =>
          this._runOptionalEnvironmentSetup(
            threadId,
            environment,
            projectRootPath,
            reason,
          ),
        ensureManagedEnvironmentArtifacts: ({ environmentId, projectRootPath }) =>
          this.envFactory.ensureManagedEnvironmentArtifacts({
            environmentId,
            projectRootPath,
            runtimeEnv: this.runtimeEnv,
          }),
        cleanupManagedEnvironmentArtifacts: ({ environmentId, projectRootPath }) =>
          this.envFactory.cleanupManagedEnvironmentArtifacts({
            environmentId,
            projectRootPath,
            runtimeEnv: this.runtimeEnv,
          }),
      },
      this.environmentRepo,
      this.threadEnvironmentAttachmentRepo,
    );
    this.primaryPromotionByProjectId = this.environmentService.primaryPromotionByProjectId;
    this.primaryPromotionValidatedAtByProjectId =
      this.environmentService.primaryPromotionValidatedAtByProjectId;
    this.primaryPromotionWatchersByProjectId =
      this.environmentService.primaryPromotionWatchersByProjectId;
    this.workspaceCleanupInFlightThreadIds =
      this.environmentService.workspaceCleanupInFlightThreadIds;
    this.providerCatalog = providerCatalog ?? [];
    this.providerToolHost = providerToolHost;
    const provider =
      agentServerOrProvider instanceof ProviderSessionController
        ? undefined
        : agentServerOrProvider;
    if (agentServerOrProvider instanceof ProviderSessionController) {
      const providerId = agentServerOrProvider.provider.id;
      this.defaultProviderId = providerId;
      this.agentServerByProviderId.set(providerId, agentServerOrProvider);
    } else {
      const providerAdapter = provider ?? createProviderAdapter();
      this.defaultProviderId = providerAdapter.id;
      this.providerAdapterByProviderId.set(this.defaultProviderId, providerAdapter);
      this.agentServerByProviderId.set(this.defaultProviderId, new ProviderSessionController({
        provider: providerAdapter,
        ...(this.providerToolHost
          ? {
              resolveDynamicTools: () => this.providerToolHost?.listTools(),
              toolHost: this.providerToolHost,
            }
          : {}),
        onNotification: (threadId, event) => {
          this._handleAgentServerNotification(threadId, event);
        },
        logger: console,
      }));
    }
  }

  /**
   * Startup only reconstructs minimal server state:
   * - finalize archived environments that still claim persisted resources
   * - leave non-archived environments to reconnect or restart lazily on demand
   */
  async cleanupArchivedEnvironmentsOnBoot(): Promise<void> {
    const archivedThreadIds =
      this.threadRepo.listArchivedIdsWithEnvironmentRecord();
    for (const threadId of archivedThreadIds) {
      this._destroyEnvironmentRuntime(threadId);
    }
  }

  async failInterruptedProvisioningOnBoot(): Promise<void> {
    const interruptedProvisioningThreadIds =
      this.threadRepo.listNonArchivedIdsByStatuses(["provisioning", "provisioned"]);
    for (const threadId of interruptedProvisioningThreadIds) {
      const thread = this.threadRepo.getById(threadId);
      if (!thread || thread.archivedAt !== undefined) {
        continue;
      }

      const statusChanged = this._setThreadStatus(
        threadId,
        "provisioning_failed",
        false,
      );
      const message =
        thread.status === "provisioned"
          ? "Server restart interrupted provider bootstrap before the thread became active."
          : "Server restart interrupted environment provisioning before provider bootstrap completed.";
      this._appendEvent(
        threadId,
        "system/error",
        {
          code: "provider_unavailable",
          message,
        },
        { broadcastChanges: false },
      );
      if (thread.status === "provisioned") {
        const envIdForRetire = this.threadEnvironmentAttachmentRepo?.getByThreadId(threadId)?.environmentId;
        if (envIdForRetire && !this.environmentService.hasSharedAttachedEnvironment(threadId)) {
          this.environmentDaemonSessionService?.retireActiveSessionForEnvironment({
            environmentId: envIdForRetire,
            reason: "migration",
          });
        }
      }
      this._broadcastThreadChanged(
        threadId,
        statusChanged
          ? [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]
          : ["events-appended"],
      );
    }
  }

  async reconcileManagedArtifacts(): Promise<void> {
    if (this.managedArtifactReconcileInFlight) {
      return this.managedArtifactReconcileInFlight;
    }

    const task = this._reconcileManagedArtifactsInternal().finally(() => {
      if (this.managedArtifactReconcileInFlight === task) {
        this.managedArtifactReconcileInFlight = null;
      }
    });
    this.managedArtifactReconcileInFlight = task;
    return task;
  }

  private async _reconcileManagedArtifactsInternal(): Promise<void> {
    const now = Date.now();
    const archivedLogRetentionMs =
      resolveArchivedEnvironmentDaemonLogRetentionMs(this.runtimeEnv);
    const threads = this.threadRepo.listManagedArtifactRetentionRecords({
      archivedLogCutoff: now - archivedLogRetentionMs,
    });
    const projects = this.projectRepo.list();
    const result = reconcileManagedArtifactStorage({
      threads,
      ...(this.environmentRepo
        ? { environments: this.environmentRepo.list() }
        : {}),
      ...(this.threadEnvironmentAttachmentRepo
        ? { environmentAttachments: this.threadEnvironmentAttachmentRepo.list() }
        : {}),
      projects,
      runtimeEnv: this.runtimeEnv,
      now,
      archivedLogRetentionMs,
    });

    if (
      result.removedLogArtifacts > 0 ||
      result.removedWorkspaceDirectories > 0
    ) {
      console.log(
        `Managed artifact cleanup removed ${result.removedLogArtifacts} log sets and ${result.removedWorkspaceDirectories} workspace directories.`,
      );
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

  private async _refreshPrimaryPromotionSnapshotAfterEnvironmentMutation(
    thread: Thread,
    environment: IEnvironment,
  ): Promise<void> {
    const active = this.primaryPromotionByProjectId.get(thread.projectId);
    const threadEnvironmentId = this._resolveThreadEnvironmentReference(thread.id);
    if (!active || !threadEnvironmentId || active.environmentId !== threadEnvironmentId) {
      return;
    }

    try {
      const promotedCheckout = await environment.getCheckoutSnapshot();
      this._setPrimaryPromotionState(thread.projectId, {
        ...active,
        promotedCheckout,
      });
      this.primaryPromotionValidatedAtByProjectId.set(thread.projectId, Date.now());
    } catch {
      // Keep the existing promotion state if the checkout snapshot cannot be refreshed.
    }
  }

  private _getDefaultAgentServer(): ProviderSessionController {
    return this._getAgentServerForProviderId(this.defaultProviderId);
  }

  private _requireBuiltInProviderId(providerId: string): ThreadProviderId {
    if (isThreadProviderId(providerId)) {
      return providerId;
    }
    throw new Error(`Unsupported provider "${providerId}"`);
  }

  private _getAgentServerForProviderId(
    providerId: string,
  ): ProviderSessionController {
    const builtInProviderId = this._requireBuiltInProviderId(providerId);
    const existing = this.agentServerByProviderId.get(builtInProviderId);
    if (existing) {
      return existing;
    }

    const provider = this._getProviderAdapterForProviderId(builtInProviderId);
    const server = new ProviderSessionController({
      provider,
      ...(this.providerToolHost
        ? {
            // Gate manager-only tools: only expose message_user for manager threads.
            // Standard threads only get user-registered dynamic tools (if any).
            resolveDynamicTools: ({ request }: { request: SpawnThreadRequest }) =>
              request.type === "manager"
                ? this.providerToolHost?.listTools()
                : undefined,
            toolHost: this.providerToolHost,
          }
        : {}),
      onNotification: (threadId, event) => {
        this._handleAgentServerNotification(threadId, event);
      },
      logger: console,
    });
    this.agentServerByProviderId.set(builtInProviderId, server);
    return server;
  }

  private _getProviderAdapterForProviderId(providerId: string): ProviderAdapter {
    const builtInProviderId = this._requireBuiltInProviderId(providerId);
    const existing = this.providerAdapterByProviderId.get(builtInProviderId);
    if (existing) {
      return existing;
    }
    const provider = createProviderAdapter({ providerId: builtInProviderId });
    this.providerAdapterByProviderId.set(builtInProviderId, provider);
    return provider;
  }

  private _getAgentServerForThread(thread: Thread): ProviderSessionController {
    return this._getAgentServerForProviderId(thread.providerId);
  }

  private _getAgentServerForThreadId(threadId: string): ProviderSessionController {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    return this._getAgentServerForThread(thread);
  }

  private _getAgentServerForThreadIdOrDefault(
    threadId: string,
  ): ProviderSessionController {
    const thread = this.threadRepo.getById(threadId);
    return thread ? this._getAgentServerForThread(thread) : this._getDefaultAgentServer();
  }

  private _clearAgentServerSessionState(threadId: string): void {
    for (const agentServer of this.agentServerByProviderId.values()) {
      agentServer.clearSessionState(threadId);
    }
  }

  private _resolveSpawnProviderId(req: SpawnThreadRequest): ThreadProviderId {
    // 1. Explicit providerId in request
    if (req.providerId && isThreadProviderId(req.providerId)) {
      return req.providerId;
    }
    // 2. Project default
    const project = this.projectRepo.getById(req.projectId);
    if (project?.defaultProviderId && isThreadProviderId(project.defaultProviderId)) {
      return project.defaultProviderId;
    }
    // 3. System default (first available in order: codex -> claude-code -> pi)
    return this.defaultProviderId;
  }

  private _resolveEnvironmentSelection(args: {
    projectId: string;
    environmentId?: string;
    environmentDescriptor?: EnvironmentDescriptor;
    environmentCreationArgs?: EnvironmentCreationArgs;
  }): ReturnType<typeof resolveProvisioningSelection> {
    const project = this.projectRepo.getById(args.projectId);
    if (!project) {
      throw projectNotFoundError(args.projectId);
    }

    try {
      return resolveProvisioningSelection({
        projectId: args.projectId,
        projectRootPath: project.rootPath,
        environmentId: args.environmentId,
        environmentDescriptor: args.environmentDescriptor,
        environmentCreationArgs: args.environmentCreationArgs,
        environmentRepo: this.environmentRepo,
        threadEnvironmentAttachmentRepo: this.threadEnvironmentAttachmentRepo,
        normalizeRuntimeKind: (value?: string) => this._normalizeRuntimeEnvironmentKind(value),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message === "First-class environment attachments are unavailable" ||
        message.startsWith("Environment not found: ")
      ) {
        throw invalidRequestError(message);
      }
      throw error;
    }
  }

  private _resolveProvisioningPresentation(args: {
    attachedEnvironmentId?: string;
    fallbackDisplayName: string;
  }): {
    environmentDisplayName: string;
    createdWorktree: boolean;
  } {
    const attachedEnvironmentId = args.attachedEnvironmentId?.trim();
    if (!attachedEnvironmentId || !this.environmentRepo) {
      return {
        environmentDisplayName: args.fallbackDisplayName,
        createdWorktree: false,
      };
    }
    const attachedEnvironment = this.environmentRepo.getById(attachedEnvironmentId);
    if (!attachedEnvironment) {
      return {
        environmentDisplayName: args.fallbackDisplayName,
        createdWorktree: false,
      };
    }
    return {
      environmentDisplayName:
        attachedEnvironment.properties?.location === "docker"
          ? "Docker Sandbox"
          : attachedEnvironment.properties?.workspaceKind === "worktree"
            ? "Git Worktree Workspace"
            : args.fallbackDisplayName,
      createdWorktree:
        attachedEnvironment.managed &&
        attachedEnvironment.properties?.provisioningSystemKind === "worktree",
    };
  }

  private _usesManagedWorktreeProvisioning(args: {
    attachedEnvironmentId?: string;
  }): boolean {
    return this._resolveProvisioningPresentation({
      attachedEnvironmentId: args.attachedEnvironmentId,
      fallbackDisplayName: "Direct Workspace",
    }).createdWorktree;
  }

  private _resolveThreadEnvironmentReference(threadId: string): string | undefined {
    if (this.threadEnvironmentAttachmentRepo) {
      return this.threadEnvironmentAttachmentRepo.getByThreadId(threadId)?.environmentId;
    }
    return this.threadRepo.getById(threadId)?.environmentId;
  }

  private _getThreadsAttachedToEnvironment(environmentId: string): Thread[] {
    const attachedThreadIds = this.threadEnvironmentAttachmentRepo
      ? this.threadEnvironmentAttachmentRepo
          .listByEnvironmentId(environmentId)
          .map((attachment) => attachment.threadId)
      : this.threadRepo.list()
          .filter((thread) => thread.environmentId === environmentId)
          .map((thread) => thread.id);
    return attachedThreadIds
      .map((threadId) => this.threadRepo.getById(threadId))
      .filter((thread): thread is Thread => Boolean(thread));
  }

  private _getNonArchivedThreadsAttachedToEnvironment(environmentId: string): Thread[] {
    return this._getThreadsAttachedToEnvironment(environmentId)
      .filter((thread) => thread.archivedAt === undefined);
  }

  private _resolveEnvironmentCommandTransportThread(args: {
    environmentId: string;
    providerId?: string;
  }): Thread | undefined {
    const attachedThreads = this._getNonArchivedThreadsAttachedToEnvironment(args.environmentId);
    if (attachedThreads.length === 0) {
      return undefined;
    }
    if (args.providerId) {
      const matchingThreads = attachedThreads.filter(
        (thread) => thread.providerId === args.providerId,
      );
      if (matchingThreads.length === 1) {
        return matchingThreads[0];
      }
      if (matchingThreads.length > 1) {
        throw invalidRequestError(
          `Environment ${args.environmentId} has multiple attached threads for provider ${args.providerId}`,
        );
      }
      throw invalidRequestError(
        `Environment ${args.environmentId} has no attached thread for provider ${args.providerId}`,
      );
    }
    if (attachedThreads.length === 1) {
      return attachedThreads[0];
    }
    throw invalidRequestError(
      `Environment ${args.environmentId} has multiple attached threads; explicit provider routing is required`,
    );
  }

  private _resolveEnvironmentSessionTransportThread(
    environmentId: string,
  ): Thread | undefined {
    return this._getNonArchivedThreadsAttachedToEnvironment(environmentId)[0];
  }

  private _isThreadAttachedToPromotedEnvironment(threadId: string): boolean {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      return false;
    }
    this._ensurePrimaryPromotionStateIsCurrent(thread.projectId);
    const activePromotion = this.primaryPromotionByProjectId.get(thread.projectId);
    if (!activePromotion) {
      return false;
    }
    return this._resolveThreadEnvironmentReference(threadId) === activePromotion.environmentId;
  }

  private _hasIsolatedThreadWorkspace(thread: Thread): boolean {
    const attachedEnvironmentId =
      this.threadEnvironmentAttachmentRepo?.getByThreadId(thread.id)?.environmentId ??
      thread.attachedEnvironment?.id;
    if (!attachedEnvironmentId || !this.environmentRepo) {
      return false;
    }
    const attachedEnvironment = this.environmentRepo.getById(attachedEnvironmentId);
    if (!attachedEnvironment?.properties) {
      return false;
    }
    return (
      attachedEnvironment.properties.location === "docker" ||
      attachedEnvironment.properties.workspaceKind === "worktree"
    );
  }

  private _resolveRequestedThreadType(req: SpawnThreadRequest): ThreadType {
    return req.type ?? "standard";
  }

  private _validateManagerParentThread(args: {
    projectId: string;
    parentThreadId: string;
    childThreadId?: string;
  }): void {
    const parentThread = this.threadRepo.getById(args.parentThreadId);
    if (!parentThread) {
      throw invalidRequestError(`Parent thread not found: ${args.parentThreadId}`);
    }
    if (args.childThreadId && args.parentThreadId === args.childThreadId) {
      throw invalidRequestError("Thread cannot manage itself");
    }
    if (parentThread.projectId !== args.projectId) {
      throw invalidRequestError("Parent thread must belong to the same project");
    }
    if (parentThread.type !== "manager") {
      throw invalidRequestError("Parent thread must be a manager thread");
    }
    if (parentThread.archivedAt !== undefined) {
      throw invalidRequestError("Parent thread cannot be archived");
    }
  }

  private _stopAllPrimaryPromotionWatches(): void {
    this.environmentService.stopAllPrimaryPromotionWatches();
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

    const threadType = this._resolveRequestedThreadType(req);
    if (threadType === "manager" && req.parentThreadId) {
      throw invalidRequestError("Manager threads cannot be managed by a parent thread");
    }
    if (req.parentThreadId) {
      this._validateManagerParentThread({
        projectId: req.projectId,
        parentThreadId: req.parentThreadId,
      });
    }

    // Create thread record in DB
    const explicitTitle = this._normalizeThreadTitle(req.title);
    const effectiveEnvironmentRequest =
      req.environmentId || req.environmentDescriptor || req.environmentCreationArgs
        ? req
        : req.parentThreadId
          ? {
              ...req,
              environmentCreationArgs: { kind: "worktree" },
            }
          : {
              ...req,
              environmentDescriptor: {
                type: "path" as const,
                path: project.rootPath,
              },
            };
    const { attachedEnvironmentId } = this._resolveEnvironmentSelection({
      projectId: req.projectId,
      environmentId: effectiveEnvironmentRequest.environmentId,
      environmentDescriptor: effectiveEnvironmentRequest.environmentDescriptor,
      environmentCreationArgs: effectiveEnvironmentRequest.environmentCreationArgs,
    });
    const providerId = this._resolveSpawnProviderId(req);
    const thread = this.threadRepo.create({
      projectId: req.projectId,
      providerId,
      type: threadType,
      ...(explicitTitle ? { title: explicitTitle } : {}),
      ...(attachedEnvironmentId && !this.threadEnvironmentAttachmentRepo
        ? { environmentId: attachedEnvironmentId }
        : {}),
      ...(req.parentThreadId ? { parentThreadId: req.parentThreadId } : {}),
    });
    if (explicitTitle) {
      this.lockedTitleThreadIds.add(thread.id);
    }
    if (attachedEnvironmentId && this.threadEnvironmentAttachmentRepo) {
      this.threadEnvironmentAttachmentRepo.attachThread({
        threadId: thread.id,
        environmentId: attachedEnvironmentId,
      });
    }
    const persistedThread = this.threadRepo.getById(thread.id) ?? thread;

    const provisioningRequest =
      threadType === "manager" &&
      req.developerInstructions &&
      (req.developerInstructions.includes(MANAGER_WORKSPACE_PATH_PLACEHOLDER) ||
        req.developerInstructions.includes(MANAGER_PREFERENCES_CONTENT_PLACEHOLDER))
        ? {
            ...req,
            developerInstructions: (() => {
              const workspacePath = resolveManagerWorkspacePath(this.runtimeEnv, thread.id);
              const preferencesPath = join(workspacePath, "PREFERENCES.md");
              const preferencesContent = existsSync(preferencesPath)
                ? readFileSync(preferencesPath, "utf8")
                : "(does not exist)";
              const project = this.projectRepo.getById(req.projectId);
              return req.developerInstructions
                .replaceAll(MANAGER_WORKSPACE_PATH_PLACEHOLDER, workspacePath)
                .replaceAll(MANAGER_PREFERENCES_CONTENT_PLACEHOLDER, preferencesContent)
                .replaceAll(MANAGER_THREAD_ID_PLACEHOLDER, thread.id)
                .replaceAll(PROJECT_ID_PLACEHOLDER, req.projectId)
                .replaceAll(PROJECT_NAME_PLACEHOLDER, project?.name ?? req.projectId)
                .replaceAll(PROJECT_ROOT_PATH_PLACEHOLDER, project?.rootPath ?? "(unknown)");
            })(),
          }
        : req;

    this._broadcastThreadChanged(persistedThread.id, ["thread-created"]);
    this._scheduleProvisioning(
      persistedThread.id,
      effectiveEnvironmentRequest.developerInstructions === provisioningRequest.developerInstructions
        ? effectiveEnvironmentRequest
        : {
            ...effectiveEnvironmentRequest,
            developerInstructions: provisioningRequest.developerInstructions,
          },
      {
        rootPathHint: project.rootPath,
        reason: "thread-created",
      },
    );
    const hydratedThread = this._withPrimaryCheckoutState(persistedThread);
    const promptTitleFallback = this._derivePromptFallbackTitle(req.input);
    if (!promptTitleFallback || hydratedThread.title) {
      return hydratedThread;
    }
    this.titleFallbackByThreadId.set(persistedThread.id, promptTitleFallback);
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
    const existingThread = this.threadRepo.getById(threadId);
    await this._tell(threadId, request, options, {
      initiator,
      awaitProviderStart: existingThread?.status !== "active",
    });
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
    this._normalizePromptInputForProvider(thread.providerId, request.input);

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
    await this._tell(threadId, request, options, {
      initiator: "system",
      awaitProviderStart: true,
    });
  }

  async messageUser(
    threadId: string,
    request: {
      text: string;
      toolCallId?: string;
      turnId?: string;
    },
  ): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }
    if (thread.type !== "manager") {
      throw invalidRequestError("Only manager threads can publish user messages");
    }

    const text = request.text.trim();
    if (text.length === 0) {
      throw invalidRequestError("Manager user messages must not be empty");
    }

    this._appendEvent(
      threadId,
      "system/manager/user_message",
      {
        text,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        ...(request.turnId ? { turnId: request.turnId } : {}),
      },
      { broadcastChanges: ["events-appended"] },
    );
  }

  private _notifyManagersOfOwnershipChange(args: {
    threadId: string;
    threadTitle?: string;
    previousParentThreadId?: string;
    nextParentThreadId?: string;
  }): void {
    const threadLabel = `${args.threadId}: ${args.threadTitle ?? "Untitled"}`;

    if (args.previousParentThreadId && args.previousParentThreadId !== args.nextParentThreadId) {
      void this.systemTell(args.previousParentThreadId, {
        input: [
          {
            type: "text",
            text: renderTemplate("systemMessageThreadOwnershipRemoved", { threadLabel }),
          },
        ],
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[thread ${args.threadId}] failed to notify prior manager ${args.previousParentThreadId}: ${message}`,
        );
      });
    }

    if (args.nextParentThreadId && args.nextParentThreadId !== args.previousParentThreadId) {
      void this.systemTell(args.nextParentThreadId, {
        input: [
          {
            type: "text",
            text: renderTemplate("systemMessageThreadOwnershipAssigned", { threadLabel }),
          },
        ],
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[thread ${args.threadId}] failed to notify new manager ${args.nextParentThreadId}: ${message}`,
        );
      });
    }

    this._appendOperationEvent(args.threadId, "ownership_change", "completed", {
      message: args.previousParentThreadId
        ? `Thread management transferred from ${args.previousParentThreadId} to ${args.nextParentThreadId ?? "none"}`
        : `Thread assigned to manager ${args.nextParentThreadId}`,
      metadata: {
        ...(args.previousParentThreadId ? { previousParentThreadId: args.previousParentThreadId } : {}),
        ...(args.nextParentThreadId ? { nextParentThreadId: args.nextParentThreadId } : {}),
        ...(args.threadTitle ? { threadTitle: args.threadTitle } : {}),
      },
    });
  }

  private _tell(
    threadId: string,
    request: TellThreadRequest,
    options: PromptExecutionOptions | undefined,
    context: TellContext,
  ): Promise<void> {
    const requestedInput = request.input;
    if (requestedInput.length === 0) {
      throw invalidRequestError("Tell payload input must be non-empty");
    }
    // Serialize concurrent _tell calls for the same thread to prevent
    // duplicate activation races (audit item 1).
    const previous = this.tellInFlightByThreadId.get(threadId) ?? Promise.resolve();
    const current = previous.then(() =>
      this._tellSerialized(threadId, request, requestedInput, options, context),
    );
    this.tellInFlightByThreadId.set(threadId, current.catch(() => {}));
    return current;
  }

  private async _tellSerialized(
    threadId: string,
    request: TellThreadRequest,
    requestedInput: PromptInput[],
    options: PromptExecutionOptions | undefined,
    context: TellContext,
  ): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (thread.archivedAt !== undefined) {
      throw threadArchivedError(threadId);
    }
    if (
      thread.status === "created" ||
      thread.status === "provisioning" ||
      thread.status === "provisioned"
    ) {
      throw threadProvisioningError(threadId);
    }
    const attachedEnvironmentId = this.threadEnvironmentAttachmentRepo
      ?.getByThreadId(threadId)
      ?.environmentId;
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
          environmentId: this._resolveThreadEnvironmentReference(threadId),
        },
        {
          reason: "tell-after-provisioning-failure",
        },
      );
      return;
    }
    const providerInput = this._normalizePromptInputForProvider(
      thread.providerId,
      requestedInput,
    );

    const tellMode = request.mode ?? "auto";
    const activeTurnId =
      this.activeTurnIdByThreadId.get(threadId) ??
      this._resolvePersistedActiveTurnId(threadId);
    const statusBeforeSend = thread.status;
    const lifecycleEpochBeforeSend = this.turnLifecycleEpochs.get(threadId) ?? 0;
    if (activeTurnId) {
      this.activeTurnIdByThreadId.set(threadId, activeTurnId);
    }
    if (tellMode === "steer" && !activeTurnId) {
      throw noActiveTurnError(threadId);
    }
    const requestedTurnParams = this._buildTurnRequestedParams(providerInput, options);
    const statusChanged = this._activateThreadAndPersistOutboundStartEvent(threadId, {
      type: "client/turn/requested",
      params: requestedTurnParams,
      input: requestedInput,
      meta: {
        source: "tell",
        initiator: context.initiator,
      },
    });
    this._broadcastThreadChanged(
      threadId,
      statusChanged
        ? [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]
        : ["events-appended"],
    );

    const dispatchTurn = async () => {
      try {
        const providerThreadId = await this._ensureProviderSession(threadId, options);

        const project = this.projectRepo.getById(thread.projectId);
        if (project) {
          this._maybeAutogenerateThreadTitle(
            threadId,
            project.rootPath,
            providerThreadId,
            requestedInput,
          );
        }

        const acceptedProviderThreadId =
          await this._sendTurnCommandWithStaleProviderRetry({
          threadId,
          projectId: thread.projectId,
          providerThreadId,
          activeTurnId,
          input: providerInput,
          options,
          mode: tellMode === "steer" ? "steer" : tellMode === "auto" ? "auto" : "start",
        });
        const turnParams = this._buildTurnStartParams(
          acceptedProviderThreadId,
          providerInput,
          options,
        );
        this._persistOutboundStartEvent(
          threadId,
          "client/turn/start",
          turnParams,
          requestedInput,
          {
            source: "tell",
            initiator: context.initiator,
          },
          { broadcastChanges: ["events-appended"] },
        );
      } catch (error) {
        if (this._getAgentServerForThread(thread).isMissingProviderThreadError(error)) {
          this.handleEnvironmentDaemonSessionInvalidated(threadId);
        }
        if (
          statusBeforeSend !== "active" &&
          !activeTurnId &&
          (this.turnLifecycleEpochs.get(threadId) ?? 0) === lifecycleEpochBeforeSend &&
          this._resolvePersistedActiveTurnId(threadId) === undefined
        ) {
          const statusChanged = this._setThreadStatus(threadId, "error", false);
          this._appendEvent(
            threadId,
            "system/error",
            this._createTellFailureEventData(error),
            { broadcastChanges: false },
          );
          this._broadcastThreadChanged(
            threadId,
            statusChanged
              ? [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]
              : ["events-appended"],
          );
        } else {
          this._appendEvent(
            threadId,
            "system/error",
            this._createTellFailureEventData(error),
            { broadcastChanges: ["events-appended"] },
          );
        }
        this._rethrowAgentServerError(threadId, error);
      }
    };

    if (context.awaitProviderStart) {
      await dispatchTurn();
      return;
    }

    void dispatchTurn().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[thread ${threadId}] follow-up dispatch failed: ${message}`);
    });
  }

  private _activateThreadAndPersistOutboundStartEvent(
    threadId: string,
    args: {
      type: "client/thread/start" | "client/turn/requested" | "client/turn/start";
      params: Record<string, unknown>;
      input: PromptInput[] | undefined;
      meta: { source: "spawn" | "tell"; initiator: ThreadTurnInitiator };
    },
  ): boolean {
    return this.threadRepo.withTransaction((connection) => {
      this._unblockProviderNotifications(threadId);
      const statusChanged = this._setThreadStatus(threadId, "active", false, {
        connection,
      });
      this._persistOutboundStartEvent(
        threadId,
        args.type,
        args.params,
        args.input,
        args.meta,
        {
          broadcastChanges: false,
          connection,
        },
      );
      return statusChanged;
    });
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
      { initiator: "agent", awaitProviderStart: true },
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
      if (
        thread.status === "created" ||
        thread.status === "provisioning" ||
        thread.status === "provisioned"
      ) {
        return;
      }

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

  private async _runWorktreeCommitOperation(
    threadId: string,
    request?: Extract<EnvironmentOperationRequest, { operation: "commit" }>["options"],
  ): Promise<CommitEnvironmentOperationResponse> {
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
    const defaultBranch =
      detectProjectDefaultBranch(project.rootPath) ??
      await detectProjectDefaultBranchAsync(project.rootPath);
    const result = await environment.commitWorkspace({
      defaultBranch,
      message: request?.message?.trim(),
      includeUnstaged: request?.includeUnstaged,
    });
    await this._refreshPrimaryPromotionSnapshotAfterEnvironmentMutation(thread, environment);
    const autoArchived =
      result.commitCreated &&
      await this._shouldAutoArchiveThreadAsync({
        thread,
        projectRootPath: project.rootPath,
        environment,
        requested: request?.autoArchiveOnSuccess,
        hadMeaningfulBranchWork: result.commitCreated,
      });

    this._broadcastEnvironmentThreadsChanged(
      this._resolveThreadEnvironmentReference(thread.id),
      ["work-status-changed"],
    );
    if (
      autoArchived
    ) {
      await this.archive(thread.id);
    }

    return {
      ok: true,
      operation: "commit",
      commitCreated: result.commitCreated,
      message: result.message,
      autoArchived,
      ...(result.commitSha ? { commitSha: result.commitSha } : {}),
      ...(result.commitSubject ? { commitSubject: result.commitSubject } : {}),
      ...(result.includeUnstaged !== undefined
        ? { includeUnstaged: result.includeUnstaged }
        : {}),
    };
  }

  private async _runWorktreeSquashMergeOperation(
    threadId: string,
    request?: Extract<EnvironmentOperationRequest, { operation: "squash_merge" }>["options"],
  ): Promise<SquashMergeEnvironmentOperationResponse> {
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
    const mergeBaseBranch = this._resolveThreadMergeBaseBranch(
      thread,
      options.mergeBaseBranch,
    );
    const mergeResult = await environment.squashMergeIntoDefaultBranch({
      activeWorkspaceRoot: project.rootPath,
      defaultBranch: mergeBaseBranch,
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
    await this._refreshPrimaryPromotionSnapshotAfterEnvironmentMutation(thread, environment);
    if (!mergeResult.merged && mergeResult.conflictFiles && mergeResult.conflictFiles.length > 0) {
      throw invalidRequestError(mergeResult.message, {
        operation: "squash_merge",
        kind: "squash_merge_conflict",
        request: {
          operation: "squash_merge",
          initiatingThreadId: threadId,
          ...(request ? { options: request } : {}),
        },
        conflictFiles: mergeResult.conflictFiles,
      } satisfies EnvironmentOperationFailureDetails);
    }
    this._broadcastEnvironmentThreadsChanged(
      this._resolveThreadEnvironmentReference(thread.id),
      ["work-status-changed"],
    );

    const autoArchived =
      mergeResult.merged &&
      await this._shouldAutoArchiveThreadAsync({
        thread,
        projectRootPath: project.rootPath,
        environment,
        mergeBaseBranch,
        requested: options.autoArchiveOnSuccess,
        hadMeaningfulBranchWork: mergeResult.merged,
      });
    if (
      autoArchived
    ) {
      await this.archive(thread.id);
    }

    return {
      ok: true,
      operation: "squash_merge",
      merged: mergeResult.merged,
      message: mergeResult.message,
      autoArchived,
      ...(mergeResult.committed !== undefined ? { committed: mergeResult.committed } : {}),
      ...(mergeResult.commitSha ? { commitSha: mergeResult.commitSha } : {}),
      ...(mergeResult.commitSubject ? { commitSubject: mergeResult.commitSubject } : {}),
      ...(mergeResult.prepCommit
        ? {
            prepCommit: {
              message: mergeResult.prepCommit.message,
              ...(mergeResult.prepCommit.commitSha
                ? { commitSha: mergeResult.prepCommit.commitSha }
                : {}),
              ...(mergeResult.prepCommit.commitSubject
                ? { commitSubject: mergeResult.prepCommit.commitSubject }
                : {}),
              ...(mergeResult.prepCommit.includeUnstaged !== undefined
                ? { includeUnstaged: mergeResult.prepCommit.includeUnstaged }
                : {}),
            },
          }
        : {}),
    };
  }

  private _broadcastEnvironmentThreadsChanged(
    environmentId: string | undefined,
    changes: readonly ThreadChangeKind[],
  ): void {
    if (!environmentId) {
      return;
    }
    for (const thread of this._getThreadsAttachedToEnvironment(environmentId)) {
      this._broadcastThreadChanged(thread.id, changes);
    }
  }

  private _environmentOperationFailureDetails(
    request: Extract<EnvironmentOperationRequest, { operation: "commit" | "squash_merge" }>,
    err: unknown,
  ): EnvironmentOperationFailureDetails | undefined {
    switch (request.operation) {
      case "commit":
        if (err instanceof DomainError) {
          return undefined;
        }
        return {
          operation: "commit",
          kind: "commit_failed",
          request,
          errorMessage: this._toErrorMessage(err),
        };
      case "squash_merge":
        if (err instanceof EnvironmentSquashMergeCommitFailureError) {
          return {
            operation: "squash_merge",
            kind: "squash_merge_commit_failed",
            request,
            stage: err.stage,
            errorMessage: this._toErrorMessage(err),
          };
        }
        if (err instanceof DomainError) {
          return undefined;
        }
        return undefined;
      default:
        return assertNever(request);
    }
  }

  /**
   * Stop an active thread by suspending its live runtime.
   */
  stop(threadId: string): void {
    const thread = this.threadRepo.getById(threadId);
    const shouldAppendInterruptedEvent =
      thread?.status === "active" ||
      thread?.status === "provisioning" ||
      thread?.status === "provisioned";
    const interruptedTurnId =
      this.activeTurnIdByThreadId.get(threadId) ??
      this._resolvePersistedActiveTurnId(threadId);

    this._cleanupThreadRuntime(threadId, {
      retireActiveSession: true,
    });
    if (interruptedTurnId) {
      this._suppressTurnId(threadId, interruptedTurnId);
    }
    this._blockProviderNotifications(threadId);
    if (shouldAppendInterruptedEvent) {
      this._appendEvent(threadId, "system/thread/interrupted" as never, {
        reason: "user",
      } as never, { broadcastChanges: ["events-appended"] });
    }
    this.threadRepo.update(threadId, { status: "idle" });
    this._pruneHistoricalNoiseEvents(threadId, IDLE_NOISE_EVENT_KEEP_RECENT);
    this._broadcastThreadChanged(threadId, THREAD_STATUS_CHANGE_KINDS);
    this._scheduleQueuedFollowUpDispatch(threadId);
  }

  handleEnvironmentDaemonSessionInvalidated(
    threadId: string,
    closeReason?: EnvironmentDaemonSessionCloseReason,
  ): void {
    if (closeReason === "newer_session" || closeReason === "migration") {
      return;
    }

    this._clearEnvironmentDaemonRuntimeState(threadId);

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    if (thread.status === "active") {
      const statusChanged = this._setThreadStatus(threadId, "error", false);
      this._appendEvent(
        threadId,
        "system/error",
        {
          code: "provider_unavailable",
          message: "The live environment-daemon was lost while the thread was active.",
        },
        { broadcastChanges: false },
      );
      this._broadcastThreadChanged(
        threadId,
        statusChanged
          ? [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]
          : ["events-appended"],
      );
      return;
    }

    if (thread.status === "provisioned") {
      const statusChanged = this._setThreadStatus(threadId, "provisioning_failed", false);
      this._appendEvent(
        threadId,
        "system/error",
        {
          code: "provider_unavailable",
          message: "The live environment-daemon was lost before provider bootstrap completed.",
        },
        { broadcastChanges: false },
      );
      this._broadcastThreadChanged(
        threadId,
        statusChanged
          ? [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]
          : ["events-appended"],
      );
    }
  }

  private _clearEnvironmentDaemonRuntimeState(threadId: string): void {
    this.providerThreadIdByThreadId.delete(threadId);
    this._clearAgentServerSessionState(threadId);
    this._detachEnvironmentRuntime(threadId);
  }

  /**
   * Archive a thread and tear down its live runtime while preserving persisted environment identity.
   */
  private _finalizeManagedThreadCleanup(threadId: string, projectId: string): void {
    this.queueDispatchInFlight.delete(threadId);
    this.providerThreadIdByThreadId.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.activeTurnIdByThreadId.delete(threadId);
    this.suppressedTurnIdsByThreadId.delete(threadId);
    this.blockedProviderNotificationsByThreadId.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    this.provisioningTasks.delete(threadId);
    this._discardQueuedProviderThreadChanged(threadId);

    const activePromotion = this.primaryPromotionByProjectId.get(projectId);
    if (activePromotion?.threadId === threadId) {
      this._clearPrimaryPromotionState(projectId);
    }
  }

  private _forgetDeletedThreadState(threadId: string): void {
    this._discardQueuedProviderThreadChanged(threadId);
    this.eventSeqCounters.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.activeTurnIdByThreadId.delete(threadId);
    this.suppressedTurnIdsByThreadId.delete(threadId);
    this.blockedProviderNotificationsByThreadId.delete(threadId);
    this.providerThreadIdByThreadId.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    this.queueDispatchInFlight.delete(threadId);
    this.provisioningTasks.delete(threadId);
    this.timelineByThread.delete(threadId);
    this.titleFallbackByThreadId.delete(threadId);
    this.lockedTitleThreadIds.delete(threadId);
    this.autoTitleAttemptedThreadIds.delete(threadId);
    this.provisioningCompletionStateByThreadId.delete(threadId);
  }

  async archive(threadId: string): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;
    const previousStatus = thread.status;
    const previousArchivedAt = thread.archivedAt;
    const archivedAt = previousArchivedAt ?? Date.now();

    this.threadRepo.update(threadId, {
      status: "idle",
      archivedAt,
    });
    this._broadcastThreadChanged(threadId, [
      ...THREAD_STATUS_CHANGE_KINDS,
      "archived-changed",
    ]);
    this._cleanupThreadRuntime(threadId, { retireActiveSession: true });

    try {
      await this.environmentService.archiveThreadEnvironment(threadId);
    } catch (error) {
      this.threadRepo.update(threadId, {
        status: previousStatus,
        archivedAt: previousArchivedAt ?? null,
      });
      this._broadcastThreadChanged(threadId, [
        ...THREAD_STATUS_CHANGE_KINDS,
        "archived-changed",
      ]);
      throw error;
    }

    const refreshedThread = this.threadRepo.getById(threadId);
    if (!refreshedThread) return;
    this._finalizeManagedThreadCleanup(threadId, refreshedThread.projectId);
    this._pruneHistoricalNoiseEvents(threadId, ARCHIVED_NOISE_EVENT_KEEP_RECENT);
  }

  async deleteThread(threadId: string): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    await this._cleanupThreadRuntimeAndWait(threadId, {
      retireActiveSession: true,
    });
    await this.environmentService.destroyThreadEnvironment(threadId);
    this._finalizeManagedThreadCleanup(threadId, thread.projectId);
    this.environmentService.removeManagedThreadLogs(thread);
    this.eventRepo.deleteByThreadId(threadId);
    this.threadRepo.delete(threadId);
    this._forgetDeletedThreadState(threadId);
    this.ws.broadcast("thread", threadId, ["thread-deleted"]);
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
    return this._hasIsolatedThreadWorkspace(thread);
  }

  updateThread(
    threadId: string,
    request: {
      title?: string;
      mergeBaseBranch?: string | null;
      parentThreadId?: string | null;
    },
  ): Thread {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }

    let didChange = false;
    let didChangeTitle = false;
    let didChangeMergeBaseBranch = false;
    let didChangeParentThread = false;
    const nextTitle = this._normalizeThreadTitle(request.title);
    if (nextTitle && nextTitle !== thread.title) {
      this.threadRepo.update(threadId, { title: nextTitle });
      this.titleFallbackByThreadId.delete(threadId);
      this.lockedTitleThreadIds.add(threadId);
      const providerThreadId = this._resolvePersistedProviderThreadId(threadId);
      if (providerThreadId) {
        void this._withEnvironmentDaemonAccess(
          threadId,
          async ({ client, thread: latestThread, providerLaunch }) => {
            await this._getAgentServerForThreadId(threadId).renameThreadCommand({
              client,
              threadId,
              providerThreadId,
              title: nextTitle,
              context: this._buildProviderThreadContext({
                threadId,
                projectId: latestThread.projectId,
              }),
              providerLaunch,
            });
          },
        ).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[thread ${threadId}] Failed to rename provider thread: ${message}`);
        });
      }
      didChange = true;
      didChangeTitle = true;
    }

    const nextMergeBaseBranch = this._normalizeThreadMergeBaseBranch(
      request.mergeBaseBranch,
    );
    if (
      request.mergeBaseBranch !== undefined &&
      nextMergeBaseBranch !== (thread.mergeBaseBranch ?? undefined)
    ) {
      this.threadRepo.update(threadId, { mergeBaseBranch: nextMergeBaseBranch ?? null });
      didChange = true;
      didChangeMergeBaseBranch = true;
    }

    if (request.parentThreadId !== undefined) {
      if (thread.type === "manager" && request.parentThreadId !== null) {
        throw invalidRequestError("Manager threads cannot be managed by a parent thread");
      }
      const previousParentThreadId = thread.parentThreadId;
      const nextParentThreadId = request.parentThreadId ?? undefined;
      if (nextParentThreadId) {
        this._validateManagerParentThread({
          projectId: thread.projectId,
          parentThreadId: nextParentThreadId,
          childThreadId: threadId,
        });
      }
      if (nextParentThreadId !== thread.parentThreadId) {
        this.threadRepo.update(threadId, {
          parentThreadId: nextParentThreadId ?? null,
        });
        didChange = true;
        didChangeParentThread = true;
        this._notifyManagersOfOwnershipChange({
          threadId,
          threadTitle: thread.title,
          previousParentThreadId,
          nextParentThreadId,
        });
      }
    }

    const updated = this.threadRepo.getById(threadId);
    if (!updated) {
      throw threadNotFoundError(threadId);
    }
    if (didChange) {
      const changes: ThreadChangeKind[] = [];
      if (didChangeTitle) {
        changes.push("title-changed");
      }
      if (didChangeMergeBaseBranch) {
        changes.push("work-status-changed");
      }
      if (didChangeParentThread) {
        changes.push("thread-created");
      }
      this._broadcastThreadChanged(threadId, changes);
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
    includeManagerDebugView: boolean = false,
  ): ThreadTimelineResponse {
    return measureSync("orchestrator.getTimeline", () => {
      const thread = this.threadRepo.getById(threadId);
      const latestSeq = this.eventRepo.getLatestSeq(threadId);
      const requestKey = `${limit ?? "all"}:${includeToolGroupMessages ? "with-tool-messages" : "summary-only"}:${includeManagerDebugView ? "manager-debug" : "manager-default"}`;
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
        includeInternalSystemMessages: includeManagerDebugView,
        includeOptionalOperations: false,
        threadStatus: thread?.status,
        threadType:
          includeManagerDebugView && thread?.type === "manager" ? "standard" : thread?.type,
      });
      const visibleMessages = uiMessages.filter(
        (entry) => {
          if (entry.kind === "assistant-reasoning") return false;
          if (includeManagerDebugView) return true;
          if (thread?.type !== "manager") return true;
          return (
            entry.kind === "user" ||
            entry.kind === "assistant-text" ||
            entry.kind === "error"
          );
        },
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
    }, {
      threadId,
      ...(limit !== undefined ? { limit } : {}),
      includeToolGroupMessages,
      includeManagerDebugView,
    });
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
      includeInternalSystemMessages: request.includeManagerDebugView ?? false,
      includeOptionalOperations: false,
      threadStatus: thread?.status,
      threadType:
        request.includeManagerDebugView && thread?.type === "manager"
          ? "standard"
          : thread?.type,
    });
    const rowMessages = uiMessages.filter((entry) => {
      if (entry.kind === "assistant-reasoning") return false;
      if (request.includeManagerDebugView) {
        if ((entry.turnId ?? null) !== request.turnId) return false;
        return (
          entry.sourceSeqStart >= sourceSeqStart &&
          entry.sourceSeqEnd <= sourceSeqEnd
        );
      }
      if (
        thread?.type === "manager" &&
        entry.kind !== "user" &&
        entry.kind !== "assistant-text" &&
        entry.kind !== "error"
      ) {
        return false;
      }
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

  async getGitDiffAsync(
    threadId: string,
    selection: ThreadGitDiffSelection = { type: "combined" },
    mergeBaseBranch?: string,
  ): Promise<ThreadGitDiffResponse> {
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
    const defaultBranch =
      detectProjectDefaultBranch(project.rootPath) ??
      await detectProjectDefaultBranchAsync(project.rootPath);
    const resolvedMergeBaseBranch = this._resolveThreadMergeBaseBranch(
      thread,
      mergeBaseBranch,
    );
    const status = await environment.getWorkspaceStatus({
      defaultBranch,
      mergeBaseBranch: resolvedMergeBaseBranch,
    });
    if (status.baseRef) {
      const commits = await environment.listWorkspaceCommitsSinceRef({
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
          ? await environment.getWorkspaceDiff({
              type: "commit",
              commitSha: normalizedSelection.sha,
            })
          : await environment.getWorkspaceDiff({
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

    const diffResult = await environment.getWorkspaceDiff({ type: "working_tree" });
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
    const thread = this.threadRepo.getById(threadId);
    const allEvents = this.eventRepo.listByThread(threadId);
    // Walk backwards to find the last output event.
    for (let i = allEvents.length - 1; i >= 0; i--) {
      if (thread?.type === "manager" && allEvents[i].type === "system/manager/user_message") {
        const text = getStringField(toRecord(allEvents[i].data), "text");
        if (typeof text === "string" && text.length > 0) {
          return text;
        }
      }
      const hydratedEvent: ThreadEvent = {
        ...allEvents[i],
        data: unwrapProviderEventPayload(allEvents[i].data) as ThreadEvent["data"],
      };
      const output = this._getAgentServerForThreadIdOrDefault(threadId).outputFromEvent(
        hydratedEvent,
      );
      if (output !== undefined) return output;
    }
    return undefined;
  }

  /**
   * Lightweight thread lookup for route guards and internal checks that do not
   * need hydrated work status or built-in action state.
   */
  getRawById(threadId: string): Thread | undefined {
    const thread = this.threadRepo.getById(threadId);
    return thread ? this._withResolvedEnvironmentReference(thread) : undefined;
  }

  getById(threadId: string): Thread | undefined {
    return this.getRawById(threadId);
  }

  /**
   * Cheap primary-checkout activity check for request paths that only need to
   * know whether a demotion should be attempted.
   */
  isPrimaryCheckoutActive(threadId: string): boolean {
    return this._isThreadAttachedToPromotedEnvironment(threadId);
  }

  /**
   * Get the thread record by id.
   */
  async getHydratedByIdAsync(threadId: string): Promise<Thread | undefined> {
    return measureAsync("orchestrator.getHydratedByIdAsync", async () => {
      const thread = this.threadRepo.getById(threadId);
      if (!thread) return undefined;
      this._ensurePrimaryPromotionStateIsCurrent(thread.projectId);
      return this._withDefaultExecutionOptions(await this._hydrateThreadStateAsync(thread));
    }, { threadId });
  }

  async getWorkStatusAsync(
    threadId: string,
    mergeBaseBranch?: string,
  ): Promise<ThreadWorkStatus | undefined> {
    return measureAsync("orchestrator.getWorkStatusAsync", async () => {
      const thread = this.threadRepo.getById(threadId);
      if (!thread) return undefined;
      const project = this.projectRepo.getById(thread.projectId);
      if (!project) return undefined;

      const environment = this._restoreThreadEnvironment(thread, project.rootPath);
      if (!environment) return undefined;
      if (this._shouldForceDeletedWorkStatus(thread)) {
        return this._buildDeletedWorkStatus();
      }

      const defaultBranch =
        detectProjectDefaultBranch(project.rootPath) ??
        await detectProjectDefaultBranchAsync(project.rootPath);
      const resolvedMergeBaseBranch = this._resolveThreadMergeBaseBranch(
        thread,
        mergeBaseBranch,
      );
      const workspaceStatus = await environment.getWorkspaceStatus({
        defaultBranch,
        mergeBaseBranch: resolvedMergeBaseBranch,
      });
      return { ...workspaceStatus };
    }, {
      threadId,
      ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
    });
  }

  async getMergeBaseBranchesAsync(threadId: string): Promise<string[] | undefined> {
    return measureAsync("orchestrator.getMergeBaseBranchesAsync", async () => {
      const thread = this.threadRepo.getById(threadId);
      if (!thread) return undefined;
      const project = this.projectRepo.getById(thread.projectId);
      if (!project) return undefined;

      const environment = this._restoreThreadEnvironment(thread, project.rootPath);
      if (!environment || this._shouldForceDeletedWorkStatus(thread)) {
        return undefined;
      }

      const defaultBranch =
        detectProjectDefaultBranch(project.rootPath) ??
        await detectProjectDefaultBranchAsync(project.rootPath);
      return listGitWorkspaceMergeBaseBranchesAsync(environment, defaultBranch);
    }, { threadId });
  }

  async getProjectWorkspaceStatusAsync(
    projectId: string,
    rootPath: string,
  ): Promise<ThreadWorkStatus> {
    return this.environmentService.getProjectWorkspaceStatusAsync(projectId, rootPath);
  }

  getPrimaryCheckoutStatus(projectId: string): PrimaryCheckoutStatus {
    this._ensurePrimaryPromotionStateIsCurrent(projectId);
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

  getDefaultExecutionOptions(
    threadId: string,
  ): ThreadExecutionOptions | undefined {
    return measureSync(
      "orchestrator.getDefaultExecutionOptions",
      () => this.eventRepo.getLatestExecutionOptions(threadId),
      { threadId },
    );
  }

  /**
   * List threads with optional filters.
   */
  list(filters?: {
    projectId?: string;
    type?: ThreadType;
    parentThreadId?: string;
    includeArchived?: boolean;
    includeWorkStatus?: boolean;
  }): Thread[] {
    const threads = this.threadRepo.list(filters);
    if (!filters?.includeWorkStatus) {
      return threads.map((thread) => this._withDerivedThreadState(thread));
    }
    return threads.map((thread) => this._hydrateThreadState(thread));
  }

  async listAsync(filters?: {
    projectId?: string;
    type?: ThreadType;
    parentThreadId?: string;
    includeArchived?: boolean;
    includeWorkStatus?: boolean;
  }): Promise<Thread[]> {
    const threads = this.threadRepo.list(filters);
    if (!filters?.includeWorkStatus) {
      return threads.map((thread) => this._withDerivedThreadState(thread));
    }
    return Promise.all(
      threads.map((thread) => this._hydrateThreadStateAsync(thread)),
    );
  }

  async requestEnvironmentOperation(
    environmentId: string,
    request: EnvironmentOperationRequest,
  ): Promise<EnvironmentOperationResponse> {
    const environmentRecord = this.environmentRepo?.getById(environmentId);
    if (!environmentRecord) {
      throw invalidRequestError(`Environment not found: ${environmentId}`);
    }

    switch (request.operation) {
      case "promote_primary": {
        const targetThread = this.threadRepo.getById(request.initiatingThreadId);
        if (!targetThread) {
          throw threadNotFoundError(request.initiatingThreadId);
        }
        if (targetThread.archivedAt !== undefined) {
          throw threadArchivedError(targetThread.id);
        }
        if (targetThread.projectId !== environmentRecord.projectId) {
          throw invalidRequestError(
            `Thread ${targetThread.id} does not belong to environment project ${environmentRecord.projectId}`,
          );
        }
        if (this._resolveThreadEnvironmentReference(targetThread.id) !== environmentId) {
          throw invalidRequestError(
            `Thread ${targetThread.id} is not attached to environment ${environmentId}`,
          );
        }
        return this.promoteThreadEnvironmentToPrimaryCheckout(targetThread.id);
      }
      case "demote_primary": {
        const targetThread = this.threadRepo.getById(request.initiatingThreadId);
        if (!targetThread) {
          throw threadNotFoundError(request.initiatingThreadId);
        }
        if (targetThread.archivedAt !== undefined) {
          throw threadArchivedError(targetThread.id);
        }
        if (targetThread.projectId !== environmentRecord.projectId) {
          throw invalidRequestError(
            `Thread ${targetThread.id} does not belong to environment project ${environmentRecord.projectId}`,
          );
        }
        if (this._resolveThreadEnvironmentReference(targetThread.id) !== environmentId) {
          throw invalidRequestError(
            `Thread ${targetThread.id} is not attached to environment ${environmentId}`,
          );
        }
        return this.demoteThreadEnvironmentFromPrimaryCheckout(targetThread.id);
      }
      case "commit":
      case "squash_merge": {
        const thread = this.threadRepo.getById(request.initiatingThreadId);
        if (!thread) {
          throw threadNotFoundError(request.initiatingThreadId);
        }
        if (thread.archivedAt !== undefined) {
          throw threadArchivedError(thread.id);
        }
        if (this._resolveThreadEnvironmentReference(request.initiatingThreadId) !== environmentId) {
          throw invalidRequestError(
            `Thread ${request.initiatingThreadId} is not attached to environment ${environmentId}`,
          );
        }
        return this._runWithProjectGitMutationLock(
          thread.projectId,
          "Another environment git operation is already in progress for this project",
          async () => {
            try {
              return request.operation === "commit"
                ? await this._runWorktreeCommitOperation(thread.id, request.options)
                : await this._runWorktreeSquashMergeOperation(thread.id, request.options);
            } catch (err) {
              const details = this._environmentOperationFailureDetails(request, err);
              if (details) {
                throw invalidRequestError(this._toErrorMessage(err), details);
              }
              if (isDomainError(err)) {
                throw err;
              }
              throw invalidRequestError(this._toErrorMessage(err));
            }
          },
        );
      }
      default:
        return assertNever(request);
    }
  }

  async promoteThreadEnvironmentToPrimaryCheckout(
    threadId: string,
  ): Promise<PromotePrimaryCheckoutResponse> {
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
      const threadEnvironmentId = this._resolveThreadEnvironmentReference(thread.id);

      if (
        existingPromotion &&
        threadEnvironmentId &&
        existingPromotion.environmentId === threadEnvironmentId
      ) {
        return {
          ok: true,
          promoted: false,
          message: "Primary checkout is already promoted to this environment",
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
        try {
          const demoteResult = await this.environmentService.demoteThreadEnvironment({
            thread: activeThread,
            ttlMs: PRIMARY_CHECKOUT_VALIDATION_TTL_MS,
          });
          this._broadcastThreadChanged(activeThread.id, THREAD_STATUS_CHANGE_KINDS);
        } catch (err) {
          const message = this._toErrorMessage(err);
          this._broadcastThreadChanged(activeThread.id, THREAD_STATUS_CHANGE_KINDS);
          throw invalidRequestError(message);
        }
      }

      const result = await this.environmentService.promoteThreadEnvironment({
        thread,
        ttlMs: PRIMARY_CHECKOUT_VALIDATION_TTL_MS,
      });

      if (
        (result.reason === "already-promoted-same-thread" ||
          result.reason === "already-promoted-same-environment") &&
        result.state
      ) {
        return {
          ok: true,
          promoted: false,
          message: "Primary checkout is already promoted to this environment",
          primaryStatus: result.status,
        };
      }

      if (!environment || !this._hasIsolatedThreadWorkspace(thread)) {
        throw invalidRequestError(
          "Thread worktree path is unavailable (workspace resolved to project root); reprovision before promoting",
        );
      }
      if (!environment.exists()) {
        throw invalidRequestError("Thread worktree is unavailable; reprovision the thread first");
      }

      try {
        const promotedState = result.state;
        const affectedThreads = promotedState
          ? this._getThreadsAttachedToEnvironment(promotedState.environmentId)
          : [thread];
        for (const affectedThread of affectedThreads) {
          this._broadcastThreadChanged(affectedThread.id, THREAD_STATUS_CHANGE_KINDS);
        }
        return {
          ok: true,
          promoted: true,
          message: "Primary checkout promoted",
          primaryStatus: result.status,
        };
      } catch (err) {
        const message = this._toErrorMessage(err);
        this._broadcastThreadChanged(thread.id, THREAD_STATUS_CHANGE_KINDS);
        throw invalidRequestError(message);
      }
    });
  }

  async demoteThreadEnvironmentFromPrimaryCheckout(
    threadId: string,
  ): Promise<DemotePrimaryCheckoutResponse> {
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
        return {
          ok: true,
          demoted: false,
          message: "Primary checkout is already demoted",
          primaryStatus: this.getPrimaryCheckoutStatus(project.id),
        };
      }

      const threadEnvironmentId = this._resolveThreadEnvironmentReference(thread.id);
      if (!threadEnvironmentId || threadEnvironmentId !== active.environmentId) {
        throw invalidRequestError(
          `Thread ${active.threadId} is currently promoted in primary checkout`,
        );
      }
      const activeThread = this.threadRepo.getById(active.threadId);

      try {
        const result = await this.environmentService.demoteThreadEnvironment({
          thread,
          ttlMs: PRIMARY_CHECKOUT_VALIDATION_TTL_MS,
        });

        const affectedThreads = this._getThreadsAttachedToEnvironment(active.environmentId);
        if (affectedThreads.length > 0) {
          for (const affectedThread of affectedThreads) {
            this._broadcastThreadChanged(affectedThread.id, THREAD_STATUS_CHANGE_KINDS);
          }
        } else if (activeThread) {
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
        const affectedThreads = this._getThreadsAttachedToEnvironment(active.environmentId);
        if (affectedThreads.length > 0) {
          for (const affectedThread of affectedThreads) {
            this._broadcastThreadChanged(affectedThread.id, THREAD_STATUS_CHANGE_KINDS);
          }
        } else {
          this._broadcastThreadChanged(active.threadId, THREAD_STATUS_CHANGE_KINDS);
        }
        throw invalidRequestError(message);
      }
    });
  }

  /**
   * Check if a thread's process is currently active.
   */
  isActive(threadId: string): boolean {
    return this.threadRepo.getById(threadId)?.status === "active";
  }

  /**
   * Get count of currently active (running) thread processes.
   */
  getActiveCount(): number {
    const activeThreads = this.threadRepo.list({ status: "active" });
    return Array.isArray(activeThreads) ? activeThreads.length : 0;
  }

  /**
   * Get count of threads currently marked as active.
   */
  getRunningCount(): number {
    return this.threadRepo.list({ status: "active" }).length;
  }

  /**
   * List available models from a provider. When no providerId is given, uses
   * the default provider.
   */
  async listModels(providerId?: string, environmentId?: string): Promise<AvailableModel[]> {
    const resolvedProviderId = providerId && isThreadProviderId(providerId)
      ? providerId
      : this.defaultProviderId;
    const cacheKey = environmentId
      ? `${resolvedProviderId}\0${environmentId}`
      : resolvedProviderId;
    const now = Date.now();
    const cached = this.cachedModelsByRequestKey.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const pending = this.pendingModelsRequestByRequestKey.get(cacheKey);
    if (pending) {
      return pending;
    }

    const request = (async () => {
      const envDaemonModels = environmentId
        ? await this._listProviderModelsFromEnvironmentDaemon(
            resolvedProviderId,
            environmentId,
          )
        : undefined;
      const models =
        envDaemonModels ??
        await this._getProviderAdapterForProviderId(resolvedProviderId).listModels();
      this.cachedModelsByRequestKey.set(cacheKey, {
        value: models,
        expiresAt: Date.now() + MODEL_LIST_CACHE_TTL_MS,
      });
      return models;
    })().finally(() => {
      this.pendingModelsRequestByRequestKey.delete(cacheKey);
    });

    this.pendingModelsRequestByRequestKey.set(cacheKey, request);
    return request;
  }

  private getDefaultProviderInfoFromCatalog(): SystemProviderInfo {
    const provider =
      this.providerCatalog.find((entry) => entry.id === this.defaultProviderId) ??
      (() => {
        const adapter = createProviderAdapter({ providerId: this.defaultProviderId });
        return {
          id: adapter.id,
          displayName: adapter.displayName,
          capabilities: { ...adapter.capabilities },
        };
      })();
    return {
      ...provider,
      capabilities: { ...provider.capabilities },
    };
  }

  async getProviderInfo(environmentId?: string): Promise<SystemProviderInfo> {
    const providers = await this.listProviders(environmentId);
    const provider =
      providers.find((entry) => entry.id === this.defaultProviderId) ??
      this.getDefaultProviderInfoFromCatalog();
    return {
      ...provider,
      capabilities: { ...provider.capabilities },
    };
  }

  async listProviders(environmentId?: string): Promise<SystemProviderInfo[]> {
    if (environmentId) {
      const envDaemonCatalog = await this._listProviderCatalogFromEnvironmentDaemon(
        environmentId,
      );
      if (envDaemonCatalog && envDaemonCatalog.length > 0) {
        return envDaemonCatalog;
      }
    }
    if (this.providerCatalog.length > 0) {
      return this.providerCatalog.map((provider) => ({
        ...provider,
        capabilities: { ...provider.capabilities },
      }));
    }
    return [this.getDefaultProviderInfoFromCatalog()];
  }

  listEnvironments(): SystemEnvironmentInfo[] {
    return this.environmentCatalog.map((environment) => ({ ...environment }));
  }

  async getEnvironmentDaemonStatus(
    threadId: string,
  ): Promise<EnvironmentDaemonStatusSnapshot> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }
    if (!this.environmentDaemonSessionService) {
      throw inactiveSessionError(threadId);
    }
    const environmentId = this.threadEnvironmentAttachmentRepo?.getByThreadId(threadId)?.environmentId;
    if (!environmentId) {
      throw inactiveSessionError(threadId);
    }
    try {
      return this.environmentDaemonSessionService.getEnvironmentStatus(environmentId, threadId);
    } catch {
      throw inactiveSessionError(threadId);
    }
  }

  async ingestReplayedEnvironmentDaemonEvents(args: {
    threadId: string;
    events: EnvironmentDaemonEventEnvelope[];
  }): Promise<void> {
    const thread = this.threadRepo.getById(args.threadId);
    if (!thread) {
      throw threadNotFoundError(args.threadId);
    }

    const fallbackEvents: EnvironmentDaemonEventEnvelope[] = [];
    for (const envelope of args.events) {
      const event = envelope.event;
      if (
        event.type === "provider.event" &&
        event.providerId &&
        event.normalizedMethod
      ) {
        this._handleAgentServerNotification(args.threadId, {
          method: event.method,
          normalizedMethod: event.normalizedMethod,
          eventType: event.method as ThreadEventType,
          eventData: createProviderEventEnvelope({
            providerId: event.providerId,
            method: event.method,
            payload: event.payload,
            observedAt: envelope.emittedAt,
          }),
          shouldPersist: event.shouldPersist !== false,
          shouldBroadcast: event.shouldBroadcast !== false,
          ...(event.nextStatus ? { nextStatus: event.nextStatus } : {}),
          ...(event.title ? { title: event.title } : {}),
          ...(event.turnState ? { turnState: event.turnState } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
        });
        continue;
      }
      fallbackEvents.push(envelope);
    }

    if (fallbackEvents.length === 0) {
      return;
    }

    await this._getAgentServerForThread(thread).ingestReplayedEnvironmentDaemonEvents({
      threadId: args.threadId,
      events: fallbackEvents,
    });
  }

  async handleEnvironmentDaemonProviderRequest(args: {
    threadId: string;
    requestId: string | number;
    method: string;
    params?: unknown;
    providerId?: string;
    normalizedMethod?: string;
    toolCall?: ProviderToolCallRequest;
  }): Promise<unknown> {
    const thread = this.threadRepo.getById(args.threadId);
    if (!thread) {
      throw threadNotFoundError(args.threadId);
    }

    if (args.toolCall) {
      if (!this.providerToolHost) {
        throw unsupportedOperationError("No provider tool host is configured");
      }
      const toolCallResponse = await this.providerToolHost.execute({
        call: args.toolCall,
        context: this._buildProviderThreadContext({
          threadId: args.threadId,
          projectId: thread.projectId,
        }),
      });
      return { toolCallResponse } satisfies { toolCallResponse: ProviderToolCallResponse };
    }

    return this._getAgentServerForThread(thread).handleProviderRequest({
      threadId: args.threadId,
      context: this._buildProviderThreadContext({
        threadId: args.threadId,
        projectId: thread.projectId,
      }),
      requestId: args.requestId,
      method: args.method,
      ...(args.params !== undefined ? { params: args.params } : {}),
    });
  }

  handleAgentServerNotification(
    threadId: string,
    event: ProviderSessionNotification,
  ): void {
    this._handleAgentServerNotification(threadId, event);
  }

  /**
   * Stop all active processes. Called during graceful shutdown.
   */
  detachAll(): void {
    this.environmentService.detachAll();
    this._clearInMemoryState();
  }

  async teardownAllForTestsOnly(): Promise<void> {
    await this.environmentService.teardownAllForTestsOnly();
    this._clearInMemoryState();
  }

  private _clearInMemoryState(): void {
    this.autoTitleAttemptedThreadIds.clear();
    this.titleFallbackByThreadId.clear();
    this.provisioningTasks.clear();
    this.eventSeqCounters.clear();
    this.lastNotifiedCompletionTurnIds.clear();
    this.turnLifecycleEpochs.clear();
    this.tellInFlightByThreadId.clear();
    this.activeTurnIdByThreadId.clear();
    this.suppressedTurnIdsByThreadId.clear();
    this.blockedProviderNotificationsByThreadId.clear();
    this.providerThreadIdByThreadId.clear();
    this.lastNotifiedCompletionEpochs.clear();
    this.queueDispatchInFlight.clear();
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
            if (this.provisioningTasks.get(threadId) !== task) {
              return;
            }
            this._cleanupThreadRuntime(threadId, { retireActiveSession: true });
            this._setThreadStatus(threadId, "provisioning_failed", true, {
              force: true,
            });
            this._appendEvent(
              threadId,
              "system/error",
              this._createProvisioningFailureEventData(err, req.projectId),
              { broadcastChanges: ["events-appended"] },
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
    const providerId = thread?.providerId ?? DEFAULT_THREAD_PROVIDER_ID;

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
    const spawnInitiator = req.spawnInitiator ?? "agent";
    const persistedThreadStartEvent = this._persistOutboundStartEvent(
      threadId,
      "client/thread/start",
      preProvisionThreadStartParams,
      requestedInput,
      {
        source: startSource,
        initiator: spawnInitiator,
      },
    );

    const effectiveEnvironmentRequest =
      req.environmentId || req.environmentDescriptor || req.environmentCreationArgs
        ? req
        : this._resolveThreadEnvironmentReference(threadId)
          ? {
              ...req,
              environmentId: this._resolveThreadEnvironmentReference(threadId),
            }
          : req.parentThreadId
            ? {
                ...req,
                environmentCreationArgs: { kind: "worktree" },
              }
            : {
                ...req,
                environmentDescriptor: {
                  type: "path" as const,
                  path: project.rootPath,
                },
              };
    let {
      attachedEnvironmentId,
      runtimeEnvironmentKind: requestedEnvironmentKind,
      environmentDisplayName,
      createdWorktree,
    } =
      this._resolveEnvironmentSelection({
      projectId: req.projectId,
      environmentId: effectiveEnvironmentRequest.environmentId,
      environmentDescriptor: effectiveEnvironmentRequest.environmentDescriptor,
      environmentCreationArgs: effectiveEnvironmentRequest.environmentCreationArgs,
      });
    if (!attachedEnvironmentId && effectiveEnvironmentRequest.environmentCreationArgs) {
      attachedEnvironmentId = this.envFactory.reserveThreadEnvironment({
        threadId,
        projectId: req.projectId,
        projectRootPath: project.rootPath,
        environmentCreationArgs: effectiveEnvironmentRequest.environmentCreationArgs,
      });
    }
    if (
      attachedEnvironmentId &&
      !this.threadEnvironmentAttachmentRepo &&
      thread &&
      thread.environmentId !== attachedEnvironmentId
    ) {
      this.threadRepo.update(threadId, { environmentId: attachedEnvironmentId });
    }
    if (attachedEnvironmentId && this.threadEnvironmentAttachmentRepo) {
      this.threadEnvironmentAttachmentRepo.attachThread({
        threadId,
        environmentId: attachedEnvironmentId,
      });
    }
    // Reusing a shared attached environment must preserve the live env-daemon runtime.
    if (!(attachedEnvironmentId && this.environmentService.hasSharedAttachedEnvironment(threadId))) {
      this._cleanupThreadRuntime(threadId);
    }
    const provisioningStatusChanged = this._setThreadStatus(threadId, "provisioning", false, {
      force: true,
    });
    this._appendEvent(
      threadId,
      "system/provisioning/started",
      {
        ...(attachedEnvironmentId ? { attachedEnvironmentId } : {}),
        reason: provisioningReason,
        transcript: createEnvironmentProvisioningTranscript({
          environmentDisplayName,
          ...(attachedEnvironmentId ? { attachedEnvironmentId } : {}),
          createdWorktree,
        }),
      },
      { broadcastChanges: false },
    );
    this._broadcastThreadChanged(
      threadId,
      provisioningStatusChanged
        ? [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]
        : ["events-appended"],
    );
    this._appendProvisioningProgressEvent(threadId, "prepare_environment", "started");

    const prepareEnvironmentStartedAt = Date.now();
    let environmentRuntime: ActiveEnvironmentRuntime;
    try {
      environmentRuntime = await this._spawnProcess(
        threadId,
        opts?.rootPathHint ?? project.rootPath,
        requestedEnvironmentKind,
        provisioningReason,
      );
      this._appendProvisioningProgressEvent(threadId, "prepare_environment", "completed", {
        durationMs: Date.now() - prepareEnvironmentStartedAt,
      });
    } catch (error) {
      this._appendProvisioningProgressEvent(threadId, "prepare_environment", "failed", {
        durationMs: Date.now() - prepareEnvironmentStartedAt,
      });
      throw error;
    }
    let attachedEnvironmentIdAfterProvision: string | undefined;
    try {
      attachedEnvironmentIdAfterProvision = this.envFactory.syncThreadEnvironmentAttachment({
        threadId,
        projectId: project.id,
        projectRootPath: project.rootPath,
        environment: environmentRuntime.environment,
      })?.environmentId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[thread ${threadId}] failed to sync first-class environment attachment: ${message}`,
      );
    }
    if (attachedEnvironmentIdAfterProvision) {
      if (!this.threadEnvironmentAttachmentRepo) {
        this.threadRepo.update(threadId, {
          environmentId: attachedEnvironmentIdAfterProvision,
        });
      }
    }
    const provisionedEnvironmentPresentation = this._resolveProvisioningPresentation({
      attachedEnvironmentId: attachedEnvironmentIdAfterProvision,
      fallbackDisplayName: environmentRuntime.environment.info.displayName,
    });
    const { branchName, headSha } = await getEnvironmentCheckoutSummary(
      environmentRuntime.environment,
    );
    const hydratedThread = this.threadRepo.getById(threadId);
    if (hydratedThread) {
      this._broadcastThreadChanged(threadId, ["work-status-changed"]);
    }
    this._setThreadStatus(threadId, "provisioned");
    const providerInput = this._normalizePromptInputForProvider(
      providerId,
      requestedInput,
    );

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
        initiator: spawnInitiator,
      },
    );
    this._appendProvisioningProgressEvent(threadId, "start_provider_session", "started");
    const providerStartStartedAt = Date.now();
    let started: { providerThreadId: string };
    try {
      started = await this._withEnvironmentDaemonAccess(
        threadId,
        async ({ client, providerLaunch }) =>
          this._getAgentServerForProviderId(providerId).startThreadCommand({
            client,
            threadId,
            projectId: req.projectId,
            request: effectiveRequest,
            context: providerContext,
            providerLaunch,
          }),
      );
      this._appendProvisioningProgressEvent(threadId, "start_provider_session", "completed", {
        durationMs: Date.now() - providerStartStartedAt,
      });
    } catch (error) {
      this._appendProvisioningProgressEvent(threadId, "start_provider_session", "failed", {
        durationMs: Date.now() - providerStartStartedAt,
      });
      throw error;
    }
    let providerThreadId = started.providerThreadId;
    this.providerThreadIdByThreadId.set(threadId, providerThreadId);
    this._appendEvent(
      threadId,
      "system/provisioning/completed",
      {
        ...(attachedEnvironmentIdAfterProvision
          ? { attachedEnvironmentId: attachedEnvironmentIdAfterProvision }
          : {}),
        providerThreadId,
        workspaceRoot: environmentRuntime.environment.getWorkspaceRootUnsafe(),
        reason: provisioningReason,
        transcript: [
          ...createEnvironmentProvisioningTranscript({
            environmentDisplayName: provisionedEnvironmentPresentation.environmentDisplayName,
            ...(attachedEnvironmentIdAfterProvision
              ? { attachedEnvironmentId: attachedEnvironmentIdAfterProvision }
              : {}),
            createdWorktree: provisionedEnvironmentPresentation.createdWorktree,
          }),
          ...(() => {
            const branchEntry = createProvisioningBranchTranscriptEntry({
              branchName,
              headSha,
              checkedOutBranch: provisionedEnvironmentPresentation.createdWorktree,
            });
            return branchEntry ? [branchEntry] : [];
          })(),
        ],
      },
      { broadcastChanges: ["events-appended"] },
    );
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
      providerThreadId = await this._sendTurnCommandWithStaleProviderRetry({
        threadId,
        projectId: req.projectId,
        providerThreadId,
        input: providerInput,
        options: req,
        mode: "start",
      });
      if (
        providerThreadId !== started.providerThreadId &&
        hydratedThreadAfterStart?.title &&
        this.lockedTitleThreadIds.has(threadId)
      ) {
        this._sendThreadNameSet(threadId, providerThreadId, hydratedThreadAfterStart.title);
      }
      const turnStartParams = this._buildTurnStartParams(providerThreadId, providerInput, req);
      const statusChanged = this._activateThreadAndPersistOutboundStartEvent(threadId, {
        type: "client/turn/start",
        params: turnStartParams,
        input: requestedInput,
        meta: {
          source: "spawn",
          initiator: spawnInitiator,
        },
      });
      this._broadcastThreadChanged(
        threadId,
        statusChanged
          ? [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]
          : ["events-appended"],
      );
      return;
    }

    this._setThreadStatus(threadId, "idle");
  }

  private _cleanupThreadRuntime(
    threadId: string,
    opts?: { retireActiveSession?: boolean },
  ): void {
    this._clearThreadRuntimeState(threadId);
    if (opts?.retireActiveSession) {
      const envId = this.threadEnvironmentAttachmentRepo?.getByThreadId(threadId)?.environmentId;
      if (envId && !this.environmentService.hasSharedAttachedEnvironment(threadId)) {
        this.environmentDaemonSessionService?.retireActiveSessionForEnvironment({
          environmentId: envId,
          reason: "migration",
        });
      }
    }
    if (!this.environmentService.hasSharedAttachedEnvironment(threadId)) {
      this.environmentService.suspendEnvironmentRuntime(threadId);
    }
  }

  private _clearThreadRuntimeState(threadId: string): void {
    this.eventSeqCounters.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.activeTurnIdByThreadId.delete(threadId);
    this.suppressedTurnIdsByThreadId.delete(threadId);
    this.blockedProviderNotificationsByThreadId.delete(threadId);
    this.providerThreadIdByThreadId.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
  }

  private async _cleanupThreadRuntimeAndWait(
    threadId: string,
    opts?: { retireActiveSession?: boolean },
  ): Promise<void> {
    this._clearThreadRuntimeState(threadId);
    if (opts?.retireActiveSession) {
      const envId = this.threadEnvironmentAttachmentRepo?.getByThreadId(threadId)?.environmentId;
      if (envId && !this.environmentService.hasSharedAttachedEnvironment(threadId)) {
        this.environmentDaemonSessionService?.retireActiveSessionForEnvironment({
          environmentId: envId,
          reason: "migration",
        });
      }
    }
    if (!this.environmentService.hasSharedAttachedEnvironment(threadId)) {
      await this.environmentService.suspendEnvironmentRuntimeAndWait(threadId);
    }
  }

  private async _recoverEnvironmentDaemonAccess(threadId: string): Promise<void> {
    await this._cleanupThreadRuntimeAndWait(threadId, { retireActiveSession: true });
    await this._ensureEnvironmentDaemonAccess(threadId);
  }

  private async _withEnvironmentDaemonClient<T>(
    threadId: string,
    action: (client: EnvironmentDaemonClient) => Promise<T>,
  ): Promise<T> {
    return this._withEnvironmentDaemonAccess(threadId, ({ client }) => action(client));
  }

  private async _withEnvironmentDaemonTarget<T>(args: {
    thread: Thread;
    projectRootPath: string;
    target: EnvironmentDaemonConnectionTarget;
    action: (input: {
      client: EnvironmentDaemonClient;
      thread: Thread;
      projectRootPath: string;
      providerLaunch?: EnvironmentDaemonConnectionTarget["providerLaunch"];
    }) => Promise<T>;
  }): Promise<T> {
    if (!this.environmentDaemonCommandDispatcher) {
      throw inactiveSessionError(args.thread.id);
    }
    const client = new EnvironmentDaemonSessionCommandClient({
      threadId: args.thread.id,
      commandDispatcher: this.environmentDaemonCommandDispatcher,
      ...(this.environmentDaemonCommandPollIntervalMs !== undefined
        ? { pollIntervalMs: this.environmentDaemonCommandPollIntervalMs }
        : {}),
      ensureSessionAccess: async () => {
        await this._recoverEnvironmentDaemonAccess(args.thread.id);
      },
    });
    try {
      return await args.action({
        client,
        thread: args.thread,
        projectRootPath: args.projectRootPath,
        providerLaunch: args.target.providerLaunch,
      });
    } finally {
      client.close();
    }
  }

  private async _listProviderModelsFromEnvironmentDaemon(
    providerId: ThreadProviderId,
    environmentId: string,
  ): Promise<AvailableModel[] | undefined> {
    if (!this.environmentDaemonCommandDispatcher || !this.environmentDaemonSessionRepo) {
      return undefined;
    }
    const matchingSession = this.environmentDaemonSessionRepo
      .listActive()
      .find((session) => session.environmentId === environmentId);
    if (!matchingSession) {
      return undefined;
    }

    const transportThread = this._resolveEnvironmentCommandTransportThread({
      environmentId,
      providerId,
    });
    if (!transportThread) {
      throw invalidRequestError(
        `No active thread is attached to environment ${environmentId}`,
      );
    }

    const client = new EnvironmentDaemonSessionCommandClient({
      threadId: transportThread.id,
      commandDispatcher: this.environmentDaemonCommandDispatcher,
      ...(this.environmentDaemonCommandPollIntervalMs !== undefined
        ? { pollIntervalMs: this.environmentDaemonCommandPollIntervalMs }
        : {}),
      ensureSessionAccess: async () => {
        await this._recoverEnvironmentDaemonAccess(transportThread.id);
      },
    });
    try {
      const commandId = `provider-models-${providerId}-${Date.now()}`;
      const ack = await client.sendCommand({
        meta: {
          protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
          commandId,
          idempotencyKey: commandId,
          sentAt: Date.now(),
        },
        command: {
          type: "provider.list_models",
          providerId,
        },
      });
      return Array.isArray(ack.result)
        ? ack.result as AvailableModel[]
        : undefined;
    } finally {
      client.close();
    }
  }

  private async _listProviderCatalogFromEnvironmentDaemon(
    environmentId: string,
  ): Promise<SystemProviderInfo[] | undefined> {
    if (!this.environmentDaemonCommandDispatcher || !this.environmentDaemonSessionRepo) {
      return undefined;
    }
    const matchingSession = this.environmentDaemonSessionRepo
      .listActive()
      .find((session) => session.environmentId === environmentId);
    if (!matchingSession) {
      return undefined;
    }

    const capabilities = toRecord(matchingSession.selectedCapabilities);
    const commands = Array.isArray(capabilities?.commands)
      ? capabilities.commands
      : [];
    if (!commands.includes("provider.list_catalog")) {
      return undefined;
    }

    const transportThread = this._resolveEnvironmentSessionTransportThread(
      environmentId,
    );
    if (!transportThread) {
      throw invalidRequestError(
        `No active thread is attached to environment ${environmentId}`,
      );
    }

    const client = new EnvironmentDaemonSessionCommandClient({
      threadId: transportThread.id,
      commandDispatcher: this.environmentDaemonCommandDispatcher,
      ...(this.environmentDaemonCommandPollIntervalMs !== undefined
        ? { pollIntervalMs: this.environmentDaemonCommandPollIntervalMs }
        : {}),
      ensureSessionAccess: async () => {
        await this._recoverEnvironmentDaemonAccess(transportThread.id);
      },
    });
    try {
      const commandId = `provider-catalog-${Date.now()}`;
      const ack = await client.sendCommand({
        meta: {
          protocolVersion: ENVIRONMENT_DAEMON_PROTOCOL_VERSION,
          commandId,
          idempotencyKey: commandId,
          sentAt: Date.now(),
        },
        command: {
          type: "provider.list_catalog",
        },
      });
      return Array.isArray(ack.result)
        ? ack.result as SystemProviderInfo[]
        : undefined;
    } finally {
      client.close();
    }
  }

  private async _ensureEnvironmentDaemonAccess(threadId: string): Promise<{
    thread: Thread;
    projectRootPath: string;
    target: EnvironmentDaemonConnectionTarget;
  }> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      throw threadNotFoundError(threadId);
    }

    const runtimeEnvTarget = this._resolveEnvironmentDaemonConnectionTargetFromRuntimeEnv();
    if (runtimeEnvTarget) {
      if (this.environmentDaemonCommandDispatcher) {
        await this.environmentDaemonCommandDispatcher.awaitActiveSession({ threadId });
      }
      return {
        thread,
        projectRootPath: "",
        target: runtimeEnvTarget,
      };
    }

    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }

    const ensured = await this._ensureEnvironmentDaemonRuntimeWithActiveSession(
      thread,
      project.rootPath,
      "resume-existing-provider-session",
    );

    return {
      thread,
      projectRootPath: project.rootPath,
      target: ensured.runtime.agentConnectionTarget,
    };
  }

  private async _withEnvironmentDaemonAccess<T>(
    threadId: string,
    action: (args: {
      client: EnvironmentDaemonClient;
      thread: Thread;
      projectRootPath: string;
      providerLaunch?: EnvironmentDaemonConnectionTarget["providerLaunch"];
    }) => Promise<T>,
  ): Promise<T> {
    const resolved = await this._ensureEnvironmentDaemonAccess(threadId);
    return this._withEnvironmentDaemonTarget({
      thread: resolved.thread,
      projectRootPath: resolved.projectRootPath,
      target: resolved.target,
      action: ({ client, providerLaunch }) =>
        action({
          client,
          thread: resolved.thread,
          projectRootPath: resolved.projectRootPath,
          providerLaunch,
        }),
    });
  }

  private async _ensureEnvironmentDaemonRuntimeWithActiveSession(
    thread: Thread,
    projectRootPath: string,
    reason: ThreadEnvironmentStartReason,
  ): Promise<{
    runtime: ActiveEnvironmentRuntime;
  }> {
    let ensured = await this.environmentService.ensureThreadEnvironmentRuntime(
      thread,
      projectRootPath,
      reason,
    );
    if (!this.environmentDaemonCommandDispatcher) {
      return ensured;
    }

    try {
      await this.environmentDaemonCommandDispatcher.awaitActiveSession({
        threadId: thread.id,
        timeoutMs: ENVIRONMENT_DAEMON_SESSION_RECOVERY_WAIT_MS,
      });
      return ensured;
    } catch (error) {
      if (!isEnvironmentDaemonSessionUnavailableError(error)) {
        throw error;
      }
    }

    await this.environmentService.suspendEnvironmentRuntimeAndWait(thread.id);
    ensured = await this.environmentService.ensureThreadEnvironmentRuntime(
      thread,
      projectRootPath,
      reason,
    );
    await this.environmentDaemonCommandDispatcher.awaitActiveSession({
      threadId: thread.id,
      timeoutMs: ENVIRONMENT_DAEMON_SESSION_RECOVERY_RETRY_WAIT_MS,
    });
    return ensured;
  }

  private _setEnvironmentRuntime(
    threadId: string,
    environment: IEnvironment,
  ): void {
    this.environmentService.setEnvironmentRuntime(threadId, environment);
  }

  private _detachEnvironmentRuntime(threadId: string): void {
    this.environmentService.detachEnvironmentRuntime(threadId);
  }

  private _destroyEnvironmentRuntime(threadId: string): void {
    this.environmentService.destroyEnvironmentRuntime(threadId);
  }

  private _cleanupPersistedEnvironment(threadId: string): void {
    void this.environmentService.destroyPersistedEnvironment(threadId);
  }

  private _appendEnvironmentProvisioningEvent(
    threadId: string,
    event: EnvironmentProvisioningEvent,
  ): void {
    const setupOutput = event.detail;
    const runtimeEnvironment = this.environmentService.getEnvironmentRuntime(threadId)?.environment;
    const attachedEnvironmentId = this._resolveThreadEnvironmentReference(threadId);
    const transcript: ProvisioningTranscriptEntry[] = [];
    const branchEntry = createProvisioningBranchTranscriptEntry({
      branchName: "branchName" in event ? event.branchName : undefined,
      headSha: "headSha" in event ? event.headSha : undefined,
      checkedOutBranch: this._usesManagedWorktreeProvisioning({
        attachedEnvironmentId,
      }),
    });
    if (branchEntry) {
      transcript.push(branchEntry);
    }
    transcript.push(
      createProvisioningSetupTranscriptEntry({
        status: event.status,
        scriptPath: event.scriptPath,
        startedAt: Date.now(),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(setupOutput ? { output: setupOutput } : {}),
      }),
    );
    this._appendEvent(
      threadId,
      "system/provisioning/env_setup",
      {
        setup: {
          status: event.status,
          scriptPath: event.scriptPath,
          ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(setupOutput ? { output: setupOutput } : {}),
        },
        ...(event.workspaceRoot ? { workspaceRoot: event.workspaceRoot } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        transcript,
      },
      { broadcastChanges: ["events-appended"] },
    );
  }

  private _appendProvisioningProgressEvent(
    threadId: string,
    phase: ThreadProvisioningProgressPhase,
    status: "started" | "completed" | "failed",
    options?: {
      durationMs?: number;
    },
  ): void {
    const observedAt = Date.now();
    const transcriptEntry = createProvisioningProgressTranscriptEntry({
      phase,
      status,
      startedAt: observedAt,
      ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    });
    this._appendEvent(
      threadId,
      "system/provisioning/progress",
      {
        phase,
        status,
        ...(options?.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
        transcript: transcriptEntry ? [transcriptEntry] : [],
      },
      { broadcastChanges: ["events-appended"] },
    );
  }

  private _createEnvironmentContext(
    threadId: string,
    projectRootPath: string,
  ): CreateEnvironmentContext {
    const thread = this.threadRepo.getById(threadId);
    const attachedEnvironmentId = this.threadEnvironmentAttachmentRepo
      ?.getByThreadId(threadId)
      ?.environmentId;
    return {
      projectId: thread?.projectId ?? "",
      threadId,
      projectRootPath,
      ...(attachedEnvironmentId ? { environmentId: attachedEnvironmentId } : {}),
      runtimeEnv: {
        ...this.runtimeEnv,
        BB_THREAD_ID: threadId,
        ...(thread?.providerId ? { BB_THREAD_PROVIDER_ID: thread.providerId } : {}),
        ...(attachedEnvironmentId
          ? { BB_ENVIRONMENT_ID: attachedEnvironmentId }
          : {}),
      },
      managedEnvironmentDaemonReconnectTarget: (() => {
        const session = attachedEnvironmentId
          ? this.environmentDaemonSessionRepo?.getActiveByEnvironmentId(attachedEnvironmentId)
          : undefined;
        if (!session?.controlBaseUrl) {
          return undefined;
        }
        return {
          baseUrl: session.controlBaseUrl,
          ...(session.controlAuthToken ? { authToken: session.controlAuthToken } : {}),
        };
      })(),
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
    projectRootPath: string,
    reason: ThreadEnvironmentStartReason,
  ): Promise<void> {
    if (!this.envFactory.shouldRunSetupScript({ environment, projectRootPath })) {
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
    const workspaceRoot = environment.getWorkspaceRootUnsafe();
    const { branchName, headSha } = await getEnvironmentCheckoutSummary(environment);
    const thread = this.threadRepo.getById(threadId);
    this._appendEnvironmentProvisioningEvent(threadId, {
      type: "env-setup",
      status: "started",
      scriptPath: ENV_SETUP_SCRIPT_NAME,
      workspaceRoot,
      ...(branchName ? { branchName } : {}),
      ...(headSha ? { headSha } : {}),
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      reason,
    });
    let sawSetupOutput = false;
    const result = await environment.run(
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
            workspaceRoot,
            ...(branchName ? { branchName } : {}),
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
            workspaceRoot,
            ...(branchName ? { branchName } : {}),
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
        workspaceRoot,
        ...(branchName ? { branchName } : {}),
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
      workspaceRoot,
      ...(branchName ? { branchName } : {}),
      ...(headSha ? { headSha } : {}),
      timeoutMs: ENV_SETUP_TIMEOUT_MS,
      durationMs: Date.now() - startedAt,
      reason,
    });
    if (this.threadRepo.getById(threadId)?.status !== "provisioning") {
      const provisioningPresentation = this._resolveProvisioningPresentation({
        attachedEnvironmentId: this._resolveThreadEnvironmentReference(threadId),
        fallbackDisplayName: environment.info.displayName,
      });
      this._appendEvent(
        threadId,
        "system/provisioning/completed",
        {
          workspaceRoot,
          transcript: [
            ...createEnvironmentProvisioningTranscript({
              environmentDisplayName: provisioningPresentation.environmentDisplayName,
              createdWorktree: provisioningPresentation.createdWorktree,
            }),
            ...(() => {
              const branchEntry = createProvisioningBranchTranscriptEntry({
                branchName,
                headSha,
                checkedOutBranch: provisioningPresentation.createdWorktree,
              });
              return branchEntry ? [branchEntry] : [];
            })(),
          ],
        },
        { broadcastChanges: ["events-appended"] },
      );
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

  private _resolveEnvironmentDaemonConnectionTargetFromRuntimeEnv():
    | EnvironmentDaemonConnectionTarget
    | undefined {
    const baseUrl = this.runtimeEnv.BB_ENV_DAEMON_BASE_URL?.trim();
    if (!baseUrl) {
      return undefined;
    }
    const authToken = this.runtimeEnv.BB_ENV_DAEMON_AUTH_TOKEN?.trim();
    return {
      transport: "http",
      baseUrl: baseUrl.replace(/\/+$/, ""),
      ...(authToken
        ? {
            headers: {
              authorization: `Bearer ${authToken}`,
            },
          }
        : {}),
    };
  }

  private _resolvePersistedProviderThreadId(threadId: string): string | undefined {
    const indexedLookup = this.eventRepo.getLatestProviderThreadId(threadId);
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

  private _resolvePersistedProviderThreadResumePath(
    threadId: string,
  ): string | undefined {
    const startedEvent = this.eventRepo.getLatestByType(threadId, "thread/started");
    if (!startedEvent) return undefined;
    const payload = toRecord(unwrapProviderEventPayload(startedEvent.data) ?? startedEvent.data);
    return getStringField(toRecord(payload?.thread), "path") ?? undefined;
  }

  private _resolvePersistedThreadStartBaseInstructions(
    threadId: string,
  ): string | undefined {
    const startEvent = this.eventRepo.getLatestByType(threadId, "client/thread/start");
    if (!startEvent) return undefined;
    const startData = toRecord(startEvent.data);
    const request = toRecord(startData?.request);
    const params = toRecord(request?.params);
    return getStringField(params, "baseInstructions") ?? undefined;
  }

  private _resolvePersistedActiveTurnId(threadId: string): string | undefined {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      return undefined;
    }
    if (thread && thread.status !== "active") {
      return undefined;
    }

    const latestLifecycle = this.eventRepo.getLatestTurnLifecycle(threadId);
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
      const normalizedType = this._getAgentServerForThread(thread).normalizeEventType(method);
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
    const inMemoryThreadId = this.providerThreadIdByThreadId.get(threadId);
    const persistedThreadId = this._resolvePersistedProviderThreadId(threadId);
    const hasActiveEnvironmentDaemonSession =
      this.environmentDaemonCommandDispatcher?.hasActiveSession(threadId) ?? false;

    if (
      inMemoryThreadId &&
      persistedThreadId &&
      persistedThreadId !== inMemoryThreadId
    ) {
      this.providerThreadIdByThreadId.delete(threadId);
    }

    if (
      inMemoryThreadId &&
      (!persistedThreadId || persistedThreadId === inMemoryThreadId) &&
      (!this.environmentDaemonCommandDispatcher || hasActiveEnvironmentDaemonSession)
    ) {
      return inMemoryThreadId;
    }
    if (inMemoryThreadId && this.environmentDaemonCommandDispatcher) {
      this.providerThreadIdByThreadId.delete(threadId);
    }

    const resumePath = this._resolvePersistedProviderThreadResumePath(threadId);
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
    if (!persistedThreadId) {
      throw inactiveSessionError(
        this._getAgentServerForThread(thread).getInactiveSessionMessage(threadId),
      );
    }

    let lastResumeError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const resumed = await this._withEnvironmentDaemonAccess(
          threadId,
          async ({ client, thread: latestThread, providerLaunch }) =>
            this._getAgentServerForThread(latestThread).resumeThreadCommand({
              client,
              threadId,
              projectId: latestThread.projectId,
              providerThreadId: persistedThreadId,
              context: this._buildProviderThreadContext({
                threadId,
                projectId: latestThread.projectId,
              }),
              options,
              resumePath,
              providerLaunch,
              dynamicTools: latestThread.type === "manager"
                ? this.providerToolHost?.listTools()
                : undefined,
            }),
        );
        this.providerThreadIdByThreadId.set(threadId, resumed.providerThreadId);
        return resumed.providerThreadId;
      } catch (err) {
        lastResumeError = err;
        const lostSession =
          err instanceof ProviderSessionError &&
          (err.code === "inactive_session" || err.code === "provider_unavailable");
        if (lostSession) {
          await this._cleanupThreadRuntimeAndWait(threadId, {
            retireActiveSession: true,
          });
        } else {
          this._cleanupThreadRuntime(threadId);
        }
        const resumeTimedOut =
          (isDomainError(err) && err.code === "provider_timeout") ||
          (err instanceof ProviderSessionError && err.code === "provider_timeout");
        if (
          !lostSession &&
          !this._getAgentServerForThread(thread).isMissingProviderThreadError(err) &&
          !resumeTimedOut
        ) {
          this._rethrowAgentServerError(threadId, err);
          throw err;
        }
        if (lostSession && attempt === 0) {
          continue;
        }
        if (resumeTimedOut && attempt === 0) {
          continue;
        }
        break;
      }
    }

    // Resume can fail when provider-side rollout state has been evicted.
    // Allow one timeout-only retry in case the env-daemon handoff was transient,
    // then fall back to fresh provisioning so the pending tell can continue.
    await this._provisionThread(
      threadId,
      {
        projectId: thread.projectId,
        model: options?.model,
        serviceTier: options?.serviceTier,
        reasoningLevel: options?.reasoningLevel,
        sandboxMode: options?.sandboxMode,
        environmentId: this._resolveThreadEnvironmentReference(threadId),
      },
      {
        rootPathHint: project.rootPath,
        reason: "resume-missing-provider-thread",
      },
    );
    const reprovisionedThreadId =
      this.providerThreadIdByThreadId.get(threadId) ??
      this._resolvePersistedProviderThreadId(threadId);
    if (reprovisionedThreadId) return reprovisionedThreadId;
    if (lastResumeError !== undefined) {
      throw lastResumeError;
    }
    throw inactiveSessionError(
      this._getAgentServerForThread(thread).getInactiveSessionMessage(threadId),
    );
  }

  private async _restartProviderThreadAfterMissingTurnStart(
    threadId: string,
    options?: PromptExecutionOptions,
  ): Promise<string> {
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

    const defaultOptions = this.getDefaultExecutionOptions(threadId);
    const runtimeEnvironment =
      this.environmentService.getEnvironmentRuntime(threadId)?.environment;
    const developerInstructions =
      this._resolvePersistedThreadStartBaseInstructions(threadId) ??
      this._buildDeveloperInstructions({
        projectInstructions: project.projectInstructions,
        environment: runtimeEnvironment,
      });
    const request: SpawnThreadRequest = {
      projectId: thread.projectId,
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(options?.model ?? defaultOptions?.model
        ? { model: options?.model ?? defaultOptions?.model }
        : {}),
      ...(options?.serviceTier ?? defaultOptions?.serviceTier
        ? { serviceTier: options?.serviceTier ?? defaultOptions?.serviceTier }
        : {}),
      ...(options?.reasoningLevel ?? defaultOptions?.reasoningLevel
        ? {
            reasoningLevel:
              options?.reasoningLevel ?? defaultOptions?.reasoningLevel,
          }
        : {}),
      ...(options?.sandboxMode ?? defaultOptions?.sandboxMode
        ? { sandboxMode: options?.sandboxMode ?? defaultOptions?.sandboxMode }
        : {}),
      environmentId: this._resolveThreadEnvironmentReference(threadId),
    };
    const providerContext = this._buildProviderThreadContext({
      threadId,
      projectId: thread.projectId,
    });
    const access = await this._ensureEnvironmentDaemonAccess(threadId);
    const started = await this._withEnvironmentDaemonTarget({
      thread: access.thread,
      projectRootPath: access.projectRootPath,
      target: access.target,
      action: async ({ client, providerLaunch }) =>
        this._getAgentServerForThread(thread).startThreadCommand({
          client,
          threadId,
          projectId: thread.projectId,
          request,
          context: providerContext,
          providerLaunch,
        }),
    });
    this.providerThreadIdByThreadId.set(threadId, started.providerThreadId);
    return started.providerThreadId;
  }

  private async _sendTurnCommandWithStaleProviderRetry(args: {
    threadId: string;
    projectId: string;
    providerThreadId: string;
    activeTurnId?: string;
    input: PromptInput[];
    options?: PromptExecutionOptions;
    mode: "auto" | "steer" | "start";
  }): Promise<string> {
    const agentServer = this._getAgentServerForThreadId(args.threadId);
    const sendTurn = async (providerThreadId: string): Promise<void> => {
      await this._withEnvironmentDaemonAccess(args.threadId, async ({ client, providerLaunch }) => {
        await agentServer.sendTurnCommand({
          client,
          threadId: args.threadId,
          providerThreadId,
          activeTurnId: args.activeTurnId,
          input: args.input,
          options: args.options,
          mode: args.mode,
          context: this._buildProviderThreadContext({
            threadId: args.threadId,
            projectId: args.projectId,
          }),
          providerLaunch,
        });
      });
    };

    try {
      await sendTurn(args.providerThreadId);
      return args.providerThreadId;
    } catch (error) {
      if (
        error instanceof ProviderSessionError &&
        (error.code === "inactive_session" || error.code === "provider_unavailable") &&
        !args.activeTurnId
      ) {
        await this._recoverEnvironmentDaemonAccess(args.threadId);
        try {
          await sendTurn(args.providerThreadId);
          return args.providerThreadId;
        } catch (recoveredError) {
          error = recoveredError;
        }
      }
      if (
        !agentServer.isMissingProviderThreadError(error) ||
        args.activeTurnId
      ) {
        throw error;
      }
      this._clearEnvironmentDaemonRuntimeState(args.threadId);
      const recoveredProviderThreadId =
        await this._restartProviderThreadAfterMissingTurnStart(
          args.threadId,
          args.options,
        );
      await sendTurn(recoveredProviderThreadId);
      return recoveredProviderThreadId;
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
      ...(resolveCliServerUrl(this.runtimeEnv.BB_SERVER_URL)
        ? { serverUrl: resolveCliServerUrl(this.runtimeEnv.BB_SERVER_URL) }
        : {}),
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
              ...(context.serverUrl
                ? { "shell_environment_policy.set.BB_SERVER_URL": context.serverUrl }
                : {}),
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
    return {
      threadId: providerThreadId,
      ...this._buildTurnRequestParams(input, options),
    };
  }

  private _buildTurnRequestedParams(
    input: PromptInput[],
    options?: ProviderExecutionOptions,
  ): Record<string, unknown> {
    return this._buildTurnRequestParams(input, options);
  }

  private _buildTurnRequestParams(
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

  private _normalizeRuntimeEnvironmentKind(value?: string): string {
    try {
      return this.environmentService.resolveRuntimeEnvironmentKind(value);
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

  private _shouldRollbackTellFailure(
    threadId: string,
    statusBeforeSend: Thread["status"],
    activeTurnIdBeforeSend: string | undefined,
    lifecycleEpochBeforeSend: number,
  ): boolean {
    if (statusBeforeSend === "active" || activeTurnIdBeforeSend) {
      return false;
    }
    if ((this.turnLifecycleEpochs.get(threadId) ?? 0) !== lifecycleEpochBeforeSend) {
      return false;
    }
    return this._resolvePersistedActiveTurnId(threadId) === undefined;
  }

  private _createTellFailureEventData(
    err: unknown,
  ): ThreadEventDataForType<"system/error"> {
    if (err instanceof ProviderSessionError) {
      switch (err.code) {
        case "inactive_session":
        case "no_active_turn":
        case "unsupported_operation":
        case "provider_rpc_error":
        case "provider_timeout":
        case "provider_unavailable":
        case "missing_provider_thread":
          return {
            code: err.code,
            message: "Failed to start turn",
            detail: err.message,
          };
        default:
          return assertNever(err.code);
      }
    }

    return {
      code: "turn_start_failed",
      message: "Failed to start turn",
      detail: this._toErrorMessage(err),
    };
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
    event: ProviderSessionNotification,
  ): void {
    const resolvedThreadId = this._resolveNotificationThreadId(threadId, event);
    if (!resolvedThreadId) {
      const providerThreadId = extractProviderThreadIdFromPersistedEventData(event.eventData);
      const providerId =
        decodeProviderEventEnvelope(event.eventData)?.__bb_provider_event.providerId;
      console.warn(
        `[thread ${threadId}] dropped provider notification: unable to resolve target thread` +
        `${providerId ? ` for provider ${providerId}` : ""}` +
        `${providerThreadId ? ` and provider thread ${providerThreadId}` : ""}`,
      );
      return;
    }
    const resolvedProviderThreadId = extractProviderThreadIdFromPersistedEventData(
      event.eventData,
    );
    if (resolvedProviderThreadId) {
      this.providerThreadIdByThreadId.set(resolvedThreadId, resolvedProviderThreadId);
    }
    if (this._shouldSuppressNotification(resolvedThreadId, event)) {
      return;
    }
    const changes: ThreadChangeKind[] = [];
    let persistedEvent: ThreadEvent | undefined;

    if (event.shouldPersist) {
      if (event.shouldBroadcast) {
        changes.push("events-appended");
      }
      persistedEvent = this._appendEvent(resolvedThreadId, event.eventType, event.eventData, {
        broadcastChanges: false,
      });
      this._maybePruneActiveThreadNoise(
        resolvedThreadId,
        event.normalizedMethod,
        persistedEvent.seq,
      );
    }

    const titleChanged = this._syncTitleFromEvent(resolvedThreadId, event);
    if (event.shouldBroadcast && titleChanged) {
      changes.push("title-changed");
    }

    const statusChanged = this._syncStatusFromEvent(resolvedThreadId, event);
    if (event.shouldBroadcast && statusChanged) {
      changes.push(...THREAD_STATUS_CHANGE_KINDS);
    }

    this._syncActiveTurnFromEvent(resolvedThreadId, event);
    if (persistedEvent) {
      this._maybeNotifyParentOnChildTurnCompletion(resolvedThreadId, persistedEvent);
    }
    if (changes.length > 0) {
      this._enqueueProviderThreadChanged(resolvedThreadId, changes);
    }
  }

  private _resolveNotificationThreadId(
    threadId: string,
    event: ProviderSessionNotification,
  ): string | undefined {
    const providerThreadId = extractProviderThreadIdFromPersistedEventData(
      event.eventData,
    );
    const providerId =
      decodeProviderEventEnvelope(event.eventData)?.__bb_provider_event.providerId;
    if (!providerThreadId) {
      return threadId;
    }

    const currentThread = this.threadRepo.getById(threadId);
    const currentProviderThreadId =
      this.providerThreadIdByThreadId.get(threadId) ??
      this._resolvePersistedProviderThreadId(threadId);
    const currentThreadMatches =
      currentProviderThreadId === providerThreadId &&
      (!providerId || currentThread?.providerId === providerId);

    const attachedEnvironmentId = this.threadEnvironmentAttachmentRepo
      ?.getByThreadId(threadId)
      ?.environmentId;
    if (!attachedEnvironmentId || !this.threadEnvironmentAttachmentRepo) {
      return currentThreadMatches ? threadId : undefined;
    }

    const providerScopedThreadIds: string[] = [];
    const matchingThreadIds: string[] = [];
    for (const attachment of this.threadEnvironmentAttachmentRepo.listByEnvironmentId(
      attachedEnvironmentId,
    )) {
      const candidateThreadId = attachment.threadId;
      const candidateThread = this.threadRepo.getById(candidateThreadId);
      if (providerId && candidateThread?.providerId !== providerId) {
        continue;
      }
      providerScopedThreadIds.push(candidateThreadId);
      const candidateProviderThreadId =
        this.providerThreadIdByThreadId.get(candidateThreadId) ??
        this._resolvePersistedProviderThreadId(candidateThreadId);
      if (candidateProviderThreadId === providerThreadId) {
        matchingThreadIds.push(candidateThreadId);
      }
    }

    if (
      matchingThreadIds.length === 0 &&
      currentThreadMatches
    ) {
      return threadId;
    }
    if (matchingThreadIds.length === 0 && providerScopedThreadIds.length === 1) {
      return providerScopedThreadIds[0];
    }
    return matchingThreadIds.length === 1 ? matchingThreadIds[0] : undefined;
  }

  private _suppressTurnId(threadId: string, turnId: string): void {
    let suppressed = this.suppressedTurnIdsByThreadId.get(threadId);
    if (!suppressed) {
      suppressed = new Set<string>();
      this.suppressedTurnIdsByThreadId.set(threadId, suppressed);
    }
    suppressed.add(turnId);
  }

  private _blockProviderNotifications(threadId: string): void {
    this.blockedProviderNotificationsByThreadId.add(threadId);
  }

  private _unblockProviderNotifications(threadId: string): void {
    this.blockedProviderNotificationsByThreadId.delete(threadId);
  }

  private _clearSuppressedTurnId(threadId: string, turnId: string): void {
    const suppressed = this.suppressedTurnIdsByThreadId.get(threadId);
    if (!suppressed) return;
    suppressed.delete(turnId);
    if (suppressed.size === 0) {
      this.suppressedTurnIdsByThreadId.delete(threadId);
    }
  }

  private _shouldSuppressNotification(
    threadId: string,
    event: ProviderSessionNotification,
  ): boolean {
    if (this.blockedProviderNotificationsByThreadId.has(threadId)) {
      return true;
    }
    const turnId = event.turnId ?? this._extractTurnIdFromEventData(event.eventData);
    if (!turnId) {
      return false;
    }
    const suppressed = this.suppressedTurnIdsByThreadId.get(threadId);
    if (!suppressed?.has(turnId)) {
      return false;
    }
    if (event.normalizedMethod === "turn/completed" || event.normalizedMethod === "turn/end") {
      this._clearSuppressedTurnId(threadId, turnId);
    }
    return true;
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

  private _discardQueuedProviderThreadChanged(threadId: string): void {
    const queued = this.queuedProviderBroadcastsByThread.get(threadId);
    if (!queued) return;
    if (queued.timer !== null) {
      clearTimeout(queued.timer);
    }
    this.queuedProviderBroadcastsByThread.delete(threadId);
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
    opts: {
      broadcastChanges: readonly ThreadChangeKind[] | false;
      connection?: DbExecutor;
    },
  ): ThreadEvent {
    const seq = this._nextEventSeq(threadId, opts?.connection);
    const created = opts?.connection
      ? this.eventRepo.create(
          {
            threadId,
            seq,
            type,
            data,
          },
          { connection: opts.connection },
        )
      : this.eventRepo.create({
          threadId,
          seq,
          type,
          data,
        });
    this.timelineByThread.delete(threadId);
    this._cacheProvisioningStateFromEvent(threadId, type, data);
    const broadcastChanges = opts.broadcastChanges;
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
      case "provisioned":
        return "Thread provisioning is in progress";
      case "provisioning_failed":
        return "Thread provisioning failed; reprovision the thread before requesting actions";
      case "error":
        return "Thread execution failed because its live environment-daemon was lost; send a follow-up to recover";
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
    const primaryCheckoutActive =
      activePromotion !== undefined &&
      this._resolveThreadEnvironmentReference(args.thread.id) === activePromotion.environmentId;
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
      if (args.thread.status === "active") return "Wait for the current turn to finish";
      if (!environment) return environmentReason;
      if (!isGitWorkspace) return "Commit is only available inside a git repository";
      if (!workStatus?.hasUncommittedChanges) return "No uncommitted changes to commit";
      return undefined;
    })();

    const squashDisabledReason = (() => {
      if (statusReason) return statusReason;
      if (args.thread.status === "active") return "Wait for the current turn to finish";
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
      if (!this._hasIsolatedThreadWorkspace(args.thread) || !environment.supportsPromoteToActiveWorkspace()) {
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
        queuesWhenActive: false,
        requiresDemoteFirst: false,
      }),
      this._threadBuiltInAction("squash_merge", {
        label: "Squash merge",
        available: squashDisabledReason === undefined,
        disabledReason: squashDisabledReason,
        queuesWhenActive: false,
        requiresDemoteFirst: false,
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

  private async _shouldAutoArchiveThreadAsync(args: {
    thread: Thread;
    projectRootPath: string;
    environment: IEnvironment;
    mergeBaseBranch?: string;
    requested?: boolean;
    hadMeaningfulBranchWork?: boolean;
  }): Promise<boolean> {
    if (args.requested !== true) {
      return false;
    }

    const defaultBranch =
      detectProjectDefaultBranch(args.projectRootPath) ??
      await detectProjectDefaultBranchAsync(args.projectRootPath);
    const status = await args.environment.getWorkspaceStatus({
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
      args.hadMeaningfulBranchWork === true || status.behindCount > 0;
    if (!hadMeaningfulBranchWork) {
      return false;
    }

    return !status.hasUncommittedChanges && !status.hasCommittedUnmergedChanges;
  }

  private _appendOperationEvent(
    threadId: string,
    operation: string,
    status: string,
    args: { message: string; operationId?: string; metadata?: Record<string, unknown> },
  ): void {
    this._appendEvent(
      threadId,
      "system/operation",
      {
        operation,
        status,
        message: args.message,
        ...(args.operationId ? { operationId: args.operationId } : {}),
        ...(args.metadata ? { metadata: args.metadata } : {}),
      },
      { broadcastChanges: ["events-appended"] },
    );
  }

  private async _runWithPrimaryCheckoutTransitionLock<T>(
    projectId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this._runWithProjectGitMutationLock(
      projectId,
      "Another primary-checkout promotion/demotion operation is already in progress for this project",
      fn,
    );
  }

  private async _runWithProjectGitMutationLock<T>(
    projectId: string,
    message: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.primaryCheckoutTransitionsInFlight.has(projectId)) {
      throw invalidRequestError(message);
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
      return this._withDerivedThreadState(hydrated);
    }

    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment) {
      const hydrated: Thread = {
        ...thread,
        builtInActions: this._buildThreadBuiltInActions({ thread }),
        ...(provisioningState ? { provisioningState } : {}),
      };
      return this._withDerivedThreadState(hydrated);
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
      return this._withDerivedThreadState(hydrated);
    }
    const hydrated: Thread = {
      ...thread,
      builtInActions: this._buildThreadBuiltInActions({
        thread,
        environment,
      }),
      ...(provisioningState ? { provisioningState } : {}),
    };
    return this._withDerivedThreadState(hydrated);
  }

  private async _hydrateThreadStateAsync(
    thread: Thread,
    opts?: { mergeBaseBranch?: string },
  ): Promise<Thread> {
    const provisioningState = this._readProvisioningState(thread.id);
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      const hydrated: Thread = provisioningState
        ? {
            ...thread,
            provisioningState,
          }
        : thread;
      return this._withDerivedThreadState(hydrated);
    }

    const environment = this._restoreThreadEnvironment(thread, project.rootPath);
    if (!environment) {
      const hydrated: Thread = {
        ...thread,
        builtInActions: this._buildThreadBuiltInActions({ thread }),
        ...(provisioningState ? { provisioningState } : {}),
      };
      return this._withDerivedThreadState(hydrated);
    }
    if (this._shouldForceDeletedWorkStatus(thread)) {
      const deletedWorkStatus = this._buildDeletedWorkStatus();
      const hydrated: Thread = {
        ...thread,
        workStatus: deletedWorkStatus,
        builtInActions: this._buildThreadBuiltInActions({
          thread,
          environment,
          workStatus: deletedWorkStatus,
        }),
        ...(provisioningState ? { provisioningState } : {}),
      };
      return this._withDerivedThreadState(hydrated);
    }
    const defaultBranch =
      detectProjectDefaultBranch(project.rootPath) ??
      await detectProjectDefaultBranchAsync(project.rootPath);
    const resolvedMergeBaseBranch = this._resolveThreadMergeBaseBranch(
      thread,
      opts?.mergeBaseBranch,
    );
    const workspaceStatus = await environment.getWorkspaceStatus({
      defaultBranch,
      mergeBaseBranch: resolvedMergeBaseBranch,
    });
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
    return this._withDerivedThreadState(hydrated);
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

  private _withDerivedThreadState(thread: Thread): Thread {
    return this._withPrimaryCheckoutState(this._withResolvedEnvironmentReference(thread));
  }

  private _withResolvedEnvironmentReference(thread: Thread): Thread {
    const attachedEnvironmentId = this._resolveThreadEnvironmentReference(thread.id);
    if (!this.threadEnvironmentAttachmentRepo) {
      return !attachedEnvironmentId || thread.environmentId === attachedEnvironmentId
        ? thread
        : {
            ...thread,
            environmentId: attachedEnvironmentId,
          };
    }
    if (thread.environmentId === attachedEnvironmentId) {
      return thread;
    }
    return {
      ...thread,
      environmentId: attachedEnvironmentId,
    };
  }

  private _withPrimaryCheckoutState(thread: Thread): Thread {
    this._ensurePrimaryPromotionStateIsCurrent(thread.projectId);
    const activePromotion = this.primaryPromotionByProjectId.get(thread.projectId);
    const isActivePrimary =
      activePromotion !== undefined &&
      this._resolveThreadEnvironmentReference(thread.id) === activePromotion.environmentId;
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

  private _withDefaultExecutionOptions(thread: Thread): Thread {
    const defaultExecutionOptions = this.eventRepo.getLatestExecutionOptions(thread.id);
    if (!defaultExecutionOptions) {
      return thread;
    }
    return {
      ...thread,
      defaultExecutionOptions,
    };
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
      const fallbackReason = (() => {
        const transcript = Array.isArray(eventData?.transcript) ? eventData.transcript : [];
        for (const entry of transcript) {
          const record = toRecord(entry);
          if (getStringField(record, "key") !== "fallback") {
            continue;
          }
          return getStringField(record, "text");
        }
        return undefined;
      })();
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

  private _nextEventSeq(threadId: string, connection?: DbExecutor): number {
    const current =
      this.eventSeqCounters.get(threadId) ??
      this.eventRepo.getLatestSeq(threadId, { connection });
    const next = current + 1;
    this.eventSeqCounters.set(threadId, next);
    return next;
  }

  private _persistOutboundStartEvent(
    threadId: string,
    type: "client/thread/start" | "client/turn/requested" | "client/turn/start",
    params: Record<string, unknown>,
    input: PromptInput[] | undefined,
    meta: { source: "spawn" | "tell"; initiator: ThreadTurnInitiator },
    opts?: {
      broadcastChanges: readonly ThreadChangeKind[] | false;
      connection?: DbExecutor;
    },
  ): ThreadEvent {
    if (type === "client/thread/start" && !this.titleFallbackByThreadId.has(threadId)) {
      const fallback = this._derivePromptFallbackTitle(input);
      if (fallback) {
        this.titleFallbackByThreadId.set(threadId, fallback);
      }
    }

    const eventData = this._buildOutboundStartEventData(type, params, input, meta);
    return this._appendEvent(
      threadId,
      type,
      eventData,
      opts ?? { broadcastChanges: ["events-appended"] },
    );
  }

  private _buildOutboundStartEventData(
    type: "client/thread/start" | "client/turn/requested" | "client/turn/start",
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
    type: "client/thread/start" | "client/turn/requested" | "client/turn/start",
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
    const childThread = this.threadRepo.getById(childThreadId);
    if (!childThread) return;
    const normalizedType = this._getAgentServerForThread(childThread).normalizeEventType(
      eventMethod,
    );
    if (normalizedType !== "turn/completed" && normalizedType !== "turn/end") {
      return;
    }
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
    const title = childThread.title?.trim();
    const titleSuffix = title ? ` (${title})` : "";
    return renderTemplate("systemMessageManagedThreadComplete", {
      threadId: childThread.id,
      titleSuffix,
    });
  }

  private _extractExecutionOptionsFromParams(
    type: "client/thread/start" | "client/turn/requested" | "client/turn/start",
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
      case "client/turn/requested":
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
    this.eventSeqCounters.delete(threadId);
    this.lastNotifiedCompletionTurnIds.delete(threadId);
    this.turnLifecycleEpochs.delete(threadId);
    this.activeTurnIdByThreadId.delete(threadId);
    this.blockedProviderNotificationsByThreadId.delete(threadId);
    this.lastNotifiedCompletionEpochs.delete(threadId);
    this._detachEnvironmentRuntime(threadId);

    const thread = this.threadRepo.getById(threadId);
    if (!thread) return;

    let statusChanged = false;
    if (thread.status === "active") {
      statusChanged = this._setThreadStatus(threadId, "error", false);
      this._appendEvent(
        threadId,
        "system/error",
        {
          code: "provider_unavailable",
          message: "The live environment-daemon exited while the thread was active.",
        },
        { broadcastChanges: false },
      );
    } else if (
      thread.status === "created" ||
      thread.status === "provisioning" ||
      thread.status === "provisioned"
    ) {
      statusChanged = this._setThreadStatus(threadId, "provisioning_failed", false);
      this._appendEvent(
        threadId,
        "system/error",
        {
          code: "provider_unavailable",
          message: "The live environment-daemon exited before thread provisioning completed.",
        },
        { broadcastChanges: false },
      );
    }

    if (statusChanged) {
      this._broadcastThreadChanged(threadId, [...THREAD_STATUS_CHANGE_KINDS, "events-appended"]);
    }
  }

  private _syncStatusFromEvent(
    threadId: string,
    event: ProviderSessionNotification,
  ): boolean {
    const nextStatus = event.nextStatus;
    if (!nextStatus) return false;
    return this._setThreadStatus(threadId, nextStatus, false);
  }

  private _syncActiveTurnFromEvent(
    threadId: string,
    event: ProviderSessionNotification,
  ): void {
    const state = event.turnState;
    if (state === "active") {
      const nextEpoch = (this.turnLifecycleEpochs.get(threadId) ?? 0) + 1;
      this.turnLifecycleEpochs.set(threadId, nextEpoch);
      if (event.turnId) {
        this.activeTurnIdByThreadId.set(threadId, event.turnId);
      }
      return;
    }
    if (state === "idle") {
      this.activeTurnIdByThreadId.delete(threadId);
    }
  }

  private _syncTitleFromEvent(
    threadId: string,
    event: ProviderSessionNotification,
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
    if (!(error instanceof ProviderSessionError)) {
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
    try {
      const removed = this.eventRepo.pruneHistoricalNoiseByThread(
        threadId,
        keepRecent,
      );
      if (removed > 0) {
        this.timelineByThread.delete(threadId);
        this.eventRepo.reclaimStorageIfNeeded({ minFreelistPages: 2_048 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[thread ${threadId}] failed to prune historical noise events: ${message}`);
    }
  }

  private _hasQueuedWork(thread: Thread): boolean {
    return Array.isArray(thread.queuedMessages) && thread.queuedMessages.length > 0;
  }

  private _setThreadStatus(
    threadId: string,
    nextStatus: Thread["status"],
    shouldBroadcast = true,
    opts?: { force?: boolean; touchUpdatedAt?: boolean; connection?: DbExecutor },
  ): boolean {
    const updateOpts: { touchUpdatedAt?: boolean; connection?: DbExecutor } = {};
    if (opts?.touchUpdatedAt !== undefined) updateOpts.touchUpdatedAt = opts.touchUpdatedAt;
    if (opts?.connection) updateOpts.connection = opts.connection;
    const hasUpdateOpts = Object.keys(updateOpts).length > 0;

    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      if (!opts?.force) return false;
      if (hasUpdateOpts) {
        this.threadRepo.update(threadId, { status: nextStatus }, updateOpts);
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
      if (!this._hasQueuedWork(thread)) {
        this._cleanupThreadRuntime(threadId);
      }
    }

    if (hasUpdateOpts) {
      this.threadRepo.update(threadId, { status: nextStatus }, updateOpts);
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
    const hasNonEventChange = uniqueChanges.some(
      (change) => change !== "events-appended",
    );
    if (hasNonEventChange) {
      this._flushQueuedProviderThreadChanged(threadId);
    }
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
        this._getAgentServerForThread(threadBeforeUpdate).deriveThreadTitle(input) ??
        this._derivePromptFallbackTitle(input);
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
    providerThreadId: string,
    title: string,
  ): void {
    void this._withEnvironmentDaemonAccess(
      threadId,
      async ({ client, thread, providerLaunch }) => {
        await this._getAgentServerForThread(thread).renameThreadCommand({
          client,
          threadId,
          providerThreadId,
          title,
          context: this._buildProviderThreadContext({
            threadId,
            projectId: thread.projectId,
          }),
          providerLaunch,
        });
      },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[thread ${threadId}] Failed to rename provider thread: ${message}`);
    });
  }

  private _normalizeThreadTitle(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;

    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    if (normalized.length <= 60) return normalized;
    return `${normalized.slice(0, 57).trimEnd()}...`;
  }

  private _normalizeThreadMergeBaseBranch(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string") return undefined;

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private _resolveThreadMergeBaseBranch(
    thread: Thread,
    requestedMergeBaseBranch?: string,
  ): string | undefined {
    return this._normalizeThreadMergeBaseBranch(requestedMergeBaseBranch) ??
      this._normalizeThreadMergeBaseBranch(thread.mergeBaseBranch);
  }

  private _normalizePromptInputForProvider(
    providerId: string,
    input: PromptInput[],
  ): PromptInput[] {
    return this._getAgentServerForProviderId(providerId).normalizePromptInput(input);
  }

  private _latestTurnLifecycleStatus(
    threadId: string,
  ): Thread["status"] | undefined {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) {
      return undefined;
    }
    const latestLifecycle = this.eventRepo.getLatestTurnLifecycle(threadId);
    if (latestLifecycle) {
      const state = toTurnLifecycleState(latestLifecycle.normType);
      if (state) return state;
    }

    const events = this.eventRepo.listByThread(threadId) ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const method = resolveProviderEventMethod(events[i].type, events[i].data);
      const normalizedType = this._getAgentServerForThread(thread).normalizeEventType(method);
      const state = toTurnLifecycleState(normalizedType);
      if (state) return state;
    }
    return undefined;
  }

}
