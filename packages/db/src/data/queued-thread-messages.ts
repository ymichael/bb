import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX } from "@bb/domain";
import type {
  PermissionMode,
  PromptInput,
  QueuedMessagePayload,
  QueuedMessageSystemNotice,
  QueuedMessageWaitHolder,
  QueuedMessageWaitingOn,
  QueuedMessageWaitingOnKind,
} from "@bb/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import type { DbNotifier } from "../notifier.js";
import {
  environments,
  events,
  queuedThreadMessages,
  threads,
} from "../schema.js";
import {
  createQueuedThreadMessageClaimToken,
  createQueuedThreadMessageId,
} from "../ids.js";
import { createOrderKeyAfter, createOrderKeyBetween } from "./order-keys.js";
import { queryInSqliteVariableBatches } from "./events.js";

export interface CreateQueuedThreadMessageInput {
  threadId: string;
  content: PromptInput[];
  senderThreadId?: string | null;
  model: string;
  reasoningLevel: string;
  permissionMode: PermissionMode;
  serviceTier: string;
  /**
   * Why the row is queued, written in the SAME insert rather than by a
   * follow-up update: a row that existed with no wait for even one statement
   * could be claimed by a concurrent drain, which is exactly the dispatch the
   * wait exists to prevent.
   */
  waitingOn: QueuedMessageWaitingOn | null;
  sendAt: number | null;
  payload: QueuedMessagePayload;
  /** Non-null only for one of core's own system notices. */
  systemNotice: QueuedMessageSystemNotice | null;
}

export interface UpdateQueuedThreadMessageInput {
  content: PromptInput[];
  expectedUpdatedAt: number;
  id: string;
  threadId: string;
}

export type QueuedThreadMessageRow = typeof queuedThreadMessages.$inferSelect;

export interface ClaimedQueuedThreadMessageRow extends QueuedThreadMessageRow {
  claimedAt: number;
  claimToken: string;
}

export interface QueuedMessageThreadRow {
  oldestQueuedMessageCreatedAt: number | null;
  threadId: string;
}

export interface ReorderQueuedThreadMessageArgs {
  db: DbConnection;
  groupBoundaryQueuedMessageId?: string;
  nextQueuedMessageId: string | null;
  notifier: DbNotifier;
  previousQueuedMessageId: string | null;
  queuedMessageId: string;
  threadId: string;
}

export interface SetQueuedThreadMessageGroupBoundaryArgs {
  db: DbConnection;
  expectedGroupedPrefixQueuedMessageIds: readonly string[];
  groupBoundaryQueuedMessageId: string;
  notifier: DbNotifier;
  threadId: string;
}

interface ResolveQueuedThreadMessageNeighborArgs {
  movedQueuedMessageId: string;
  neighborQueuedMessageId: string | null;
  threadId: string;
}

export interface ClaimedQueuedThreadMessageMutationArgs {
  claimToken: string;
  id: string;
}

export interface DeleteClaimedQueuedThreadMessageBatchInTransactionArgs {
  queuedMessages: readonly ClaimedQueuedThreadMessageMutationArgs[];
}

export interface ReleaseStaleQueuedMessageClaimsArgs {
  claimedBefore: number;
  protectedClaimTokens: readonly string[];
}

export interface ReorderQueuedThreadMessageSuccess {
  kind: "reordered";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface ReorderQueuedThreadMessageUnchanged {
  kind: "unchanged";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface ReorderQueuedThreadMessageNotFound {
  kind: "not_found";
}

export interface ReorderQueuedThreadMessageClaimed {
  kind: "claimed";
}

export interface ReorderQueuedThreadMessageStaleNeighbor {
  kind: "stale_neighbor";
}

export interface ReorderQueuedThreadMessageInvalidNeighborOrder {
  kind: "invalid_neighbor_order";
}

export interface QueuedThreadMessageGroupBoundarySuccess {
  kind: "updated";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface QueuedThreadMessageGroupBoundaryUnchanged {
  kind: "unchanged";
  queuedMessages: QueuedThreadMessageRow[];
}

export interface QueuedThreadMessageGroupBoundaryNotFound {
  kind: "not_found";
}

export interface QueuedThreadMessageGroupBoundaryInvalidSender {
  kind: "invalid_sender";
}

export interface QueuedThreadMessageGroupBoundaryInvalidExecutionOptions {
  kind: "invalid_execution_options";
}

export interface QueuedThreadMessageGroupBoundaryStaleOrder {
  kind: "stale_neighbor";
}

export type ReorderQueuedThreadMessageResult =
  | ReorderQueuedThreadMessageSuccess
  | ReorderQueuedThreadMessageUnchanged
  | ReorderQueuedThreadMessageNotFound
  | ReorderQueuedThreadMessageClaimed
  | ReorderQueuedThreadMessageStaleNeighbor
  | ReorderQueuedThreadMessageInvalidNeighborOrder
  | QueuedThreadMessageGroupBoundaryInvalidSender
  | QueuedThreadMessageGroupBoundaryInvalidExecutionOptions;

export type SetQueuedThreadMessageGroupBoundaryResult =
  | QueuedThreadMessageGroupBoundarySuccess
  | QueuedThreadMessageGroupBoundaryUnchanged
  | QueuedThreadMessageGroupBoundaryNotFound
  | QueuedThreadMessageGroupBoundaryInvalidSender
  | QueuedThreadMessageGroupBoundaryInvalidExecutionOptions
  | QueuedThreadMessageGroupBoundaryStaleOrder
  | ReorderQueuedThreadMessageClaimed;

export type UpdateQueuedThreadMessageResult =
  | { kind: "updated"; queuedMessage: QueuedThreadMessageRow }
  | { kind: "not_found" }
  | { kind: "claimed" }
  | { kind: "stale" };

export type ReleaseQueuedMessageClaimArgs =
  ClaimedQueuedThreadMessageMutationArgs;

class ReorderQueuedThreadMessageRollback extends Error {
  constructor(readonly result: ReorderQueuedThreadMessageResult) {
    super("Queued message reorder rolled back");
  }
}

function collectLeadGroupIds(
  queuedMessages: readonly QueuedThreadMessageRow[],
): string[] {
  const ids: string[] = [];
  const firstQueuedMessage = queuedMessages[0] ?? null;
  for (const [index, queuedMessage] of queuedMessages.entries()) {
    ids.push(queuedMessage.id);
    if (!queuedMessage.groupWithNext) break;
    const nextQueuedMessage = queuedMessages[index + 1];
    if (
      !nextQueuedMessage ||
      !queuedMessageGroupingEnvelopeMatches(
        firstQueuedMessage,
        nextQueuedMessage,
      )
    ) {
      break;
    }
  }
  return ids;
}

/**
 * A thread's live queue split into its groups: each maximal `groupWithNext`
 * chain with a matching envelope, in queue order.
 *
 * Grouping is computed over ALL live rows, never over an eligibility-filtered
 * subset. A filtered list has holes, and walking `groupWithNext` across a hole
 * either splits a group (dispatching a tail without the head that a re-queue
 * left waiting) or staples an unrelated later row onto it. Membership is one
 * question, eligibility another; callers apply eligibility to whole groups.
 */
function partitionQueuedMessageGroups(
  queuedMessages: readonly QueuedThreadMessageRow[],
): QueuedThreadMessageRow[][] {
  const groups: QueuedThreadMessageRow[][] = [];
  let index = 0;
  while (index < queuedMessages.length) {
    const size = collectLeadGroupIds(queuedMessages.slice(index)).length;
    groups.push(queuedMessages.slice(index, index + size));
    index += size;
  }
  return groups;
}

const IDLE_DRAINABLE_WAIT_KINDS = ["thread-busy", "turn-starting"] as const;

function hasOrdinaryTurnEndWait(row: QueuedThreadMessageRow): boolean {
  if (row.waitingOn === null) return true;
  try {
    const parsed = JSON.parse(row.waitingOn) as { kind?: unknown };
    return (
      parsed.kind === "thread-busy" || parsed.kind === "turn-starting"
    );
  } catch {
    return false;
  }
}

export function isOrdinaryTurnEndQueuedMessage(
  row: QueuedThreadMessageRow,
): boolean {
  return row.systemNotice === null && hasOrdinaryTurnEndWait(row);
}

/**
 * The JS mirror of {@link drainableQueuedThreadMessage}'s wait condition, for
 * deciding whole-group eligibility over rows already in hand. Kept next to a
 * pointer at the SQL so the two cannot drift silently.
 */
function isIdleDrainableQueuedMessage(row: QueuedThreadMessageRow): boolean {
  if (row.failureReason !== null) return false;
  if (row.waitingOn === null) return true;
  try {
    const parsed = JSON.parse(row.waitingOn) as { kind?: unknown };
    return IDLE_DRAINABLE_WAIT_KINDS.some(
      (waitKind) => waitKind === parsed.kind,
    );
  } catch {
    return false;
  }
}

function stringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function queuedMessageGroupingEnvelopeMatches(
  firstQueuedMessage: QueuedThreadMessageRow | null,
  queuedMessage: QueuedThreadMessageRow,
): boolean {
  return (
    firstQueuedMessage !== null &&
    queuedMessage.senderThreadId === firstQueuedMessage.senderThreadId &&
    queuedMessage.model === firstQueuedMessage.model &&
    queuedMessage.reasoningLevel === firstQueuedMessage.reasoningLevel &&
    queuedMessage.permissionMode === firstQueuedMessage.permissionMode &&
    queuedMessage.serviceTier === firstQueuedMessage.serviceTier
  );
}

function isQueuedThreadMessageClaimed(row: QueuedThreadMessageRow): boolean {
  return row.claimedAt !== null || row.claimToken !== null;
}

function requireClaimedQueuedThreadMessage(
  row: QueuedThreadMessageRow | null,
): ClaimedQueuedThreadMessageRow | null {
  if (!row || row.claimedAt === null || row.claimToken === null) {
    return null;
  }
  return {
    ...row,
    claimedAt: row.claimedAt,
    claimToken: row.claimToken,
  };
}

export function listQueuedThreadMessages(
  db: DbQueryConnection,
  threadId: string,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, threadId),
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}

function getLastQueuedThreadMessage(
  db: DbQueryConnection,
  threadId: string,
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .orderBy(
        desc(queuedThreadMessages.sortKey),
        desc(queuedThreadMessages.id),
      )
      .limit(1)
      .get() ?? null
  );
}

function getPreviousUnclaimedQueuedThreadMessage(
  db: DbQueryConnection,
  queuedMessage: QueuedThreadMessageRow,
): QueuedThreadMessageRow | null {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, queuedMessage.threadId),
          isNull(queuedThreadMessages.claimedAt),
          isNull(queuedThreadMessages.claimToken),
          or(
            lt(queuedThreadMessages.sortKey, queuedMessage.sortKey),
            and(
              eq(queuedThreadMessages.sortKey, queuedMessage.sortKey),
              lt(queuedThreadMessages.id, queuedMessage.id),
            ),
          ),
        ),
      )
      .orderBy(
        desc(queuedThreadMessages.sortKey),
        desc(queuedThreadMessages.id),
      )
      .limit(1)
      .get() ?? null
  );
}

function clearPreviousQueuedMessageGroupEdgeInTransaction(
  db: DbTransaction,
  queuedMessage: QueuedThreadMessageRow,
  now = Date.now(),
): void {
  const previousQueuedMessage = getPreviousUnclaimedQueuedThreadMessage(
    db,
    queuedMessage,
  );
  if (!previousQueuedMessage?.groupWithNext) return;
  db.update(queuedThreadMessages)
    .set({ groupWithNext: false, updatedAt: now })
    .where(eq(queuedThreadMessages.id, previousQueuedMessage.id))
    .run();
}

function clearQueuedMessageGroupEdgeInTransaction(
  db: DbTransaction,
  queuedMessage: QueuedThreadMessageRow,
  now = Date.now(),
): void {
  if (!queuedMessage.groupWithNext) return;
  db.update(queuedThreadMessages)
    .set({ groupWithNext: false, updatedAt: now })
    .where(eq(queuedThreadMessages.id, queuedMessage.id))
    .run();
}

function resolveQueuedThreadMessageNeighbor(
  db: DbQueryConnection,
  args: ResolveQueuedThreadMessageNeighborArgs,
): QueuedThreadMessageRow | null | false {
  if (args.neighborQueuedMessageId === null) {
    return null;
  }
  if (args.neighborQueuedMessageId === args.movedQueuedMessageId) {
    return false;
  }

  const neighbor = getQueuedThreadMessage(
    db,
    args.neighborQueuedMessageId,
  );
  if (
    !neighbor ||
    neighbor.threadId !== args.threadId ||
    isQueuedThreadMessageClaimed(neighbor)
  ) {
    return false;
  }
  return neighbor;
}

function applyQueuedThreadMessageGroupBoundary(
  db: DbTransaction,
  expectedGroupedPrefixQueuedMessageIds: readonly string[] | null,
  threadId: string,
  groupBoundaryQueuedMessageId: string,
): SetQueuedThreadMessageGroupBoundaryResult {
  const queuedMessages = listQueuedThreadMessages(db, threadId);
  const boundaryIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === groupBoundaryQueuedMessageId,
  );
  if (boundaryIndex === -1) {
    const claimedBoundary = getQueuedThreadMessage(
      db,
      groupBoundaryQueuedMessageId,
    );
    return claimedBoundary?.threadId === threadId &&
      isQueuedThreadMessageClaimed(claimedBoundary)
      ? { kind: "claimed" }
      : { kind: "not_found" };
  }
  if (expectedGroupedPrefixQueuedMessageIds !== null) {
    const currentGroupedPrefixIds = queuedMessages
      .slice(0, boundaryIndex + 1)
      .map((queuedMessage) => queuedMessage.id);
    if (
      !stringArraysEqual(
        currentGroupedPrefixIds,
        expectedGroupedPrefixQueuedMessageIds,
      )
    ) {
      return { kind: "stale_neighbor" };
    }
  }
  if (boundaryIndex > 0) {
    const firstQueuedMessage = queuedMessages[0] ?? null;
    const groupedMessages = queuedMessages.slice(0, boundaryIndex + 1);
    const hasMixedSender = groupedMessages.some(
      (queuedMessage) =>
        queuedMessage.senderThreadId !== firstQueuedMessage?.senderThreadId,
    );
    if (hasMixedSender) {
      return { kind: "invalid_sender" };
    }
    const hasMixedExecutionOptions = groupedMessages.some(
      (queuedMessage) =>
        !queuedMessageGroupingEnvelopeMatches(
          firstQueuedMessage,
          queuedMessage,
        ),
    );
    if (hasMixedExecutionOptions) {
      return { kind: "invalid_execution_options" };
    }
  }

  let changed = false;
  const now = Date.now();
  for (const [index, queuedMessage] of queuedMessages.entries()) {
    const groupWithNext = index < boundaryIndex;
    if (queuedMessage.groupWithNext === groupWithNext) continue;
    changed = true;
    db.update(queuedThreadMessages)
      .set({ groupWithNext, updatedAt: now })
      .where(eq(queuedThreadMessages.id, queuedMessage.id))
      .run();
  }

  if (!changed) {
    return { kind: "unchanged", queuedMessages };
  }
  return {
    kind: "updated",
    queuedMessages: listQueuedThreadMessages(db, threadId),
  };
}

function applyPreservedLeadGroupAfterReorder(
  db: DbTransaction,
  threadId: string,
  originalLeadGroupIds: readonly string[],
): QueuedThreadMessageRow[] {
  const queuedMessages = listQueuedThreadMessages(db, threadId);
  if (originalLeadGroupIds.length <= 1) {
    return queuedMessages;
  }

  const originalLeadGroupIdSet = new Set(originalLeadGroupIds);
  const preservesLeadGroup = queuedMessages
    .slice(0, originalLeadGroupIds.length)
    .every((queuedMessage) => originalLeadGroupIdSet.has(queuedMessage.id));
  let changed = false;
  const now = Date.now();
  for (const [index, queuedMessage] of queuedMessages.entries()) {
    const groupWithNext =
      preservesLeadGroup && index < originalLeadGroupIds.length - 1;
    if (queuedMessage.groupWithNext === groupWithNext) continue;
    changed = true;
    db.update(queuedThreadMessages)
      .set({ groupWithNext, updatedAt: now })
      .where(eq(queuedThreadMessages.id, queuedMessage.id))
      .run();
  }

  return changed ? listQueuedThreadMessages(db, threadId) : queuedMessages;
}

export function createQueuedThreadMessageInTransaction(
  tx: DbTransaction,
  input: CreateQueuedThreadMessageInput,
) {
  const now = Date.now();
  const id = createQueuedThreadMessageId();
  const lastQueuedMessage = getLastQueuedThreadMessage(tx, input.threadId);
  const sortKey = lastQueuedMessage
    ? createOrderKeyAfter({ previousKey: lastQueuedMessage.sortKey })
    : createOrderKeyBetween({ previousKey: null, nextKey: null });
  return tx
    .insert(queuedThreadMessages)
    .values({
      id,
      threadId: input.threadId,
      content: JSON.stringify(input.content),
      senderThreadId: input.senderThreadId ?? null,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      permissionMode: input.permissionMode,
      serviceTier: input.serviceTier,
      waitingOn:
        input.waitingOn === null ? null : JSON.stringify(input.waitingOn),
      waitHolder:
        input.waitingOn === null ? null : waitHolderFor(input.waitingOn),
      sendAt: input.sendAt,
      systemNotice:
        input.systemNotice === null ? null : JSON.stringify(input.systemNotice),
      payloadKind: input.payload.kind,
      retryOfTurnRequestId:
        input.payload.kind === "retry"
          ? input.payload.retryOfTurnRequestId
          : null,
      retryAttempt:
        input.payload.kind === "retry" ? input.payload.attempt : null,
      retryReason: input.payload.kind === "retry" ? input.payload.reason : null,
      groupWithNext: false,
      claimedAt: null,
      claimToken: null,
      sortKey,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function createQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  input: CreateQueuedThreadMessageInput,
) {
  const row = db.transaction(
    (tx) => createQueuedThreadMessageInTransaction(tx, input),
    { behavior: "immediate" },
  );
  notifier.notifyThread(input.threadId, ["queue-changed"]);
  return row;
}

export function updateQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  input: UpdateQueuedThreadMessageInput,
): UpdateQueuedThreadMessageResult {
  const result = db.transaction(
    (tx): UpdateQueuedThreadMessageResult => {
      const existing = getQueuedThreadMessage(tx, input.id);
      if (!existing || existing.threadId !== input.threadId) {
        return { kind: "not_found" };
      }
      if (isQueuedThreadMessageClaimed(existing)) {
        return { kind: "claimed" };
      }
      if (existing.updatedAt !== input.expectedUpdatedAt) {
        return { kind: "stale" };
      }

      const queuedMessage = tx
        .update(queuedThreadMessages)
        .set({
          content: JSON.stringify(input.content),
          updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
        })
        .where(eq(queuedThreadMessages.id, input.id))
        .returning()
        .get();
      if (!queuedMessage) {
        return { kind: "not_found" };
      }
      return { kind: "updated", queuedMessage };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "updated") {
    notifier.notifyThread(input.threadId, ["queue-changed"]);
  }
  return result;
}

export function getQueuedThreadMessage(db: DbQueryConnection, id: string) {
  return (
    db
      .select()
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.id, id))
      .get() ?? null
  );
}

export function hasQueuedThreadMessages(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(eq(queuedThreadMessages.threadId, threadId))
      .limit(1)
      .get() !== undefined
  );
}

function manuallyStoppedQueuePauseQuery(
  db: DbQueryConnection,
  threadId: string | typeof threads.id,
) {
  const interruption = alias(events, "queue_pause_interruption");
  const laterInterruption = alias(events, "queue_pause_later_interruption");
  const laterRootTurnStart = alias(events, "queue_pause_later_turn_start");
  const laterTurnRequest = alias(events, "queue_pause_later_turn_request");
  return db
    .select({ sequence: interruption.sequence })
    .from(interruption)
    .where(
      and(
        sql`${interruption.threadId} = ${threadId}`,
        eq(interruption.type, "system/thread/interrupted"),
        sql`json_extract(${interruption.data}, '$.reason') = 'manual-stop'`,
        notExists(
          db
            .select({ sequence: laterInterruption.sequence })
            .from(laterInterruption)
            .where(
              and(
                eq(laterInterruption.threadId, interruption.threadId),
                eq(laterInterruption.type, "system/thread/interrupted"),
                sql`${laterInterruption.sequence} > ${interruption.sequence}`,
              ),
            ),
        ),
        notExists(
          db
            .select({ sequence: laterRootTurnStart.sequence })
            .from(laterRootTurnStart)
            .where(
              and(
                eq(laterRootTurnStart.threadId, interruption.threadId),
                eq(laterRootTurnStart.type, "turn/started"),
                isNull(laterRootTurnStart.parentToolCallId),
                sql`${laterRootTurnStart.sequence} > ${interruption.sequence}`,
                exists(
                  db
                    .select({ sequence: laterTurnRequest.sequence })
                    .from(laterTurnRequest)
                    .where(
                      and(
                        eq(laterTurnRequest.threadId, interruption.threadId),
                        eq(laterTurnRequest.type, "client/turn/requested"),
                        sql`${laterTurnRequest.sequence} > ${interruption.sequence}`,
                        sql`${laterTurnRequest.sequence} < ${laterRootTurnStart.sequence}`,
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    )
    .limit(1);
}

export function isThreadQueueAutoSendPaused(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return manuallyStoppedQueuePauseQuery(db, threadId).get() !== undefined;
}

/**
 * Threads a drain could move right now.
 *
 * `pending` is included alongside `idle`, and the environment join is a LEFT
 * join because of it: a `pending` thread has never provisioned, so it has no
 * environment row to join to, and an inner join silently dropped exactly the
 * threads whose first message is waiting to start them.
 */
export function listIdleThreadsWithQueuedMessages(
  db: DbConnection,
): QueuedMessageThreadRow[] {
  return db
    .select({
      threadId: threads.id,
      oldestQueuedMessageCreatedAt: min(queuedThreadMessages.createdAt),
    })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .leftJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        inArray(threads.status, ["idle", "pending"]),
        isNull(threads.archivedAt),
        isNull(threads.deletedAt),
        or(
          notExists(manuallyStoppedQueuePauseQuery(db, threads.id)),
          isNotNull(queuedThreadMessages.systemNotice),
        ),
        // A gone environment (destroying/destroyed) is never reprovisioned, so
        // its queued rows can never drain. Leave them out of the sweep instead
        // of failing the same send every cycle (#1789). A thread with NO
        // environment is not that case — it has simply not provisioned yet.
        or(
          isNull(threads.environmentId),
          notInArray(environments.status, ["destroying", "destroyed"]),
        ),
        // Only rows an idle thread actually unblocks. A thread whose only
        // queued row is waiting on a clock or a plugin is not a drain
        // candidate, and listing it would re-run the whole send pipeline
        // every sweep tick for a row that cannot move.
        drainableQueuedThreadMessage(),
      ),
    )
    .groupBy(threads.id)
    .orderBy(asc(min(queuedThreadMessages.createdAt)), asc(threads.id))
    .all();
}

export function claimQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
): ClaimedQueuedThreadMessageRow | null {
  const claimedQueuedMessage = db.transaction(
    (tx) => {
      const existing = tx
        .select()
        .from(queuedThreadMessages)
        .where(eq(queuedThreadMessages.id, id))
        .get();
      if (
        !existing ||
        existing.claimedAt !== null ||
        existing.claimToken !== null
      ) {
        return null;
      }

      const now = Date.now();
      clearPreviousQueuedMessageGroupEdgeInTransaction(tx, existing, now);
      const claimToken = createQueuedThreadMessageClaimToken();
      const updated = tx
        .update(queuedThreadMessages)
        .set({ claimedAt: now, claimToken, updatedAt: now })
        .where(
          and(
            eq(queuedThreadMessages.id, id),
            isNull(queuedThreadMessages.claimedAt),
            isNull(queuedThreadMessages.claimToken),
          ),
        )
        .returning()
        .get();

      return requireClaimedQueuedThreadMessage(updated ?? null);
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessage) {
    notifier.notifyThread(claimedQueuedMessage.threadId, ["queue-changed"]);
  }
  return claimedQueuedMessage;
}

function claimQueuedThreadMessageIdsInTransaction(
  tx: DbTransaction,
  ids: readonly string[],
): ClaimedQueuedThreadMessageRow[] | null {
  if (ids.length === 0) return null;

  const now = Date.now();
  const claimToken = createQueuedThreadMessageClaimToken();
  const updated = tx
    .update(queuedThreadMessages)
    .set({ claimedAt: now, claimToken, updatedAt: now })
    .where(
      and(
        inArray(queuedThreadMessages.id, [...ids]),
        isNull(queuedThreadMessages.claimedAt),
        isNull(queuedThreadMessages.claimToken),
      ),
    )
    .returning()
    .all();

  if (updated.length !== ids.length) {
    return null;
  }

  const byId = new Map(
    updated.map((row) => [row.id, requireClaimedQueuedThreadMessage(row)]),
  );
  const claimedRows: ClaimedQueuedThreadMessageRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return null;
    claimedRows.push(row);
  }
  return claimedRows;
}

export type QueuedThreadMessageGroupEligibility = (
  rows: readonly QueuedThreadMessageRow[],
) => boolean;

export type QueuedThreadMessageGroupClaimPolicy =
  | {
      kind: "automatic";
      isGroupEligible: QueuedThreadMessageGroupEligibility;
    }
  | { kind: "explicit-send" };

function isAutomaticQueuedThreadMessageGroupClaimAllowed(
  rows: readonly QueuedThreadMessageRow[],
  pauseOrdinaryMessages: boolean,
): boolean {
  return (
    rows.every((row) => row.failureReason === null) &&
    (!pauseOrdinaryMessages ||
      rows.every((row) => !isOrdinaryTurnEndQueuedMessage(row)))
  );
}

export function claimQueuedThreadMessageGroup(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
  policy: QueuedThreadMessageGroupClaimPolicy,
): ClaimedQueuedThreadMessageRow[] | null {
  const claimedQueuedMessages = db.transaction(
    (tx) => {
      const existing = getQueuedThreadMessage(tx, id);
      if (!existing || isQueuedThreadMessageClaimed(existing)) {
        return null;
      }

      const queuedMessages = listQueuedThreadMessages(tx, existing.threadId);
      const group =
        partitionQueuedMessageGroups(queuedMessages).find((rows) =>
          rows.some((row) => row.id === id),
        ) ?? null;
      if (group === null) {
        return null;
      }
      if (
        (policy.kind === "automatic" &&
          !isAutomaticQueuedThreadMessageGroupClaimAllowed(
            group,
            isThreadQueueAutoSendPaused(tx, existing.threadId),
          )) ||
        (policy.kind === "automatic" && !policy.isGroupEligible(group))
      ) {
        return null;
      }
      if (policy.kind === "explicit-send" && group[0]?.id !== id) {
        const now = Date.now();
        clearPreviousQueuedMessageGroupEdgeInTransaction(tx, existing, now);
        clearQueuedMessageGroupEdgeInTransaction(tx, existing, now);
        return claimQueuedThreadMessageIdsInTransaction(tx, [existing.id]);
      }
      return claimQueuedThreadMessageIdsInTransaction(
        tx,
        group.map((row) => row.id),
      );
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessages && claimedQueuedMessages.length > 0) {
    notifier.notifyThread(claimedQueuedMessages[0]!.threadId, [
      "queue-changed",
    ]);
  }
  return claimedQueuedMessages;
}

export function claimNextQueuedThreadMessageGroup(
  db: DbConnection,
  notifier: DbNotifier,
  threadId: string,
  isGroupEligible?: QueuedThreadMessageGroupEligibility,
): ClaimedQueuedThreadMessageRow[] | null {
  const claimedQueuedMessages = db.transaction(
    (tx) => {
      // The idle drain takes the first group whose EVERY member it may act
      // on. A group with one waiting member is skipped whole — dispatching
      // its drainable tail alone would split a batch the sender composed as
      // one prompt — and skipping it does not block the independent rows
      // behind it: the queue is a queue, not a pipeline.
      const queuedMessages = listQueuedThreadMessages(tx, threadId);
      const pauseOrdinaryMessages = isThreadQueueAutoSendPaused(tx, threadId);
      const group =
        partitionQueuedMessageGroups(queuedMessages).find((rows) => {
          const eligible = isGroupEligible
            ? rows.some(isIdleDrainableQueuedMessage) && isGroupEligible(rows)
            : rows.every(isIdleDrainableQueuedMessage);
          return (
            eligible &&
            isAutomaticQueuedThreadMessageGroupClaimAllowed(
              rows,
              pauseOrdinaryMessages,
            )
          );
        }) ?? null;
      if (group === null) {
        return null;
      }
      return claimQueuedThreadMessageIdsInTransaction(
        tx,
        group.map((row) => row.id),
      );
    },
    { behavior: "immediate" },
  );

  if (claimedQueuedMessages && claimedQueuedMessages.length > 0) {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }
  return claimedQueuedMessages;
}

export function reorderQueuedThreadMessage({
  db,
  groupBoundaryQueuedMessageId,
  nextQueuedMessageId,
  notifier,
  previousQueuedMessageId,
  queuedMessageId,
  threadId,
}: ReorderQueuedThreadMessageArgs): ReorderQueuedThreadMessageResult {
  let result: ReorderQueuedThreadMessageResult;
  try {
    result = db.transaction(
      (tx): ReorderQueuedThreadMessageResult => {
        const movedQueuedMessage = getQueuedThreadMessage(
          tx,
          queuedMessageId,
        );
        if (!movedQueuedMessage || movedQueuedMessage.threadId !== threadId) {
          return { kind: "not_found" };
        }
        if (isQueuedThreadMessageClaimed(movedQueuedMessage)) {
          return { kind: "claimed" };
        }

        const previousQueuedMessage = resolveQueuedThreadMessageNeighbor(tx, {
          movedQueuedMessageId: queuedMessageId,
          neighborQueuedMessageId: previousQueuedMessageId,
          threadId,
        });
        const nextQueuedMessage = resolveQueuedThreadMessageNeighbor(tx, {
          movedQueuedMessageId: queuedMessageId,
          neighborQueuedMessageId: nextQueuedMessageId,
          threadId,
        });
        if (previousQueuedMessage === false || nextQueuedMessage === false) {
          return { kind: "stale_neighbor" };
        }
        if (
          previousQueuedMessage !== null &&
          nextQueuedMessage !== null &&
          previousQueuedMessage.sortKey >= nextQueuedMessage.sortKey
        ) {
          return { kind: "invalid_neighbor_order" };
        }

        const currentQueuedMessages = listQueuedThreadMessages(tx, threadId);
        const originalLeadGroupIds = collectLeadGroupIds(currentQueuedMessages);
        const currentIndex = currentQueuedMessages.findIndex(
          (queuedMessage) => queuedMessage.id === queuedMessageId,
        );
        const currentPreviousQueuedMessageId =
          currentQueuedMessages[currentIndex - 1]?.id ?? null;
        const currentNextQueuedMessageId =
          currentQueuedMessages[currentIndex + 1]?.id ?? null;
        if (
          currentPreviousQueuedMessageId === previousQueuedMessageId &&
          currentNextQueuedMessageId === nextQueuedMessageId
        ) {
          if (groupBoundaryQueuedMessageId !== undefined) {
            const groupResult = applyQueuedThreadMessageGroupBoundary(
              tx,
              null,
              threadId,
              groupBoundaryQueuedMessageId,
            );
            if (groupResult.kind === "not_found") {
              return { kind: "stale_neighbor" };
            }
            if (groupResult.kind === "claimed") {
              return { kind: "claimed" };
            }
            if (groupResult.kind === "stale_neighbor") {
              return { kind: "stale_neighbor" };
            }
            if (groupResult.kind === "invalid_sender") {
              return { kind: "invalid_sender" };
            }
            if (groupResult.kind === "invalid_execution_options") {
              return { kind: "invalid_execution_options" };
            }
            if (groupResult.kind === "updated") {
              return {
                kind: "reordered",
                queuedMessages: groupResult.queuedMessages,
              };
            }
          }
          return {
            kind: "unchanged",
            queuedMessages: currentQueuedMessages,
          };
        }

        const sortKey = createOrderKeyBetween({
          previousKey: previousQueuedMessage?.sortKey ?? null,
          nextKey: nextQueuedMessage?.sortKey ?? null,
        });
        const updated = tx
          .update(queuedThreadMessages)
          .set({ sortKey, updatedAt: Date.now() })
          .where(
            and(
              eq(queuedThreadMessages.id, queuedMessageId),
              isNull(queuedThreadMessages.claimedAt),
              isNull(queuedThreadMessages.claimToken),
            ),
          )
          .returning({ id: queuedThreadMessages.id })
          .get();
        if (!updated) {
          return { kind: "stale_neighbor" };
        }

        if (groupBoundaryQueuedMessageId !== undefined) {
          const groupResult = applyQueuedThreadMessageGroupBoundary(
            tx,
            null,
            threadId,
            groupBoundaryQueuedMessageId,
          );
          if (groupResult.kind === "not_found") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "stale_neighbor",
            });
          }
          if (groupResult.kind === "claimed") {
            throw new ReorderQueuedThreadMessageRollback({ kind: "claimed" });
          }
          if (groupResult.kind === "stale_neighbor") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "stale_neighbor",
            });
          }
          if (groupResult.kind === "invalid_sender") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "invalid_sender",
            });
          }
          if (groupResult.kind === "invalid_execution_options") {
            throw new ReorderQueuedThreadMessageRollback({
              kind: "invalid_execution_options",
            });
          }
          if (groupResult.kind === "updated") {
            return {
              kind: "reordered",
              queuedMessages: groupResult.queuedMessages,
            };
          }
        } else {
          return {
            kind: "reordered",
            queuedMessages: applyPreservedLeadGroupAfterReorder(
              tx,
              threadId,
              originalLeadGroupIds,
            ),
          };
        }

        return {
          kind: "reordered",
          queuedMessages: listQueuedThreadMessages(tx, threadId),
        };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof ReorderQueuedThreadMessageRollback) {
      result = error.result;
    } else {
      throw error;
    }
  }

  if (result.kind === "reordered") {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }
  return result;
}

export function setQueuedThreadMessageGroupBoundary({
  db,
  expectedGroupedPrefixQueuedMessageIds,
  groupBoundaryQueuedMessageId,
  notifier,
  threadId,
}: SetQueuedThreadMessageGroupBoundaryArgs): SetQueuedThreadMessageGroupBoundaryResult {
  const result = db.transaction(
    (tx) =>
      applyQueuedThreadMessageGroupBoundary(
        tx,
        expectedGroupedPrefixQueuedMessageIds,
        threadId,
        groupBoundaryQueuedMessageId,
      ),
    { behavior: "immediate" },
  );

  if (result.kind === "updated") {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }
  return result;
}

export interface RequeueClaimedQueuedThreadMessagesArgs {
  /** Every row the drain claimed, lead first. */
  claims: readonly ClaimedQueuedThreadMessageMutationArgs[];
  threadId: string;
  waitingOn: QueuedMessageWaitingOn;
  sendAt: number | null;
}

export function requeueClaimedQueuedThreadMessages(
  db: DbQueryConnection,
  notifier: DbNotifier,
  args: RequeueClaimedQueuedThreadMessagesArgs,
): QueuedThreadMessageRow | null {
  const lead = args.claims[0];
  if (lead === undefined) return null;
  const queued = db.transaction(
    (tx) => {
      const now = Date.now();
      for (const claim of args.claims) {
        tx.update(queuedThreadMessages)
          .set({
            claimedAt: null,
            claimToken: null,
            waitingOn: JSON.stringify(args.waitingOn),
            waitHolder: waitHolderFor(args.waitingOn),
            sendAt: args.sendAt,
            failureReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(queuedThreadMessages.id, claim.id),
              eq(queuedThreadMessages.claimToken, claim.claimToken),
            ),
          )
          .run();
      }
      return (
        tx
          .update(queuedThreadMessages)
          .set({
            waitingOn: JSON.stringify(args.waitingOn),
            waitHolder: waitHolderFor(args.waitingOn),
            sendAt: args.sendAt,
            // A re-queue is a fresh, successful statement of why this row is
            // waiting, which supersedes whatever the previous attempt failed
            // with. Leaving a stale failure next to a current wait would show
            // the user two contradictory explanations of the same row.
            failureReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(queuedThreadMessages.id, lead.id),
              eq(queuedThreadMessages.threadId, args.threadId),
              liveQueuedThreadMessage(),
            ),
          )
          .returning()
          .get() ?? null
      );
    },
    { behavior: "immediate" },
  );
  if (queued) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return queued;
}

export function releaseQueuedMessageClaim(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseQueuedMessageClaimArgs,
): boolean {
  const existing = db
    .select()
    .from(queuedThreadMessages)
    .where(eq(queuedThreadMessages.id, args.id))
    .get();
  if (
    !existing ||
    existing.claimedAt === null ||
    existing.claimToken !== args.claimToken
  ) {
    return false;
  }

  const now = Date.now();
  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(
      and(
        eq(queuedThreadMessages.id, args.id),
        isNotNull(queuedThreadMessages.claimedAt),
        eq(queuedThreadMessages.claimToken, args.claimToken),
      ),
    )
    .run();
  if (result.changes === 0) {
    return false;
  }

  notifier.notifyThread(existing.threadId, ["queue-changed"]);
  return true;
}

export function releaseStaleQueuedMessageClaims(
  db: DbConnection,
  notifier: DbNotifier,
  args: ReleaseStaleQueuedMessageClaimsArgs,
): number {
  const protectedClaimTokens = [...args.protectedClaimTokens];
  const staleClaimWhere = and(
    isNotNull(queuedThreadMessages.claimedAt),
    lt(queuedThreadMessages.claimedAt, args.claimedBefore),
    ...(protectedClaimTokens.length > 0
      ? [
          or(
            isNull(queuedThreadMessages.claimToken),
            notInArray(queuedThreadMessages.claimToken, protectedClaimTokens),
          )!,
        ]
      : []),
  );
  const staleRows = db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
    })
    .from(queuedThreadMessages)
    .where(staleClaimWhere)
    .all();
  if (staleRows.length === 0) {
    return 0;
  }

  const now = Date.now();
  const result = db
    .update(queuedThreadMessages)
    .set({ claimedAt: null, claimToken: null, updatedAt: now })
    .where(staleClaimWhere)
    .run();

  for (const threadId of new Set(staleRows.map((row) => row.threadId))) {
    notifier.notifyThread(threadId, ["queue-changed"]);
  }

  return result.changes;
}

export function deleteClaimedQueuedThreadMessageBatchInTransaction(
  db: DbTransaction,
  args: DeleteClaimedQueuedThreadMessageBatchInTransactionArgs,
): boolean {
  if (args.queuedMessages.length === 0) return false;
  const claimToken = args.queuedMessages[0]!.claimToken;
  if (
    args.queuedMessages.some(
      (queuedMessage) => queuedMessage.claimToken !== claimToken,
    )
  ) {
    return false;
  }

  const ids = args.queuedMessages.map((queuedMessage) => queuedMessage.id);
  const existingRows = db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        inArray(queuedThreadMessages.id, ids),
        eq(queuedThreadMessages.claimToken, claimToken),
      ),
    )
    .all();
  if (existingRows.length !== ids.length) {
    return false;
  }

  const deletedRows = db
    .delete(queuedThreadMessages)
    .where(
      and(
        inArray(queuedThreadMessages.id, ids),
        eq(queuedThreadMessages.claimToken, claimToken),
      ),
    )
    .returning({ id: queuedThreadMessages.id })
    .all();
  if (deletedRows.length !== ids.length) {
    return false;
  }

  const removingIds = new Set(ids);
  const now = Date.now();
  for (const existing of existingRows) {
    const previousQueuedMessage = getPreviousUnclaimedQueuedThreadMessage(
      db,
      existing,
    );
    if (
      previousQueuedMessage &&
      !removingIds.has(previousQueuedMessage.id) &&
      previousQueuedMessage.groupWithNext
    ) {
      db.update(queuedThreadMessages)
        .set({ groupWithNext: false, updatedAt: now })
        .where(eq(queuedThreadMessages.id, previousQueuedMessage.id))
        .run();
    }
  }
  return true;
}

/**
 * A row is live while no drain worker holds it. Queueing, re-queueing and
 * clearing a wait are all lost updates against a row that is already being
 * dispatched, so every wait mutation is gated on liveness in the same
 * statement that performs it.
 */
function liveQueuedThreadMessage() {
  return and(
    isNull(queuedThreadMessages.claimedAt),
    isNull(queuedThreadMessages.claimToken),
  );
}

function automaticallyDrainableQueuedThreadMessage() {
  return and(
    liveQueuedThreadMessage(),
    isNull(queuedThreadMessages.failureReason),
  );
}

/**
 * Rows the IDLE drain may claim: a row with no wait at all, or one waiting
 * on the thread being busy or its turn starting — waits an idle thread
 * clears.
 *
 * Every other wait belongs to a different drain and must be invisible here, or
 * the idle sweep would dispatch a message scheduled for 9am the moment the
 * thread went quiet. That is also why an ineligible row does not BLOCK the
 * ones behind it: the queue is a queue, not a pipeline, so a row queued
 * on a plugin for an hour is overtaken by the follow-up the user sent after
 * it rather than stalling the whole thread. Plain queued rows are all
 * `thread-busy`, so among themselves they keep strict FIFO order, which is
 * what makes today's queue behaviour unchanged.
 */
function drainableQueuedThreadMessage() {
  return and(
    automaticallyDrainableQueuedThreadMessage(),
    or(
      isNull(queuedThreadMessages.waitingOn),
      inArray(
        sql<string>`json_extract(${queuedThreadMessages.waitingOn}, '$.kind')`,
        [...IDLE_DRAINABLE_WAIT_KINDS],
      ),
    ),
  );
}

export interface ListQueuedThreadMessagesForApiArgs {
  threadId?: string;
  waitHolder?: QueuedMessageWaitHolder;
}

/**
 * The cross-thread queued-row list behind `GET /queued-messages`. Both filters
 * are genuinely absent by default: unfiltered means every live row in the
 * workspace, which is what a whole-workspace pending view asks for.
 */
export function listQueuedThreadMessagesForApi(
  db: DbQueryConnection,
  args: ListQueuedThreadMessagesForApiArgs,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        liveQueuedThreadMessage(),
        ...(args.threadId === undefined
          ? []
          : [eq(queuedThreadMessages.threadId, args.threadId)]),
        ...(args.waitHolder === undefined
          ? []
          : [eq(queuedThreadMessages.waitHolder, args.waitHolder)]),
      ),
    )
    .orderBy(asc(queuedThreadMessages.createdAt), asc(queuedThreadMessages.id))
    .all();
}

export interface QueuedThreadMessageCounts {
  threadId: string;
  queuedMessageCount: number;
  /**
   * How many of those rows last failed to dispatch. Counted in the same pass
   * as the total because both answers come from the same rows, and the thread
   * list needs them together: a thread with queued work shows a clock, and one
   * whose queued work failed shows the failure instead.
   */
  failedQueuedMessageCount: number;
}

/**
 * How many live rows each of these threads has queued, and how many of those
 * failed. One grouped query rather than one per thread: the thread list renders
 * a glyph per row and would otherwise issue a query per visible thread.
 *
 * Batched over the SQLite variable limit because the thread list is unbounded —
 * a workspace with tens of thousands of threads builds its sidebar from one
 * call.
 */
export function listQueuedThreadMessageCountsByThreadIds(
  db: DbQueryConnection,
  args: { threadIds: readonly string[] },
): QueuedThreadMessageCounts[] {
  return queryInSqliteVariableBatches({
    dedupeKey: (threadId) => threadId,
    fixedVariableCount: 0,
    variableCountPerValue: 1,
    values: args.threadIds,
    queryBatch: (threadIds) =>
      db
        .select({
          threadId: queuedThreadMessages.threadId,
          queuedMessageCount: count(queuedThreadMessages.id),
          failedQueuedMessageCount: count(queuedThreadMessages.failureReason),
        })
        .from(queuedThreadMessages)
        .where(
          and(
            inArray(queuedThreadMessages.threadId, [...threadIds]),
            liveQueuedThreadMessage(),
          ),
        )
        .groupBy(queuedThreadMessages.threadId)
        .all(),
  });
}

/**
 * The single place `wait_holder` is derived from `waiting_on`. Keeping it here
 * — rather than letting callers pass a holder — is what makes the
 * denormalization safe: the two columns are always written together, from the
 * same value.
 */
function waitHolderFor(
  waitingOn: QueuedMessageWaitingOn,
): QueuedMessageWaitHolder | null {
  return waitingOn.kind === "plugin"
    ? `${QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX}${waitingOn.pluginId}`
    : null;
}

export interface SetQueuedThreadMessageWaitingOnArgs {
  id: string;
  threadId: string;
  waitingOn: QueuedMessageWaitingOn;
  /**
   * The row's scheduled instant. Passed on every call rather than left alone,
   * because a re-queue is a fresh statement of when this row may run: a
   * `time` wait sets it, and every other wait kind clears it by passing null.
   */
  sendAt: number | null;
}

export interface ClearQueuedThreadMessageWaitingOnArgs {
  id: string;
  threadId: string;
}

export interface ListQueuedThreadMessagesWaitingOnKindArgs {
  kind: QueuedMessageWaitingOnKind;
  threadId: string;
}

/**
 * Queue a live row on a typed wait. Returns the updated row, or null when the
 * row is gone, belongs to another thread, or has already been claimed.
 */
export function setQueuedThreadMessageWaitingOn(
  db: DbConnection,
  notifier: DbNotifier,
  args: SetQueuedThreadMessageWaitingOnArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        waitingOn: JSON.stringify(args.waitingOn),
        waitHolder: waitHolderFor(args.waitingOn),
        sendAt: args.sendAt,
        // Same rule as `requeueClaimedQueuedThreadMessages`: any fresh,
        // successful statement of why this row is waiting supersedes whatever
        // a previous attempt failed with. Leaving a stale failure beside a
        // current wait would show the reader two contradictory explanations of
        // one row.
        failureReason: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return updated;
}

export interface SetQueuedThreadMessageFailureReasonArgs {
  id: string;
  threadId: string;
  failureReason: string;
}

/**
 * Records why a drain attempt on this row failed outright.
 *
 * Only the drain writes this: an inline attempt has a caller still listening
 * and reports to them instead. The row's wait is deliberately untouched — it
 * is still waiting on whatever it was waiting on, and the failure is a separate
 * fact about the last attempt rather than a new reason to wait. A later
 * successful re-queue clears it (see `requeueClaimedQueuedThreadMessages`).
 */
export function setQueuedThreadMessageFailureReason(
  db: DbConnection,
  notifier: DbNotifier,
  args: SetQueuedThreadMessageFailureReasonArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        failureReason: args.failureReason,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return updated;
}

/**
 * Drop a live row's wait, leaving it an ordinary queued row eligible at the
 * next drain. `sendAt` is cleared with it: a row with no wait is not waiting
 * for a clock either.
 */
export function clearQueuedThreadMessageWaitingOn(
  db: DbConnection,
  notifier: DbNotifier,
  args: ClearQueuedThreadMessageWaitingOnArgs,
): QueuedThreadMessageRow | null {
  const updated =
    db
      .update(queuedThreadMessages)
      .set({
        waitingOn: null,
        waitHolder: null,
        sendAt: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(queuedThreadMessages.id, args.id),
          eq(queuedThreadMessages.threadId, args.threadId),
          liveQueuedThreadMessage(),
        ),
      )
      .returning()
      .get() ?? null;

  if (updated) {
    notifier.notifyThread(args.threadId, ["queue-changed"]);
  }
  return updated;
}

/**
 * Rows whose scheduled instant has arrived and that a drain may act on now,
 * oldest-due first. Threads that are archived or deleted are excluded here
 * rather than by the caller, so a scheduled send into a thread the user threw
 * away never wakes the sweep every cycle (the #1789 shape).
 *
 * The thread check is a correlated EXISTS rather than a join on purpose. A
 * join lets SQLite drive from `threads` — scanning every live thread to find
 * the few with a due row — which throws away the partial due index entirely.
 * EXISTS forces the queue table to be the outer loop, so the sweep costs one
 * index range scan plus a primary-key probe per hit.
 */
export function listDueScheduledQueuedThreadMessages(
  db: DbQueryConnection,
  now: number,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.sendAt),
        lte(queuedThreadMessages.sendAt, now),
        automaticallyDrainableQueuedThreadMessage(),
        exists(
          db
            .select({ live: sql`1` })
            .from(threads)
            .where(
              and(
                eq(threads.id, queuedThreadMessages.threadId),
                isNull(threads.archivedAt),
                isNull(threads.deletedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sendAt), asc(queuedThreadMessages.id))
    .all();
}

/**
 * Every live row a given wait owner holds, in queue order. Asked when one
 * plugin's waits must be cleared at once, on its disable or uninstall —
 * clearing by holder is what `wait_holder`'s indexed equality lookup exists
 * for.
 *
 * Ordered by `createdAt` for the same reason as
 * {@link listQueuedThreadMessagesWithPluginWait}: `id` is a random suffix, so
 * it sorts nothing, and one holder's rows span threads so `sortKey` alone
 * cannot order them either.
 */
export function listQueuedThreadMessagesByWaitHolder(
  db: DbQueryConnection,
  waitHolder: QueuedMessageWaitHolder,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.waitHolder, waitHolder),
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(
      asc(queuedThreadMessages.createdAt),
      asc(queuedThreadMessages.sortKey),
      asc(queuedThreadMessages.id),
    )
    .all();
}

/** The columns the plugin-wait walkers act on; see the query below. */
export interface QueuedThreadMessagePluginWaitRef {
  id: string;
  threadId: string;
  waitHolder: QueuedMessageWaitHolder;
}

/**
 * Every live row on SOME plugin's wait, across every thread, in queue order.
 *
 * The orphan sweep asks this once per tick and then filters by which plugins
 * are loaded, rather than asking per plugin: the set of holders is not known
 * up front (it is whichever plugins happen to be holding something), and the
 * partial wait index covers exactly these rows, so one range scan answers it.
 *
 * Deliberately a projection, not full rows: both walkers only clear waits or
 * re-attempt by id, so returning prompt bodies here would ship every held
 * message's content on a ten-second timer for nothing.
 *
 * Ordered by `createdAt` and NOT by `id`: row ids are random suffixes, so
 * sorting by them is sorting by nothing. It matters because the requested
 * drain re-offers these rows to the dispatch hook in this order, and a full
 * pool is supposed to drain in the order it filled. `sortKey` cannot do the
 * job either — its fractional keys are seeded per thread, so they order a
 * thread's own rows and are meaningless between threads; it breaks a
 * same-millisecond tie within one thread, and `id` makes the sort total.
 */
export function listQueuedThreadMessagePluginWaitRefs(
  db: DbQueryConnection,
): QueuedThreadMessagePluginWaitRef[] {
  return db
    .select({
      id: queuedThreadMessages.id,
      threadId: queuedThreadMessages.threadId,
      waitHolder: queuedThreadMessages.waitHolder,
    })
    .from(queuedThreadMessages)
    .where(
      and(
        isNotNull(queuedThreadMessages.waitHolder),
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(
      asc(queuedThreadMessages.createdAt),
      asc(queuedThreadMessages.sortKey),
      asc(queuedThreadMessages.id),
    )
    .all()
    .flatMap((row) =>
      row.waitHolder === null ? [] : [{ ...row, waitHolder: row.waitHolder }],
    );
}

/**
 * A thread's live rows on one kind of wait, in queue order. Read
 * straight out of the stored JSON so the kind has exactly one home; the
 * thread predicate is what makes this selective, so no index on the extracted
 * kind is warranted.
 */
export function listQueuedThreadMessagesWaitingOnKind(
  db: DbQueryConnection,
  args: ListQueuedThreadMessagesWaitingOnKindArgs,
): QueuedThreadMessageRow[] {
  return db
    .select()
    .from(queuedThreadMessages)
    .where(
      and(
        eq(queuedThreadMessages.threadId, args.threadId),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = ${args.kind}`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .orderBy(asc(queuedThreadMessages.sortKey), asc(queuedThreadMessages.id))
    .all();
}

/**
 * Whether a retry of this original turn request already exists on the queue.
 *
 * Claimed rows count on purpose: a retry a drain has claimed and is deciding
 * about is as live as a waiting one, and the window between its claim and its
 * dispatch is exactly when a second retry of the same turn would otherwise
 * slip past. Targeted on the retry column rather than loading the thread's
 * rows to inspect their payloads.
 */
export function hasQueuedRetryOfTurnRequest(
  db: DbQueryConnection,
  args: { threadId: string; retryOfTurnRequestId: string },
): boolean {
  return (
    db
      .select({ id: queuedThreadMessages.id })
      .from(queuedThreadMessages)
      .where(
        and(
          eq(queuedThreadMessages.threadId, args.threadId),
          eq(
            queuedThreadMessages.retryOfTurnRequestId,
            args.retryOfTurnRequestId,
          ),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

/**
 * Threads on one host with live rows parked on a `host-offline` wait.
 *
 * Joined through the thread's environment by host ID rather than matched on
 * the wait's stored `hostName`: the name on the wait is display text captured
 * at failure time, and a renamed host would orphan every row that matched on
 * it.
 */
export function listThreadIdsWithHostOfflineQueueWaits(
  db: DbQueryConnection,
  hostId: string,
): string[] {
  return db
    .selectDistinct({ threadId: queuedThreadMessages.threadId })
    .from(queuedThreadMessages)
    .innerJoin(threads, eq(threads.id, queuedThreadMessages.threadId))
    .innerJoin(environments, eq(environments.id, threads.environmentId))
    .where(
      and(
        eq(environments.hostId, hostId),
        sql`json_extract(${queuedThreadMessages.waitingOn}, '$.kind') = 'host-offline'`,
        automaticallyDrainableQueuedThreadMessage(),
      ),
    )
    .all()
    .map((row) => row.threadId);
}

export function deleteQueuedThreadMessage(
  db: DbConnection,
  notifier: DbNotifier,
  id: string,
) {
  const existing = db.transaction(
    (tx) => {
      const existing = getQueuedThreadMessage(tx, id);
      if (!existing) return null;
      clearPreviousQueuedMessageGroupEdgeInTransaction(tx, existing);
      tx.delete(queuedThreadMessages)
        .where(eq(queuedThreadMessages.id, id))
        .run();
      return existing;
    },
    { behavior: "immediate" },
  );
  if (!existing) return false;
  notifier.notifyThread(existing.threadId, ["queue-changed"]);
  return true;
}
