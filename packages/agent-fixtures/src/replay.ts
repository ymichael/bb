import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { replayRawProviderEvents } from "@bb/agent-runtime";
import type {
  AgentRuntimeCaptureEntry,
  AgentRuntimeRawProviderEventCaptureEntry,
  AgentRuntimeTranslatedThreadEventCaptureEntry,
} from "@bb/agent-runtime/capture";
import { buildBundle, writeBundle } from "./capture.js";
import type { FixtureManifest } from "./corpus-schema.js";
import { defaultFixtureRoot, listFixtureBundles } from "./load.js";
import type {
  FixtureCorpusEntry,
  FixtureReplayArgs,
  FixtureReplayBundle,
  FixtureReplayResult,
  FixtureReplayResults,
} from "./types.js";

interface FixtureReplayCliParseResult {
  args: FixtureReplayArgs;
}

interface TranslateRawProviderEventsArgs {
  manifest: FixtureManifest;
  rawProviderEvents: AgentRuntimeRawProviderEventCaptureEntry[];
}

interface WithReplayOutputDirArgs {
  bundle: FixtureReplayBundle;
  outputRoot: string;
  fixture: FixtureCorpusEntry;
}

interface ReplayFixtureBundleArgs {
  fixture: FixtureCorpusEntry;
  outputRoot?: string;
}

function translateRawProviderEvents(
  args: TranslateRawProviderEventsArgs,
): AgentRuntimeTranslatedThreadEventCaptureEntry[] {
  return replayRawProviderEvents({
    bbThreadId: args.manifest.threadId,
    providerId: args.manifest.providerId,
    rawProviderEvents: args.rawProviderEvents,
  });
}

function withReplayOutputDir(
  args: WithReplayOutputDirArgs,
): FixtureReplayBundle {
  const outputDir = join(
    resolve(args.outputRoot),
    args.fixture.corpusId,
    args.fixture.providerId,
    args.fixture.taskId,
  );
  mkdirSync(outputDir, { recursive: true });
  return {
    ...args.bundle,
    outputDir,
  };
}

function replayFixtureBundle(
  args: ReplayFixtureBundleArgs,
): FixtureReplayResult {
  const translatedCaptures = translateRawProviderEvents({
    manifest: args.fixture.manifest,
    rawProviderEvents: args.fixture.rawProviderEvents,
  });
  const captures: AgentRuntimeCaptureEntry[] = [
    ...args.fixture.rawProviderEvents,
    ...translatedCaptures,
  ];

  const baseBundle = buildBundle({
    manifest: args.fixture.manifest,
    captures,
  });

  if (!args.outputRoot) {
    return {
      fixture: args.fixture,
      bundle: baseBundle,
    };
  }

  const outputBundle = withReplayOutputDir({
    bundle: baseBundle,
    outputRoot: args.outputRoot,
    fixture: args.fixture,
  });
  writeBundle(outputBundle);
  if (outputBundle.outputDir === null) {
    throw new Error("Replay output bundle was not assigned an outputDir");
  }
  return {
    fixture: args.fixture,
    bundle: outputBundle,
    outputDir: outputBundle.outputDir,
  };
}

export function replayFixtures(args: FixtureReplayArgs): FixtureReplayResults {
  const fixtureRoot = args.fixtureRoot
    ? resolve(args.fixtureRoot)
    : defaultFixtureRoot();
  const fixtures = listFixtureBundles({
    ...args,
    fixtureRoot,
  });
  return {
    fixtures: fixtures.map((fixture) =>
      replayFixtureBundle({
        fixture,
        outputRoot: args.outputRoot,
      }),
    ),
  };
}

export function parseFixtureReplayArgs(
  argv: string[],
): FixtureReplayCliParseResult {
  const args: FixtureReplayArgs = {
    fixtureRoot: defaultFixtureRoot(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--") {
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
    if (token === "--provider" && next) {
      args.providerId = next;
      index += 1;
      continue;
    }
    if (token === "--task" && next) {
      args.taskId = next;
      index += 1;
      continue;
    }
    if (token === "--output-root" && next) {
      args.outputRoot = resolve(next);
      index += 1;
    }
  }

  return { args };
}
