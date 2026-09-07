import { z } from "zod";
import {
  activeThinkingSchema,
  callerExecutionInputSourceSchema,
  environmentSchema,
  hostSchema,
  jsonValueSchema,
  pendingInteractionResolutionSchema,
  pendingInteractionSchema,
  permissionModeInputSchema,
  promptInputSchema,
  clientTurnRequestIdSchema,
  queuedMessageWaitHolderSchema,
  queuedMessageWaitingOnSchema,
  queuedMessageWaitReasonSchema,
  reasoningLevelSchema,
  rawThreadIdSchema,
  serviceTierSchema,
  threadOriginKindSchema,
  threadListEntrySchema,
  threadQueuedMessageSchema,
  threadSearchSourceKindSchema,
  threadStatusSchema,
  threadTimelineActivePromptModeSchema,
  threadTimelineGoalSchema,
  threadTimelineModelFallbackSchema,
  threadTimelinePendingTodosSchema,
  threadEventTypeValues,
  threadVisibilitySchema,
  threadWithRuntimeSchema,
} from "@bb/domain";
import type { CallerExecutionInputSource } from "@bb/domain";
import {
  timelineDeltaSchema,
  timelineRowSchema,
  timelineWorkflowWorkRowSchema,
} from "../thread-timeline.js";
import {
  createThreadEnvironmentArgsSchema,
  FILE_LIST_QUERY_MAX_LENGTH,
  isCommaSeparatedIncludeQueryValue,
  pathListIncludeQueryValueSchema,
  threadContextWindowUsageSchema,
  workspaceFileListResponseSchema,
  workspacePathListResponseSchema,
} from "./shared.js";

export const sendMessageModeSchema = z.enum([
  "queue-if-active",
  "steer-if-active",
  "auto",
  "start",
  "steer",
]);

export const threadCreateOriginSchema = z.enum(["app", "cli", "sdk", "plugin"]);
export type ThreadCreateOrigin = z.infer<typeof threadCreateOriginSchema>;

export const executionInputFieldSourceSchema = callerExecutionInputSourceSchema;
export type ExecutionInputFieldSource = CallerExecutionInputSource;

export const createExecutionInputSourcesSchema = z
  .object({
    providerId: executionInputFieldSourceSchema.optional(),
    model: executionInputFieldSourceSchema.optional(),
    serviceTier: executionInputFieldSourceSchema.optional(),
    reasoningLevel: executionInputFieldSourceSchema.optional(),
    permissionMode: executionInputFieldSourceSchema.optional(),
  })
  .strict();
export type CreateExecutionInputSources = z.infer<
  typeof createExecutionInputSourcesSchema
>;

export const existingThreadExecutionInputSourcesSchema = z
  .object({
    model: executionInputFieldSourceSchema.optional(),
    serviceTier: executionInputFieldSourceSchema.optional(),
    reasoningLevel: executionInputFieldSourceSchema.optional(),
    permissionMode: executionInputFieldSourceSchema.optional(),
  })
  .strict();
export type ExistingThreadExecutionInputSources = z.infer<
  typeof existingThreadExecutionInputSourcesSchema
>;

export const startedOnBehalfOfInitiatorSchema = z.enum(["agent", "system"]);

export const startedOnBehalfOfSchema = z.object({
  initiator: startedOnBehalfOfInitiatorSchema,
  senderThreadId: z.string().min(1),
});
export type StartedOnBehalfOf = z.infer<typeof startedOnBehalfOfSchema>;

export const createThreadRequestSchema = z
  .object({
    projectId: z.string().min(1),
    providerId: z.string().min(1).optional(),
    origin: threadCreateOriginSchema,
    originPluginId: z.string().min(1).optional(),
    visibility: threadVisibilitySchema.optional(),
    title: z.string().min(1).optional(),
    input: z.array(promptInputSchema),
    model: z.string().min(1).optional(),
    serviceTier: serviceTierSchema.optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    permissionMode: permissionModeInputSchema.optional(),
    executionInputSources: createExecutionInputSourcesSchema.optional(),
    environment: createThreadEnvironmentArgsSchema,
    parentThreadId: z.string().min(1).optional(),
    sectionId: z.string().min(1).nullable().optional(),
    sourceThreadId: z.string().min(1).optional(),
    sourceSeqEnd: z.number().int().nonnegative().optional(),
    startedOnBehalfOf: startedOnBehalfOfSchema.nullable().default(null),
    originKind: threadOriginKindSchema.nullable().default(null),
    /**
     * Epoch ms at which this thread's first message should dispatch. Present ⇒
     * the thread is created `pending` with no turn and no environment work,
     * and the first message is queued as a row waiting on the clock. Absent
     * ⇒ attempt the dispatch now; when nothing blocks it no queued row is ever
     * created and creation runs exactly as it did before the queue existed.
     */
    sendAt: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.origin === "plugin" && value.originPluginId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId is required when origin is "plugin"',
        path: ["originPluginId"],
      });
    }
    if (value.origin !== "plugin" && value.originPluginId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId requires origin "plugin"',
        path: ["originPluginId"],
      });
    }
    if (value.originKind === null && value.input.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "input must contain at least one entry",
        path: ["input"],
      });
    }
    if (value.originKind === null && value.sourceSeqEnd !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "sourceSeqEnd requires an originKind",
        path: ["sourceSeqEnd"],
      });
    }
  });
export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

const agentOnlyPromptInputSchema = promptInputSchema.and(
  z.object({ visibility: z.literal("agent-only") }),
);

export const forkThreadRequestSchema = z
  .object({
    sourceThreadId: z.string().min(1),
    sourceSeqEnd: z.number().int().nonnegative().optional(),
    input: z.array(promptInputSchema).min(1).optional(),
    agentContextSeed: z.array(agentOnlyPromptInputSchema).min(1).optional(),
    title: z.string().min(1).optional(),
    permissionMode: permissionModeInputSchema.optional(),
    visibility: threadVisibilitySchema.default("visible"),
    environment: createThreadEnvironmentArgsSchema.optional(),
    origin: threadCreateOriginSchema.default("sdk"),
    originPluginId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.origin === "plugin" && value.originPluginId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId is required when origin is "plugin"',
        path: ["originPluginId"],
      });
    }
    if (value.origin !== "plugin" && value.originPluginId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId requires origin "plugin"',
        path: ["originPluginId"],
      });
    }
  });
export type ForkThreadRequest = z.infer<typeof forkThreadRequestSchema>;

const sendMessageRequestBaseSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeInputSchema.optional(),
  executionInputSources: existingThreadExecutionInputSourcesSchema.optional(),
  mode: sendMessageModeSchema,
  senderThreadId: z.string().min(1).optional(),
  /**
   * Epoch ms at which this message should dispatch. Present ⇒ nothing is sent
   * now; the message is queued as a row waiting on the clock, and the due
   * sweep re-attempts it then. Absent ⇒ attempt the dispatch now.
   */
  sendAt: z.number().int().nonnegative().optional(),
});

export const sendMessageRequestSchema = sendMessageRequestBaseSchema;
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/**
 * How a `send` request was taken.
 *
 * Two outcomes, because there are two: the attempt cleared and dispatched, or
 * something blocked it and it queued. The four-way `sent`/`queued`/`deferred`/
 * `held` split this replaces described WHICH queueing mechanism took the
 * message, and there is only one now — so the useful half of that answer, WHY
 * it is waiting, moved onto the queued arm where it can be typed.
 */
export const sendMessageDeliverySchema = z.enum(["sent", "queued"]);
export type SendMessageDelivery = z.infer<typeof sendMessageDeliverySchema>;

/**
 * A discriminated union rather than a flat record with nullable extras: a
 * `sent` message has no queued row and no wait, and modelling those as "null
 * for now" would invite every caller to check fields that cannot exist.
 */
export const sendMessageResponseSchema = z.discriminatedUnion("delivery", [
  z.object({ ok: z.literal(true), delivery: z.literal("sent") }),
  z.object({
    ok: z.literal(true),
    delivery: z.literal("queued"),
    queuedMessage: threadQueuedMessageSchema,
  }),
]);
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

// `sendAt` is deliberately dropped: an edit rewrites a message that has
// already been dispatched, so there is nothing left to schedule.
export const editMessageRequestSchema = sendMessageRequestBaseSchema
  .omit({ mode: true, sendAt: true })
  .extend({
    operationId: z.string().min(1),
    expectedRequestSequence: z.number().int().nonnegative().optional(),
  })
  .strict();
export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;

export const editMessageResponseSchema = z
  .object({
    ok: z.literal(true),
    operationId: z.string().min(1),
    requestSequence: z.number().int().nonnegative(),
  })
  .strict();
export type EditMessageResponse = z.infer<typeof editMessageResponseSchema>;

/**
 * The reason a retry carries when the caller names none. Filled here at the
 * boundary so the queued row, its card and `bb thread queue list` all read the
 * same word whether the retry came from a plugin, the CLI or the app.
 */
export const DEFAULT_TURN_RETRY_REASON = "Retry";

export const retryTurnRequestSchema = z
  .object({
    /**
     * The failed turn to re-submit. Null means the thread's own most recent
     * turn, which is the one whose failure put it in `error` — the only turn a
     * caller who did not watch the failure happen can mean.
     */
    turnRequestId: clientTurnRequestIdSchema.nullable().default(null),
    /**
     * Epoch ms to retry at. Null attempts the retry now (it may still queue
     * behind a busy thread or a plugin wait, like any other dispatch); a future
     * instant queues the row on the clock, which is what a rate-limit window
     * wants.
     */
    sendAt: z.number().int().nonnegative().nullable().default(null),
    /** Why the turn is being retried, shown verbatim on the queued row. */
    reason: queuedMessageWaitReasonSchema.default(DEFAULT_TURN_RETRY_REASON),
  })
  .strict();
export type RetryTurnRequest = z.infer<typeof retryTurnRequestSchema>;

/**
 * What a retry did, mirroring `sendMessageResponseSchema`: a retry is a
 * dispatch of a turn that already exists, so it is delivered or queued on
 * exactly the same terms as a send. The two retry-specific facts ride along,
 * because a caller that let the server pick the turn has no other way to learn
 * which one it picked.
 */
export const retryTurnResponseSchema = z.discriminatedUnion("delivery", [
  z.object({
    ok: z.literal(true),
    delivery: z.literal("sent"),
    /** The ORIGINAL request of the retry chain, which the retry re-submits. */
    turnRequestId: clientTurnRequestIdSchema,
    /** Which attempt this retry is: 2 is the first retry. */
    attempt: z.number().int().min(2),
  }),
  z.object({
    ok: z.literal(true),
    delivery: z.literal("queued"),
    turnRequestId: clientTurnRequestIdSchema,
    attempt: z.number().int().min(2),
    /** The row now carrying the retry; addressable for send-now or cancel. */
    queuedMessageId: z.string().min(1),
    waitingOn: queuedMessageWaitingOnSchema,
    sendAt: z.number().int().nonnegative().nullable(),
  }),
]);
export type RetryTurnResponse = z.infer<typeof retryTurnResponseSchema>;

export const sendQueuedMessageModeSchema = z.enum(["auto", "steer"]);
export type SendQueuedMessageMode = z.infer<typeof sendQueuedMessageModeSchema>;

export const createQueuedMessageRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeInputSchema.optional(),
  executionInputSources: existingThreadExecutionInputSourcesSchema.optional(),
  senderThreadId: z.string().min(1).optional(),
});
export type CreateQueuedMessageRequest = z.infer<
  typeof createQueuedMessageRequestSchema
>;

export const updateQueuedMessageRequestSchema = z.object({
  expectedUpdatedAt: z.number().int().nonnegative(),
  input: z.array(promptInputSchema).min(1),
});
export type UpdateQueuedMessageRequest = z.infer<
  typeof updateQueuedMessageRequestSchema
>;

export const sendQueuedMessageRequestSchema = z.object({
  mode: sendQueuedMessageModeSchema,
});
export type SendQueuedMessageRequest = z.infer<
  typeof sendQueuedMessageRequestSchema
>;

export const reorderQueuedMessageRequestSchema = z.object({
  previousQueuedMessageId: z.string().min(1).nullable(),
  nextQueuedMessageId: z.string().min(1).nullable(),
  groupBoundaryQueuedMessageId: z.string().min(1).optional(),
});
export type ReorderQueuedMessageRequest = z.infer<
  typeof reorderQueuedMessageRequestSchema
>;

export const setQueuedMessageGroupBoundaryRequestSchema = z.object({
  expectedGroupedPrefixQueuedMessageIds: z.array(z.string().min(1)).min(1),
  groupBoundaryQueuedMessageId: z.string().min(1),
});
export type SetQueuedMessageGroupBoundaryRequest = z.infer<
  typeof setQueuedMessageGroupBoundaryRequestSchema
>;

export const sendQueuedMessageResponseSchema = sendMessageResponseSchema;
export type SendQueuedMessageResponse = z.infer<
  typeof sendQueuedMessageResponseSchema
>;

export const threadListResponseSchema = z.array(threadListEntrySchema);
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;

export const THREAD_MENTION_RESOLVE_MAX_IDS = 32;

export const resolveThreadMentionsRequestSchema = z
  .object({
    threadIds: z.array(rawThreadIdSchema).max(THREAD_MENTION_RESOLVE_MAX_IDS),
  })
  .strict();
export type ResolveThreadMentionsRequest = z.infer<
  typeof resolveThreadMentionsRequestSchema
>;

export const threadMentionResolutionSchema = z
  .object({
    threadId: rawThreadIdSchema,
    projectId: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

export const resolveThreadMentionsResponseSchema = z.array(
  threadMentionResolutionSchema,
);
export type ResolveThreadMentionsResponse = z.infer<
  typeof resolveThreadMentionsResponseSchema
>;

export const threadSearchHighlightRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.end > range.start, {
    message: "highlight range end must be greater than start",
  });
export type ThreadSearchHighlightRange = z.infer<
  typeof threadSearchHighlightRangeSchema
>;

export const threadSearchMatchSchema = z
  .object({
    sourceKind: threadSearchSourceKindSchema,
    text: z.string(),
    highlightRanges: z.array(threadSearchHighlightRangeSchema),
    sourceSeq: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ThreadSearchMatch = z.infer<typeof threadSearchMatchSchema>;

export const threadSearchResultSchema = z
  .object({
    thread: threadListEntrySchema,
    matches: z.array(threadSearchMatchSchema),
  })
  .strict();
export type ThreadSearchResult = z.infer<typeof threadSearchResultSchema>;

export const threadSearchResultGroupSchema = z
  .object({
    total: z.number().int().nonnegative(),
    results: z.array(threadSearchResultSchema),
  })
  .strict();
export type ThreadSearchResultGroup = z.infer<
  typeof threadSearchResultGroupSchema
>;

export const threadSearchResponseSchema = z
  .object({
    active: threadSearchResultGroupSchema,
    archived: threadSearchResultGroupSchema,
  })
  .strict();
export type ThreadSearchResponse = z.infer<typeof threadSearchResponseSchema>;

export const threadResponseSchema = threadWithRuntimeSchema.extend({
  activeBackgroundAgentCount: z.number().int().nonnegative(),
  canSpawnChild: z.boolean(),
  // How many messages are waiting on this thread's queue right now — waiting on
  // the clock, on the running turn, on provisioning, on an interaction, or on
  // a plugin. The count alone drives the pending-region and thread-row badges;
  // `GET /threads/:id/queued-messages` supplies the reasons once a surface
  // actually renders them.
  queuedMessageCount: z.number().int().nonnegative(),
});
export type ThreadResponse = z.infer<typeof threadResponseSchema>;

export const threadIncludeOptionSchema = z.enum(["environment", "host"]);
export type ThreadIncludeOption = z.infer<typeof threadIncludeOptionSchema>;

export const threadGetQuerySchema = z.object({
  include: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: threadIncludeOptionSchema.options,
          value,
        }),
      { message: "Invalid include" },
    )
    .optional(),
});
export type ThreadGetQuery = z.infer<typeof threadGetQuerySchema>;

export const threadWithIncludesResponseSchema = threadResponseSchema.extend({
  environment: environmentSchema.nullable().optional(),
  host: hostSchema.nullable().optional(),
});
export type ThreadWithIncludesResponse = z.infer<
  typeof threadWithIncludesResponseSchema
>;

export const threadPendingInteractionsResponseSchema = z.array(
  pendingInteractionSchema,
);
export type ThreadPendingInteractionsResponse = z.infer<
  typeof threadPendingInteractionsResponseSchema
>;

export const resolvePendingInteractionRequestSchema =
  pendingInteractionResolutionSchema;
export type ResolvePendingInteractionRequest = z.infer<
  typeof resolvePendingInteractionRequestSchema
>;

export const respondPluginInteractionRequestSchema = z.object({
  value: jsonValueSchema,
});
export type RespondPluginInteractionRequest = z.infer<
  typeof respondPluginInteractionRequestSchema
>;

/**
 * Filters for the cross-thread queue list — the replacement for the hold
 * list, and cross-thread for the same reason it was: "what is queued right
 * now" is a whole-workspace question (`bb thread queue list` with no thread, a
 * limiter plugin's own bookkeeping, a router recovering its rows after a
 * restart) that no single thread's list can answer.
 *
 * `waitHolder` is the indexed one. It answers "every row this plugin is
 * holding", which is exactly what a plugin needs on restart and what the
 * orphan sweep needs per uninstalled plugin.
 */
export const queuedMessageListQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  waitHolder: queuedMessageWaitHolderSchema.optional(),
});
export type QueuedMessageListQuery = z.infer<
  typeof queuedMessageListQuerySchema
>;

export const threadQueuedMessageListResponseSchema = z.array(
  threadQueuedMessageSchema,
);
export type ThreadQueuedMessageListResponse = z.infer<
  typeof threadQueuedMessageListResponseSchema
>;

export const threadChildSummaryResponseSchema = z.object({
  nonDeletedChildCount: z.number().int().nonnegative(),
});
export type ThreadChildSummaryResponse = z.infer<
  typeof threadChildSummaryResponseSchema
>;

export const deleteThreadRequestSchema = z.object({
  childThreadsConfirmed: z.boolean(),
});
export type DeleteThreadRequest = z.infer<typeof deleteThreadRequestSchema>;

export const updateThreadRequestSchema = z
  .object({
    title: z.string().min(1).nullable(),
    sectionId: z.string().min(1).nullable(),
    parentThreadId: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    reasoningLevel: reasoningLevelSchema.nullable(),
    visibility: threadVisibilitySchema,
  })
  .partial()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.sectionId !== undefined ||
      value.parentThreadId !== undefined ||
      value.model !== undefined ||
      value.reasoningLevel !== undefined ||
      value.visibility !== undefined,
    "At least one field must be provided",
  );
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

export const reorderPinnedThreadRequestSchema = z.object({
  previousThreadId: z.string().min(1).nullable(),
  nextThreadId: z.string().min(1).nullable(),
});
export type ReorderPinnedThreadRequest = z.infer<
  typeof reorderPinnedThreadRequestSchema
>;

export const panelFileSourceSchema = z.enum(["workspace", "thread-storage"]);
export type PanelFileSource = z.infer<typeof panelFileSourceSchema>;

export const threadOpenSplitSchema = z.enum([
  "right",
  "down",
  "left",
  "top",
  "replace",
]);
export type ThreadOpenSplit = z.infer<typeof threadOpenSplitSchema>;

export const threadOpenFileSchema = z
  .object({
    source: panelFileSourceSchema,
    path: z.string().min(1),
    lineNumber: z.number().int().positive().nullable(),
  })
  .strict();
export type ThreadOpenFile = z.infer<typeof threadOpenFileSchema>;

const threadOpenFileLenientSchema = z.object({
  source: panelFileSourceSchema,
  path: z.string().min(1),
  lineNumber: z.number().int().positive().nullable(),
});

export const threadOpenSignalSchema = z
  .object({
    type: z.literal("thread-open"),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    split: threadOpenSplitSchema,
    file: threadOpenFileSchema.nullable(),
  })
  .strict();
export type ThreadOpenSignal = z.infer<typeof threadOpenSignalSchema>;

export const threadOpenSignalLenientSchema = z.object({
  type: z.literal("thread-open"),
  projectId: z.string(),
  threadId: z.string(),
  split: threadOpenSplitSchema,
  file: threadOpenFileLenientSchema.nullable(),
});

export const threadOpenRequestSchema = z
  .object({
    split: threadOpenSplitSchema.optional(),
    file: threadOpenFileSchema.nullable(),
  })
  .strict();
export type ThreadOpenRequest = z.infer<typeof threadOpenRequestSchema>;

export const threadOpenResponseSchema = z.object({
  delivered: z.number().int().nonnegative(),
});
export type ThreadOpenResponse = z.infer<typeof threadOpenResponseSchema>;

export const threadPaneActionSchema = z.enum([
  "maximize",
  "restore",
  "toggle",
  "spotlight",
  "clear-spotlight",
]);
export type ThreadPaneAction = z.infer<typeof threadPaneActionSchema>;

export const threadPaneActionRequestSchema = z
  .object({ action: threadPaneActionSchema })
  .strict();
export type ThreadPaneActionRequest = z.infer<
  typeof threadPaneActionRequestSchema
>;

export const threadPaneActionSignalSchema = z
  .object({
    type: z.literal("thread-pane-action"),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    action: threadPaneActionSchema,
  })
  .strict();
export type ThreadPaneActionSignal = z.infer<
  typeof threadPaneActionSignalSchema
>;

export const threadPaneActionSignalLenientSchema = z.object({
  type: z.literal("thread-pane-action"),
  projectId: z.string(),
  threadId: z.string(),
  action: threadPaneActionSchema,
});

export const threadPaneActionResponseSchema = z.object({
  delivered: z.number().int().nonnegative(),
});
export type ThreadPaneActionResponse = z.infer<
  typeof threadPaneActionResponseSchema
>;

export const threadArchiveAllResponseSchema = z.object({
  ok: z.literal(true),
  archivedThreadIds: z.array(z.string().min(1)),
});
export type ThreadArchiveAllResponse = z.infer<
  typeof threadArchiveAllResponseSchema
>;

export const threadListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  parentThreadId: z.string().min(1).optional(),
  sourceThreadId: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional(),
  sectionId: z.string().min(1).optional(),
  unsectioned: z.enum(["true", "false"]).optional(),
  hasParent: z.enum(["true", "false"]).optional(),
  originKind: threadOriginKindSchema.optional(),
  originPluginId: z.string().min(1).optional(),
  includeHidden: z.enum(["true", "false"]).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});
export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

/**
 * Grouping for `GET /threads/count`. Omitted, the route answers one total.
 * `host` groups by the host the thread's environment lives on; a thread with
 * no environment yet counts under the `null` key.
 */
export const threadCountGroupBySchema = z.enum(["host", "provider", "project"]);
export type ThreadCountGroupBy = z.infer<typeof threadCountGroupBySchema>;

/**
 * Filters for `GET /threads/count`. Every value is a string because this is a
 * query string; the route parses them once at the boundary.
 *
 * `parentThreadId` is deliberately three-valued and unambiguous: omitted means
 * "do not filter on parentage", the literal `"none"` means root threads only
 * (`parent_thread_id IS NULL`), and any other value is that parent's id. An
 * empty string would have been ambiguous with an omitted parameter, and a
 * thread id can never be `"none"` (ids are prefixed `thr_`).
 */
export const THREAD_COUNT_ROOT_PARENT = "none";

export const threadCountQuerySchema = z.object({
  status: threadStatusSchema.optional(),
  hostId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  parentThreadId: z.string().min(1).optional(),
  groupBy: threadCountGroupBySchema.optional(),
  /** Count archived threads too; omitted/false excludes them (deleted always are). */
  includeArchived: z.enum(["true", "false"]).optional(),
  /** Count hidden threads too; omitted/false counts visible threads only. */
  includeHidden: z.enum(["true", "false"]).optional(),
});
export type ThreadCountQuery = z.infer<typeof threadCountQuerySchema>;

/**
 * `total` is always the count of every matching thread. `groups` is present
 * exactly when `groupBy` was requested — an ungrouped count has no group list,
 * rather than one anonymous group.
 */
export const threadCountResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  groups: z
    .array(
      z.object({
        /** The host/provider/project id, or null for threads with none. */
        key: z.string().nullable(),
        count: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export type ThreadCountResponse = z.infer<typeof threadCountResponseSchema>;

/**
 * One thread currently occupying capacity — canonical status `starting` or
 * `active`. Archived and deleted threads are excluded (neither runs); hidden
 * ones are not, because a hidden thread burns a real slot on a real machine.
 *
 * The row is an id and the machine that id is occupying, and nothing else.
 * `hostId` is here because a per-host pool cannot be derived from an id
 * without a query per row; every other question a caller might ask is
 * answerable by fetching the thread it names.
 *
 * **Exact inside the `message.dispatch` hook, a snapshot everywhere else.**
 * Hook passes run one at a time under a server-wide lock, and a cleared first
 * attempt commits its `pending → starting` flip before that lock releases — so
 * the next handler in line sees the admission the previous one granted. Read
 * anywhere else (a background service, an HTTP client, a `turn.failed`
 * listener) it is an ordinary query that races with every concurrent dispatch,
 * exactly like `threads.count`.
 * See {@link threadRunningResponseSchema}'s consumers in the plugin authoring
 * guide for the one boundary case: a warm follow-up's `idle → active` flip
 * commits just after the lock, so admissions of already-live threads can be
 * momentarily invisible.
 */
export const threadRunningEntrySchema = z.object({
  id: z.string(),
  /** The machine it runs on; null while no environment has been chosen. */
  hostId: z.string().nullable(),
});
export type ThreadRunningEntry = z.infer<typeof threadRunningEntrySchema>;

export const threadRunningResponseSchema = z.array(threadRunningEntrySchema);
export type ThreadRunningResponse = z.infer<typeof threadRunningResponseSchema>;

export const threadSearchQuerySchema = z.object({
  query: z.string().trim().min(2),
  limitPerGroup: z.string().regex(/^\d+$/).optional(),
});
export type ThreadSearchQuery = z.infer<typeof threadSearchQuerySchema>;

export const timelinePaginationCursorSchema = z
  .object({
    anchorSeq: z.number().int().positive(),
    anchorId: z.string().min(1),
  })
  .strict();
export type TimelinePaginationCursor = z.infer<
  typeof timelinePaginationCursorSchema
>;

export const timelinePageMetadataSchema = z
  .object({
    kind: z.enum(["latest", "older"]),
    segmentLimit: z.number().int().positive(),
    returnedSegmentCount: z.number().int().nonnegative(),
    hasOlderRows: z.boolean(),
    olderCursor: timelinePaginationCursorSchema.nullable(),
  })
  .strict();

export const threadTimelineQuerySchema = z
  .object({
    includeNestedRows: z.enum(["true", "false"]),
    segmentLimit: z.string().regex(/^\d+$/),
    beforeAnchorSeq: z.string().regex(/^[1-9]\d*$/),
    beforeAnchorId: z.string().min(1),
    summaryOnly: z.enum(["true", "false"]),
    afterSequence: z.string().regex(/^\d+$/),
  })
  .partial()
  .superRefine((query, context) => {
    const hasBeforeAnchorSeq = query.beforeAnchorSeq !== undefined;
    const hasBeforeAnchorId = query.beforeAnchorId !== undefined;

    if (hasBeforeAnchorSeq === hasBeforeAnchorId) {
      return;
    }

    context.addIssue({
      code: "custom",
      message: "beforeAnchorSeq and beforeAnchorId must be provided together",
      path: hasBeforeAnchorSeq ? ["beforeAnchorId"] : ["beforeAnchorSeq"],
    });
  });
export type ThreadTimelineQuery = z.infer<typeof threadTimelineQuerySchema>;

export const timelineTurnSummaryDetailsQuerySchema = z.object({
  turnId: z.string().min(1),
  sourceSeqStart: z.string().regex(/^\d+$/),
  sourceSeqEnd: z.string().regex(/^\d+$/),
});
export type TimelineTurnSummaryDetailsQuery = z.infer<
  typeof timelineTurnSummaryDetailsQuerySchema
>;

export const threadEventsQuerySchema = z
  .object({
    afterSeq: z.string().regex(/^\d+$/),
    beforeSeq: z.string().regex(/^\d+$/),
    limit: z.string().regex(/^\d+$/),
    order: z.enum(["asc", "desc"]),
    types: z.string().refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: threadEventTypeValues,
          value,
        }),
      "Invalid thread event types",
    ),
  })
  .partial();
export type ThreadEventsQuery = z.infer<typeof threadEventsQuerySchema>;

export const threadEventWaitQuerySchema = z.object({
  type: z.string().min(1),
  afterSeq: z.string().regex(/^\d+$/).optional(),
  waitMs: z.string().regex(/^\d+$/).optional(),
});
export type ThreadEventWaitQuery = z.infer<typeof threadEventWaitQuerySchema>;

export const threadStorageFilesQuerySchema = z
  .object({
    query: z.string().min(1).max(FILE_LIST_QUERY_MAX_LENGTH),
    limit: z.string().regex(/^\d+$/),
  })
  .partial();
export type ThreadStorageFilesQuery = z.infer<
  typeof threadStorageFilesQuerySchema
>;

export const threadStoragePathsQuerySchema =
  threadStorageFilesQuerySchema.extend({
    includeFiles: pathListIncludeQueryValueSchema,
    includeDirectories: pathListIncludeQueryValueSchema,
  });
export type ThreadStoragePathsQuery = z.infer<
  typeof threadStoragePathsQuerySchema
>;

export const threadStorageContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type ThreadStorageContentQuery = z.infer<
  typeof threadStorageContentQuerySchema
>;

export const threadStorageLocationResponseSchema = z
  .object({
    hostId: z.string().min(1),
    storageRootPath: z.string().min(1),
  })
  .strict();
export type ThreadStorageLocationResponse = z.infer<
  typeof threadStorageLocationResponseSchema
>;

export const threadHostFileContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type ThreadHostFileContentQuery = z.infer<
  typeof threadHostFileContentQuerySchema
>;

export const threadFilesRawQuerySchema = z.object({
  path: z.string().min(1),
});
export type ThreadFilesRawQuery = z.infer<typeof threadFilesRawQuerySchema>;

export const timelineTurnSummaryDetailsRequestSchema = z.object({
  turnId: z.string().min(1),
  sourceSeqStart: z.number().int().nonnegative(),
  sourceSeqEnd: z.number().int().nonnegative(),
});

export const timelineTurnSummaryDetailsResponseSchema = z.object({
  rows: z.array(timelineRowSchema),
});
export type TimelineTurnSummaryDetailsResponse = z.infer<
  typeof timelineTurnSummaryDetailsResponseSchema
>;

export const threadTimelineResponseSchema = z.object({
  rows: z.array(timelineRowSchema),
  contextBoundarySeq: z.number().int().nonnegative().nullable(),
  activePromptMode: threadTimelineActivePromptModeSchema.nullable(),
  activeThinking: activeThinkingSchema.nullable(),
  activeWorkflows: z.array(timelineWorkflowWorkRowSchema),
  activeBackgroundCommands: z.array(timelineWorkflowWorkRowSchema),
  pendingTodos: threadTimelinePendingTodosSchema.nullable(),
  goal: threadTimelineGoalSchema.nullable(),
  modelFallback: threadTimelineModelFallbackSchema.nullable(),
  contextWindowUsage: threadContextWindowUsageSchema.optional(),
  timelinePage: timelinePageMetadataSchema,
  maxSeq: z.number().int().nonnegative(),
  delta: timelineDeltaSchema.optional(),
});
export type ThreadTimelineResponse = z.infer<
  typeof threadTimelineResponseSchema
>;

export const threadConversationOutlineAttachmentSummarySchema = z
  .object({
    imageCount: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadConversationOutlineAttachmentSummary = z.infer<
  typeof threadConversationOutlineAttachmentSummarySchema
>;

export const threadConversationOutlineItemSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    preview: z.string(),
    attachmentSummary:
      threadConversationOutlineAttachmentSummarySchema.nullable(),
  })
  .strict();
export type ThreadConversationOutlineItem = z.infer<
  typeof threadConversationOutlineItemSchema
>;

export const threadConversationOutlineResponseSchema = z
  .object({
    items: z.array(threadConversationOutlineItemSchema),
    maxSeq: z.number().int().nonnegative(),
  })
  .strict();
export type ThreadConversationOutlineResponse = z.infer<
  typeof threadConversationOutlineResponseSchema
>;

export const threadStorageFileListResponseSchema =
  workspaceFileListResponseSchema.extend({
    storageRootPath: z.string(),
  });
export type ThreadStorageFileListResponse = z.infer<
  typeof threadStorageFileListResponseSchema
>;

export const threadStoragePathListResponseSchema =
  workspacePathListResponseSchema.extend({
    storageRootPath: z.string(),
  });
export type ThreadStoragePathListResponse = z.infer<
  typeof threadStoragePathListResponseSchema
>;
