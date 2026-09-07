import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { z } from "zod";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeJsonRpcId,
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_closeAllForTests, handleLine } from "./bridge.js";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { PI_BRIDGE_SESSION_DIR_ENV } from "./session-paths.js";

export const fakePiPath = fileURLToPath(
  new URL("./fake-pi-rpc.mjs", import.meta.url),
);

export const FULL_PERMISSION_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

const INITIALIZE_ID = 100;
const FIRST_HARNESS_REQUEST_ID = 1_000_000;
const RESPONSE_DEADLINE_MS = 60_000;

const threadDeltaParamsSchema = z.object({
  threadId: z.string(),
  deltas: z.array(z.record(z.string(), z.unknown())),
});

export interface StartFakePiBridgeOptions {
  prefix: string;
  sessionDir?: (workspaceDir: string) => string;
  initialize: boolean;
  processLog?: boolean;
}

export interface FakePiBridgeHarness {
  workspaceDir: string;
  sessionDir: string;
  messages: BridgeJsonRpcOutputMessage[];
  takeMessages(): BridgeJsonRpcOutputMessage[];
  request(
    id: BridgeJsonRpcId,
    method: string,
    params: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage>;
  startThread(
    threadId: string,
    extra?: BridgeJsonRpcObject,
  ): Promise<BridgeJsonRpcOutputMessage>;
  deltasOf(threadId: string): Record<string, unknown>[];
  waitFor(predicate: () => boolean, what: string): Promise<void>;
  waitForDelta(
    threadId: string,
    predicate: (delta: Record<string, unknown>) => boolean,
    since?: number,
  ): Promise<void>;
  waitForTurnBoundary(threadId: string, since?: number): Promise<number>;
  waitForMessage(
    predicate: (message: BridgeJsonRpcOutputMessage) => boolean,
    what: string,
  ): Promise<BridgeJsonRpcOutputMessage>;
  readProcessLog(): { spawned: number[]; exited: number[] };
  teardown(): Promise<void>;
}

export async function startFakePiBridge(
  options: StartFakePiBridgeOptions,
): Promise<FakePiBridgeHarness> {
  const workspaceDir = mkdtempSync(join(tmpdir(), options.prefix));
  const sessionDir =
    options.sessionDir === undefined
      ? join(workspaceDir, "sessions")
      : options.sessionDir(workspaceDir);
  const processLogPath = join(workspaceDir, "process.log");
  vi.stubEnv(PI_BRIDGE_COMMAND_ENV, process.execPath);
  vi.stubEnv(PI_BRIDGE_ARGS_ENV, JSON.stringify([fakePiPath]));
  vi.stubEnv(PI_BRIDGE_SESSION_DIR_ENV, sessionDir);
  if (options.processLog === true) {
    vi.stubEnv("FAKE_PI_PROCESS_LOG", processLogPath);
  }
  const harness = createBridgeJsonRpcTestHarness(handleLine);
  let nextHarnessRequestId = FIRST_HARNESS_REQUEST_ID;
  const bridge: FakePiBridgeHarness = {
    workspaceDir,
    sessionDir,
    messages: harness.messages,
    takeMessages: harness.takeMessages,
    async request(id, method, params) {
      harness.sendRequest(id, method, params);
      const deadline = Date.now() + RESPONSE_DEADLINE_MS;
      while (Date.now() < deadline) {
        const response = harness.messages.find((message) => message.id === id);
        if (response !== undefined) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no response to ${method}`);
    },
    startThread(threadId, extra = {}) {
      nextHarnessRequestId += 1;
      return bridge.request(nextHarnessRequestId, "thread/start", {
        threadId,
        cwd: workspaceDir,
        instructionMode: "append",
        options: FULL_PERMISSION_OPTIONS,
        ...extra,
      });
    },
    deltasOf(threadId) {
      return harness.messages
        .filter((message) => message.method === "thread/delta")
        .map((message) => threadDeltaParamsSchema.parse(message.params))
        .filter((params) => params.threadId === threadId)
        .flatMap((params) => params.deltas);
    },
    async waitFor(predicate, what) {
      const deadline = Date.now() + RESPONSE_DEADLINE_MS;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    waitForDelta(threadId, predicate, since = 0) {
      return bridge.waitFor(
        () => bridge.deltasOf(threadId).slice(since).some(predicate),
        `a delta of ${threadId}`,
      );
    },
    async waitForTurnBoundary(threadId, since = 0) {
      await bridge.waitFor(
        () =>
          bridge
            .deltasOf(threadId)
            .slice(since)
            .some((delta) => delta.kind === "turn.boundary"),
        `the turn of ${threadId} to end`,
      );
      return bridge.deltasOf(threadId).length;
    },
    async waitForMessage(predicate, what) {
      await bridge.waitFor(() => harness.messages.some(predicate), what);
      const found = harness.messages.find(predicate);
      if (found === undefined) throw new Error(`timed out waiting for ${what}`);
      return found;
    },
    readProcessLog() {
      const lines = existsSync(processLogPath)
        ? readFileSync(processLogPath, "utf8").split("\n").filter(Boolean)
        : [];
      const spawned: number[] = [];
      const exited: number[] = [];
      for (const line of lines) {
        const [step, pid] = line.split(":");
        (step === "spawn" ? spawned : exited).push(Number(pid));
      }
      return { spawned, exited };
    },
    async teardown() {
      await experimental_closeAllForTests();
      harness.restore();
      vi.unstubAllEnvs();
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
  if (options.initialize) {
    try {
      await bridge.request(INITIALIZE_ID, "initialize", {
        protocolVersion: 2,
        client: { name: "test", version: "0" },
        grammarVersions: [3, 3],
      });
    } catch (error) {
      await bridge.teardown();
      throw error;
    }
  }
  return bridge;
}
