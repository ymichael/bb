import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildThreadTimelineFromEvents,
  buildTimelineViewRows,
  decodeThreadEventRow,
  formatThreadTimelineText,
} from "@bb/thread-view";
import { threadEventTypeValues, type ThreadEventType } from "@bb/domain";
import { timelineRowSchema, type TimelineRow } from "@bb/server-contract";
import { z } from "zod";
import { readJsonFile } from "./json-file.js";
import {
  collectCoverageIssues,
  replayFixtures,
  summarizeFixtureCoverage,
} from "./replay.js";
import type {
  ProviderAuditBundle,
  ProviderAuditCoverageIssues,
  ProviderAuditFixtureCoverageSummary,
  ProviderAuditLadleStoryData,
  ProviderAuditReplayFixturesResult,
} from "./types.js";
import {
  DEFAULT_LADLE_OUTPUT_PATH,
  buildLadleStoryDataFromReplay,
  exportLadleStoryDataFromStoryData,
} from "./visual-audit.js";

const DEFAULT_FIXTURE_ROOT = resolve(
  fileURLToPath(new URL("../fixtures", import.meta.url)),
);
const DEFAULT_REPLAY_BUILD_ARTIFACT_PATH = resolve(
  fileURLToPath(new URL("../build/replay-artifact.json", import.meta.url)),
);

type TokenUsageTranslatedCapture = Extract<
  ProviderAuditBundle["translatedCaptures"][number],
  { kind: "translated-thread-event" }
> & {
  event: Extract<
    ProviderAuditBundle["translatedCaptures"][number]["event"],
    { type: "thread/tokenUsage/updated" }
  >;
};

interface ProviderAuditBuildReplayArtifactCliParseResult {
  args: WriteProviderAuditReplayBuildArtifactsArgs;
}

interface BuildPrefixSnapshotArgs {
  bundle: ProviderAuditBundle;
  fixtureId: string;
  prefixLength: number;
}

export interface ProviderAuditReplayBuildSummary {
  debugRawEventCount: number;
  fixture: string;
  rawProviderEventCount: number;
  renderedTimelineRowCount: number;
  semanticTimelineRowCount: number;
  timelinePreview: string[];
  translatedThreadEventCount: number;
  unexpectedUntranslatedRawEventCount: number;
}

export interface ProviderAuditReplayBuildVerboseTimeline {
  fixture: string;
  text: string;
}

export type ProviderAuditReplayBuildPrefixThreadStatus = "active" | "idle";

export interface ProviderAuditReplayBuildPrefixSnapshot {
  fixture: string;
  lastEventType: ThreadEventType;
  prefixLength: number;
  renderedTimelineRowCount: number;
  semanticTimelineRowCount: number;
  threadStatus: ProviderAuditReplayBuildPrefixThreadStatus;
  timelinePreview: string[];
  totalEventCount: number;
}

export interface ProviderAuditReplayBuildTokenUsageSummary {
  distinctModelContextWindows: number[];
  nonNullModelContextWindowCount: number;
  tokenUsageEventCount: number;
}

export interface ProviderAuditReplayBuildContextWindowUsage {
  estimated: boolean;
  modelContextWindow: number;
  usedTokens: number;
}

export interface ProviderAuditReplayBuildContextWindowSnapshot {
  contextWindowUsage: ProviderAuditReplayBuildContextWindowUsage | null;
  fixture: string;
  providerId: string;
  tokenUsageSummary: ProviderAuditReplayBuildTokenUsageSummary;
}

export interface ProviderAuditReplayBuildDelegationSnapshot {
  childRowCount: number;
  fixture: string;
  hasChildToolActivity: boolean;
}

export interface ProviderAuditReplayBuildArtifact {
  contextWindowSnapshots: ProviderAuditReplayBuildContextWindowSnapshot[];
  coverageIssues: ProviderAuditCoverageIssues;
  coverageSummary: ProviderAuditFixtureCoverageSummary;
  delegationSnapshots: ProviderAuditReplayBuildDelegationSnapshot[];
  fixtureCount: number;
  ladleStoryData: ProviderAuditLadleStoryData;
  summaries: ProviderAuditReplayBuildSummary[];
  timelinePrefixSnapshots: ProviderAuditReplayBuildPrefixSnapshot[];
  verboseTimelines: ProviderAuditReplayBuildVerboseTimeline[];
}

export interface BuildProviderAuditReplayBuildArtifactArgs {
  fixtureRoot?: string;
}

export interface LoadProviderAuditReplayBuildArtifactArgs {
  artifactPath?: string;
}

export interface WriteProviderAuditReplayBuildArtifactsArgs {
  artifactPath?: string;
  fixtureRoot?: string;
  ladleOutputPath?: string;
}

export interface WriteProviderAuditReplayBuildArtifactsResult {
  artifactPath: string;
  fixtureCount: number;
  ladleOutputPath: string;
}

const rawEventCoverageSchema = z.enum(["normalized", "noise", "unknown"]);
const observedToolCallCoverageSchema = z.enum([
  "well-known",
  "accepted-fallback",
  "unknown",
]);
const providerAuditThreadEventTypeSet = new Set<string>(threadEventTypeValues);
const providerAuditThreadEventTypeSchema = z.custom<ThreadEventType>(
  (value) =>
    typeof value === "string" && providerAuditThreadEventTypeSet.has(value),
  "Invalid thread event type",
);

const coverageFixtureIdsSchema = z.object({
  fixtureIds: z.array(z.string()),
});

const coverageSummarySchema = z.object({
  providers: z.array(
    z.object({
      providerId: z.string(),
      fixtureIds: z.array(z.string()),
      wellKnownToolNames: z.array(z.string()),
      rawEventKinds: z.array(
        coverageFixtureIdsSchema.extend({
          kind: z.string(),
          classification: rawEventCoverageSchema,
          totalCount: z.number(),
        }),
      ),
      translatedEventTypes: z.array(
        coverageFixtureIdsSchema.extend({
          type: providerAuditThreadEventTypeSchema,
        }),
      ),
      observedToolCalls: z.array(
        coverageFixtureIdsSchema.extend({
          key: z.string(),
          displayName: z.string(),
          coverage: observedToolCallCoverageSchema,
          totalCount: z.number(),
        }),
      ),
    }),
  ),
}) satisfies z.ZodType<ProviderAuditFixtureCoverageSummary>;

const coverageIssuesSchema = z.object({
  unexpectedUntranslatedFixtures: z.array(
    z.object({
      fixtureId: z.string(),
      unexpectedUntranslatedRawEventCount: z.number(),
    }),
  ),
  providersWithUnhandledEvents: z.array(
    z.object({
      providerId: z.string(),
      fixtureIds: z.array(z.string()),
    }),
  ),
  unknownRawEventKinds: z.array(
    z.object({
      providerId: z.string(),
      kind: z.string(),
      totalCount: z.number(),
      fixtureIds: z.array(z.string()),
    }),
  ),
  unknownObservedToolCalls: z.array(
    z.object({
      providerId: z.string(),
      key: z.string(),
      displayName: z.string(),
      totalCount: z.number(),
      fixtureIds: z.array(z.string()),
    }),
  ),
}) satisfies z.ZodType<ProviderAuditCoverageIssues>;

const contextWindowUsageSchema = z.object({
  estimated: z.boolean(),
  modelContextWindow: z.number(),
  usedTokens: z.number(),
});

const replayBuildArtifactSchema = z.object({
  contextWindowSnapshots: z.array(
    z.object({
      contextWindowUsage: contextWindowUsageSchema.nullable(),
      fixture: z.string(),
      providerId: z.string(),
      tokenUsageSummary: z.object({
        distinctModelContextWindows: z.array(z.number()),
        nonNullModelContextWindowCount: z.number(),
        tokenUsageEventCount: z.number(),
      }),
    }),
  ),
  coverageIssues: coverageIssuesSchema,
  coverageSummary: coverageSummarySchema,
  delegationSnapshots: z.array(
    z.object({
      childRowCount: z.number(),
      fixture: z.string(),
      hasChildToolActivity: z.boolean(),
    }),
  ),
  fixtureCount: z.number(),
  ladleStoryData: z.object({
    fixtures: z.array(
      z.object({
        id: z.string(),
        corpusId: z.string(),
        providerId: z.string(),
        taskId: z.string(),
        scenarioDescription: z.string(),
        threadStatus: z.string(),
        semanticTimelineRowCount: z.number(),
        renderedTimelineRowCount: z.number(),
        timelineRows: z.array(timelineRowSchema),
      }),
    ),
  }),
  summaries: z.array(
    z.object({
      debugRawEventCount: z.number(),
      fixture: z.string(),
      rawProviderEventCount: z.number(),
      renderedTimelineRowCount: z.number(),
      semanticTimelineRowCount: z.number(),
      timelinePreview: z.array(z.string()),
      translatedThreadEventCount: z.number(),
      unexpectedUntranslatedRawEventCount: z.number(),
    }),
  ),
  timelinePrefixSnapshots: z.array(
    z.object({
      fixture: z.string(),
      lastEventType: providerAuditThreadEventTypeSchema,
      prefixLength: z.number(),
      renderedTimelineRowCount: z.number(),
      semanticTimelineRowCount: z.number(),
      threadStatus: z.enum(["active", "idle"]),
      timelinePreview: z.array(z.string()),
      totalEventCount: z.number(),
    }),
  ),
  verboseTimelines: z.array(
    z.object({
      fixture: z.string(),
      text: z.string(),
    }),
  ),
}) satisfies z.ZodType<ProviderAuditReplayBuildArtifact>;

function toFixtureId(
  fixture: ProviderAuditReplayFixturesResult["fixtures"][number]["fixture"],
): string {
  return `${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`;
}

function buildTimelinePreview(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

function trimTrailingWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");
}

function buildVerboseTimelineText(bundle: ProviderAuditBundle): string {
  return trimTrailingWhitespace(
    formatThreadTimelineText(bundle.timelineVerboseRows, {
      color: false,
      truncateForAudit: true,
      verbose: true,
    }),
  );
}

function buildAuditTimelineText(bundle: ProviderAuditBundle): string {
  return trimTrailingWhitespace(
    formatThreadTimelineText(bundle.timelineRows, {
      color: false,
      truncateForAudit: true,
      verbose: false,
    }),
  );
}

function flattenTimelineRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const flattenedRows: TimelineRow[] = [];
  for (const row of rows) {
    flattenedRows.push(row);
    if (row.kind === "turn" && row.children) {
      flattenedRows.push(...flattenTimelineRows(row.children));
      continue;
    }
    if (row.kind === "work" && row.workKind === "delegation") {
      flattenedRows.push(...flattenTimelineRows(row.childRows));
    }
  }
  return flattenedRows;
}

function isTokenUsageTranslatedCapture(
  entry: ProviderAuditBundle["translatedCaptures"][number],
): entry is TokenUsageTranslatedCapture {
  return entry.event.type === "thread/tokenUsage/updated";
}

function selectPrefixLengths(totalEventCount: number): number[] {
  if (totalEventCount <= 0) {
    return [];
  }

  return [
    ...new Set([
      1,
      Math.ceil(totalEventCount * 0.25),
      Math.ceil(totalEventCount * 0.5),
      Math.ceil(totalEventCount * 0.75),
      totalEventCount,
    ]),
  ]
    .filter(
      (prefixLength) => prefixLength > 0 && prefixLength <= totalEventCount,
    )
    .sort((left, right) => left - right);
}

function buildPrefixSnapshot(
  args: BuildPrefixSnapshotArgs,
): ProviderAuditReplayBuildPrefixSnapshot {
  const prefixRows = args.bundle.threadEventRows.slice(0, args.prefixLength);
  const lastRow = prefixRows[prefixRows.length - 1];
  if (!lastRow) {
    throw new Error(`Cannot build empty prefix snapshot for ${args.fixtureId}`);
  }

  const threadStatus: ProviderAuditReplayBuildPrefixThreadStatus =
    args.prefixLength === args.bundle.threadEventRows.length
      ? "idle"
      : "active";
  const decodedRows = prefixRows.map((row) => decodeThreadEventRow(row));
  const timelineRows = buildThreadTimelineFromEvents({
    contextWindowEvents: decodedRows,
    events: decodedRows,
    options: {
      includeDebugRawEvents: false,
      includeNestedRows: false,
      includeOptionalOperations: false,
      includeProviderUnhandledOperations: false,
      threadStatus,
      turnMessageDetail: "summary",
      viewMode: "standard",
    },
  }).rows;
  const timelineText = formatThreadTimelineText(timelineRows, {
    color: false,
    truncateForAudit: true,
    verbose: false,
  });
  const renderedTimelineRowCount = buildTimelineViewRows(timelineRows).length;

  return {
    fixture: args.fixtureId,
    lastEventType: lastRow.type,
    prefixLength: args.prefixLength,
    renderedTimelineRowCount,
    semanticTimelineRowCount: timelineRows.length,
    threadStatus,
    timelinePreview: buildTimelinePreview(timelineText),
    totalEventCount: args.bundle.threadEventRows.length,
  };
}

function buildTimelinePrefixSnapshots(
  replayed: ProviderAuditReplayFixturesResult,
): ProviderAuditReplayBuildPrefixSnapshot[] {
  const snapshots: ProviderAuditReplayBuildPrefixSnapshot[] = [];
  for (const { fixture, bundle } of replayed.fixtures) {
    const fixtureId = toFixtureId(fixture);
    for (const prefixLength of selectPrefixLengths(
      bundle.threadEventRows.length,
    )) {
      snapshots.push(
        buildPrefixSnapshot({
          bundle,
          fixtureId,
          prefixLength,
        }),
      );
    }
  }
  return snapshots;
}

function buildFixtureContextWindowSnapshot(
  bundle: ProviderAuditBundle,
  fixtureId: string,
  providerId: string,
): ProviderAuditReplayBuildContextWindowSnapshot {
  const tokenUsageEvents = bundle.translatedCaptures.filter(
    isTokenUsageTranslatedCapture,
  );
  const distinctModelContextWindows = [
    ...new Set(
      tokenUsageEvents
        .map((entry) => entry.event.tokenUsage.modelContextWindow)
        .filter((value): value is number => value !== null),
    ),
  ].sort((left, right) => left - right);

  return {
    fixture: fixtureId,
    providerId,
    contextWindowUsage: bundle.contextWindowUsage,
    tokenUsageSummary: {
      tokenUsageEventCount: tokenUsageEvents.length,
      nonNullModelContextWindowCount: tokenUsageEvents.filter(
        (entry) => entry.event.tokenUsage.modelContextWindow !== null,
      ).length,
      distinctModelContextWindows,
    },
  };
}

function buildDelegationSnapshots(
  replayed: ProviderAuditReplayFixturesResult,
): ProviderAuditReplayBuildDelegationSnapshot[] {
  const snapshots: ProviderAuditReplayBuildDelegationSnapshot[] = [];
  for (const { fixture, bundle } of replayed.fixtures) {
    for (const row of flattenTimelineRows(bundle.timelineVerboseRows)) {
      if (row.kind !== "work" || row.workKind !== "delegation") {
        continue;
      }
      const childRows = flattenTimelineRows(row.childRows);
      snapshots.push({
        fixture: toFixtureId(fixture),
        childRowCount: childRows.length,
        hasChildToolActivity: childRows.some(
          (child) =>
            child.kind === "work" &&
            (child.workKind === "command" || child.workKind === "tool"),
        ),
      });
    }
  }
  return snapshots;
}

export function buildProviderAuditReplayBuildArtifact(
  args: BuildProviderAuditReplayBuildArtifactArgs = {},
): ProviderAuditReplayBuildArtifact {
  const replayed = replayFixtures({
    fixtureRoot: args.fixtureRoot ?? DEFAULT_FIXTURE_ROOT,
  });

  return {
    contextWindowSnapshots: replayed.fixtures.map(({ fixture, bundle }) =>
      buildFixtureContextWindowSnapshot(
        bundle,
        toFixtureId(fixture),
        fixture.providerId,
      ),
    ),
    coverageIssues: collectCoverageIssues(replayed),
    coverageSummary: summarizeFixtureCoverage(replayed),
    delegationSnapshots: buildDelegationSnapshots(replayed),
    fixtureCount: replayed.fixtures.length,
    ladleStoryData: buildLadleStoryDataFromReplay({ replayed }),
    summaries: replayed.fixtures.map(({ fixture, bundle }) => ({
      fixture: toFixtureId(fixture),
      rawProviderEventCount: bundle.auditReport.summary.rawProviderEventCount,
      translatedThreadEventCount:
        bundle.auditReport.summary.translatedThreadEventCount,
      semanticTimelineRowCount:
        bundle.auditReport.summary.semanticTimelineRowCount,
      renderedTimelineRowCount:
        bundle.auditReport.summary.renderedTimelineRowCount,
      debugRawEventCount: bundle.auditReport.summary.debugRawEventCount,
      unexpectedUntranslatedRawEventCount:
        bundle.auditReport.summary.unexpectedUntranslatedRawEventCount,
      timelinePreview: buildTimelinePreview(buildAuditTimelineText(bundle)),
    })),
    timelinePrefixSnapshots: buildTimelinePrefixSnapshots(replayed),
    verboseTimelines: replayed.fixtures.map(({ fixture, bundle }) => ({
      fixture: toFixtureId(fixture),
      text: buildVerboseTimelineText(bundle),
    })),
  };
}

export function loadProviderAuditReplayBuildArtifact(
  args: LoadProviderAuditReplayBuildArtifactArgs = {},
): ProviderAuditReplayBuildArtifact {
  return readJsonFile({
    filePath: args.artifactPath ?? DEFAULT_REPLAY_BUILD_ARTIFACT_PATH,
    schema: replayBuildArtifactSchema,
  });
}

export function writeProviderAuditReplayBuildArtifacts(
  args: WriteProviderAuditReplayBuildArtifactsArgs = {},
): WriteProviderAuditReplayBuildArtifactsResult {
  const artifactPath = resolve(
    args.artifactPath ?? DEFAULT_REPLAY_BUILD_ARTIFACT_PATH,
  );
  const ladleOutputPath = resolve(
    args.ladleOutputPath ?? DEFAULT_LADLE_OUTPUT_PATH,
  );
  const artifact = buildProviderAuditReplayBuildArtifact({
    fixtureRoot: args.fixtureRoot,
  });

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  exportLadleStoryDataFromStoryData({
    outputPath: ladleOutputPath,
    storyData: artifact.ladleStoryData,
  });

  return {
    artifactPath,
    fixtureCount: artifact.fixtureCount,
    ladleOutputPath,
  };
}

export function parseBuildReplayArtifactArgs(
  argv: string[],
): ProviderAuditBuildReplayArtifactCliParseResult {
  const args: WriteProviderAuditReplayBuildArtifactsArgs = {};

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
    if (token === "--artifact-output" && next) {
      args.artifactPath = resolve(next);
      index += 1;
      continue;
    }
    if (token === "--ladle-output" && next) {
      args.ladleOutputPath = resolve(next);
      index += 1;
    }
  }

  return { args };
}
