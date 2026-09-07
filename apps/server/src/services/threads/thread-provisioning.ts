import { getThread, type DbTransaction } from "@bb/db";
import {
  type Environment,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
  type SystemMessageKind,
  type SystemMessageSubject,
  type Thread,
  type ThreadTurnInitiator,
  type TurnRequestTarget,
} from "@bb/domain";
import type { StartedOnBehalfOf } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  appendClientTurnEvent,
  appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  buildCwdBranchEntries,
  createClientTurnRequestId,
} from "./thread-events.js";
import { requestThreadStart } from "./thread-lifecycle.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import {
  createMetadataPendingContext,
  createReprovisioningContext,
  type ThreadForkDescriptor,
  type ThreadProvisionEnvironmentIntent,
  type ThreadProvisionContext,
  type ThreadProvisionProvisionableContext,
} from "./thread-provisioning-context.js";
import {
  ensureThreadProvisionEnvironmentReady,
  ensureWorkspaceReadyEvent,
  failThreadProvisioning,
  loadActiveThreadProvisionContext,
  type ThreadProvisioningDeps,
} from "./thread-provisioning-environment.js";
import {
  forgetActiveThreadProvisionContext,
  getActiveThreadProvisionContext,
  rememberActiveThreadProvisionContext,
} from "./thread-provisioning-active-context.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { recordAcceptedPromptHistoryEntry } from "../prompt-history.js";

interface RequestThreadProvisionArgs {
  environmentIntent: ThreadProvisionEnvironmentIntent;
  execution: ResolvedThreadExecutionOptions;
  fork: ThreadForkDescriptor | null;
  input: PromptInput[];
  providerInput?: PromptInput[];
  startedOnBehalfOf: StartedOnBehalfOf | null;
  thread: Thread;
  titleProvided: boolean;
}

interface RequestThreadReprovisionArgs {
  beforeRequestAppendInTransaction?: (args: { tx: DbTransaction }) => void;
  environment: Environment;
  provisionEventSequence: number;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  initiator: ThreadTurnInitiator;
  provisioningId: string;
  senderThreadId: string | null;
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  thread: Thread;
}

interface AdvanceThreadProvisioningArgs {
  context?: ThreadProvisionContext;
  threadId: string;
}

interface CurrentProvisioningFailureThreadArgs {
  context: ThreadProvisionContext;
  threadId: string;
}

interface EnvironmentPayloadThreadArgs {
  context: ThreadProvisionProvisionableContext;
  environment: Environment;
  thread: Thread;
}

function getCurrentProvisioningFailureThread(
  deps: Pick<AppDeps, "db">,
  args: CurrentProvisioningFailureThreadArgs,
): Thread | null {
  const currentThread = getThread(deps.db, args.threadId);
  if (!currentThread || currentThread.deletedAt !== null) {
    forgetActiveThreadProvisionContext(args.threadId);
    return null;
  }
  if (
    currentThread.status !== "starting" ||
    currentThread.archivedAt !== null
  ) {
    forgetActiveThreadProvisionContext(args.threadId);
    return null;
  }

  const activeContext = getActiveThreadProvisionContext(args.threadId);
  if (
    activeContext &&
    activeContext.state.provisioningId !== args.context.state.provisioningId
  ) {
    return null;
  }

  return currentThread;
}

async function startThreadIfEnvironmentReady(
  deps: ThreadProvisioningDeps,
  args: EnvironmentPayloadThreadArgs,
): Promise<void> {
  if (args.environment.status === "error") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment provisioning failed",
    });
    return;
  }
  if (args.environment.status === "provisioning") {
    return;
  }
  if (args.environment.status !== "ready") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: `Environment is ${args.environment.status}`,
    });
    return;
  }
  if (!args.environment.path) {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment is ready without a workspace path",
    });
    return;
  }

  const workspaceReady = ensureWorkspaceReadyEvent(deps, {
    context: args.context,
    threadId: args.thread.id,
    environmentId: args.environment.id,
    entries: buildCwdBranchEntries({
      path: args.environment.path,
      branchName: args.environment.branchName,
    }),
  });
  if (!workspaceReady.reached) {
    throw new Error("Thread did not reach workspace-ready provisioning state");
  }

  // The workspace exists, so anything that queued waiting for it stops
  // waiting here rather than after the dispatch below: the wait is over at
  // this line, and the `run.succeeded` branch below returns without
  // dispatching anything. A thread with nothing queued no-ops.
  requestQueuedMessageDispatch(deps, {
    kind: "workspace-ready",
    threadId: args.thread.id,
  });

  if (
    args.context.request.seedWithoutRun &&
    args.context.request.fork === null
  ) {
    const outcome = applyLoggedThreadLifecycleEvent(deps, {
      threadId: args.thread.id,
      event: { type: "run.succeeded" },
    });
    if (!outcome.applied) {
      deps.logger.warn(
        { threadId: args.thread.id },
        "Seed-without-run thread was no longer starting; idle settle skipped",
      );
    }
    return;
  }

  await requestThreadStart(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      status: args.environment.status,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
    fork: args.context.request.fork,
    input: args.context.request.input,
    ...(args.context.request.inputGroups !== undefined
      ? { inputGroups: args.context.request.inputGroups }
      : {}),
    requestId: args.context.request.clientRequestId,
    execution: args.context.request.execution,
    permissionEscalation: resolvePermissionEscalation({
      initiator: "user",
    }),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    syncGeneratedTitle: !args.context.request.titleProvided,
  });
}

export function requestThreadProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadProvisionArgs,
): ThreadProvisionContext {
  const initiator: ThreadTurnInitiator =
    args.startedOnBehalfOf?.initiator ?? "user";
  const senderThreadId = args.startedOnBehalfOf?.senderThreadId ?? null;
  const target: TurnRequestTarget = { kind: "thread-start" };
  const request = appendClientTurnEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator,
    senderThreadId,
    requestMethod: "thread/start",
    source: "spawn",
    target,
  });
  recordAcceptedPromptHistoryEntry(deps, {
    thread: args.thread,
    input: args.input,
    initiator,
    target,
    requestSequence: request.sequence,
  });
  appendClientTurnEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    type: "client/thread/start",
    initiator,
    requestMethod: "thread/start",
    source: "spawn",
  });

  const context = createMetadataPendingContext({
    ...args,
    clientRequestId: request.requestId,
    input: args.providerInput ?? args.input,
    seedWithoutRun: args.startedOnBehalfOf !== null,
  });
  rememberActiveThreadProvisionContext({
    threadId: args.thread.id,
    context,
  });
  return context;
}

export function requestThreadReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadReprovisionArgs,
): ThreadProvisionContext {
  const requestId = createClientTurnRequestId();
  const request = deps.db.transaction(
    (tx) => {
      args.beforeRequestAppendInTransaction?.({ tx });
      const request =
        appendPreparedClientTurnRequestedEventWithNotificationInTransaction(
          tx,
          {
            threadId: args.thread.id,
            environmentId: args.environment.id,
            type: "client/turn/requested",
            input: args.input,
            ...(args.inputGroups !== undefined
              ? { inputGroups: args.inputGroups }
              : {}),
            execution: args.execution,
            initiator: args.initiator,
            senderThreadId: args.senderThreadId,
            systemMessageKind: args.systemMessageKind,
            systemMessageSubject: args.systemMessageSubject,
            requestMethod: "turn/start",
            source: "tell",
            target: { kind: "new-turn" },
            requestId,
          },
        );
      recordAcceptedPromptHistoryEntry(
        { db: tx },
        {
          thread: args.thread,
          input: args.input,
          initiator: args.initiator,
          target: { kind: "new-turn" },
          requestSequence: request.sequence,
        },
      );
      return request;
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(
    args.thread.id,
    request.notificationChanges,
    request.notificationMetadata,
  );

  const context = createReprovisioningContext({
    clientRequestId: request.requestId,
    provisionEventSequence: args.provisionEventSequence,
    execution: args.execution,
    environmentId: args.environment.id,
    input: args.input,
    ...(args.inputGroups !== undefined
      ? { inputGroups: args.inputGroups }
      : {}),
    provisioningId: args.provisioningId,
  });
  rememberActiveThreadProvisionContext({
    threadId: args.thread.id,
    context,
  });
  return context;
}

async function advanceThreadProvisioningOnce(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.deletedAt !== null) {
    return;
  }
  if (thread.status !== "starting") {
    forgetActiveThreadProvisionContext(thread.id);
    return;
  }
  let context =
    args.context ?? loadActiveThreadProvisionContext(deps, thread.id);
  if (!context) {
    failThreadProvisioning(deps, {
      thread,
      environmentId: thread.environmentId,
      detail: "Thread setup did not finish. Retry the thread to continue.",
    });
    return;
  }
  if (thread.archivedAt !== null) {
    return;
  }

  try {
    const ready = await ensureThreadProvisionEnvironmentReady(deps, {
      context,
      thread,
    });
    context = ready.context;
    await startThreadIfEnvironmentReady(deps, {
      context: ready.context,
      environment: ready.environment,
      thread: ready.thread,
    });
  } catch (error) {
    const failureThread = getCurrentProvisioningFailureThread(deps, {
      context,
      threadId: thread.id,
    });
    if (!failureThread) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    failThreadProvisioning(deps, {
      thread: failureThread,
      environmentId: context.state.environmentId ?? failureThread.environmentId,
      detail,
    });
  }
}

export async function advanceThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  await deps.lifecycleDedupers.threadProvisionAdvance.run(args.threadId, () =>
    advanceThreadProvisioningOnce(deps, args),
  );
}

/**
 * Drives provisioning off the caller's stack. Creation returns the thread row
 * before the workspace exists, and a cold-start row whose wait cleared returns
 * to its sweep or route the same way, so neither waits on the daemon.
 */
export function scheduleThreadProvisioningAdvance(
  deps: ThreadProvisioningDeps & Pick<AppDeps, "config" | "logger">,
  context: ThreadProvisionContext,
  threadId: string,
): void {
  void advanceThreadProvisioning(deps, {
    context,
    threadId,
  }).catch((error) => {
    deps.logger.warn(
      {
        threadId,
        ...runtimeErrorLogFields(deps.config, error),
      },
      "Failed to advance thread provisioning",
    );
  });
}
