import { z } from "zod";
import {
  jsonRpcEnvelopeSchema,
  type JsonRpcEnvelope,
} from "@bb/agent-runtime/shared/json-rpc-envelope";
import {
  promptInputSchema,
  resolvedThreadExecutionOptionsSchema,
} from "@bb/domain";

export const REPLAY_CAPTURE_SCHEMA_VERSION = 3 as const;
export const REPLAY_CAPTURE_ID_PATTERN = /^cap_[0-9a-z]+_[0-9a-z]{8}$/u;
export const REPLAY_CAPTURE_ID_PATTERN_DESCRIPTION =
  "cap_<base36 timestamp>_<8 lowercase base36 chars>";
export const DEFAULT_REPLAY_CAPTURE_MAX_CAPTURES = 100;
export const REPLAY_CAPTURE_USER_INPUT_PREVIEW_MAX = 120;

export const replayCaptureKindSchema = z.enum(["thread-start", "turn-start"]);
export type ReplayCaptureKind = z.infer<typeof replayCaptureKindSchema>;

export const replayCaptureSourceSchema = z.enum([
  "live-dev-capture",
  "corpus-fixture",
]);
export type ReplayCaptureSource = z.infer<typeof replayCaptureSourceSchema>;

export const gitSnapshotSchema = z
  .object({
    headSha: z.string().nullable(),
    isClean: z.boolean(),
    statusLines: z.array(z.string()),
  })
  .strict();
export type GitSnapshot = z.infer<typeof gitSnapshotSchema>;

export const jsonRpcMessageSchema = z.custom<JsonRpcEnvelope>(
  (value) => jsonRpcEnvelopeSchema.safeParse(value).success,
  "Invalid JSON-RPC envelope",
);
export type ReplayJsonRpcMessage = JsonRpcEnvelope;

export const replayRawProviderCaptureEntrySchema = z.object({
  kind: z.literal("raw-provider-event"),
  capturedAt: z.number().int().nonnegative(),
  providerId: z.string().min(1),
  captureId: z.string().min(1),
  rawLine: z.string(),
  rawEvent: jsonRpcMessageSchema,
  sourceThreadId: z.string().optional(),
});
export type ReplayRawProviderCaptureEntry = z.infer<
  typeof replayRawProviderCaptureEntrySchema
>;

export const replayCaptureTurnSchema = z
  .object({
    turnId: z.string().min(1),
    userInput: z.array(promptInputSchema).min(1),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type ReplayCaptureTurn = z.infer<typeof replayCaptureTurnSchema>;

export const replayCaptureEventCountsSchema = z
  .object({
    rawProviderEvents: z.number().int().nonnegative(),
    droppedRecords: z.number().int().nonnegative(),
  })
  .strict();
export type ReplayCaptureEventCounts = z.infer<
  typeof replayCaptureEventCountsSchema
>;

export const replayCaptureManifestSchema = z
  .object({
    schemaVersion: z.literal(REPLAY_CAPTURE_SCHEMA_VERSION),
    captureId: z.string().regex(REPLAY_CAPTURE_ID_PATTERN),
    capturedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().nullable(),
    source: replayCaptureSourceSchema,
    providerId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    threadId: z.string().min(1),
    /** Null means the provider did not emit a provider thread identity before the capture was read/finalized. */
    providerThreadId: z.string().nullable(),
    title: z.string().nullable(),
    kind: replayCaptureKindSchema,
    turns: z.array(replayCaptureTurnSchema).min(1),
    userInputPreview: z.string(),
    execution: resolvedThreadExecutionOptionsSchema,
    eventCounts: replayCaptureEventCountsSchema,
    errorMessage: z.string().nullable(),
  })
  .strict();
export type ReplayCaptureManifest = z.infer<typeof replayCaptureManifestSchema>;

export const replayCaptureSummarySchema = replayCaptureManifestSchema.pick({
  captureId: true,
  capturedAt: true,
  completedAt: true,
  providerId: true,
  projectId: true,
  environmentId: true,
  threadId: true,
  title: true,
  kind: true,
  userInputPreview: true,
  execution: true,
  eventCounts: true,
  errorMessage: true,
});
export type ReplayCaptureSummary = z.infer<typeof replayCaptureSummarySchema>;

export const replayCaptureHostSummarySchema = replayCaptureSummarySchema.extend(
  {
    hostId: z.string().min(1),
    projectName: z.string().nullable(),
  },
);
export type ReplayCaptureHostSummary = z.infer<
  typeof replayCaptureHostSummarySchema
>;

export const replayCaptureDaemonListResponseSchema = z.object({
  captures: z.array(replayCaptureSummarySchema),
});
export type ReplayCaptureDaemonListResponse = z.infer<
  typeof replayCaptureDaemonListResponseSchema
>;

export const replayCaptureDetailSchema = replayCaptureManifestSchema.extend({
  hostId: z.string().min(1),
  projectName: z.string().nullable(),
});
export type ReplayCaptureDetail = z.infer<typeof replayCaptureDetailSchema>;

export const replayCaptureListResponseSchema = z.object({
  captures: z.array(replayCaptureHostSummarySchema),
});
export type ReplayCaptureListResponse = z.infer<
  typeof replayCaptureListResponseSchema
>;

export const replaySpeedSchema = z.union([
  z.literal(0.5),
  z.literal(1),
  z.literal(2),
  z.literal(5),
  z.literal(10),
]);
export type ReplayRunSpeed = z.infer<typeof replaySpeedSchema>;

export const replayRunRequestSchema = z
  .object({
    speed: replaySpeedSchema,
  })
  .strict();
export type ReplayRunRequest = z.infer<typeof replayRunRequestSchema>;

export const replayRunResponseSchema = z.object({
  commandId: z.string(),
  replayThreadId: z.string(),
  projectId: z.string(),
});
export type ReplayRunResponse = z.infer<typeof replayRunResponseSchema>;

export const replayRawProviderEventRecordSchema = z.object({
  ordinal: z.number().int().positive(),
  relativeMs: z.number().int().nonnegative(),
  entry: replayRawProviderCaptureEntrySchema,
});
export type ReplayRawProviderEventRecord = z.infer<
  typeof replayRawProviderEventRecordSchema
>;
