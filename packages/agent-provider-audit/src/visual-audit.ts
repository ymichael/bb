import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replayFixtures } from "./replay.js";
import type {
  ProviderAuditBuildLadleStoryDataArgs,
  ProviderAuditExportLadleDataArgs,
  ProviderAuditExportLadleDataResult,
  ProviderAuditExportLadleStoryDataArgs,
  ProviderAuditLadleFixture,
  ProviderAuditLadleStoryData,
  ProviderAuditReplayFixtureResult,
} from "./types.js";

interface ProviderAuditVisualCliParseResult {
  args: ProviderAuditExportLadleDataArgs;
}

const DEFAULT_FIXTURE_ROOT = resolve(
  fileURLToPath(new URL("../fixtures", import.meta.url)),
);

export const DEFAULT_LADLE_OUTPUT_PATH = resolve(
  fileURLToPath(new URL("../.ladle/fixture-story-data.ts", import.meta.url)),
);

function toLadleFixture(
  replayedFixture: ProviderAuditReplayFixtureResult,
): ProviderAuditLadleFixture {
  return {
    id: `${replayedFixture.fixture.corpusId}/${replayedFixture.fixture.providerId}/${replayedFixture.fixture.taskId}`,
    corpusId: replayedFixture.fixture.corpusId,
    providerId: replayedFixture.fixture.providerId,
    taskId: replayedFixture.fixture.taskId,
    scenarioDescription: replayedFixture.fixture.manifest.scenarioDescription,
    threadStatus: "idle",
    timelineRowCount: replayedFixture.bundle.timelineRows.length,
    timelineRows: replayedFixture.bundle.timelineRows,
  };
}

export function buildLadleStoryData(
  args: ProviderAuditExportLadleDataArgs,
): ProviderAuditLadleStoryData {
  const replayed = replayFixtures(args);
  return buildLadleStoryDataFromReplay({ replayed });
}

export function buildLadleStoryDataFromReplay(
  args: ProviderAuditBuildLadleStoryDataArgs,
): ProviderAuditLadleStoryData {
  return {
    fixtures: args.replayed.fixtures.map((fixture) => toLadleFixture(fixture)),
  };
}

function serializeLadleStoryDataModule(
  data: ProviderAuditLadleStoryData,
): string {
  return [
    'import type { ProviderAuditLadleStoryData } from "../src/types.js";',
    "",
    `export const fixtureStoryData = ${JSON.stringify(data, null, 2)} satisfies ProviderAuditLadleStoryData;`,
    "",
  ].join("\n");
}

export function exportLadleStoryData(
  args: ProviderAuditExportLadleDataArgs,
): ProviderAuditExportLadleDataResult {
  const storyData = buildLadleStoryData(args);
  return exportLadleStoryDataFromStoryData({
    outputPath: args.outputPath,
    storyData,
  });
}

export function exportLadleStoryDataFromStoryData(
  args: ProviderAuditExportLadleStoryDataArgs,
): ProviderAuditExportLadleDataResult {
  const outputPath = resolve(args.outputPath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeLadleStoryDataModule(args.storyData));
  return {
    fixtureCount: args.storyData.fixtures.length,
    outputPath,
  };
}

export function parseExportLadleDataArgs(
  argv: string[],
): ProviderAuditVisualCliParseResult {
  const args: ProviderAuditExportLadleDataArgs = {
    fixtureRoot: DEFAULT_FIXTURE_ROOT,
    outputPath: DEFAULT_LADLE_OUTPUT_PATH,
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
    if (token === "--output" && next) {
      args.outputPath = resolve(next);
      index += 1;
    }
  }

  return { args };
}
