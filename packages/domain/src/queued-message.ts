import { z } from "zod";
import { pluginIdSchema } from "./plugin-id.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  systemMessageKindSchema,
  systemMessageSubjectSchema,
} from "./system-message.js";

/**
 * The queue is the one queue for a dispatch that cannot run yet.
 *
 * A send is always a dispatch attempt: when nothing blocks it, it dispatches
 * directly and no queued row ever exists. When something blocks it, the
 * message is queued as a row carrying the typed reason it is waiting, and
 * the drain re-attempts the dispatch when that reason could have cleared.
 *
 * These types describe what a queued row carries. The row's message itself
 * (content, execution tuple, plugin inputs) already lives in columns, so
 * nothing here re-encodes it.
 */

/**
 * Why a queued row is not dispatching yet.
 *
 * - `time` — the row has a future `sendAt`. The instant lives in the row's
 *   own `sendAt` field, which is what the due sweep indexes, so this arm
 *   carries no payload of its own.
 * - `thread-busy` — the thread is running a turn and the message asked to
 *   wait for idle rather than steer.
 * - `provisioning` — the thread's workspace is being (re)provisioned. Only
 *   follow-ups and steers wait on this: a thread's first message rides the
 *   cold-start command instead.
 * - `host-offline` — the thread's workspace exists, but the machine it runs on
 *   has no live daemon session, so nothing can be delivered to it. Distinct
 *   from `provisioning` because the two are cleared by different events and
 *   read differently to a user: a provisioning workspace is being built and
 *   will finish on its own, while an offline host is waiting on a machine that
 *   may be shut, asleep, or off the network. It carries the host's display
 *   name for the same reason the `plugin` arm carries its reason — the
 *   renderers that word this wait (the timeline projection in `thread-view`,
 *   `bb thread queue`) have no database to resolve an id against.
 * - `interaction` — the thread has a pending interaction the user has not
 *   settled.
 * - `plugin` — a plugin's dispatch gate returned `wait(reason)`. This is the
 *   only arm with an authored reason, because it is the only arm whose reason
 *   is not derivable from the kind (plus `sendAt`) by the renderer.
 */
export const queuedMessageWaitingOnKindValues = [
  "time",
  "thread-busy",
  "turn-starting",
  "provisioning",
  "host-offline",
  "interaction",
  "plugin",
] as const;
export const queuedMessageWaitingOnKindSchema = z.enum(
  queuedMessageWaitingOnKindValues,
);
export type QueuedMessageWaitingOnKind = z.infer<
  typeof queuedMessageWaitingOnKindSchema
>;

/**
 * The host display name a `host-offline` wait carries. Denormalized onto the
 * wait at queue time: the row outlives the attempt that queued it, and a rename
 * between then and the read is a cosmetic staleness, not a correctness one.
 */
export const queuedMessageWaitHostNameSchema = z.string().min(1).max(200);

/**
 * A plugin's wait reason renders on the queued card and in `bb thread queue`,
 * so it stays short enough for a couple of wrapped lines.
 */
export const QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH = 200;
export const queuedMessageWaitReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH);

export const queuedMessageWaitingOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time") }),
  z.object({ kind: z.literal("thread-busy") }),
  z.object({ kind: z.literal("turn-starting") }),
  z.object({ kind: z.literal("provisioning") }),
  z.object({
    kind: z.literal("host-offline"),
    hostName: queuedMessageWaitHostNameSchema,
  }),
  z.object({ kind: z.literal("interaction") }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: pluginIdSchema,
    reason: queuedMessageWaitReasonSchema,
  }),
]);
export type QueuedMessageWaitingOn = z.infer<
  typeof queuedMessageWaitingOnSchema
>;

export type QueuedMessagePluginWaitingOn = Extract<
  QueuedMessageWaitingOn,
  { kind: "plugin" }
>;

export type QueuedMessageHostOfflineWaitingOn = Extract<
  QueuedMessageWaitingOn,
  { kind: "host-offline" }
>;

/**
 * Why the last dispatch attempt on a queued row failed outright, as opposed to
 * queueing again.
 *
 * A row acquires one only on a drain attempt: an inline attempt has a caller
 * listening and surfaces the error to them instead. Until the drain has failed
 * on a row, it has none — which is the overwhelming majority of rows — so this
 * is null rather than a string that has to be read as "no failure yet".
 *
 * It is deliberately NOT part of `waitingOn`: writing a wait rewrites it
 * wholesale, so a failure recorded there would be erased by the very next
 * attempt, and the two answer different questions ("what is this row waiting
 * for" vs "what went wrong last time it tried").
 */
export const QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH = 200;
export const queuedMessageFailureReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH);

export const QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX = "plugin:";

/**
 * Who owns a wait, as the denormalized `waitHolder` column stores it.
 *
 * This exists only because the orphan sweep and the per-plugin release both
 * need an indexed equality lookup ("every row this plugin is holding"), which
 * a JSON `waitingOn` cannot serve. It is written by the same single writer
 * that writes `waitingOn`, derived from it — never set independently — so the
 * two cannot drift. Core waits have no holder.
 */
export const queuedMessageWaitHolderSchema = z.templateLiteral([
  QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX,
  pluginIdSchema,
]);
export type QueuedMessageWaitHolder = z.infer<
  typeof queuedMessageWaitHolderSchema
>;

/**
 * What a queued row dispatches when its waits clear.
 *
 * `inline` carries its own message in the row's columns — the prompt blocks
 * the sender wrote and the execution tuple frozen at queue time. It is a draft
 * that has not run, so it is editable while it waits.
 *
 * `retry` only references a failed turn's original request. Nothing about it
 * is editable: the point of a retry is to re-submit the original faithfully,
 * with no duplicated user message.
 */
export const queuedMessagePayloadKindValues = ["inline", "retry"] as const;
export const queuedMessagePayloadKindSchema = z.enum(
  queuedMessagePayloadKindValues,
);
export type QueuedMessagePayloadKind = z.infer<
  typeof queuedMessagePayloadKindSchema
>;

export const queuedMessagePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline") }),
  z.object({
    kind: z.literal("retry"),
    /**
     * The ORIGINAL request, not the attempt that just failed. Retrying a retry
     * re-submits the same original blocks, so this id is carried forward
     * unchanged across attempts and `attempt` is what distinguishes them.
     */
    retryOfTurnRequestId: clientTurnRequestIdSchema,
    /** Which attempt this row will dispatch: 2 is the first retry. */
    attempt: z.number().int().min(2),
    /**
     * Why this turn is being retried, in the retrier's words ("Rate limited"),
     * as the row's card and `bb thread queue list` render it.
     *
     * It lives on the payload rather than on `waitingOn` because a retry can
     * wait on the clock, on a limiter, or on nothing at all, and the reason
     * outlives all three: it is a fact about the retry, not about what is
     * currently holding it. Filled at the boundary, so every row has one.
     */
    reason: queuedMessageWaitReasonSchema,
  }),
]);
export type QueuedMessagePayload = z.infer<typeof queuedMessagePayloadSchema>;

export type QueuedMessageRetryPayload = Extract<
  QueuedMessagePayload,
  { kind: "retry" }
>;

/**
 * Core's own taxonomy for a queued row that is a SYSTEM notice rather than
 * someone's message — today, the "your child thread finished" notice a parent
 * gets while it is busy answering a question.
 *
 * Null for every ordinary row, which is the overwhelming majority. It exists
 * because such a notice is dispatched as an `initiator: "system"` turn whose
 * event carries this taxonomy, and a notice that queued and then dispatched
 * without it would be a different turn than the one that would have been sent
 * a moment earlier. The `deferred_thread_messages` table used to carry it; the
 * queue is the one queue now, so it carries it here.
 */
export const queuedMessageSystemNoticeSchema = z.object({
  kind: systemMessageKindSchema,
  subject: systemMessageSubjectSchema.nullable(),
});
export type QueuedMessageSystemNotice = z.infer<
  typeof queuedMessageSystemNoticeSchema
>;
