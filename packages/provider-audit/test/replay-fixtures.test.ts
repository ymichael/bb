import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { extractThreadContextWindowUsage } from "@bb/core-ui";
import type { ViewMessage } from "@bb/domain";
import type {
  ProviderAuditBundle,
  ProviderAuditReplayFixturesResult,
} from "../src/types.js";
import {
  collectCoverageIssues,
  replayFixtures,
  summarizeFixtureCoverage,
} from "../src/replay.js";
import {
  buildLadleStoryData,
  exportLadleStoryData,
} from "../src/visual-audit.js";

const TEMP_DIRS: string[] = [];
const CHECKED_IN_FIXTURE_ROOT = fixtureRoot();
let checkedInReplay: ProviderAuditReplayFixturesResult;

function fixtureRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
}

function countMessageKinds(messages: ViewMessage[]): Record<string, number> {
  return messages.reduce<Record<string, number>>((counts, message) => {
    counts[message.kind] = (counts[message.kind] ?? 0) + 1;
    return counts;
  }, {});
}

function buildTimelinePreview(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function trimTrailingWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");
}

type TokenUsageTranslatedCapture = Extract<
  ProviderAuditBundle["translatedCaptures"][number],
  { event: { type: "thread/tokenUsage/updated" } }
>;

interface TokenUsageSummarySnapshot {
  tokenUsageEventCount: number;
  nonNullModelContextWindowCount: number;
  distinctModelContextWindows: number[];
}

interface FixtureContextWindowSnapshot {
  fixture: string;
  contextWindowUsage: ReturnType<typeof extractThreadContextWindowUsage>;
  tokenUsageSummary: TokenUsageSummarySnapshot;
}

function isTokenUsageTranslatedCapture(
  entry: ProviderAuditBundle["translatedCaptures"][number],
): entry is TokenUsageTranslatedCapture {
  return entry.event.type === "thread/tokenUsage/updated";
}

function buildFixtureContextWindowSnapshot(
  bundle: ProviderAuditBundle,
  fixtureId: string,
): FixtureContextWindowSnapshot {
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
    contextWindowUsage: extractThreadContextWindowUsage(bundle.threadEventRows),
    tokenUsageSummary: {
      tokenUsageEventCount: tokenUsageEvents.length,
      nonNullModelContextWindowCount: tokenUsageEvents.filter(
        (entry) => entry.event.tokenUsage.modelContextWindow !== null,
      ).length,
      distinctModelContextWindows,
    },
  };
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0, TEMP_DIRS.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("@bb/provider-audit fixture replay", () => {
  beforeAll(() => {
    checkedInReplay = replayFixtures({
      fixtureRoot: CHECKED_IN_FIXTURE_ROOT,
    });
  });

  it("replays every checked-in fixture into stable summaries", () => {
    expect(checkedInReplay.fixtures.length).toBeGreaterThan(0);

    for (const { fixture, bundle } of checkedInReplay.fixtures) {
      expect(
        bundle.auditReport.summary.translatedThreadEventCount,
        `Expected translated events for ${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
      ).toBeGreaterThan(0);
      expect(
        bundle.auditReport.summary.unexpectedUntranslatedRawEventCount,
        `Expected zero unexpected untranslated raw events for ${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
      ).toBe(0);
    }

    const summary = checkedInReplay.fixtures.map(({ fixture, bundle }) => ({
      fixture: `${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
      rawProviderEventCount: bundle.auditReport.summary.rawProviderEventCount,
      translatedThreadEventCount:
        bundle.auditReport.summary.translatedThreadEventCount,
      viewMessageCount: bundle.auditReport.summary.viewMessageCount,
      timelineRowCount: bundle.auditReport.summary.timelineRowCount,
      debugRawEventCount: bundle.auditReport.summary.debugRawEventCount,
      unexpectedUntranslatedRawEventCount:
        bundle.auditReport.summary.unexpectedUntranslatedRawEventCount,
      viewMessageKinds: countMessageKinds(bundle.viewMessages),
      timelinePreview: buildTimelinePreview(bundle.timelineText),
    }));

    expect(summary).toMatchSnapshot();
  });

  it("snapshots verbose CLI timeline output for every fixture", () => {
    const verboseTimelines = checkedInReplay.fixtures.map(({ fixture, bundle }) => ({
      fixture: `${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
      timeline: trimTrailingWhitespace(bundle.timelineVerboseText),
    }));

    expect(verboseTimelines).toMatchSnapshot();
  });

  it("summarizes raw-event and tool-call coverage across the checked-in fixtures", () => {
    expect(summarizeFixtureCoverage(checkedInReplay)).toMatchSnapshot();
  });

  it("snapshots parsed context-window data for replayed token-usage events", () => {
    const contextWindowSnapshots = checkedInReplay.fixtures.map(
      ({ fixture, bundle }) =>
        buildFixtureContextWindowSnapshot(
          bundle,
          `${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
        ),
    );

    expect(contextWindowSnapshots).toMatchSnapshot();
  });

  it("replayed Pi fixtures expose non-null context-window usage", () => {
    const piSnapshots = checkedInReplay.fixtures
      .filter(({ fixture }) => fixture.providerId === "pi")
      .map(({ fixture, bundle }) =>
        buildFixtureContextWindowSnapshot(
          bundle,
          `${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
        ),
      );

    expect(piSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of piSnapshots) {
      expect(snapshot.contextWindowUsage).not.toBeNull();
      expect(snapshot.tokenUsageSummary.nonNullModelContextWindowCount).toBeGreaterThan(0);
      expect(snapshot.tokenUsageSummary.distinctModelContextWindows.length).toBeGreaterThan(0);
    }
  });

  it("has no unresolved coverage issues in the checked-in fixtures", () => {
    expect(collectCoverageIssues(checkedInReplay)).toEqual({
      unexpectedUntranslatedFixtures: [],
      providersWithUnhandledEvents: [],
      unknownRawEventKinds: [],
      unknownObservedToolCalls: [],
    });
  });

  it("writes replay outputs on demand without mutating the checked-in fixtures", () => {
    const outputRoot = mkdtempSync(join(tmpdir(), "provider-audit-replay-"));
    TEMP_DIRS.push(outputRoot);

    const replayed = replayFixtures({
      fixtureRoot: fixtureRoot(),
      corpusId: "excalidraw",
      providerId: "claude-code",
      taskId: "search-feature",
      outputRoot,
    });

    expect(replayed.fixtures).toHaveLength(1);
    const replay = replayed.fixtures[0];
    expect(replay).toBeDefined();
    if (!replay?.outputDir) {
      throw new Error("Expected replay outputDir to be set");
    }

    const timelinePath = join(replay.outputDir, "timeline.txt");
    const rawProviderEventsPath = join(
      replay.outputDir,
      "raw-provider-events.json",
    );

    expect(existsSync(timelinePath)).toBe(true);
    expect(existsSync(rawProviderEventsPath)).toBe(true);

    const timeline = readFileSync(timelinePath, "utf8");
    expect(timeline).toContain("User");
    expect(timeline).toContain("Assistant");
  });

  it("replays Claude delegated child activity under the parent delegation", () => {
    const replayed = replayFixtures({
      fixtureRoot: fixtureRoot(),
      corpusId: "excalidraw",
      providerId: "claude-code",
      taskId: "search-bugfix",
    });

    expect(replayed.fixtures).toHaveLength(1);
    const replay = replayed.fixtures[0];
    expect(replay).toBeDefined();
    const delegation = replay?.bundle.viewMessages.find(
      (message): message is Extract<ViewMessage, { kind: "delegation" }> =>
        message.kind === "delegation",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.children.length).toBeGreaterThan(0);
    expect(
      delegation?.children.some(
        (child) => child.kind === "tool-exploring" || child.kind === "tool-call",
      ),
    ).toBe(true);
  });

  it("exports shared React story data for the checked-in fixtures", () => {
    const outputPath = join(
      mkdtempSync(join(tmpdir(), "provider-audit-ladle-")),
      "fixture-story-data.ts",
    );
    TEMP_DIRS.push(dirname(outputPath));

    const storyData = buildLadleStoryData({
      fixtureRoot: fixtureRoot(),
      corpusId: "excalidraw",
    });

    expect(
      storyData.fixtures.map((fixture) => ({
        id: fixture.id,
        latestActivityRowId: fixture.latestActivityRowId,
        timelineRowCount: fixture.timelineRowCount,
        viewMessageCount: fixture.viewMessageCount,
      })),
    ).toMatchSnapshot();

    const exportResult = exportLadleStoryData({
      fixtureRoot: fixtureRoot(),
      corpusId: "excalidraw",
      outputPath,
    });

    expect(exportResult.fixtureCount).toBe(storyData.fixtures.length);
    expect(readFileSync(outputPath, "utf8")).toContain("fixtureStoryData");
  });
});
