#!/usr/bin/env node

import { parseCliArgs, runProviderAuditCapture } from "./capture.js";
import {
  parseBuildReplayArtifactArgs,
  writeProviderAuditReplayBuildArtifacts,
} from "./build-artifacts.js";
import {
  importDevReplayFixtures,
  importFixtureCorpus,
  parseImportDevReplaysArgs,
  parseImportFixturesArgs,
} from "./fixtures.js";
import {
  parseReplayFixturesArgs,
  replayFixtures,
  summarizeReplayResults,
} from "./replay.js";
import {
  exportLadleStoryData,
  parseExportLadleDataArgs,
} from "./visual-audit.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "build-replay-artifact") {
    const { args } = parseBuildReplayArtifactArgs(argv.slice(1));
    const result = writeProviderAuditReplayBuildArtifacts(args);
    console.log(
      JSON.stringify(
        {
          artifactPath: result.artifactPath,
          fixtureCount: result.fixtureCount,
          ladleOutputPath: result.ladleOutputPath,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (argv[0] === "import-fixtures") {
    const { args } = parseImportFixturesArgs(argv.slice(1));
    const result = importFixtureCorpus(args);
    console.log(
      JSON.stringify(
        {
          corpusId: result.corpusId,
          fixtureCount: result.fixtures.length,
          fixtureRoot: result.fixtureRoot,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (argv[0] === "import-dev-replays") {
    const { args } = parseImportDevReplaysArgs(argv.slice(1));
    const result = importDevReplayFixtures(args);
    console.log(
      JSON.stringify(
        {
          corpusId: result.corpusId,
          fixtureCount: result.fixtures.length,
          fixtureRoot: result.fixtureRoot,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (argv[0] === "replay-fixtures") {
    const { args } = parseReplayFixturesArgs(argv.slice(1));
    const result = replayFixtures(args);
    console.log(JSON.stringify(summarizeReplayResults(result), null, 2));
    return;
  }
  if (argv[0] === "export-ladle-data") {
    const { args } = parseExportLadleDataArgs(argv.slice(1));
    const result = exportLadleStoryData(args);
    console.log(
      JSON.stringify(
        {
          fixtureCount: result.fixtureCount,
          outputPath: result.outputPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const args = parseCliArgs(argv);
  const result = await runProviderAuditCapture(args);
  console.log(result.outputDir);
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
