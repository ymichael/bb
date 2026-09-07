import {
  type ClientTurnRequestId,
  type PendingInteractionPayload,
  type PromptInput,
  type ThreadDelta,
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  initializeParamsSchema,
  modelListParamsSchema,
  skillsConfigureParamsSchema,
  threadArchiveParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadGoalClearParamsSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadUnarchiveParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  experimental_defineProviderBridge,
  providerRecoveryKindSchema,
  runBridgeRequest,
  type ProviderRecoveryHint,
} from "@get-bb/plugin-sdk/provider-bridge";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const scriptedMethodSchema = z.enum([
  "initialize",
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
  "turn/steer",
  "thread/stop",
  "thread/discard",
  "thread/archive",
  "thread/unarchive",
  "thread/name/set",
  "thread/goal/clear",
  "skills/configure",
]);
export const scriptedEchoOptionsSchema = z
  .object({
    startDelayMs: z.number().int().nonnegative().optional(),
    turnStartResponseDelayMs: z.number().int().nonnegative().optional(),
    answerStartWithoutIdentity: z.boolean().optional(),
    archivedSession: z.boolean().optional(),
    unarchiveFails: z.boolean().optional(),
    exitAfterArchivedError: z.boolean().optional(),
    discardFailsOnce: z.boolean().optional(),
    crashOn: scriptedMethodSchema.optional(),
    exitAfter: scriptedMethodSchema.optional(),
    unsupportedMethods: z.array(scriptedMethodSchema).optional(),
    failMethods: z
      .array(
        z.object({
          method: scriptedMethodSchema,
          message: z.string(),
          code: z.number().int().optional(),
          times: z.number().int().positive().optional(),
          recovery: z
            .object({
              kind: providerRecoveryKindSchema,
              retryable: z.boolean(),
            })
            .optional(),
        }),
      )
      .optional(),
    goalClearNotifyDelayMs: z.number().int().nonnegative().optional(),
    goalClearReportsCleared: z.boolean().optional(),
    swallowTurnStart: z.boolean().optional(),
    sessionRestorable: z.boolean().optional(),
    warnOnTurn: z.boolean().optional(),
    toolCallThreadIdHint: z.string().min(1).optional(),
    recoveryThreadIdHint: z.string().min(1).optional(),
    approvalEnforcedBy: z.enum(["runtime", "provider"]).optional(),
    identifyProcess: z.boolean().optional(),
    failStopForThreadIds: z.array(z.string().min(1)).optional(),
    emitIdentityOnSigterm: z.boolean().optional(),
  })
  .strict();
export type ScriptedEchoOptions = z.infer<typeof scriptedEchoOptionsSchema>;

const SCRIPTED_OPTIONS_ENV = "SCRIPTED_ECHO_OPTIONS";
const SCRIPTED_RECORD_PATH_ENV = "SCRIPTED_ECHO_RECORD_PATH";
const SCRIPTED_PROCESS_LOG_PATH_ENV = "SCRIPTED_ECHO_PROCESS_LOG_PATH";

function logProcessStep(step: string): void {
  const logPath = process.env[SCRIPTED_PROCESS_LOG_PATH_ENV];
  if (logPath === undefined || logPath.length === 0) {
    return;
  }
  appendFileSync(logPath, `${step}\n`);
}
logProcessStep(`spawn:${process.pid}`);

function readEnvOptions(): ScriptedEchoOptions {
  const raw = process.env[SCRIPTED_OPTIONS_ENV];
  if (raw === undefined || raw.length === 0) {
    return {};
  }
  return scriptedEchoOptionsSchema.parse(JSON.parse(raw));
}

let processOptions: ScriptedEchoOptions = {};
try {
  processOptions = readEnvOptions();
} catch (error) {
  process.stderr.write(
    `scripted echo bridge: invalid ${SCRIPTED_OPTIONS_ENV}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}

function scriptedOptionsFor(
  providerOptions: Record<string, unknown> | undefined,
): ScriptedEchoOptions {
  const fromCommand = providerOptions?.scripted;
  if (fromCommand === undefined) {
    return processOptions;
  }
  const parsed = scriptedEchoOptionsSchema.safeParse(fromCommand);
  if (!parsed.success) {
    process.stderr.write(
      `scripted echo bridge: ignoring invalid providerOptions.scripted: ${parsed.error.message}\n`,
    );
    return processOptions;
  }
  return { ...processOptions, ...parsed.data };
}

type JsonRpcId = string | number;

interface ActiveTurn {
  providerTurnId: string;
  timer: NodeJS.Timeout | null;
}

interface Session {
  threadId: string;
  providerThreadId: string;
  turnCount: number;
  messageCount: number;
  activeTurn: ActiveTurn | null;
  options: ScriptedEchoOptions;
}

type PendingReply =
  | { kind: "tool"; threadId: string; toolName: string; delayMs: number }
  | { kind: "question"; threadId: string; delayMs: number }
  | {
      kind: "approval";
      threadId: string;
      responseText: string;
      delayMs: number;
    };

const sessions = new Map<string, Session>();
const pendingReplies = new Map<JsonRpcId, PendingReply>();
const unarchivedSessionIds = new Set<string>();
const archivedSessionIds = new Set<string>();
const scriptedFailureCounts = new Map<number, number>();
const openBackgroundTasks = new Map<
  string,
  { providerItemId: string; familyId: string }[]
>();
let discardFailed = false;
let providerThreadCounter = 0;
let outboundRequestCounter = 0;

type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const io = createBridgeIo<OutboundMessage>();

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

function emitRecoveryHint(
  threadId: string,
  kind: ProviderRecoveryHint["kind"] | null,
): void {
  if (kind === null) {
    return;
  }
  notify(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
    threadId: sessions.get(threadId)?.options.recoveryThreadIdHint ?? threadId,
    kind,
    message: `scripted ${kind}`,
    retryable: false,
  });
}

function sendRequest(
  method: string,
  params: Record<string, unknown>,
): JsonRpcId {
  outboundRequestCounter += 1;
  const id = `scripted-${outboundRequestCounter}`;
  io.send({ jsonrpc: "2.0", id, method, params });
  return id;
}

function exitProcess(): void {
  process.exit(0);
}

type ApprovalKind = "command" | "file_change" | "permission_grant" | "plan";
const APPROVAL_KINDS: readonly ApprovalKind[] = [
  "command",
  "file_change",
  "permission_grant",
  "plan",
];

interface TurnPlan {
  approvalKind: ApprovalKind | null;
  delayMs: number;
  questionRequested: boolean;
  responseText: string;
  toolName: string | null;
  toolTurnResolved: boolean;
  holdTurn: boolean;
  failure: { text: string; beforeTurn: boolean } | null;
  recoverKind: ProviderRecoveryHint["kind"] | null;
  recoverNowKind: ProviderRecoveryHint["kind"] | null;
  backgroundTask: boolean;
  settleBackgroundTasks: boolean;
}

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter(
      (item): item is Extract<PromptInput, { type: "text" }> =>
        item.type === "text",
    )
    .map((item) => item.text)
    .join(" ");
}

function parseTurnPlan(inputText: string): TurnPlan {
  const delayMatch = /(?:^|\s)delay:(\d+)(?:\s|$)/u.exec(inputText);
  const questionMatch = /(?:^|\s)ask_user(?:\s|$)/u.exec(inputText);
  const approvalMatch = /(?:^|\s)approve:([^\s]+)(?:\s|$)/u.exec(inputText);
  const unresolvedToolMatch =
    /(?:^|\s)call_tool_unresolved:([^\s]+)(?:\s|$)/u.exec(inputText);
  const toolMatch =
    unresolvedToolMatch ??
    /(?:^|\s)call_tool:([^\s]+)(?:\s|$)/u.exec(inputText);
  const approvalKind =
    APPROVAL_KINDS.find((kind) => kind === approvalMatch?.[1]) ?? null;
  const holdMatch = /(?:^|\s)hold_turn(?:\s|$)/u.exec(inputText);
  const failMatch = /(?:^|\s)fail_turn:([^\s]+)(?:\s|$)/u.exec(inputText);
  const prestartFailMatch = /(?:^|\s)prestart_fail:([^\s]+)(?:\s|$)/u.exec(
    inputText,
  );
  const failureText = prestartFailMatch?.[1] ?? failMatch?.[1];
  const recoverMatch = /(?:^|\s)recover:([^\s]+)(?:\s|$)/u.exec(inputText);
  const recoverKind = providerRecoveryKindSchema.safeParse(recoverMatch?.[1]);
  const recoverNowMatch = /(?:^|\s)recover_now:([^\s]+)(?:\s|$)/u.exec(
    inputText,
  );
  const recoverNowKind = providerRecoveryKindSchema.safeParse(
    recoverNowMatch?.[1],
  );
  return {
    recoverKind: recoverKind.success ? recoverKind.data : null,
    recoverNowKind: recoverNowKind.success ? recoverNowKind.data : null,
    backgroundTask: /(?:^|\s)bg_task(?:\s|$)/u.test(inputText),
    settleBackgroundTasks: /(?:^|\s)bg_task_done(?:\s|$)/u.test(inputText),
    approvalKind,
    delayMs: delayMatch?.[1] === undefined ? 0 : Number(delayMatch[1]),
    questionRequested: questionMatch !== null,
    responseText:
      inputText.length > 0 ? `Response to: ${inputText}` : "Response complete",
    toolName: toolMatch?.[1] ?? null,
    toolTurnResolved: unresolvedToolMatch === null,
    holdTurn: holdMatch !== null,
    failure:
      failureText === undefined
        ? null
        : {
            text: failureText.replaceAll("_", " "),
            beforeTurn: prestartFailMatch !== null,
          },
  };
}

function approvalPayload(
  kind: ApprovalKind,
  itemId: string,
): PendingInteractionPayload {
  switch (kind) {
    case "command":
      return {
        kind: "approval",
        subject: {
          kind: "command",
          itemId,
          command: "echo hi",
          cwd: null,
          actions: [],
          sessionGrant: null,
        },
        reason: null,
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      };
    case "file_change":
      return {
        kind: "approval",
        subject: {
          kind: "file_change",
          itemId,
          writeScope: null,
          sessionGrant: null,
        },
        reason: "Write src/example.ts",
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      };
    case "permission_grant":
      return {
        kind: "approval",
        subject: {
          kind: "permission_grant",
          itemId,
          toolName: "Edit",
          permissions: {
            network: null,
            fileSystem: { read: [], write: ["src/example.ts"] },
          },
        },
        reason: null,
        availableDecisions: ["allow_once", "allow_for_session", "deny"],
      };
    case "plan":
      return {
        kind: "approval",
        subject: {
          kind: "plan",
          itemId,
          plan: "# Fake plan\n\n1. Say hi\n2. Report back",
          planFilePath: null,
        },
        reason: null,
        availableDecisions: ["allow_once", "deny"],
      };
  }
}

function userQuestionPayload(requestId: JsonRpcId): PendingInteractionPayload {
  return {
    kind: "user_question",
    questions: [
      {
        id: `${String(requestId)}:question-1`,
        prompt: "Which deployment path should the fake provider use?",
        shortLabel: "Path",
        multiSelect: false,
        options: [
          {
            value: "staging",
            label: "Staging",
            description: "Deploy to staging first.",
          },
          {
            value: "production",
            label: "Production",
            description: "Deploy directly to production.",
          },
        ],
        allowFreeText: true,
      },
    ],
  };
}

function clearActiveTurn(session: Session): void {
  if (session.activeTurn?.timer) {
    clearTimeout(session.activeTurn.timer);
  }
  session.activeTurn = null;
}

function completeTurn(
  session: Session,
  status: "completed" | "interrupted" | "failed",
  text: string,
): void {
  const turn = session.activeTurn;
  if (turn === null) {
    return;
  }
  clearActiveTurn(session);
  const responseText =
    session.options.identifyProcess === true
      ? `pid:${process.pid}:${text}`
      : text;
  const deltas: ThreadDelta[] = [];
  if (status === "completed") {
    session.messageCount += 1;
    const key = { providerItemId: `msg-${session.messageCount}` };
    deltas.push(
      {
        kind: "item.open",
        key,
        item: { type: "agentMessage", text: "" },
        providerTurnId: turn.providerTurnId,
      },
      {
        kind: "item.close",
        key,
        status: "completed",
        item: { type: "agentMessage", text: responseText },
        providerTurnId: turn.providerTurnId,
      },
    );
  }
  deltas.push({
    kind: "turn.boundary",
    status,
    providerTurnId: turn.providerTurnId,
  });
  emitDeltas(session.threadId, deltas);
}

function openBackgroundTask(session: Session, providerTurnId: string): void {
  const providerItemId = `bg-${session.turnCount}`;
  const familyId = `bg-family-${session.threadId}-${session.turnCount}`;
  emitDeltas(session.threadId, [
    {
      kind: "item.open",
      key: { providerItemId },
      item: {
        type: "backgroundTask",
        familyId,
        taskType: "workflow",
        description: "scripted background task",
        status: "pending",
        taskStatus: "running",
        skipTranscript: false,
      },
      providerTurnId,
    },
  ]);
  const open = openBackgroundTasks.get(session.threadId) ?? [];
  open.push({ providerItemId, familyId });
  openBackgroundTasks.set(session.threadId, open);
  logProcessStep(`bg_task/open:${process.pid}:${session.threadId}`);
}

function settleBackgroundTasks(session: Session): void {
  const open = openBackgroundTasks.get(session.threadId) ?? [];
  openBackgroundTasks.delete(session.threadId);
  emitDeltas(
    session.threadId,
    open.map((task) => ({
      kind: "item.close",
      key: { providerItemId: task.providerItemId },
      status: "completed",
      item: {
        type: "backgroundTask",
        familyId: task.familyId,
        taskType: "workflow",
        description: "scripted background task",
        status: "completed",
        taskStatus: "completed",
        skipTranscript: false,
      },
    })),
  );
}

function scheduleCompletion(
  session: Session,
  responseText: string,
  delayMs: number,
  recoverKind: ProviderRecoveryHint["kind"] | null = null,
): void {
  if (session.activeTurn === null) {
    return;
  }
  session.activeTurn.timer = setTimeout(() => {
    completeTurn(session, "completed", responseText);
    emitRecoveryHint(session.threadId, recoverKind);
  }, delayMs);
}

function beginTurn(args: {
  session: Session;
  input: readonly PromptInput[];
  clientRequestId?: ClientTurnRequestId;
}): void {
  const { session } = args;
  clearActiveTurn(session);
  const plan = parseTurnPlan(promptText(args.input));
  if (plan.failure !== null && plan.failure.beforeTurn) {
    if (args.clientRequestId !== undefined) {
      emitDeltas(session.threadId, [
        { kind: "input.accepted", clientRequestId: args.clientRequestId },
      ]);
    }
    emitDeltas(session.threadId, [
      {
        kind: "provider.error",
        message: "Provider error",
        detail: plan.failure.text,
        willRetry: false,
        settlesTurn: true,
      },
    ]);
    emitRecoveryHint(session.threadId, plan.recoverKind);
    return;
  }
  session.turnCount += 1;
  const providerTurnId = `turn-${session.turnCount}`;
  session.activeTurn = { providerTurnId, timer: null };

  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    deltas.push({
      kind: "input.accepted",
      clientRequestId: args.clientRequestId,
      providerTurnId,
    });
  }
  deltas.push({ kind: "turn.open", providerTurnId });
  if (session.options.warnOnTurn === true) {
    deltas.push({
      kind: "provider.warning",
      category: "general",
      summary: "scripted warning",
      vouchedTurn: true,
    });
  }
  emitDeltas(session.threadId, deltas);
  emitRecoveryHint(session.threadId, plan.recoverNowKind);
  if (plan.backgroundTask) {
    openBackgroundTask(session, providerTurnId);
  }
  if (plan.settleBackgroundTasks) {
    settleBackgroundTasks(session);
  }

  if (plan.holdTurn) {
    emitRecoveryHint(session.threadId, plan.recoverKind);
    return;
  }
  if (plan.failure !== null) {
    clearActiveTurn(session);
    emitDeltas(session.threadId, [
      {
        kind: "provider.error",
        message: "Provider error",
        detail: plan.failure.text,
        willRetry: false,
        settlesTurn: true,
        providerTurnId,
      },
    ]);
    emitRecoveryHint(session.threadId, plan.recoverKind);
    return;
  }

  if (plan.approvalKind !== null) {
    const requestId = sendRequest(
      BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
      {
        providerThreadId: session.providerThreadId,
        threadId: session.threadId,
        turnId: providerTurnId,
        payload: approvalPayload(
          plan.approvalKind,
          `approval-${providerTurnId}`,
        ),
        providerNativeIds: true,
      },
    );
    pendingReplies.set(requestId, {
      kind: "approval",
      threadId: session.threadId,
      responseText: plan.responseText,
      delayMs: plan.delayMs,
    });
    return;
  }
  if (plan.questionRequested) {
    outboundRequestCounter += 1;
    const requestId = `scripted-${outboundRequestCounter}`;
    io.send({
      jsonrpc: "2.0",
      id: requestId,
      method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
      params: {
        providerThreadId: session.providerThreadId,
        threadId: session.threadId,
        turnId: providerTurnId,
        payload: userQuestionPayload(requestId),
        providerNativeIds: true,
      },
    });
    pendingReplies.set(requestId, {
      kind: "question",
      threadId: session.threadId,
      delayMs: plan.delayMs,
    });
    return;
  }
  if (plan.toolName !== null) {
    const requestId = sendRequest(BRIDGE_INBOUND_REQUEST_METHODS.toolCall, {
      providerThreadId: session.providerThreadId,
      threadId: session.options.toolCallThreadIdHint ?? session.threadId,
      turnId: plan.toolTurnResolved ? providerTurnId : null,
      callId: `call-${session.turnCount}`,
      tool: plan.toolName,
      arguments: {},
      providerNativeIds: true,
    });
    pendingReplies.set(requestId, {
      kind: "tool",
      threadId: session.threadId,
      toolName: plan.toolName,
      delayMs: plan.delayMs,
    });
    return;
  }
  scheduleCompletion(
    session,
    plan.responseText,
    plan.delayMs,
    plan.recoverKind,
  );
}

function describeAnswer(result: unknown): string {
  const parsed = z
    .object({
      answers: z.record(
        z.string(),
        z.object({
          selected: z.array(z.string()).default([]),
          freeText: z.string().default(""),
        }),
      ),
    })
    .safeParse(result);
  const first = parsed.success
    ? Object.values(parsed.data.answers)[0]
    : undefined;
  if (first === undefined) {
    return "no answer";
  }
  return [...first.selected, first.freeText]
    .filter((part) => part.length > 0)
    .join(", ");
}

function isAllowedDecision(result: unknown): boolean {
  const parsed = z.object({ decision: z.string() }).safeParse(result);
  return (
    parsed.success &&
    (parsed.data.decision === "allow_once" ||
      parsed.data.decision === "allow_for_session")
  );
}

const jsonRpcErrorSchema = z
  .object({ code: z.number(), message: z.string() })
  .passthrough();

function handleResponse(
  id: JsonRpcId,
  result: unknown,
  error: unknown,
): boolean {
  const pending = pendingReplies.get(id);
  if (pending === undefined) {
    return false;
  }
  pendingReplies.delete(id);
  const session = sessions.get(pending.threadId);
  if (session === undefined) {
    return true;
  }
  const parsedError = jsonRpcErrorSchema.safeParse(error);
  if (parsedError.success) {
    const turn = session.activeTurn;
    if (turn !== null) {
      clearActiveTurn(session);
      emitDeltas(session.threadId, [
        {
          kind: "provider.error",
          message: `${pending.kind} request failed: ${parsedError.data.message}`,
          detail: `JSON-RPC error ${parsedError.data.code}`,
          settlesTurn: true,
          providerTurnId: turn.providerTurnId,
        },
      ]);
    }
    return true;
  }
  switch (pending.kind) {
    case "tool":
      scheduleCompletion(
        session,
        `Tool called: ${pending.toolName}`,
        pending.delayMs,
      );
      return true;
    case "question":
      scheduleCompletion(
        session,
        `Question answered: ${describeAnswer(result)}`,
        pending.delayMs,
      );
      return true;
    case "approval":
      scheduleCompletion(
        session,
        isAllowedDecision(result) ? pending.responseText : "Denied",
        pending.delayMs,
      );
      return true;
  }
}

function archivedSessionError(providerThreadId: string): string {
  return `session ${providerThreadId} is archived. Run codex unarchive ${providerThreadId} to unarchive it first.`;
}

function rejectIfArchived(
  id: JsonRpcId,
  options: ScriptedEchoOptions,
  providerThreadId: string,
): boolean {
  const scriptedArchived =
    options.archivedSession === true &&
    !unarchivedSessionIds.has(providerThreadId);
  if (!scriptedArchived && !archivedSessionIds.has(providerThreadId)) {
    return false;
  }
  const message = archivedSessionError(providerThreadId);
  io.sendError(id, -32000, message, {
    recovery: {
      kind: "sessionArchived",
      message,
      retryable: true,
    } satisfies ProviderRecoveryHint,
  });
  if (options.exitAfterArchivedError === true) {
    exitProcess();
  }
  return true;
}

function openSession(args: {
  threadId: string;
  providerThreadId: string;
  options: ScriptedEchoOptions;
}): Session {
  const session: Session = {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    turnCount: 0,
    messageCount: 0,
    activeTurn: null,
    options: args.options,
  };
  sessions.set(args.threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    ...(args.options.sessionRestorable === undefined
      ? {}
      : { sessionRestorable: args.options.sessionRestorable }),
  });
  emitDeltas(args.threadId, [{ kind: "session.reset" }]);
  return session;
}

function mintProviderThreadId(options: ScriptedEchoOptions): string {
  providerThreadCounter += 1;
  return options.identifyProcess === true
    ? `prov-${process.pid}-${providerThreadCounter}`
    : `prov-${providerThreadCounter}`;
}

function identityResult(session: Session): Record<string, unknown> {
  if (session.options.answerStartWithoutIdentity === true) {
    return { threadId: session.threadId };
  }
  return {
    providerThreadId: session.providerThreadId,
    ...(session.options.sessionRestorable === undefined
      ? {}
      : { sessionRestorable: session.options.sessionRestorable }),
  };
}

function afterStartDelay(options: ScriptedEchoOptions, run: () => void): void {
  if (options.startDelayMs === undefined || options.startDelayMs === 0) {
    run();
    return;
  }
  setTimeout(run, options.startDelayMs);
}

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

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

const MODEL_LIST = {
  models: [
    {
      id: "fake-model",
      model: "fake-model",
      displayName: "Fake Model",
      description: "Fake model for integration and runtime tests",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Medium" },
      ],
      defaultReasoningEffort: "medium",
      isDefault: true,
    },
  ],
  selectedOnlyModels: [],
};

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
        sessionRestore: true,
        threadArchive: true,
        threadRename: true,
        threadGoalClear: true,
        fork: "checkpoint",
        approvalEnforcedBy: processOptions.approvalEnforcedBy ?? "runtime",
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        steerMode: "inject",
        skills: { configure: true },
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    io.sendResult(id, MODEL_LIST);
  },

  [BRIDGE_REQUEST_METHODS.providerHealth]: (id) => {
    io.sendResult(id, {
      supported: true,
      health: {
        status: "ready",
        statusMessage: null,
        accountEmail: null,
        planLabel: null,
        installedVersion: "999.0.0",
        minimumSupportedVersion: "1.0.0",
        canInstall: false,
        canUpdate: false,
        loginCommand: null,
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.providerUsage]: (id) => {
    io.sendResult(id, {
      supported: true,
      usage: { status: "ok", accountEmail: null, planLabel: null, windows: [] },
    });
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationStatus]: (id) => {
    io.sendResult(id, {
      executableName: "fake-provider",
      executablePath: "/fake/bin/fake-provider",
      installed: true,
      installSource: "external",
      currentVersion: "999.0.0",
      latestVersion: "999.0.0",
      minimumSupportedVersion: "1.0.0",
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      installAction: null,
      needsUpdate: false,
      versionUnsupported: false,
    });
  },

  [BRIDGE_REQUEST_METHODS.providerInstallationRun]: (id) => {
    io.sendResult(id, {
      available: false,
      message: "Fake provider installation is unavailable",
    });
  },

  [BRIDGE_REQUEST_METHODS.skillsConfigure]: (id, params) => {
    const parsed = skillsConfigureParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.skillsConfigure,
        parsed.error.issues,
      );
      return;
    }
    io.sendResult(id, {});
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
    const options = scriptedOptionsFor(parsed.data.options.providerOptions);
    afterStartDelay(options, () => {
      const session = openSession({
        threadId: parsed.data.threadId,
        providerThreadId: mintProviderThreadId(options),
        options,
      });
      logProcessStep(`thread/start:${process.pid}:${parsed.data.threadId}`);
      io.sendResult(id, identityResult(session));
      if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
        beginTurn({ session, input: parsed.data.input });
      }
    });
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
    const options = scriptedOptionsFor(parsed.data.options.providerOptions);
    if (rejectIfArchived(id, options, parsed.data.providerThreadId)) {
      return;
    }
    afterStartDelay(options, () => {
      const session = openSession({
        threadId: parsed.data.threadId,
        providerThreadId: parsed.data.providerThreadId,
        options,
      });
      logProcessStep(
        `thread/resume:${process.pid}:${parsed.data.threadId}:${parsed.data.providerThreadId}`,
      );
      io.sendResult(id, identityResult(session));
    });
  },

  [BRIDGE_REQUEST_METHODS.threadFork]: (id, params) => {
    const parsed = threadForkParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadFork, parsed.error.issues);
      return;
    }
    const options = scriptedOptionsFor(parsed.data.options.providerOptions);
    if (rejectIfArchived(id, options, parsed.data.sourceProviderThreadId)) {
      return;
    }
    afterStartDelay(options, () => {
      const session = openSession({
        threadId: parsed.data.threadId,
        providerThreadId: mintProviderThreadId(options),
        options,
      });
      io.sendResult(id, identityResult(session));
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
      io.sendError(id, -32000, `Unknown thread: ${parsed.data.threadId}`);
      return;
    }
    session.options = scriptedOptionsFor(parsed.data.options.providerOptions);
    if (rejectIfArchived(id, session.options, session.providerThreadId)) {
      return;
    }
    logProcessStep(
      `turn/start:${process.pid}:${parsed.data.threadId}:${promptText(parsed.data.input)}`,
    );
    const responseDelayMs = session.options.turnStartResponseDelayMs;
    if (responseDelayMs === undefined) {
      io.sendResult(id, {});
    }
    if (session.options.swallowTurnStart !== true) {
      beginTurn({
        session,
        input: parsed.data.input,
        clientRequestId: parsed.data.clientRequestId,
      });
    }
    if (responseDelayMs !== undefined) {
      setTimeout(() => io.sendResult(id, {}), responseDelayMs);
    }
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(id, -32000, `Unknown thread: ${parsed.data.threadId}`);
      return;
    }
    const options = scriptedOptionsFor(parsed.data.options.providerOptions);
    if (rejectIfArchived(id, options, session.providerThreadId)) {
      return;
    }
    if (session.activeTurn === null) {
      const message = `No active turn to steer (expected ${parsed.data.expectedTurnId})`;
      io.sendError(id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, message, {
        recovery: {
          kind: "staleTurn",
          message,
          retryable: false,
        } satisfies ProviderRecoveryHint,
      });
      return;
    }
    emitDeltas(session.threadId, [
      {
        kind: "input.accepted",
        clientRequestId: parsed.data.clientRequestId,
        providerTurnId: session.activeTurn.providerTurnId,
      },
    ]);
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    logProcessStep(`thread/stop:${process.pid}:${parsed.data.threadId}`);
    const stopOptions = session?.options ?? processOptions;
    if (stopOptions.failStopForThreadIds?.includes(parsed.data.threadId)) {
      io.sendError(id, -32000, `stop refused for ${parsed.data.threadId}`);
      return;
    }
    if (
      session !== undefined &&
      parsed.data.intent === "interrupt" &&
      session.activeTurn !== null
    ) {
      completeTurn(session, "interrupted", "");
    }
    sessions.delete(parsed.data.threadId);
    openBackgroundTasks.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadDiscard]: (id, params) => {
    const parsed = threadDiscardParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadDiscard,
        parsed.error.issues,
      );
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    const options = session?.options ?? processOptions;
    if (options.discardFailsOnce === true && !discardFailed) {
      discardFailed = true;
      io.sendError(id, -32000, "discard is temporarily unavailable");
      return;
    }
    sessions.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadArchive]: (id, params) => {
    const parsed = threadArchiveParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadArchive,
        parsed.error.issues,
      );
      return;
    }
    archivedSessionIds.add(parsed.data.providerThreadId);
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadUnarchive]: (id, params) => {
    const parsed = threadUnarchiveParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadUnarchive,
        parsed.error.issues,
      );
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    const options = session?.options ?? processOptions;
    if (options.unarchiveFails === true) {
      io.sendError(id, -32000, "unarchive is unavailable");
      return;
    }
    unarchivedSessionIds.add(parsed.data.providerThreadId);
    archivedSessionIds.delete(parsed.data.providerThreadId);
    io.sendResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadNameSet]: (id, params) => {
    const parsed = threadNameSetParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadNameSet,
        parsed.error.issues,
      );
      return;
    }
    io.sendResult(id, {});
    if (sessions.has(parsed.data.threadId)) {
      emitDeltas(parsed.data.threadId, [
        { kind: "thread.name", name: parsed.data.title },
      ]);
    }
  },

  [BRIDGE_REQUEST_METHODS.threadGoalClear]: (id, params) => {
    const parsed = threadGoalClearParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(
        id,
        BRIDGE_REQUEST_METHODS.threadGoalClear,
        parsed.error.issues,
      );
      return;
    }
    const session = sessions.get(parsed.data.threadId);
    const options = session?.options ?? processOptions;
    const notifyCleared = (): void => {
      emitDeltas(parsed.data.threadId, [
        {
          kind: "extension.state",
          extensionKind: "provider-codex/goal",
          payload: null,
        },
      ]);
    };
    const answer = { cleared: options.goalClearReportsCleared ?? true };
    if (options.goalClearNotifyDelayMs === undefined) {
      notifyCleared();
      io.sendResult(id, answer);
      return;
    }
    io.sendResult(id, answer);
    setTimeout(notifyCleared, options.goalClearNotifyDelayMs);
  },
};

function recordRequest(method: string, params: unknown): void {
  const recordPath = process.env[SCRIPTED_RECORD_PATH_ENV];
  if (recordPath === undefined || recordPath.length === 0) {
    return;
  }
  appendFileSync(
    recordPath,
    `${JSON.stringify({ method, params: params ?? null })}\n`,
  );
}

function applyScriptedMethodPolicy(
  id: JsonRpcId,
  method: string,
  options: ScriptedEchoOptions,
): "handled" | "continue" {
  const scripted = scriptedMethodSchema.safeParse(method);
  if (!scripted.success) {
    return "continue";
  }
  if (options.crashOn === scripted.data) {
    exitProcess();
  }
  if (options.unsupportedMethods?.includes(scripted.data)) {
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Method not found: ${method}`,
    );
    return "handled";
  }
  const failureIndex = (options.failMethods ?? []).findIndex(
    (entry, index) =>
      entry.method === scripted.data &&
      (entry.times === undefined ||
        (scriptedFailureCounts.get(index) ?? 0) < entry.times),
  );
  const failure =
    failureIndex === -1 ? undefined : options.failMethods?.[failureIndex];
  if (failure !== undefined) {
    const failedSoFar = scriptedFailureCounts.get(failureIndex) ?? 0;
    {
      scriptedFailureCounts.set(failureIndex, failedSoFar + 1);
      io.sendError(
        id,
        failure.code ?? -32000,
        failure.message,
        failure.recovery === undefined
          ? undefined
          : {
              recovery: {
                kind: failure.recovery.kind,
                message: failure.message,
                retryable: failure.recovery.retryable,
              } satisfies ProviderRecoveryHint,
            },
      );
      return "handled";
    }
  }
  return "continue";
}

function optionsForRequest(params: unknown): ScriptedEchoOptions {
  const parsed = z
    .object({
      threadId: z.string().optional(),
      options: z
        .object({
          providerOptions: z.record(z.string(), z.unknown()).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .safeParse(params);
  if (!parsed.success) {
    return processOptions;
  }
  if (parsed.data.options?.providerOptions !== undefined) {
    return scriptedOptionsFor(parsed.data.options.providerOptions);
  }
  const session =
    parsed.data.threadId === undefined
      ? undefined
      : sessions.get(parsed.data.threadId);
  return session?.options ?? processOptions;
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
  const { id, method, params, result, error } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (typeof method !== "string") {
    if (typeof id === "string" || typeof id === "number") {
      handleResponse(id, result, error);
    }
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") {
    return;
  }
  recordRequest(method, params);
  const options = optionsForRequest(params);
  if (applyScriptedMethodPolicy(id, method, options) === "handled") {
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
  if (options.exitAfter === method) {
    exitProcess();
  }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  onSigterm: () => {
    logProcessStep(`exit:${process.pid}`);
    if (processOptions.emitIdentityOnSigterm === true) {
      for (const session of sessions.values()) {
        notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
          threadId: session.threadId,
          providerThreadId: `late-${session.providerThreadId}`,
        });
      }
      setTimeout(() => process.exit(0), 10);
      return;
    }
    process.exit(0);
  },
});
