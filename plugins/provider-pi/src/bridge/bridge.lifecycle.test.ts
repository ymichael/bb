import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  experimental_closeAllForTests,
  experimental_scratchDirForTests,
} from "./bridge.js";
import {
  FULL_PERMISSION_OPTIONS,
  type FakePiBridgeHarness,
  startFakePiBridge,
} from "./test-support.js";

let harness: FakePiBridgeHarness;

beforeEach(async () => {
  harness = await startFakePiBridge({
    prefix: "bb-pi-lifecycle-",
    initialize: true,
    processLog: true,
  });
}, 90_000);

afterEach(async () => {
  await harness.teardown();
}, 90_000);

let nextId = 1000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectEveryChildGone(expectedSpawns: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const log = harness.readProcessLog();
    const allExited =
      log.spawned.length >= expectedSpawns &&
      log.spawned.every((pid) => log.exited.includes(pid) && !isAlive(pid));
    if (allExited) {
      expect(log.spawned.length).toBe(expectedSpawns);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `pi children still running: spawned ${JSON.stringify(log.spawned)}, exited ${JSON.stringify(log.exited)}, alive ${JSON.stringify(log.spawned.filter(isAlive))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startThread(threadId: string): Promise<void> {
  const response = await harness.startThread(threadId, {
    dynamicTools: [
      {
        name: "bb_probe",
        description: "A bb tool.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ],
  });
  expect(response.result).toMatchObject({ providerThreadId: threadId });
}

it("stop{release} ends the child", async () => {
  await startThread("thr_lc_release");
  await harness.request((nextId += 1), "turn/start", {
    threadId: "thr_lc_release",
    providerThreadId: "thr_lc_release",
    clientRequestId: "creq_ab23456789",
    input: [{ type: "text", text: "hello", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  await harness.waitForTurnBoundary("thr_lc_release", 0);
  const stop = await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_release",
    providerThreadId: "thr_lc_release",
    intent: "release",
    activeTurnId: null,
  });
  expect(stop.result).toMatchObject({
    ok: true,
    providerCheckpointId: "leaf-1",
  });
  await expectEveryChildGone(1);
}, 90_000);

it("stop{interrupt} of a live run ends the child, and the turn settled before the result", async () => {
  await startThread("thr_lc_interrupt");
  await harness.request((nextId += 1), "turn/start", {
    threadId: "thr_lc_interrupt",
    providerThreadId: "thr_lc_interrupt",
    clientRequestId: "creq_cd23456789",
    input: [{ type: "text", text: "/hold", mentions: [] }],
    options: FULL_PERMISSION_OPTIONS,
  });
  const stop = await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_interrupt",
    providerThreadId: "thr_lc_interrupt",
    intent: "interrupt",
    activeTurnId: "turn-1",
  });
  expect(stop.result).toMatchObject({ ok: true });
  await expectEveryChildGone(1);
}, 90_000);

it("discard ends the child and removes the session file", async () => {
  await startThread("thr_lc_discard");
  const sessionFile = join(
    harness.workspaceDir,
    "sessions",
    "thr_lc_discard.jsonl",
  );
  expect(existsSync(sessionFile)).toBe(true);
  const discard = await harness.request((nextId += 1), "thread/discard", {
    threadId: "thr_lc_discard",
    providerThreadId: "thr_lc_discard",
  });
  expect(discard.result).toEqual({ ok: true });
  expect(existsSync(sessionFile)).toBe(false);
  await expectEveryChildGone(1);
}, 90_000);

it("a failed construction leaves no child", async () => {
  vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", "1");
  const response = await harness.request((nextId += 1), "thread/start", {
    threadId: "thr_lc_failed",
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: FULL_PERMISSION_OPTIONS,
  });
  expect(response.error).toMatchObject({
    message: expect.stringContaining("pi exited"),
  });
  const log = harness.readProcessLog();
  expect(log.spawned).toHaveLength(1);
  await expectEveryChildGone(1);
}, 90_000);

it("the fork helper child exits once the fork is done", async () => {
  const sessionDir = join(harness.workspaceDir, "sessions");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const source = SessionManager.create(harness.workspaceDir, sessionDir);
  source.appendMessage({ role: "user", content: "first", timestamp: 1 });
  source.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ready" }],
    api: "openai-responses",
    provider: "fake-provider",
    model: "fake-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const sourceFile = source.getSessionFile()!;
  const sourceBefore = readFileSync(sourceFile, "utf8");
  mkdirSync(sessionDir, { recursive: true });
  copyFileSync(sourceFile, join(sessionDir, "thr_lc_src.jsonl"));
  const forkResponse = await harness.request((nextId += 1), "thread/fork", {
    threadId: "thr_lc_fork",
    cwd: harness.workspaceDir,
    sourceProviderThreadId: "thr_lc_src",
    options: FULL_PERMISSION_OPTIONS,
    instructionMode: "append",
  });
  expect(forkResponse.result).toMatchObject({
    providerThreadId: "thr_lc_fork",
  });
  expect(readFileSync(join(sessionDir, "thr_lc_src.jsonl"), "utf8")).toBe(
    sourceBefore,
  );
  expect(existsSync(join(sessionDir, "thr_lc_fork.jsonl"))).toBe(true);
  await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_fork",
    providerThreadId: "thr_lc_fork",
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(2);
}, 90_000);

function scratchFiles(): string[] {
  return readdirSync(experimental_scratchDirForTests())
    .filter((name) => name !== "bb-pi-extension.mjs")
    .sort();
}

async function expectScratchFilesGone(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (scratchFiles().length > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `scratch files left behind: ${scratchFiles().join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

it("accepts a prompt containing only a local image", async () => {
  const threadId = "thr_image_only";
  await harness.startThread(threadId);
  const imagePath = join(harness.workspaceDir, "screenshot.png");
  writeFileSync(imagePath, Buffer.from("fake png data"));

  const response = await harness.request(2, "turn/start", {
    threadId,
    providerThreadId: threadId,
    clientRequestId: "creq_234567abcd",
    input: [{ type: "localImage", path: imagePath, mimeType: "image/png" }],
    options: FULL_PERMISSION_OPTIONS,
  });

  expect(response.result).toEqual({ threadId });
  await harness.waitForTurnBoundary(threadId);
  expect(
    harness.deltasOf(threadId).some(
      (delta) => delta.kind === "item.textDelta" && delta.text === "Response to: ",
    ),
  ).toBe(true);
});

it("a child's tool and prompt files go with the child after release and failed construction", async () => {
  await harness.startThread("thr_lc_scratch", {
    options: { ...FULL_PERMISSION_OPTIONS, instructions: "be brief" },
    dynamicTools: [
      {
        name: "bb_probe",
        description: "A bb tool.",
        inputSchema: { type: "object" },
      },
    ],
  });
  expect(scratchFiles()).toEqual([
    expect.stringMatching(/^pi-append-.*\.md$/),
    expect.stringMatching(/^pi-tools-.*\.json$/),
  ]);
  await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_scratch",
    providerThreadId: "thr_lc_scratch",
    intent: "release",
    activeTurnId: null,
  });
  await expectEveryChildGone(1);
  await expectScratchFilesGone();

  vi.stubEnv("FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE", "1");
  const failed = await harness.request((nextId += 1), "thread/start", {
    threadId: "thr_lc_scratch_failed",
    cwd: harness.workspaceDir,
    instructionMode: "append",
    options: { ...FULL_PERMISSION_OPTIONS, instructions: "be brief" },
  });
  expect(failed.error).toBeDefined();
  const log = harness.readProcessLog();
  expect(log.spawned).toHaveLength(2);
  await expectEveryChildGone(2);
  await expectScratchFilesGone();
}, 60_000);

it("closing the catalog waits for its child to exit", async () => {
  const models = await harness.request((nextId += 1), "model/list", {
    cwd: harness.workspaceDir,
  });
  expect(models.result).toMatchObject({ models: expect.any(Array) });
  await experimental_closeAllForTests();
  const log = harness.readProcessLog();
  expect(log.spawned).toHaveLength(1);
  expect(log.exited).toContain(log.spawned[0]);
  expect(log.spawned.some(isAlive)).toBe(false);
}, 90_000);

it("a child that ignores EOF and SIGTERM is SIGKILLed", async () => {
  vi.stubEnv("FAKE_PI_HANG_ON_CLOSE", "1");
  await startThread("thr_lc_kill");
  const { spawned } = harness.readProcessLog();
  const pid = spawned[0]!;
  const stop = await harness.request((nextId += 1), "thread/stop", {
    threadId: "thr_lc_kill",
    providerThreadId: "thr_lc_kill",
    intent: "release",
    activeTurnId: null,
  });
  expect(stop.result).toMatchObject({ ok: true });
  expect(isAlive(pid)).toBe(true);
  const deadline = Date.now() + 15_000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(isAlive(pid)).toBe(false);
}, 90_000);
