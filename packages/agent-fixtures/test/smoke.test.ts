import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPLAY_CAPTURE_SCHEMA_VERSION,
  createReplayCaptureId,
} from "@bb/replay-capture";
import type {
  ReplayCaptureManifest,
  ReplayRawProviderEventRecord,
} from "@bb/replay-capture/schema";
import {
  deriveReplayCaptureUserInputPreview,
  writeFixture,
} from "@bb/replay-capture/writer";
import {
  defaultFixtureRoot,
  listFixtureBundles,
  readFixtureBundle,
} from "../src/load.js";
import { promoteCaptureToFixture } from "../src/promote.js";
import { replayFixtures } from "../src/replay.js";

// The checked-in corpus is large enough to exceed Vitest's 5s default on
// Ubuntu CI when the full Turbo graph is running in parallel.
const CORPUS_SMOKE_TEST_TIMEOUT_MS = 30_000;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function replayManifest(captureId: string): ReplayCaptureManifest {
  const userInput: ReplayCaptureManifest["turns"][number]["userInput"] = [
    { type: "text", text: "Promote this capture" },
  ];
  return {
    schemaVersion: REPLAY_CAPTURE_SCHEMA_VERSION,
    captureId,
    capturedAt: 1000,
    completedAt: 1200,
    source: "live-dev-capture",
    providerId: "codex",
    projectId: "project-1",
    environmentId: "environment-1",
    threadId: "thread-1",
    providerThreadId: null,
    title: "Live capture",
    kind: "thread-start",
    turns: [{ turnId: "turn-1", userInput, createdAt: 1000 }],
    userInputPreview: deriveReplayCaptureUserInputPreview(userInput),
    execution: {
      model: "gpt-test",
      serviceTier: "fast",
      reasoningLevel: "medium",
      permissionMode: "full",
      source: "client/turn/requested",
    },
    eventCounts: {
      rawProviderEvents: 1,
      droppedRecords: 0,
    },
    errorMessage: null,
  };
}

function rawProviderEventRecord(): ReplayRawProviderEventRecord {
  return {
    ordinal: 1,
    relativeMs: 10,
    entry: {
      kind: "raw-provider-event",
      captureId: "raw-1",
      capturedAt: 1010,
      providerId: "codex",
      rawLine: '{"method":"turn/completed"}',
      rawEvent: {
        jsonrpc: "2.0",
        method: "turn/completed",
      },
    },
  };
}

describe("@bb/agent-fixtures corpus smoke test", () => {
  it("loads every checked-in fixture without error", () => {
    const bundles = listFixtureBundles({ fixtureRoot: defaultFixtureRoot() });
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      expect(bundle.manifest.schemaVersion).toBe(3);
    }
  }, CORPUS_SMOKE_TEST_TIMEOUT_MS);

  it("returns no fixtures for a missing custom root", () => {
    const missingRoot = join(
      tempDir("agent-fixtures-missing-root-"),
      "missing",
    );

    expect(listFixtureBundles({ fixtureRoot: missingRoot })).toEqual([]);
  });

  it("replays a representative fixture without throwing", () => {
    const result = replayFixtures({
      fixtureRoot: defaultFixtureRoot(),
      corpusId: "excalidraw",
      providerId: "claude-code",
      taskId: "search-feature",
    });
    expect(result.fixtures).toHaveLength(1);
    expect(result.fixtures[0]?.bundle.timelineRows.length).toBeGreaterThan(0);
  }, CORPUS_SMOKE_TEST_TIMEOUT_MS);

  it("promotes a synthetic capture to a fixture", async () => {
    const dataDir = tempDir("agent-fixtures-replays-");
    const replayRoot = join(dataDir, "replays");
    const fixtureRoot = tempDir("agent-fixtures-corpus-");
    const captureId = createReplayCaptureId(1000, "aaaaaaaa");

    await writeFixture({
      destinationDir: join(replayRoot, captureId),
      manifest: replayManifest(captureId),
      rawProviderEventRecords: [rawProviderEventRecord()],
    });

    const result = await promoteCaptureToFixture({
      captureId,
      replayRoot,
      corpusContext: {
        fixtureRoot,
        corpusId: "synthetic",
        taskId: "promoted-task",
        scenarioId: "promoted-task",
        scenarioDescription: "Promoted synthetic capture",
        model: "gpt-test",
        gitSha: null,
        gitResetRef: null,
        workspacePath: "$WORKSPACE",
        runtimeWorkspacePath: "$WORKSPACE",
        envWorkspacePath: "$WORKSPACE",
        runtimeWorkspaceGitStart: null,
        runtimeWorkspaceGitEnd: null,
      },
    });

    const bundle = readFixtureBundle({
      corpusId: "synthetic",
      providerId: "codex",
      taskId: "promoted-task",
      fixturePath: result.destDir,
    });
    expect(bundle.manifest.source).toBe("corpus-fixture");
    expect(bundle.rawProviderEventRecords).toHaveLength(1);
  });
});
