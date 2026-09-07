import { z } from "zod";
import { terminalCreateTargetSchema } from "./terminals.js";

const THREAD_TAB_ID_MAX_LENGTH = 4_194_304;
const THREAD_TAB_PATH_MAX_LENGTH = 32_768;
const THREAD_TAB_TITLE_MAX_LENGTH = 1_024;
const THREAD_TAB_URL_MAX_LENGTH = 4_096;
const THREAD_TAB_PARAMS_MAX_LENGTH = 1_048_576;
const THREAD_TAB_SOURCE_MESSAGE_MAX_LENGTH = 2_097_152;
const THREAD_TAB_LIST_MAX_LENGTH = 200;
const THREAD_TABS_JSON_MAX_LENGTH = 8_388_608;

const threadTabIdSchema = z.string().min(1).max(THREAD_TAB_ID_MAX_LENGTH);
const threadTabPathSchema = z.string().min(1).max(THREAD_TAB_PATH_MAX_LENGTH);
const threadTabLineRangeSchema = z
  .object({
    endLineNumber: z.number().int().positive(),
    startLineNumber: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.startLineNumber <= range.endLineNumber);
const threadTabEnvironmentFileSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("working-tree") }).strict(),
  z.object({ kind: z.literal("head") }).strict(),
  z
    .object({
      kind: z.literal("merge-base"),
      ref: z.string().min(1).max(THREAD_TAB_PATH_MAX_LENGTH),
    })
    .strict(),
]);

export const threadTabFileOpenerOwnerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      environmentId: z.string().min(1).nullable(),
      kind: z.literal("workspace-file-preview"),
      projectId: z.string().min(1).nullable(),
      tab: z
        .object({
          lineRange: threadTabLineRangeSchema.nullable(),
          path: threadTabPathSchema,
          source: threadTabEnvironmentFileSourceSchema,
          statusLabel: z.literal("deleted").nullable(),
        })
        .strict(),
      threadId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      environmentId: z.string().min(1).nullable().default(null),
      hostId: z.string().min(1).nullable().default(null),
      kind: z.literal("host-file-preview"),
      tab: z
        .object({
          lineRange: threadTabLineRangeSchema.nullable(),
          path: threadTabPathSchema,
        })
        .strict(),
      threadId: z.string().min(1).nullable().default(null),
    })
    .strict()
    .refine(
      (owner) =>
        owner.hostId !== null ||
        (owner.environmentId !== null && owner.threadId !== null),
      { message: "hostId or threadId/environmentId is required" },
    ),
  z
    .object({
      environmentId: z.string().min(1).nullable(),
      kind: z.literal("thread-storage-file-preview"),
      tab: z
        .object({
          lineRange: threadTabLineRangeSchema.nullable(),
          path: threadTabPathSchema,
        })
        .strict(),
      threadId: z.string().min(1),
    })
    .strict(),
]);
export type ThreadTabFileOpenerOwner = z.infer<
  typeof threadTabFileOpenerOwnerSchema
>;

export const threadTabSchema = z.discriminatedUnion("kind", [
  z.object({ id: threadTabIdSchema, kind: z.literal("thread-info") }).strict(),
  z.object({ id: threadTabIdSchema, kind: z.literal("git-diff") }).strict(),
  z
    .object({
      actionId: z.string().min(1).max(THREAD_TAB_PATH_MAX_LENGTH),
      fileOpenerOwner: threadTabFileOpenerOwnerSchema.optional(),
      id: threadTabIdSchema,
      kind: z.literal("plugin-panel"),
      paramsJson: z.string().max(THREAD_TAB_PARAMS_MAX_LENGTH).nullable(),
      pluginId: z.string().min(1).max(THREAD_TAB_PATH_MAX_LENGTH),
      title: z.string().min(1).max(THREAD_TAB_TITLE_MAX_LENGTH),
    })
    .strict(),
  z
    .object({
      environmentId: z.string().min(1).nullable(),
      id: threadTabIdSchema,
      kind: z.literal("workspace-file-preview"),
      lineRange: threadTabLineRangeSchema.nullable(),
      path: threadTabPathSchema,
      projectId: z.string().min(1).nullable(),
      source: threadTabEnvironmentFileSourceSchema,
      statusLabel: z.literal("deleted").nullable(),
    })
    .strict(),
  z
    .object({
      environmentId: z.string().min(1).nullable(),
      hostId: z.string().min(1).nullable().default(null),
      id: threadTabIdSchema,
      kind: z.literal("host-file-preview"),
      lineRange: threadTabLineRangeSchema.nullable(),
      path: threadTabPathSchema,
      threadId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      environmentId: z.string().min(1).nullable(),
      id: threadTabIdSchema,
      isPinned: z.boolean(),
      kind: z.literal("thread-storage-file-preview"),
      lineRange: threadTabLineRangeSchema.nullable(),
      path: threadTabPathSchema,
      threadId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      environmentId: z.string().min(1).nullable(),
      id: threadTabIdSchema,
      kind: z.literal("browser"),
      desktopTarget: z
        .object({
          hostId: z.string().min(1),
          instanceId: z.string().min(1),
          generation: z.string().min(1),
        })
        .strict()
        .optional(),
      title: z.string().min(1).max(THREAD_TAB_TITLE_MAX_LENGTH).nullable(),
      url: z.string().max(THREAD_TAB_URL_MAX_LENGTH),
    })
    .strict(),
  z.object({ id: threadTabIdSchema, kind: z.literal("new-tab") }).strict(),
  z
    .object({
      id: threadTabIdSchema,
      kind: z.literal("side-chat"),
      sourceMessageText: z.string().max(THREAD_TAB_SOURCE_MESSAGE_MAX_LENGTH),
      sourceSeqEnd: z.number().int().nonnegative().nullable(),
      threadId: z.string().min(1).nullable(),
      title: z.string().min(1).max(THREAD_TAB_TITLE_MAX_LENGTH),
    })
    .strict(),
  z
    .object({
      id: threadTabIdSchema,
      kind: z.literal("terminal"),
      target: terminalCreateTargetSchema.optional(),
      terminalId: z.string().min(1).max(THREAD_TAB_PATH_MAX_LENGTH),
    })
    .strict(),
]);
export type ThreadTab = z.infer<typeof threadTabSchema>;

export const threadTabsSchema = z
  .array(threadTabSchema)
  .max(THREAD_TAB_LIST_MAX_LENGTH)
  .superRefine((tabs, context) => {
    if (JSON.stringify(tabs).length > THREAD_TABS_JSON_MAX_LENGTH) {
      context.addIssue({
        code: "custom",
        message: "Thread tabs payload is too large",
      });
    }
    const seenIds = new Set<string>();
    for (const [index, tab] of tabs.entries()) {
      if (seenIds.has(tab.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate tab id: ${tab.id}`,
          path: [index, "id"],
        });
      }
      seenIds.add(tab.id);
    }
  });

export const threadTabsResponseSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    tabs: threadTabsSchema,
  })
  .strict();
export type ThreadTabsResponse = z.infer<typeof threadTabsResponseSchema>;
export type ThreadTabsWireResponse = z.input<typeof threadTabsResponseSchema>;

export const updateThreadTabsRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    tabs: threadTabsSchema,
  })
  .strict();
export type UpdateThreadTabsRequest = z.infer<
  typeof updateThreadTabsRequestSchema
>;
