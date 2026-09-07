import { hasQueuedRetryOfTurnRequest } from "@bb/db";
import { permissionModeSchema } from "@bb/domain";
import type {
  ClientTurnRequestId,
  PermissionMode,
  PromptInput,
  Thread,
} from "@bb/domain";
import type {
  RetryTurnRequest,
  RetryTurnResponse,
  SendMessageRequest,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import {
  loadFailedTurn,
  retryChain,
  wasFailedTurnInputAccepted,
  type FailedTurnRecord,
} from "./turn-failed.js";

type TurnRetryDeps = LoggedPendingInteractionWorkSessionDeps;

/**
 * True when this original request already has a retry row, waiting or claimed.
 *
 * One failure earns at most one live retry: a second row would re-submit the
 * same turn twice, which the user would see as two identical retry cards and
 * the provider as two identical turns.
 */
function hasQueuedRetryFor(
  deps: Pick<TurnRetryDeps, "db">,
  args: { threadId: string; originalRequestId: string },
): boolean {
  return hasQueuedRetryOfTurnRequest(deps.db, {
    threadId: args.threadId,
    retryOfTurnRequestId: args.originalRequestId,
  });
}

/**
 * The failed turn a retry re-submits.
 *
 * A thread has exactly one retryable turn: its most recent one, whose failure
 * is what put it in `error`. Anything earlier has already been answered by the
 * turns after it, so re-submitting it would ask the provider to redo work the
 * conversation has moved past. `turnRequestId` therefore ASSERTS which turn the
 * caller means rather than selecting among several — it is how a retry policy
 * that decided on one failure refuses to act on a different one it never saw.
 */
function requireFailedTurn(
  deps: Pick<TurnRetryDeps, "db">,
  args: { thread: Thread; turnRequestId: ClientTurnRequestId | null },
) {
  const { thread } = args;
  if (thread.status !== "error") {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Thread ${thread.id} has no failed turn to retry: it is ${thread.status}.`,
    );
  }
  const failed = loadFailedTurn(deps.db, thread.id);
  if (failed === null) {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Thread ${thread.id} failed before it dispatched a turn, so there is nothing to retry.`,
    );
  }
  if (
    args.turnRequestId !== null &&
    args.turnRequestId !== failed.request.requestId
  ) {
    throw new ApiError(
      409,
      "no_failed_turn",
      `Turn ${args.turnRequestId} is not the failed turn on thread ${thread.id}; its most recent turn is ${failed.request.requestId}.`,
    );
  }
  return failed;
}

export interface RetryFailedTurnArgs {
  thread: Thread;
  request: RetryTurnRequest;
}

const CONTINUE_ACCEPTED_TURN_TEXT = "Please continue.";

/**
 * What the re-attempt sends, decided by the provider's own acceptance record.
 *
 * An input the provider never accepted must be re-sent verbatim: the request
 * died at the door, the provider has no record of it, and the retry asks the
 * original question for the first time the provider will hear it. An input
 * the provider DID accept is already in its conversation — the failed attempt
 * left the message (and possibly partial output) in the provider session,
 * which no provider rolls back — so re-sending it would ask the same question
 * twice in a row; a continuation nudge is the honest re-attempt there.
 *
 * Either way the blocks are `agent-only`: the user's message stays where it
 * was, on the attempt that failed, using the same projection rule that has
 * always hidden system continuations.
 */
function retryInput(
  deps: Pick<TurnRetryDeps, "db">,
  args: { threadId: string; failed: FailedTurnRecord },
): { input: PromptInput[]; inputGroups?: PromptInput[][] } {
  if (wasFailedTurnInputAccepted(deps.db, args)) {
    return {
      input: [
        {
          type: "text",
          text: CONTINUE_ACCEPTED_TURN_TEXT,
          mentions: [],
          visibility: "agent-only",
        },
      ],
    };
  }
  const agentOnly = (block: PromptInput): PromptInput => ({
    ...block,
    visibility: "agent-only",
  });
  const groups = args.failed.request.inputGroups;
  return {
    input: args.failed.request.input.map(agentOnly),
    ...(groups === undefined
      ? {}
      : { inputGroups: groups.map((group) => group.map(agentOnly)) }),
  };
}

/**
 * The failed attempt's own execution tuple, replayed explicitly.
 *
 * A retry re-runs a turn the user already sent, so it runs the way that turn
 * ran — not the way the thread would resolve a NEW message today. Without
 * this, a thread-level model override changed between the failure and the
 * retry would silently swap the model under a turn nobody re-composed. A
 * legacy-recorded permission mode that the request schema no longer accepts
 * is the one field left to re-resolution.
 */
function retryExecution(failed: FailedTurnRecord): {
  model: string;
  reasoningLevel: SendMessageRequest["reasoningLevel"];
  serviceTier: SendMessageRequest["serviceTier"];
  permissionMode?: PermissionMode;
} {
  const { execution } = failed.request;
  const permissionMode = permissionModeSchema.safeParse(
    execution.permissionMode,
  ).data;
  return {
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    serviceTier: execution.serviceTier,
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}

/**
 * Originals with a retry currently being decided in this process.
 *
 * The queued-row check below cannot see a concurrent call that has passed it
 * but not yet written anything — two clients clicking Retry together would
 * both dispatch. One failure earns one retry, so the second caller gets the
 * same 409 a queued duplicate gets.
 */
const retriesInFlight = new Set<string>();

/**
 * Re-submits a failed turn.
 *
 * The retry is an ordinary dispatch attempt carrying a `retry` payload, which
 * is what makes it behave like everything else: a `sendAt` in the future queues
 * it on the clock, a busy thread queues it behind the running turn, and the
 * `message.dispatch` hook still gets to hold it — so a retry coming back after
 * a rate-limit window respects a limiter that is at capacity instead of jumping
 * the queue. What the attempt carries is `retryInput` and `retryExecution` decide.
 */
export async function retryFailedTurn(
  deps: TurnRetryDeps,
  args: RetryFailedTurnArgs,
): Promise<RetryTurnResponse> {
  const { request, thread } = args;
  const failed = requireFailedTurn(deps, {
    thread,
    turnRequestId: request.turnRequestId,
  });
  const chain = retryChain(failed.request);
  const originalRequestId = chain.originalRequestId;
  const inFlightKey = `${thread.id}:${originalRequestId}`;
  if (
    retriesInFlight.has(inFlightKey) ||
    hasQueuedRetryFor(deps, { threadId: thread.id, originalRequestId })
  ) {
    throw new ApiError(
      409,
      "retry_already_queued",
      `Turn ${originalRequestId} already has a retry waiting on thread ${thread.id}.`,
    );
  }
  retriesInFlight.add(inFlightKey);
  try {
    const attempt = chain.attemptNumber + 1;
    const outcome = await attemptDispatch(deps, {
      thread,
      payload: {
        // A retry never steers: it re-runs a turn, so a thread that is busy
        // again is something to wait behind rather than to interrupt.
        mode: "queue-if-active",
        ...retryInput(deps, { threadId: thread.id, failed }),
        ...retryExecution(failed),
        ...(request.sendAt === null ? {} : { sendAt: request.sendAt }),
      },
      source: { kind: "inline" },
      queuePayload: {
        kind: "retry",
        retryOfTurnRequestId: originalRequestId,
        attempt,
        reason: request.reason,
      },
      retryOf: { requestId: originalRequestId, attempt },
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      trigger: "user",
    });
    if (outcome.kind === "dispatched") {
      return {
        ok: true,
        delivery: "sent",
        turnRequestId: originalRequestId,
        attempt,
      };
    }
    return {
      ok: true,
      delivery: "queued",
      turnRequestId: originalRequestId,
      attempt,
      queuedMessageId: outcome.entry.id,
      // A queued row's `waitingOn` is null only when a drain cleared its wait
      // and is about to re-attempt it — a state this row, just written by the
      // attempt above, cannot be in. The fallback narrows the type honestly.
      waitingOn: outcome.entry.waitingOn ?? { kind: "thread-busy" },
      sendAt: outcome.entry.sendAt,
    };
  } finally {
    retriesInFlight.delete(inFlightKey);
  }
}
