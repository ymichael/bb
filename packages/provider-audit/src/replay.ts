import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProviderForId,
  type AgentRuntimeCaptureEntry,
  type AgentRuntimeRawProviderEventCaptureEntry,
  type AgentRuntimeTranslatedThreadEventCaptureEntry,
} from "@bb/agent-runtime";
import { threadEventSchema, type ThreadEvent } from "@bb/domain";
import { z } from "zod";
import { buildBundle, writeBundle } from "./capture.js";
import {
  providerAuditClientRequestSchema,
  providerAuditManifestSchema,
  providerAuditRawProviderEventCaptureEntrySchema,
  readJsonFile,
} from "./json-file.js";
import type {
  ProviderAuditCoverageIssues,
  ProviderAuditBundle,
  ProviderAuditCoverageRawEventSummary,
  ProviderAuditCoverageToolCallSummary,
  ProviderAuditCoverageTranslatedEventTypeSummary,
  ProviderAuditFixtureCoverageSummary,
  ProviderAuditFixtureBundle,
  ProviderAuditManifest,
  ProviderAuditProviderCoverageSummary,
  ProviderAuditReplayFixtureResult,
  ProviderAuditReplayFixturesArgs,
  ProviderAuditReplayFixturesResult,
} from "./types.js";

const DEFAULT_FIXTURE_ROOT = resolve(
  fileURLToPath(new URL("../fixtures", import.meta.url)),
);

interface ProviderAuditReplayCliParseResult {
  args: ProviderAuditReplayFixturesArgs;
}

interface CoverageRawEventAccumulator {
  classification: ProviderAuditCoverageRawEventSummary["classification"];
  fixtureIds: Set<string>;
  kind: string;
  totalCount: number;
}

interface CoverageTranslatedEventTypeAccumulator {
  fixtureIds: Set<string>;
  type: ProviderAuditCoverageTranslatedEventTypeSummary["type"];
}

interface CoverageToolCallAccumulator {
  coverage: ProviderAuditCoverageToolCallSummary["coverage"];
  displayName: string;
  fixtureIds: Set<string>;
  key: string;
  totalCount: number;
}

interface CoverageProviderAccumulator {
  fixtureIds: Set<string>;
  observedToolCalls: Map<string, CoverageToolCallAccumulator>;
  providerId: string;
  rawEventKinds: Map<string, CoverageRawEventAccumulator>;
  translatedEventTypes: Map<string, CoverageTranslatedEventTypeAccumulator>;
  wellKnownToolNames: Set<string>;
}

const providerAuditThreadIdParamsSchema = z.object({
  threadId: z.string().optional(),
}).passthrough();

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

function loadFixtureBundle(args: {
  fixtureRoot: string;
  corpusId: string;
  providerId: string;
  taskId: string;
}): ProviderAuditFixtureBundle {
  const fixturePath = join(args.fixtureRoot, args.corpusId, args.providerId, args.taskId);
  return {
    corpusId: args.corpusId,
    providerId: args.providerId,
    taskId: args.taskId,
    fixturePath,
    manifestPath: join(fixturePath, "manifest.json"),
    manifest: readJsonFile({
      filePath: join(fixturePath, "manifest.json"),
      schema: providerAuditManifestSchema,
    }),
    clientRequests: readJsonFile({
      filePath: join(fixturePath, "client-requests.json"),
      schema: z.array(providerAuditClientRequestSchema),
    }),
    rawProviderEvents: readJsonFile({
      filePath: join(fixturePath, "raw-provider-events.json"),
      schema: z.array(providerAuditRawProviderEventCaptureEntrySchema),
    }),
  };
}

function getThreadIdFromParams(
  rawEvent: AgentRuntimeRawProviderEventCaptureEntry["rawEvent"],
): string | undefined {
  const parsedParams = providerAuditThreadIdParamsSchema.safeParse(rawEvent.params);
  return parsedParams.success ? parsedParams.data.threadId : undefined;
}

interface StampTranslatedEventArgs {
  event: ThreadEvent;
  bbThreadId: string;
  providerThreadId: string | undefined;
  sourceThreadId: string | undefined;
}

function resolveStampedProviderThreadId(
  args: StampTranslatedEventArgs,
): string | undefined {
  if (args.providerThreadId) {
    return args.providerThreadId;
  }

  if (
    args.sourceThreadId &&
    args.sourceThreadId !== args.bbThreadId &&
    args.event.type !== "thread/identity"
  ) {
    return args.sourceThreadId;
  }

  return "providerThreadId" in args.event
    ? args.event.providerThreadId
    : undefined;
}

function stampTranslatedEvent(args: StampTranslatedEventArgs): ThreadEvent {
  const providerThreadId = resolveStampedProviderThreadId(args);
  return threadEventSchema.parse({
    ...args.event,
    threadId: args.bbThreadId,
    ...(
      providerThreadId !== undefined || "providerThreadId" in args.event
        ? {
            providerThreadId,
          }
        : {}
    ),
  });
}

function translateRawProviderEvents(args: {
  manifest: ProviderAuditManifest;
  rawProviderEvents: AgentRuntimeRawProviderEventCaptureEntry[];
}): AgentRuntimeTranslatedThreadEventCaptureEntry[] {
  const adapter = createProviderForId(args.manifest.providerId);
  let providerThreadId: string | undefined;
  const translated: AgentRuntimeTranslatedThreadEventCaptureEntry[] = [];

  for (const rawProviderEvent of args.rawProviderEvents) {
    const sourceThreadId =
      rawProviderEvent.sourceThreadId ??
      getThreadIdFromParams(rawProviderEvent.rawEvent);
    const events = adapter.translateEvent(rawProviderEvent.rawEvent, {
      threadId: sourceThreadId,
    });

    for (const event of events) {
      const candidateProviderThreadId =
        event.type === "thread/identity"
          ? event.providerThreadId
          : providerThreadId;
      const stampedEvent = stampTranslatedEvent({
        event,
        bbThreadId: args.manifest.threadId,
        providerThreadId: candidateProviderThreadId,
        sourceThreadId,
      });

      if (
        stampedEvent.type === "thread/identity" &&
        typeof stampedEvent.providerThreadId === "string" &&
        stampedEvent.providerThreadId.length > 0
      ) {
        providerThreadId = stampedEvent.providerThreadId;
      }

      translated.push({
        kind: "translated-thread-event",
        capturedAt: rawProviderEvent.capturedAt,
        providerId: rawProviderEvent.providerId,
        rawCaptureId: rawProviderEvent.captureId,
        rawMethod: rawProviderEvent.rawEvent.method,
        event: stampedEvent,
      });
    }
  }

  return translated;
}

export function listFixtureBundles(
  args: ProviderAuditReplayFixturesArgs,
): ProviderAuditFixtureBundle[] {
  const fixtureRoot = resolve(args.fixtureRoot);
  const corpusIds =
    args.corpusId !== undefined
      ? [args.corpusId]
      : readDirNames(fixtureRoot).filter((entry) =>
          isDirectory(join(fixtureRoot, entry)),
        );

  const fixtures: ProviderAuditFixtureBundle[] = [];

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

function withReplayOutputDir(args: {
  bundle: ProviderAuditBundle;
  outputRoot: string;
  fixture: ProviderAuditFixtureBundle;
}): ProviderAuditBundle {
  const outputDir = join(
    resolve(args.outputRoot),
    args.fixture.corpusId,
    args.fixture.providerId,
    args.fixture.taskId,
  );
  mkdirSync(outputDir, { recursive: true });
  return {
    ...args.bundle,
    manifest: {
      ...args.bundle.manifest,
      outputDir,
    },
  };
}

function replayFixtureBundle(args: {
  fixture: ProviderAuditFixtureBundle;
  outputRoot?: string;
}): ProviderAuditReplayFixtureResult {
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
    clientRequests: args.fixture.clientRequests,
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
  return {
    fixture: args.fixture,
    bundle: outputBundle,
    outputDir: outputBundle.manifest.outputDir,
  };
}

export function replayFixtures(
  args: ProviderAuditReplayFixturesArgs,
): ProviderAuditReplayFixturesResult {
  const fixtureRoot = args.fixtureRoot ? resolve(args.fixtureRoot) : DEFAULT_FIXTURE_ROOT;
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

export function parseReplayFixturesArgs(
  argv: string[],
): ProviderAuditReplayCliParseResult {
  const args: ProviderAuditReplayFixturesArgs = {
    fixtureRoot: DEFAULT_FIXTURE_ROOT,
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
      continue;
    }
  }

  return { args };
}

export function summarizeReplayResults(
  result: ProviderAuditReplayFixturesResult,
): Array<Record<string, number | string>> {
  return result.fixtures.map(({ fixture, bundle }) => ({
    corpusId: fixture.corpusId,
    providerId: fixture.providerId,
    taskId: fixture.taskId,
    rawProviderEventCount: bundle.auditReport.summary.rawProviderEventCount,
    translatedThreadEventCount:
      bundle.auditReport.summary.translatedThreadEventCount,
    viewMessageCount: bundle.auditReport.summary.viewMessageCount,
    timelineRowCount: bundle.auditReport.summary.timelineRowCount,
    debugRawEventCount: bundle.auditReport.summary.debugRawEventCount,
    unexpectedUntranslatedRawEventCount:
      bundle.auditReport.summary.unexpectedUntranslatedRawEventCount,
    fixturePath: relative(process.cwd(), fixture.fixturePath),
  }));
}

function toCoverageFixtureId(fixture: ProviderAuditFixtureBundle): string {
  return `${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`;
}

function getCoverageProviderAccumulator(
  accumulators: Map<string, CoverageProviderAccumulator>,
  providerId: string,
): CoverageProviderAccumulator {
  const existing = accumulators.get(providerId);
  if (existing) {
    return existing;
  }

  const created: CoverageProviderAccumulator = {
    fixtureIds: new Set<string>(),
    observedToolCalls: new Map<string, CoverageToolCallAccumulator>(),
    providerId,
    rawEventKinds: new Map<string, CoverageRawEventAccumulator>(),
    translatedEventTypes: new Map<string, CoverageTranslatedEventTypeAccumulator>(),
    wellKnownToolNames: new Set<string>(),
  };
  accumulators.set(providerId, created);
  return created;
}

function sortFixtureIds(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function finalizeCoverageProviderAccumulator(
  accumulator: CoverageProviderAccumulator,
): ProviderAuditProviderCoverageSummary {
  const rawEventKinds: ProviderAuditCoverageRawEventSummary[] = [
    ...accumulator.rawEventKinds.values(),
  ].map((entry) => ({
    kind: entry.kind,
    classification: entry.classification,
    totalCount: entry.totalCount,
    fixtureIds: sortFixtureIds(entry.fixtureIds),
  })).sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    return left.classification.localeCompare(right.classification);
  });

  const translatedEventTypes: ProviderAuditCoverageTranslatedEventTypeSummary[] = [
    ...accumulator.translatedEventTypes.values(),
  ].map((entry) => ({
    type: entry.type,
    fixtureIds: sortFixtureIds(entry.fixtureIds),
  })).sort((left, right) => left.type.localeCompare(right.type));

  const observedToolCalls: ProviderAuditCoverageToolCallSummary[] = [
    ...accumulator.observedToolCalls.values(),
  ].map((entry) => ({
    key: entry.key,
    displayName: entry.displayName,
    coverage: entry.coverage,
    totalCount: entry.totalCount,
    fixtureIds: sortFixtureIds(entry.fixtureIds),
  })).sort((left, right) => {
    if (left.key !== right.key) {
      return left.key.localeCompare(right.key);
    }
    return left.coverage.localeCompare(right.coverage);
  });

  return {
    providerId: accumulator.providerId,
    fixtureIds: sortFixtureIds(accumulator.fixtureIds),
    wellKnownToolNames: sortFixtureIds(accumulator.wellKnownToolNames),
    rawEventKinds,
    translatedEventTypes,
    observedToolCalls,
  };
}

export function summarizeFixtureCoverage(
  result: ProviderAuditReplayFixturesResult,
): ProviderAuditFixtureCoverageSummary {
  const accumulators = new Map<string, CoverageProviderAccumulator>();

  for (const entry of result.fixtures) {
    const fixtureId = toCoverageFixtureId(entry.fixture);
    const provider = getCoverageProviderAccumulator(
      accumulators,
      entry.fixture.providerId,
    );

    provider.fixtureIds.add(fixtureId);
    for (const toolName of entry.bundle.auditReport.wellKnownToolNames) {
      provider.wellKnownToolNames.add(toolName);
    }

    for (const rawEventKind of entry.bundle.auditReport.rawEventKinds) {
      const rawEventKey = `${rawEventKind.classification}:${rawEventKind.kind}`;
      const existing = provider.rawEventKinds.get(rawEventKey);
      if (existing) {
        existing.totalCount += rawEventKind.count;
        existing.fixtureIds.add(fixtureId);
      } else {
        provider.rawEventKinds.set(rawEventKey, {
          classification: rawEventKind.classification,
          fixtureIds: new Set<string>([fixtureId]),
          kind: rawEventKind.kind,
          totalCount: rawEventKind.count,
        });
      }
    }

    for (const translatedEventType of entry.bundle.auditReport.translatedEventTypes) {
      const existing = provider.translatedEventTypes.get(translatedEventType);
      if (existing) {
        existing.fixtureIds.add(fixtureId);
      } else {
        provider.translatedEventTypes.set(translatedEventType, {
          fixtureIds: new Set<string>([fixtureId]),
          type: translatedEventType,
        });
      }
    }

    for (const observedToolCall of entry.bundle.auditReport.observedToolCalls) {
      const toolKey = `${observedToolCall.coverage}:${observedToolCall.key}`;
      const existing = provider.observedToolCalls.get(toolKey);
      if (existing) {
        existing.totalCount += observedToolCall.count;
        existing.fixtureIds.add(fixtureId);
      } else {
        provider.observedToolCalls.set(toolKey, {
          coverage: observedToolCall.coverage,
          displayName: observedToolCall.displayName,
          fixtureIds: new Set<string>([fixtureId]),
          key: observedToolCall.key,
          totalCount: observedToolCall.count,
        });
      }
    }
  }

  return {
    providers: [...accumulators.values()]
      .map((entry) => finalizeCoverageProviderAccumulator(entry))
      .sort((left, right) => left.providerId.localeCompare(right.providerId)),
  };
}

export function collectCoverageIssues(
  result: ProviderAuditReplayFixturesResult,
): ProviderAuditCoverageIssues {
  const coverage = summarizeFixtureCoverage(result);

  return {
    unexpectedUntranslatedFixtures: result.fixtures
      .filter(
        (entry) => entry.bundle.auditReport.summary.unexpectedUntranslatedRawEventCount > 0,
      )
      .map((entry) => ({
        fixtureId: toCoverageFixtureId(entry.fixture),
        unexpectedUntranslatedRawEventCount:
          entry.bundle.auditReport.summary.unexpectedUntranslatedRawEventCount,
      }))
      .sort((left, right) => left.fixtureId.localeCompare(right.fixtureId)),
    providersWithUnhandledEvents: coverage.providers
      .filter((provider) =>
        provider.translatedEventTypes.some((entry) => entry.type === "provider/unhandled"),
      )
      .map((provider) => ({
        providerId: provider.providerId,
        fixtureIds: provider.translatedEventTypes
          .filter((entry) => entry.type === "provider/unhandled")
          .flatMap((entry) => entry.fixtureIds)
          .sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId)),
    unknownRawEventKinds: coverage.providers
      .flatMap((provider) =>
        provider.rawEventKinds
          .filter((entry) => entry.classification === "unknown")
          .map((entry) => ({
            providerId: provider.providerId,
            kind: entry.kind,
            totalCount: entry.totalCount,
            fixtureIds: entry.fixtureIds,
          })),
      )
      .sort((left, right) => {
        if (left.providerId !== right.providerId) {
          return left.providerId.localeCompare(right.providerId);
        }
        return left.kind.localeCompare(right.kind);
      }),
    unknownObservedToolCalls: coverage.providers
      .flatMap((provider) =>
        provider.observedToolCalls
          .filter((entry) => entry.coverage === "unknown")
          .map((entry) => ({
            providerId: provider.providerId,
            key: entry.key,
            displayName: entry.displayName,
            totalCount: entry.totalCount,
            fixtureIds: entry.fixtureIds,
          })),
      )
      .sort((left, right) => {
        if (left.providerId !== right.providerId) {
          return left.providerId.localeCompare(right.providerId);
        }
        return left.key.localeCompare(right.key);
      }),
  };
}
