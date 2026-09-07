import {
  promptInputSchema,
  queuedMessageWaitingOnSchema,
  threadQueuedMessageSchema,
} from "@bb/domain";
import type {
  PermissionMode,
  PromptInput,
  QueuedMessagePayload,
  QueuedMessagePayloadKind,
  QueuedMessageWaitingOn,
  ThreadQueuedMessage,
} from "@bb/domain";
import { z } from "zod";
import { ApiError } from "../../errors.js";

interface StoredQueuedThreadMessageRow {
  claimedAt: number | null;
  content: string;
  createdAt: number;
  failureReason: string | null;
  id: string;
  groupWithNext: boolean;
  model: string;
  payloadKind: QueuedMessagePayloadKind;
  reasoningLevel: string;
  retryAttempt: number | null;
  retryOfTurnRequestId: string | null;
  retryReason: string | null;
  permissionMode: PermissionMode;
  sendAt: number | null;
  serviceTier: string;
  threadId: string;
  updatedAt: number;
  waitingOn: string | null;
}

function parseStoredQueuedThreadMessageContent(
  row: Pick<StoredQueuedThreadMessageRow, "content" | "id" | "threadId">,
): PromptInput[] {
  let content: unknown;
  try {
    content = JSON.parse(row.content);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const parsed = z.array(promptInputSchema).min(1).safeParse(content);
  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is malformed`,
    );
  }

  return parsed.data;
}

export function parseStoredQueuedThreadMessageWaitingOn(
  row: Pick<StoredQueuedThreadMessageRow, "id" | "threadId" | "waitingOn">,
): QueuedMessageWaitingOn | null {
  if (row.waitingOn === null) return null;

  let waitingOn: unknown;
  try {
    waitingOn = JSON.parse(row.waitingOn);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} has a malformed wait`,
    );
  }

  const parsed = queuedMessageWaitingOnSchema.safeParse(waitingOn);
  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} has a malformed wait`,
    );
  }
  return parsed.data;
}

/**
 * Assemble the row's retry columns into the payload union. A `retry` row that
 * is missing either column is a write-side bug, not a shape a reader should
 * paper over, so it fails loudly rather than degrading to `inline`.
 */
function toQueuedMessagePayload(
  row: StoredQueuedThreadMessageRow,
): QueuedMessagePayload {
  if (row.payloadKind === "inline") {
    return { kind: "inline" };
  }
  if (
    row.retryOfTurnRequestId === null ||
    row.retryAttempt === null ||
    row.retryReason === null
  ) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is a retry with no original request`,
    );
  }
  return {
    kind: "retry",
    retryOfTurnRequestId: row.retryOfTurnRequestId,
    attempt: row.retryAttempt,
    reason: row.retryReason,
  };
}

export function toThreadQueuedMessage(
  row: StoredQueuedThreadMessageRow,
): ThreadQueuedMessage {
  return threadQueuedMessageSchema.parse({
    id: row.id,
    threadId: row.threadId,
    content: parseStoredQueuedThreadMessageContent(row),
    model: row.model,
    reasoningLevel: row.reasoningLevel,
    permissionMode: row.permissionMode,
    serviceTier: row.serviceTier,
    groupWithNext: row.groupWithNext,
    sendAt: row.sendAt,
    waitingOn: parseStoredQueuedThreadMessageWaitingOn(row),
    failureReason: row.failureReason,
    payload: toQueuedMessagePayload(row),
    // An `inline` draft stops being editable the moment the drain claims it:
    // the row is on its way to a provider and a rewrite would be lost.
    editable: row.payloadKind === "inline" && row.claimedAt === null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
