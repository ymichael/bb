import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIDGE_JSON_RPC_ERRORS,
  providerHealthResultSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  BridgeDeltaEventCollector,
  BridgeJsonRpcObject,
  BridgeJsonRpcOutputMessage,
  BridgeJsonRpcTestHarness,
  ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

import { handleLine } from "./src/provider-bridge.js";
import {
  ECHO_GREETING_ENV,
  ECHO_MOOD_KIND,
  ECHO_PROVIDER_ID,
  ECHO_RECEIPT_ICON_GLYPH,
  ECHO_RECEIPT_KIND,
  ECHO_STAMP_TOOL_NAME,
  ECHO_STAMP_TOOL_PRESENTATION,
} from "./src/vocabulary.js";

type ItemEvent = Extract<
  ThreadEvent,
  { type: "item/started" | "item/completed" }
>;

const THREAD_ID = "thr_echo_stream";
const CWD = "/workspace/echo";
const PROMPT = "hello world";

const STAMP_TOOL_DEFINITION = {
  name: ECHO_STAMP_TOOL_NAME,
  description: "Stamp a piece of text with the echo provider's seal.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  presentation: ECHO_STAMP_TOOL_PRESENTATION,
};

const FULL_OPTIONS = {
  model: "echo-1",
  reasoningLevel: "medium",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};

let harness: BridgeJsonRpcTestHarness;
let collector: BridgeDeltaEventCollector;
let requestCounter = 0;
let savedGreeting: string | undefined;

beforeEach(() => {
  harness = createBridgeJsonRpcTestHarness(handleLine);
  collector = createBridgeDeltaEventCollector(ECHO_PROVIDER_ID);
  savedGreeting = process.env[ECHO_GREETING_ENV];
  process.env[ECHO_GREETING_ENV] = "hi from the daemon";
});

afterEach(() => {
  harness.restore();
  if (savedGreeting === undefined) {
    delete process.env[ECHO_GREETING_ENV];
  } else {
    process.env[ECHO_GREETING_ENV] = savedGreeting;
  }
});

async function request(
  method: string,
  params: BridgeJsonRpcObject,
): Promise<BridgeJsonRpcOutputMessage> {
  requestCounter += 1;
  const id = `test-${requestCounter}`;
  harness.sendRequest(id, method, params);
  const response = await harness.waitForResponse(id);
  expect(response.error, `${method} answered an error`).toBeUndefined();
  return response;
}

async function startSession(args: {
  dynamicTools?: BridgeJsonRpcObject[];
  providerOptions?: BridgeJsonRpcObject;
  input?: BridgeJsonRpcObject[];
}): Promise<string> {
  const response = await request("thread/start", {
    threadId: THREAD_ID,
    cwd: CWD,
    instructionMode: "append",
    options: {
      ...FULL_OPTIONS,
      ...(args.providerOptions === undefined
        ? {}
        : { providerOptions: args.providerOptions }),
    },
    ...(args.dynamicTools === undefined
      ? {}
      : { dynamicTools: args.dynamicTools }),
    ...(args.input === undefined ? {} : { input: args.input }),
  });
  const result = response.result as { providerThreadId: string };
  expect(typeof result.providerThreadId).toBe("string");
  return result.providerThreadId;
}

function textInput(text: string): BridgeJsonRpcObject[] {
  return [{ type: "text", text, mentions: [] }];
}

function answerToolCall(
  answer: (params: Record<string, unknown>) => BridgeJsonRpcObject,
): Record<string, unknown> {
  const call = harness.messages.find(
    (message) => message.method === "item/tool/call",
  );
  expect(call, "the bridge called its bb tool").toBeDefined();
  const params = call?.params as Record<string, unknown>;
  handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: call?.id, result: answer(params) }),
  );
  return params;
}

function assembledEvents(): ThreadEvent[] {
  return harness.messages.flatMap((message) =>
    collector.assembleMessage(message),
  );
}

function itemEvents(events: ThreadEvent[]): ItemEvent[] {
  return events.filter(
    (event): event is ItemEvent =>
      event.type === "item/started" || event.type === "item/completed",
  );
}

function completedItem<T extends ItemEvent["item"]["type"]>(
  events: ThreadEvent[],
  type: T,
): Extract<ItemEvent["item"], { type: T }> {
  const event = itemEvents(events).find(
    (candidate) =>
      candidate.type === "item/completed" && candidate.item.type === type,
  );
  expect(event, `a completed ${type} item`).toBeDefined();
  return event?.item as Extract<ItemEvent["item"], { type: T }>;
}

describe("the echo bridge's grammar v3 stream", () => {
  it("runs the whole scripted turn through the runtime assembler", async () => {
    await request("initialize", {
      protocolVersion: 2,
      client: { name: "echo-stream-test", version: "0.0.0" },
      grammarVersions: [3, 3],
    });
    const providerThreadId = await startSession({
      dynamicTools: [STAMP_TOOL_DEFINITION],
      providerOptions: { shout: true, model: "echo-1", promptMode: null },
    });
    await request("turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: textInput(PROMPT),
      clientRequestId: "creq_ech2345678",
      options: {
        ...FULL_OPTIONS,
        providerOptions: { shout: true, model: "echo-1", promptMode: null },
      },
    });

    const callParams = answerToolCall(() => ({
      success: true,
      contentItems: [{ type: "inputText", text: `stamped: ${PROMPT}` }],
    }));
    expect(callParams).toMatchObject({
      providerThreadId,
      threadId: THREAD_ID,
      turnId: null,
      tool: ECHO_STAMP_TOOL_NAME,
      arguments: { text: PROMPT },
      providerNativeIds: true,
    });

    const events = assembledEvents();
    const types = events.map((event) => event.type);

    expect(
      harness.messages.find((message) => message.method === "thread/identity")
        ?.params,
    ).toEqual({ threadId: THREAD_ID, providerThreadId });
    expect(types.slice(0, 2)).toEqual(["turn/started", "turn/input/accepted"]);
    expect(types.filter((type) => type === "turn/input/accepted")).toHaveLength(
      1,
    );
    expect(types.filter((type) => type === "turn/started")).toHaveLength(2);
    expect(types.filter((type) => type === "turn/completed")).toHaveLength(2);
    expect(types.at(-1)).toBe("turn/completed");

    const items = itemEvents(events);
    expect(items.length).toBeGreaterThanOrEqual(18);
    for (const event of items) {
      expect(
        "presentation" in event.item ? event.item.presentation : undefined,
        `${event.type} ${event.item.type} ${event.item.id} has presentation`,
      ).toMatchObject({
        label: { pending: expect.any(String), completed: expect.any(String) },
        icon: { glyph: expect.any(String) },
      });
    }
    const completedTypes = items
      .filter((event) => event.type === "item/completed")
      .map((event) => event.item.type);
    expect(completedTypes).toEqual([
      "commandExecution",
      "fileRead",
      "search",
      "agentMessage",
      "delegation",
      "planSteps",
      "toolCall",
      "toolCall",
      "extension",
      "agentMessage",
    ]);

    const command = completedItem(events, "commandExecution");
    expect(command).toMatchObject({
      command: `echo "${PROMPT}"`,
      cwd: CWD,
      status: "completed",
      exitCode: 0,
      aggregatedOutput: `${PROMPT}\n`,
      presentation: {
        label: { pending: "Running command", completed: "Ran command" },
        icon: { glyph: "Terminal" },
        title: `echo "${PROMPT}"`,
      },
    });
    expect(
      events.some(
        (event) => event.type === "item/commandExecution/outputDelta",
      ),
    ).toBe(true);

    expect(completedItem(events, "fileRead")).toMatchObject({
      path: `${CWD}/README.md`,
      status: "completed",
      presentation: { icon: { glyph: "FileText" }, title: `${CWD}/README.md` },
    });
    expect(completedItem(events, "search")).toMatchObject({
      mode: "content",
      query: PROMPT,
      path: CWD,
      status: "completed",
      presentation: { icon: { glyph: "Search" }, title: PROMPT },
    });

    const delegation = completedItem(events, "delegation");
    expect(delegation).toMatchObject({
      background: false,
      status: "completed",
      summary: `child echo: ${PROMPT}`,
      presentation: {
        label: {
          pending: "Running echo child",
          completed: "Echo child finished",
        },
        icon: { glyph: "UserRound" },
        detail: expect.stringContaining("parentRef"),
      },
    });
    const childTurn = events.find(
      (event) =>
        event.type === "turn/started" &&
        "parentToolCallId" in event &&
        event.parentToolCallId !== undefined,
    );
    expect(childTurn).toMatchObject({ parentToolCallId: delegation.id });
    const childMessage = items.find(
      (event) =>
        event.type === "item/completed" &&
        event.item.type === "agentMessage" &&
        event.item.parentToolCallId !== undefined,
    );
    expect(childMessage?.item).toMatchObject({
      text: `child echo: ${PROMPT}`,
      parentToolCallId: delegation.id,
    });
    expect(childMessage?.scope).toEqual(childTurn?.scope);

    expect(completedItem(events, "planSteps")).toMatchObject({
      steps: [
        { step: "Hear the prompt", status: "completed" },
        { step: `Echo "${PROMPT}"`, status: "completed" },
        { step: "Write the receipt", status: "completed" },
      ],
      explanation: "The echo agent's three-step plan.",
      presentation: { icon: { glyph: "ListTodo" }, title: "Write the receipt" },
    });

    const tools = items
      .filter(
        (event) =>
          event.type === "item/completed" && event.item.type === "toolCall",
      )
      .map((event) => event.item);
    expect(tools[0]).toMatchObject({
      tool: "echo_noop",
      result: "ahem",
      presentation: { suppress: true, icon: { glyph: "Toolbox" } },
    });
    expect(tools[0]).not.toHaveProperty("server");
    expect(tools[1]).toMatchObject({
      tool: ECHO_STAMP_TOOL_NAME,
      server: "bb",
      arguments: { text: PROMPT },
      result: `stamped: ${PROMPT}`,
      status: "completed",
      presentation: ECHO_STAMP_TOOL_PRESENTATION,
    });
    expect(
      collector.assembler.getBbItemId(THREAD_ID, String(callParams.callId)),
    ).toBe(tools[1]?.id);

    expect(completedItem(events, "extension")).toMatchObject({
      kind: ECHO_RECEIPT_KIND,
      payload: { prompt: PROMPT, itemCount: 7, shouted: true },
      status: "completed",
      presentation: {
        label: { pending: "Writing receipt", completed: "Wrote receipt" },
        icon: { glyph: ECHO_RECEIPT_ICON_GLYPH },
        title: PROMPT,
        detail: "Echoed 7 items, shouting.",
        tint: { light: "#047857", dark: "#6ee7b7" },
      },
    });
    const mood = events.find(
      (event) => event.type === "thread/extensionState/updated",
    );
    expect(mood).toMatchObject({
      kind: ECHO_MOOD_KIND,
      payload: { mood: "cheerful", turnsEchoed: 1 },
    });

    const message = items
      .filter(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "agentMessage" &&
          event.item.parentToolCallId === undefined,
      )
      .map((event) => event.item)
      .at(-1);
    expect(message).toMatchObject({
      text: [
        "echo: HELLO WORLD",
        "providerOptions (server): shout=true model=echo-1 promptMode=none",
        `${ECHO_GREETING_ENV}=hi from the daemon`,
        `${ECHO_STAMP_TOOL_NAME}: stamped: ${PROMPT}`,
      ].join("\n"),
      presentation: { label: { pending: "Echoing", completed: "Echoed" } },
    });

    expect(
      events.find((event) => event.type === "thread/tokenUsage/updated"),
    ).toMatchObject({
      tokenUsage: {
        total: { inputTokens: PROMPT.length },
        last: { inputTokens: PROMPT.length },
      },
    });
    expect(
      events.some(
        (event) => event.type === "thread/contextWindowUsage/updated",
      ),
    ).toBe(true);
  });

  it("emits the malformed receipt payload the server must reject", async () => {
    await request("initialize", {
      protocolVersion: 2,
      client: { name: "echo-stream-test", version: "0.0.0" },
      grammarVersions: [3, 3],
    });
    await startSession({ input: textInput("malformed-receipt please") });
    const receipt = completedItem(assembledEvents(), "extension");
    expect(receipt).toMatchObject({
      kind: ECHO_RECEIPT_KIND,
      payload: { prompt: 42, itemCount: "many" },
      presentation: { label: { completed: "Wrote receipt" } },
    });
  });

  it("settles a zero-work turn and falls back to defaults without providerOptions", async () => {
    await request("initialize", {
      protocolVersion: 2,
      client: { name: "echo-stream-test", version: "0.0.0" },
      grammarVersions: [3, 3],
    });
    const providerThreadId = await startSession({});
    await request("turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: textInput("/noop"),
      clientRequestId: "creq_ech2345679",
      options: FULL_OPTIONS,
    });
    const zeroWork = assembledEvents().map((event) => event.type);
    expect(zeroWork).toEqual([
      "turn/started",
      "turn/input/accepted",
      "turn/completed",
    ]);

    await request("turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: textInput("plain"),
      clientRequestId: "creq_ech234567a",
      options: FULL_OPTIONS,
    });
    const events = assembledEvents();
    expect(
      harness.messages.some((message) => message.method === "item/tool/call"),
    ).toBe(false);
    const tools = itemEvents(events)
      .filter((event) => event.type === "item/completed")
      .map((event) => event.item)
      .filter((item) => item.type === "toolCall");
    expect(tools.map((item) => item.tool)).toEqual(["echo_noop"]);
    const message = itemEvents(events)
      .filter(
        (event) =>
          event.type === "item/completed" &&
          event.item.type === "agentMessage" &&
          event.item.parentToolCallId === undefined,
      )
      .at(-1);
    expect(message?.item).toMatchObject({
      text: expect.stringContaining(
        "providerOptions (defaults): shout=false model=echo-1 promptMode=none",
      ),
    });
    expect(message?.item).toMatchObject({
      text: expect.stringContaining("echo: plain"),
    });
  });
});

describe("the echo bridge's provider maintenance", () => {
  it("answers provider/health with a ready result the runtime's schema accepts", async () => {
    await request("initialize", {
      protocolVersion: 2,
      client: { name: "echo-stream-test", version: "0.0.0" },
      grammarVersions: [3, 3],
    });
    const response = await request("provider/health", {
      providerId: ECHO_PROVIDER_ID,
      cwd: CWD,
    });
    const result = providerHealthResultSchema.parse(response.result);
    expect(result).toEqual({
      supported: true,
      health: {
        status: "ready",
        statusMessage: null,
        accountEmail: null,
        planLabel: null,
        installedVersion: null,
        minimumSupportedVersion: null,
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
      },
    });
  });

  it("rejects a malformed health request and does not serve undeclared maintenance", async () => {
    harness.sendRequest("health-bad", "provider/health", {});
    const malformed = await harness.waitForResponse("health-bad");
    expect(malformed.result).toBeUndefined();
    expect(malformed.error).toMatchObject({
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
    });

    for (const method of ["provider/usage", "provider/installation/status"]) {
      harness.sendRequest(`undeclared:${method}`, method, {
        providerId: ECHO_PROVIDER_ID,
      });
      const response = await harness.waitForResponse(`undeclared:${method}`);
      expect(response.error, method).toMatchObject({
        code: BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      });
    }
  });
});
