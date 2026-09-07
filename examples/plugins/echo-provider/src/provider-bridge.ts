import {
  type ClientTurnRequestId,
  type DeltaPresentation,
  type DynamicTool,
  type PromptInput,
  type ProviderHealthResult,
  type ThreadDelta,
  type ThreadEventTokenUsageBreakdown,
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ZERO_TOKEN_USAGE,
  addTokenUsage,
  createBridgeIo,
  decodeToolCallResponsePayload,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  runBridgeRequest,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AGENT_MESSAGE_PRESENTATION,
  ECHO_GREETING_ENV,
  ECHO_MODEL,
  ECHO_MODEL_ID,
  ECHO_MOOD_KIND,
  ECHO_RECEIPT_KIND,
  ECHO_STAMP_TOOL_NAME,
  NOOP_TOOL_PRESENTATION,
  commandPresentation,
  delegationPresentation,
  echoProviderOptionsSchema,
  fileReadPresentation,
  planStepsPresentation,
  receiptPresentation,
  searchPresentation,
  type EchoMood,
  type EchoProviderOptions,
  type EchoReceipt,
} from "./vocabulary.js";

const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;

interface Session {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  turnsEchoed: number;
  usageTotal: ThreadEventTokenUsageBreakdown;
  tools: ReadonlyMap<string, DynamicTool>;
}

const sessions = new Map<string, Session>();

type JsonRpcId = string | number;

type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

let outboundRequestCounter = 0;

interface PendingToolCall {
  turn: TurnContext;
}

const pendingToolCalls = new Map<string, PendingToolCall>();

function sendRequest(method: string, params: Record<string, unknown>): string {
  outboundRequestCounter += 1;
  const id = `echo-req-${outboundRequestCounter}`;
  io.send({ jsonrpc: "2.0", id, method, params });
  return id;
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter(
      (item): item is Extract<PromptInput, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join("");
}

function parseProviderOptions(options: unknown): {
  source: "server" | "defaults";
  values: EchoProviderOptions;
} {
  const parsed = echoProviderOptionsSchema.safeParse(options);
  if (parsed.success) {
    return { source: "server", values: parsed.data };
  }
  return {
    source: "defaults",
    values: { shout: false, model: ECHO_MODEL_ID, promptMode: null },
  };
}

interface TurnContext {
  session: Session;
  ordinal: number;
  prompt: string;
  providerOptions: ReturnType<typeof parseProviderOptions>;
  itemCount: number;
  malformedReceipt: boolean;
  stamp: { itemId: string; presentation: DeltaPresentation | undefined } | null;
}

function itemId(turn: TurnContext, name: string): string {
  return `echo-${turn.session.providerThreadId}-t${turn.ordinal}-${name}`;
}

function runEchoTurn(args: {
  session: Session;
  input: readonly PromptInput[];
  options: unknown;
  clientRequestId?: ClientTurnRequestId;
}): void {
  const { session } = args;
  const prompt = promptText(args.input);
  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    deltas.push({
      kind: "input.accepted",
      clientRequestId: args.clientRequestId,
    });
  }

  if (/(?:^|\s)\/noop(?:\s|$)/u.test(prompt)) {
    deltas.push({
      kind: "turn.boundary",
      status: "completed",
      claimIfIdle: true,
    });
    emitDeltas(session.threadId, deltas);
    return;
  }

  session.turnsEchoed += 1;
  const turn: TurnContext = {
    session,
    ordinal: session.turnsEchoed,
    prompt,
    providerOptions: parseProviderOptions(args.options),
    itemCount: 0,
    malformedReceipt: /(?:^|\s)malformed-receipt(?:\s|$)/u.test(prompt),
    stamp: null,
  };
  deltas.push({ kind: "turn.open" });
  deltas.push(...commandDeltas(turn));
  deltas.push(...fileReadDeltas(turn));
  deltas.push(...searchDeltas(turn));
  deltas.push(...delegationDeltas(turn));
  deltas.push(...planStepsDeltas(turn));
  deltas.push(...suppressedToolDeltas(turn));

  const stampTool = session.tools.get(ECHO_STAMP_TOOL_NAME);
  if (stampTool !== undefined) {
    const id = itemId(turn, "stamp");
    turn.stamp = { itemId: id, presentation: stampTool.presentation };
    turn.itemCount += 1;
    deltas.push({
      kind: "item.open",
      key: { providerItemId: id },
      item: {
        type: "tool",
        tool: ECHO_STAMP_TOOL_NAME,
        server: "bb",
        args: { text: prompt },
      },
      ...(stampTool.presentation === undefined
        ? {}
        : { presentation: stampTool.presentation }),
    });
    emitDeltas(session.threadId, deltas);
    const requestId = sendRequest(BRIDGE_INBOUND_REQUEST_METHODS.toolCall, {
      providerThreadId: session.providerThreadId,
      threadId: session.threadId,
      turnId: null,
      callId: id,
      tool: ECHO_STAMP_TOOL_NAME,
      arguments: { text: prompt },
      providerNativeIds: true,
    });
    pendingToolCalls.set(requestId, { turn });
    return;
  }
  emitDeltas(session.threadId, deltas);
  finishEchoTurn(turn, null);
}

function commandDeltas(turn: TurnContext): ThreadDelta[] {
  const id = itemId(turn, "command");
  const command = `echo ${JSON.stringify(turn.prompt)}`;
  const output = `${turn.prompt}\n`;
  const presentation = commandPresentation(command);
  turn.itemCount += 1;
  return [
    {
      kind: "item.open",
      key: { providerItemId: id },
      item: { type: "command", command, cwd: turn.session.cwd },
      presentation,
    },
    {
      kind: "item.outputDelta",
      key: { providerItemId: id },
      channel: "command",
      text: output,
    },
    {
      kind: "item.close",
      key: { providerItemId: id },
      status: "completed",
      exitCode: 0,
      aggregatedOutput: output,
      item: {
        type: "command",
        command,
        cwd: turn.session.cwd,
        aggregatedOutput: output,
        exitCode: 0,
        durationMs: 1,
      },
      presentation,
    },
  ];
}

function fileReadDeltas(turn: TurnContext): ThreadDelta[] {
  const id = itemId(turn, "read");
  const path = join(turn.session.cwd, "README.md");
  const presentation = fileReadPresentation(path);
  turn.itemCount += 1;
  return [
    {
      kind: "item.open",
      key: { providerItemId: id },
      item: { type: "fileRead", path },
      presentation,
    },
    {
      kind: "item.close",
      key: { providerItemId: id },
      status: "completed",
      item: { type: "fileRead", path },
      presentation,
    },
  ];
}

function searchDeltas(turn: TurnContext): ThreadDelta[] {
  const id = itemId(turn, "search");
  const item = {
    type: "search",
    mode: "content",
    query: turn.prompt,
    path: turn.session.cwd,
  } as const;
  const presentation = searchPresentation(turn.prompt);
  turn.itemCount += 1;
  return [
    { kind: "item.open", key: { providerItemId: id }, item, presentation },
    {
      kind: "item.close",
      key: { providerItemId: id },
      status: "completed",
      item,
      presentation,
    },
  ];
}

function delegationDeltas(turn: TurnContext): ThreadDelta[] {
  const id = itemId(turn, "delegate");
  const childTurnId = `${id}-turn`;
  const childRef = `${turn.session.threadId}-t${turn.ordinal}-child`;
  const childMessageId = `${id}-message`;
  const label = `Echo "${turn.prompt}" one more time`;
  const childText = `child echo: ${turn.prompt}`;
  const presentation = delegationPresentation(label);
  turn.itemCount += 1;
  return [
    {
      kind: "item.open",
      key: { providerItemId: id },
      item: { type: "delegation", childRef, label, background: false },
      presentation,
    },
    { kind: "turn.open", providerTurnId: childTurnId, parentRef: id },
    {
      kind: "item.open",
      key: { providerItemId: childMessageId, parentRef: id },
      item: { type: "agentMessage", text: "" },
      presentation: AGENT_MESSAGE_PRESENTATION,
      providerTurnId: childTurnId,
    },
    {
      kind: "item.textDelta",
      key: { providerItemId: childMessageId, parentRef: id },
      channel: "agentMessage",
      text: childText,
      providerTurnId: childTurnId,
    },
    {
      kind: "item.textClose",
      key: { providerItemId: childMessageId, parentRef: id },
      channel: "agentMessage",
      text: childText,
      providerTurnId: childTurnId,
    },
    { kind: "turn.boundary", status: "completed", providerTurnId: childTurnId },
    {
      kind: "item.close",
      key: { providerItemId: id },
      status: "completed",
      item: {
        type: "delegation",
        childRef,
        label,
        background: false,
        summary: childText,
      },
      presentation,
    },
  ];
}

function planStepsDeltas(turn: TurnContext): ThreadDelta[] {
  const id = itemId(turn, "plan");
  const steps = [
    { step: "Hear the prompt", status: "completed" },
    { step: `Echo "${turn.prompt}"`, status: "active" },
    { step: "Write the receipt", status: "pending" },
  ] as const;
  const explanation = "The echo agent's three-step plan.";
  turn.itemCount += 1;
  return [
    {
      kind: "item.open",
      key: { providerItemId: id },
      item: { type: "planSteps", steps: [...steps], explanation },
      presentation: planStepsPresentation(steps[1].step),
    },
    {
      kind: "item.close",
      key: { providerItemId: id },
      status: "completed",
      item: {
        type: "planSteps",
        steps: steps.map((step) => ({ step: step.step, status: "completed" })),
        explanation,
      },
      presentation: planStepsPresentation(steps[2].step),
    },
  ];
}

function suppressedToolDeltas(turn: TurnContext): ThreadDelta[] {
  const id = itemId(turn, "noop");
  turn.itemCount += 1;
  return [
    {
      kind: "item.open",
      key: { providerItemId: id },
      item: { type: "tool", tool: "echo_noop", args: {} },
      presentation: NOOP_TOOL_PRESENTATION,
    },
    {
      kind: "item.close",
      key: { providerItemId: id },
      status: "completed",
      item: { type: "tool", tool: "echo_noop", args: {}, result: "ahem" },
      presentation: NOOP_TOOL_PRESENTATION,
    },
  ];
}

function finishEchoTurn(
  turn: TurnContext,
  stamp: { content: string; isError: boolean } | null,
): void {
  const { session } = turn;
  const deltas: ThreadDelta[] = [];

  if (turn.stamp !== null) {
    deltas.push({
      kind: "item.close",
      key: { providerItemId: turn.stamp.itemId },
      status: stamp === null || stamp.isError ? "failed" : "completed",
      item: {
        type: "tool",
        tool: ECHO_STAMP_TOOL_NAME,
        server: "bb",
        args: { text: turn.prompt },
        ...(stamp === null
          ? { error: "no reply" }
          : stamp.isError
            ? { error: stamp.content }
            : { result: stamp.content }),
      },
      ...(turn.stamp.presentation === undefined
        ? {}
        : { presentation: turn.stamp.presentation }),
    });
  }

  const receiptId = itemId(turn, "receipt");
  const receipt: EchoReceipt = {
    prompt: turn.prompt,
    itemCount: turn.itemCount,
    shouted: turn.providerOptions.values.shout,
  };
  const receiptPayload = turn.malformedReceipt
    ? { prompt: 42, itemCount: "many" }
    : receipt;
  const receiptRow = receiptPresentation(receipt);
  deltas.push(
    {
      kind: "item.open",
      key: { providerItemId: receiptId },
      item: {
        type: "extension",
        kind: ECHO_RECEIPT_KIND,
        payload: receiptPayload,
      },
      presentation: receiptRow,
    },
    {
      kind: "item.close",
      key: { providerItemId: receiptId },
      status: "completed",
      item: {
        type: "extension",
        kind: ECHO_RECEIPT_KIND,
        payload: receiptPayload,
      },
      presentation: receiptRow,
    },
  );

  const mood: EchoMood = {
    mood: session.turnsEchoed > 3 ? "bored" : "cheerful",
    turnsEchoed: session.turnsEchoed,
  };
  deltas.push({
    kind: "extension.state",
    extensionKind: ECHO_MOOD_KIND,
    payload: mood,
  });

  const options = turn.providerOptions.values;
  const echoed = options.shout ? turn.prompt.toUpperCase() : turn.prompt;
  const greeting = process.env[ECHO_GREETING_ENV];
  const lines = [
    `echo: ${echoed}`,
    `providerOptions (${turn.providerOptions.source}): shout=${String(options.shout)} model=${options.model} promptMode=${options.promptMode ?? "none"}`,
    `${ECHO_GREETING_ENV}=${greeting === undefined ? "<unset>" : greeting}`,
    ...(stamp === null ? [] : [`${ECHO_STAMP_TOOL_NAME}: ${stamp.content}`]),
  ];
  const text = lines.join("\n");
  const messageKey = { providerItemId: itemId(turn, "message") };
  deltas.push(
    {
      kind: "item.open",
      key: messageKey,
      item: { type: "agentMessage", text: "" },
      presentation: AGENT_MESSAGE_PRESENTATION,
    },
    {
      kind: "item.textDelta",
      key: messageKey,
      channel: "agentMessage",
      text: lines[0] ?? "",
    },
    {
      kind: "item.textDelta",
      key: messageKey,
      channel: "agentMessage",
      text: text.slice((lines[0] ?? "").length),
    },
    { kind: "item.textClose", key: messageKey, channel: "agentMessage", text },
  );

  const last: ThreadEventTokenUsageBreakdown = {
    ...ZERO_TOKEN_USAGE,
    inputTokens: turn.prompt.length,
    outputTokens: text.length,
    totalTokens: turn.prompt.length + text.length,
  };
  session.usageTotal = addTokenUsage(session.usageTotal, last);
  deltas.push(
    {
      kind: "usage",
      total: session.usageTotal,
      last,
      modelContextWindow: 8192,
    },
    {
      kind: "contextWindow",
      used: session.usageTotal.totalTokens,
      size: 8192,
      estimated: true,
      attach: "open",
    },
    { kind: "turn.boundary", status: "completed" },
  );
  emitDeltas(session.threadId, deltas);
}

function openSession(args: {
  threadId: string;
  providerThreadId: string;
  cwd: string;
  dynamicTools: readonly DynamicTool[] | undefined;
}): Session {
  const session: Session = {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    cwd: args.cwd,
    turnsEchoed: 0,
    usageTotal: ZERO_TOKEN_USAGE,
    tools: new Map((args.dynamicTools ?? []).map((tool) => [tool.name, tool])),
  };
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
  });
  emitDeltas(args.threadId, [{ kind: "session.reset" }]);
  return session;
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

const ECHO_HEALTH: ProviderHealthResult = {
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
};

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        approvalEnforcedBy: "runtime",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    io.sendResult(id, {
      models: [{ ...ECHO_MODEL, model: ECHO_MODEL_ID }],
      selectedOnlyModels: [],
    });
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id, params) => {
    const parsed = providerMaintenanceParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.providerHealth,
        parsed.error.issues,
      );
      return;
    }
    io.sendResult(id, ECHO_HEALTH);
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadStart,
        parsed.error.issues,
      );
      return;
    }
    threadCounter += 1;
    const providerThreadId = `echo_${instanceNonce}_${threadCounter}`;
    const session = openSession({
      threadId: parsed.data.threadId,
      providerThreadId,
      cwd: parsed.data.cwd,
      dynamicTools: parsed.data.dynamicTools,
    });
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
    if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
      runEchoTurn({
        session,
        input: parsed.data.input,
        options: parsed.data.options.providerOptions,
      });
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadResume,
        parsed.error.issues,
      );
      return;
    }
    openSession({
      threadId: parsed.data.threadId,
      providerThreadId: parsed.data.providerThreadId,
      cwd: parsed.data.cwd,
      dynamicTools: parsed.data.dynamicTools,
    });
    io.sendResult(id, {
      providerThreadId: parsed.data.providerThreadId,
      sessionRestorable: true,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    io.sendResult(id, {});
    runEchoTurn({
      session,
      input: parsed.data.input,
      options: parsed.data.options.providerOptions,
      clientRequestId: parsed.data.clientRequestId,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      `No active turn to steer (expected ${parsed.data.expectedTurnId})`,
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    sessions.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },
};

const jsonRpcResponseSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

function handleResponse(message: unknown): void {
  const parsed = jsonRpcResponseSchema.safeParse(message);
  if (!parsed.success || typeof parsed.data.id !== "string") {
    return;
  }
  const pending = pendingToolCalls.get(parsed.data.id);
  if (pending === undefined) {
    return;
  }
  pendingToolCalls.delete(parsed.data.id);
  if (!sessions.has(pending.turn.session.threadId)) {
    return;
  }
  if (parsed.data.error !== undefined) {
    const error = z
      .object({ message: z.string() })
      .safeParse(parsed.data.error);
    finishEchoTurn(pending.turn, {
      content: error.success ? error.data.message : "tool call failed",
      isError: true,
    });
    return;
  }
  const decoded = decodeToolCallResponsePayload(parsed.data.result);
  finishEchoTurn(pending.turn, {
    content: decoded.content,
    isError: decoded.isError,
  });
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string") {
    handleResponse(message);
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (request) => handler(request.id, request.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) {
    writeFileSync(
      join(context.dataDir, "last-boot.json"),
      `${JSON.stringify({ pluginId: context.pluginId, tempDir: context.tempDir })}\n`,
    );
  },
});
