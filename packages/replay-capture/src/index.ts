import path from "node:path";
import { z } from "zod";
import {
  jsonRpcEnvelopeSchema,
  type JsonRpcEnvelope,
} from "@bb/agent-runtime/shared/json-rpc-envelope";
import {
  promptInputSchema,
  resolvedThreadExecutionOptionsSchema,
} from "@bb/domain";

export const REPLAY_CAPTURE_SCHEMA_VERSION = 2 as const;
export const REPLAY_CAPTURE_ID_PATTERN = /^cap_[0-9a-z]+_[0-9a-z]{8}$/u;
export const REPLAY_CAPTURE_ID_PATTERN_DESCRIPTION =
  "cap_<base36 timestamp>_<8 lowercase base36 chars>";
export const DEFAULT_REPLAY_CAPTURE_MAX_CAPTURES = 100;
export const REPLAY_CAPTURE_USER_INPUT_PREVIEW_MAX = 120;

export const replayCaptureKindSchema = z.enum(["thread-start", "turn-start"]);
export type ReplayCaptureKind = z.infer<typeof replayCaptureKindSchema>;

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

export const replayCaptureManifestSchema = z.object({
  schemaVersion: z.literal(REPLAY_CAPTURE_SCHEMA_VERSION),
  captureId: z.string().regex(REPLAY_CAPTURE_ID_PATTERN),
  capturedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  source: z.literal("live-dev-capture"),
  providerId: z.string().min(1),
  projectId: z.string().min(1),
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
  /** Null means the provider did not emit a provider thread identity before the capture was read/finalized. */
  providerThreadId: z.string().nullable(),
  turnIds: z.array(z.string()),
  title: z.string().nullable(),
  kind: replayCaptureKindSchema,
  userInput: z.array(promptInputSchema),
  userInputPreview: z.string(),
  execution: resolvedThreadExecutionOptionsSchema,
  eventCounts: z.object({
    rawProviderEvents: z.number().int().nonnegative(),
    droppedRecords: z.number().int().nonnegative(),
  }),
  errorMessage: z.string().nullable(),
});
export type ReplayCaptureManifest = z.infer<typeof replayCaptureManifestSchema>;

export const replayRawProviderEventRecordSchema = z.object({
  ordinal: z.number().int().positive(),
  relativeMs: z.number().int().nonnegative(),
  entry: replayRawProviderCaptureEntrySchema,
});
export type ReplayRawProviderEventRecord = z.infer<
  typeof replayRawProviderEventRecordSchema
>;

export function isReplayCaptureId(value: string): boolean {
  return REPLAY_CAPTURE_ID_PATTERN.test(value);
}

export function assertReplayCaptureId(value: string): void {
  if (!isReplayCaptureId(value)) {
    throw new Error(
      `Invalid replay capture id. Expected ${REPLAY_CAPTURE_ID_PATTERN_DESCRIPTION}`,
    );
  }
}

export function createReplayCaptureId(
  now: number,
  randomSuffix: string,
): string {
  const suffix = randomSuffix.toLowerCase();
  if (!/^[0-9a-z]{8}$/u.test(suffix)) {
    throw new Error(
      "Replay capture random suffix must be 8 lowercase base36 characters",
    );
  }
  return `cap_${now.toString(36)}_${suffix}`;
}

export function replayCaptureRoot(dataDir: string): string {
  return path.join(dataDir, "replays");
}

export function resolveContainedReplayCapturePath(args: {
  captureId?: string;
  dataDir: string;
  segments?: readonly string[];
}): string {
  const root = path.resolve(replayCaptureRoot(args.dataDir));
  const rawSegments = args.segments ?? [];
  const segments = args.captureId
    ? [args.captureId, ...rawSegments]
    : [...rawSegments];
  if (args.captureId) {
    assertReplayCaptureId(args.captureId);
  }
  const candidate = path.resolve(root, ...segments);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Replay capture path escapes replay root");
  }
  return candidate;
}

export function replayCaptureDir(dataDir: string, captureId: string): string {
  return resolveContainedReplayCapturePath({ dataDir, captureId });
}

export function replayCaptureManifestPath(
  dataDir: string,
  captureId: string,
): string {
  return resolveContainedReplayCapturePath({
    dataDir,
    captureId,
    segments: ["manifest.json"],
  });
}

export function replayRawProviderEventsPath(
  dataDir: string,
  captureId: string,
): string {
  return resolveContainedReplayCapturePath({
    dataDir,
    captureId,
    segments: ["raw-provider-events.ndjson"],
  });
}

export function replayCaptureIndexPath(dataDir: string): string {
  return resolveContainedReplayCapturePath({
    dataDir,
    segments: ["index.ndjson"],
  });
}

export function parseReplayCaptureManifest(
  value: unknown,
): ReplayCaptureManifest {
  return replayCaptureManifestSchema.parse(value);
}

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

