#!/usr/bin/env node

import { parseCliArgs, runFixtureCapture } from "./capture.js";
import {
  parsePromoteCaptureArgs,
  promoteCaptureFromCliArgs,
} from "./promote.js";
import { parseFixtureReplayArgs, replayFixtures } from "./replay.js";
import type { FixtureReplayResults } from "./types.js";

interface ReplaySummaryRow {
  corpusId: string;
  providerId: string;
  taskId: string;
  rawProviderEventCount: number;
  translatedThreadEventCount: number;
  timelineRowCount: number;
}

function buildReplaySummaryRows(
  result: FixtureReplayResults,
): ReplaySummaryRow[] {
  return result.fixtures.map(({ fixture, bundle }) => ({
    corpusId: fixture.corpusId,
    providerId: fixture.providerId,
    taskId: fixture.taskId,
    rawProviderEventCount: bundle.rawProviderEvents.length,
    translatedThreadEventCount: bundle.translatedCaptures.length,
    timelineRowCount: bundle.timelineRows.length,
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "capture") {
    const args = parseCliArgs(argv.slice(1));
    const result = await runFixtureCapture(args);
    console.log(result.outputDir);
    return;
  }

  if (command === "replay") {
    const { args } = parseFixtureReplayArgs(argv.slice(1));
    const result = replayFixtures(args);
    console.log(JSON.stringify(buildReplaySummaryRows(result), null, 2));
    return;
  }

  if (command === "promote") {
    const { args } = parsePromoteCaptureArgs(argv.slice(1));
    const result = await promoteCaptureFromCliArgs(args);
    console.log(
      JSON.stringify(
        {
          destDir: result.destDir,
          captureId: result.manifest.captureId,
          providerId: result.manifest.providerId,
        },
        null,
        2,
      ),
    );
    return;
  }

  throw new Error(
    command
      ? `Unknown bb-fixtures command: ${command}`
      : "Expected bb-fixtures command: capture, replay, or promote",
  );
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
