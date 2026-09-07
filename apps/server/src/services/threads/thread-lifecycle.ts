import { revokeThreadDesktopBrowserControl } from "../desktop-browsers.js";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  deleteThread,
  environments,
  events,
  getEnvironment,
  getLatestThreadInterruptedReason,
  getThread,
  listThreadIdsWithLatestHostDaemonRestartInterruption,
  listThreadTurnInterruptionEventStates,
  threads,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
} from "@bb/db";
import { assertNever } from "@bb/core-ui";
import {
  type ProvisioningTranscriptEntry,
  type SystemThreadInterruptedReason,
  type Thread,
  type ThreadEventScope,
  type ThreadEventType,
  type ThreadLifecycleEvent,
  type ThreadStatus,
  threadScope,
  turnScope,
} from "@bb/domain";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
  LoggedWorkSessionDeps,
} from "../../types.js";
import {
  requestEnvironmentCleanup,
  requestEnvironmentCleanupAdvance,
  runEnvironmentCleanupAdvance,
} from "../environments/environment-cleanup-internal.js";
import { cancelEnvironmentProvisioningForThreadStopInTransaction } from "../environments/environment-provisioning-cancellation.js";
import {
  emptyCommandResultSideEffects,
  type CommandResultFailureReportForType,
  type CommandResultPostCommitAction,
  type CommandResultSideEffectsDeps,
  type CommandResultReportForType,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
  type HostDaemonCommandForType,
} from "../../internal/command-result-side-effects.js";
import {
  appendSystemErrorEventInTransaction,
  buildSystemErrorEventData,
  appendThreadEventInTransaction,
  appendThreadEventsInTransaction,
  appendThreadInterruptedEventInTransaction,
  appendThreadProvisioningEventInTransaction,
  getActiveTurnId,
  getLastProviderThreadId,
} from "./thread-events.js";
import {
  applyLoggedThreadLifecycleEvent,
  applyLoggedThreadLifecycleEventInTransaction,
} from "./lifecycle-outcome.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildThreadStartCommand,
  buildThreadStopCommand,
  prepareTurnSubmitCommandPayload,
  dispatchArchivedThreadProviderArchiveCommand,
  dispatchThreadRenameCommand,
  type ThreadStartCommandArgs,
  type ThreadStopCommandArgs,
} from "./thread-commands.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { isHostUnavailableApiError } from "../hosts/online-rpc.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
  startLiveHostCommand,
} from "../hosts/live-command.js";
import { createAsyncDeduper } from "../lib/async-deduper.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { throwThreadNotWritable } from "../lib/lifecycle-api-errors.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { queueChildThreadTurnNotificationBestEffort } from "./child-thread-notifications.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";
import {
  forgetActiveThreadProvisionContext,
  getActiveThreadProvisionContext,
} from "./thread-provisioning-active-context.js";
import { hasProvisioningTimelineRow } from "./thread-provisioning-context.js";
import { isPreStartThreadStatus } from "./thread-status.js";
import { settleDanglingBackgroundTasksForStoppedThreadInTransaction } from "./background-task-reconciliation.js";

type ThreadStartCommand = Awaited<ReturnType<typeof buildThreadStartCommand>>;
type ThreadStopCommand = ReturnType<typeof buildThreadStopCommand>;
type ThreadPlanCancelCommand = HostDaemonCommandForType<"thread.plan.cancel">;
type TurnSubmitCommand = HostDaemonCommandForType<"turn.submit">;
type ThreadEventAppendArgs = Parameters<
  typeof appendThreadEventsInTransaction
>[1][number];

type ThreadFailureCommand = ThreadStartCommand | TurnSubmitCommand;

type ThreadFailureResultReport = CommandResultFailureReportForType<
  ThreadFailureCommand["type"]
>;
type ThreadStartCommandResultReport =
  CommandResultReportForType<"thread.start">;
type TurnSubmitCommandResultReport = CommandResultReportForType<"turn.submit">;
type ThreadStopCommandResultReport = CommandResultReportForType<"thread.stop">;
type ThreadPlanCancelCommandResultReport =
  CommandResultReportForType<"thread.plan.cancel">;

interface PreparedThreadStartCommand {
  command: ThreadStartCommand;
  mode: "thread.start";
}

interface PreparedReadyTurnSubmitCommand {
  command: TurnSubmitCommand;
  mode: "turn.submit";
}

type PreparedReadyThreadTurnCommand =
  | PreparedThreadStartCommand
  | PreparedReadyTurnSubmitCommand;

const threadStartRequestDeduper = createAsyncDeduper<string, void>();
const threadStopRequestDeduper = createAsyncDeduper<string, void>();

type InFlightThreadRpcKind =
  | "thread.start"
  | "thread.start.title-sync"
  | "thread.stop";

class InFlightRpcGuard {
  private readonly held = new Set<string>();

  private key(threadId: string, kind: InFlightThreadRpcKind): string {
    return `${kind}:${threadId}`;
  }

  claim(threadId: string, kind: InFlightThreadRpcKind): boolean {
    const key = this.key(threadId, kind);
    if (this.held.has(key)) {
      return false;
    }
    this.held.add(key);
    return true;
  }

  release(threadId: string, kind: InFlightThreadRpcKind): void {
    this.held.delete(this.key(threadId, kind));
  }

  isHeld(threadId: string, kind: InFlightThreadRpcKind): boolean {
    return this.held.has(this.key(threadId, kind));
  }
}

const inFlightThreadRpcGuard = new InFlightRpcGuard();

export function hasLiveThreadStartInFlight(threadId: string): boolean {
  return inFlightThreadRpcGuard.isHeld(threadId, "thread.start");
}

export function hasLiveThreadStopInFlight(threadId: string): boolean {
  return inFlightThreadRpcGuard.isHeld(threadId, "thread.stop");
}

interface ThreadStartSuccessActivationArgs {
  commandStartedAt: number;
  providerThreadId: string;
  threadId: string;
}

interface HasThreadInterruptedEventAtOrAfterArgs {
  createdAt: number;
  threadId: string;
}

interface HasProviderTurnCompletedEventAtOrAfterArgs {
  createdAt: number;
  providerThreadId: string;
  threadId: string;
}

interface RequestThreadStopArgs extends Omit<ThreadStopCommandArgs, "intent"> {
  interruptionReason: SystemThreadInterruptedReason;
}

const AWAITED_THREAD_STOP_TIMEOUT_MS = 60_000;

interface RequestThreadStopForCurrentStateEnvironment {
  hostId: string;
  id: string;
}

type RequestThreadStopForCurrentStateDeps =
  LoggedPendingInteractionWorkSessionDeps;

interface RequestThreadStopForCurrentStateThread {
  environmentId: string | null;
  id: string;
  status: ThreadStatus;
}

interface RequestPreStartThreadStopResult {
  cancelHostId: string | null;
  environmentId: string | null;
  finalized: boolean;
}

interface ProvisioningInterruptedThread {
  environmentId: string | null;
  id: string;
}

interface FinalizeStoppedThreadArgs {
  providerCheckpointId?: string;
  threadId: string;
}

interface InterruptActiveTurnForThreadArgs {
  environmentId: string | null;
  providerCheckpointId?: string;
  reason: SystemThreadInterruptedReason;
  threadId: string;
}

interface InterruptActiveThreadArgs {
  environmentId: string | null;
  threadId: string;
}

interface InterruptActiveThreadsArgs {
  cause?: "host-connection-lost";
  reason: SystemThreadInterruptedReason;
  threads: readonly InterruptActiveThreadArgs[];
}

interface InterruptActiveThreadsForHostArgs {
  cause?: "host-connection-lost";
  hostId: string;
  reason: SystemThreadInterruptedReason;
}

interface InterruptedActiveThreadResult {
  failureEventAppended: boolean;
  interruptedTurnId: string | null;
  threadId: string;
}

interface InterruptActiveThreadsResult {
  threads: InterruptedActiveThreadResult[];
}

interface ReconcileDaemonReportedThreadsArgs {
  activeThreadIds: readonly string[];
  hostId: string;
}

interface DispatchSettledArchivedThreadProviderArchiveCommandArgs {
  threadId: string;
}

interface ThreadCommandResultSettlementDeps {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
}

interface SettleThreadCommandFailureArgs {
  command: ThreadFailureCommand;
  deps: ThreadCommandResultSettlementDeps;
  report: ThreadFailureResultReport;
}

interface SettleThreadStartCommandResultArgs {
  command: ThreadStartCommand;
  deps: FinalizeStoppedThreadTransactionDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: ThreadStartCommandResultReport;
}

interface SettleTurnSubmitCommandResultArgs {
  command: TurnSubmitCommand;
  deps: ThreadCommandResultSettlementDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: TurnSubmitCommandResultReport;
}

interface SettleThreadStopCommandResultArgs {
  command: ThreadStopCommand;
  deps: FinalizeStoppedThreadTransactionDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: ThreadStopCommandResultReport;
}

interface SettleThreadPlanCancelCommandResultArgs {
  command: ThreadPlanCancelCommand;
  deps: FinalizeStoppedThreadTransactionDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: ThreadPlanCancelCommandResultReport;
}

type RuntimeThreadInterruptionReason =
  | SystemThreadInterruptedReason
  | "host-connection-lost";

function lifecycleEventForInterruptedThread(
  reason: RuntimeThreadInterruptionReason,
): ThreadLifecycleEvent {
  switch (reason) {
    case "manual-stop":
      return { type: "stop.settled" };
    case "host-daemon-restarted":
    case "host-connection-lost":
      return { type: "run.failed" };
    case "provider-turn-idle":
      return { type: "run.failed" };
    default:
      return assertNever(reason);
  }
}

function pendingInteractionStopReason(
  reason: RuntimeThreadInterruptionReason,
): string {
  switch (reason) {
    case "manual-stop":
      return "Thread stopped by user request";
    case "host-daemon-restarted":
      return "Host daemon restarted while awaiting user interaction";
    case "host-connection-lost":
      return "Connection to host was lost while awaiting user interaction";
    case "provider-turn-idle":
      return "Thread stopped after the provider stopped sending progress";
    default:
      return assertNever(reason);
  }
}

function threadCommandFailureMessageForInterruption(
  reason: RuntimeThreadInterruptionReason,
): string | null {
  switch (reason) {
    case "manual-stop":
      return null;
    case "host-daemon-restarted":
      return "Thread interrupted because the host daemon disconnected";
    case "host-connection-lost":
      return "Thread interrupted because the connection to the host was lost";
    case "provider-turn-idle":
      return "Live runtime work failed because the provider stopped sending progress";
    default:
      return assertNever(reason);
  }
}

function threadCommandFailureDetailForInterruption(
  reason: RuntimeThreadInterruptionReason,
): string {
  switch (reason) {
    case "manual-stop":
      return "Thread stopped by user request";
    case "host-daemon-restarted":
    case "host-connection-lost":
      return "Please retry the thread to continue.";
    case "provider-turn-idle":
      return "Provider stopped sending progress while the thread was running";
    default:
      return assertNever(reason);
  }
}

interface DispatchThreadStartFromRequestArgs {
  command: ThreadStartCommand;
  sourceThreadStatus: ThreadStatus;
  threadId: string;
}

type ThreadStartDispatchDisposition = "blocked" | "started";

interface DispatchThreadStartFromRequestResult {
  completedProvisionSequence: number | null;
  disposition: ThreadStartDispatchDisposition;
}

interface ThreadLifecycleReadDeps {
  db: DbQueryConnection;
}

interface ThreadLifecycleTransactionDeps extends ThreadLifecycleReadDeps {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
}

interface FinalizeStoppedThreadTransactionDeps extends ThreadLifecycleTransactionDeps {
  pendingInteractions: AppDeps["pendingInteractions"];
}

interface ApplyActiveTurnInterruptionArgs {
  activeTurnId: string;
  environmentId: string | null;
  providerCheckpointId?: string;
  providerThreadId: string | null;
  reason: SystemThreadInterruptedReason;
  threadId: string;
}

interface MarkThreadStopRequestedWithEventArgs {
  reason: SystemThreadInterruptedReason;
  threadId: string;
}

function hasActiveThreadProvisioningContext(threadId: string): boolean {
  return getActiveThreadProvisionContext(threadId) !== null;
}

function hasThreadInterruptedEvent(
  deps: ThreadLifecycleReadDeps,
  threadId: string,
): boolean {
  const row = deps.db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "system/thread/interrupted"),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

function buildProvisioningStoppedEntry(): ProvisioningTranscriptEntry {
  return {
    type: "step",
    key: "provisioning-stopped",
    text: "Provisioning stopped by user request",
    status: "completed",
    startedAt: Date.now(),
  };
}

function appendProvisioningInterruptedEventInTransaction(
  deps: ThreadLifecycleTransactionDeps,
  thread: ProvisioningInterruptedThread,
): void {
  const currentThread = getThread(deps.db, thread.id);
  const context = getActiveThreadProvisionContext(thread.id);
  if (!currentThread || !context) {
    return;
  }
  const environmentId = context.state.environmentId ?? thread.environmentId;
  if (environmentId === null) {
    return;
  }
  if (!hasProvisioningTimelineRow(context)) {
    return;
  }

  appendThreadProvisioningEventInTransaction(deps.db, {
    threadId: thread.id,
    environmentId,
    provisioningId: context.state.provisioningId,
    status: "cancelled",
    entries: [buildProvisioningStoppedEntry()],
  });
  deps.hub.notifyThread(thread.id, ["events-appended"], {
    eventTypes: ["system/thread-provisioning"],
  });
}

function appendThreadInterruptedEventIfMissingInTransaction(
  deps: ThreadLifecycleTransactionDeps,
  args: MarkThreadStopRequestedWithEventArgs,
): boolean {
  if (hasThreadInterruptedEvent(deps, args.threadId)) {
    return false;
  }
  appendThreadInterruptedEventInTransaction(deps.db, {
    threadId: args.threadId,
    reason: args.reason,
  });
  deps.hub.notifyThread(args.threadId, ["events-appended"], {
    eventTypes: ["system/thread/interrupted"],
  });
  return true;
}

function markThreadStoppingWithEventInTransaction(
  deps: ThreadLifecycleTransactionDeps,
  args: MarkThreadStopRequestedWithEventArgs,
): boolean {
  const outcome = applyLoggedThreadLifecycleEventInTransaction(deps, {
    event: { type: "stop.requested" },
    threadId: args.threadId,
  });
  if (!outcome.applied) {
    return false;
  }
  deps.hub.notifyThread(args.threadId, ["status-changed"]);
  appendThreadInterruptedEventInTransaction(deps.db, {
    threadId: args.threadId,
    reason: args.reason,
  });
  deps.hub.notifyThread(args.threadId, ["events-appended"], {
    eventTypes: ["system/thread/interrupted"],
  });
  return true;
}

function applyActiveTurnInterruptionInTransaction(
  deps: ThreadLifecycleTransactionDeps,
  args: ApplyActiveTurnInterruptionArgs,
): boolean {
  appendThreadEventInTransaction(deps.db, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    type: "turn/completed",
    scope: turnScope(args.activeTurnId),
    data: {
      providerThreadId: args.providerThreadId,
      status: "interrupted",
      ...(args.providerCheckpointId !== undefined
        ? { providerCheckpointId: args.providerCheckpointId }
        : {}),
    },
  });
  const appendedThreadInterruptedEvent =
    appendThreadInterruptedEventIfMissingInTransaction(deps, args);
  applyLoggedThreadLifecycleEventInTransaction(deps, {
    event: lifecycleEventForInterruptedThread(args.reason),
    threadId: args.threadId,
  });
  return appendedThreadInterruptedEvent;
}

export function dispatchSettledArchivedThreadProviderArchiveCommand(
  deps: CommandResultSideEffectsDeps,
  args: DispatchSettledArchivedThreadProviderArchiveCommandArgs,
): boolean {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.status === "active" || thread.status === "stopping") {
    return false;
  }
  if (hasLiveThreadStartInFlight(thread.id)) {
    return false;
  }

  return dispatchArchivedThreadProviderArchiveCommand(deps, {
    threadId: thread.id,
  });
}

function getThreadFailureCommandErrorScope(
  command: ThreadFailureCommand,
): ThreadEventScope {
  if (command.type !== "turn.submit") {
    return threadScope();
  }

  return command.target.mode !== "start" && command.target.expectedTurnId
    ? turnScope(command.target.expectedTurnId)
    : threadScope();
}

function hasExpectedTurnCompletedEvent(
  deps: ThreadCommandResultSettlementDeps,
  command: ThreadFailureCommand,
): boolean {
  if (command.type !== "turn.submit" || command.target.mode === "start") {
    return false;
  }
  const turnId = command.target.expectedTurnId;
  if (!turnId) {
    return false;
  }

  return (
    deps.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, command.threadId),
          eq(events.turnId, turnId),
          eq(events.type, "turn/completed"),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasTerminalClientTurnRequestEvent(
  deps: ThreadCommandResultSettlementDeps,
  command: ThreadFailureCommand,
): boolean {
  if (command.type !== "turn.submit") {
    return false;
  }

  return (
    deps.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, command.threadId),
          or(
            and(
              eq(events.type, "turn/input/accepted"),
              sql`json_extract(${events.data}, '$.clientRequestId') = ${command.requestId}`,
            ),
            and(
              eq(events.type, "client/turn/rejected"),
              sql`json_extract(${events.data}, '$.requestId') = ${command.requestId}`,
            ),
          ),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasThreadInterruptedEventAtOrAfter(
  deps: ThreadLifecycleReadDeps,
  args: HasThreadInterruptedEventAtOrAfterArgs,
): boolean {
  return (
    deps.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, args.threadId),
          eq(events.type, "system/thread/interrupted"),
          gte(events.createdAt, args.createdAt),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function hasProviderTurnCompletedEventAtOrAfter(
  deps: ThreadLifecycleReadDeps,
  args: HasProviderTurnCompletedEventAtOrAfterArgs,
): boolean {
  return (
    deps.db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, args.threadId),
          eq(events.providerThreadId, args.providerThreadId),
          eq(events.type, "turn/completed"),
          gte(events.createdAt, args.createdAt),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

function isThreadStartActivationStale(
  deps: ThreadLifecycleReadDeps,
  args: ThreadStartSuccessActivationArgs,
): boolean {
  return (
    hasThreadInterruptedEventAtOrAfter(deps, {
      createdAt: args.commandStartedAt,
      threadId: args.threadId,
    }) ||
    hasProviderTurnCompletedEventAtOrAfter(deps, {
      createdAt: args.commandStartedAt,
      providerThreadId: args.providerThreadId,
      threadId: args.threadId,
    })
  );
}

function lifecycleEventForSuccessfulThreadStart(
  command: ThreadStartCommand,
): ThreadLifecycleEvent {
  if (command.fork && command.input.length === 0) {
    return { type: "run.succeeded" };
  }
  return { type: "run.started" };
}

function shouldAutoSendQueuedMessagesAfterThreadStart(
  command: ThreadStartCommand,
): boolean {
  return command.fork !== null && command.input.length === 0;
}

function recordEmptyThreadStartProviderSessionInTransaction(
  args: SettleThreadStartCommandResultArgs & { thread: Thread },
): void {
  if (
    !args.report.ok ||
    !shouldAutoSendQueuedMessagesAfterThreadStart(args.command)
  ) {
    return;
  }
  appendThreadEventInTransaction(args.deps.db, {
    threadId: args.thread.id,
    environmentId: args.command.environmentId,
    providerThreadId: args.report.result.providerThreadId,
    type: "system/thread-provisioning",
    scope: threadScope(),
    data: {
      provisioningId: `thread-start:${args.execution.id}`,
      status: "completed",
      environmentId: args.command.environmentId,
      entries: [],
    },
  });
}

function settleThreadCommandFailure(
  args: SettleThreadCommandFailureArgs,
): CommandResultSideEffectsResult {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  const thread = getThread(args.deps.db, args.command.threadId);
  if (!thread || thread.deletedAt !== null) {
    return emptyCommandResultSideEffects();
  }
  if (
    args.command.type === "turn.submit" &&
    args.report.errorCode === "command_timeout"
  ) {
    return emptyCommandResultSideEffects();
  }
  if (hasTerminalClientTurnRequestEvent(args.deps, args.command)) {
    return emptyCommandResultSideEffects();
  }
  if (args.command.type === "turn.submit") {
    appendThreadEventInTransaction(args.deps.db, {
      threadId: thread.id,
      environmentId: thread.environmentId,
      type: "client/turn/rejected",
      scope: threadScope(),
      data: {
        requestId: args.command.requestId,
        reason: args.report.errorCode,
        message: args.report.errorMessage,
      },
    });
  }
  if (hasExpectedTurnCompletedEvent(args.deps, args.command)) {
    return emptyCommandResultSideEffects();
  }
  appendSystemErrorEventInTransaction(args.deps, {
    threadId: thread.id,
    environmentId: thread.environmentId,
    code: "thread_command_failed",
    message: `Command ${args.report.type} failed`,
    detail: args.report.errorMessage,
    scope: getThreadFailureCommandErrorScope(args.command),
  });
  const outcome = applyLoggedThreadLifecycleEventInTransaction(args.deps, {
    event: { type: "run.failed" },
    threadId: thread.id,
  });
  if (outcome.applied) {
    args.deps.hub.notifyThread(thread.id, ["status-changed"]);
  }
  if (isParentNotifiableChildThread(thread)) {
    const parentThreadId = thread.parentThreadId;
    postCommitActions.push({
      run: (deps) =>
        queueChildThreadTurnNotificationBestEffort(deps, {
          childThread: thread,
          parentThreadId,
          turnStatus: "failed",
        }),
    });
  }
  return { postCommitActions };
}

export function settleThreadStartCommandResult(
  args: SettleThreadStartCommandResultArgs,
): CommandResultSideEffectsResult {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  const thread = getThread(args.deps.db, args.command.threadId);
  if (!thread) {
    return emptyCommandResultSideEffects();
  }
  if (!args.report.ok) {
    forgetActiveThreadProvisionContext(thread.id);
    return settleThreadCommandFailure({
      command: args.command,
      deps: args.deps,
      report: args.report,
    });
  }

  const shouldSyncTitle =
    thread.title !== null &&
    inFlightThreadRpcGuard.isHeld(thread.id, "thread.start.title-sync");
  forgetActiveThreadProvisionContext(thread.id);
  const currentThread = getThread(args.deps.db, args.command.threadId);
  if (currentThread && currentThread.deletedAt !== null) {
    finalizeStoppedThreadInTransaction(args.deps, {
      threadId: currentThread.id,
    });
    postCommitActions.push({
      run: (deps) =>
        runEnvironmentCleanupAdvance(deps, {
          environmentId: args.command.environmentId,
        }),
    });
    return { postCommitActions };
  }
  if (
    currentThread &&
    !isThreadStartActivationStale(args.deps, {
      commandStartedAt: args.execution.createdAt,
      providerThreadId: args.report.result.providerThreadId,
      threadId: currentThread.id,
    })
  ) {
    const lifecycleEvent = lifecycleEventForSuccessfulThreadStart(args.command);
    recordEmptyThreadStartProviderSessionInTransaction({
      ...args,
      thread: currentThread,
    });
    const outcome = applyLoggedThreadLifecycleEventInTransaction(args.deps, {
      event: lifecycleEvent,
      threadId: currentThread.id,
    });
    if (outcome.applied) {
      args.deps.hub.notifyThread(currentThread.id, ["status-changed"]);
      if (shouldAutoSendQueuedMessagesAfterThreadStart(args.command)) {
        postCommitActions.push({
          run: async (deps) => {
            const { runQueuedMessageDispatch } =
              await import("./queued-message-dispatch.js");
            await runQueuedMessageDispatch(deps, {
              kind: "thread-ready",
              threadId: currentThread.id,
            });
          },
        });
      }
    }
  }
  const threadTitle = thread.title;
  if (threadTitle && shouldSyncTitle) {
    postCommitActions.push({
      run: (deps) =>
        dispatchThreadRenameCommand(deps, {
          environment: {
            id: args.command.environmentId,
            hostId: args.execution.hostId,
          },
          providerId: thread.providerId,
          threadId: thread.id,
          title: threadTitle,
        }),
    });
  }
  return { postCommitActions };
}

export function settleTurnSubmitCommandResult(
  args: SettleTurnSubmitCommandResultArgs,
): CommandResultSideEffectsResult {
  if (!args.report.ok) {
    return settleThreadCommandFailure({
      command: args.command,
      deps: args.deps,
      report: args.report,
    });
  }
  return emptyCommandResultSideEffects();
}

export function ensureThreadCanStartRequest(thread: Thread): void {
  if (isPreStartThreadStatus(thread.status)) {
    throwThreadNotWritable(
      thread,
      "still_starting",
      "Thread is still starting",
    );
  }
}

export async function prepareReadyThreadTurnCommand(
  deps: LoggedWorkSessionDeps,
  args: ThreadStartCommandArgs,
): Promise<PreparedReadyThreadTurnCommand> {
  await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const providerThreadId = getLastProviderThreadId(deps, args.thread.id);
  if (providerThreadId) {
    const preparedCommand = await prepareTurnSubmitCommandPayload(deps, {
      environment: args.environment,
      execution: args.execution,
      input: args.input,
      ...(args.inputGroups !== undefined
        ? { inputGroups: args.inputGroups }
        : {}),
      permissionEscalation: args.permissionEscalation,
      providerThreadId,
      target: { mode: "start" },
      thread: args.thread,
    });
    return {
      command: addRequestIdToTurnSubmitCommandPayload({
        preparedCommand,
        requestId: args.requestId,
      }),
      mode: "turn.submit",
    };
  }

  return {
    command: await buildThreadStartCommand(deps, args),
    mode: "thread.start",
  };
}

export function settleThreadStopCommandResult(
  args: SettleThreadStopCommandResultArgs,
): CommandResultSideEffectsResult {
  if (args.report.ok) {
    settleDanglingBackgroundTasksForStoppedThreadInTransaction(args.deps, {
      threadId: args.command.threadId,
    });
  }

  if (args.command.intent === "release") {
    return emptyCommandResultSideEffects();
  }

  if (!args.report.ok) {
    if (args.report.errorCode !== "unknown_environment") {
      return emptyCommandResultSideEffects();
    }

    finalizeStoppedThreadInTransaction(args.deps, {
      threadId: args.command.threadId,
    });
    return {
      postCommitActions: [
        {
          run: (deps) =>
            runEnvironmentCleanupAdvance(deps, {
              environmentId: args.command.environmentId,
            }),
        },
      ],
    };
  }

  finalizeStoppedThreadInTransaction(args.deps, {
    ...(args.report.result.providerCheckpointId !== null
      ? { providerCheckpointId: args.report.result.providerCheckpointId }
      : {}),
    threadId: args.command.threadId,
  });

  return {
    postCommitActions: [
      {
        run: (deps) => {
          dispatchSettledArchivedThreadProviderArchiveCommand(deps, {
            threadId: args.command.threadId,
          });
        },
      },
      {
        run: (deps) =>
          runEnvironmentCleanupAdvance(deps, {
            environmentId: args.command.environmentId,
          }),
      },
    ],
  };
}

export function settleThreadPlanCancelCommandResult(
  args: SettleThreadPlanCancelCommandResultArgs,
): CommandResultSideEffectsResult {
  if (!args.report.ok || !args.report.result.cancelled) {
    return emptyCommandResultSideEffects();
  }
  const activeTurnId = getActiveTurnId(args.deps, args.command.threadId);
  if (activeTurnId !== null && activeTurnId !== args.command.expectedTurnId) {
    return emptyCommandResultSideEffects();
  }
  finalizeStoppedThreadInTransaction(args.deps, {
    threadId: args.command.threadId,
  });
  return emptyCommandResultSideEffects();
}

function dispatchThreadStartFromRequest(
  deps: Pick<AppDeps, "db" | "hub">,
  args: DispatchThreadStartFromRequestArgs,
): DispatchThreadStartFromRequestResult {
  const result: DispatchThreadStartFromRequestResult = deps.db.transaction(
    (tx) => {
      const currentThread = getThread(tx, args.threadId);
      const activeProvisionContext =
        args.sourceThreadStatus === "starting"
          ? getActiveThreadProvisionContext(args.threadId)
          : null;
      const isProvisionHandoff = activeProvisionContext !== null;
      if (
        !currentThread ||
        currentThread.deletedAt !== null ||
        currentThread.archivedAt !== null ||
        currentThread.status === "stopping"
      ) {
        return {
          completedProvisionSequence: null,
          disposition: "blocked",
        };
      }

      if (isProvisionHandoff && !isPreStartThreadStatus(currentThread.status)) {
        return {
          completedProvisionSequence: null,
          disposition: "blocked",
        };
      }

      let completedProvisionSequence: number | null = null;
      if (
        activeProvisionContext !== null &&
        hasProvisioningTimelineRow(activeProvisionContext)
      ) {
        completedProvisionSequence = appendThreadProvisioningEventInTransaction(
          tx,
          {
            threadId: args.threadId,
            environmentId: args.command.environmentId,
            provisioningId: activeProvisionContext.state.provisioningId,
            status: "completed",
            entries: [],
          },
        );
      }

      return {
        completedProvisionSequence,
        disposition: "started",
      };
    },
    { behavior: "immediate" },
  );

  if (result.completedProvisionSequence !== null) {
    deps.hub.notifyThread(args.threadId, ["events-appended"], {
      eventTypes: ["system/thread-provisioning"],
    });
  }
  return result;
}

export async function requestThreadStart(
  deps: CommandResultSideEffectsDeps,
  args: ThreadStartCommandArgs,
): Promise<void> {
  await threadStartRequestDeduper.run(args.thread.id, () =>
    requestThreadStartOnce(deps, args),
  );
}

async function requestThreadStartOnce(
  deps: CommandResultSideEffectsDeps,
  args: ThreadStartCommandArgs,
): Promise<void> {
  if (hasLiveThreadStartInFlight(args.thread.id)) {
    return;
  }

  const command = await buildThreadStartCommand(deps, {
    ...args,
  });
  if (hasLiveThreadStartInFlight(args.thread.id)) {
    return;
  }

  await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  const result = dispatchThreadStartFromRequest(deps, {
    command,
    sourceThreadStatus: args.thread.status,
    threadId: args.thread.id,
  });
  if (result.disposition === "started") {
    inFlightThreadRpcGuard.claim(args.thread.id, "thread.start");
    if (args.syncGeneratedTitle) {
      inFlightThreadRpcGuard.claim(args.thread.id, "thread.start.title-sync");
    }
    void runLiveHostCommand(deps, {
      command,
      hostId: args.environment.hostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
    })
      .catch((error) => {
        deps.logger.warn(
          { err: error, threadId: args.thread.id },
          "Live thread start command failed",
        );
      })
      .finally(() => {
        inFlightThreadRpcGuard.release(args.thread.id, "thread.start");
        inFlightThreadRpcGuard.release(
          args.thread.id,
          "thread.start.title-sync",
        );
      });
  }
}

function requestThreadStop(
  deps: CommandResultSideEffectsDeps,
  args: RequestThreadStopArgs,
): void {
  if (!markThreadStopRequested(deps, args)) {
    return;
  }
  if (!inFlightThreadRpcGuard.claim(args.threadId, "thread.stop")) {
    return;
  }

  dispatchThreadStopCommand(deps, args);
}

function markThreadStopRequested(
  deps: CommandResultSideEffectsDeps,
  args: RequestThreadStopArgs,
): boolean {
  const notificationBuffer = new NotificationBuffer();
  deps.db.transaction(
    (tx) => {
      markThreadStoppingWithEventInTransaction(
        {
          ...deps,
          db: tx,
          hub: notificationBuffer,
        },
        {
          reason: args.interruptionReason,
          threadId: args.threadId,
        },
      );
    },
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);

  const currentThread = getThread(deps.db, args.threadId);
  return currentThread?.status === "stopping";
}

function dispatchThreadStopCommand(
  deps: CommandResultSideEffectsDeps,
  args: RequestThreadStopArgs,
): void {
  void runLiveHostCommand(deps, {
    command: buildThreadStopCommand({ ...args, intent: "interrupt" }),
    hostId: args.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  })
    .catch((error) => {
      deps.logger.warn(
        { err: error, threadId: args.threadId },
        "Live thread stop command failed",
      );
    })
    .finally(() => {
      inFlightThreadRpcGuard.release(args.threadId, "thread.stop");
    });
}

function requestPreStartThreadStop(
  deps: RequestThreadStopForCurrentStateDeps,
  thread: RequestThreadStopForCurrentStateThread,
): void {
  // Stopping a thread abandons the provisioning anything was waiting on, so
  // those waits end here. This runs outside the transaction below because
  // clearing a wait notifies, and it runs first so no row is left waiting on
  // provisioning by an early return inside it.
  requestQueuedMessageDispatch(deps, {
    kind: "provisioning-ended",
    threadId: thread.id,
  });
  const notificationBuffer = new NotificationBuffer();
  const result: RequestPreStartThreadStopResult = deps.db.transaction(
    (tx) => {
      const txDeps = {
        ...deps,
        db: tx,
        hub: notificationBuffer,
      };
      const currentThread = getThread(tx, thread.id);
      if (!currentThread) {
        return { cancelHostId: null, environmentId: null, finalized: true };
      }

      const hasProvisioningContext =
        currentThread.status === "starting" &&
        hasActiveThreadProvisioningContext(currentThread.id);
      if (
        !isPreStartThreadStatus(currentThread.status) &&
        currentThread.status !== "stopping" &&
        !hasProvisioningContext
      ) {
        return {
          cancelHostId: null,
          environmentId: currentThread.environmentId,
          finalized: false,
        };
      }

      if (currentThread.status !== "stopping") {
        markThreadStoppingWithEventInTransaction(txDeps, {
          reason: "manual-stop",
          threadId: currentThread.id,
        });
      }
      if (hasProvisioningContext) {
        appendProvisioningInterruptedEventInTransaction(txDeps, currentThread);
      }
      forgetActiveThreadProvisionContext(currentThread.id);

      const environmentId = currentThread.environmentId;
      const environment =
        environmentId === null ? null : getEnvironment(tx, environmentId);
      const cancellation =
        environment === null
          ? "ready_to_finalize"
          : cancelEnvironmentProvisioningForThreadStopInTransaction(txDeps, {
              environmentId: environment.id,
              threadId: currentThread.id,
            });
      if (cancellation === "awaiting_host_cancel" && environment !== null) {
        return {
          cancelHostId: environment.hostId,
          environmentId: environment.id,
          finalized: false,
        };
      }

      finalizeStoppedThreadInTransaction(txDeps, {
        threadId: currentThread.id,
      });
      return { cancelHostId: null, environmentId, finalized: true };
    },
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);

  if (!result.finalized && result.environmentId && result.cancelHostId) {
    requestEnvironmentCleanup(deps, { environmentId: result.environmentId });
    startLiveHostCommand(deps, {
      command: {
        type: "environment.provision.cancel",
        environmentId: result.environmentId,
      },
      hostId: result.cancelHostId,
      timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
      onError: ({ error }) => {
        deps.logger.warn(
          {
            err: error,
            environmentId: result.environmentId,
            threadId: thread.id,
          },
          "Live environment provision cancel command failed",
        );
      },
    });
    return;
  }

  if (result.finalized && result.environmentId !== null) {
    requestEnvironmentCleanup(deps, { environmentId: result.environmentId });
    requestEnvironmentCleanupAdvance(deps, {
      environmentId: result.environmentId,
    });
  }
}

export function requestThreadStopForCurrentState(
  deps: RequestThreadStopForCurrentStateDeps,
  thread: RequestThreadStopForCurrentStateThread,
  environment: RequestThreadStopForCurrentStateEnvironment | null,
): void {
  const hasLiveRuntime =
    thread.status === "active" ||
    hasLiveThreadStartInFlight(thread.id) ||
    (thread.status === "stopping" && getActiveTurnId(deps, thread.id) !== null);
  if (hasLiveRuntime) {
    if (environment === null) {
      return;
    }
    requestThreadStop(deps, {
      environmentId: environment.id,
      hostId: environment.hostId,
      interruptionReason: "manual-stop",
      threadId: thread.id,
    });
    return;
  }

  if (
    isPreStartThreadStatus(thread.status) ||
    thread.status === "stopping" ||
    hasActiveThreadProvisioningContext(thread.id)
  ) {
    requestPreStartThreadStop(deps, thread);
  }
}

export async function stopThreadForCurrentState(
  deps: RequestThreadStopForCurrentStateDeps,
  thread: RequestThreadStopForCurrentStateThread,
  environment: RequestThreadStopForCurrentStateEnvironment | null,
): Promise<void> {
  await revokeThreadDesktopBrowserControl(deps, thread.id);
  const hasLiveRuntime =
    thread.status === "active" ||
    hasLiveThreadStartInFlight(thread.id) ||
    (thread.status === "stopping" && getActiveTurnId(deps, thread.id) !== null);
  if (hasLiveRuntime) {
    if (environment === null) {
      return;
    }
    const args: RequestThreadStopArgs = {
      environmentId: environment.id,
      hostId: environment.hostId,
      interruptionReason: "manual-stop",
      threadId: thread.id,
    };
    if (markThreadStopRequested(deps, args)) {
      await runAwaitedThreadStopCommand(deps, {
        command: buildThreadStopCommand({ ...args, intent: "interrupt" }),
        hostId: args.hostId,
        threadId: thread.id,
      });
      return;
    }
    const settledThread = getThread(deps.db, thread.id);
    if (
      settledThread === null ||
      (settledThread.status !== "idle" && settledThread.status !== "error")
    ) {
      return;
    }
    await releaseIdleThreadRuntime(deps, thread.id, environment);
    return;
  }

  if (
    isPreStartThreadStatus(thread.status) ||
    thread.status === "stopping" ||
    hasActiveThreadProvisioningContext(thread.id)
  ) {
    requestPreStartThreadStop(deps, thread);
    return;
  }

  await releaseIdleThreadRuntime(deps, thread.id, environment);
}

async function releaseIdleThreadRuntime(
  deps: RequestThreadStopForCurrentStateDeps,
  threadId: string,
  environment: RequestThreadStopForCurrentStateEnvironment | null,
): Promise<void> {
  if (environment === null) {
    return;
  }
  await runAwaitedThreadStopCommand(deps, {
    command: buildThreadStopCommand({
      environmentId: environment.id,
      hostId: environment.hostId,
      intent: "release",
      threadId,
    }),
    hostId: environment.hostId,
    threadId,
  });
}

async function runAwaitedThreadStopCommand(
  deps: RequestThreadStopForCurrentStateDeps,
  args: {
    command: ThreadStopCommand;
    hostId: string;
    threadId: string;
  },
): Promise<void> {
  await threadStopRequestDeduper.run(args.threadId, async () => {
    inFlightThreadRpcGuard.claim(args.threadId, "thread.stop");
    try {
      await runLiveHostCommand(deps, {
        command: args.command,
        hostId: args.hostId,
        timeoutMs: AWAITED_THREAD_STOP_TIMEOUT_MS,
      });
    } catch (error) {
      deps.logger.warn(
        { err: error, intent: args.command.intent, threadId: args.threadId },
        "Awaited thread stop command failed",
      );
      if (
        args.command.intent === "release" &&
        !isHostUnavailableApiError(error)
      ) {
        throw error;
      }
    } finally {
      inFlightThreadRpcGuard.release(args.threadId, "thread.stop");
    }
  });
}

export function requestActiveRuntimeThreadStopIfNeeded(
  deps: CommandResultSideEffectsDeps,
  thread: Pick<Thread, "id" | "status">,
  environment: {
    hostId: string;
    id: string;
  },
): void {
  if (thread.status !== "active" && !hasLiveThreadStartInFlight(thread.id)) {
    return;
  }
  requestThreadStop(deps, {
    environmentId: environment.id,
    hostId: environment.hostId,
    interruptionReason: "manual-stop",
    threadId: thread.id,
  });
}

function interruptActiveTurnForThreadInTransaction(
  deps: ThreadLifecycleTransactionDeps,
  args: InterruptActiveTurnForThreadArgs,
): boolean {
  const activeTurnId = getActiveTurnId(deps, args.threadId);
  if (!activeTurnId) {
    return false;
  }

  const providerThreadId = getLastProviderThreadId(deps, args.threadId);

  const appendedThreadInterruptedEvent =
    applyActiveTurnInterruptionInTransaction(deps, {
      activeTurnId,
      environmentId: args.environmentId,
      ...(args.providerCheckpointId !== undefined
        ? { providerCheckpointId: args.providerCheckpointId }
        : {}),
      providerThreadId,
      reason: args.reason,
      threadId: args.threadId,
    });
  const eventTypes: ThreadEventType[] = ["turn/completed"];
  if (appendedThreadInterruptedEvent) {
    eventTypes.push("system/thread/interrupted");
  }
  deps.hub.notifyThread(args.threadId, ["events-appended", "status-changed"], {
    eventTypes,
  });

  return appendedThreadInterruptedEvent;
}

function interruptActiveThreads(
  deps: Pick<
    AppDeps,
    "db" | "hub" | "logger" | "pendingInteractions" | "providerRegistry"
  >,
  args: InterruptActiveThreadsArgs,
): InterruptActiveThreadsResult {
  if (args.threads.length === 0) {
    return { threads: [] };
  }

  const results: InterruptedActiveThreadResult[] = [];
  const threadIds = args.threads.map((thread) => thread.threadId);
  const effectiveReason = args.cause ?? args.reason;
  const lifecycleEvent = lifecycleEventForInterruptedThread(effectiveReason);

  deps.db.transaction(
    (tx) => {
      const stateByThreadId = new Map(
        listThreadTurnInterruptionEventStates(tx, { threadIds }).map(
          (state) => [state.threadId, state],
        ),
      );
      const eventArgs: ThreadEventAppendArgs[] = [];

      for (const thread of args.threads) {
        const state = stateByThreadId.get(thread.threadId);
        const activeTurnId = state?.activeTurnId ?? null;
        const providerThreadId = state?.latestProviderThreadId ?? null;
        const failureMessage =
          threadCommandFailureMessageForInterruption(effectiveReason);

        if (activeTurnId !== null) {
          eventArgs.push({
            threadId: thread.threadId,
            environmentId: thread.environmentId,
            providerThreadId,
            type: "turn/completed",
            scope: turnScope(activeTurnId),
            data: {
              providerThreadId,
              status: "interrupted",
            },
          });
        }

        if (failureMessage !== null) {
          eventArgs.push({
            threadId: thread.threadId,
            environmentId: thread.environmentId,
            providerThreadId,
            type: "system/error",
            scope:
              activeTurnId !== null ? turnScope(activeTurnId) : threadScope(),
            data: buildSystemErrorEventData({
              code: "thread_command_failed",
              message: failureMessage,
              detail:
                threadCommandFailureDetailForInterruption(effectiveReason),
            }),
          });
        }

        eventArgs.push({
          threadId: thread.threadId,
          type: "system/thread/interrupted",
          scope: threadScope(),
          data: {
            reason: args.reason,
            ...(args.cause ? { cause: args.cause } : {}),
          },
        });
        results.push({
          failureEventAppended: failureMessage !== null,
          threadId: thread.threadId,
          interruptedTurnId: activeTurnId,
        });
      }

      appendThreadEventsInTransaction(tx, eventArgs);
      for (const thread of args.threads) {
        applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          { event: lifecycleEvent, threadId: thread.threadId },
        );
      }
    },
    { behavior: "immediate" },
  );

  deps.pendingInteractions.interruptPendingInteractionsForThreadIds({
    threadIds: results.map((result) => result.threadId),
    reason: pendingInteractionStopReason(effectiveReason),
  });

  for (const result of results) {
    const eventTypes: ThreadEventType[] = ["system/thread/interrupted"];
    if (result.failureEventAppended) {
      eventTypes.unshift("system/error");
    }
    if (result.interruptedTurnId !== null) {
      eventTypes.unshift("turn/completed");
    }
    const thread = getThread(deps.db, result.threadId);
    deps.hub.notifyThread(
      result.threadId,
      ["events-appended", "status-changed"],
      {
        eventTypes,
        ...(thread ? buildThreadStatusChangeMetadata(deps, thread) : {}),
      },
    );
  }

  return { threads: results };
}

export function interruptActiveThreadsForHost(
  deps: Pick<
    AppDeps,
    "db" | "hub" | "logger" | "pendingInteractions" | "providerRegistry"
  >,
  args: InterruptActiveThreadsForHostArgs,
): InterruptActiveThreadsResult {
  const activeThreads = deps.db
    .select({
      environmentId: environments.id,
      threadId: threads.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, args.hostId),
        eq(threads.status, "active"),
        isNull(threads.deletedAt),
      ),
    )
    .all();

  return interruptActiveThreads(deps, {
    threads: activeThreads,
    reason: args.reason,
    ...(args.cause ? { cause: args.cause } : {}),
  });
}

export function finalizeStoppedThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: FinalizeStoppedThreadArgs,
): void {
  const notificationBuffer = new NotificationBuffer();
  deps.db.transaction(
    (tx) =>
      finalizeStoppedThreadInTransaction(
        {
          ...deps,
          db: tx,
          hub: notificationBuffer,
        },
        args,
      ),
    { behavior: "immediate" },
  );
  notificationBuffer.flushInto(deps.hub);
  dispatchSettledArchivedThreadProviderArchiveCommand(deps, {
    threadId: args.threadId,
  });
}

export function finalizeStoppedThreadInTransaction(
  deps: FinalizeStoppedThreadTransactionDeps,
  args: FinalizeStoppedThreadArgs,
): void {
  const currentThread = getThread(deps.db, args.threadId);
  if (!currentThread) {
    return;
  }

  const interruptionReason =
    getLatestThreadInterruptedReason(deps.db, {
      threadId: currentThread.id,
    }) ?? "manual-stop";
  let appendedThreadInterruptedEvent = false;
  if (
    currentThread.status === "active" ||
    currentThread.status === "stopping"
  ) {
    appendedThreadInterruptedEvent = interruptActiveTurnForThreadInTransaction(
      deps,
      {
        environmentId: currentThread.environmentId,
        ...(args.providerCheckpointId !== undefined
          ? { providerCheckpointId: args.providerCheckpointId }
          : {}),
        threadId: currentThread.id,
        reason: interruptionReason,
      },
    );
    if (!appendedThreadInterruptedEvent) {
      const outcome = applyLoggedThreadLifecycleEventInTransaction(deps, {
        event: lifecycleEventForInterruptedThread(interruptionReason),
        threadId: currentThread.id,
      });
      if (outcome.applied) {
        deps.hub.notifyThread(currentThread.id, ["status-changed"]);
      }
    }
  } else if (isPreStartThreadStatus(currentThread.status)) {
    const outcome = applyLoggedThreadLifecycleEventInTransaction(deps, {
      event: lifecycleEventForInterruptedThread(interruptionReason),
      threadId: currentThread.id,
    });
    if (outcome.applied) {
      deps.hub.notifyThread(currentThread.id, ["status-changed"]);
    }
  }

  const finalizedThread = getThread(deps.db, args.threadId);
  if (!finalizedThread) {
    return;
  }

  if (finalizedThread.deletedAt === null) {
    deps.pendingInteractions.interruptPendingInteractionsForThreadIdsInTransaction(
      deps,
      {
        threadIds: [finalizedThread.id],
        reason: pendingInteractionStopReason(interruptionReason),
      },
    );
    if (
      !appendedThreadInterruptedEvent &&
      !hasThreadInterruptedEvent(deps, finalizedThread.id)
    ) {
      appendThreadInterruptedEventInTransaction(deps.db, {
        threadId: finalizedThread.id,
        reason: interruptionReason,
      });
      deps.hub.notifyThread(finalizedThread.id, ["events-appended"], {
        eventTypes: ["system/thread/interrupted"],
      });
    }
  }

  if (finalizedThread.deletedAt !== null) {
    deps.pendingInteractions.interruptPendingInteractionsForThreadIdsInTransaction(
      deps,
      {
        threadIds: [finalizedThread.id],
        reason: "thread-deleted",
      },
    );

    const environmentId = finalizedThread.environmentId;
    deleteThread(deps.db, deps.hub, finalizedThread.id);
    requestEnvironmentCleanup(deps, {
      environmentId,
    });
  }
}

export function finalizeStoppedThreadAndRequestCleanupAdvance(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: FinalizeStoppedThreadArgs,
): void {
  const threadBeforeFinalize = getThread(deps.db, args.threadId);
  finalizeStoppedThread(deps, args);

  const threadAfterFinalize = getThread(deps.db, args.threadId);
  const environmentId =
    threadAfterFinalize?.environmentId ??
    threadBeforeFinalize?.environmentId ??
    null;
  requestEnvironmentCleanupAdvance(deps, { environmentId });
}

export async function reconcileDaemonReportedThreads(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: ReconcileDaemonReportedThreadsArgs,
): Promise<void> {
  const activeThreadIdSet = new Set(args.activeThreadIds);

  const pendingThreads = deps.db
    .select({
      deletedAt: threads.deletedAt,
      environmentId: environments.id,
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, args.hostId),
        inArray(threads.status, [
          "active",
          "idle",
          "error",
          "starting",
          "stopping",
        ]),
        or(isNotNull(threads.deletedAt), eq(threads.status, "stopping")),
      ),
    )
    .all();

  for (const thread of pendingThreads) {
    if (activeThreadIdSet.has(thread.id)) {
      requestThreadStop(deps, {
        environmentId: thread.environmentId,
        hostId: args.hostId,
        interruptionReason: "manual-stop",
        threadId: thread.id,
      });
      continue;
    }

    finalizeStoppedThreadAndRequestCleanupAdvance(deps, {
      threadId: thread.id,
    });
  }

  if (args.activeThreadIds.length > 0) {
    const erroredThreads = deps.db
      .select({ id: threads.id })
      .from(threads)
      .innerJoin(environments, eq(threads.environmentId, environments.id))
      .where(
        and(
          eq(environments.hostId, args.hostId),
          eq(threads.status, "error"),
          isNull(threads.deletedAt),
          inArray(threads.id, [...args.activeThreadIds]),
        ),
      )
      .all();

    for (const thread of erroredThreads) {
      applyLoggedThreadLifecycleEvent(deps, {
        event: { type: "run.started" },
        threadId: thread.id,
      });
    }
  }

  const activeButMissing = deps.db
    .select({ environmentId: environments.id, id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, args.hostId),
        eq(threads.status, "active"),
        isNull(threads.deletedAt),
        args.activeThreadIds.length > 0
          ? notInArray(threads.id, [...args.activeThreadIds])
          : undefined,
      ),
    )
    .all();

  interruptActiveThreads(deps, {
    threads: activeButMissing.map((thread) => ({
      environmentId: thread.environmentId,
      threadId: thread.id,
    })),
    reason: "host-daemon-restarted",
  });

  if (args.activeThreadIds.length === 0) {
    return;
  }

  const inactiveButActive = deps.db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, args.hostId),
        inArray(threads.status, ["starting", "idle"]),
        isNull(threads.deletedAt),
        inArray(threads.id, [...args.activeThreadIds]),
      ),
    )
    .all();

  const blockedRevivalThreadIds = new Set(
    listThreadIdsWithLatestHostDaemonRestartInterruption(deps.db, {
      threadIds: inactiveButActive.map((thread) => thread.id),
    }),
  );

  for (const thread of inactiveButActive) {
    if (blockedRevivalThreadIds.has(thread.id)) {
      continue;
    }
    applyLoggedThreadLifecycleEvent(deps, {
      event: { type: "run.started" },
      threadId: thread.id,
    });
    forgetActiveThreadProvisionContext(thread.id);
  }
}
