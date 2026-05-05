import path from "node:path";
import { z } from "zod";
import {
  REPLAY_CAPTURE_ID_PATTERN,
  REPLAY_CAPTURE_ID_PATTERN_DESCRIPTION,
  replayCaptureManifestSchema,
  type ReplayCaptureManifest,
  type ReplayCaptureTurn,
} from "./schema.js";

export * from "./schema.js";

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

export function createReplayCapturePlaceholderTurnId(
  captureId: string,
): string {
  return `replay:${captureId}`;
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

export function getReplayCaptureInitialTurn(
  manifest: ReplayCaptureManifest,
): ReplayCaptureTurn {
  const turn = manifest.turns[0];
  if (!turn) {
    throw new Error("Replay capture manifest has no turns");
  }
  return turn;
}

export function getReplayCaptureTerminalTurnId(
  manifest: ReplayCaptureManifest,
): string {
  const turn = manifest.turns.at(-1);
  if (!turn) {
    throw new Error("Replay capture manifest has no turns");
  }
  return turn.turnId;
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
