import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ProviderAuditReplayBuildArtifact } from "../src/build-artifacts.js";
import { loadProviderAuditReplayBuildArtifact } from "../src/build-artifacts.js";
import { replayFixtures } from "../src/replay.js";
import { DEFAULT_LADLE_OUTPUT_PATH } from "../src/visual-audit.js";

const TEMP_DIRS: string[] = [];
const SNAPSHOT_BODY_LINE_LIMIT = 3;
const SNAPSHOT_LINE_LENGTH_LIMIT = 100;
let checkedInArtifact: ProviderAuditReplayBuildArtifact;

type ReplayBuildSummary = ProviderAuditReplayBuildArtifact["summaries"][number];
type ReplayBuildPrefixSnapshot =
  ProviderAuditReplayBuildArtifact["timelinePrefixSnapshots"][number];

function fixtureRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
}

function normalizeTimelineSnapshotText(text: string): string {
  return text.replaceAll("─", "-");
}

function isTimelineHeaderLine(line: string): boolean {
  return line.trimStart().startsWith("-- ");
}

function truncateSnapshotLine(line: string): string {
  if (line.length <= SNAPSHOT_LINE_LENGTH_LIMIT) {
    return line;
  }

  const omittedCharacterCount = line.length - SNAPSHOT_LINE_LENGTH_LIMIT;
  return `${line.slice(0, SNAPSHOT_LINE_LENGTH_LIMIT)}... [truncated ${omittedCharacterCount} chars]`;
}

function truncatedLinesNotice(skippedLineCount: number): string {
  return `  ... [truncated ${skippedLineCount} lines]`;
}

function compactTimelineSnapshotLines(lines: string[]): string[] {
  const compacted: string[] = [];
  let bodyLineCount = 0;
  let skippedLineCount = 0;

  function flushSkippedLines(): void {
    if (skippedLineCount === 0) {
      return;
    }
    compacted.push(truncatedLinesNotice(skippedLineCount));
    skippedLineCount = 0;
  }

  for (const line of lines) {
    const normalizedLine = normalizeTimelineSnapshotText(line);
    if (isTimelineHeaderLine(normalizedLine)) {
      flushSkippedLines();
      bodyLineCount = 0;
      compacted.push(truncateSnapshotLine(normalizedLine));
      continue;
    }

    bodyLineCount += 1;
    if (bodyLineCount <= SNAPSHOT_BODY_LINE_LIMIT) {
      compacted.push(truncateSnapshotLine(normalizedLine));
      continue;
    }

    skippedLineCount += 1;
  }

  flushSkippedLines();
  return compacted;
}

function compactTimelineSnapshotText(text: string): string {
  return compactTimelineSnapshotLines(text.split("\n")).join("\n");
}

function compactTimelinePreview(lines: string[]): string[] {
  return compactTimelineSnapshotLines(lines);
}

function compactSummarySnapshot(
  summary: ReplayBuildSummary,
): ReplayBuildSummary {
  return {
    ...summary,
    timelinePreview: compactTimelinePreview(summary.timelinePreview),
  };
}

function compactPrefixSnapshot(
  snapshot: ReplayBuildPrefixSnapshot,
): ReplayBuildPrefixSnapshot {
  return {
    ...snapshot,
    timelinePreview: compactTimelinePreview(snapshot.timelinePreview),
  };
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0, TEMP_DIRS.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("@bb/agent-provider-audit fixture replay", () => {
  beforeAll(() => {
    checkedInArtifact = loadProviderAuditReplayBuildArtifact();
  });

  it("replays every checked-in fixture into stable summaries", () => {
    expect(checkedInArtifact.fixtureCount).toBeGreaterThan(0);

    for (const summary of checkedInArtifact.summaries) {
      expect(
        summary.translatedThreadEventCount,
        `Expected translated events for ${summary.fixture}`,
      ).toBeGreaterThan(0);
      expect(
        summary.unexpectedUntranslatedRawEventCount,
        `Expected zero unexpected untranslated raw events for ${summary.fixture}`,
      ).toBe(0);
    }

    expect(
      checkedInArtifact.summaries.map(compactSummarySnapshot),
    ).toMatchSnapshot();
  });

  it("snapshots readable verbose CLI timeline structure for every fixture", () => {
    for (const timeline of checkedInArtifact.verboseTimelines) {
      expect(compactTimelineSnapshotText(timeline.text)).toMatchSnapshot(
        timeline.fixture,
      );
    }
  });

  it("snapshots streaming prefix timeline structure for every fixture", () => {
    expect(checkedInArtifact.timelinePrefixSnapshots.length).toBeGreaterThan(0);
    expect(
      checkedInArtifact.timelinePrefixSnapshots.some(
        (snapshot) => snapshot.threadStatus === "active",
      ),
    ).toBe(true);
    expect(
      checkedInArtifact.timelinePrefixSnapshots.some(
        (snapshot) => snapshot.threadStatus === "idle",
      ),
    ).toBe(true);

    expect(
      checkedInArtifact.timelinePrefixSnapshots.map(compactPrefixSnapshot),
    ).toMatchSnapshot();
  });

  it("summarizes raw-event and tool-call coverage across the checked-in fixtures", () => {
    expect(checkedInArtifact.coverageSummary).toMatchSnapshot();
  });

  it("snapshots parsed context-window data for replayed token-usage events", () => {
    const contextWindowSnapshotRows =
      checkedInArtifact.contextWindowSnapshots.map((snapshot) => ({
        contextWindowUsage: snapshot.contextWindowUsage,
        fixture: snapshot.fixture,
        tokenUsageSummary: snapshot.tokenUsageSummary,
      }));

    expect(contextWindowSnapshotRows).toMatchSnapshot();
  });

  it("replayed Pi fixtures preserve model context-window metadata even without bridge-side usage samples", () => {
    const piSnapshots = checkedInArtifact.contextWindowSnapshots.filter(
      (snapshot) => snapshot.providerId === "pi",
    );

    expect(piSnapshots.length).toBeGreaterThan(0);
    for (const snapshot of piSnapshots) {
      expect(snapshot.contextWindowUsage).toBeNull();
      expect(
        snapshot.tokenUsageSummary.nonNullModelContextWindowCount,
      ).toBeGreaterThan(0);
      expect(
        snapshot.tokenUsageSummary.distinctModelContextWindows.length,
      ).toBeGreaterThan(0);
    }
  });

  it("has no unresolved coverage issues in the checked-in fixtures", () => {
    expect(checkedInArtifact.coverageIssues).toEqual({
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
  }, 30_000);

  it("replays Claude delegated child activity under the parent delegation", () => {
    const delegation = checkedInArtifact.delegationSnapshots.find(
      (snapshot) => snapshot.fixture === "excalidraw/claude-code/search-bugfix",
    );

    expect(delegation).toBeDefined();
    expect(delegation?.childMessageCount).toBeGreaterThan(0);
    expect(delegation?.hasChildToolActivity).toBe(true);
  });

  it("exports shared React story data for the checked-in fixtures", () => {
    const storyData = checkedInArtifact.ladleStoryData;

    expect(
      storyData.fixtures.map((fixture) => ({
        id: fixture.id,
        latestActivityRowId: fixture.latestActivityRowId,
        timelineRowCount: fixture.timelineRowCount,
        viewMessageCount: fixture.viewMessageCount,
      })),
    ).toMatchSnapshot();

    expect(existsSync(DEFAULT_LADLE_OUTPUT_PATH)).toBe(true);
    expect(readFileSync(DEFAULT_LADLE_OUTPUT_PATH, "utf8")).toContain(
      "fixtureStoryData",
    );
  }, 60_000);
});
