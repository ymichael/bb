import { and, desc, eq, isNull } from "drizzle-orm";
import {
  events,
  type DbConnection,
  type DbNotifier,
  type DbQueryConnection,
  type DbTransaction,
  getAppSettings,
  getEnvironment,
  getThread,
  listStoredThreadProvisioningRowsByProvisioningId,
  threads,
} from "@bb/db";
import { recordProvisionedEnvironmentWorkspace } from "@bb/db/internal-environment-lifecycle";
import type {
  Environment,
  ProvisioningTranscriptEntry,
  SystemThreadProvisioningStatus,
  ThreadStatus,
} from "@bb/domain";
import {
  systemThreadProvisioningEventDataSchema,
  threadScope,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  appendSystemErrorEventInTransaction,
  appendThreadProvisioningEventInTransaction,
  buildCwdBranchEntries,
} from "../threads/thread-events.js";
import {
  buildEnvironmentProvisionCommand,
  buildManagedBranchName,
  SETUP_TIMEOUT_MS,
  requireSourceForHost,
  storedBaseBranchNameToSpec,
} from "../threads/thread-create-helpers.js";
import {
  resolveManagedTargetPath,
  resolvePersonalTargetPath,
} from "../threads/worktree-paths.js";
import type { EnvironmentProvisionRequest } from "./environment-provision-request.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  createLiveHostCommandExecution,
  expectedLiveHostCommandErrorLogFields,
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
} from "../hosts/live-command.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "../threads/lifecycle-outcome.js";
import {
  applyLoggedEnvironmentLifecycleEvent,
  applyLoggedEnvironmentLifecycleEventInTransaction,
} from "./lifecycle-outcome.js";
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
  requestEnvironmentCleanup,
  runEnvironmentCleanupAdvance,
} from "./environment-cleanup-internal.js";
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
  HostDaemonCommandForType<"environment.provision">;
type EnvironmentProvisionCommandResultReport =
  CommandResultReportForType<"environment.provision">;
type EnvironmentProvisionCancelCommand =
  HostDaemonCommandForType<"environment.provision.cancel">;
type EnvironmentProvisionCancelCommandResultReport =
  CommandResultReportForType<"environment.provision.cancel">;

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

interface CompletePathlessDestroyInTransactionArgs {
  environment: Pick<
    NonNullable<ReturnType<typeof getEnvironment>>,
    "destroyAttemptId" | "path" | "status"
  >;
  environmentId: string;
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
  environment: Environment;
  request: EnvironmentProvisionRequest;
}

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

function isWorkspaceProvisioningTranscriptEntry(
  entry: ProvisioningTranscriptEntry,
): boolean {
  return WORKSPACE_PROVISIONING_TRANSCRIPT_KEYS.has(entry.key);
}

const WORKSPACE_PROVISIONING_TRANSCRIPT_KEYS = new Set([
  "git-checkout-completed",
  "git-checkout-failed",
  "git-checkout-started",
  "git-clone-completed",
  "git-clone-failed",
  "git-clone-started",
  "git-worktree-command",
  "git-worktree-completed",
  "git-worktree-failed",
  "git-worktree-started",
  "setup-completed",
  "setup-failed",
  "setup-started",
  "workspace-branch",
  "workspace-path",
  "workspace-source",
  "workspace-target",
]);

const activeEnvironmentProvisionRpcEnvironmentIds = new Set<string>();

function hasLiveEnvironmentProvisionInFlight(environmentId: string): boolean {
  return activeEnvironmentProvisionRpcEnvironmentIds.has(environmentId);
}

function hasStreamedProvisioningTranscript(
  deps: EnvironmentProvisionReadDeps,
  threadId: string,
  provisioningId: string,
): boolean {
  const rows = listStoredThreadProvisioningRowsByProvisioningId(deps.db, {
    threadId,
    provisioningId,
  });

  return rows.some((row) => {
    const eventData = systemThreadProvisioningEventDataSchema.parse(
      JSON.parse(row.data),
    );
    return (
      eventData.provisioningId === provisioningId &&
      eventData.entries.some(isWorkspaceProvisioningTranscriptEntry)
    );
  });
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
  environment: Environment;
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
    completePathlessDestroyInTransaction(deps, {
      environmentId: args.environment.id,
      environment: outcome.environment,
    });
  }

  return true;
}

function completePathlessDestroyInTransaction(
  deps: EnvironmentProvisionTransactionDeps,
  args: CompletePathlessDestroyInTransactionArgs,
): void {
  if (args.environment.status !== "destroying" || args.environment.path) {
    return;
  }
  const completedOutcome = applyLoggedEnvironmentLifecycleEventInTransaction(
    deps,
    {
      environmentId: args.environmentId,
      event: {
        type: "destroy.completed",
        destroyAttemptId: args.environment.destroyAttemptId,
      },
    },
  );
  if (completedOutcome.applied) {
    deps.hub.notifyEnvironment(args.environmentId, completedOutcome.changes);
  }
}

interface ProvisionedEnvironmentBranchMetadata {
  baseBranch?: string | null;
  mergeBaseBranch?: string | null;
}

function resolveProvisionedEnvironmentBranchMetadata(
  command: EnvironmentProvisionCommand,
): ProvisionedEnvironmentBranchMetadata {
  if (command.workspaceProvisionType !== "unmanaged") {
    return {};
  }

  if (!command.checkout) {
    return {};
  }

  if (command.checkout.kind === "new") {
    return {
      baseBranch: null,
      mergeBaseBranch: command.checkout.baseBranch,
    };
  }

  return {
    baseBranch: null,
    mergeBaseBranch: null,
  };
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
        ...resolveProvisionedEnvironmentBranchMetadata(args.command),
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
    });

    for (const thread of boundThreads) {
      if (thread.deletedAt !== null) {
        finalizeStoppedThreadInTransaction(args.deps, {
          threadId: thread.id,
        });
        postCommitActions.push({
          run: (deps) =>
            runEnvironmentCleanupAdvance(deps, {
              environmentId: args.command.environmentId,
            }),
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

      const isInitiator = thread.id === args.command.initiator?.threadId;
      const hasStreamedTranscript =
        isInitiator && args.command.initiator
          ? hasStreamedProvisioningTranscript(
              args.deps,
              thread.id,
              args.command.initiator.provisioningId,
            )
          : false;
      const entries = hasStreamedTranscript
        ? []
        : isInitiator && args.report.result.transcript.length > 0
          ? args.report.result.transcript
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

    postCommitActions.push({
      run: (deps) =>
        runEnvironmentCleanupAdvance(deps, {
          environmentId: args.command.environmentId,
        }),
    });
    return { postCommitActions };
  }

  if (!initiator) {
    return emptyCommandResultSideEffects();
  }
  const environmentProvisioningId = initiator.provisioningId;
  const failureHandled = recordEnvironmentProvisioningFailureInTransaction(
    args.deps,
    {
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
    },
  );
  if (failureHandled) {
    postCommitActions.push({
      run: (deps) => {
        requestEnvironmentCleanup(deps, {
          environmentId: args.command.environmentId,
        });
        runEnvironmentCleanupAdvance(deps, {
          environmentId: args.command.environmentId,
        });
      },
    });
  }
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
  const restoredProvisioningEnvironment = cancelledOutcome.applied;
  if (cancelledOutcome.applied) {
    args.deps.hub.notifyEnvironment(
      args.command.environmentId,
      cancelledOutcome.changes,
    );
    completePathlessDestroyInTransaction(args.deps, {
      environmentId: args.command.environmentId,
      environment: cancelledOutcome.environment,
    });
  }

  for (const thread of stoppedThreads) {
    finalizeStoppedThreadInTransaction(args.deps, {
      threadId: thread.id,
    });
  }
  const finalizedThread = stoppedThreads.length > 0;

  if (finalizedThread || restoredProvisioningEnvironment) {
    postCommitActions.push({
      run: (deps) => {
        requestEnvironmentCleanup(deps, {
          environmentId: args.command.environmentId,
        });
        runEnvironmentCleanupAdvance(deps, {
          environmentId: args.command.environmentId,
        });
      },
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

export const MANAGED_REPROVISION_STARTED = "started" as const;
export const MANAGED_REPROVISION_IN_PROGRESS = "already-provisioning" as const;
interface StartedManagedReprovision {
  provisionEventSequence: number;
  status: typeof MANAGED_REPROVISION_STARTED;
}
type ManagedReprovisionResult =
  | StartedManagedReprovision
  | typeof MANAGED_REPROVISION_IN_PROGRESS;

interface ActiveManagedEnvironmentProvisionArgs {
  environmentId: string;
}

interface DispatchManagedEnvironmentReprovisionArgs {
  beforeProvisionCommandStart?: () => void;
  environment: Environment;
  projectId: string;
  provisionEventSequence: number;
  provisioningId: string;
  threadId: string;
}

export function hasActiveManagedEnvironmentProvision(
  deps: Pick<AppDeps, "db">,
  args: ActiveManagedEnvironmentProvisionArgs,
): boolean {
  return getEnvironment(deps.db, args.environmentId)?.status === "provisioning";
}

export async function dispatchManagedEnvironmentReprovision(
  deps: CommandResultSideEffectsDeps,
  args: DispatchManagedEnvironmentReprovisionArgs,
): Promise<ManagedReprovisionResult> {
  const provisionType = args.environment.workspaceProvisionType;
  if (!args.environment.managed || provisionType === "unmanaged") {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment cannot be reprovisioned automatically",
      {
        details: {
          managed: args.environment.managed,
          workspaceProvisionType: provisionType,
        },
      },
    );
  }

  if (
    hasActiveManagedEnvironmentProvision(deps, {
      environmentId: args.environment.id,
    })
  ) {
    return MANAGED_REPROVISION_IN_PROGRESS;
  }

  const hostSession = await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });

  const initiator = {
    threadId: args.threadId,
    provisioningId: args.provisioningId,
  };
  const command =
    provisionType === "personal"
      ? buildEnvironmentProvisionCommand({
          environmentId: args.environment.id,
          hostId: args.environment.hostId,
          initiator,
          targetPath:
            args.environment.path ??
            resolvePersonalTargetPath({
              dataDir: hostSession.dataDir,
              environmentId: args.environment.id,
            }),
          workspaceProvisionType: provisionType,
        })
      : (() => {
          const source = requireSourceForHost(
            deps,
            args.projectId,
            args.environment.hostId,
          );
          const targetPath =
            args.environment.path ??
            resolveManagedTargetPath({
              dataDir: hostSession.dataDir,
              environmentId: args.environment.id,
              sourcePath: source.path,
            });
          const branchName =
            args.environment.branchName ??
            buildManagedBranchName({
              branchPrefix: getAppSettings(deps.db).managedBranchPrefix,
              threadId: args.threadId,
            });
          const baseBranch = storedBaseBranchNameToSpec(
            args.environment.baseBranch,
          );
          return buildEnvironmentProvisionCommand({
            branchName,
            baseBranch,
            environmentId: args.environment.id,
            hostId: args.environment.hostId,
            initiator,
            sourcePath: source.path,
            targetPath,
            workspaceProvisionType: provisionType,
            setupTimeoutMs: SETUP_TIMEOUT_MS,
          });
        })();

  args.beforeProvisionCommandStart?.();
  applyLoggedEnvironmentLifecycleEvent(deps, {
    environmentId: args.environment.id,
    event: { type: "provision.requested" },
  });
  await advanceEnvironmentProvisioning(deps, {
    environmentId: args.environment.id,
    request: { command },
  });
  return {
    provisionEventSequence: args.provisionEventSequence,
    status: MANAGED_REPROVISION_STARTED,
  };
}
