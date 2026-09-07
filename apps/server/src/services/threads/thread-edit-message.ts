import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  deleteThreadEventSuffixInTransaction,
  events,
  getActivePendingInteractionForThread,
  getExperiments,
  getHighWaterMarks,
  getThread,
  hasQueuedThreadMessages,
  hasRootStoredTurnStarted,
  listActiveBackgroundTaskCountsByThreadIds,
  type DbQueryConnection,
} from "@bb/db";
import {
  threadScope,
  type PromptInput,
  type Thread,
  type ThreadEvent,
} from "@bb/domain";
import type {
  EditMessageRequest,
  EditMessageResponse,
} from "@bb/server-contract";
import type {
  HostDaemonCommand,
  HostDaemonCommandResult,
} from "@bb/host-daemon-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  appendThreadEventInTransaction,
  createClientTurnRequestId,
  parseStoredTurnRequestEvent,
} from "./thread-events.js";
import { parseStoredEvent } from "./thread-data.js";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "./thread-commands.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { requireReadyThreadEnvironment } from "./thread-turn-dispatch.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import {
  LIVE_DAEMON_COMMAND_TIMEOUT_MS,
  runLiveHostCommand,
} from "../hosts/live-command.js";
import {
  resolveMessageSenderThreadId,
  sendThreadMessage,
} from "./thread-send.js";
import { requestThreadStopForCurrentState } from "./thread-lifecycle.js";
import { getLeadingAgentOnlyInput } from "./deferred-first-turn-context.js";

type ThreadRewindPrepareCommand = Extract<
  HostDaemonCommand,
  { type: "thread.rewind.prepare" }
>;

interface EditableTurn {
  leadingAgentOnlyInput: PromptInput[];
  currentTurnId: string;
  oldMaxSequence: number;
  precedingProviderCheckpoint: string | null;
  requestSequence: number;
  sourceProviderThreadId: string | null;
}

function conflict(message: string): never {
  throw new ApiError(409, "invalid_request", message);
}

function requestFingerprint(payload: EditMessageRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        expectedRequestSequence: payload.expectedRequestSequence,
        executionInputSources: payload.executionInputSources,
        input: payload.input,
        model: payload.model,
        permissionMode: payload.permissionMode,
        reasoningLevel: payload.reasoningLevel,
        senderThreadId: payload.senderThreadId,
        serviceTier: payload.serviceTier,
      }),
    )
    .digest("hex");
}

function findCommittedOperation(
  db: DbQueryConnection,
  args: { operationId: string; threadId: string },
): { fingerprint: string; requestSequence: number } | null {
  const row = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, "system/operation"),
        sql`json_extract(${events.data}, '$.operation') = 'edit_message'`,
        sql`json_extract(${events.data}, '$.operationId') = ${args.operationId}`,
      ),
    )
    .limit(1)
    .get();
  if (!row) return null;
  const event = parseStoredEvent(row);
  if (event.type !== "system/operation") return null;
  const fingerprint = event.metadata?.fingerprint;
  const requestSequence = event.metadata?.requestSequence;
  return typeof fingerprint === "string" && typeof requestSequence === "number"
    ? { fingerprint, requestSequence }
    : null;
}

const EDIT_MESSAGE_STOP_TIMEOUT_MS = 60_000;

function isMessageEditThreadQuiescent(thread: Pick<Thread, "status">): boolean {
  return thread.status === "idle" || thread.status === "error";
}

async function stopThreadBeforeMessageEdit(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    environment: Parameters<typeof requireReadyThreadEnvironment>[0];
    threadId: string;
  },
): Promise<Thread> {
  let thread = getThread(deps.db, args.threadId);
  if (!thread) conflict("Thread not found");
  if (isMessageEditThreadQuiescent(thread)) return thread;

  await ensureHostSessionReadyForWork(deps, {
    hostId: args.environment.hostId,
  });
  requestThreadStopForCurrentState(deps, thread, args.environment);

  const deadline = Date.now() + EDIT_MESSAGE_STOP_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      conflict("The thread did not stop before the message edit timed out");
    }
    const waiter = deps.hub.registerThreadEventWaiter(args.threadId, remaining);
    thread = getThread(deps.db, args.threadId);
    if (!thread) {
      waiter.cancel();
      conflict("Thread not found");
    }
    if (isMessageEditThreadQuiescent(thread)) {
      waiter.cancel();
      return thread;
    }
    if (!(await waiter.promise)) {
      conflict("The thread did not stop before the message edit timed out");
    }
  }
}

function getTurnCompletion(
  db: DbQueryConnection,
  threadId: string,
  turnId: string,
): Extract<ThreadEvent, { type: "turn/completed" }> | null {
  const row = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "turn/completed"),
        eq(events.turnId, turnId),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (!row) return null;
  const event = parseStoredEvent(row);
  return event.type === "turn/completed" ? event : null;
}

const CODEX_NATIVE_TURN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveTurnProviderCheckpointId(args: {
  providerCheckpointId: string | null | undefined;
  providerId: string;
  turnId: string;
}): string | null {
  if (args.providerCheckpointId) {
    return args.providerCheckpointId;
  }
  return args.providerId === "codex" &&
    CODEX_NATIVE_TURN_ID_PATTERN.test(args.turnId)
    ? args.turnId
    : null;
}

function resolveEditableTurnCandidate(
  db: DbQueryConnection,
  thread: Thread,
  requestRow: Parameters<typeof parseStoredTurnRequestEvent>[0],
): EditableTurn {
  const request = parseStoredTurnRequestEvent(requestRow);
  if (
    request.initiator !== "user" ||
    request.senderThreadId !== null ||
    (request.target.kind !== "new-turn" &&
      request.target.kind !== "thread-start")
  ) {
    conflict("The selected request is not an editable user turn");
  }
  if (request.inputGroups !== undefined) {
    conflict("Grouped messages cannot be edited yet");
  }

  const acceptedRows = db
    .select({ sequence: events.sequence, turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "turn/input/accepted"),
        sql`json_extract(${events.data}, '$.clientRequestId') = ${request.requestId}`,
      ),
    )
    .orderBy(events.sequence)
    .limit(2)
    .all();
  const accepted = acceptedRows.length === 1 ? acceptedRows[0] : undefined;
  if (!accepted?.turnId) {
    conflict("The selected request was not accepted into exactly one turn");
  }

  if (
    !hasRootStoredTurnStarted(db, {
      threadId: thread.id,
      turnId: accepted.turnId,
    })
  ) {
    conflict("The selected message does not belong to a root turn");
  }
  const precedingTurn = db
    .select({ turnId: events.turnId })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "turn/started"),
        lt(events.sequence, requestRow.sequence),
        isNull(events.parentToolCallId),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  const precedingTurnId = precedingTurn?.turnId ?? null;
  const precedingCompletion =
    precedingTurnId === null
      ? null
      : getTurnCompletion(db, thread.id, precedingTurnId);
  if (
    precedingTurnId !== null &&
    (precedingCompletion === null ||
      precedingCompletion.providerThreadId === null)
  ) {
    conflict("This earlier turn has no provider history");
  }
  const precedingProviderCheckpoint =
    precedingTurnId === null
      ? null
      : resolveTurnProviderCheckpointId({
          providerCheckpointId: precedingCompletion?.providerCheckpointId,
          providerId: thread.providerId,
          turnId: precedingTurnId,
        });
  if (precedingTurnId !== null && precedingProviderCheckpoint === null) {
    conflict("This earlier provider turn has no editable history checkpoint");
  }
  return {
    leadingAgentOnlyInput: getLeadingAgentOnlyInput(request.input),
    currentTurnId: accepted.turnId,
    oldMaxSequence: getHighWaterMarks(db, [thread.id])[thread.id] ?? 0,
    precedingProviderCheckpoint,
    requestSequence: requestRow.sequence,
    sourceProviderThreadId:
      precedingTurnId === null
        ? null
        : (precedingCompletion?.providerThreadId ?? null),
  };
}

function resolveEditableTurn(
  db: DbQueryConnection,
  thread: Thread,
  requestSequence?: number,
): EditableTurn {
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    conflict("The thread is not writable");
  }
  const backgroundActivity = listActiveBackgroundTaskCountsByThreadIds(db, {
    threadIds: [thread.id],
  })[0];
  if (
    backgroundActivity &&
    (backgroundActivity.activeBackgroundAgentCount > 0 ||
      backgroundActivity.activeBackgroundCommandCount > 0 ||
      backgroundActivity.activeWorkflowCount > 0)
  ) {
    conflict("Wait for background work to finish before editing the message");
  }

  if (requestSequence !== undefined) {
    const requestRow = db
      .select({
        data: events.data,
        sequence: events.sequence,
        threadId: events.threadId,
        type: events.type,
      })
      .from(events)
      .where(
        and(
          eq(events.threadId, thread.id),
          eq(events.type, "client/turn/requested"),
          eq(events.sequence, requestSequence),
        ),
      )
      .limit(1)
      .get();
    if (requestRow !== undefined) {
      return resolveEditableTurnCandidate(db, thread, requestRow);
    }
    conflict("The thread has no editable user message");
  }

  const requestRows = db
    .select({
      data: events.data,
      sequence: events.sequence,
      threadId: events.threadId,
      type: events.type,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, thread.id),
        eq(events.type, "client/turn/requested"),
        sql`json_extract(${events.data}, '$.initiator') = 'user'`,
        sql`json_extract(${events.data}, '$.senderThreadId') IS NULL`,
        sql`json_extract(${events.data}, '$.target.kind') IN ('new-turn', 'thread-start')`,
      ),
    )
    .orderBy(desc(events.sequence))
    .all();
  for (const requestRow of requestRows) {
    try {
      return resolveEditableTurnCandidate(db, thread, requestRow);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        error.body.code !== "invalid_request"
      ) {
        throw error;
      }
    }
  }
  conflict("The thread has no editable user message");
}

function rewindPrepareCommandFromStart(
  start: Extract<HostDaemonCommand, { type: "thread.start" }>,
  args: {
    leaseId: string;
    retainThroughProviderCheckpoint: string;
    sourceProviderThreadId: string;
  },
): ThreadRewindPrepareCommand {
  const {
    type: _type,
    requestId: _requestId,
    input: _input,
    inputGroups: _inputGroups,
    threadStoragePath: _threadStoragePath,
    fork: _fork,
    ...context
  } = start;
  return { type: "thread.rewind.prepare", ...context, ...args };
}

export async function editThreadMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    environment: Parameters<typeof requireReadyThreadEnvironment>[0];
    payload: EditMessageRequest;
    thread: Thread;
  },
): Promise<EditMessageResponse> {
  if (!getExperiments(deps.db).editMessages) {
    conflict("Enable the Edit messages experiment before editing a message");
  }
  if (!deps.providerRegistry.supportsSessionRewind(args.thread.providerId)) {
    conflict(`Editing messages is not supported for ${args.thread.providerId}`);
  }
  const fingerprint = requestFingerprint(args.payload);
  const committed = findCommittedOperation(deps.db, {
    operationId: args.payload.operationId,
    threadId: args.thread.id,
  });
  if (committed) {
    if (committed.fingerprint !== fingerprint) {
      conflict("The edit operation id was already used for different input");
    }
    return {
      ok: true,
      operationId: args.payload.operationId,
      requestSequence: committed.requestSequence,
    };
  }
  if (deps.pendingInteractions.hasPendingThreadInteraction(args.thread.id)) {
    conflict("Resolve the pending interaction before editing the message");
  }
  if (hasQueuedThreadMessages(deps.db, args.thread.id)) {
    conflict("Send or remove queued messages before editing a message");
  }
  const initialThread = getThread(deps.db, args.thread.id);
  if (!initialThread) conflict("Thread not found");
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: args.payload.senderThreadId,
    targetThread: initialThread,
  });
  const initiator = senderThreadId === null ? "user" : "agent";

  const initialTarget = resolveEditableTurn(
    deps.db,
    initialThread,
    args.payload.expectedRequestSequence,
  );
  const editableThread = await stopThreadBeforeMessageEdit(deps, {
    environment: args.environment,
    threadId: initialThread.id,
  });
  const target = resolveEditableTurn(
    deps.db,
    editableThread,
    initialTarget.requestSequence,
  );
  const readyEnvironment = requireReadyThreadEnvironment(args.environment);
  await ensureHostSessionReadyForWork(deps, {
    hostId: readyEnvironment.hostId,
  });
  const execution = await buildExecutionOptions(deps, args.payload, {
    threadId: editableThread.id,
  });

  let stagedProviderThreadId: string | null = null;
  let rewindLeaseId: string | null = null;
  if (target.precedingProviderCheckpoint !== null) {
    if (target.sourceProviderThreadId === null) {
      conflict("This earlier turn has no provider session");
    }
    rewindLeaseId = randomUUID();
    const startCommand = await buildThreadStartCommand(deps, {
      thread: editableThread,
      fork: null,
      input: [],
      requestId: createClientTurnRequestId(),
      execution,
      permissionEscalation: resolvePermissionEscalation({
        initiator,
      }),
      environment: readyEnvironment,
      projectId: editableThread.projectId,
      providerId: editableThread.providerId,
      syncGeneratedTitle: false,
    });
    const prepared: HostDaemonCommandResult<"thread.rewind.prepare"> =
      await runLiveHostCommand(deps, {
        command: rewindPrepareCommandFromStart(startCommand, {
          leaseId: rewindLeaseId,
          retainThroughProviderCheckpoint: target.precedingProviderCheckpoint,
          sourceProviderThreadId: target.sourceProviderThreadId,
        }),
        hostId: readyEnvironment.hostId,
        timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
      });
    stagedProviderThreadId = prepared.providerThreadId;
  }

  const requestSequence = target.oldMaxSequence + 2;
  const discardStagedRewind =
    stagedProviderThreadId === null || rewindLeaseId === null
      ? undefined
      : async () => {
          try {
            await runLiveHostCommand(deps, {
              command: {
                type: "thread.rewind.discard",
                environmentId: readyEnvironment.id,
                threadId: editableThread.id,
                leaseId: rewindLeaseId,
              },
              hostId: readyEnvironment.hostId,
              timeoutMs: LIVE_DAEMON_COMMAND_TIMEOUT_MS,
            });
          } catch (error) {
            deps.logger.warn(
              { err: error, threadId: editableThread.id },
              "Failed to discard staged message-edit rewind",
            );
          }
        };
  const {
    operationId: _operationId,
    expectedRequestSequence: _expectedRequestSequence,
    ...sendPayload
  } = args.payload;
  try {
    await sendThreadMessage(deps, {
      beforeAppendInTransaction: ({ tx }) => {
        if (getActivePendingInteractionForThread(tx, editableThread.id)) {
          conflict(
            "Resolve the pending interaction before editing the message",
          );
        }
        if (hasQueuedThreadMessages(tx, editableThread.id)) {
          conflict("Send or remove queued messages before editing a message");
        }
        const currentThread = getThread(tx, editableThread.id);
        if (!currentThread) conflict("Thread not found");
        if (!isMessageEditThreadQuiescent(currentThread)) {
          conflict("The thread changed while the edit was being prepared");
        }
        const currentTarget = resolveEditableTurn(
          tx,
          currentThread,
          target.requestSequence,
        );
        if (
          currentTarget.oldMaxSequence !== target.oldMaxSequence ||
          currentTarget.currentTurnId !== target.currentTurnId
        ) {
          conflict("The thread changed while the edit was being prepared");
        }
        appendThreadEventInTransaction(tx, {
          threadId: editableThread.id,
          environmentId: editableThread.environmentId,
          type: "system/operation",
          scope: threadScope(),
          data: {
            operation: "edit_message",
            status: "completed",
            message: "Message edited",
            operationId: args.payload.operationId,
            metadata: {
              cutoffSequence: target.requestSequence,
              oldMaxSequence: target.oldMaxSequence,
              removedTurnId: target.currentTurnId,
              replacementProviderThreadId: stagedProviderThreadId,
              fingerprint,
              requestSequence,
            },
          },
        });
        deleteThreadEventSuffixInTransaction(tx, {
          cutoffSequence: target.requestSequence,
          oldMaxSequence: target.oldMaxSequence,
          threadId: editableThread.id,
        });
      },
      environment: args.environment,
      historyReplacement: {
        forkSourceProviderThreadId: stagedProviderThreadId,
        ...(discardStagedRewind !== undefined
          ? { onCommandSettled: discardStagedRewind }
          : {}),
      },
      payload: {
        ...sendPayload,
        input: [...target.leadingAgentOnlyInput, ...sendPayload.input],
        mode: "start",
      },
      thread: editableThread,
      trigger: "user",
    });
    deps.hub.notifyThread(editableThread.id, ["history-rewritten"], {
      projectId: editableThread.projectId,
    });
  } catch (error) {
    await discardStagedRewind?.();
    const concurrentCommit = findCommittedOperation(deps.db, {
      operationId: args.payload.operationId,
      threadId: editableThread.id,
    });
    if (!concurrentCommit || concurrentCommit.fingerprint !== fingerprint) {
      throw error;
    }
    return {
      ok: true,
      operationId: args.payload.operationId,
      requestSequence: concurrentCommit.requestSequence,
    };
  }
  return {
    ok: true,
    operationId: args.payload.operationId,
    requestSequence,
  };
}
