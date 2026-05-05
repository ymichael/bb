import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertReplayCaptureId,
  getReplayCaptureInitialTurn,
} from "@bb/replay-capture";
import {
  replayCaptureManifestSchema,
  type ReplayCaptureManifest,
} from "@bb/replay-capture/schema";
import {
  readManifestSync,
  readRawProviderRecordsFile,
} from "@bb/replay-capture/reader";
import { fixtureManifestSchema } from "./corpus-schema.js";
import type {
  CorpusContext,
  PromoteCaptureCliArgs,
  PromoteCaptureToFixtureArgs,
  PromoteCaptureToFixtureResult,
} from "./types.js";

const DEFAULT_DEV_REPLAY_CORPUS_ID = "dev-replays";
const BB_DEV_WORKSPACE_PLACEHOLDER = "$BB_DEV_WORKSPACE";

interface PromoteCaptureCliParseResult {
  args: PromoteCaptureCliArgs;
}

interface ResolveFixtureDestinationArgs {
  context: CorpusContext;
  providerId: string;
}

interface ReplayCapturePaths {
  manifestPath: string;
  rawProviderEventsPath: string;
}

interface ReplayCapturePathArgs {
  captureId: string;
  replayRoot: string;
}

function getHomeDir(): string | null {
  const homeDir = process.env.HOME;
  return homeDir && homeDir.length > 0 ? homeDir : null;
}

function getDefaultReplayRoot(): string {
  const homeDir = getHomeDir();
  if (homeDir) {
    return join(homeDir, ".bb-dev", "replays");
  }
  return resolve(".bb-dev", "replays");
}

function buildScenarioDescription(manifest: ReplayCaptureManifest): string {
  const preview = manifest.userInputPreview.trim();
  if (preview.length > 0) {
    return preview;
  }
  return getReplayCaptureInitialTurn(manifest).turnId;
}

function assertSafePathSegment(label: string, value: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function resolveFixtureDestination(
  args: ResolveFixtureDestinationArgs,
): string {
  assertSafePathSegment("corpus id", args.context.corpusId);
  assertSafePathSegment("provider id", args.providerId);
  assertSafePathSegment("task id", args.context.taskId);

  const fixtureRoot = resolve(args.context.fixtureRoot);
  const candidate = resolve(
    fixtureRoot,
    args.context.corpusId,
    args.providerId,
    args.context.taskId,
  );
  const relativePath = relative(fixtureRoot, candidate);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error("Fixture destination escapes fixture root");
  }
  return candidate;
}

function replayCapturePaths(args: ReplayCapturePathArgs): ReplayCapturePaths {
  assertReplayCaptureId(args.captureId);
  const captureDir = resolve(args.replayRoot, args.captureId);
  const replayRoot = resolve(args.replayRoot);
  const relativeCaptureDir = relative(replayRoot, captureDir);
  if (
    relativeCaptureDir === "" ||
    relativeCaptureDir === ".." ||
    relativeCaptureDir.startsWith(`..${sep}`)
  ) {
    throw new Error("Replay capture path escapes replay root");
  }
  return {
    manifestPath: join(captureDir, "manifest.json"),
    rawProviderEventsPath: join(captureDir, "raw-provider-events.ndjson"),
  };
}

export function parsePromoteCaptureArgs(
  argv: string[],
): PromoteCaptureCliParseResult {
  const args: PromoteCaptureCliArgs = {
    captureId: "",
    replayRoot: getDefaultReplayRoot(),
    fixtureRoot: resolve(
      fileURLToPath(new URL("../fixtures", import.meta.url)),
    ),
    corpusId: DEFAULT_DEV_REPLAY_CORPUS_ID,
    taskId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--") {
      continue;
    }
    if (token === "--replay-root" && next) {
      args.replayRoot = resolve(next);
      index += 1;
      continue;
    }
    if (token === "--fixture-root" && next) {
      args.fixtureRoot = resolve(next);
      index += 1;
      continue;
    }
    if (token === "--corpus-id" && next) {
      args.corpusId = next;
      index += 1;
      continue;
    }
    if (token === "--task-id" && next) {
      args.taskId = next;
      index += 1;
      continue;
    }
    if (!token.startsWith("--") && args.captureId.length === 0) {
      args.captureId = token;
    }
  }

  if (args.captureId.length === 0) {
    throw new Error("A replay capture id is required");
  }

  return { args };
}

export async function promoteCaptureFromCliArgs(
  args: PromoteCaptureCliArgs,
): Promise<PromoteCaptureToFixtureResult> {
  const paths = replayCapturePaths({
    captureId: args.captureId,
    replayRoot: args.replayRoot,
  });
  const manifest = readManifestSync({
    manifestPath: paths.manifestPath,
    schema: replayCaptureManifestSchema,
  });
  return promoteCaptureToFixture({
    captureId: args.captureId,
    replayRoot: args.replayRoot,
    corpusContext: {
      fixtureRoot: args.fixtureRoot,
      corpusId: args.corpusId,
      taskId: args.taskId ?? args.captureId,
      scenarioId: args.taskId ?? args.captureId,
      scenarioDescription: buildScenarioDescription(manifest),
      model: manifest.execution.model,
      gitSha: null,
      gitResetRef: null,
      workspacePath: BB_DEV_WORKSPACE_PLACEHOLDER,
      runtimeWorkspacePath: BB_DEV_WORKSPACE_PLACEHOLDER,
      envWorkspacePath: BB_DEV_WORKSPACE_PLACEHOLDER,
      runtimeWorkspaceGitStart: null,
      runtimeWorkspaceGitEnd: null,
    },
  });
}

export async function promoteCaptureToFixture(
  args: PromoteCaptureToFixtureArgs,
): Promise<PromoteCaptureToFixtureResult> {
  const paths = replayCapturePaths(args);
  const baseManifest = readManifestSync({
    manifestPath: paths.manifestPath,
    schema: replayCaptureManifestSchema,
  });
  const rawProviderEventRecords = readRawProviderRecordsFile({
    filePath: paths.rawProviderEventsPath,
  });
  const destDir = resolveFixtureDestination({
    context: args.corpusContext,
    providerId: baseManifest.providerId,
  });
  const manifest = fixtureManifestSchema.parse({
    ...baseManifest,
    source: "corpus-fixture",
    corpusId: args.corpusContext.corpusId,
    scenarioId: args.corpusContext.scenarioId,
    scenarioDescription: args.corpusContext.scenarioDescription,
    model: args.corpusContext.model,
    gitSha: args.corpusContext.gitSha,
    gitResetRef: args.corpusContext.gitResetRef,
    workspacePath: args.corpusContext.workspacePath,
    runtimeWorkspacePath: args.corpusContext.runtimeWorkspacePath,
    envWorkspacePath: args.corpusContext.envWorkspacePath,
    runtimeWorkspaceGitStart: args.corpusContext.runtimeWorkspaceGitStart,
    runtimeWorkspaceGitEnd: args.corpusContext.runtimeWorkspaceGitEnd,
    eventCounts: {
      ...baseManifest.eventCounts,
      rawProviderEvents: rawProviderEventRecords.length,
    },
  });

  await mkdir(destDir, { recursive: true });
  await Promise.all([
    writeFile(
      join(destDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
    copyFile(
      paths.rawProviderEventsPath,
      join(destDir, "raw-provider-events.ndjson"),
    ),
  ]);

  return {
    destDir,
    manifest,
  };
}
