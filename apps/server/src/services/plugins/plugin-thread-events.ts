import type { ApplyThreadLifecycleEventOutcome } from "@bb/db";
import type { PendingInteraction, Thread } from "@bb/domain";
import type { ThreadQueuedMessage } from "@bb/domain";
import type { PluginThreadEventEmitter } from "./plugin-service.js";

let emitter: PluginThreadEventEmitter | undefined;

export function setPluginThreadEventEmitter(
  next: PluginThreadEventEmitter | undefined,
): void {
  emitter = next;
}

export function emitPluginThreadCreated(thread: Thread): void {
  emitter?.emitThreadCreated(thread);
}

/**
 * Called after a thread is archived (archiveThreadWithLifecycleEffects),
 * including cascade archives.
 */
export function emitPluginThreadArchived(thread: Thread): void {
  emitter?.emitThreadArchived(thread);
}

export function emitPluginThreadDeleted(thread: Thread): void {
  emitter?.emitThreadDeleted(thread);
}

export function emitPluginInteractionPending(
  thread: Thread,
  interaction: PendingInteraction,
): void {
  emitter?.emitInteractionPending(thread, interaction);
}

/** Called after a dispatch attempt is queued as a row (recordQueuedMessageWait). */
export function emitPluginMessageQueued(entry: ThreadQueuedMessage): void {
  emitter?.emitMessageQueued(entry);
}

/** Called after a queued row's waits cleared and it dispatched. */
export function emitPluginMessageDispatched(entry: ThreadQueuedMessage): void {
  emitter?.emitMessageDispatched(entry);
}

/**
 * Called after an applied `run.failed` lifecycle event, from the same seam
 * that announces the thread's move into `error`.
 *
 * `thread.failed` says the thread stopped; this says which turn stopped it and
 * why, which is what a retry policy decides on. Both are announcements — the
 * failure stands either way — so neither can block the seam.
 */
export function emitPluginTurnFailed(threadId: string): void {
  emitter?.emitTurnFailed(threadId);
}

/**
 * Called with every lifecycle-event outcome; forwards applied transitions
 * into `active`/`idle`/`error` as their curated plugin lifecycle events.
 * Those statuses have no self-transitions in THREAD_LIFECYCLE, so an applied
 * outcome landing there always means the thread just entered the state.
 *
 * These, plus archive and delete above, are the fanout a plugin whose waits
 * depend on capacity subscribes to; it answers by calling
 * `bb.experimental_hooks.recheck()`. Core deliberately does not derive
 * "a slot freed" here itself: the wait is the plugin's, and so is the
 * condition that ends it.
 */
export function emitPluginThreadLifecycleOutcome(
  outcome: ApplyThreadLifecycleEventOutcome,
): void {
  if (!outcome.applied) return;
  if (outcome.thread.status === "active") {
    emitter?.emitThreadActive(outcome.thread);
  } else if (outcome.thread.status === "idle") {
    emitter?.emitThreadIdle(outcome.thread);
  } else if (outcome.thread.status === "error") {
    emitter?.emitThreadFailed(outcome.thread);
  }
}
