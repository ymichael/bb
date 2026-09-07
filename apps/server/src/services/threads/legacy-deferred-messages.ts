import { sql } from "drizzle-orm";
import { z } from "zod";
import { getThread } from "@bb/db";
import {
  promptInputSchema,
  systemMessageKindSchema,
  systemMessageSubjectSchema,
} from "@bb/domain";
import { sendMessageRequestSchema } from "@bb/server-contract";
import type { SendMessageRequest } from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import { queueParentSystemMessage } from "./parent-system-messages.js";
import { acceptThreadSendRequest } from "./thread-send-request.js";

/**
 * Where the pre-queue `deferred_thread_messages` rows wait for this backfill.
 *
 * The queue rework replaced the deferral mechanism, but its rows were users'
 * held messages — a migration that dropped them would delete words somebody
 * wrote. Migration 0111 copies the rows into this table before dropping the
 * original, because they cannot be transferred in SQL: a queued row carries a
 * resolved execution tuple and a typed wait, both of which only the running
 * server can compute. This module finishes the job on startup and drops the
 * table once nothing is left in it.
 */
const LEGACY_DEFERRED_TABLE = "deferred_thread_messages_legacy";

/**
 * The old payload shapes, validated only as far as delivery needs.
 *
 * `send` held the original wire request, whose surrounding fields (mode
 * names, since-removed keys) may predate today's schema — so only `input` is
 * required and the rest is salvaged field-by-field below, rather than letting
 * one renamed enum value discard a user's message.
 */
const legacyDeferredPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("send"),
    request: z
      .object({ input: z.array(promptInputSchema).min(1) })
      .passthrough(),
  }),
  z.object({
    kind: z.literal("parent-system"),
    input: z.array(promptInputSchema),
    systemMessageKind: systemMessageKindSchema,
    systemMessageSubject: systemMessageSubjectSchema.nullable(),
  }),
]);

interface LegacyDeferredRow {
  id: string;
  threadId: string;
  payload: string;
}

function legacyDeferredTableExists(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): boolean {
  return (
    deps.db.get<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${LEGACY_DEFERRED_TABLE}`,
    ) !== undefined
  );
}

function toSendPayload(
  request: z.infer<typeof legacyDeferredPayloadSchema.options[0]>["request"],
): SendMessageRequest {
  // A deferred message's moment has passed, so its old delivery mode carries
  // no intent worth preserving: `auto` steers a running turn and starts an
  // idle one, which is the only sensible reading a week later.
  const revalidated = sendMessageRequestSchema.safeParse({
    ...request,
    mode: "auto",
  });
  return revalidated.success
    ? revalidated.data
    : { input: request.input, mode: "auto" };
}

/**
 * Delivers whatever the renamed `deferred_thread_messages` table still holds,
 * then drops it.
 *
 * Each row goes through today's machinery — the dispatch checkpoint for a
 * held send, the parent-notice path for a held notice — so it lands with a
 * correct typed wait instead of a guessed one, and is deleted only after its
 * delivery call returned. A row that fails is kept for the next startup, and
 * the table survives with it; an empty table is dropped, which is what makes
 * this a no-op on every later boot.
 *
 * Delivery and the delete are deliberately NOT atomic, because they cannot
 * be: delivery has effects outside the database (a dispatched turn, a host
 * command), so no transaction can span both. That leaves a choice of failure
 * for a crash between the two — delete-first loses the message silently,
 * delete-after delivers it twice on the next boot. For a table whose whole
 * purpose is not losing what a user wrote, the rare duplicate is the right
 * failure, so this is at-least-once on purpose.
 */
export async function deliverLegacyDeferredThreadMessages(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  if (!legacyDeferredTableExists(deps)) {
    return;
  }
  const rows = deps.db.all<LegacyDeferredRow>(
    sql`SELECT id, thread_id AS threadId, payload FROM deferred_thread_messages_legacy ORDER BY thread_id, created_at, id`,
  );
  let kept = 0;
  for (const row of rows) {
    try {
      const delivered = await deliverLegacyDeferredRow(deps, row);
      if (delivered === "kept") {
        kept += 1;
        continue;
      }
      deps.db.run(
        sql`DELETE FROM deferred_thread_messages_legacy WHERE id = ${row.id}`,
      );
    } catch (error) {
      kept += 1;
      deps.logger.warn(
        {
          deferredMessageId: row.id,
          threadId: row.threadId,
          ...runtimeErrorLogFields(deps.config, error),
        },
        "Could not deliver a legacy deferred message; keeping it for the next startup",
      );
    }
  }
  if (kept === 0) {
    deps.db.run(sql`DROP TABLE deferred_thread_messages_legacy`);
    if (rows.length > 0) {
      deps.logger.info(
        { migrated: rows.length },
        "Delivered the legacy deferred messages into the queue",
      );
    }
  }
}

async function deliverLegacyDeferredRow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  row: LegacyDeferredRow,
): Promise<"delivered" | "kept"> {
  const thread = getThread(deps.db, row.threadId);
  if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
    // The thread the message was waiting for is gone; there is nobody left
    // to deliver to, and that is a resolution rather than a failure.
    return "delivered";
  }
  const parsed = legacyDeferredPayloadSchema.safeParse(JSON.parse(row.payload));
  if (!parsed.success) {
    deps.logger.warn(
      { deferredMessageId: row.id, threadId: row.threadId },
      "Keeping an unrecognized legacy deferred payload",
    );
    return "kept";
  }
  if (parsed.data.kind === "send") {
    await acceptThreadSendRequest(deps, {
      payload: toSendPayload(parsed.data.request),
      thread,
    });
    return "delivered";
  }
  await queueParentSystemMessage(deps, {
    parentThreadId: row.threadId,
    input: parsed.data.input,
    systemMessageKind: parsed.data.systemMessageKind,
    systemMessageSubject: parsed.data.systemMessageSubject,
  });
  return "delivered";
}
