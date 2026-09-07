import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";

import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_child_exit_open_work";

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

type DelegationLifecycle = Extract<
  ThreadDelta,
  { kind: "item.open" | "item.close" }
> & { item: { type: "delegation" } };

function delegationDeltas(): DelegationLifecycle[] {
  const found: DelegationLifecycle[] = [];
  for (const message of harness.messages) {
    if (message.method !== "thread/delta") continue;
    const params = message.params as
      | { threadId?: unknown; deltas?: unknown }
      | undefined;
    if (params?.threadId !== THREAD_ID || !Array.isArray(params.deltas)) {
      continue;
    }
    for (const delta of params.deltas as ThreadDelta[]) {
      if (
        (delta.kind === "item.open" || delta.kind === "item.close") &&
        delta.item.type === "delegation"
      ) {
        found.push(delta as DelegationLifecycle);
      }
    }
  }
  return found;
}

async function waitForDelegationDeltas(
  predicate: (deltas: DelegationLifecycle[]) => boolean,
): Promise<DelegationLifecycle[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const deltas = delegationDeltas();
    if (predicate(deltas)) return deltas;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for delegation deltas (saw ${JSON.stringify(delegationDeltas())})`,
  );
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-child-exit-ws-"));
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath]),
  );
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  const cleanupId = 994_001;
  harness.sendRequest(cleanupId, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "child-exit-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(cleanupId).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("settles the open delegation as failed when the app-server child dies", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: { ...sessionOptions },
  });
  const startResponse = await harness.waitForResponse(1);
  const providerThreadId = (
    startResponse.result as { providerThreadId: string } | undefined
  )?.providerThreadId;
  if (typeof providerThreadId !== "string") {
    throw new Error(`thread/start failed: ${JSON.stringify(startResponse)}`);
  }

  harness.sendRequest(2, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId,
    input: [{ type: "text", text: "/subagent-then-crash", mentions: [] }],
    clientRequestId: "creq_chidexit22",
    options: { ...sessionOptions },
  });
  await harness.waitForResponse(2);

  const deltas = await waitForDelegationDeltas(
    (all) =>
      all.some((delta) => delta.kind === "item.open") &&
      all.at(-1)?.kind === "item.close",
  );
  const open = deltas.find((delta) => delta.kind === "item.open");
  const close = deltas.at(-1);
  expect(open?.item.type).toBe("delegation");
  expect(open?.presentation).toBeDefined();
  expect(close).toEqual(
    expect.objectContaining({
      kind: "item.close",
      key: open?.key,
      status: "failed",
      item: expect.objectContaining({ type: "delegation" }),
    }),
  );
}, 30_000);
