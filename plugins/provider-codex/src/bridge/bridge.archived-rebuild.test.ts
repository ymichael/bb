import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcOutputMessage } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_archived_rebuild_1";
const PROVIDER_THREAD_ID = "rebuild-rollout-1";
const ARCHIVED_ERROR_TEXT = `session ${PROVIDER_THREAD_ID} is archived; unarchive it and retry`;

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

const sessionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  reasoningLevel: "low",
} as const;

const changedSessionOptions = {
  ...sessionOptions,
  reasoningLevel: "high",
} as const;

const turnInput = [{ type: "text", text: "hello", mentions: [] }];

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let archiveStatePath: string;
let processLogPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-archived-rebuild-"));
  archiveStatePath = join(workspaceDir, "fake-codex-archived.json");
  processLogPath = join(workspaceDir, "app-server-processes.log");
  const scriptPath = join(workspaceDir, "fake-codex-script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({ archiveStatePath, processLogPath }),
  );
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath, scriptPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 993_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  await waitForAppServerChildrenToExit();
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function spawnedAppServerPids(): number[] {
  return readFileSync(processLogPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("spawn:"))
    .map((line) => Number(line.split(":")[1]));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForAppServerChildrenToExit(): Promise<void> {
  const childPids = spawnedAppServerPids();
  const deadline = Date.now() + 15_000;
  while (childPids.some(processIsAlive)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for app-server children to exit: ${JSON.stringify(childPids.filter(processIsAlive))}`,
      );
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
}

async function resumeThread(): Promise<void> {
  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: sessionOptions,
  });
  const response = await harness.waitForResponse(1);
  expect(response.error).toBeUndefined();
}

function archiveOutsideBb(): void {
  writeFileSync(archiveStatePath, JSON.stringify([PROVIDER_THREAD_ID]));
}

async function startTurn(
  id: number,
  options: typeof sessionOptions | typeof changedSessionOptions,
): Promise<BridgeJsonRpcOutputMessage> {
  harness.sendRequest(id, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    clientRequestId: "creq_abcdefghjk",
    input: turnInput,
    options,
  });
  return harness.waitForResponse(id);
}

function sessionReplacedNotifications(): BridgeJsonRpcOutputMessage[] {
  return harness.messages.filter(
    (message) => message.method === "session/replaced",
  );
}

async function waitForTurnBoundary(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const settled = harness.messages.some(
      (message) =>
        message.method === "thread/delta" &&
        JSON.stringify(message.params).includes('"turn.boundary"'),
    );
    if (settled) {
      return;
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
  throw new Error("Timed out waiting for the turn to settle");
}

async function expectArchivedHint(
  response: BridgeJsonRpcOutputMessage,
): Promise<void> {
  expect(response.result).toBeUndefined();
  expect(response.error?.message).toBe(ARCHIVED_ERROR_TEXT);
  expect(response.error?.data).toEqual({
    recovery: {
      kind: "sessionArchived",
      message: ARCHIVED_ERROR_TEXT,
      retryable: true,
    },
  });
  expect(sessionReplacedNotifications()).toEqual([]);
}

async function expectRetryAfterUnarchiveSucceeds(
  options: typeof sessionOptions | typeof changedSessionOptions,
): Promise<void> {
  harness.sendRequest(3, "thread/unarchive", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
  });
  expect((await harness.waitForResponse(3)).error).toBeUndefined();

  const retried = await startTurn(4, options);
  expect(retried.error).toBeUndefined();
  expect(retried.result).toEqual({ threadId: THREAD_ID });
  expect(sessionReplacedNotifications()).toHaveLength(1);
  expect(sessionReplacedNotifications()[0]?.params).toMatchObject({
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    contextLost: false,
  });
  await waitForTurnBoundary();
}

it("keeps the thread resumable when a settings-change rebuild hits an externally archived rollout", async () => {
  await resumeThread();
  archiveOutsideBb();

  await expectArchivedHint(await startTurn(2, changedSessionOptions));
  await expectRetryAfterUnarchiveSucceeds(changedSessionOptions);
}, 30_000);

it("keeps the thread resumable when the rebuild after the child died hits an externally archived rollout", async () => {
  await resumeThread();
  const spawnLine = readFileSync(processLogPath, "utf8")
    .split("\n")
    .find((line) => line.startsWith("spawn:"));
  const childPid = Number(spawnLine?.split(":")[1]);
  expect(Number.isInteger(childPid)).toBe(true);
  process.kill(childPid, "SIGKILL");
  const deadline = Date.now() + 15_000;
  while (
    !harness.messages.some(
      (message) =>
        message.method === "error" &&
        JSON.stringify(message.params).includes("exited unexpectedly"),
    )
  ) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the child exit report");
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
  archiveOutsideBb();

  await expectArchivedHint(await startTurn(2, sessionOptions));
  await expectRetryAfterUnarchiveSucceeds(sessionOptions);
}, 30_000);
