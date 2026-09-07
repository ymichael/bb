import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_archive_idempotency_1";
const PROVIDER_THREAD_ID = "rollout-archive-idempotency-1";

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let processLogPath: string;

const sessionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-archive-ws-"));
  processLogPath = join(workspaceDir, "app-server-processes.log");
  const fakeScriptPath = join(workspaceDir, "fake-codex-script.json");
  writeFileSync(
    fakeScriptPath,
    JSON.stringify({
      archiveStatePath: join(workspaceDir, "fake-codex-archived.json"),
      processLogPath,
      sigtermDelayMs: 250,
    }),
  );
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath, fakeScriptPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(() => {
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function request(id: number, method: string) {
  harness.sendRequest(id, method, {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
  });
  return harness.waitForResponse(id);
}

function processStepCount(step: string): number {
  return readFileSync(processLogPath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`${step}:`)).length;
}

it("finishes each app-server handoff before acknowledging archive and unarchive", async () => {
  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: sessionOptions,
  });
  expect((await harness.waitForResponse(1)).error).toBeUndefined();

  expect((await request(2, "thread/archive")).result).toEqual({ ok: true });
  expect(processStepCount("spawn")).toBe(1);
  expect(processStepCount("exit")).toBe(1);

  expect((await request(3, "thread/unarchive")).result).toEqual({ ok: true });
  expect(processStepCount("spawn")).toBe(2);
  expect(processStepCount("exit")).toBe(2);
}, 30_000);

it("answers a repeated archive and a repeated unarchive as already done", async () => {
  expect((await request(1, "thread/archive")).result).toEqual({ ok: true });
  expect((await request(2, "thread/archive")).result).toEqual({ ok: true });
  expect((await request(3, "thread/unarchive")).result).toEqual({ ok: true });
  expect((await request(4, "thread/unarchive")).result).toEqual({ ok: true });
}, 30_000);

it("keeps a discard of an already-archived rollout as a failure", async () => {
  expect((await request(1, "thread/archive")).result).toEqual({ ok: true });

  const response = await request(2, "thread/discard");
  expect(response.result).toBeUndefined();
  expect(response.error?.message).toBe(
    `no rollout found for thread id ${PROVIDER_THREAD_ID}`,
  );
}, 30_000);
