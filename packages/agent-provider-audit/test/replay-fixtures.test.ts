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
let checkedInArtifact: ProviderAuditReplayBuildArtifact;

type ReplayBuildSummary = ProviderAuditReplayBuildArtifact["summaries"][number];
type ReplayBuildPrefixSnapshot =
  ProviderAuditReplayBuildArtifact["timelinePrefixSnapshots"][number];

function fixtureRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
}

function escapeNonAsciiSnapshotCharacter(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) {
    return "";
  }
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
}

function normalizeTimelineSnapshotText(text: string): string {
  return text
    .replaceAll("\u2500", "-")
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'")
    .replaceAll("\u201C", '"')
    .replaceAll("\u201D", '"')
    .replaceAll("\u2013", "-")
    .replaceAll("\u2014", "-")
    .replaceAll("\u2026", "...")
    .replaceAll("\u00A0", " ")
    .replaceAll("\u00B7", ".")
    .replaceAll("\u00D7", "x")
    .replaceAll("\u23CE", "<newline>")
    .replaceAll("\u2713", "[ok]")
    .replace(/[^\x00-\x7F]/gu, escapeNonAsciiSnapshotCharacter)
    .replaceAll("\t", "  ")
    .replace(/[ \t]+$/u, "");
}

function compactTimelineSnapshotText(text: string): string {
  return normalizeTimelineSnapshotText(text);
}

function compactTimelinePreview(lines: string[]): string[] {
  return lines.map(normalizeTimelineSnapshotText);
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

  it("normalizes UTF-8 punctuation in review snapshots", () => {
    expect(
      compactTimelineSnapshotText(
        "I\u2019m checking \u201Cquoted\u201D text \u2014 then truncating\u2026 \u2713 \u23CE\u00B7\u00B7 \u00D7 \u03C0 \u{1F642}",
      ),
    ).toBe(
      `I'm checking "quoted" text - then truncating... [ok] <newline>.. x <U+03C0> <U+1F642>`,
    );
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

  it("checks one verbose replay without audit truncation", () => {
    const replayed = replayFixtures({
      fixtureRoot: fixtureRoot(),
      corpusId: "excalidraw",
      providerId: "codex",
      taskId: "command-output-recovery",
    });

    expect(replayed.fixtures).toHaveLength(1);
    const replay = replayed.fixtures[0];
    expect(replay).toBeDefined();
    if (!replay) {
      throw new Error("Expected command-output-recovery replay");
    }

    const verboseText = compactTimelineSnapshotText(
      replay.bundle.timelineVerboseText,
    );
    expect(verboseText).not.toContain("[truncated");
    expect(verboseText).toContain(
      "Use your real shell tool, preserve the full command output",
    );
    expect(verboseText).toContain("FIRST");
    expect(verboseText).toContain("SECOND");
    expect(verboseText).toContain("THIRD");
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

    const activeSubagentPrefix =
      checkedInArtifact.timelinePrefixSnapshots.find(
        (snapshot) =>
          snapshot.fixture === "excalidraw/claude-code/search-feature" &&
          snapshot.threadStatus === "active" &&
          snapshot.timelinePreview.some((line) =>
            line.includes("Running 1 subagent"),
          ),
      );
    expect(activeSubagentPrefix).toBeDefined();
    expect(activeSubagentPrefix?.lastEventType).toBe("item/started");
    expect(activeSubagentPrefix?.semanticTimelineRowCount).toBeGreaterThan(0);
    expect(activeSubagentPrefix?.renderedTimelineRowCount).toBeGreaterThan(0);

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
    expect(delegation?.childRowCount).toBeGreaterThan(0);
    expect(delegation?.hasChildToolActivity).toBe(true);
  });

  it("exports generated fixture data for the checked-in fixtures", () => {
    const storyData = checkedInArtifact.ladleStoryData;

    expect(
      storyData.fixtures.map((fixture) => ({
        id: fixture.id,
        renderedTimelineRowCount: fixture.renderedTimelineRowCount,
        semanticTimelineRowCount: fixture.semanticTimelineRowCount,
      })),
    ).toMatchSnapshot();

    expect(existsSync(DEFAULT_LADLE_OUTPUT_PATH)).toBe(true);
    expect(readFileSync(DEFAULT_LADLE_OUTPUT_PATH, "utf8")).toContain(
      "fixtureStoryData",
    );
  }, 60_000);
});
