import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@bb/domain";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";

import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_zero_work_1";

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

const sessionOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

let harness: BridgeJsonRpcTestHarness;
let workspaceDir: string;

function threadEvents(): ThreadEvent[] {
  return assembleCapturedThreadEvents(harness.messages, "codex");
}

async function waitForEvents(
  predicate: (events: ThreadEvent[]) => boolean,
): Promise<ThreadEvent[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const events = threadEvents();
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for thread events");
}

async function startSession(): Promise<string> {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...sessionOptions },
  });
  const response = await harness.waitForResponse(1);
  const providerThreadId = (
    response.result as { providerThreadId: string } | undefined
  )?.providerThreadId;
  if (typeof providerThreadId !== "string") {
    throw new Error(`thread/start failed: ${JSON.stringify(response)}`);
  }
  return providerThreadId;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-zero-work-ws-"));
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 993_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "zero-work-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("settles a prompt the app-server accepts without any turn activity", async () => {
  const providerThreadId = await startSession();
  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/clear", mentions: [] }],
    clientRequestId: "creq_zerwrk2345",
    options: { ...sessionOptions },
  });
  await harness.waitForResponse(2);

  const events = await waitForEvents((all) =>
    all.some((event) => event.type === "turn/completed"),
  );
  const started = events.filter((event) => event.type === "turn/started");
  const completed = events.filter((event) => event.type === "turn/completed");
  expect(started).toHaveLength(1);
  expect(completed).toHaveLength(1);
  const turnId =
    started[0]?.scope.kind === "turn" ? started[0].scope.turnId : "";
  expect(turnId).not.toBe("");
  expect(completed[0]).toMatchObject({
    status: "completed",
    scope: { kind: "turn", turnId },
  });
  expect(completed[0]).not.toHaveProperty("providerCheckpointId");
  expect(
    events.filter((event) => event.type === "turn/input/accepted"),
  ).toEqual([
    expect.objectContaining({
      clientRequestId: "creq_zerwrk2345",
      scope: { kind: "turn", turnId },
    }),
  ]);
}, 30_000);

it("preserves the native checkpoint when thread/stop interrupts a turn", async () => {
  const providerThreadId = await startSession();
  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/wait-for-interrupt", mentions: [] }],
    clientRequestId: "creq_a2b3c4d5e6",
    options: { ...sessionOptions },
  });
  await harness.waitForResponse(2);
  await waitForEvents((events) =>
    events.some((event) => event.type === "turn/started"),
  );

  harness.sendRequest(3, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId,
    intent: "interrupt",
    activeTurnId: "turn-fx-1",
  });
  await harness.waitForResponse(3);

  const events = await waitForEvents((all) =>
    all.some(
      (event) =>
        event.type === "turn/completed" && event.status === "interrupted",
    ),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "turn/completed",
      status: "interrupted",
      providerCheckpointId: "turn-fx-1",
    }),
  );
}, 30_000);

it("lets a turn/started that lands after the turn/start response win the race", async () => {
  const providerThreadId = await startSession();
  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/late-start", mentions: [] }],
    clientRequestId: "creq_atestart23",
    options: { ...sessionOptions },
  });
  await harness.waitForResponse(2);

  const events = await waitForEvents((all) =>
    all.some((event) => event.type === "turn/completed"),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const settledEvents = threadEvents();

  expect(
    settledEvents.filter((event) => event.type === "turn/started"),
  ).toHaveLength(1);
  expect(
    settledEvents.filter((event) => event.type === "turn/completed"),
  ).toHaveLength(1);
  expect(
    settledEvents.some((event) => event.type === "item/agentMessage/delta"),
  ).toBe(true);
  expect(
    settledEvents.filter((event) => event.type === "turn/input/accepted"),
  ).toHaveLength(1);
  expect(events.length).toBeGreaterThan(0);
}, 30_000);
