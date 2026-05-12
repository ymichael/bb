import path from "node:path";
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
