import { createReadStream } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  isReplayCaptureId,
  replayCaptureDir,
  replayCaptureManifestPath,
  replayCaptureManifestSchema,
  replayCaptureRoot,
  replayRawProviderEventsPath,
  replayRawProviderEventRecordSchema,
  type ReplayCaptureManifest,
  type ReplayCaptureSummary,
  type ReplayRawProviderEventRecord,
} from "./index.js";

export type ReplayCaptureReadErrorCode =
  | "invalid_replay_capture"
  | "replay_capture_not_found";

export class ReplayCaptureReadError extends Error {
  constructor(
    readonly code: ReplayCaptureReadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReplayCaptureReadError";
  }
}

export interface ReplayCaptureReadArgs {
  captureId: string;
  dataDir: string;
}

interface StreamNdjsonRecordsArgs<TRecord extends { relativeMs: number }> {
  filePath: string;
  parse: (value: unknown) => TRecord;
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}

function requireCaptureId(captureId: string): void {
  if (!isReplayCaptureId(captureId)) {
    throw new ReplayCaptureReadError(
      "invalid_replay_capture",
      "Invalid replay capture id",
    );
  }
}

async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    throw new ReplayCaptureReadError(
      "replay_capture_not_found",
      `Replay capture file not found: ${filePath}`,
    );
  }
}

async function pathIsDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function requireReplayCaptureFile(
  filePath: string,
): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    throw new ReplayCaptureReadError(
      "replay_capture_not_found",
      `Replay capture file not found: ${filePath}`,
    );
  }
}

function parseJsonText(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new ReplayCaptureReadError(
      "invalid_replay_capture",
      `Invalid replay capture JSON: ${label}`,
    );
  }
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new ReplayCaptureReadError(
      "invalid_replay_capture",
      `Invalid replay capture JSON on line ${lineNumber}`,
    );
  }
}

async function* streamNdjsonRecords<TRecord extends { relativeMs: number }>(
  args: StreamNdjsonRecordsArgs<TRecord>,
): AsyncGenerator<TRecord> {
  const lines = createInterface({
    input: createReadStream(args.filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let previousRelativeMs = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) {
        continue;
      }
      const record = args.parse(parseJsonLine(line, lineNumber));
      if (record.relativeMs < previousRelativeMs) {
        throw new ReplayCaptureReadError(
          "invalid_replay_capture",
          `Replay capture relativeMs decreased at record ${lineNumber}`,
        );
      }
      previousRelativeMs = record.relativeMs;
      yield record;
    }
  } catch (error) {
    if (error instanceof ReplayCaptureReadError) {
      throw error;
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ReplayCaptureReadError(
        "replay_capture_not_found",
        `Replay capture file not found: ${args.filePath}`,
      );
    }
    throw error;
  }
}

function parseManifest(value: unknown): ReplayCaptureManifest {
  const result = replayCaptureManifestSchema.safeParse(value);
  if (!result.success) {
    throw new ReplayCaptureReadError(
      "invalid_replay_capture",
      "Replay capture manifest is invalid",
    );
  }
  return result.data;
}

function parseRawProviderRecord(value: unknown): ReplayRawProviderEventRecord {
  const result = replayRawProviderEventRecordSchema.safeParse(value);
  if (!result.success) {
    throw new ReplayCaptureReadError(
      "invalid_replay_capture",
      "Replay raw provider event record is invalid",
    );
  }
  return result.data;
}

export async function readReplayCaptureManifest(
  args: ReplayCaptureReadArgs,
): Promise<ReplayCaptureManifest> {
  requireCaptureId(args.captureId);
  const manifestPath = replayCaptureManifestPath(args.dataDir, args.captureId);
  const content = await readText(manifestPath);
  return parseManifest(parseJsonText(content, manifestPath));
}

function toSummary(manifest: ReplayCaptureManifest): ReplayCaptureSummary {
  return {
    captureId: manifest.captureId,
    capturedAt: manifest.capturedAt,
    completedAt: manifest.completedAt,
    providerId: manifest.providerId,
    projectId: manifest.projectId,
    environmentId: manifest.environmentId,
    threadId: manifest.threadId,
    title: manifest.title,
    kind: manifest.kind,
    userInputPreview: manifest.userInputPreview,
    execution: manifest.execution,
    eventCounts: manifest.eventCounts,
    errorMessage: manifest.errorMessage,
  };
}

export async function listReplayCaptureSummaries(
  dataDir: string,
): Promise<ReplayCaptureSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(replayCaptureRoot(dataDir));
  } catch {
    return [];
  }

  const captures: ReplayCaptureSummary[] = [];
  for (const entry of entries) {
    if (!isReplayCaptureId(entry)) {
      continue;
    }
    if (!(await pathIsDirectory(replayCaptureDir(dataDir, entry)))) {
      continue;
    }
    try {
      captures.push(
        toSummary(
          await readReplayCaptureManifest({
            captureId: entry,
            dataDir,
          }),
        ),
      );
    } catch {
      continue;
    }
  }

  return captures.sort((left, right) => right.capturedAt - left.capturedAt);
}

export async function* streamRawProviderRecords(
  args: ReplayCaptureReadArgs,
): AsyncGenerator<ReplayRawProviderEventRecord> {
  requireCaptureId(args.captureId);
  yield* streamNdjsonRecords({
    filePath: replayRawProviderEventsPath(args.dataDir, args.captureId),
    parse: parseRawProviderRecord,
  });
}

export async function deleteReplayCapture(
  args: ReplayCaptureReadArgs,
): Promise<void> {
  requireCaptureId(args.captureId);
  const dir = replayCaptureDir(args.dataDir, args.captureId);
  if (!(await pathIsDirectory(dir))) {
    throw new ReplayCaptureReadError(
      "replay_capture_not_found",
      `Replay capture not found: ${args.captureId}`,
    );
  }
  await rm(dir, { force: true, recursive: true });
}
