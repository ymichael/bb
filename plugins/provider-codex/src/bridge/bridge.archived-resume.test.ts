import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BRIDGE_JSON_RPC_ERRORS } from "@bb/provider-bridge-protocol";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_archived_resume_1";
const ARCHIVED_PROVIDER_THREAD_ID = "archived-prov-1";
const ARCHIVED_ERROR_TEXT = `session ${ARCHIVED_PROVIDER_THREAD_ID} is archived; unarchive it and retry`;

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

const sessionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let processLogPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-archived-ws-"));
  processLogPath = join(workspaceDir, "app-server-processes.log");
  const scriptPath = join(workspaceDir, "fake-codex-script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({ processLogPath, sigtermDelayMs: 250 }),
  );
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath, scriptPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 992_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "archived-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("preserves the archived-session error text verbatim on a rejected resume", async () => {
  harness.sendRequest(1, "thread/resume", {
    threadId: THREAD_ID,
    providerThreadId: ARCHIVED_PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...sessionOptions },
  });
  const response = await harness.waitForResponse(1);

  expect(response.result).toBeUndefined();
  expect(response.error?.code).toBe(
    BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
  );
  expect(response.error?.message).toBe(ARCHIVED_ERROR_TEXT);
  expect(response.error?.data).toEqual({
    recovery: {
      kind: "sessionArchived",
      message: ARCHIVED_ERROR_TEXT,
      retryable: true,
    },
  });
  expect(readFileSync(processLogPath, "utf8")).toContain("exit:");
}, 30_000);

it("attaches the sessionArchived hint to a fork whose source is archived", async () => {
  harness.sendRequest(2, "thread/fork", {
    threadId: THREAD_ID,
    sourceProviderThreadId: ARCHIVED_PROVIDER_THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...sessionOptions },
  });
  const response = await harness.waitForResponse(2);

  expect(response.result).toBeUndefined();
  expect(response.error?.code).toBe(BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR);
  expect(response.error?.data).toMatchObject({
    recovery: { kind: "sessionArchived", retryable: true },
  });
}, 30_000);
