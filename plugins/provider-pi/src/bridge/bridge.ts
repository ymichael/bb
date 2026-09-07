#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  createPendingToolCallTracker,
  decodeBridgeJsonRpcResponse,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
  isStandaloneBuiltinCompactCommand,
  mimeTypeFromExtension,
  modelListParamsSchema,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadForkParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type BridgeToolCallRequest,
  type InitializeResult,
  type ThreadDelta,
  type ThreadEventContextWindowUsage,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createPiDeltaTranslator } from "../delta-translation.js";
import {
  buildPiSessionParams,
  buildPiTurnOptions,
  type PiSessionParams,
} from "../session-params.js";
import { BB_PI_EXTENSION_SOURCE } from "./bb-pi-extension.js";
import {
  getPiInstallGate,
  getPiProviderInstallationRun,
  getPiProviderInstallationStatus,
  piHealthResult,
  resetPiInstallGateForTests,
} from "./provider-maintenance.js";
import {
  closeAllPiCatalogs,
  createLiveContextWindowResolver,
  getPiCatalog,
  peekPiCatalog,
} from "./catalog.js";
import {
  PiRpcSession,
  type PiRpcSessionOptions,
  type ToolCallForwarder,
} from "./rpc-session.js";
import {
  resolvePiBridgeSessionDir,
  resolvePiSessionFilePath,
} from "./session-paths.js";

const piCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({ method: z.literal("model/list"), params: modelListParamsSchema }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: threadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: threadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: threadForkParamsSchema,
  }),
  z.object({ method: z.literal("turn/start"), params: turnStartParamsSchema }),
  z.object({ method: z.literal("turn/steer"), params: turnSteerParamsSchema }),
  z.object({
    method: z.literal("thread/stop"),
    params: threadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: threadDiscardParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

type PiCommand = z.infer<typeof piCommandSchema>;

const piCommandMethodValues = piCommandSchema.options.map(
  (option) => option.shape.method.value,
);

type DecodedPiBridgeRequest =
  | { kind: "request"; request: PiCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodePiJsonRpcRequest(raw: unknown): DecodedPiBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }
  const command = piCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (command.success) {
    return {
      kind: "request",
      request: { ...command.data, id: envelope.data.id },
    };
  }
  if (
    !(piCommandMethodValues as readonly string[]).includes(envelope.data.method)
  ) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method,
    };
  }
  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; "),
  };
}

interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface CurrentThreadSessionArgs {
  sessionSerial: number;
  threadId: string;
}

interface ThreadSession {
  session: PiRpcSession;
  sessionSerial: number;
  closing: boolean;
  providerThreadId: string;
  cwd: string;
  construction: PiSessionParams;
  constructionModel: { provider: string; id: string } | undefined;
}

let sessionSerialCounter = 0;
const THREAD_STOP_CLOSE_TIMEOUT_MS = 8_000;

const { send, sendResult, sendError } = createBridgeIo<
  BridgeEventNotification | BridgeToolCallRequest
>();

const sessions = new Map<string, ThreadSession>();
const closingSessions = new Map<string, Promise<string | undefined>>();
const { forwardToolCall, handleToolCallResponse, resolvePendingToolCalls } =
  createPendingToolCallTracker({ sendToolCall: send });

let configuredSkillPaths: string[] | null = null;

let scratchDir: string | null = null;
let scratchDirIsPrivate = false;
let extensionPath: string | null = null;

function requireScratchDir(): string {
  if (scratchDir === null) {
    scratchDir = join(
      tmpdir(),
      `bb-pi-bridge-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    scratchDirIsPrivate = true;
    mkdirSync(scratchDir, { recursive: true });
  }
  return scratchDir;
}

function requireExtensionPath(): string {
  if (extensionPath === null) {
    const path = join(requireScratchDir(), "bb-pi-extension.mjs");
    writeFileSync(path, BB_PI_EXTENSION_SOURCE, "utf8");
    extensionPath = path;
  }
  return extensionPath;
}

const contextWindows = createLiveContextWindowResolver();
const piDeltaTranslator = createPiDeltaTranslator({
  resolveModelContextWindow: contextWindows.resolve,
});

function createForwardToolCall(getThreadId: () => string): ToolCallForwarder {
  return (toolName, args) => {
    const threadId = getThreadId();
    const threadSession = sessions.get(threadId);
    if (!threadSession || threadSession.closing) {
      return Promise.resolve({
        content: "Thread session not found",
        isError: true,
      });
    }
    return forwardToolCall({
      arguments: args,
      providerThreadId: threadSession.providerThreadId,
      scope: threadSession,
      threadId,
      toolName,
    });
  };
}

async function closeThreadSession(args: {
  message: string;
  threadId: string;
}): Promise<string | undefined> {
  const existingClose = closingSessions.get(args.threadId);
  if (existingClose) {
    return existingClose;
  }
  const threadSession = sessions.get(args.threadId);
  if (!threadSession) {
    return;
  }
  threadSession.closing = true;
  resolvePendingToolCalls(threadSession, args.message);
  const closePromise = Promise.resolve()
    .then(() =>
      threadSession.session.closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS),
    )
    .finally(() => {
      if (sessions.get(args.threadId) === threadSession) {
        sessions.delete(args.threadId);
      }
      closingSessions.delete(args.threadId);
    });
  closingSessions.set(args.threadId, closePromise);
  return closePromise;
}

async function closeThreadSessionsGracefully(message: string): Promise<void> {
  await Promise.all(
    Array.from(sessions.keys()).map((threadId) =>
      closeThreadSession({ message, threadId }),
    ),
  );
}

function sendThreadDeltas(
  threadId: string,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  send({
    jsonrpc: "2.0",
    method: THREAD_DELTA_NOTIFICATION_METHOD,
    params: { threadId, deltas: [...deltas] },
  });
}

function emitForSession(
  threadId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  sendThreadDeltas(
    threadId,
    piDeltaTranslator.translate(
      { jsonrpc: "2.0", method, params },
      { threadId, cwd: sessions.get(threadId)?.cwd },
    ),
  );
}

function sendThreadIdentity(threadId: string, providerThreadId: string): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
    params: { threadId, providerThreadId, sessionRestorable: true },
  });
}

function sendSessionScopedError(
  threadId: string,
  providerThreadId: string,
  message: string,
): void {
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.error,
    params: { threadId, providerThreadId, message },
  });
}

function emitSessionError(
  threadSession: ThreadSession,
  threadId: string,
  message: string,
): void {
  emitForSession(threadId, "error", { threadId, message });
  sendSessionScopedError(threadId, threadSession.providerThreadId, message);
}

function toContextWindowUsagePayload(
  contextUsage: { tokens: number | null; contextWindow: number } | null,
): ThreadEventContextWindowUsage | null {
  if (!contextUsage) {
    return null;
  }
  return {
    usedTokens: contextUsage.tokens,
    modelContextWindow:
      contextUsage.contextWindow > 0 ? contextUsage.contextWindow : null,
    estimated: true,
  };
}

function emitContextWindowUsage(threadId: string): void {
  const threadSession = sessions.get(threadId);
  if (!threadSession) {
    return;
  }
  const contextWindowUsage = toContextWindowUsagePayload(
    threadSession.session.getContextUsage(),
  );
  if (!contextWindowUsage) {
    return;
  }
  emitForSession(threadId, "thread/contextWindowUsage/updated", {
    threadId,
    contextWindowUsage,
  });
}

function nextSessionSerial(): number {
  sessionSerialCounter += 1;
  return sessionSerialCounter;
}

function getCurrentThreadSession(
  args: CurrentThreadSessionArgs,
): ThreadSession | undefined {
  const threadSession = sessions.get(args.threadId);
  if (
    !threadSession ||
    threadSession.closing ||
    threadSession.sessionSerial !== args.sessionSerial
  ) {
    return undefined;
  }
  return threadSession;
}

function createOnPiEvent(
  args: CurrentThreadSessionArgs,
): (event: Record<string, unknown>) => void {
  return (event) => {
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession) return;
    emitForSession(args.threadId, "sdk/message", {
      threadId: args.threadId,
      message: event,
    });
    if (event.type === "turn_end" || event.type === "compaction_end") {
      emitContextWindowUsage(args.threadId);
    }
  };
}

function createOnSessionDone(
  args: CurrentThreadSessionArgs,
): (error?: unknown) => void {
  return (error?: unknown) => {
    if (error) {
      reportSessionError({ ...args, error });
      return;
    }
    const threadSession = getCurrentThreadSession(args);
    if (!threadSession) {
      return;
    }
    void closeThreadSession({
      message: "Pi session ended while tool call was pending",
      threadId: args.threadId,
    }).catch((shutdownError: unknown) => {
      sendSessionScopedError(
        args.threadId,
        threadSession.providerThreadId,
        shutdownError instanceof Error
          ? shutdownError.message
          : String(shutdownError),
      );
    });
  };
}

function reportPromptSettled(args: {
  error?: unknown;
  sessionSerial: number;
  threadId: string;
}): void {
  const threadSession = getCurrentThreadSession(args);
  if (!threadSession) {
    return;
  }
  const errorMessage =
    args.error === undefined
      ? undefined
      : args.error instanceof Error
        ? args.error.message
        : String(args.error);
  emitForSession(args.threadId, "pi/prompt/settled", {
    threadId: args.threadId,
    status: errorMessage === undefined ? "completed" : "failed",
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
  });
}

function reportSessionError(
  args: CurrentThreadSessionArgs & { error: unknown },
): void {
  const threadSession = getCurrentThreadSession(args);
  if (!threadSession) return;
  emitSessionError(
    threadSession,
    args.threadId,
    args.error instanceof Error ? args.error.message : String(args.error),
  );
}

async function handleRequest(
  request: PiCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize": {
      const result: InitializeResult = {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: true,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "checkpoint",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "inject",
          skills: { configure: true },
        },
      };
      sendResult(request.id, result);
      break;
    }
    case "model/list":
      await handleModelList(request.id, request.params);
      break;
    case "provider/health":
      await handleProviderHealth(request.id, request.params);
      break;
    case "provider/usage":
      sendResult(request.id, { supported: false });
      break;
    case "provider/installation/status":
      sendResult(request.id, await getPiProviderInstallationStatus());
      break;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getPiProviderInstallationRun(request.params.action),
      );
      break;
    case "thread/start":
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        request.params.threadId,
        toPiSessionParams(request.params),
      );
      break;
    case "thread/resume": {
      const missingCwd = resumedSessionMissingCwd(
        request.params.providerThreadId,
      );
      if (missingCwd !== null) {
        sendError(
          request.id,
          -32000,
          `Cannot resume: the pi session's working directory "${missingCwd}" no longer exists.`,
        );
        break;
      }
      await handleThreadConstruction(
        request.id,
        request.params.threadId,
        request.params.providerThreadId,
        toPiSessionParams(request.params),
      );
      break;
    }
    case "thread/fork":
      await handleThreadFork(request.id, request.params);
      break;
    case "turn/start":
      await handleTurnStart(request.id, request.params);
      break;
    case "turn/steer":
      await handleTurnSteer(request.id, request.params);
      break;
    case "thread/stop":
      await handleThreadStop(request.id, request.params);
      break;
    case "thread/discard":
      sendResult(request.id, await handleThreadDiscard(request.params));
      break;
    case "skills/configure":
      configuredSkillPaths = request.params.roots.map((root) => root.path);
      sendResult(request.id, { ok: true });
      break;
  }
}

type ThreadForkParams = z.infer<typeof threadForkParamsSchema>;
type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
type TurnSteerParams = z.infer<typeof turnSteerParamsSchema>;
type ThreadStopParams = z.infer<typeof threadStopParamsSchema>;
type ThreadRefParams = z.infer<typeof threadDiscardParamsSchema>;

function toPiSessionParams(
  params: z.infer<typeof threadStartParamsSchema>,
): PiSessionParams {
  return buildPiSessionParams({
    threadId: params.threadId,
    cwd: params.cwd,
    options: params.options,
    instructionMode: params.instructionMode,
    dynamicTools: params.dynamicTools,
    additionalSkillPaths: configuredSkillPaths ?? undefined,
  });
}

async function handleModelList(
  id: string | number,
  params: { cwd?: string },
): Promise<void> {
  const gate = await getPiInstallGate();
  if (!gate.ok) {
    sendError(
      id,
      -32000,
      gate.status === "not_installed"
        ? "Could not find the pi CLI on this host. Install @earendil-works/pi-coding-agent and retry."
        : (gate.statusMessage ?? "Pi is not supported on this host."),
    );
    return;
  }
  try {
    const catalog = await getPiCatalog(
      params.cwd ?? process.cwd(),
      requireExtensionPath(),
    );
    contextWindows.learn(await catalog.rawModels());
    sendResult(id, await catalog.listModels());
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleProviderHealth(
  id: string | number,
  params: { cwd?: string },
): Promise<void> {
  const gate = await getPiInstallGate();
  if (!gate.ok) {
    sendResult(id, gate.result);
    return;
  }
  const installedVersion = gate.installedVersion;
  try {
    const catalog = await getPiCatalog(
      params.cwd ?? process.cwd(),
      requireExtensionPath(),
    );
    await catalog.probe();
    const models = await catalog.rawModels();
    sendResult(
      id,
      models.length > 0
        ? piHealthResult("ready", { installedVersion })
        : piHealthResult("unauthenticated", {
            installedVersion,
            statusMessage: "Pi has no authenticated model provider available.",
          }),
    );
  } catch (error) {
    sendResult(
      id,
      piHealthResult("unknown", {
        installedVersion,
        statusMessage: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function resolvePiModel(
  modelStr: string,
  cwd: string,
): Promise<{ provider: string; id: string }> {
  const slashIdx = modelStr.indexOf("/");
  if (slashIdx > 0) {
    const provider = modelStr.slice(0, slashIdx);
    const id = modelStr.slice(slashIdx + 1);
    const warm = peekPiCatalog(cwd);
    if (warm !== null) {
      const models = await (await warm).rawModels();
      if (
        models.some((m) => m.provider === provider) &&
        !models.some((m) => m.provider === provider && m.id === id)
      ) {
        throw new Error(
          `Pi model "${modelStr}" is not served by provider "${provider}" on this host.`,
        );
      }
    }
    return { provider, id };
  }
  const catalog = await getPiCatalog(cwd, requireExtensionPath());
  const served = (await catalog.rawModels()).filter((m) => m.id === modelStr);
  if (served.length > 1) {
    throw new Error(
      `Ambiguous Pi model "${modelStr}": served by ${served
        .map((m) => String(m.provider))
        .join(", ")}. Prefix it with the provider you want.`,
    );
  }
  const match = served[0];
  if (!match || typeof match.provider !== "string") {
    throw new Error(`Failed to resolve Pi model "${modelStr}"`);
  }
  return { provider: match.provider, id: modelStr };
}

async function buildSessionOptions(args: {
  params: PiSessionParams;
  providerThreadId: string;
  threadId: string;
}): Promise<PiRpcSessionOptions> {
  return {
    cwd: args.params.cwd,
    ...(args.params.model
      ? { model: await resolvePiModel(args.params.model, args.params.cwd) }
      : {}),
    sessionFilePath: resolvePiSessionFilePath({
      env: process.env,
      threadId: args.providerThreadId,
    }),
    sessionDir: resolvePiBridgeSessionDir({ env: process.env }),
    systemPrompt: args.params.baseInstructions,
    appendSystemPrompt: args.params.appendSystemPrompt,
    shellEnvOverrides: args.params.shellEnvOverrides,
    ...(args.params.additionalSkillPaths
      ? { additionalSkillPaths: [...args.params.additionalSkillPaths] }
      : {}),
    ...(args.params.thinkingLevel
      ? { thinkingLevel: args.params.thinkingLevel }
      : {}),
    ...(args.params.dynamicTools && args.params.dynamicTools.length > 0
      ? { dynamicTools: args.params.dynamicTools }
      : {}),
    scratchDir: requireScratchDir(),
    extensionPath: requireExtensionPath(),
    recordThreadId: args.threadId,
  };
}

async function constructPiThreadSession(
  threadId: string,
  providerThreadId: string,
  params: PiSessionParams,
): Promise<ThreadSession> {
  const sessionSerial = nextSessionSerial();
  const sessionOptions = await buildSessionOptions({
    params,
    providerThreadId,
    threadId,
  });
  const session = new PiRpcSession(
    sessionOptions,
    createForwardToolCall(() => threadId),
    createOnPiEvent({ sessionSerial, threadId }),
    createOnSessionDone({ sessionSerial, threadId }),
  );
  const threadSession: ThreadSession = {
    session,
    sessionSerial,
    closing: false,
    providerThreadId,
    cwd: persistedSessionCwd(providerThreadId) ?? params.cwd,
    construction: params,
    constructionModel: sessionOptions.model,
  };
  sessions.set(threadId, threadSession);
  try {
    await session.start();
    const liveModel = session.getLiveModel();
    if (
      liveModel &&
      typeof liveModel.id === "string" &&
      typeof liveModel.provider === "string"
    ) {
      contextWindows.learn([
        {
          id: liveModel.id,
          provider: liveModel.provider,
          contextWindow: liveModel.contextWindow,
        },
      ]);
    }
    return threadSession;
  } catch (error) {
    if (sessions.get(threadId) === threadSession) {
      sessions.delete(threadId);
    }
    session.kill();
    throw error;
  }
}

async function startPiThreadSession(
  threadId: string,
  providerThreadId: string,
  params: PiSessionParams,
): Promise<void> {
  const existing = sessions.get(threadId);
  if (existing) {
    await closeThreadSession({
      message: "Pi thread session replaced while tool call was pending",
      threadId,
    });
  }
  await constructPiThreadSession(threadId, providerThreadId, params);
}

function retireReplacedPiChild(replaced: ThreadSession): void {
  replaced.closing = true;
  resolvePendingToolCalls(
    replaced,
    "Pi thread session replaced while tool call was pending",
  );
  void replaced.session
    .closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS)
    .catch(() => undefined);
}

async function rebuildThreadSession(
  threadId: string,
  previous: ThreadSession,
  params: PiSessionParams,
): Promise<ThreadSession> {
  let replacement: ThreadSession;
  try {
    replacement = await constructPiThreadSession(
      threadId,
      previous.providerThreadId,
      params,
    );
  } catch (error) {
    if (!sessions.has(threadId) && !previous.closing) {
      sessions.set(threadId, previous);
    }
    throw error;
  }
  retireReplacedPiChild(previous);
  return replacement;
}

function sendSessionResetBoundary(threadId: string): void {
  piDeltaTranslator.resetThread(threadId);
  sendThreadDeltas(threadId, [{ kind: "session.reset" }]);
}

function sendThreadSessionResult(
  id: string | number,
  threadId: string,
  providerThreadId: string,
): void {
  sendThreadIdentity(threadId, providerThreadId);
  sendSessionResetBoundary(threadId);
  sendResult(id, { providerThreadId, sessionRestorable: true });
}

async function handleThreadConstruction(
  id: string | number,
  threadId: string,
  providerThreadId: string,
  params: PiSessionParams,
): Promise<void> {
  await startPiThreadSession(threadId, providerThreadId, params);
  sendThreadSessionResult(id, threadId, providerThreadId);
}

function resumedSessionMissingCwd(providerThreadId: string): string | null {
  const cwd = persistedSessionCwd(providerThreadId);
  return cwd !== null && !existsSync(cwd) ? cwd : null;
}

function persistedSessionCwd(providerThreadId: string): string | null {
  const sessionFile = resolvePiSessionFilePath({
    env: process.env,
    threadId: providerThreadId,
  });
  let firstLine: string;
  try {
    firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0] ?? "";
  } catch {
    return null;
  }
  try {
    const header = JSON.parse(firstLine) as { type?: unknown; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string"
      ? header.cwd
      : null;
  } catch {
    return null;
  }
}

async function handleThreadFork(
  id: string | number,
  params: ThreadForkParams,
): Promise<void> {
  const sourceSessionFile = resolvePiSessionFilePath({
    env: process.env,
    threadId: params.sourceProviderThreadId,
  });
  if (!existsSync(sourceSessionFile)) {
    sendError(
      id,
      -32000,
      `Cannot fork: source pi session file not found for thread "${params.sourceProviderThreadId}"`,
    );
    return;
  }
  const targetSessionFile = resolvePiSessionFilePath({
    env: process.env,
    threadId: params.threadId,
  });
  mkdirSync(resolvePiBridgeSessionDir({ env: process.env }), {
    recursive: true,
  });
  try {
    await PiRpcSession.forkSessionFile({
      sourceFile: sourceSessionFile,
      targetFile: targetSessionFile,
      cwd: params.cwd,
      sessionDir: resolvePiBridgeSessionDir({ env: process.env }),
      ...(params.sourceProviderCheckpointId === undefined
        ? {}
        : { checkpointId: params.sourceProviderCheckpointId }),
      extensionPath: requireExtensionPath(),
      scratchDir: requireScratchDir(),
      recordThreadId: params.threadId,
    });
  } catch (error) {
    rmSync(targetSessionFile, { force: true });
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  await handleThreadConstruction(
    id,
    params.threadId,
    params.threadId,
    toPiSessionParams(params),
  );
}

function startPiPrompt(
  threadSession: ThreadSession,
  threadId: string,
  text: string,
  images: ImageContent[],
): Promise<void> {
  const dispatch = threadSession.session.prompt(
    text,
    images.length > 0 ? images : undefined,
  );
  void dispatch.settled.then((outcome) => {
    if (outcome === null) {
      return;
    }
    reportPromptSettled({
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      sessionSerial: threadSession.sessionSerial,
      threadId,
    });
  });
  return dispatch.consumed;
}

function startPiCompaction(
  threadSession: ThreadSession,
  threadId: string,
): void {
  void threadSession.session.compact().then(
    () =>
      reportPromptSettled({
        sessionSerial: threadSession.sessionSerial,
        threadId,
      }),
    (error: unknown) =>
      reportPromptSettled({
        error,
        sessionSerial: threadSession.sessionSerial,
        threadId,
      }),
  );
}

function recordAcceptedTurnInput(params: TurnStartParams): void {
  sendThreadDeltas(params.threadId, [
    { kind: "input.accepted", clientRequestId: params.clientRequestId },
  ]);
}

async function reconcileTurnOptions(
  threadId: string,
  threadSession: ThreadSession,
  options: TurnStartParams["options"],
): Promise<ThreadSession> {
  const turnOptions = buildPiTurnOptions(options);
  const construction = threadSession.construction;
  const changedModelRequest =
    turnOptions.model !== undefined && turnOptions.model !== construction.model
      ? turnOptions.model
      : undefined;
  const thinkingLevelChanged =
    turnOptions.thinkingLevel !== undefined &&
    turnOptions.thinkingLevel !== construction.thinkingLevel;
  if (changedModelRequest === undefined && !thinkingLevelChanged) {
    return threadSession;
  }
  const nextModel =
    changedModelRequest === undefined
      ? undefined
      : await resolvePiModel(changedModelRequest, construction.cwd);
  const modelChanged =
    nextModel !== undefined &&
    (threadSession.constructionModel === undefined ||
      threadSession.constructionModel.provider !== nextModel.provider ||
      threadSession.constructionModel.id !== nextModel.id);
  if (!modelChanged && !thinkingLevelChanged) {
    return threadSession;
  }
  const replacement = await rebuildThreadSession(threadId, threadSession, {
    ...construction,
    ...(turnOptions.model === undefined ? {} : { model: turnOptions.model }),
    ...(turnOptions.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: turnOptions.thinkingLevel }),
  });
  sendThreadIdentity(threadId, replacement.providerThreadId);
  sendSessionResetBoundary(threadId);
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.sessionReplaced,
    params: {
      threadId,
      providerThreadId: replacement.providerThreadId,
      reason:
        "Execution settings changed; the pi session was rebuilt to apply them.",
      contextLost: false,
    },
  });
  return replacement;
}

async function handleTurnStart(
  id: string | number,
  params: TurnStartParams,
): Promise<void> {
  const liveSession = sessions.get(params.threadId);
  if (!liveSession || liveSession.closing) {
    sendError(id, -32000, "No active pi session");
    return;
  }
  let threadSession: ThreadSession;
  try {
    threadSession = await reconcileTurnOptions(
      params.threadId,
      liveSession,
      params.options,
    );
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  if (isStandaloneBuiltinCompactCommand(params.input)) {
    recordAcceptedTurnInput(params);
    startPiCompaction(threadSession, params.threadId);
    sendResult(id, { threadId: params.threadId });
    return;
  }
  const { text, images } = extractInput(params.input);
  if (!text && images.length === 0) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }
  try {
    await startPiPrompt(threadSession, params.threadId, text ?? "", images);
    recordAcceptedTurnInput(params);
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleTurnSteer(
  id: string | number,
  params: TurnSteerParams,
): Promise<void> {
  const threadSession = sessions.get(params.threadId);
  if (!threadSession || threadSession.closing) {
    sendError(id, -32000, "No active pi session");
    return;
  }
  const { text, images } = extractInput(params.input);
  if (!text && images.length === 0) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }
  if (threadSession.session.getIsCompacting()) {
    sendError(id, -32000, "Cannot steer while context compaction is active");
    return;
  }
  try {
    await threadSession.session.steer(
      text ?? "",
      images.length > 0 ? images : undefined,
    );
    sendThreadDeltas(params.threadId, [
      { kind: "input.accepted", clientRequestId: params.clientRequestId },
    ]);
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    sendError(
      id,
      -32000,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParams,
): Promise<void> {
  const threadSession = sessions.get(params.threadId);
  if (
    params.intent === "interrupt" &&
    threadSession !== undefined &&
    !threadSession.closing
  ) {
    sendThreadDeltas(params.threadId, [{ kind: "session.ended" }]);
  }
  const providerCheckpointId =
    (await closeThreadSession({
      message: "Pi thread stopped while tool call was pending",
      threadId: params.threadId,
    })) ?? null;
  sendResult(id, { ok: true, providerCheckpointId });
}

async function handleThreadDiscard(
  params: ThreadRefParams,
): Promise<{ ok: true }> {
  await closeThreadSession({
    message: "Pi staged thread discarded while tool call was pending",
    threadId: params.threadId,
  });
  rmSync(
    resolvePiSessionFilePath({
      env: process.env,
      threadId: params.providerThreadId,
    }),
    {
      force: true,
    },
  );
  return { ok: true };
}

interface ExtractedInput {
  text?: string;
  images: ImageContent[];
}

function extractInput(input: TurnStartParams["input"]): ExtractedInput {
  const chunks: string[] = [];
  const images: ImageContent[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const typed = item as {
      type?: string;
      text?: string;
      path?: string;
      mimeType?: string;
    };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    } else if (typed.type === "localImage" && typeof typed.path === "string") {
      try {
        const data = readFileSync(typed.path).toString("base64");
        const mimeType = typed.mimeType ?? mimeTypeFromExtension(typed.path);
        images.push({ type: "image", data, mimeType });
      } catch {}
    } else if (typed.type === "localFile" && typeof typed.path === "string") {
      chunks.push(`[Attached file: ${typed.path}]`);
    }
  }
  return { text: chunks.length > 0 ? chunks.join("\n") : undefined, images };
}

function handleParsedMessage(parsed: unknown): void {
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response && handleToolCallResponse(response)) {
    return;
  }
  const decoded = decodePiJsonRpcRequest(parsed);
  if (decoded.kind === "ignored") {
    return;
  }
  if (decoded.kind === "unknown-method") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unknown method "${decoded.method}"`,
    );
    return;
  }
  if (decoded.kind === "invalid-params") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for "${decoded.method}": ${decoded.issues}`,
    );
    return;
  }
  runBridgeRequest({ request: decoded.request, handleRequest, sendError });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

/** @internal Test inspection: where this process writes its scratch files. */
export function experimental_scratchDirForTests(): string {
  return requireScratchDir();
}

/**
 * @internal Test cleanup: every pi child this process runs, and the private
 * scratch dir (a suite never runs the entry's `start`, so nothing else would
 * remove it).
 */
export async function experimental_closeAllForTests(): Promise<void> {
  await closeThreadSessionsGracefully("Pi bridge test teardown");
  await closeAllPiCatalogs();
  resetPiInstallGateForTests();
  if (scratchDir !== null && scratchDirIsPrivate) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
    scratchDirIsPrivate = false;
    extensionPath = null;
  }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: (context) => {
    scratchDir = join(context.tempDir, "pi");
    scratchDirIsPrivate = false;
    mkdirSync(scratchDir, { recursive: true });
  },
  onClose: () => {
    void closeThreadSessionsGracefully(
      "Pi bridge shutting down while tool call was pending",
    ).finally(() => {
      void closeAllPiCatalogs();
      process.exit(0);
    });
  },
  onSigterm: () => {
    void closeThreadSessionsGracefully(
      "Pi bridge terminated while tool call was pending",
    ).finally(() => {
      void closeAllPiCatalogs();
      process.exit(0);
    });
  },
});
