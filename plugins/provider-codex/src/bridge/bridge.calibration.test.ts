import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PromptInput, ThreadEvent } from "@bb/domain";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  THREAD_DELTA_NOTIFICATION_METHOD,
  interactionRequestParamsSchema,
  type InteractionRequestParams,
} from "@bb/provider-bridge-protocol";
import {
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  experimental_describeCalibrationEvents as describeCalibrationEvents,
  experimental_normalizeCalibrationEvents as normalizeCalibrationEvents,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeDeltaEventCollector,
  BridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ServerNotification as CodexEvent } from "../generated/codex-app-server/schema/ServerNotification.js";
import type { Turn } from "../generated/codex-app-server/schema/v2/Turn.js";
import { handleLine } from "./bridge.js";

const THREAD_ID = "thr_codex_calibration_1";
const SCRIPT_THREAD_ID = "codex-script-thread";
const FIRST_TURN_ID = "turn-cal-1";
const SECOND_TURN_ID = "turn-cal-2";
const COMMAND_ITEM_ID = "cmd-cal-1";

const ARCHIVED_PROVIDER_THREAD_ID = "archived-calibration-1";
const ARCHIVED_ERROR_TEXT = `session ${ARCHIVED_PROVIDER_THREAD_ID} is archived; unarchive it and retry`;
const RUNTIME_UNARCHIVE_RETRY_PATTERN =
  /\b(?:session|thread)\s+\S+\s+is archived\b/i;

const fakeAppServerPath = fileURLToPath(
  new URL("./fake-codex-app-server.mjs", import.meta.url),
);

interface ScriptedNotification {
  kind?: "notify";
  method: CodexEvent["method"];
  params: CodexEvent["params"];
}

interface ScriptedRequest {
  kind: "request";
  method: string;
  params: Record<string, string | number | null | string[]>;
}

function codexNotification<M extends CodexEvent["method"]>(
  method: M,
  params: Extract<CodexEvent, { method: M }>["params"],
): ScriptedNotification {
  return { method, params };
}

function codexTurn(id: string, status: Turn["status"]): Turn {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null,
  };
}

const APPROVAL_REQUEST: ScriptedRequest = {
  kind: "request",
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: SCRIPT_THREAD_ID,
    turnId: FIRST_TURN_ID,
    itemId: COMMAND_ITEM_ID,
    reason: "git status touches the workspace",
    command: "git status --short",
    cwd: "/tmp/project",
    commandActions: [],
    availableDecisions: ["accept", "acceptForSession", "decline"],
  },
};

const SCRIPT: (ScriptedNotification | ScriptedRequest)[][] = [
  [
    codexNotification("turn/started", {
      threadId: SCRIPT_THREAD_ID,
      turn: codexTurn(FIRST_TURN_ID, "inProgress"),
    }),
    codexNotification("item/agentMessage/delta", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      itemId: "msg-cal-1",
      delta: "checking the tree",
    }),
    codexNotification("item/completed", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      completedAtMs: 0,
      item: {
        type: "agentMessage",
        id: "msg-cal-1",
        text: "checking the tree",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
    }),
    APPROVAL_REQUEST,
    codexNotification("item/started", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      startedAtMs: 0,
      item: {
        type: "commandExecution",
        id: COMMAND_ITEM_ID,
        command: "git status --short",
        cwd: "/tmp/project",
        processId: null,
        pluginId: null,
        scriptPath: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    }),
    codexNotification("item/commandExecution/outputDelta", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      itemId: COMMAND_ITEM_ID,
      delta: " M src/app.ts\n",
    }),
    codexNotification("item/completed", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      completedAtMs: 0,
      item: {
        type: "commandExecution",
        id: COMMAND_ITEM_ID,
        command: "git status --short",
        cwd: "/tmp/project",
        processId: null,
        pluginId: null,
        scriptPath: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: " M src/app.ts\n",
        exitCode: 0,
        durationMs: 12,
      },
    }),
    codexNotification("item/completed", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      completedAtMs: 0,
      item: {
        type: "commandExecution",
        id: COMMAND_ITEM_ID,
        command: "git status --short",
        cwd: "/tmp/project",
        processId: null,
        pluginId: null,
        scriptPath: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: " M src/app.ts\n",
        exitCode: 0,
        durationMs: 12,
      },
    }),
    codexNotification("item/started", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      startedAtMs: 0,
      item: {
        type: "commandExecution",
        id: COMMAND_ITEM_ID,
        command: "git status --short",
        cwd: "/tmp/project",
        processId: null,
        pluginId: null,
        scriptPath: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    }),
    codexNotification("item/completed", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      completedAtMs: 0,
      item: {
        type: "commandExecution",
        id: COMMAND_ITEM_ID,
        command: "git status --short",
        cwd: "/tmp/project",
        processId: null,
        pluginId: null,
        scriptPath: null,
        source: "agent",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "clean\n",
        exitCode: 0,
        durationMs: 8,
      },
    }),
    codexNotification("item/completed", {
      threadId: SCRIPT_THREAD_ID,
      turnId: FIRST_TURN_ID,
      completedAtMs: 0,
      item: {
        type: "reasoning",
        id: "reasoning-cal-1",
        summary: ["Read the working tree"],
        content: ["The tree is dirty."],
      },
    }),
    codexNotification("turn/completed", {
      threadId: SCRIPT_THREAD_ID,
      turn: codexTurn(FIRST_TURN_ID, "completed"),
    }),
  ],
  [
    codexNotification("turn/started", {
      threadId: SCRIPT_THREAD_ID,
      turn: codexTurn(SECOND_TURN_ID, "inProgress"),
    }),
    codexNotification("item/started", {
      threadId: SCRIPT_THREAD_ID,
      turnId: SECOND_TURN_ID,
      startedAtMs: 0,
      item: {
        type: "agentMessage",
        id: "msg-cal-2",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
    }),
    codexNotification("item/completed", {
      threadId: SCRIPT_THREAD_ID,
      turnId: SECOND_TURN_ID,
      completedAtMs: 0,
      item: {
        type: "agentMessage",
        id: "msg-cal-2",
        text: "all done",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
    }),
    codexNotification("turn/completed", {
      threadId: SCRIPT_THREAD_ID,
      turn: codexTurn(SECOND_TURN_ID, "completed"),
    }),
  ],
];

const CANONICAL_OPTIONS = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} as const;

function promptInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

const FIRST_REQUEST_ID = "creq_23456789ab";
const STEER_REQUEST_ID = "creq_23456789ac";
const SECOND_REQUEST_ID = "creq_23456789ad";

interface ReplayResult {
  approvals: InteractionRequestParams[];
  collector: BridgeDeltaEventCollector;
  events: ThreadEvent[];
}

function answerBridgeRequests(
  bridge: BridgeJsonRpcTestHarness,
  from: number,
  approvals: InteractionRequestParams[],
): number {
  for (const message of bridge.messages.slice(from)) {
    if (
      message.method !== BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest ||
      message.id === undefined
    ) {
      continue;
    }
    approvals.push(interactionRequestParamsSchema.parse(message.params));
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { decision: "allow_once", grantedPermissions: null },
      }),
    );
  }
  return bridge.messages.length;
}

async function replayCanonical(workspaceDir: string): Promise<ReplayResult> {
  const bridge = createBridgeJsonRpcTestHarness(handleLine);
  const events: ThreadEvent[] = [];
  const approvals: InteractionRequestParams[] = [];
  let drained = 0;
  let answered = 0;

  const collector = createBridgeDeltaEventCollector("codex");
  const collect = (): void => {
    for (const message of bridge.messages.slice(drained)) {
      if (message.method !== THREAD_DELTA_NOTIFICATION_METHOD) {
        continue;
      }
      events.push(...collector.assembleMessage(message));
    }
    drained = bridge.messages.length;
  };

  const settle = async (id: number): Promise<void> => {
    while (!bridge.hasResponse(id)) {
      answered = answerBridgeRequests(bridge, answered, approvals);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    answered = bridge.messages.length;
    collect();
  };

  try {
    bridge.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: { ...CANONICAL_OPTIONS },
    });
    await settle(1);

    bridge.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId: THREAD_ID,
      input: promptInput("check the tree"),
      clientRequestId: FIRST_REQUEST_ID,
      options: { ...CANONICAL_OPTIONS },
    });
    await settle(2);

    const bbTurnId = firstTurnId(events);
    const expectedTurnId =
      bbTurnId === undefined
        ? undefined
        : collector.assembler.getProviderTurnId(THREAD_ID, bbTurnId);
    if (expectedTurnId === undefined) {
      throw new Error("Expected a codex-native turn id to steer against");
    }
    bridge.sendRequest(3, "turn/steer", {
      threadId: THREAD_ID,
      providerThreadId: THREAD_ID,
      expectedTurnId,
      input: promptInput("also check git log"),
      clientRequestId: STEER_REQUEST_ID,
      options: { ...CANONICAL_OPTIONS },
    });
    await settle(3);

    bridge.sendRequest(4, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId: THREAD_ID,
      input: promptInput("now summarize"),
      clientRequestId: SECOND_REQUEST_ID,
      options: { ...CANONICAL_OPTIONS },
    });
    await settle(4);

    bridge.sendRequest(5, "thread/stop", {
      threadId: THREAD_ID,
      providerThreadId: THREAD_ID,
      intent: "release",
      activeTurnId: null,
    });
    await settle(5);
  } finally {
    bridge.restore();
  }

  return { approvals, collector, events };
}

function firstTurnId(events: readonly ThreadEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "turn/started" && event.scope.kind === "turn") {
      return event.scope.turnId;
    }
  }
  return undefined;
}

const GOLDEN_EVENT_STREAM: string[] = [
  "thread/started",
  "thread/identity",
  "turn/started",
  "turn/input/accepted",
  "item/started:agentMessage",
  "item/agentMessage/delta",
  "item/completed:agentMessage",
  "item/started:commandExecution",
  "item/commandExecution/outputDelta",
  "item/completed:commandExecution",
  "item/started:commandExecution",
  "item/completed:commandExecution",
  "item/completed:reasoning",
  "turn/completed",
  "turn/input/accepted",
  "turn/started",
  "turn/input/accepted",
  "item/started:agentMessage",
  "item/completed:agentMessage",
  "turn/completed",
];

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-calibration-ws-"));
  const scriptPath = join(workspaceDir, "calibration-script.json");
  writeFileSync(scriptPath, JSON.stringify({ turns: SCRIPT }), "utf8");
  vi.stubEnv("BB_CODEX_BRIDGE_APP_SERVER_COMMAND", process.execPath);
  vi.stubEnv(
    "BB_CODEX_BRIDGE_APP_SERVER_ARGS",
    JSON.stringify([fakeAppServerPath, scriptPath]),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("replays one scripted codex session onto the golden event stream", async () => {
  const canonical = await replayCanonical(workspaceDir);

  expect(canonical.events.length).toBeGreaterThan(10);
  expect(
    canonical.events.filter(
      (event) =>
        event.type === "item/completed" &&
        event.item.type === "commandExecution" &&
        event.item.command === "git status --short",
    ),
  ).toHaveLength(2);

  expect(
    describeCalibrationEvents(normalizeCalibrationEvents(canonical.events)),
  ).toEqual(GOLDEN_EVENT_STREAM);

  expect(canonical.approvals).toHaveLength(1);
  const approvalRequest = canonical.approvals[0];
  const canonicalApproval = approvalRequest?.payload;
  if (
    canonicalApproval?.kind !== "approval" ||
    canonicalApproval.subject.kind !== "command"
  ) {
    throw new Error("Expected a canonical command-approval payload");
  }
  expect(approvalRequest?.providerNativeIds).toBe(true);
  expect(canonicalApproval.subject.itemId).toBe(COMMAND_ITEM_ID);
  const commandEventItemId = canonical.events.find(
    (event) =>
      event.type === "item/completed" &&
      event.item.type === "commandExecution" &&
      event.item.command === "git status --short",
  );
  expect(
    canonical.collector.assembler.getBbItemId(THREAD_ID, COMMAND_ITEM_ID),
  ).toBe(
    commandEventItemId?.type === "item/completed"
      ? commandEventItemId.item.id
      : undefined,
  );
  expect(canonicalApproval).toMatchObject({
    kind: "approval",
    reason: "git status touches the workspace",
    subject: { kind: "command", command: "git status --short" },
  });
}, 60_000);

it("surfaces an archived-session resume rejection verbatim", async () => {
  const bridge = createBridgeJsonRpcTestHarness(handleLine);
  try {
    bridge.sendRequest(1, "thread/resume", {
      threadId: THREAD_ID,
      providerThreadId: ARCHIVED_PROVIDER_THREAD_ID,
      cwd: workspaceDir,
      instructionMode: "append",
      options: { ...CANONICAL_OPTIONS },
    });
    const response = await bridge.waitForResponse(1);

    expect(response.error?.code).toBe(
      BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE,
    );
    expect(response.error?.message).toBe(ARCHIVED_ERROR_TEXT);
    expect(ARCHIVED_ERROR_TEXT).toMatch(RUNTIME_UNARCHIVE_RETRY_PATTERN);
    expect(response.error?.message).toMatch(RUNTIME_UNARCHIVE_RETRY_PATTERN);
  } finally {
    bridge.restore();
  }
}, 30_000);
