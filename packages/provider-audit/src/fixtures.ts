import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntimeCaptureEntry } from "@bb/agent-runtime";
import { z } from "zod";
import {
  providerAuditClientRequestSchema,
  providerAuditManifestSchema,
  providerAuditRawProviderEventCaptureEntrySchema,
  readJsonFile,
} from "./json-file.js";
import type {
  ProviderAuditClientRequest,
  ProviderAuditImportFixtureResult,
  ProviderAuditImportFixturesArgs,
  ProviderAuditImportFixturesResult,
  ProviderAuditManifest,
} from "./types.js";

const DEFAULT_CORPUS_ID = "excalidraw";
const DEFAULT_FIXTURE_ROOT = resolve(
  fileURLToPath(new URL("../fixtures", import.meta.url)),
);

const FIXTURE_FILE_NAMES = [
  "manifest.json",
  "client-requests.json",
  "raw-provider-events.json",
] as const;

interface ProviderAuditFixtureCliParseResult {
  args: ProviderAuditImportFixturesArgs;
}

interface ProviderAuditFixtureBundlePaths {
  bundleDir: string;
  manifestPath: string;
  clientRequestsPath: string;
  rawProviderEventsPath: string;
}

interface ProviderAuditFixturePathSanitization {
  homeDir: string | null;
  workspacePath: string;
  outputDir: string;
}

interface ProviderAuditFixtureImportBundleArgs {
  bundlePaths: ProviderAuditFixtureBundlePaths;
  corpusId: string;
  fixtureCorpusRoot: string;
}

interface ResolveFixtureCorpusRootArgs {
  corpusId: string;
  fixtureRoot: string;
}

function getHomeDir(): string | null {
  const homeDir = process.env.HOME;
  return homeDir && homeDir.length > 0 ? homeDir : null;
}

function writeJsonFile(filePath: string, value: object): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function resolveFixtureCorpusRoot(
  args: ResolveFixtureCorpusRootArgs,
): string {
  const fixtureRoot = resolve(args.fixtureRoot);
  const candidate = resolve(fixtureRoot, args.corpusId);
  const relativePath = relative(fixtureRoot, candidate);
  const escapesFixtureRoot =
    relativePath === ".." || relativePath.startsWith(`..${sep}`);
  if (escapesFixtureRoot) {
    throw new Error(`Invalid corpus id: ${args.corpusId}`);
  }
  return candidate;
}

function normalizeTaskId(args: {
  corpusId: string;
  scenarioId: string;
}): string {
  const prefix = `${args.corpusId}-`;
  if (args.scenarioId.startsWith(prefix)) {
    return args.scenarioId.slice(prefix.length);
  }
  return args.scenarioId;
}

function sanitizeTextContent(
  content: string,
  sanitization: ProviderAuditFixturePathSanitization,
): string {
  const replacements: Array<{ from: string; to: string }> = [
    {
      from: sanitization.workspacePath,
      to: "$EXCALIDRAW_REPO",
    },
    {
      from: sanitization.outputDir,
      to: "$CAPTURE_OUTPUT",
    },
  ];

  if (sanitization.workspacePath.startsWith("/tmp/")) {
    replacements.push({
      from: `/private${sanitization.workspacePath}`,
      to: "$EXCALIDRAW_REPO",
    });
  }
  if (sanitization.outputDir.startsWith("/tmp/")) {
    replacements.push({
      from: `/private${sanitization.outputDir}`,
      to: "$CAPTURE_OUTPUT",
    });
  }
  if (sanitization.homeDir) {
    replacements.push({
      from: sanitization.homeDir,
      to: "$HOME",
    });
  }

  let nextContent = content;
  for (const replacement of replacements.sort((left, right) =>
    right.from.length - left.from.length,
  )) {
    nextContent = nextContent.split(replacement.from).join(replacement.to);
  }
  return nextContent;
}

function fileExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readDirNames(path: string): string[] {
  return Array.from(new Set(readdirSync(path)));
}

function findBundlePaths(sourceRoot: string): ProviderAuditFixtureBundlePaths[] {
  const entries = readDirNames(sourceRoot);
  return entries
    .map((entryName) => resolve(sourceRoot, entryName))
    .filter((entryPath) => isDirectory(entryPath))
    .filter((entryPath) => basename(entryPath).endsWith(".log") === false)
    .map((bundleDir) => ({
      bundleDir,
      manifestPath: join(bundleDir, "manifest.json"),
      clientRequestsPath: join(bundleDir, "client-requests.json"),
      rawProviderEventsPath: join(bundleDir, "raw-provider-events.json"),
    }))
    .filter(
      (entry) =>
        fileExists(entry.manifestPath) &&
        fileExists(entry.clientRequestsPath) &&
        fileExists(entry.rawProviderEventsPath),
    );
}

function normalizeManifest(args: {
  manifest: ProviderAuditManifest;
  corpusId: string;
  taskId: string;
}): ProviderAuditManifest {
  return {
    ...args.manifest,
    workspacePath: "$EXCALIDRAW_REPO",
    runtimeWorkspacePath: "$EXCALIDRAW_REPO",
    envWorkspacePath: "$EXCALIDRAW_REPO",
    outputDir: `$FIXTURE_ROOT/${args.corpusId}/${args.manifest.providerId}/${args.taskId}`,
  };
}

function normalizeRawProviderEvents(
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[],
): Extract<AgentRuntimeCaptureEntry, { kind: "raw-provider-event" }>[] {
  return rawProviderEvents.map((entry) => structuredClone(entry));
}

function normalizeClientRequests(
  clientRequests: ProviderAuditClientRequest[],
): ProviderAuditClientRequest[] {
  return clientRequests.map((request) => ({ ...request }));
}

function writeFixtureBundle(args: {
  destinationBundleDir: string;
  manifest: ProviderAuditManifest;
  clientRequests: ProviderAuditClientRequest[];
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[];
  sanitization: ProviderAuditFixturePathSanitization;
}): void {
  mkdirSync(args.destinationBundleDir, { recursive: true });

  writeJsonFile(join(args.destinationBundleDir, "manifest.json"), args.manifest);

  const clientRequestsContent = sanitizeTextContent(
    JSON.stringify(args.clientRequests, null, 2) + "\n",
    args.sanitization,
  );
  writeFileSync(
    join(args.destinationBundleDir, "client-requests.json"),
    clientRequestsContent,
  );

  const rawProviderEventsContent = sanitizeTextContent(
    JSON.stringify(args.rawProviderEvents, null, 2) + "\n",
    args.sanitization,
  );
  writeFileSync(
    join(args.destinationBundleDir, "raw-provider-events.json"),
    rawProviderEventsContent,
  );
}

function importFixtureBundle(
  args: ProviderAuditFixtureImportBundleArgs,
): ProviderAuditImportFixtureResult {
  const manifest = readJsonFile({
    filePath: args.bundlePaths.manifestPath,
    schema: providerAuditManifestSchema,
  });
  const clientRequests = normalizeClientRequests(
    readJsonFile({
      filePath: args.bundlePaths.clientRequestsPath,
      schema: z.array(providerAuditClientRequestSchema),
    }),
  );
  const rawProviderEvents = normalizeRawProviderEvents(
    readJsonFile({
      filePath: args.bundlePaths.rawProviderEventsPath,
      schema: z.array(providerAuditRawProviderEventCaptureEntrySchema),
    }),
  );
  const taskId = normalizeTaskId({
    corpusId: args.corpusId,
    scenarioId: manifest.scenarioId,
  });
  const destinationBundleDir = join(
    args.fixtureCorpusRoot,
    manifest.providerId,
    taskId,
  );
  const normalizedManifest = normalizeManifest({
    manifest,
    corpusId: args.corpusId,
    taskId,
  });

  writeFixtureBundle({
    destinationBundleDir,
    manifest: normalizedManifest,
    clientRequests,
    rawProviderEvents,
    sanitization: {
      homeDir: getHomeDir(),
      workspacePath: manifest.workspacePath,
      outputDir: manifest.outputDir,
    },
  });

  return {
    corpusId: args.corpusId,
    providerId: normalizedManifest.providerId,
    taskId,
    fixturePath: join(args.corpusId, normalizedManifest.providerId, taskId),
  };
}

export function parseImportFixturesArgs(
  argv: string[],
): ProviderAuditFixtureCliParseResult {
  const args: ProviderAuditImportFixturesArgs = {
    sourceRoot: "",
    fixtureRoot: DEFAULT_FIXTURE_ROOT,
    corpusId: DEFAULT_CORPUS_ID,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--") {
      continue;
    }
    if (token === "--source-root" && next) {
      args.sourceRoot = resolve(next);
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
  }

  if (args.sourceRoot.length === 0) {
    throw new Error("--source-root is required for import-fixtures");
  }

  return { args };
}

export function importFixtureCorpus(
  args: ProviderAuditImportFixturesArgs,
): ProviderAuditImportFixturesResult {
  const fixtureCorpusRoot = resolveFixtureCorpusRoot({
    fixtureRoot: args.fixtureRoot,
    corpusId: args.corpusId,
  });
  rmSync(fixtureCorpusRoot, { recursive: true, force: true });
  mkdirSync(fixtureCorpusRoot, { recursive: true });

  const bundlePaths = findBundlePaths(args.sourceRoot);
  const fixtures = bundlePaths.map((bundlePath) =>
    importFixtureBundle({
      bundlePaths: bundlePath,
      corpusId: args.corpusId,
      fixtureCorpusRoot,
    }),
  );

  return {
    corpusId: args.corpusId,
    fixtureRoot: fixtureCorpusRoot,
    fixtures: fixtures.sort((left, right) => {
      if (left.providerId !== right.providerId) {
        return left.providerId.localeCompare(right.providerId);
      }
      return left.taskId.localeCompare(right.taskId);
    }),
  };
}

export function getFixtureFileNames(): readonly string[] {
  return FIXTURE_FILE_NAMES;
}
