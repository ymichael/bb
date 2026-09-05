import { and, desc, eq, isNull } from "drizzle-orm";
import {
  events,
  type DbConnection,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
  getEnvironment,
  type EnvironmentRow,
  getThread,
  listStoredThreadProvisioningRowsByProvisioningId,
  threads,
} from "@bb/db";
import { recordProvisionedEnvironmentWorkspace } from "@bb/db/internal-environment-lifecycle";
import type {
  ProvisioningTranscriptEntry,
  SystemThreadProvisioningStatus,
  ThreadStatus,
  DiscoveredWorkspaceProperties,
  GitSourceInspection,
} from "@bb/domain";
import {
  systemThreadProvisioningEventDataSchema,
  threadScope,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import {
  appendSystemErrorEventInTransaction,
  appendThreadProvisioningEventInTransaction,
  buildCwdBranchEntries,
} from "../threads/thread-events.js";
import type { EnvironmentProvisionRequest } from "./environment-provision-request.js";
import {
  buildLiveHostCommandFailureReport,
  buildLiveHostCommandSuccessReport,
  createLiveHostCommandExecution,
  expectedLiveHostCommandErrorLogFields,
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
  runLiveHostCommandSettlement,
} from "../hosts/live-command.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "../threads/lifecycle-outcome.js";
import { applyLoggedEnvironmentLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import {
  forgetActiveThreadProvisionContext,
  getActiveThreadProvisionContext,
} from "../threads/thread-provisioning-active-context.js";
import { advanceThreadProvisioning } from "../threads/thread-provisioning.js";
import { ensureWorkspaceReadyEventInTransaction } from "../threads/thread-provisioning-environment.js";
import {
  finalizeStoppedThreadInTransaction,
  requestThreadStopForCurrentState,
} from "../threads/thread-lifecycle.js";
import {
  emptyCommandResultSideEffects,
  type CommandResultPostCommitAction,
  type CommandResultSideEffectsDeps,
  type CommandResultReportForType,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
  type HostDaemonCommandForType,
} from "../../internal/command-result-side-effects.js";

type EnvironmentProvisionCommand =
  HostDaemonCommandForType<"environment.attach">;
type EnvironmentProvisionCommandResultReport =
  CommandResultReportForType<"environment.attach">;
type EnvironmentProvisionCancelCommand =
  HostDaemonCommandForType<"environment.attach.cancel">;
type EnvironmentProvisionCancelCommandResultReport =
  CommandResultReportForType<"environment.attach.cancel">;

interface EnvironmentProvisionReadDeps {
  db: DbQueryConnection;
}

interface EnvironmentProvisionWriteDeps extends EnvironmentProvisionReadDeps {
  db: DbConnection | DbTransaction;
  hub: DbNotifier;
}

interface EnvironmentProvisionTransactionDeps extends EnvironmentProvisionWriteDeps {
  db: DbTransaction;
  logger: AppDeps["logger"];
  pendingInteractions: AppDeps["pendingInteractions"];
}

interface AdvanceEnvironmentProvisioningArgs {
  environmentId: string | null | undefined;
  request?: EnvironmentProvisionRequest | null;
}

interface SettleEnvironmentProvisionCommandResultArgs {
  command: EnvironmentProvisionCommand;
  deps: EnvironmentProvisionTransactionDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: EnvironmentProvisionCommandResultReport;
}

interface SettleEnvironmentProvisionCancelCommandResultArgs {
  command: EnvironmentProvisionCancelCommand;
  deps: EnvironmentProvisionTransactionDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: EnvironmentProvisionCancelCommandResultReport;
}

interface FailEnvironmentProvisioningDurablyArgs {
  environmentId: string;
  failureEntry: ProvisioningTranscriptEntry;
  failureReason: string;
  provisioningId: string;
}

interface StartTrackedEnvironmentProvisionCommandArgs {
  environment: EnvironmentRow;
  request: EnvironmentProvisionRequest;
}

interface SettleEnvironmentProvisionOutcomeArgs extends SettleEnvironmentProvisionCommandResultArgs {
  headSha: string | null;
  initiatorStreamed: boolean;
  mergeBaseBranch: string | null;
}

interface InspectProducedEnvironmentWorkspaceArgs {
  command: EnvironmentProvisionCommand;
  environment: EnvironmentRow;
  execution: HostDaemonCommandExecutionRecord;
  mergeBaseBranch: string | null;
}

const PRODUCED_WORKSPACE_INSPECT_TIMEOUT_MS = 60_000;

interface InterruptUnrecoverableEnvironmentProvisioningArgs {
  environmentId: string;
  reason: string;
}

interface LiveEnvironmentThread {
  environmentId: string | null;
  id: string;
  status: ThreadStatus;
}

interface StopRequestedEnvironmentProvisionThread {
  id: string;
  status: ThreadStatus;
}

interface AppendThreadProvisioningEventToEnvironmentThreadsArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  fallbackProvisioningId: string;
  status: SystemThreadProvisioningStatus;
  threads?: LiveEnvironmentThread[];
}

function listLiveEnvironmentThreads(
  deps: EnvironmentProvisionReadDeps,
  environmentId: string,
): LiveEnvironmentThread[] {
  return deps.db
    .select({
      environmentId: threads.environmentId,
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .where(
      and(eq(threads.environmentId, environmentId), isNull(threads.deletedAt)),
    )
    .all();
}

function listStopRequestedEnvironmentProvisionThreads(
  deps: EnvironmentProvisionReadDeps,
  environmentId: string,
): StopRequestedEnvironmentProvisionThread[] {
  return deps.db
    .select({
      id: threads.id,
      status: threads.status,
    })
    .from(threads)
    .where(
      and(
        eq(threads.environmentId, environmentId),
        eq(threads.status, "stopping"),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
      ),
    )
    .all();
}

function resolveLiveThreadProvisioningId(
  thread: LiveEnvironmentThread,
  fallbackProvisioningId: string,
): string {
  const context = getActiveThreadProvisionContext(thread.id);
  if (context?.state.environmentId === thread.environmentId) {
    return context.state.provisioningId;
  }
  return fallbackProvisioningId;
}

function appendThreadProvisioningEventToEnvironmentThreadsInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: AppendThreadProvisioningEventToEnvironmentThreadsArgs,
): void {
  const liveThreads =
    args.threads ?? listLiveEnvironmentThreads(deps, args.environmentId);

  for (const thread of liveThreads) {
    const provisioningId = resolveLiveThreadProvisioningId(
      thread,
      args.fallbackProvisioningId,
    );
    appendThreadProvisioningEventInTransaction(deps.db, {
      entries: args.entries,
      environmentId: args.environmentId,
      provisioningId,
      status: args.status,
      threadId: thread.id,
    });
    deps.hub.notifyThread(thread.id, ["events-appended"], {
      eventTypes: ["system/thread-provisioning"],
    });
  }
}

const activeEnvironmentProvisionRpcEnvironmentIds = new Set<string>();

function hasLiveEnvironmentProvisionInFlight(environmentId: string): boolean {
  return activeEnvironmentProvisionRpcEnvironmentIds.has(environmentId);
}

function hasActiveThreadProvisioningContext(
  thread: LiveEnvironmentThread,
): boolean {
  const context = getActiveThreadProvisionContext(thread.id);
  return context?.state.environmentId === thread.environmentId;
}

function hasThreadProvisionCancellationIntent(
  deps: EnvironmentProvisionReadDeps,
  threadId: string,
): boolean {
  return getThread(deps.db, threadId)?.status === "stopping";
}

interface HasThreadProvisionCancellationOutcomeArgs {
  provisioningId: string;
  threadId: string;
}

interface HasLatestThreadProvisionCancellationOutcomeArgs {
  environmentId: string | null;
  threadId: string;
}

function hasThreadProvisionCancellationOutcome(
  deps: EnvironmentProvisionReadDeps,
  args: HasThreadProvisionCancellationOutcomeArgs,
): boolean {
  const rows = listStoredThreadProvisioningRowsByProvisioningId(deps.db, {
    provisioningId: args.provisioningId,
    threadId: args.threadId,
  });

  return rows.some((row) => {
    const eventData = systemThreadProvisioningEventDataSchema.parse(
      JSON.parse(row.data),
    );
    return (
      eventData.provisioningId === args.provisioningId &&
      eventData.status === "cancelled"
    );
  });
}

function hasLatestThreadProvisionCancellationOutcome(
  deps: EnvironmentProvisionReadDeps,
  args: HasLatestThreadProvisionCancellationOutcomeArgs,
): boolean {
  if (args.environmentId === null) {
    return false;
  }

  const row = deps.db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.environmentId, args.environmentId),
        eq(events.type, "system/thread-provisioning"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (!row) {
    return false;
  }

  const eventData = systemThreadProvisioningEventDataSchema.parse(
    JSON.parse(row.data),
  );
  return eventData.status === "cancelled";
}

interface ShouldPreserveThreadProvisionCancellationOutcomeArgs {
  provisioningId: string;
  thread: LiveEnvironmentThread;
}

function shouldPreserveThreadProvisionCancellationOutcome(
  deps: EnvironmentProvisionReadDeps,
  args: ShouldPreserveThreadProvisionCancellationOutcomeArgs,
): boolean {
  return (
    args.thread.status === "stopping" ||
    hasThreadProvisionCancellationIntent(deps, args.thread.id) ||
    hasThreadProvisionCancellationOutcome(deps, {
      provisioningId: args.provisioningId,
      threadId: args.thread.id,
    }) ||
    hasLatestThreadProvisionCancellationOutcome(deps, {
      environmentId: args.thread.environmentId,
      threadId: args.thread.id,
    })
  );
}

interface HasOnlyCancelledOrStoppedProvisioningOutcomeThreadsArgs {
  provisioningId: string;
  threads: LiveEnvironmentThread[];
}

interface RestoreProvisioningEnvironmentAfterCancelledProvisioningOutcomeArgs {
  environment: EnvironmentRow;
}

function hasOnlyCancelledOrStoppedProvisioningOutcomeThreads(
  deps: EnvironmentProvisionReadDeps,
  args: HasOnlyCancelledOrStoppedProvisioningOutcomeThreadsArgs,
): boolean {
  return (
    args.threads.length > 0 &&
    args.threads.every((thread) =>
      shouldPreserveThreadProvisionCancellationOutcome(deps, {
        provisioningId: args.provisioningId,
        thread,
      }),
    )
  );
}

function restoreProvisioningEnvironmentAfterCancelledProvisioningOutcomeInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: RestoreProvisioningEnvironmentAfterCancelledProvisioningOutcomeArgs,
): boolean {
  if (args.environment.status === "destroyed") {
    return false;
  }

  const outcome = applyLoggedEnvironmentLifecycleEventInTransaction(deps, {
    environmentId: args.environment.id,
    event: { type: "provision.cancelled" },
  });
  if (outcome.applied) {
    deps.hub.notifyEnvironment(args.environment.id, outcome.changes);
  }

  return true;
}

function recordEnvironmentProvisioningFailureInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: FailEnvironmentProvisioningDurablyArgs,
): boolean {
  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment) {
    return false;
  }
  const liveThreads = listLiveEnvironmentThreads(deps, environment.id);
  const failureThreads = liveThreads.filter(
    (thread) =>
      !shouldPreserveThreadProvisionCancellationOutcome(deps, {
        provisioningId: args.provisioningId,
        thread,
      }),
  );
  if (
    failureThreads.length === 0 &&
    hasOnlyCancelledOrStoppedProvisioningOutcomeThreads(deps, {
      provisioningId: args.provisioningId,
      threads: liveThreads,
    })
  ) {
    return restoreProvisioningEnvironmentAfterCancelledProvisioningOutcomeInTransaction(
      deps,
      { environment },
    );
  }

  const failureOutcome = applyLoggedEnvironmentLifecycleEventInTransaction(
    deps,
    {
      environmentId: environment.id,
      event: { type: "provision.failed" },
    },
  );
  if (failureOutcome.applied) {
    deps.hub.notifyEnvironment(environment.id, failureOutcome.changes);
  }

  appendThreadProvisioningEventToEnvironmentThreadsInTransaction(deps, {
    environmentId: environment.id,
    fallbackProvisioningId: args.provisioningId,
    status: "failed",
    threads: failureThreads,
    entries: [args.failureEntry],
  });

  for (const thread of failureThreads) {
    forgetActiveThreadProvisionContext(thread.id);
    appendSystemErrorEventInTransaction(deps, {
      threadId: thread.id,
      environmentId: environment.id,
      code: "thread_provisioning_failed",
      message: "Provisioning thread failed",
      detail: args.failureReason,
      scope: threadScope(),
    });
    const outcome = applyLoggedThreadLifecycleEventInTransaction(deps, {
      event: { type: "run.failed" },
      threadId: thread.id,
    });
    if (outcome.applied) {
      deps.hub.notifyThread(thread.id, ["status-changed"]);
    }
  }

  return true;
}

export function settleEnvironmentProvisionCommandResult(
  args: SettleEnvironmentProvisionCommandResultArgs,
): CommandResultSideEffectsResult {
  return settleEnvironmentProvisionOutcome({
    ...args,
    headSha: null,
    initiatorStreamed: true,
    mergeBaseBranch: null,
  });
}

function settleEnvironmentProvisionOutcome(
  args: SettleEnvironmentProvisionOutcomeArgs,
): CommandResultSideEffectsResult {
  const postCommitActions: CommandResultPostCommitAction[] = [];
  const initiator = args.command.initiator;
  if (!initiator && !args.report.ok) {
    const outcome = applyLoggedEnvironmentLifecycleEventInTransaction(
      args.deps,
      {
        environmentId: args.command.environmentId,
        event: { type: "provision.failed" },
      },
    );
    if (outcome.applied) {
      args.deps.hub.notifyEnvironment(
        args.command.environmentId,
        outcome.changes,
      );
    }
    return emptyCommandResultSideEffects();
  }

  const boundThreads = args.deps.db
    .select()
    .from(threads)
    .where(eq(threads.environmentId, args.command.environmentId))
    .all();

  if (args.report.ok) {
    recordProvisionedEnvironmentWorkspace(
      args.deps.db,
      args.deps.hub,
      args.command.environmentId,
      {
        path: args.report.result.path,
        isGitRepo: args.report.result.isGitRepo,
        isWorktree: args.report.result.isWorktree,
        branchName: args.report.result.branchName,
        defaultBranch: args.report.result.defaultBranch,
        ...(args.mergeBaseBranch === null
          ? {}
          : { baseBranch: null, mergeBaseBranch: args.mergeBaseBranch }),
      },
    );
    const provisionedOutcome =
      applyLoggedEnvironmentLifecycleEventInTransaction(args.deps, {
        environmentId: args.command.environmentId,
        event: { type: "provision.succeeded" },
      });
    if (provisionedOutcome.applied) {
      args.deps.hub.notifyEnvironment(
        args.command.environmentId,
        provisionedOutcome.changes,
      );
    }
    args.deps.hub.notifyEnvironment(args.command.environmentId, [
      "work-status-changed",
    ]);
    if (!initiator) {
      return emptyCommandResultSideEffects();
    }
    const environmentProvisioningId = initiator.provisioningId;

    const cwdBranchEntries = buildCwdBranchEntries({
      path: args.report.result.path,
      branchName: args.report.result.branchName,
      headSha: args.headSha,
    });

    for (const thread of boundThreads) {
      if (thread.deletedAt !== null) {
        finalizeStoppedThreadInTransaction(args.deps, {
          threadId: thread.id,
        });
        continue;
      }
      if (
        thread.archivedAt !== null ||
        shouldPreserveThreadProvisionCancellationOutcome(args.deps, {
          provisioningId: environmentProvisioningId,
          thread,
        })
      ) {
        continue;
      }

      const entries =
        thread.id === initiator.threadId && args.initiatorStreamed
          ? []
          : cwdBranchEntries;

      if (!hasActiveThreadProvisioningContext(thread)) {
        appendThreadProvisioningEventInTransaction(args.deps.db, {
          threadId: thread.id,
          environmentId: args.command.environmentId,
          provisioningId: environmentProvisioningId,
          status: thread.status === "starting" ? "active" : "completed",
          entries,
        });
        args.deps.hub.notifyThread(thread.id, ["events-appended"], {
          eventTypes: ["system/thread-provisioning"],
        });
        continue;
      }

      ensureWorkspaceReadyEventInTransaction(args.deps, {
        threadId: thread.id,
        environmentId: args.command.environmentId,
        entries,
      });
      postCommitActions.push({
        run: (deps) => advanceThreadProvisioning(deps, { threadId: thread.id }),
      });
    }

    return { postCommitActions };
  }

  if (!initiator) {
    return emptyCommandResultSideEffects();
  }
  const environmentProvisioningId = initiator.provisioningId;
  recordEnvironmentProvisioningFailureInTransaction(args.deps, {
    environmentId: args.command.environmentId,
    failureReason: args.report.errorMessage,
    provisioningId: environmentProvisioningId,
    failureEntry: {
      type: "step",
      key: "workspace-failed",
      text: "Workspace setup failed",
      status: "failed",
      startedAt: args.execution.createdAt,
      metadata: { durationMs: Date.now() - args.execution.createdAt },
    },
  });
  return { postCommitActions };
}

export function settleEnvironmentProvisionCancelCommandResult(
  args: SettleEnvironmentProvisionCancelCommandResultArgs,
): CommandResultSideEffectsResult {
  const stoppedThreads = listStopRequestedEnvironmentProvisionThreads(
    args.deps,
    args.command.environmentId,
  );
  if (!args.report.ok) {
    const environment = getEnvironment(
      args.deps.db,
      args.command.environmentId,
    );
    args.deps.logger.warn(
      {
        activeProvisionState:
          environment?.status === "provisioning" ? "provisioning" : null,
        executionId: args.execution.id,
        environmentId: args.command.environmentId,
        errorCode: args.report.errorCode,
        errorMessage: args.report.errorMessage,
        stoppedThreadCount: stoppedThreads.length,
        stoppedThreadIds: stoppedThreads.map((thread) => thread.id),
      },
      "Environment provision cancel command failed",
    );

    if (!environment || stoppedThreads.length === 0) {
      return emptyCommandResultSideEffects();
    }

    return {
      postCommitActions: [
        {
          run: (deps) => {
            for (const thread of stoppedThreads) {
              requestThreadStopForCurrentState(
                deps,
                {
                  environmentId: args.command.environmentId,
                  id: thread.id,
                  status: thread.status,
                },
                {
                  hostId: environment.hostId,
                  id: environment.id,
                },
              );
            }
          },
        },
      ],
    };
  }

  const postCommitActions: CommandResultPostCommitAction[] = [];
  const cancelledOutcome = applyLoggedEnvironmentLifecycleEventInTransaction(
    args.deps,
    {
      environmentId: args.command.environmentId,
      event: { type: "provision.cancelled" },
    },
  );
  if (cancelledOutcome.applied) {
    args.deps.hub.notifyEnvironment(
      args.command.environmentId,
      cancelledOutcome.changes,
    );
  }

  for (const thread of stoppedThreads) {
    finalizeStoppedThreadInTransaction(args.deps, {
      threadId: thread.id,
    });
  }

  return { postCommitActions };
}

function interruptUnrecoverableEnvironmentProvisioning(
  deps: CommandResultSideEffectsDeps,
  args: InterruptUnrecoverableEnvironmentProvisioningArgs,
): void {
  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || environment.status !== "provisioning") {
    return;
  }

  const now = Date.now();
  deps.db.transaction(
    (tx) => {
      recordEnvironmentProvisioningFailureInTransaction(
        {
          ...deps,
          db: tx,
        },
        {
          environmentId: environment.id,
          failureReason: args.reason,
          provisioningId: `env-${environment.id}-interrupted`,
          failureEntry: {
            type: "step",
            key: "workspace-failed",
            text: "Workspace setup interrupted",
            status: "failed",
            startedAt: now,
            metadata: { durationMs: 0 },
          },
        },
      );
    },
    { behavior: "immediate" },
  );
}

function startTrackedEnvironmentProvisionCommand(
  deps: CommandResultSideEffectsDeps,
  args: StartTrackedEnvironmentProvisionCommandArgs,
): void {
  if (hasLiveEnvironmentProvisionInFlight(args.environment.id)) {
    return;
  }
  const execution = createLiveHostCommandExecution(args.environment.hostId);
  activeEnvironmentProvisionRpcEnvironmentIds.add(args.environment.id);
  if (args.request.mode === "inspect") {
    void inspectProducedEnvironmentWorkspace(deps, {
      command: args.request.command,
      environment: args.environment,
      execution,
      mergeBaseBranch: args.request.mergeBaseBranch,
    }).finally(() => {
      activeEnvironmentProvisionRpcEnvironmentIds.delete(args.environment.id);
    });
    return;
  }
  void runLiveHostCommand(deps, {
    command: args.request.command,
    execution,
    hostId: args.environment.hostId,
    timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  })
    .catch((error) => {
      const expectedErrorFields =
        error instanceof Error
          ? expectedLiveHostCommandErrorLogFields(error)
          : null;
      if (expectedErrorFields !== null) {
        deps.logger.debug(
          {
            commandType: args.request.command.type,
            environmentId: args.environment.id,
            ...expectedErrorFields,
            executionId: execution.id,
            hostId: args.environment.hostId,
            initiatorThreadId: args.request.command.initiator?.threadId ?? null,
            provisioningId:
              args.request.command.initiator?.provisioningId ?? null,
          },
          "Live environment provisioning cancelled",
        );
        return;
      }
      deps.logger.warn(
        {
          commandType: args.request.command.type,
          err: error,
          environmentId: args.environment.id,
          executionId: execution.id,
          hostId: args.environment.hostId,
        },
        "Live environment provision command failed",
      );
    })
    .finally(() => {
      activeEnvironmentProvisionRpcEnvironmentIds.delete(args.environment.id);
    });
}

function discoverProducedWorkspace(
  path: string,
  inspection: GitSourceInspection,
): { headSha: string | null; properties: DiscoveredWorkspaceProperties } {
  const checkout = inspection.checkout;
  const isGitRepo = checkout.kind !== "unknown";
  const branchName =
    checkout.kind === "branch" || checkout.kind === "unborn"
      ? checkout.branchName
      : null;
  return {
    headSha:
      checkout.kind === "branch" || checkout.kind === "detached"
        ? checkout.headSha
        : null,
    properties: {
      path,
      isGitRepo,
      isWorktree: inspection.isWorktree,
      branchName,
      defaultBranch: isGitRepo
        ? (inspection.defaultBranch ?? branchName)
        : null,
    },
  };
}

async function inspectProducedEnvironmentWorkspace(
  deps: CommandResultSideEffectsDeps,
  args: InspectProducedEnvironmentWorkspaceArgs,
): Promise<void> {
  let discovered:
    | {
        ok: true;
        headSha: string | null;
        properties: DiscoveredWorkspaceProperties;
      }
    | { ok: false; error: Error };
  try {
    const inspection = await callHostRetryableOnlineRpc(deps, {
      hostId: args.environment.hostId,
      timeoutMs: PRODUCED_WORKSPACE_INSPECT_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: args.command.path,
        remoteRefresh: "background",
      },
    });
    discovered = {
      ok: true,
      ...discoverProducedWorkspace(args.command.path, inspection),
    };
  } catch (error) {
    discovered = {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  const completedAt = Date.now();
  const report = discovered.ok
    ? buildLiveHostCommandSuccessReport({
        command: args.command,
        completedAt,
        execution: args.execution,
        result: discovered.properties,
      })
    : buildLiveHostCommandFailureReport({
        command: args.command,
        completedAt,
        error: discovered.error,
        execution: args.execution,
      });
  const headSha = discovered.ok ? discovered.headSha : null;
  try {
    await runLiveHostCommandSettlement(deps, (settlementDeps) =>
      settleEnvironmentProvisionOutcome({
        command: args.command,
        deps: settlementDeps,
        execution: args.execution,
        headSha,
        initiatorStreamed: false,
        mergeBaseBranch: args.mergeBaseBranch,
        report,
      }),
    );
  } catch (settlementError) {
    deps.logger.error(
      {
        err: settlementError,
        environmentId: args.environment.id,
        hostId: args.environment.hostId,
      },
      "Produced environment settlement failed",
    );
  }
}

export async function advanceEnvironmentProvisioning(
  deps: CommandResultSideEffectsDeps,
  args: AdvanceEnvironmentProvisioningArgs,
): Promise<void> {
  if (!args.environmentId) {
    return;
  }

  const environment = getEnvironment(deps.db, args.environmentId);
  if (!environment || environment.status === "destroyed") {
    return;
  }
  if (!args.request) {
    if (hasLiveEnvironmentProvisionInFlight(environment.id)) {
      return;
    }
    interruptUnrecoverableEnvironmentProvisioning(deps, {
      environmentId: environment.id,
      reason:
        "Environment setup did not finish. Retry provisioning to continue.",
    });
    return;
  }
  startTrackedEnvironmentProvisionCommand(deps, {
    environment,
    request: args.request,
  });
}
