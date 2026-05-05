import { replayRawProviderEventRecordSchema } from "@bb/replay-capture/schema";
import { fixtureManifestSchema } from "./corpus-schema.js";
import type { FixtureBundle } from "./types.js";

export interface ParseFixtureBundleFromJsonArgs {
  manifestJson: unknown;
  eventsNdjson: string;
}

interface ParseNdjsonLineArgs {
  line: string;
  lineNumber: number;
}

function parseNdjsonLine(args: ParseNdjsonLineArgs): unknown {
  try {
    return JSON.parse(args.line) as unknown;
  } catch {
    throw new Error(
      `Fixture raw provider event JSON is invalid on line ${args.lineNumber}`,
    );
  }
}

export function parseFixtureBundleFromJson(
  args: ParseFixtureBundleFromJsonArgs,
): FixtureBundle {
  const manifest = fixtureManifestSchema.parse(args.manifestJson);
  const rawProviderEventRecords = args.eventsNdjson
    .split(/\r?\n/u)
    .flatMap((line, index) => {
      if (line.trim().length === 0) {
        return [];
      }
      return [
        replayRawProviderEventRecordSchema.parse(
          parseNdjsonLine({ line, lineNumber: index + 1 }),
        ),
      ];
    });

  if (
    rawProviderEventRecords.length !== manifest.eventCounts.rawProviderEvents
  ) {
    throw new Error("Fixture raw provider event count mismatch");
  }

  return {
    manifest,
    rawProviderEventRecords,
    rawProviderEvents: rawProviderEventRecords.map((record) => record.entry),
  };
}
