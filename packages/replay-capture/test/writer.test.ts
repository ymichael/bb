import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeCaptureEntry } from "@bb/agent-runtime/capture";
import type { ResolvedThreadExecutionOptions, ThreadEvent } from "@bb/domain";

const DEFAULT_TEST_EXECUTION: ResolvedThreadExecutionOptions = {
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
  source: "client/turn/requested",
};
import {
  isReplayCaptureId,
  replayCaptureDir,
  replayCaptureManifestPath,
  replayCaptureManifestSchema,
  replayRawProviderEventsPath,
} from "../src/index.js";
import { createReplayCaptureService } from "../src/writer.js";

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function turnStartedEvent(threadId: string): ThreadEvent {
  return {
    type: "turn/started",
    threadId,
    providerThreadId: "provider-thread-1",
    turnId: "turn-1",
  };
}

function turnCompletedEvent(threadId: string): ThreadEvent {
  return {
    type: "turn/completed",
    threadId,
    providerThreadId: "provider-thread-1",
    turnId: "turn-1",
    status: "completed",
  };
}

function agentMessageDeltaEvent(threadId: string): ThreadEvent {
  return {
    type: "item/agentMessage/delta",
    threadId,
    providerThreadId: "provider-thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    delta: "late usage",
  };
}

function replayRoot(dataDir: string): string {
  return path.join(dataDir, "replays");
}

async function listCaptureIds(dataDir: string): Promise<string[]> {
  return (await readdir(replayRoot(dataDir))).filter(isReplayCaptureId).sort();
}

async function captureIdForThread(
  dataDir: string,
  threadId: string,
): Promise<string> {
  for (const captureId of await listCaptureIds(dataDir)) {
    const manifest = await readCaptureManifest(dataDir, captureId);
    if (manifest.threadId === threadId) {
      return captureId;
    }
  }
  throw new Error(`No replay capture found for thread ${threadId}`);
}

async function captureIdsForThread(
  dataDir: string,
  threadId: string,
): Promise<string[]> {
  const captureIds: string[] = [];
  for (const captureId of await listCaptureIds(dataDir)) {
    const manifest = await readCaptureManifest(dataDir, captureId);
    if (manifest.threadId === threadId) {
      captureIds.push(captureId);
    }
  }
  return captureIds;
}

async function readCaptureManifest(dataDir: string, captureId: string) {
  return replayCaptureManifestSchema.parse(
    JSON.parse(
      await readFile(replayCaptureManifestPath(dataDir, captureId), "utf8"),
    ),
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

type ReplayCaptureServiceInstance = NonNullable<
  ReturnType<typeof createReplayCaptureService>
>;

interface CompleteCaptureArgs {
  completeAt: number;
  dataDir: string;
  mtimeSeconds?: number;
  service: ReplayCaptureServiceInstance;
  startAt: number;
  threadId: string;
}

interface RecordRawTranslatedThreadEventArgs {
  at: number;
  event: ThreadEvent;
  rawCaptureId: string;
  service: ReplayCaptureServiceInstance;
  threadId: string;
}

function recordStarted(
  service: ReplayCaptureServiceInstance,
  threadId: string,
  at: number,
): void {
  service.recordThreadMetadata({
    environmentId: `env-${threadId}`,
    projectId: `proj-${threadId}`,
    providerId: "codex",
    threadId,
    title: threadId,
  });
  service.recordTurnRequest({
    threadId,
    kind: "thread-start",
    input: [{ type: "text", text: `Hello from ${threadId}` }],
    execution: DEFAULT_TEST_EXECUTION,
  });
  service.recordThreadEvent({
    environmentId: `env-${threadId}`,
    threadId,
    event: turnStartedEvent(threadId),
    createdAt: at,
  });
}

function recordCompleted(
  service: ReplayCaptureServiceInstance,
  threadId: string,
  at: number,
): void {
  service.recordThreadEvent({
    environmentId: `env-${threadId}`,
    threadId,
    event: turnCompletedEvent(threadId),
    createdAt: at,
  });
}

function recordRawTranslatedThreadEvent(
  args: RecordRawTranslatedThreadEventArgs,
): void {
  args.service.recordRuntimeCaptureEntry({
    kind: "raw-provider-event",
    capturedAt: args.at,
    providerId: "codex",
    captureId: args.rawCaptureId,
    rawLine: "{}",
    rawEvent: {
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
    },
    sourceThreadId: "provider-thread-1",
  });
  args.service.recordRuntimeCaptureEntry({
    kind: "translated-thread-event",
    capturedAt: args.at,
    providerId: "codex",
    rawCaptureId: args.rawCaptureId,
    rawMethod: "item/agentMessage/delta",
    event: args.event,
  });
  args.service.recordThreadEvent({
    environmentId: `env-${args.threadId}`,
    threadId: args.threadId,
    event: args.event,
    createdAt: args.at,
  });
}

async function setCaptureDirMtime(
  dataDir: string,
  captureId: string,
  secondsSinceEpoch: number,
): Promise<void> {
  const timestamp = new Date(secondsSinceEpoch * 1_000);
  await utimes(replayCaptureDir(dataDir, captureId), timestamp, timestamp);
}

async function completeCapture(args: CompleteCaptureArgs): Promise<string> {
  recordStarted(args.service, args.threadId, args.startAt);
  recordCompleted(args.service, args.threadId, args.completeAt);
  await args.service.drain();
  const captureId = await captureIdForThread(args.dataDir, args.threadId);
  if (args.mtimeSeconds !== undefined) {
    await setCaptureDirMtime(args.dataDir, captureId, args.mtimeSeconds);
  }
  return captureId;
}

describe("createReplayCaptureService", () => {
  it("writes correlated raw provider capture files", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    const log = logger();
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: log,
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    service.recordThreadMetadata({
      environmentId: "env-1",
      projectId: "proj-1",
      providerId: "codex",
      threadId: "thr-1",
      title: "Original",
    });
    service.recordTurnRequest({
      threadId: "thr-1",
      kind: "thread-start",
      input: [{ type: "text", text: "Original prompt text" }],
      execution: DEFAULT_TEST_EXECUTION,
    });

    const rawEntry: AgentRuntimeCaptureEntry = {
      kind: "raw-provider-event",
      capturedAt: currentTime,
      providerId: "codex",
      captureId: "raw-1",
      rawLine: "{}",
      rawEvent: {
        jsonrpc: "2.0",
        method: "turn.started",
      },
      sourceThreadId: "provider-thread-1",
    };
    service.recordRuntimeCaptureEntry(rawEntry);

    const started = turnStartedEvent("thr-1");
    service.recordRuntimeCaptureEntry({
      kind: "translated-thread-event",
      capturedAt: currentTime,
      providerId: "codex",
      rawCaptureId: "raw-1",
      rawMethod: "turn.started",
      event: started,
    });
    service.recordThreadEvent({
      environmentId: "env-1",
      threadId: "thr-1",
      event: started,
      createdAt: currentTime,
    });

    currentTime = 1_050;
    service.recordThreadEvent({
      environmentId: "env-1",
      threadId: "thr-1",
      event: turnCompletedEvent("thr-1"),
      createdAt: currentTime,
    });
    await service.drain();

    const replayRoot = path.join(dataDir, "replays");
    const entries = await readdir(replayRoot);
    const captureId = entries.find((entry) => entry.startsWith("cap_"));
    expect(captureId).toBeDefined();
    if (!captureId) return;

    const manifest = replayCaptureManifestSchema.parse(
      JSON.parse(
        await readFile(
          path.join(replayRoot, captureId, "manifest.json"),
          "utf8",
        ),
      ),
    );
    expect(manifest.projectId).toBe("proj-1");
    expect(manifest.environmentId).toBe("env-1");
    expect(manifest.eventCounts.rawProviderEvents).toBe(1);
    expect(manifest.eventCounts.droppedRecords).toBe(0);
    expect(manifest.completedAt).toBe(1_050);
    expect(manifest.kind).toBe("thread-start");
    expect(manifest.userInput).toEqual([
      { type: "text", text: "Original prompt text" },
    ]);
    expect(manifest.userInputPreview).toBe("Original prompt text");

    const rawLines = (
      await readFile(replayRawProviderEventsPath(dataDir, captureId), "utf8")
    )
      .trim()
      .split("\n");
    expect(rawLines).toHaveLength(1);
  });

  it("skips capture creation when thread metadata is missing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    const log = logger();
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: log,
      now: () => 1_000,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    service.recordThreadEvent({
      environmentId: "env-no-metadata",
      threadId: "thr-no-metadata",
      event: turnStartedEvent("thr-no-metadata"),
      createdAt: 1_000,
    });
    await service.drain();

    expect(log.warn).toHaveBeenCalledWith(
      { threadId: "thr-no-metadata" },
      "skipping replay capture event without thread metadata",
    );
    if (await pathExists(replayRoot(dataDir))) {
      await expect(readdir(replayRoot(dataDir))).resolves.toEqual([]);
    }
  });

  it("skips capture creation when no turn request was buffered", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    const log = logger();
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: log,
      now: () => 1_000,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    service.recordThreadMetadata({
      environmentId: "env-no-request",
      projectId: "proj-no-request",
      providerId: "codex",
      threadId: "thr-no-request",
      title: "thr-no-request",
    });
    service.recordThreadEvent({
      environmentId: "env-no-request",
      threadId: "thr-no-request",
      event: turnStartedEvent("thr-no-request"),
      createdAt: 1_000,
    });
    await service.drain();

    expect(log.warn).toHaveBeenCalledWith(
      { threadId: "thr-no-request" },
      "skipping replay capture event without buffered turn request",
    );
    if (await pathExists(replayRoot(dataDir))) {
      await expect(readdir(replayRoot(dataDir))).resolves.toEqual([]);
    }
  });

  it("records the buffered turn request kind and input on the capture", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: logger(),
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    service.recordThreadMetadata({
      environmentId: "env-follow-up",
      projectId: "proj-follow-up",
      providerId: "codex",
      threadId: "thr-follow-up",
      title: "thr-follow-up",
    });
    service.recordTurnRequest({
      threadId: "thr-follow-up",
      kind: "turn-start",
      input: [
        { type: "text", text: "Follow-up question" },
        { type: "localFile", path: "/tmp/notes.md", name: "notes.md" },
      ],
      execution: DEFAULT_TEST_EXECUTION,
    });
    service.recordThreadEvent({
      environmentId: "env-follow-up",
      threadId: "thr-follow-up",
      event: turnStartedEvent("thr-follow-up"),
      createdAt: currentTime,
    });
    currentTime += 5;
    recordCompleted(service, "thr-follow-up", currentTime);
    await service.drain();

    const captureId = await captureIdForThread(dataDir, "thr-follow-up");
    const manifest = await readCaptureManifest(dataDir, captureId);
    expect(manifest.kind).toBe("turn-start");
    expect(manifest.userInput).toEqual([
      { type: "text", text: "Follow-up question" },
      { type: "localFile", path: "/tmp/notes.md", name: "notes.md" },
    ]);
    expect(manifest.userInputPreview).toBe(
      "Follow-up question [file: notes.md]",
    );
    expect(manifest.execution).toEqual(DEFAULT_TEST_EXECUTION);
  });

  it("only consumes the buffered request once per capture", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      finalizedCaptureGraceMs: 0,
      logger: logger(),
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    recordStarted(service, "thr-once", currentTime);
    currentTime += 5;
    recordCompleted(service, "thr-once", currentTime);
    await service.drain();
    const firstCaptureId = await captureIdForThread(dataDir, "thr-once");

    currentTime += 10;
    service.recordThreadEvent({
      environmentId: "env-thr-once",
      threadId: "thr-once",
      event: turnStartedEvent("thr-once"),
      createdAt: currentTime,
    });
    await service.drain();

    await expect(captureIdsForThread(dataDir, "thr-once")).resolves.toEqual([
      firstCaptureId,
    ]);
  });

  it("dedupes raw provider ids per capture instead of globally", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: logger(),
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    for (const threadId of ["thr-first", "thr-second"]) {
      service.recordThreadMetadata({
        environmentId: `env-${threadId}`,
        projectId: `proj-${threadId}`,
        providerId: "codex",
        threadId,
        title: threadId,
      });
      service.recordTurnRequest({
        threadId,
        kind: "thread-start",
        input: [{ type: "text", text: `prompt ${threadId}` }],
        execution: DEFAULT_TEST_EXECUTION,
      });
      service.recordRuntimeCaptureEntry({
        kind: "raw-provider-event",
        capturedAt: currentTime,
        providerId: "codex",
        captureId: "capture-1",
        rawLine: "{}",
        rawEvent: {
          jsonrpc: "2.0",
          method: "turn.started",
        },
        sourceThreadId: "provider-thread-1",
      });
      const started = turnStartedEvent(threadId);
      service.recordRuntimeCaptureEntry({
        kind: "translated-thread-event",
        capturedAt: currentTime,
        providerId: "codex",
        rawCaptureId: "capture-1",
        rawMethod: "turn.started",
        event: started,
      });
      service.recordThreadEvent({
        environmentId: `env-${threadId}`,
        threadId,
        event: started,
        createdAt: currentTime,
      });
      currentTime += 10;
      recordCompleted(service, threadId, currentTime);
      await service.drain();
      currentTime += 10;
    }

    for (const threadId of ["thr-first", "thr-second"]) {
      const captureId = await captureIdForThread(dataDir, threadId);
      const rawContent = await readFile(
        replayRawProviderEventsPath(dataDir, captureId),
        "utf8",
      );
      const rawLines =
        rawContent.trim().length > 0 ? rawContent.trim().split("\n") : [];
      expect(rawLines).toHaveLength(1);
      await expect(
        readCaptureManifest(dataDir, captureId),
      ).resolves.toMatchObject({
        eventCounts: {
          rawProviderEvents: 1,
        },
      });
    }
  });

  it("persists metadata that arrives after capture finalization", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: logger(),
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    recordStarted(service, "thr-late-metadata", currentTime);
    currentTime += 10;
    recordCompleted(service, "thr-late-metadata", currentTime);
    await service.drain();
    const captureId = await captureIdForThread(dataDir, "thr-late-metadata");

    service.recordThreadMetadata({
      environmentId: "env-late",
      projectId: "proj-late",
      providerId: "codex",
      threadId: "thr-late-metadata",
      title: "Late title",
    });
    await service.drain();

    await expect(
      readCaptureManifest(dataDir, captureId),
    ).resolves.toMatchObject({
      environmentId: "env-late",
      projectId: "proj-late",
      title: "Late title",
    });
  });

  it("appends trailing post-finalize events to the finalized capture", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      finalizedCaptureGraceMs: 100,
      logger: logger(),
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    recordStarted(service, "thr-trailing", currentTime);
    currentTime += 10;
    recordCompleted(service, "thr-trailing", currentTime);
    await service.drain();
    const captureId = await captureIdForThread(dataDir, "thr-trailing");

    currentTime += 10;
    recordRawTranslatedThreadEvent({
      at: currentTime,
      event: agentMessageDeltaEvent("thr-trailing"),
      rawCaptureId: "raw-late",
      service,
      threadId: "thr-trailing",
    });
    await service.drain();

    await expect(captureIdsForThread(dataDir, "thr-trailing")).resolves.toEqual(
      [captureId],
    );
    await expect(
      readCaptureManifest(dataDir, captureId),
    ).resolves.toMatchObject({
      completedAt: currentTime,
      eventCounts: {
        rawProviderEvents: 1,
      },
    });
    const rawLines = (
      await readFile(replayRawProviderEventsPath(dataDir, captureId), "utf8")
    )
      .trim()
      .split("\n");
    expect(rawLines).toHaveLength(1);
  });

  it("does not create a new capture for post-grace trailing events", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      finalizedCaptureGraceMs: 5,
      logger: logger(),
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    recordStarted(service, "thr-post-grace", currentTime);
    currentTime += 10;
    recordCompleted(service, "thr-post-grace", currentTime);
    await service.drain();
    const captureId = await captureIdForThread(dataDir, "thr-post-grace");

    currentTime += 10;
    recordRawTranslatedThreadEvent({
      at: currentTime,
      event: agentMessageDeltaEvent("thr-post-grace"),
      rawCaptureId: "raw-post-grace",
      service,
      threadId: "thr-post-grace",
    });
    await service.drain();

    await expect(
      captureIdsForThread(dataDir, "thr-post-grace"),
    ).resolves.toEqual([captureId]);
    await expect(
      readCaptureManifest(dataDir, captureId),
    ).resolves.toMatchObject({
      completedAt: 1_010,
      eventCounts: {
        rawProviderEvents: 0,
      },
    });
  });

  it("drops pending raw provider events when their capture finalizes", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: logger(),
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    service.recordRuntimeCaptureEntry({
      kind: "raw-provider-event",
      capturedAt: currentTime,
      providerId: "codex",
      captureId: "raw-stale",
      rawLine: "{}",
      rawEvent: {
        jsonrpc: "2.0",
        method: "turn.started",
      },
      sourceThreadId: "provider-thread-1",
    });
    recordStarted(service, "thr-pending-raw", currentTime);
    currentTime += 10;
    recordCompleted(service, "thr-pending-raw", currentTime);
    await service.drain();
    const firstCaptureId = await captureIdForThread(dataDir, "thr-pending-raw");

    currentTime += 10;
    service.recordThreadMetadata({
      environmentId: "env-thr-pending-raw",
      projectId: "proj-thr-pending-raw",
      providerId: "codex",
      threadId: "thr-pending-raw",
      title: "thr-pending-raw",
    });
    service.recordTurnRequest({
      threadId: "thr-pending-raw",
      kind: "turn-start",
      input: [{ type: "text", text: "second-turn" }],
      execution: DEFAULT_TEST_EXECUTION,
    });
    const started = turnStartedEvent("thr-pending-raw");
    service.recordRuntimeCaptureEntry({
      kind: "translated-thread-event",
      capturedAt: currentTime,
      providerId: "codex",
      rawCaptureId: "raw-stale",
      rawMethod: "turn.started",
      event: started,
    });
    service.recordThreadEvent({
      environmentId: "env-thr-pending-raw",
      threadId: "thr-pending-raw",
      event: started,
      createdAt: currentTime,
    });
    currentTime += 10;
    recordCompleted(service, "thr-pending-raw", currentTime);
    await service.drain();

    const secondCaptureId = (
      await captureIdsForThread(dataDir, "thr-pending-raw")
    ).find((captureId) => captureId !== firstCaptureId);
    expect(secondCaptureId).toBeDefined();
    if (!secondCaptureId) return;

    const rawContent = await readFile(
      replayRawProviderEventsPath(dataDir, secondCaptureId),
      "utf8",
    );
    expect(rawContent.trim()).toBe("");
  });

  it("caps capture file appends and records dropped records", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: logger(),
      maxCaptureFileBytes: 1,
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    service.recordThreadMetadata({
      environmentId: "env-thr-capped",
      projectId: "proj-thr-capped",
      providerId: "codex",
      threadId: "thr-capped",
      title: "thr-capped",
    });
    service.recordTurnRequest({
      threadId: "thr-capped",
      kind: "thread-start",
      input: [{ type: "text", text: "capped prompt" }],
      execution: DEFAULT_TEST_EXECUTION,
    });
    recordRawTranslatedThreadEvent({
      at: currentTime,
      event: agentMessageDeltaEvent("thr-capped"),
      rawCaptureId: "raw-capped",
      service,
      threadId: "thr-capped",
    });
    currentTime += 10;
    recordCompleted(service, "thr-capped", currentTime);
    await service.drain();
    const captureId = await captureIdForThread(dataDir, "thr-capped");

    await expect(
      readCaptureManifest(dataDir, captureId),
    ).resolves.toMatchObject({
      eventCounts: {
        rawProviderEvents: 0,
        droppedRecords: 1,
      },
    });
    const rawContent = await readFile(
      replayRawProviderEventsPath(dataDir, captureId),
      "utf8",
    );
    expect(rawContent).toBe("");
  });

  it("records dropped records and error messages when append writes fail", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    const log = logger();
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      logger: log,
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    recordStarted(service, "thr-append-failure", currentTime);
    await service.drain();
    const captureId = await captureIdForThread(dataDir, "thr-append-failure");
    const rawPath = replayRawProviderEventsPath(dataDir, captureId);
    await rm(rawPath);
    await mkdir(rawPath);

    currentTime += 10;
    recordRawTranslatedThreadEvent({
      at: currentTime,
      event: agentMessageDeltaEvent("thr-append-failure"),
      rawCaptureId: "raw-append-failure",
      service,
      threadId: "thr-append-failure",
    });
    await service.drain();

    const manifest = await readCaptureManifest(dataDir, captureId);
    expect(manifest.eventCounts.droppedRecords).toBe(1);
    expect(manifest.errorMessage).toContain("EISDIR");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        captureId,
        label: "append",
      }),
      "failed to write replay capture record",
    );
  });

  it("prunes the oldest finalized captures beyond maxCaptures", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      finalizedCaptureGraceMs: 0,
      logger: logger(),
      maxCaptures: 2,
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    const oldestCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      mtimeSeconds: 10,
      service,
      startAt: currentTime,
      threadId: "thr-oldest",
    });
    currentTime += 20;
    const middleCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      mtimeSeconds: 20,
      service,
      startAt: currentTime,
      threadId: "thr-middle",
    });
    currentTime += 20;
    const newestCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      service,
      startAt: currentTime,
      threadId: "thr-newest",
    });

    await expect(
      pathExists(replayCaptureDir(dataDir, oldestCaptureId)),
    ).resolves.toBe(false);
    await expect(
      pathExists(replayCaptureDir(dataDir, middleCaptureId)),
    ).resolves.toBe(true);
    await expect(
      pathExists(replayCaptureDir(dataDir, newestCaptureId)),
    ).resolves.toBe(true);
    await expect(listCaptureIds(dataDir)).resolves.toEqual(
      [middleCaptureId, newestCaptureId].sort(),
    );
  });

  it("does not write late metadata to pruned capture directories", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    const log = logger();
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      finalizedCaptureGraceMs: 0,
      logger: log,
      maxCaptures: 1,
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    const prunedCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      mtimeSeconds: 10,
      service,
      startAt: currentTime,
      threadId: "thr-pruned",
    });
    currentTime += 20;
    const retainedCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      service,
      startAt: currentTime,
      threadId: "thr-retained",
    });

    await expect(
      pathExists(replayCaptureDir(dataDir, prunedCaptureId)),
    ).resolves.toBe(false);
    await expect(
      pathExists(replayCaptureDir(dataDir, retainedCaptureId)),
    ).resolves.toBe(true);

    log.warn.mockClear();
    service.recordThreadMetadata({
      environmentId: "env-pruned-late",
      projectId: "proj-pruned-late",
      providerId: "codex",
      threadId: "thr-pruned",
      title: "Late pruned title",
    });
    await service.drain();

    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does not prune active captures when finalized siblings exceed retention", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-replay-capture-"));
    let currentTime = 1_000;
    const service = createReplayCaptureService({
      dataDir,
      enabled: true,
      finalizedCaptureGraceMs: 0,
      logger: logger(),
      maxCaptures: 2,
      now: () => currentTime,
    });
    expect(service).not.toBeNull();
    if (!service) return;

    recordStarted(service, "thr-active", currentTime);
    await service.drain();
    const activeCaptureId = await captureIdForThread(dataDir, "thr-active");
    await setCaptureDirMtime(dataDir, activeCaptureId, 1);

    currentTime += 10;
    const oldestCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      mtimeSeconds: 10,
      service,
      startAt: currentTime,
      threadId: "thr-oldest",
    });
    currentTime += 20;
    const middleCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      mtimeSeconds: 20,
      service,
      startAt: currentTime,
      threadId: "thr-middle",
    });
    currentTime += 20;
    const newestCaptureId = await completeCapture({
      completeAt: currentTime + 10,
      dataDir,
      service,
      startAt: currentTime,
      threadId: "thr-newest",
    });

    await expect(
      pathExists(replayCaptureDir(dataDir, activeCaptureId)),
    ).resolves.toBe(true);
    await expect(
      pathExists(replayCaptureDir(dataDir, oldestCaptureId)),
    ).resolves.toBe(false);
    await expect(
      pathExists(replayCaptureDir(dataDir, middleCaptureId)),
    ).resolves.toBe(true);
    await expect(
      pathExists(replayCaptureDir(dataDir, newestCaptureId)),
    ).resolves.toBe(true);
    await expect(listCaptureIds(dataDir)).resolves.toEqual(
      [activeCaptureId, middleCaptureId, newestCaptureId].sort(),
    );
  });
});
