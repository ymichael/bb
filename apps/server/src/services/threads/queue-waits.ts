import {
  clearQueuedThreadMessageWaitingOn,
  createQueuedThreadMessageInTransaction,
  requeueClaimedQueuedThreadMessages,
  type ClaimedQueuedThreadMessageRow,
  type DbConnection,
  type DbNotifier,
  type DbQueryConnection,
  type QueuedThreadMessageRow,
} from "@bb/db";
import type {
  PromptInput,
  QueuedMessagePayload,
  QueuedMessageSystemNotice,
  QueuedMessageWaitingOn,
  ResolvedThreadExecutionOptions,
  Thread,
  ThreadQueuedMessage,
} from "@bb/domain";
import {
  emitPluginMessageDispatched,
  emitPluginMessageQueued,
} from "../plugins/plugin-thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";

type QueueWaitDeps = { db: DbQueryConnection; hub: DbNotifier };

/**
 * A settling row, for the plugin event its transition raises.
 *
 * A wait is narrated by the queue rows above the composer, which read the
 * row's own columns — so a settle has nothing to write down, only somebody to
 * tell.
 */
export interface SettleQueueRowArgs {
  row: QueuedThreadMessageRow;
}

/** The message a queued row will carry, as the queueing site supplies it. */
export interface QueuedDispatchMessage {
  input: PromptInput[];
  execution: ResolvedThreadExecutionOptions;
  senderThreadId: string | null;
  payload: QueuedMessagePayload;
  /** Non-null only when core is queueing one of its own system notices. */
  systemNotice: QueuedMessageSystemNotice | null;
}

export interface RecordQueuedMessageWaitArgs {
  thread: Thread;
  message: QueuedDispatchMessage;
  waitingOn: QueuedMessageWaitingOn;
  /**
   * The row's scheduled instant. Passed every time the wait is written rather
   * than left alone, because writing a wait is a fresh statement of when this
   * row may run: a `time` wait sets it, a plugin wait with a `sendAt` sets it,
   * and every other wait clears it by passing null.
   */
  sendAt: number | null;
  /**
   * Rows already claimed from the queue that this call is RETURNING rather
   * than creating. Present on every drain re-attempt; absent when an inline
   * send is queued for the first time.
   */
  claimed: readonly ClaimedQueuedThreadMessageRow[] | null;
}

/**
 * Records that a dispatch is waiting: the single place a queued row comes into
 * existence or has its wait rewritten.
 *
 * Creating and re-queueing are one function because they are one concept —
 * "this message is waiting, and here is why" — and because every caller reaches
 * it from the same place in {@link attemptDispatch}. The difference is only
 * whether a row already exists: a drain re-attempt hands back the rows it
 * claimed, an inline attempt has none yet.
 *
 * Returns the row the wait now sits on, or null when a re-queue lost its row
 * (deleted under the drain), which the caller treats as "nothing to do".
 */
export function recordQueuedMessageWait(
  deps: QueueWaitDeps,
  args: RecordQueuedMessageWaitArgs,
): ThreadQueuedMessage | null {
  const claimed = args.claimed ?? [];
  const leadClaim = claimed[0];
  let row: QueuedThreadMessageRow | null;

  if (leadClaim === undefined) {
    row = deps.db.transaction(
      (tx) =>
        createQueuedThreadMessageInTransaction(tx, {
          threadId: args.thread.id,
          content: args.message.input,
          senderThreadId: args.message.senderThreadId,
          model: args.message.execution.model,
          reasoningLevel: args.message.execution.reasoningLevel,
          permissionMode: args.message.execution.permissionMode,
          serviceTier: args.message.execution.serviceTier,
          waitingOn: args.waitingOn,
          sendAt: args.sendAt,
          payload: args.message.payload,
          systemNotice: args.message.systemNotice,
        }),
      { behavior: "immediate" },
    );
  } else {
    row = requeueClaimedQueuedThreadMessages(deps.db, deps.hub, {
      claims: claimed.map((claim) => ({
        id: claim.id,
        claimToken: claim.claimToken,
      })),
      threadId: args.thread.id,
      waitingOn: args.waitingOn,
      sendAt: args.sendAt,
    });
  }

  if (row === null) {
    // The claim no longer holds: the row was deleted under the drain, or a
    // stale-claim sweep reclaimed it. Either way there is no row left to queue.
    return null;
  }
  const entry = toThreadQueuedMessage(row);
  emitPluginMessageQueued(entry);
  deps.hub.notifyThread(args.thread.id, ["queue-changed"]);
  return entry;
}

/**
 * Records that a queued row's waits all cleared and it dispatched. Called
 * AFTER the row is consumed, so a plugin listening on `message.dispatched` sees
 * the row leave the queue rather than a row that is about to.
 */
export function settleQueueRowDispatched(args: SettleQueueRowArgs): void {
  emitPluginMessageDispatched(toThreadQueuedMessage(args.row));
}

/**
 * Drops a row's wait so the next drain re-attempts it. The row stays exactly
 * where it is in the queue; only its eligibility changes.
 */
export function clearQueuedMessageWait(
  deps: { db: DbConnection; hub: DbNotifier },
  args: { queuedMessageId: string; threadId: string },
): QueuedThreadMessageRow | null {
  return clearQueuedThreadMessageWaitingOn(deps.db, deps.hub, {
    id: args.queuedMessageId,
    threadId: args.threadId,
  });
}
