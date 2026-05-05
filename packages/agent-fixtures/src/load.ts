import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fixtureManifestSchema,
  type FixtureManifest,
} from "./corpus-schema.js";
import { parseFixtureBundleFromJson } from "./load-browser.js";
import type { FixtureCorpusEntry } from "./types.js";

const DEFAULT_FIXTURE_ROOT = resolve(
  fileURLToPath(new URL("../fixtures", import.meta.url)),
);

export interface ReadFixtureManifestArgs {
  manifestPath: string;
}

export interface ReadFixtureBundleArgs {
  corpusId: string;
  fixturePath: string;
  providerId: string;
  taskId: string;
}

interface LoadFixtureBundleArgs {
  fixtureRoot: string;
  corpusId: string;
  providerId: string;
  taskId: string;
}

interface FixtureListFilterArgs {
  fixtureRoot: string;
  corpusId?: string;
  providerId?: string;
  taskId?: string;
}

export function defaultFixtureRoot(): string {
  return DEFAULT_FIXTURE_ROOT;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readDirNames(path: string): string[] {
  return readdirSync(path)
    .filter((entry) => entry.startsWith(".") === false)
    .sort((left, right) => left.localeCompare(right));
}

export function readFixtureManifest(
  args: ReadFixtureManifestArgs,
): FixtureManifest {
  const parsed = JSON.parse(readFileSync(args.manifestPath, "utf8")) as unknown;
  return fixtureManifestSchema.parse(parsed);
}

export function readFixtureBundle(
  args: ReadFixtureBundleArgs,
): FixtureCorpusEntry {
  const manifestPath = join(args.fixturePath, "manifest.json");
  const rawProviderEventsPath = join(
    args.fixturePath,
    "raw-provider-events.ndjson",
  );
  const bundle = parseFixtureBundleFromJson({
    manifestJson: JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    eventsNdjson: readFileSync(rawProviderEventsPath, "utf8"),
  });
  if (
    bundle.manifest.corpusId !== args.corpusId ||
    bundle.manifest.providerId !== args.providerId
  ) {
    throw new Error(
      `Fixture manifest does not match path: ${args.fixturePath}`,
    );
  }

  return {
    ...bundle,
    corpusId: args.corpusId,
    providerId: args.providerId,
    taskId: args.taskId,
    fixturePath: args.fixturePath,
    manifestPath,
    rawProviderEventsPath,
  };
}

function loadFixtureBundle(args: LoadFixtureBundleArgs): FixtureCorpusEntry {
  const fixturePath = join(
    args.fixtureRoot,
    args.corpusId,
    args.providerId,
    args.taskId,
  );
  return readFixtureBundle({
    corpusId: args.corpusId,
    providerId: args.providerId,
    taskId: args.taskId,
    fixturePath,
  });
}

export function listFixtureBundles(
  args: FixtureListFilterArgs,
): FixtureCorpusEntry[] {
  const fixtureRoot = resolve(args.fixtureRoot);
  if (!isDirectory(fixtureRoot)) {
    return [];
  }

  const corpusIds =
    args.corpusId !== undefined
      ? [args.corpusId]
      : readDirNames(fixtureRoot).filter((entry) =>
          isDirectory(join(fixtureRoot, entry)),
        );

  const fixtures: FixtureCorpusEntry[] = [];

  for (const corpusId of corpusIds) {
    const corpusPath = join(fixtureRoot, corpusId);
    if (!isDirectory(corpusPath)) {
      continue;
    }
    const providerIds =
      args.providerId !== undefined
        ? [args.providerId]
        : readDirNames(corpusPath).filter((entry) =>
            isDirectory(join(corpusPath, entry)),
          );

    for (const providerId of providerIds) {
      const providerPath = join(corpusPath, providerId);
      if (!isDirectory(providerPath)) {
        continue;
      }
      const taskIds =
        args.taskId !== undefined
          ? [args.taskId]
          : readDirNames(providerPath).filter((entry) =>
              isDirectory(join(providerPath, entry)),
            );

      for (const taskId of taskIds) {
        const taskPath = join(providerPath, taskId);
        if (!isDirectory(taskPath)) {
          continue;
        }
        fixtures.push(
          loadFixtureBundle({
            fixtureRoot,
            corpusId,
            providerId,
            taskId,
          }),
        );
      }
    }
  }

  return fixtures.sort((left, right) => {
    if (left.corpusId !== right.corpusId) {
      return left.corpusId.localeCompare(right.corpusId);
    }
    if (left.providerId !== right.providerId) {
      return left.providerId.localeCompare(right.providerId);
    }
    return left.taskId.localeCompare(right.taskId);
  });
}
