import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  assertNever,
  createProviderEventEnvelope,
  extractProviderThreadIdFromPersistedEventData,
  extractTurnIdFromPersistedEventData,
  getStringField,
  resolveProviderEventMethod,
  buildThreadDetailRows,
  extractThreadContextWindowUsage,
  toRecord,
  toUIMessages,
  unwrapProviderEventPayload,
  type AvailableModel,
  type EnvironmentAdapter,
  type EnvironmentInstructionsContext,
  type EnvironmentProvisioningEvent,
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
  type ThreadWorkStatus,
  type Thread,
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
import { ThreadGitStatusService, type GitCheckoutSnapshot } from "./thread-git-status.js";
import { ThreadAttributedDiffService } from "./thread-attributed-diff.js";
import {
  evaluateThreadOperationPolicy,
} from "./thread-operation-policy.js";

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

interface PrimaryPromotionState {
  projectId: string;
  threadId: string;
  promotedAt: number;
  previousCheckout?: GitCheckoutSnapshot;
  promotedCheckout: GitCheckoutSnapshot;
  reconstructed: boolean;
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

const PRIMARY_CHECKOUT_VALIDATION_TTL_MS = 2_000;
const IDLE_NOISE_EVENT_KEEP_RECENT = 300;
const ARCHIVED_NOISE_EVENT_KEEP_RECENT = 120;
const ACTIVE_NOISE_EVENT_KEEP_RECENT = 1_000;
const ACTIVE_NOISE_PRUNE_MIN_SEQ_DELTA = 250;
const ACTIVE_NOISE_PRUNE_MIN_INTERVAL_MS = 30_000;
const PRUNABLE_NOISE_EVENT_TYPES: readonly string[] = [
  "account/ratelimits/updated",
  "thread/tokenusage/updated",
  "item/reasoning/summarypartadded",
  "turn/diff/updated",
];

function checkoutSnapshotsMatch(
  left: GitCheckoutSnapshot,
  right: GitCheckoutSnapshot,
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

function resolveGitHeadPath(repoRoot: string): string | undefined {
  const dotGitPath = join(repoRoot, ".git");
  try {
    const dotGitStat = lstatSync(dotGitPath);
    if (dotGitStat.isDirectory()) {
      return join(dotGitPath, "HEAD");
    }
    if (!dotGitStat.isFile()) {
      return undefined;
    }

    const gitFileContents = readFileSync(dotGitPath, "utf-8");
    const firstLine = gitFileContents.split("\n")[0]?.trim() ?? "";
    const normalizedLine = firstLine.toLowerCase();
    if (!normalizedLine.startsWith("gitdir:")) {
      return undefined;
    }
    const relativeGitDir = firstLine.slice("gitdir:".length).trim();
    if (relativeGitDir.length === 0) {
      return undefined;
    }
    const gitDir = resolve(repoRoot, relativeGitDir);
    return join(gitDir, "HEAD");
  } catch {
    return undefined;
  }
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

function normalizeQueuedSandboxMode(
  value: SandboxMode | undefined,
): SandboxMode {
  return value ?? "danger-full-access";
}

function isAutoArchiveOnSuccessEnabled(args: {
  autoArchiveOnSuccess?: boolean;
}): boolean {
  return args.autoArchiveOnSuccess !== false;
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
  /** Ensure automatic title generation is attempted at most once per thread. */
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
  /** Last event sequence where historical noise pruning ran for an active thread. */
  private lastNoisePruneSeqByThread = new Map<string, number>();
  /** Last wall-clock timestamp where historical noise pruning ran for an active thread. */
  private lastNoisePruneAtByThread = new Map<string, number>();
  /** Memoized timeline projection per thread until event sequence or thread status changes. */
  private timelineByThread = new Map<string, ThreadTimelineCacheEntry>();
  /** Cached prompt-derived fallback titles for untitled threads. */
  private titleFallbackByThreadId = new Map<string, string | null>();
  /** Per-project in-memory primary-checkout promotion status. */
  private primaryPromotionByProjectId = new Map<string, PrimaryPromotionState>();
  /** Last successful external validation timestamp for active primary-checkout state. */
  private primaryPromotionValidatedAtByProjectId = new Map<string, number>();
  /** Filesystem watchers keyed by project while primary checkout is active. */
  private primaryPromotionWatchersByProjectId = new Map<string, ReturnType<typeof watch>>();
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
  private workspaceCleanupInFlightThreadIds = new Set<string>();
  private operationIdCounter = 0;
  private rpcIdCounter = 0;
  private threadShellPath: string | undefined;
  private providerCatalog: SystemProviderInfo[];
  private environmentCatalog: SystemEnvironmentInfo[];
  private gitStatusService: ThreadGitStatusService;
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
    gitStatusService?: ThreadGitStatusService,
  ) {
    this.threadShellPath = resolveThreadShellPath(this.runtimeEnv.PATH);
    this.gitStatusService = gitStatusService ?? new ThreadGitStatusService();
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
    const shouldRemainActive = latestLifecycle === "active";

    if (!project || !providerThreadId || !shouldRemainActive) {
      this._setThreadStatus(thread.id, "idle", true, { touchUpdatedAt: false });
      return;
    }

    try {
      const environmentAdapter = this._resolveThreadEnvironmentAdapter({
        thread,
      });
      await this._spawnProcess(thread.id, project.rootPath, environmentAdapter);
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
      this._setThreadStatus(thread.id, "idle", true, { touchUpdatedAt: false });
    }
  }

  private _rebuildPrimaryPromotionStateFromGit(): void {
    this._stopAllPrimaryPromotionWatches();
    this.primaryPromotionByProjectId.clear();
    this.primaryPromotionValidatedAtByProjectId.clear();
    const projects = this.projectRepo.list();
    if (!Array.isArray(projects) || projects.length === 0) return;
    const allThreads = this.threadRepo.list({ includeArchived: true });
    if (!Array.isArray(allThreads) || allThreads.length === 0) return;

    for (const project of projects) {
      let projectCheckout: GitCheckoutSnapshot;
      try {
        projectCheckout = this.gitStatusService.resolveCheckoutSnapshot(project.rootPath);
      } catch {
        continue;
      }

      const projectThreads = allThreads.filter((thread) => {
        return (
          thread.projectId === project.id &&
          thread.environmentId === "worktree" &&
          thread.archivedAt === undefined
        );
      });
      if (projectThreads.length === 0) continue;

      for (const thread of projectThreads) {
        const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
        if (!workspaceRoot || !existsSync(workspaceRoot) || workspaceRoot === project.rootPath) {
          continue;
        }

        let workspaceCheckout: GitCheckoutSnapshot;
        try {
          workspaceCheckout = this.gitStatusService.resolveCheckoutSnapshot(workspaceRoot);
        } catch {
          continue;
        }

        if (!checkoutSnapshotsMatch(projectCheckout, workspaceCheckout)) {
          continue;
        }

        this._setPrimaryPromotionState(project.id, {
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

  private _setPrimaryPromotionState(
    projectId: string,
    state: PrimaryPromotionState,
  ): void {
    this.primaryPromotionByProjectId.set(projectId, state);
    this.primaryPromotionValidatedAtByProjectId.set(projectId, Date.now());
    this._startPrimaryPromotionWatch(projectId);
  }

  private _clearPrimaryPromotionState(projectId: string): PrimaryPromotionState | undefined {
    const existing = this.primaryPromotionByProjectId.get(projectId);
    this.primaryPromotionByProjectId.delete(projectId);
    this.primaryPromotionValidatedAtByProjectId.delete(projectId);
    this._stopPrimaryPromotionWatch(projectId);
    return existing;
  }

  private _startPrimaryPromotionWatch(projectId: string): void {
    if (this.primaryPromotionWatchersByProjectId.has(projectId)) {
      return;
    }
    const project = this.projectRepo.getById(projectId);
    if (!project) return;
    const gitHeadPath = resolveGitHeadPath(project.rootPath);
    if (!gitHeadPath) return;
    const gitDir = dirname(gitHeadPath);

    try {
      const watcher = watch(
        gitDir,
        { persistent: false },
        (_eventType, filename) => {
          if (
            typeof filename === "string" &&
            filename.length > 0 &&
            filename !== "HEAD"
          ) {
            return;
          }
          this._ensurePrimaryPromotionStateIsCurrent(projectId, { force: true });
        },
      );
      watcher.on("error", () => {
        this._stopPrimaryPromotionWatch(projectId);
      });
      this.primaryPromotionWatchersByProjectId.set(projectId, watcher);
    } catch {
      // File watching can fail on some filesystems. Keep on-demand validation as fallback.
    }
  }

  private _stopPrimaryPromotionWatch(projectId: string): void {
    const watcher = this.primaryPromotionWatchersByProjectId.get(projectId);
    if (!watcher) {
      return;
    }
    watcher.close();
    this.primaryPromotionWatchersByProjectId.delete(projectId);
  }

  private _stopAllPrimaryPromotionWatches(): void {
    for (const watcher of this.primaryPromotionWatchersByProjectId.values()) {
      watcher.close();
    }
    this.primaryPromotionWatchersByProjectId.clear();
  }

  private _ensurePrimaryPromotionStateIsCurrent(
    projectId: string,
    opts?: { force?: boolean },
  ): void {
    const active = this.primaryPromotionByProjectId.get(projectId);
    if (!active) return;

    const now = Date.now();
    const lastValidatedAt = this.primaryPromotionValidatedAtByProjectId.get(projectId) ?? 0;
    if (!opts?.force && now - lastValidatedAt < PRIMARY_CHECKOUT_VALIDATION_TTL_MS) {
      return;
    }
    this.primaryPromotionValidatedAtByProjectId.set(projectId, now);

    const project = this.projectRepo.getById(projectId);
    if (!project) {
      this._clearPrimaryPromotionState(projectId);
      return;
    }

    let currentCheckout: GitCheckoutSnapshot;
    try {
      currentCheckout = this.gitStatusService.resolveCheckoutSnapshot(project.rootPath);
    } catch {
      return;
    }

    if (checkoutSnapshotsMatch(currentCheckout, active.promotedCheckout)) {
      return;
    }

    const cleared = this._clearPrimaryPromotionState(projectId);
    const demotedThreadId = cleared?.threadId ?? active.threadId;
    this._appendEvent(
      demotedThreadId,
      "system/primary_checkout/updated",
      {
        action: "demote",
        status: "completed",
        message: "Primary checkout changed outside Beanbag; marked as demoted",
        projectId,
        activeThreadId: demotedThreadId,
        ...(currentCheckout.branch ? { branch: currentCheckout.branch } : {}),
      },
      { broadcastChanges: ["events-appended"] },
    );
    this._broadcastThreadChanged(demotedThreadId, THREAD_STATUS_CHANGE_KINDS);
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
      { rootPathHint: project.rootPath },
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

  private async _resolveCommitMessage(args: {
    workspaceRoot: string;
    includeUnstaged?: boolean;
    explicitMessage?: string;
  }): Promise<string> {
    const explicitMessage = args.explicitMessage?.trim();
    if (explicitMessage) {
      return explicitMessage;
    }

    if (!this.provider.generateCommitMessage) {
      throw new Error("Commit message generation is unavailable");
    }

    const generated = await this.provider.generateCommitMessage({
      cwd: args.workspaceRoot,
      includeUnstaged: args.includeUnstaged,
    });
    const message = generated?.trim();
    if (!message) {
      throw new Error(
        `Failed to auto-generate commit message (${this.provider.displayName})`,
      );
    }
    return message;
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
    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    if (!workspaceRoot) {
      throw invalidRequestError(
        thread.environmentId === "worktree"
          ? "Thread worktree is unavailable; reprovision the thread first"
          : "Thread workspace is unavailable",
      );
    }

    const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
    const beforeStatus = this.gitStatusService.getStatus({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
    });
    const message = beforeStatus.hasUncommittedChanges
      ? await this._resolveCommitMessage({
          workspaceRoot,
          includeUnstaged: request?.includeUnstaged,
          explicitMessage: request?.message,
        })
      : request?.message?.trim();
    const result = this.gitStatusService.commit({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
      message,
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

    if (
      result.commitCreated &&
      thread.environmentId === "local" &&
      isAutoArchiveOnSuccessEnabled(request ?? {})
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
    if (thread.environmentId !== "worktree") {
      throw invalidRequestError("Squash merge is only available for worktree threads");
    }

    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }
    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    if (!workspaceRoot) {
      throw invalidRequestError("Thread worktree is unavailable; reprovision the thread first");
    }

    const options = request ?? {};
    const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
    const requestedMergeBaseBranch = options.mergeBaseBranch?.trim() || undefined;
    const before = this.gitStatusService.getStatus({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
      mergeBaseBranch: requestedMergeBaseBranch,
    });
    const mergeBaseBranch = before.mergeBaseBranch ?? defaultBranch;

    let committed = false;
    if (before.hasUncommittedChanges) {
      if (options.commitIfNeeded !== true) {
        throw invalidRequestError("Workspace has uncommitted changes; commit first");
      }
      const commitMessage = await this._resolveCommitMessage({
        workspaceRoot,
        includeUnstaged: options.includeUnstaged,
        explicitMessage: options.commitMessage,
      });
      const commitResult = this.gitStatusService.commit({
        workspaceRoot,
        projectRoot: project.rootPath,
        defaultBranch,
        message: commitMessage,
        includeUnstaged: options.includeUnstaged,
      });
      this._appendEvent(
        thread.id,
        "system/worktree/commit",
        {
          status: commitResult.commitCreated ? "committed" : "noop",
          message: commitResult.message,
          ...(commitResult.commitSha ? { commitSha: commitResult.commitSha } : {}),
          ...(options.includeUnstaged !== undefined
            ? { includeUnstaged: options.includeUnstaged }
            : {}),
        },
        { broadcastChanges: ["events-appended", "work-status-changed"] },
      );
      committed = commitResult.commitCreated;
    }

    const mergeResult = this.gitStatusService.squashMergeWorktreeIntoDefaultBranch({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch: mergeBaseBranch,
      message: options.squashMessage,
    });
    this.gitStatusService.invalidate(workspaceRoot);
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
        ...(mergeBaseBranch ? { mergeBaseBranch } : {}),
        ...(mergeResult.conflictFiles ? { conflictFiles: mergeResult.conflictFiles } : {}),
      },
      { broadcastChanges: ["events-appended", "work-status-changed"] },
    );

    if (mergeResult.merged && isAutoArchiveOnSuccessEnabled(options)) {
      this.archive(thread.id);
    }

    return { message: mergeResult.message };
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
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    this._cleanupEnvironmentSession(threadId);
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
    this._invalidateThreadWorkStatus(thread);
    this.queuedOperationsByThreadId.delete(threadId);
    this.operationDispatchInFlight.delete(threadId);

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
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    const activePromotion = this.primaryPromotionByProjectId.get(thread.projectId);
    if (activePromotion?.threadId === threadId) {
      this._clearPrimaryPromotionState(thread.projectId);
    }
    this._cleanupEnvironmentSession(threadId, { destroyWorkspace: true });
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
      const providerThreadId = this.providerThreadIds.get(threadId);
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
    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    if (!workspaceRoot) {
      throw invalidRequestError(
        thread.environmentId === "worktree"
          ? "Thread worktree is unavailable; reprovision the thread first"
          : "Thread workspace is unavailable",
      );
    }
    if (thread.environmentId === "worktree") {
      const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
      const status = this.gitStatusService.getStatus({
        workspaceRoot,
        projectRoot: project.rootPath,
        defaultBranch,
        mergeBaseBranch,
      });
      const commits = this.gitStatusService.listCommitsSinceRef({
        workspaceRoot,
        baseRef: status.baseRef,
      });
      const hasSelectedCommit =
        selection.type === "commit" &&
        commits.some((commit) => commit.sha === selection.sha);
      const normalizedSelection: ThreadGitDiffSelection = hasSelectedCommit
        ? selection
        : { type: "combined" };
      const diffResult =
        normalizedSelection.type === "commit"
          ? this.gitStatusService.getCommitDiff({
              workspaceRoot,
              commitSha: normalizedSelection.sha,
            })
          : this.gitStatusService.getCombinedDiffSinceRef({
              workspaceRoot,
              baseRef: status.baseRef,
            });
      return {
        mode: "worktree_commits",
        workspaceRoot,
        commits,
        selection: normalizedSelection,
        diff: diffResult.diff,
        truncated: diffResult.truncated,
        ...(status.currentBranch ? { currentBranch: status.currentBranch } : {}),
        ...(status.mergeBaseBranch ? { mergeBaseBranch: status.mergeBaseBranch } : {}),
        ...(status.baseRef ? { mergeBaseRef: status.baseRef } : {}),
      };
    }

    const diffResult = this.gitStatusService.getWorkingTreeDiff(workspaceRoot);
    return {
      mode: "local_uncommitted",
      workspaceRoot,
      commits: [],
      selection: { type: "combined" },
      diff: diffResult.diff,
      truncated: diffResult.truncated,
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
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    return this._withPrimaryCheckoutState(thread);
  }

  getWorkStatus(threadId: string, mergeBaseBranch?: string) {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    return this._hydrateThreadState(thread, {
      includeAttributedDiff: true,
      mergeBaseBranch,
    }).workStatus;
  }

  async getWorkStatusAsync(
    threadId: string,
    mergeBaseBranch?: string,
  ): Promise<ThreadWorkStatus | undefined> {
    const thread = this.threadRepo.getById(threadId);
    if (!thread) return undefined;
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return undefined;

    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    if (!workspaceRoot) return undefined;
    if (this._shouldForceDeletedWorkStatus(thread)) {
      return this._buildDeletedWorkStatus(workspaceRoot);
    }

    const defaultBranch = await this.gitStatusService.detectDefaultBranchAsync(project.rootPath);
    const workspaceStatus = await this.gitStatusService.getStatusAsync({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
      mergeBaseBranch,
    });
    const workStatus = { ...workspaceStatus };

    if (thread.environmentId !== "worktree" && thread.agentDiffStats) {
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

    return workStatus;
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
    return threads.map((thread) =>
      this._hydrateThreadState(thread, { includeAttributedDiff: false })
    );
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
    if (request.operation === "squash_merge" && thread.environmentId !== "worktree") {
      throw invalidRequestError("Squash merge operations are only available for worktree threads");
    }

    const primaryPromotion = this.primaryPromotionByProjectId.get(thread.projectId);
    const policyAction = this._resolveOperationPolicyAction(request.operation);
    const policyDecision = evaluateThreadOperationPolicy(policyAction, {
      status: thread.status,
      archived: thread.archivedAt !== undefined,
      primaryCheckoutActive: primaryPromotion?.threadId === thread.id,
    });

    if (!policyDecision.allowed) {
      throw invalidRequestError(policyDecision.reason ?? "Operation is not allowed");
    }

    const operationId = this._nextOperationId();
    let demotedPrimaryCheckout = false;
    try {
      if (policyDecision.requiresDemoteFirst) {
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
        policyDecision.shouldQueue === true ||
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
    if (thread.environmentId !== "worktree") {
      throw invalidRequestError("Promotion is only available for worktree threads");
    }

    const policyDecision = evaluateThreadOperationPolicy("promote", {
      status: thread.status,
      archived: thread.archivedAt !== undefined,
      primaryCheckoutActive: false,
    });
    if (!policyDecision.allowed) {
      throw invalidRequestError(policyDecision.reason ?? "Promotion is not allowed");
    }

    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      throw projectNotFoundError(thread.projectId);
    }
    return this._runWithPrimaryCheckoutTransitionLock(project.id, async () => {
      this._ensurePrimaryPromotionStateIsCurrent(project.id, { force: true });
      const existing = this.primaryPromotionByProjectId.get(project.id);
      if (existing && existing.threadId !== thread.id) {
        throw invalidRequestError(
          `Thread ${existing.threadId} is already promoted in the primary checkout for this project`,
        );
      }

      if (existing && existing.threadId === thread.id) {
        this._appendEvent(
          thread.id,
          "system/primary_checkout/updated",
          {
            action: "promote",
            status: "noop",
            message: "Primary checkout is already promoted to this thread",
            projectId: project.id,
            activeThreadId: thread.id,
            ...(existing.promotedCheckout.branch
              ? { branch: existing.promotedCheckout.branch }
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

      const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
      if (!workspaceRoot || workspaceRoot === project.rootPath) {
        throw invalidRequestError(
          "Thread worktree path is unavailable (workspace resolved to project root); reprovision before promoting",
        );
      }
      if (!existsSync(workspaceRoot)) {
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
        const promoted = this.gitStatusService.promoteWorktreeIntoPrimary({
          workspaceRoot,
          projectRoot: project.rootPath,
        });
        const nextState: PrimaryPromotionState = {
          projectId: project.id,
          threadId: thread.id,
          promotedAt: Date.now(),
          previousCheckout: promoted.previousCheckout,
          promotedCheckout: promoted.promotedCheckout,
          reconstructed: false,
        };
        this._setPrimaryPromotionState(project.id, nextState);
        this._appendEvent(
          thread.id,
          "system/primary_checkout/updated",
          {
            action: "promote",
            status: "completed",
            message: "Primary checkout now reflects this thread worktree",
            projectId: project.id,
            activeThreadId: thread.id,
            ...(promoted.promotedCheckout.branch
              ? { branch: promoted.promotedCheckout.branch }
              : {}),
          },
          { broadcastChanges: ["events-appended"] },
        );
        this._broadcastThreadChanged(thread.id, THREAD_STATUS_CHANGE_KINDS);
        return {
          ok: true,
          promoted: true,
          message: "Primary checkout promoted",
          primaryStatus: this.getPrimaryCheckoutStatus(project.id),
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
    const policyDecision = evaluateThreadOperationPolicy("demote", {
      status: thread.status,
      archived: thread.archivedAt !== undefined,
      primaryCheckoutActive: false,
    });
    if (!policyDecision.allowed) {
      throw invalidRequestError(policyDecision.reason ?? "Demotion is not allowed");
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
        const fallbackDefaultCheckout =
          this.gitStatusService.resolveDefaultBranchCheckout(project.rootPath);
        const demoteSnapshot = active.previousCheckout ?? fallbackDefaultCheckout;
        if (!demoteSnapshot) {
          throw invalidRequestError(
            "Could not determine a branch/commit to restore. Checkout manually and retry.",
          );
        }

        this.gitStatusService.discardLocalChanges(project.rootPath);
        this.gitStatusService.checkoutSnapshot(project.rootPath, demoteSnapshot);
        this._clearPrimaryPromotionState(project.id);
        this._appendEvent(
          active.threadId,
          "system/primary_checkout/updated",
          {
            action: "demote",
            status: "completed",
            message: "Primary checkout restored from promoted state",
            projectId: project.id,
            ...(demoteSnapshot.branch ? { branch: demoteSnapshot.branch } : {}),
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
          primaryStatus: this.getPrimaryCheckoutStatus(project.id),
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
      // Shutdown/restart should not create unread noise by touching thread.updatedAt.
      this.threadRepo.update(threadId, { status: "idle" }, {
        touchUpdatedAt: false,
      });
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
    this.titleFallbackByThreadId.clear();
    this.authRefreshWarningThreadIds.clear();
    this.suppressedAuthStderrDepth.clear();
    this.provisioningTasks.clear();
    this.eventSeqCounters.clear();
    this.lastNotifiedCompletionTurnIds.clear();
    this.turnLifecycleEpochs.clear();
    this.lastNotifiedCompletionEpochs.clear();
    this._stopAllPrimaryPromotionWatches();
    this.primaryPromotionByProjectId.clear();
    this.primaryPromotionValidatedAtByProjectId.clear();
    this.queueDispatchInFlight.clear();
    this.queuedOperationsByThreadId.clear();
    this.operationDispatchInFlight.clear();
    this.projectOperationTransitionsInFlight.clear();
  }

  private _scheduleProvisioning(
    threadId: string,
    req: SpawnThreadRequest,
    opts?: { rootPathHint?: string; reason?: string },
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
    opts?: { rootPathHint?: string; reason?: string },
  ): Promise<void> {
    const thread = this.threadRepo.getById(threadId);
    if (thread?.archivedAt !== undefined) return;

    const project = this.projectRepo.getById(req.projectId);
    if (!project) {
      throw projectNotFoundError(req.projectId);
    }

    const requestedInput = req.input ?? [];
    const preProvisionDeveloperInstructions = this._buildDeveloperInstructions({
      projectWorkflowInstructions: project.workflowInstructions,
      requestDeveloperInstructions: req.developerInstructions,
    });
    const preProvisionThreadStartParams = this.provider.createThreadStartParams(
      preProvisionDeveloperInstructions
        ? { ...req, developerInstructions: preProvisionDeveloperInstructions }
        : req,
      this._buildProviderThreadContext({
        threadId,
        projectId: req.projectId,
      }),
    );
    const startSource = opts?.reason === "tell-after-provisioning-failure" ? "tell" : "spawn";
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

    const environmentRuntime = await this._spawnProcess(
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
    const providerInput = this._normalizePromptInputForProvider(requestedInput);

    const effectiveDeveloperInstructions = this._buildDeveloperInstructions({
      projectWorkflowInstructions: project.workflowInstructions,
      requestDeveloperInstructions: req.developerInstructions,
      environmentAdapter: environmentRuntime.adapter,
      environmentInstructionsContext: {
        projectId: req.projectId,
        threadId,
        projectRootPath: project.rootPath,
        workspaceRootPath: environmentRuntime.session.cwd,
        requestedEnvironmentId,
        effectiveEnvironmentId,
        mode: environmentRuntime.session.metadata?.mode,
        fallbackReason,
      },
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
    const providerThreadId = await this._sendRequestAndAwaitThreadId(
      threadId,
      this.provider.threadStartMethod,
      threadStartParams,
    );
    this.providerThreadIds.set(threadId, providerThreadId);
    const hydratedThreadAfterStart = this.threadRepo.getById(threadId);
    if (
      hydratedThreadAfterStart?.title &&
      this.lockedTitleThreadIds.has(threadId)
    ) {
      this._sendThreadNameSet(
        threadId,
        providerThreadId,
        hydratedThreadAfterStart.title,
      );
    }

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
    this.lastNoisePruneSeqByThread.delete(threadId);
    this.lastNoisePruneAtByThread.delete(threadId);
    this.queuedOperationsByThreadId.delete(threadId);
    this.operationDispatchInFlight.delete(threadId);
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
    if (runtime) {
      this.environmentRuntimes.delete(threadId);
    }
    if (!opts?.destroyWorkspace) return;
    this.workspaceCleanupInFlightThreadIds.add(threadId);
    const refreshWorkStatusAfterCleanup = () => {
      const thread = this.threadRepo.getById(threadId);
      if (!thread) return;
      this._invalidateThreadWorkStatus(thread);
      this._broadcastThreadChanged(threadId, ["work-status-changed"]);
    };
    const markWorkspaceCleanupSettled = () => {
      this.workspaceCleanupInFlightThreadIds.delete(threadId);
    };
    const reportCleanupFailure = (environmentId: string, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
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
    };

    if (!runtime) {
      const thread = this.threadRepo.getById(threadId);
      try {
        this._cleanupPersistedWorkspace(threadId);
      } catch (err) {
        reportCleanupFailure(thread?.environmentId ?? "worktree", err);
      }
      markWorkspaceCleanupSettled();
      refreshWorkStatusAfterCleanup();
      return;
    }

    const { adapter, session } = runtime;
    if (!session.cleanup) {
      markWorkspaceCleanupSettled();
      refreshWorkStatusAfterCleanup();
      return;
    }
    try {
      const maybePromise = session.cleanup();
      if (
        maybePromise &&
        typeof maybePromise === "object" &&
        "then" in maybePromise &&
        typeof maybePromise.then === "function"
      ) {
        void maybePromise
          .catch((err) => {
            reportCleanupFailure(adapter.info.id, err);
          })
          .finally(() => {
            markWorkspaceCleanupSettled();
            refreshWorkStatusAfterCleanup();
          });
        return;
      }
      markWorkspaceCleanupSettled();
      refreshWorkStatusAfterCleanup();
    } catch (err) {
      reportCleanupFailure(adapter.info.id, err);
      markWorkspaceCleanupSettled();
      refreshWorkStatusAfterCleanup();
    }
  }

  private _cleanupPersistedWorkspace(threadId: string): void {
    const thread = this.threadRepo.getById(threadId);
    if (!thread || thread.environmentId !== "worktree") {
      return;
    }
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) {
      return;
    }
    const completedProvisioning = this._readCompletedProvisioningDetails(threadId);
    const workspaceRoot = completedProvisioning?.workspaceRoot;
    if (!workspaceRoot) {
      return;
    }
    if (
      completedProvisioning.mode !== undefined &&
      completedProvisioning.mode !== "worktree"
    ) {
      return;
    }
    if (resolve(workspaceRoot) === resolve(project.rootPath)) {
      return;
    }
    this.gitStatusService.removeWorktreeWorkspace({
      projectRoot: project.rootPath,
      workspaceRoot,
    });
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

  private _appendEnvironmentProvisioningEvent(
    threadId: string,
    event: EnvironmentProvisioningEvent,
  ): void {
    this._appendEvent(threadId, "system/provisioning/env_setup", {
      status: event.status,
      scriptPath: event.scriptPath,
      ...(event.workspaceRoot ? { workspaceRoot: event.workspaceRoot } : {}),
      ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.detail ? { detail: event.detail } : {}),
    });
  }

  private async _spawnProcess(
    threadId: string,
    projectRootPath: string,
    environmentAdapter: EnvironmentAdapter,
  ): Promise<ActiveEnvironmentRuntime> {
    const thread = this.threadRepo.getById(threadId);
    const projectId = thread?.projectId;
    const prepareContext = {
      projectId: projectId ?? "",
      threadId,
      projectRootPath,
      runtimeEnv: this.runtimeEnv,
      onProvisioningEvent: (event: EnvironmentProvisioningEvent) => {
        this._appendEnvironmentProvisioningEvent(threadId, event);
      },
    };
    const environmentSession = environmentAdapter.prepareAsync
      ? await environmentAdapter.prepareAsync(prepareContext)
      : environmentAdapter.prepare(prepareContext);
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
      await this._spawnProcess(threadId, project.rootPath, environmentAdapter);
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
    environmentAdapter?: EnvironmentAdapter;
    environmentInstructionsContext?: EnvironmentInstructionsContext;
  }): string | undefined {
    const projectInstructions = args.projectWorkflowInstructions?.trim();
    const requestInstructions = args.requestDeveloperInstructions?.trim();
    const baseInstructions = [projectInstructions, requestInstructions]
      .filter((value): value is string => Boolean(value))
      .join("\n\n")
      .trim();
    const currentInstructions = baseInstructions.length > 0
      ? baseInstructions
      : undefined;
    const customizeInstructions = args.environmentAdapter?.customizeDeveloperInstructions;
    if (!customizeInstructions || !args.environmentInstructionsContext) {
      return currentInstructions;
    }
    const customized = customizeInstructions(
      currentInstructions,
      args.environmentInstructionsContext,
    )?.trim();
    return customized && customized.length > 0 ? customized : undefined;
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
    const normalizedType = this.provider.normalizeEventType(msg.method);
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
    this._maybePruneActiveThreadNoise(
      threadId,
      normalizedType,
      persistedEvent.seq,
    );

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

  private _resolveOperationPolicyAction(
    operation: ThreadOperationType,
  ): "commit" | "squash" {
    switch (operation) {
      case "commit":
        return "commit";
      case "squash_merge":
        return "squash";
      default:
        return assertNever(operation);
    }
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
    opts?: { includeAttributedDiff?: boolean; mergeBaseBranch?: string },
  ): Thread {
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return thread;

    const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
    if (!workspaceRoot) {
      const hydrated: Thread = {
        ...thread,
        provisioningState: this._readProvisioningState(thread.id),
      };
      return this._withPrimaryCheckoutState(hydrated);
    }
    if (this._shouldForceDeletedWorkStatus(thread)) {
      const hydrated: Thread = {
        ...thread,
        workStatus: this._buildDeletedWorkStatus(workspaceRoot),
        provisioningState: this._readProvisioningState(thread.id),
      };
      return this._withPrimaryCheckoutState(hydrated);
    }
    const defaultBranch = this.gitStatusService.detectDefaultBranch(project.rootPath);
    const workspaceStatus = this.gitStatusService.getStatus({
      workspaceRoot,
      projectRoot: project.rootPath,
      defaultBranch,
      mergeBaseBranch: opts?.mergeBaseBranch,
    });
    const workStatus = { ...workspaceStatus };

    if (opts?.includeAttributedDiff) {
      if (thread.environmentId !== "worktree" && thread.agentDiffStats) {
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

    const hydrated: Thread = {
      ...thread,
      workStatus,
      provisioningState: this._readProvisioningState(thread.id),
    };
    return this._withPrimaryCheckoutState(hydrated);
  }

  private _shouldForceDeletedWorkStatus(thread: Thread): boolean {
    return this.workspaceCleanupInFlightThreadIds.has(thread.id);
  }

  private _buildDeletedWorkStatus(workspaceRoot?: string): ThreadWorkStatus {
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
      ...(workspaceRoot ? { workspaceRoot } : {}),
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

  private _resolveThreadWorkspaceRoot(thread: Thread, projectRoot: string): string | undefined {
    if (thread.environmentId === "worktree") {
      const completedWorkspaceRoot = this._readCompletedProvisioningWorkspaceRoot(thread.id);
      if (!completedWorkspaceRoot) {
        return undefined;
      }
      const runtime = this.environmentRuntimes.get(thread.id);
      if (runtime?.session?.cwd) {
        return runtime.session.cwd;
      }
      return completedWorkspaceRoot;
    }

    const runtime = this.environmentRuntimes.get(thread.id);
    if (runtime?.session?.cwd) {
      return runtime.session.cwd;
    }

    const completedWorkspaceRoot = this._readCompletedProvisioningWorkspaceRoot(thread.id);
    if (completedWorkspaceRoot) {
      return completedWorkspaceRoot;
    }

    return projectRoot;
  }

  private _readCompletedProvisioningWorkspaceRoot(threadId: string): string | undefined {
    const data = this._readCompletedProvisioningDetails(threadId);
    return data?.workspaceRoot;
  }

  private _readCompletedProvisioningDetails(
    threadId: string,
  ): { workspaceRoot?: string; mode?: string } | undefined {
    const provisioningEvent = this.eventRepo.getLatestByType(
      threadId,
      "system/provisioning/completed",
    );
    if (!provisioningEvent) return undefined;
    const data = toRecord(provisioningEvent.data);
    const workspaceRoot = getStringField(data, "workspaceRoot");
    const mode = getStringField(data, "mode");
    if (!workspaceRoot && !mode) {
      return undefined;
    }
    return {
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(mode ? { mode } : {}),
    };
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
    if (!workspaceRoot) return;
    this.gitStatusService.invalidate(workspaceRoot);
  }

  private _captureAgentDiffStats(thread: Thread): void {
    const project = this.projectRepo.getById(thread.projectId);
    if (!project) return;

    if (thread.environmentId === "worktree") {
      const workspaceRoot = this._resolveThreadWorkspaceRoot(thread, project.rootPath);
      if (!workspaceRoot) return;
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
      this._captureAgentDiffStats(thread);
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

      const threadBeforeUpdate = this.threadRepo.getById(threadId);
      if (!threadBeforeUpdate) return;

      const fallbackTitle =
        this.provider.deriveThreadTitle(input) ?? this._derivePromptFallbackTitle(input);
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
