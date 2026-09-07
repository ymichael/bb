import {
  getLastStoredTurnRequestEvent,
  getLatestStoredRateLimitsEventForProvider,
  getLatestStoredThreadEventOfTypes,
  getThread,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnRejectedRowsByClientRequestIds,
  type DbConnection,
  type StoredThreadEventDataRow,
} from "@bb/db";
import {
  providerErrorInfoSchema,
  providerRateLimitStateSchema,
  type ClientTurnRequestId,
  type ProviderErrorInfo,
  type ProviderRateLimitState,
  type Thread,
  type TurnRequestEventData,
} from "@bb/domain";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseStoredTurnRequestEvent } from "./thread-events.js";

/** The message shapes the fallback query can return, by event type. */
const providerErrorDataSchema = z.object({
  message: z.string(),
  errorInfo: providerErrorInfoSchema.optional(),
});

const rateLimitsDataSchema = z.object({
  rateLimits: providerRateLimitStateSchema,
});

const rejectedReasonDataSchema = z.object({
  reason: z.string(),
});

function parseRowData(row: StoredThreadEventDataRow): unknown {
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export interface FailedTurnRecord {
  request: TurnRequestEventData;
  requestSequence: number;
}

/**
 * The turn whose failure just landed: the most recent request on the thread.
 *
 * A failure applies at the moment the thread leaves `active`/`starting`, and
 * nothing else can have appended a request in between — the send path only
 * appends one while dispatching, and a queue drain waits for the thread to be
 * quiescent, which this failure is what makes it. Returns null for a thread
 * that has never dispatched a turn (a start that failed before any request),
 * where there is nothing to announce and nothing for a retry to re-submit.
 */
export function loadFailedTurn(
  db: DbConnection,
  threadId: string,
): FailedTurnRecord | null {
  const row = getLastStoredTurnRequestEvent(db, threadId);
  if (row === null) return null;
  try {
    return {
      request: parseStoredTurnRequestEvent(row),
      requestSequence: row.sequence,
    };
  } catch {
    return null;
  }
}

/**
 * Which attempt failed, and which request the chain started from.
 *
 * Both come off the failed request itself rather than a tally: the marker
 * written when a retry dispatched IS the counter, so restarts, re-queues and a
 * server that never saw the earlier attempts all arrive at the same number.
 */
export function retryChain(request: TurnRequestEventData): {
  attemptNumber: number;
  originalRequestId: ClientTurnRequestId;
} {
  return {
    attemptNumber: request.retryAttempt ?? 1,
    originalRequestId: request.retryOfRequestId ?? request.requestId,
  };
}

/**
 * Whether the provider accepted the failed turn's input before the failure.
 *
 * Acceptance is the provider's own statement that the input entered its
 * conversation, recorded as the mandatory `turn/input/accepted` event keyed by
 * the request id. It is the fact that splits a failure into its two shapes:
 * accepted-then-failed means the provider holds the message (and possibly
 * partial output) that no provider rolls back, while never-accepted means the
 * request died at the door and the provider has no record of it.
 */
export function wasFailedTurnInputAccepted(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): boolean {
  return (
    listStoredTurnInputAcceptedRowsByClientRequestIds(db, {
      threadId: args.threadId,
      clientRequestIds: [args.failed.request.requestId],
      afterSequence: args.failed.requestSequence,
    }).length > 0
  );
}

/**
 * The structured classification of a request the provider refused at the door.
 *
 * A rejected dispatch never produces a `provider/error` event — no provider
 * turn existed to carry one — so the typed code the runtime attached to the
 * `client/turn/rejected` row is the failure's only classification. Mapping it
 * here is what lets a retry policy see a door-rejected rate limit as the same
 * category a mid-stream one reports; unmapped reasons stay null, exactly as
 * before.
 */
function doorRejectionErrorInfo(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): ProviderErrorInfo | null {
  const row = listStoredTurnRejectedRowsByClientRequestIds(db, {
    threadId: args.threadId,
    clientRequestIds: [args.failed.request.requestId],
    afterSequence: args.failed.requestSequence,
  })[0];
  if (row === undefined) return null;
  const reason = rejectedReasonDataSchema.safeParse(parseRowData(row)).data
    ?.reason;
  switch (reason) {
    case "rate_limited":
      return {
        category: "rate-limit",
        providerCode: null,
        httpStatusCode: null,
      };
    case "auth_required":
      return {
        category: "unauthorized",
        providerCode: null,
        httpStatusCode: null,
      };
    default:
      return null;
  }
}

/**
 * The `turn.failed` payload: ids and failure facts, assembled from the failed
 * turn's own records so a listener never replays the event log itself.
 *
 * Deliberately carries no thread DTO and no copy of the message. A retry is
 * asked for BY REFERENCE (`sdk.threads.retry`), so the request id is the whole
 * of what a policy needs, and a listener that wants more reads it when it uses
 * it rather than being handed a snapshot that is already aging.
 *
 * Returns null when the thread is gone or never dispatched a turn — there is
 * no failed turn to announce.
 */
export function buildTurnFailedEvent(
  db: DbConnection,
  threadId: string,
): PluginTurnFailedEvent | null {
  const thread = getThread(db, threadId);
  if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
    return null;
  }
  const failed = loadFailedTurn(db, threadId);
  if (failed === null) return null;
  // The provider's own account of the failure, when the failure happened
  // inside a provider turn at all: it carries both the turn id and the
  // structured classification, so one row answers two fields.
  const providerError = getLatestStoredThreadEventOfTypes(db, {
    threadId,
    types: ["provider/error"],
    afterSequence: failed.requestSequence,
  });
  const providerErrorInfo: ProviderErrorInfo | null =
    providerError === null
      ? null
      : (providerErrorDataSchema.safeParse(parseRowData(providerError)).data
          ?.errorInfo ?? null);
  return {
    threadId,
    requestId: failed.request.requestId,
    turnId: providerError?.turnId ?? null,
    errorInfo:
      providerErrorInfo ?? doorRejectionErrorInfo(db, { threadId, failed }),
    inputAccepted: wasFailedTurnInputAccepted(db, { threadId, failed }),
    rateLimits: latestRateLimits(db, thread),
    attemptNumber: retryChain(failed.request).attemptNumber,
  };
}

function latestRateLimits(
  db: DbConnection,
  thread: Thread,
): ProviderRateLimitState | null {
  const row = getLatestStoredRateLimitsEventForProvider(db, {
    threadId: thread.id,
    providerId: thread.providerId,
  });
  if (row === null) return null;
  return (
    rateLimitsDataSchema.safeParse(parseRowData(row)).data?.rateLimits ?? null
  );
}
