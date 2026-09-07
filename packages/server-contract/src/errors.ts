import { z } from "zod";
import {
  environmentStatusSchema,
  hostStatusSchema,
  pluginIdSchema,
  threadStatusSchema,
} from "@bb/domain";

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
  retryable: z.boolean().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const environmentNotReadyErrorDetailsSchema = z.object({
  environmentStatus: environmentStatusSchema,
  hasPath: z.boolean(),
});
export type EnvironmentNotReadyErrorDetails = z.infer<
  typeof environmentNotReadyErrorDetailsSchema
>;

export const threadNotWritableReasonSchema = z.enum([
  "archived",
  "stopping",
  "deleted",
  "not_started",
  "not_active",
  "errored",
  "already_active",
  "still_starting",
]);
export type ThreadNotWritableReason = z.infer<
  typeof threadNotWritableReasonSchema
>;

export const threadNotWritableErrorDetailsSchema = z.object({
  reason: threadNotWritableReasonSchema,
  archivedAt: z.number().int().nonnegative().nullable(),
  threadStatus: threadStatusSchema,
});
export type ThreadNotWritableErrorDetails = z.infer<
  typeof threadNotWritableErrorDetailsSchema
>;

export const threadEnvironmentUnavailableReasonSchema = z.enum([
  "never_attached",
  "destroyed",
  "destroying",
  "provisioning",
  "errored",
]);

export const threadEnvironmentUnavailableErrorDetailsSchema = z.object({
  reason: threadEnvironmentUnavailableReasonSchema,
  environmentStatus: environmentStatusSchema.nullable(),
});
export type ThreadEnvironmentUnavailableErrorDetails = z.infer<
  typeof threadEnvironmentUnavailableErrorDetailsSchema
>;

export const hostUnavailableReasonSchema = z.enum([
  "suspended",
  "disconnected",
  "destroyed",
]);

export const hostUnavailableErrorDetailsSchema = z.object({
  reason: hostUnavailableReasonSchema,
  hostStatus: hostStatusSchema.nullable(),
  suspendedAt: z.number().int().nonnegative().nullable(),
  destroyedAt: z.number().int().nonnegative().nullable(),
});
export type HostUnavailableErrorDetails = z.infer<
  typeof hostUnavailableErrorDetailsSchema
>;

export const projectUnavailableReasonSchema = z.enum([
  "deleted",
  "pending_deletion",
]);

export const projectUnavailableErrorDetailsSchema = z.object({
  reason: projectUnavailableReasonSchema,
  deletedAt: z.number().int().nonnegative().nullable(),
});
export type ProjectUnavailableErrorDetails = z.infer<
  typeof projectUnavailableErrorDetailsSchema
>;

export const parentThreadInvalidReasonSchema = z.enum([
  "not_found",
  "archived",
  "deleted",
  "self",
  "cycle",
  "too_deep",
]);
export type ParentThreadInvalidReason = z.infer<
  typeof parentThreadInvalidReasonSchema
>;

export const parentThreadInvalidSubjectSchema = z.enum(["parent", "sender"]);
export type ParentThreadInvalidSubject = z.infer<
  typeof parentThreadInvalidSubjectSchema
>;

export const parentThreadInvalidErrorDetailsSchema = z.object({
  reason: parentThreadInvalidReasonSchema,
  subject: parentThreadInvalidSubjectSchema,
});
export type ParentThreadInvalidErrorDetails = z.infer<
  typeof parentThreadInvalidErrorDetailsSchema
>;

/** Which plugin's `message.dispatch` hook ended the dispatch. Shared by the
 *  hook's `reject` decision (409) and its fail-closed failure (502): both name
 *  the same plugin, so the client can attribute either one without guessing. */
export const dispatchHookErrorDetailsSchema = z.object({
  pluginId: pluginIdSchema,
});
export type DispatchHookErrorDetails = z.infer<
  typeof dispatchHookErrorDetailsSchema
>;

export const environmentNotReadyApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("environment_not_ready"),
  details: environmentNotReadyErrorDetailsSchema,
});

export const threadNotWritableApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("thread_not_writable"),
  details: threadNotWritableErrorDetailsSchema,
});

export const threadEnvironmentUnavailableApiErrorSchema = apiErrorSchema.extend(
  {
    code: z.literal("thread_environment_unavailable"),
    details: threadEnvironmentUnavailableErrorDetailsSchema,
  },
);

export const hostUnavailableApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("host_unavailable"),
  details: hostUnavailableErrorDetailsSchema,
});

export const projectUnavailableApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("project_unavailable"),
  details: projectUnavailableErrorDetailsSchema,
});

export const parentThreadInvalidApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("parent_thread_invalid"),
  details: parentThreadInvalidErrorDetailsSchema,
});

export const dispatchRejectedApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("dispatch_rejected"),
  details: dispatchHookErrorDetailsSchema,
});

export const dispatchHookFailedApiErrorSchema = apiErrorSchema.extend({
  code: z.literal("dispatch_hook_failed"),
  details: dispatchHookErrorDetailsSchema,
});

export const lifecycleApiErrorSchema = z.discriminatedUnion("code", [
  environmentNotReadyApiErrorSchema,
  threadNotWritableApiErrorSchema,
  threadEnvironmentUnavailableApiErrorSchema,
  hostUnavailableApiErrorSchema,
  projectUnavailableApiErrorSchema,
  parentThreadInvalidApiErrorSchema,
  dispatchRejectedApiErrorSchema,
  dispatchHookFailedApiErrorSchema,
]);
export type LifecycleApiError = z.infer<typeof lifecycleApiErrorSchema>;
