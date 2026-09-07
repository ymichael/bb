#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  isStandaloneBuiltinCompactCommand,
  approvalInteractionOutcomeSchema,
  type DynamicTool,
  type PromptInput,
  type ThreadDelta,
  sanitizeInheritedChildProcessEnv,
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  initializeParamsSchema,
  modelListParamsSchema,
  providerInstallationRunParamsSchema,
  providerInstallationStatusParamsSchema,
  providerMaintenanceParamsSchema,
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
  type BridgeExecutionOptions,
  type InitializeResult,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  decodeBridgeJsonRpcResponse,
  runBridgeRequest,
  withoutBridgeRuntimeEnv,
  type BridgeJsonRpcResponse,
  type DecodedInteractiveRequest,
  type PreparedProviderCommandDispatch,
  type ProviderPostInitializeRequest,
  type ProviderRuntimeEvent,
  experimental_defineProviderBridge,
  type ProviderRecoveryHint,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  CODEX_MACOS_PERMISSION_EXTENSION_KIND,
  summarizeCodexMacOsPermissions,
} from "../extension-kinds.js";
import {
  buildCodexInteractiveResponse,
  decodeCodexInteractiveRequest,
  extractCodexMacOsPermissionRequest,
  type CodexMacOsPermissionRequest,
} from "../interactive-requests.js";
import { parseModelsResponse } from "../models.js";
import { macOsPermissionPresentation } from "../presentation.js";
import {
  resolveCodexInstructionOverrides,
  toCodexDynamicTools,
  toCodexPermissionSettings,
  toCodexServiceTier,
  toCodexThreadPermissionSettings,
  toCodexUserInput,
  type BbThreadForkParams,
  type BbThreadStartParams,
  type CodexSessionOptions,
} from "../session-params.js";
import type { ThreadResumeParams } from "../generated/codex-app-server/schema/v2/ThreadResumeParams.js";
import {
  createCodexEventTranslator,
  type CodexEventTranslator,
} from "../translator.js";
import {
  createCodexAppServerConnection,
  CodexAppServerExitedError,
  type CodexAppServerConnection,
  type CodexAppServerExitInfo,
  type CodexAppServerRequestResponder,
} from "./app-server-connection.js";
import {
  getCodexProviderHealth,
  getCodexProviderInstallationRun,
  getCodexProviderInstallationStatus,
  getCodexProviderUsage,
} from "./provider-maintenance.js";

type BbThreadResumeParams = ThreadResumeParams & { excludeTurns: boolean };

const codexBridgeCommandSchema = z.discriminatedUnion("method", [
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
    method: z.literal("thread/name/set"),
    params: threadNameSetParamsSchema,
  }),
  z.object({
    method: z.literal("thread/archive"),
    params: threadArchiveParamsSchema,
  }),
  z.object({
    method: z.literal("thread/unarchive"),
    params: threadUnarchiveParamsSchema,
  }),
  z.object({
    method: z.literal("thread/goal/clear"),
    params: threadGoalClearParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

type CodexBridgeCommand = z.infer<typeof codexBridgeCommandSchema>;

const codexBridgeCommandMethodValues = codexBridgeCommandSchema.options.map(
  (option) => option.shape.method.value,
);

type DecodedCodexBridgeRequest =
  | { kind: "request"; request: CodexBridgeCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodeCodexBridgeJsonRpcRequest(
  raw: unknown,
): DecodedCodexBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }

  const command = codexBridgeCommandSchema.safeParse({
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
    !(codexBridgeCommandMethodValues as readonly string[]).includes(
      envelope.data.method,
    )
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

interface BridgeNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface BridgeRuntimeRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const { send, sendResult, sendError } = createBridgeIo<
  BridgeNotification | BridgeRuntimeRequest
>();

function sendNotification(
  method: string,
  params: Record<string, unknown>,
): void {
  send({ jsonrpc: "2.0", method, params });
}

const pendingRuntimeRequests = new Map<
  number,
  (response: BridgeJsonRpcResponse) => void
>();
let runtimeRequestIdCounter = 0;

function sendRuntimeRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  runtimeRequestIdCounter += 1;
  const requestId = runtimeRequestIdCounter;
  const responsePromise = new Promise<unknown>(
    (resolveResponse, rejectResponse) => {
      pendingRuntimeRequests.set(requestId, (response) => {
        if ("error" in response) {
          rejectResponse(
            new Error(response.error.message ?? "Runtime request failed"),
          );
          return;
        }
        resolveResponse(response.result);
      });
    },
  );
  send({ jsonrpc: "2.0", id: requestId, method, params });
  return responsePromise;
}

const CODEX_APP_SERVER_COMMAND_ENV = "BB_CODEX_BRIDGE_APP_SERVER_COMMAND";
const CODEX_APP_SERVER_ARGS_ENV = "BB_CODEX_BRIDGE_APP_SERVER_ARGS";
const CODEX_POOL_BASE_URL_ENV = "CODEX_OPENAI_BASE_URL";
const CODEX_POOL_AUTH_TOKEN_ENV = "CODEX_POOL_AUTH_TOKEN";

const CODEX_INITIALIZE_PARAMS = {
  clientInfo: { name: "bb", version: "1.0.0", title: null },
  capabilities: { experimentalApi: true },
};

const CHILD_REQUEST_TIMEOUT_MS = 60_000;
const INTERRUPT_SETTLEMENT_TIMEOUT_MS = 5_000;
const CODEX_ARCHIVED_SESSION_ERROR_PATTERN =
  /\b(?:session|thread)\s+\S+\s+is archived\b/i;
const CODEX_ALREADY_ARCHIVED_ERROR_PATTERN =
  /\bno rollout found for thread id\b/i;
const CODEX_NOT_ARCHIVED_ERROR_PATTERN =
  /\bno archived rollout found for thread id\b/i;
const CODEX_EMPTY_ROLLOUT_RENAME_ERROR_PATTERN = /\brollout at .+ is empty\b/i;
const CODEX_RENAME_RETRY_DELAYS_MS = [50, 200] as const;
const CODEX_AUTH_REQUIRED_TEXT_PATTERN =
  /\b(?:40[13]|auth(?:entication|orization)?|unauthori[sz]ed)\b/i;
const CODEX_RATE_LIMITED_TEXT_PATTERN =
  /\b(?:429|credits?|quota|rate[-\s]?limit(?:ed)?|usage limit)\b/i;

function classifyTerminalAccountError(
  delta: Extract<ThreadDelta, { kind: "provider.error" }>,
): "authRequired" | "rateLimited" | null {
  const category = delta.errorInfo?.category;
  if (category === "unauthorized") {
    return "authRequired";
  }
  if (category === "rate-limit") {
    return "rateLimited";
  }
  if (category !== undefined && category !== "unknown") {
    return null;
  }
  const text = [delta.message, delta.detail]
    .filter((part) => part !== undefined)
    .join("\n");
  if (CODEX_AUTH_REQUIRED_TEXT_PATTERN.test(text)) {
    return "authRequired";
  }
  if (CODEX_RATE_LIMITED_TEXT_PATTERN.test(text)) {
    return "rateLimited";
  }
  return null;
}

function archivedSessionHint(message: string): ProviderRecoveryHint | null {
  return CODEX_ARCHIVED_SESSION_ERROR_PATTERN.test(message)
    ? { kind: "sessionArchived", message, retryable: true }
    : null;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
const MISSING_CODEX_CLI_GUIDANCE =
  "bb could not find the Codex CLI on this machine. Install Codex (https://developers.openai.com/codex/cli) or put `codex` on PATH, then retry.";

export function resolveAppServerLaunch(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  const command = env[CODEX_APP_SERVER_COMMAND_ENV];
  const rawArgs = env[CODEX_APP_SERVER_ARGS_ENV];
  const args = command
    ? rawArgs
      ? z.array(z.string()).parse(JSON.parse(rawArgs))
      : []
    : ["app-server"];
  const poolBaseUrl = env[CODEX_POOL_BASE_URL_ENV];
  const poolToken = env[CODEX_POOL_AUTH_TOKEN_ENV];
  if (!poolBaseUrl || !poolToken) return { command: command ?? "codex", args };
  return {
    command: command ?? "codex",
    args: [
      ...args,
      "-c",
      `openai_base_url=${JSON.stringify(poolBaseUrl)}`,
      "-c",
      'model_provider="bb-account-pool"',
      "-c",
      'model_providers.bb-account-pool.name="OpenAI"',
      "-c",
      `model_providers.bb-account-pool.base_url=${JSON.stringify(poolBaseUrl)}`,
      "-c",
      'model_providers.bb-account-pool.wire_api="responses"',
      "-c",
      "model_providers.bb-account-pool.requires_openai_auth=true",
      "-c",
      "model_providers.bb-account-pool.supports_websockets=true",
      "-c",
      'model_providers.bb-account-pool.env_http_headers.x-bb-account-pool-token="CODEX_POOL_AUTH_TOKEN"',
    ],
  };
}

function appServerLaunchEnv(
  envVars: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const poolBaseUrl = envVars?.[CODEX_POOL_BASE_URL_ENV];
  const poolAuthToken = envVars?.[CODEX_POOL_AUTH_TOKEN_ENV];
  return {
    ...process.env,
    ...(poolBaseUrl === undefined
      ? {}
      : { [CODEX_POOL_BASE_URL_ENV]: poolBaseUrl }),
    ...(poolAuthToken === undefined
      ? {}
      : { [CODEX_POOL_AUTH_TOKEN_ENV]: poolAuthToken }),
  };
}

function buildAppServerEnv(
  envVars: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  return withoutBridgeRuntimeEnv(
    sanitizeInheritedChildProcessEnv({
      env: appServerLaunchEnv(envVars),
    }),
  );
}

function describeCodexLaunchError(error: unknown): string {
  if (error instanceof CodexAppServerExitedError && error.spawnFailed) {
    return MISSING_CODEX_CLI_GUIDANCE;
  }
  return error instanceof Error ? error.message : String(error);
}

interface CodexSessionConstruction {
  cwd: string;
  instructionMode: "append" | "replace";
  dynamicTools: DynamicTool[] | undefined;
}

interface CodexBridgeSession {
  bbThreadId: string;
  codexThreadId: string | null;
  serial: number;
  connection: CodexAppServerConnection | null;
  translator: CodexEventTranslator;
  construction: CodexSessionConstruction;
  constructionSignature: string;
  openCodexTurnIds: Set<string>;
  turnSettledWaiters: Map<string, Array<() => void>>;
  awaitingReplayedUsage: boolean;
  identityAnnounced: boolean;
  pendingPreIdentityDeltas: ThreadDelta[];
  rebuildBeforeNextTurnReason: string | null;
  closing: boolean;
  previousChildExit: Promise<void> | null;
  releasePromise: Promise<void> | null;
}

const sessionsByBbThreadId = new Map<string, CodexBridgeSession>();
const maintenanceConnections = new Set<CodexAppServerConnection>();
let modelListConnection: CodexAppServerConnection | null = null;
let modelListConnectionPromise: Promise<CodexAppServerConnection> | null = null;
let sessionSerialCounter = 0;
let configuredSkillExtraRoots: string[] | null = null;

const LEGACY_BRIDGE_MINTED_ID_PATTERN = /^bt[0-9a-f]{8}-\d+-/;

function stripLegacyBridgeIdPrefix(id: string): string {
  const match = LEGACY_BRIDGE_MINTED_ID_PATTERN.exec(id);
  return match ? id.slice(match[0].length) : id;
}

function currentSession(
  bbThreadId: string,
  serial: number,
): CodexBridgeSession | undefined {
  const session = sessionsByBbThreadId.get(bbThreadId);
  if (!session || session.serial !== serial || session.closing) {
    return undefined;
  }
  return session;
}

function releaseSession(session: CodexBridgeSession): Promise<void> {
  if (session.releasePromise !== null) {
    return session.releasePromise;
  }
  session.closing = true;
  if (sessionsByBbThreadId.get(session.bbThreadId) === session) {
    sessionsByBbThreadId.delete(session.bbThreadId);
  }
  const previousChildExit = session.previousChildExit;
  session.previousChildExit = null;
  const currentChildExit = session.connection?.kill() ?? Promise.resolve();
  session.connection = null;
  const releasePromise =
    previousChildExit === null
      ? currentChildExit
      : Promise.all([previousChildExit, currentChildExit]).then(
          () => undefined,
        );
  session.releasePromise = releasePromise;
  return releasePromise;
}

const codexProviderOptionsSchema = z
  .object({
    memoryEnabled: z.boolean().optional(),
    providerSubagentsEnabled: z.boolean().optional(),
    additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
  })
  .passthrough();

interface DecodedCodexOptions {
  sessionOptions: CodexSessionOptions;
  additionalWorkspaceWriteRoots: string[];
}

function decodeCodexOptions(
  options: BridgeExecutionOptions,
): DecodedCodexOptions {
  const decoded = codexProviderOptionsSchema.parse(
    options.providerOptions ?? {},
  );
  return {
    sessionOptions: {
      ...options,
      ...(decoded.memoryEnabled !== undefined
        ? { memoryEnabled: decoded.memoryEnabled }
        : {}),
      ...(decoded.providerSubagentsEnabled !== undefined
        ? { providerSubagentsEnabled: decoded.providerSubagentsEnabled }
        : {}),
    },
    additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots ?? [],
  };
}

function constructionSignature(
  cwd: string,
  sessionOptions: CodexSessionOptions,
): string {
  const permissionSettings = toCodexThreadPermissionSettings(sessionOptions);
  const poolBaseUrl = sessionOptions.envVars?.[CODEX_POOL_BASE_URL_ENV];
  const poolToken = sessionOptions.envVars?.[CODEX_POOL_AUTH_TOKEN_ENV];
  return JSON.stringify({
    cwd,
    reasoningLevel: sessionOptions.reasoningLevel ?? null,
    memoryEnabled: sessionOptions.memoryEnabled ?? null,
    providerSubagentsEnabled: sessionOptions.providerSubagentsEnabled ?? null,
    approvalPolicy: permissionSettings.approvalPolicy,
    approvalsReviewer: permissionSettings.approvalsReviewer,
    sandbox: permissionSettings.sandbox,
    poolRoute:
      poolBaseUrl === undefined || poolToken === undefined
        ? null
        : {
            baseUrl: poolBaseUrl,
            tokenHash: createHash("sha256").update(poolToken).digest("hex"),
          },
  });
}

function sendThreadDeltas(
  session: CodexBridgeSession,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  const outDeltas: ThreadDelta[] = [];
  for (const delta of deltas) {
    if (delta.kind === "turn.open") {
      session.awaitingReplayedUsage = false;
      if (delta.providerTurnId !== undefined) {
        session.openCodexTurnIds.add(delta.providerTurnId);
      }
    }
    if (delta.kind === "turn.boundary" && delta.providerTurnId !== undefined) {
      session.openCodexTurnIds.delete(delta.providerTurnId);
      const waiters = session.turnSettledWaiters.get(delta.providerTurnId);
      if (waiters !== undefined) {
        session.turnSettledWaiters.delete(delta.providerTurnId);
        for (const resolve of waiters) {
          resolve();
        }
      }
    }
    if (session.awaitingReplayedUsage) {
      if (delta.kind === "usage") {
        continue;
      }
      if (delta.kind === "contextWindow") {
        const { providerTurnId: _replayedTurnId, ...threadScoped } = delta;
        outDeltas.push(threadScoped);
        continue;
      }
    }
    outDeltas.push(delta);
  }
  if (!session.identityAnnounced) {
    session.pendingPreIdentityDeltas.push(...outDeltas);
    return;
  }
  sendNotification(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId: session.bbThreadId,
    deltas: outDeltas,
  });
}

function announceSessionIdentity(
  session: CodexBridgeSession,
  codexThreadId: string,
): void {
  if (session.codexThreadId === null) {
    session.codexThreadId = codexThreadId;
  }
  if (session.identityAnnounced) {
    return;
  }
  session.identityAnnounced = true;
  sendNotification(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId: session.bbThreadId,
    providerThreadId: codexThreadId,
    sessionRestorable: true,
  });
  const buffered = session.pendingPreIdentityDeltas;
  session.pendingPreIdentityDeltas = [];
  sendThreadDeltas(session, buffered);
}

const codexThreadStartedNotificationSchema = z
  .object({ thread: z.object({ id: z.string().min(1) }).passthrough() })
  .passthrough();

function toProviderRuntimeEvent(
  method: string,
  params: unknown,
): ProviderRuntimeEvent {
  return {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {}),
  } as ProviderRuntimeEvent;
}

function handleChildNotification(
  bbThreadId: string,
  serial: number,
  method: string,
  params: unknown,
): void {
  const session = currentSession(bbThreadId, serial);
  if (!session) {
    return;
  }
  if (method === "thread/started") {
    const parsed = codexThreadStartedNotificationSchema.safeParse(params);
    if (parsed.success) {
      announceSessionIdentity(session, parsed.data.thread.id);
    }
  }
  const deltas = session.translator.translateEvent(
    toProviderRuntimeEvent(method, params),
  );
  sendThreadDeltas(session, deltas);
  for (const delta of deltas) {
    if (delta.kind === "provider.error" && delta.willRetry !== true) {
      emitTerminalAccountErrorHint(session, delta);
    }
  }
}

function emitTerminalAccountErrorHint(
  session: CodexBridgeSession,
  delta: Extract<ThreadDelta, { kind: "provider.error" }>,
): void {
  const kind = classifyTerminalAccountError(delta);
  if (kind === null) {
    return;
  }
  const message = delta.detail ?? delta.message;
  session.rebuildBeforeNextTurnReason =
    kind === "authRequired"
      ? "codex session restarted after an authentication failure so a new login can take effect."
      : "codex session restarted after a rate limit so a refreshed account state can take effect.";
  sendNotification(BRIDGE_NOTIFICATION_METHODS.providerRecovery, {
    threadId: session.bbThreadId,
    kind,
    message,
    retryable: false,
  });
}

const codexChildToolCallParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.union([z.string().min(1), z.null()]),
  callId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.unknown(),
});

function handleChildRequest(
  bbThreadId: string,
  serial: number,
  method: string,
  params: unknown,
  responder: CodexAppServerRequestResponder,
): void {
  const session = currentSession(bbThreadId, serial);
  if (!session) {
    responder.error(
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      "codex session is no longer current",
    );
    return;
  }

  if (method === BRIDGE_INBOUND_REQUEST_METHODS.toolCall) {
    const parsed = codexChildToolCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      responder.error(
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Invalid codex tool call params: ${parsed.error.message}`,
      );
      return;
    }
    void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.toolCall, {
      providerThreadId: session.codexThreadId ?? parsed.data.threadId,
      threadId: session.bbThreadId,
      turnId: parsed.data.turnId,
      callId: parsed.data.callId,
      tool: parsed.data.tool,
      arguments: parsed.data.arguments ?? {},
      providerNativeIds: true,
    })
      .then((result) => {
        responder.result(result);
      })
      .catch((error: unknown) => {
        responder.error(
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      });
    return;
  }

  const macOsPermission = extractCodexMacOsPermissionRequest({
    id: 0,
    method,
    params,
  });
  if (macOsPermission !== null) {
    sendThreadDeltas(session, [buildMacOsPermissionItemDelta(macOsPermission)]);
  }

  let decoded: DecodedInteractiveRequest | null;
  try {
    decoded = decodeCodexInteractiveRequest({ id: 0, method, params });
  } catch (error) {
    responder.error(
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  if (decoded === null) {
    responder.error(
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unhandled codex request "${method}"`,
    );
    return;
  }
  const request = decoded;

  void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
    providerThreadId: session.codexThreadId ?? request.providerThreadId,
    threadId: session.bbThreadId,
    turnId: request.turnId,
    payload: request.payload,
    providerNativeIds: true,
  })
    .then((result) => {
      const outcome = approvalInteractionOutcomeSchema.parse({
        payload: request.payload,
        resolution: result,
      });
      responder.result(buildCodexInteractiveResponse(outcome));
    })
    .catch((error: unknown) => {
      responder.error(
        BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        error instanceof Error ? error.message : String(error),
      );
    });
}

function buildMacOsPermissionItemDelta(
  request: CodexMacOsPermissionRequest,
): ThreadDelta {
  return {
    kind: "item.close",
    key: {
      providerItemId: `${request.item.approvalItemId}:macos-permission`,
    },
    status: "completed",
    item: {
      type: "extension",
      kind: CODEX_MACOS_PERMISSION_EXTENSION_KIND,
      payload: request.item,
    },
    presentation: macOsPermissionPresentation(
      summarizeCodexMacOsPermissions(request.item.permissions),
    ),
    providerTurnId: request.turnId,
  };
}

function handleChildExit(
  bbThreadId: string,
  serial: number,
  info: CodexAppServerExitInfo,
): void {
  const session = currentSession(bbThreadId, serial);
  if (!session) {
    return;
  }
  session.connection = null;

  const openTurnIds = [...session.openCodexTurnIds];
  const message = `codex app-server exited unexpectedly (code ${info.code ?? "null"}, signal ${info.signal ?? "null"})${info.stderrTail ? `: ${info.stderrTail}` : ""}`;
  sendThreadDeltas(
    session,
    openTurnIds.map((codexTurnId) => ({
      kind: "turn.boundary",
      providerTurnId: codexTurnId,
      status: "failed",
      error: { message },
    })),
  );
  session.openCodexTurnIds.clear();
  sendNotification(BRIDGE_NOTIFICATION_METHODS.error, {
    threadId: session.bbThreadId,
    ...(session.codexThreadId !== null
      ? { providerThreadId: session.codexThreadId }
      : {}),
    message,
  });
  if (session.codexThreadId !== null) {
    sendThreadDeltas(
      session,
      session.translator.clearExitedChildThreadState({
        providerThreadId: session.codexThreadId,
      }),
    );
  }
}

function spawnChildConnection(callbacks: {
  envVars?: Readonly<Record<string, string>>;
  recordThreadId: string | null;
  onNotification: (method: string, params: unknown) => void;
  onRequest: (
    method: string,
    params: unknown,
    responder: CodexAppServerRequestResponder,
  ) => void;
  onExit: (info: CodexAppServerExitInfo) => void;
}): CodexAppServerConnection {
  const env = buildAppServerEnv(callbacks.envVars);
  const launch = resolveAppServerLaunch(appServerLaunchEnv(callbacks.envVars));
  const { envVars: _envVars, ...connectionCallbacks } = callbacks;
  return createCodexAppServerConnection({
    command: launch.command,
    args: launch.args,
    cwd: process.cwd(),
    env,
    ...connectionCallbacks,
  });
}

const ignoredChildResultSchema = z.unknown();

async function initializeChild(
  connection: CodexAppServerConnection,
  postInitializeRequests?: readonly ProviderPostInitializeRequest[],
): Promise<void> {
  await connection.request({
    method: "initialize",
    params: CODEX_INITIALIZE_PARAMS,
    resultSchema: ignoredChildResultSchema,
    timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
  });
  for (const request of postInitializeRequests ?? []) {
    try {
      const result = await connection.request({
        method: request.plan.method,
        ...("params" in request.plan && request.plan.params !== undefined
          ? { params: request.plan.params }
          : {}),
        resultSchema: ignoredChildResultSchema,
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      });
      request.onResult(result);
    } catch (error) {
      if (request.required) {
        throw error;
      }
    }
  }
  if (configuredSkillExtraRoots !== null) {
    await connection.request({
      method: "skills/extraRoots/set",
      params: { extraRoots: configuredSkillExtraRoots },
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
  }
}

const codexThreadIdentityResultSchema = z
  .object({ thread: z.object({ id: z.string().min(1) }).passthrough() })
  .passthrough();

type CodexSessionConstructionRequest =
  | { kind: "start" }
  | { kind: "resume"; providerThreadId: string }
  | {
      kind: "fork";
      sourceProviderThreadId: string;
      sourceProviderCheckpointId?: string;
    };

interface ConstructThreadSessionArgs {
  threadId: string;
  cwd: string;
  options: BridgeExecutionOptions;
  instructionMode: "append" | "replace";
  dynamicTools?: DynamicTool[];
  request: CodexSessionConstructionRequest;
}

interface ConstructedCodexSession {
  session: CodexBridgeSession;
  codexThreadId: string;
}

async function constructThreadSession(
  args: ConstructThreadSessionArgs,
): Promise<ConstructedCodexSession> {
  const existing = sessionsByBbThreadId.get(args.threadId);
  const decoded = decodeCodexOptions(args.options);
  sessionSerialCounter += 1;
  const serial = sessionSerialCounter;
  const translator = createCodexEventTranslator({
    additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots,
  });
  translator.configureInjectedTools(
    (args.dynamicTools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.presentation === undefined
        ? {}
        : { presentation: tool.presentation }),
    })),
  );
  const session: CodexBridgeSession = {
    bbThreadId: args.threadId,
    codexThreadId:
      args.request.kind === "resume" ? args.request.providerThreadId : null,
    serial,
    connection: null,
    translator,
    construction: {
      cwd: args.cwd,
      instructionMode: args.instructionMode,
      dynamicTools: args.dynamicTools,
    },
    constructionSignature: constructionSignature(
      args.cwd,
      decoded.sessionOptions,
    ),
    openCodexTurnIds: new Set(),
    turnSettledWaiters: new Map(),
    awaitingReplayedUsage: args.request.kind !== "start",
    identityAnnounced: false,
    pendingPreIdentityDeltas: [],
    rebuildBeforeNextTurnReason: null,
    closing: false,
    previousChildExit: null,
    releasePromise: null,
  };
  sessionsByBbThreadId.set(args.threadId, session);
  if (existing) {
    const previousChildExit = releaseSession(existing);
    session.previousChildExit = previousChildExit;
    await previousChildExit;
    if (session.previousChildExit === previousChildExit) {
      session.previousChildExit = null;
    }
    if (session.closing) {
      throw new CodexSessionReleasedError(
        new Error(
          "codex session was released while waiting for the previous app-server to exit",
        ),
      );
    }
  }
  if (args.request.kind === "resume") {
    announceSessionIdentity(session, args.request.providerThreadId);
  }
  sendThreadDeltas(session, [{ kind: "session.reset" }]);

  const connection = spawnChildConnection({
    envVars: decoded.sessionOptions.envVars,
    recordThreadId: args.threadId,
    onNotification: (method, params) =>
      handleChildNotification(args.threadId, serial, method, params),
    onRequest: (method, params, responder) =>
      handleChildRequest(args.threadId, serial, method, params, responder),
    onExit: (info) => handleChildExit(args.threadId, serial, info),
  });
  session.connection = connection;

  try {
    await initializeChild(connection, translator.buildPostInitializeRequests());

    const preparedGitRoots = translator.prepareWorkspaceWriteGitRoots({
      command: {
        threadId: args.threadId,
        cwd: args.cwd,
        options: decoded.sessionOptions,
      },
    });
    const dynamicTools = toCodexDynamicTools(args.dynamicTools);
    const instructionOverrides = resolveCodexInstructionOverrides({
      instructionMode: args.instructionMode,
      options: decoded.sessionOptions,
    });
    const sharedConstructionParams = {
      approvalPolicy: preparedGitRoots.permissionSettings.approvalPolicy,
      approvalsReviewer: preparedGitRoots.permissionSettings.approvalsReviewer,
      sandbox: preparedGitRoots.permissionSettings.sandbox,
      cwd: args.cwd,
      ...instructionOverrides,
      model: decoded.sessionOptions.model ?? undefined,
      serviceTier: toCodexServiceTier(decoded.sessionOptions.serviceTier),
      config: preparedGitRoots.config ?? undefined,
      ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
    };

    let method: string;
    let params: BbThreadStartParams | BbThreadResumeParams | BbThreadForkParams;
    switch (args.request.kind) {
      case "start": {
        method = "thread/start";
        const startParams: BbThreadStartParams = {
          ...sharedConstructionParams,
          ephemeral: false,
          experimentalRawEvents: true,
        };
        params = startParams;
        break;
      }
      case "resume": {
        method = "thread/resume";
        const resumeParams: BbThreadResumeParams = {
          threadId: args.request.providerThreadId,
          excludeTurns: true,
          ...sharedConstructionParams,
        };
        params = resumeParams;
        break;
      }
      case "fork": {
        method = "thread/fork";
        const forkParams: BbThreadForkParams = {
          threadId: args.request.sourceProviderThreadId,
          ...(args.request.sourceProviderCheckpointId !== undefined
            ? {
                lastTurnId: stripLegacyBridgeIdPrefix(
                  args.request.sourceProviderCheckpointId,
                ),
              }
            : {}),
          ...sharedConstructionParams,
        };
        params = forkParams;
        break;
      }
    }

    const result = await connection.request({
      method,
      params,
      resultSchema: codexThreadIdentityResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
    const codexThreadId = result.thread.id;
    session.codexThreadId = codexThreadId;
    translator.activateThreadGitWritableRoots({
      providerThreadId: codexThreadId,
      threadId: args.threadId,
    });
    announceSessionIdentity(session, codexThreadId);
    return { session, codexThreadId };
  } catch (error) {
    const released = session.closing;
    if (sessionsByBbThreadId.get(args.threadId) === session) {
      sessionsByBbThreadId.delete(args.threadId);
    }
    session.closing = true;
    await connection.kill();
    throw released ? new CodexSessionReleasedError(error) : error;
  }
}

class CodexSessionReleasedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CodexSessionReleasedError";
  }
}

function registerResumableSession(session: CodexBridgeSession): void {
  if (
    session.codexThreadId === null ||
    sessionsByBbThreadId.has(session.bbThreadId)
  ) {
    return;
  }
  sessionSerialCounter += 1;
  sessionsByBbThreadId.set(session.bbThreadId, {
    bbThreadId: session.bbThreadId,
    codexThreadId: session.codexThreadId,
    serial: sessionSerialCounter,
    connection: null,
    translator: session.translator,
    construction: session.construction,
    constructionSignature: session.constructionSignature,
    openCodexTurnIds: new Set(),
    turnSettledWaiters: new Map(),
    awaitingReplayedUsage: true,
    identityAnnounced: session.identityAnnounced,
    pendingPreIdentityDeltas: [],
    rebuildBeforeNextTurnReason: null,
    closing: false,
    previousChildExit: null,
    releasePromise: null,
  });
}

async function rebuildThreadSession(
  session: CodexBridgeSession,
  options: BridgeExecutionOptions,
  reason: string,
): Promise<CodexBridgeSession> {
  const codexThreadId = session.codexThreadId;
  if (codexThreadId === null) {
    throw new Error(
      "codex session has no provider thread id to restore from its rollout",
    );
  }
  let replacement: ConstructedCodexSession;
  try {
    replacement = await constructThreadSession({
      threadId: session.bbThreadId,
      cwd: session.construction.cwd,
      options,
      instructionMode: session.construction.instructionMode,
      ...(session.construction.dynamicTools !== undefined
        ? { dynamicTools: session.construction.dynamicTools }
        : {}),
      request: { kind: "resume", providerThreadId: codexThreadId },
    });
  } catch (error) {
    if (!(error instanceof CodexSessionReleasedError)) {
      registerResumableSession(session);
    }
    throw error;
  }
  sendNotification(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
    threadId: replacement.session.bbThreadId,
    providerThreadId: replacement.codexThreadId,
    reason,
    contextLost: false,
  });
  return replacement.session;
}

async function withMaintenanceChild<T>(
  fn: (connection: CodexAppServerConnection) => Promise<T>,
): Promise<T> {
  const connection = spawnChildConnection({
    recordThreadId: null,
    onNotification: () => {},
    onRequest: (_method, _params, responder) => {
      responder.error(
        BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        "maintenance codex app-server does not serve requests",
      );
    },
    onExit: () => {},
  });
  maintenanceConnections.add(connection);
  try {
    await initializeChild(connection);
    return await fn(connection);
  } finally {
    maintenanceConnections.delete(connection);
    await connection.kill();
  }
}

async function getModelListConnection(): Promise<CodexAppServerConnection> {
  if (modelListConnection !== null && !modelListConnection.exited) {
    return modelListConnection;
  }
  if (modelListConnectionPromise !== null) {
    return modelListConnectionPromise;
  }

  const connectionPromise = (async () => {
    const connection = spawnChildConnection({
      recordThreadId: null,
      onNotification: () => {},
      onRequest: (_method, _params, responder) => {
        responder.error(
          BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          "model-list codex app-server does not serve requests",
        );
      },
      onExit: () => {
        maintenanceConnections.delete(connection);
        if (modelListConnection === connection) {
          modelListConnection = null;
        }
      },
    });
    maintenanceConnections.add(connection);
    try {
      await initializeChild(connection);
      modelListConnection = connection;
      return connection;
    } catch (error) {
      maintenanceConnections.delete(connection);
      await connection.kill();
      throw error;
    }
  })();
  modelListConnectionPromise = connectionPromise;
  try {
    return await connectionPromise;
  } finally {
    if (modelListConnectionPromise === connectionPromise) {
      modelListConnectionPromise = null;
    }
  }
}

function retireModelListConnection(connection: CodexAppServerConnection): void {
  maintenanceConnections.delete(connection);
  if (modelListConnection === connection) {
    modelListConnection = null;
  }
  connection.kill();
}

async function withChildForThread<T>(
  bbThreadId: string,
  fn: (connection: CodexAppServerConnection) => Promise<T>,
): Promise<T> {
  const session = sessionsByBbThreadId.get(bbThreadId);
  if (
    session &&
    !session.closing &&
    session.connection !== null &&
    !session.connection.exited
  ) {
    return fn(session.connection);
  }
  return withMaintenanceChild(fn);
}

type ThreadStartParamsShape = z.infer<typeof threadStartParamsSchema>;
type TurnStartParamsShape = z.infer<typeof turnStartParamsSchema>;
type TurnSteerParamsShape = z.infer<typeof turnSteerParamsSchema>;
type ThreadStopParamsShape = z.infer<typeof threadStopParamsSchema>;

function handleInitialize(id: string | number): void {
  const result: InitializeResult = {
    protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
    capabilities: {
      sessionRestore: true,
      threadArchive: true,
      threadRename: true,
      threadGoalClear: true,
      fork: "checkpoint",
      approvalEnforcedBy: "runtime",
      grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      steerMode: "inject",
      skills: { configure: true },
    },
  };
  sendResult(id, result);
}

async function handleModelList(id: string | number): Promise<void> {
  let connection: CodexAppServerConnection | null = null;
  try {
    connection = await getModelListConnection();
    const result = await connection.request({
      method: "model/list",
      params: {},
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
    sendResult(id, {
      models: parseModelsResponse(result),
      selectedOnlyModels: [],
    });
  } catch (error) {
    if (connection !== null) {
      retireModelListConnection(connection);
    }
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      describeCodexLaunchError(error),
    );
  }
}

function sendConstructionError(
  id: string | number,
  error: unknown,
  resumable: boolean,
): void {
  const message = describeCodexLaunchError(error);
  const recovery = archivedSessionHint(message);
  sendError(
    id,
    resumable && recovery !== null
      ? BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE
      : BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    message,
    recovery === null ? undefined : { recovery },
  );
}

async function handleThreadConstruction(
  id: string | number,
  params: ThreadStartParamsShape,
  request: CodexSessionConstructionRequest,
): Promise<void> {
  try {
    const constructed = await constructThreadSession({
      threadId: params.threadId,
      cwd: params.cwd,
      options: params.options,
      instructionMode: params.instructionMode,
      ...(params.dynamicTools !== undefined
        ? { dynamicTools: params.dynamicTools }
        : {}),
      request,
    });
    sendResult(id, {
      providerThreadId: constructed.codexThreadId,
      sessionRestorable: true,
    });
  } catch (error) {
    sendConstructionError(id, error, request.kind === "resume");
  }
}

interface LiveSessionForTurn {
  session: CodexBridgeSession;
  connection: CodexAppServerConnection;
}

async function requireLiveSessionForTurn(
  params: TurnStartParamsShape,
): Promise<LiveSessionForTurn> {
  let session = sessionsByBbThreadId.get(params.threadId);
  if (!session || session.closing) {
    throw new Error(`No active codex session for thread "${params.threadId}"`);
  }

  const decoded = decodeCodexOptions(params.options);
  const signature = constructionSignature(
    session.construction.cwd,
    decoded.sessionOptions,
  );
  if (session.connection === null || session.connection.exited) {
    session = await rebuildThreadSession(
      session,
      params.options,
      "codex app-server exited; the session was restored from its rollout.",
    );
  } else if (session.rebuildBeforeNextTurnReason !== null) {
    session = await rebuildThreadSession(
      session,
      params.options,
      session.rebuildBeforeNextTurnReason,
    );
  } else if (signature !== session.constructionSignature) {
    session = await rebuildThreadSession(
      session,
      params.options,
      "Execution settings changed; the codex session was rebuilt to apply them.",
    );
  }
  if (session.connection === null) {
    throw new Error(`No active codex session for thread "${params.threadId}"`);
  }
  return { session, connection: session.connection };
}

const ZERO_WORK_SETTLEMENT_GRACE_MS = 250;

let syntheticZeroWorkTurnCounter = 0;

function scheduleZeroWorkTurnSettlement(args: {
  clientRequestId: TurnStartParamsShape["clientRequestId"];
  prepared: PreparedProviderCommandDispatch | null;
  session: CodexBridgeSession;
}): void {
  const { clientRequestId, prepared, session } = args;
  if (prepared === null) {
    return;
  }
  const serial = session.serial;
  const timer = setTimeout(() => {
    const live = currentSession(session.bbThreadId, serial);
    if (!live || live.openCodexTurnIds.size > 0) {
      return;
    }
    if (!prepared.claim()) {
      return;
    }
    syntheticZeroWorkTurnCounter += 1;
    const providerTurnId = `zero-work-${syntheticZeroWorkTurnCounter}`;
    sendThreadDeltas(live, [
      { kind: "turn.open", providerTurnId },
      { kind: "input.accepted", clientRequestId, providerTurnId },
      { kind: "turn.boundary", providerTurnId, status: "completed" },
    ]);
  }, ZERO_WORK_SETTLEMENT_GRACE_MS);
  timer.unref?.();
}

async function handleTurnStart(
  id: string | number,
  params: TurnStartParamsShape,
): Promise<void> {
  let live: LiveSessionForTurn;
  try {
    live = await requireLiveSessionForTurn(params);
  } catch (error) {
    rejectWithCodexError(id, error);
    return;
  }
  const { session, connection } = live;
  const codexThreadId = session.codexThreadId;
  if (codexThreadId === null) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      `No provider thread identity for thread "${params.threadId}"`,
    );
    return;
  }

  const input: PromptInput[] = params.input;
  const decoded = decodeCodexOptions(params.options);

  const prepared = session.translator.prepareTurnStart({
    clientRequestId: params.clientRequestId,
    providerThreadId: codexThreadId,
  });

  try {
    if (isStandaloneBuiltinCompactCommand(input)) {
      await connection.request({
        method: "thread/compact/start",
        params: { threadId: codexThreadId },
        resultSchema: ignoredChildResultSchema,
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      });
    } else {
      const permissionSettings = toCodexPermissionSettings({
        additionalWorkspaceWriteRoots: decoded.additionalWorkspaceWriteRoots,
        gitWritableRoots: session.translator.getThreadGitWritableRoots(
          params.threadId,
        ),
        options: decoded.sessionOptions,
      });
      await connection.request({
        method: "turn/start",
        params: {
          threadId: codexThreadId,
          input: toCodexUserInput(input),
          approvalPolicy: permissionSettings.approvalPolicy,
          approvalsReviewer: permissionSettings.approvalsReviewer,
          sandboxPolicy: permissionSettings.sandboxPolicy,
          model: decoded.sessionOptions.model ?? undefined,
          serviceTier: toCodexServiceTier(decoded.sessionOptions.serviceTier),
        },
        resultSchema: ignoredChildResultSchema,
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      });
    }
    sendResult(id, { threadId: params.threadId });
    scheduleZeroWorkTurnSettlement({
      clientRequestId: params.clientRequestId,
      prepared,
      session,
    });
  } catch (error) {
    prepared?.rollback();
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleTurnSteer(
  id: string | number,
  params: TurnSteerParamsShape,
): Promise<void> {
  const session = sessionsByBbThreadId.get(params.threadId);
  if (
    !session ||
    session.closing ||
    session.connection === null ||
    session.connection.exited ||
    session.codexThreadId === null
  ) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      `No active codex session for thread "${params.threadId}"`,
    );
    return;
  }
  try {
    await session.connection.request({
      method: "turn/steer",
      params: {
        threadId: session.codexThreadId,
        expectedTurnId: params.expectedTurnId,
        input: toCodexUserInput(params.input),
      },
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
    sendThreadDeltas(session, [
      {
        kind: "input.accepted",
        clientRequestId: params.clientRequestId,
        providerTurnId: params.expectedTurnId,
      },
    ]);
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    rejectWithCodexError(id, error);
  }
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParamsShape,
): Promise<void> {
  const session = sessionsByBbThreadId.get(params.threadId);

  if (params.intent === "release") {
    if (session) {
      await releaseSession(session);
    }
    sendResult(id, { ok: true });
    return;
  }

  if (
    !session ||
    session.closing ||
    session.connection === null ||
    session.connection.exited ||
    session.codexThreadId === null ||
    params.activeTurnId === null
  ) {
    sendResult(id, { ok: true });
    return;
  }

  try {
    await session.connection.request({
      method: "turn/interrupt",
      params: {
        threadId: session.codexThreadId,
        turnId: params.activeTurnId,
      },
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const settled = await waitForCodexTurnSettlement(
    session,
    params.activeTurnId,
    INTERRUPT_SETTLEMENT_TIMEOUT_MS,
  );
  if (!settled) {
    sendThreadDeltas(session, [
      {
        kind: "turn.boundary",
        providerTurnId: params.activeTurnId,
        status: "interrupted",
      },
    ]);
  }
  sendThreadDeltas(
    session,
    session.translator.clearExitedChildThreadState({
      providerThreadId: session.codexThreadId,
    }),
  );
  await releaseSession(session);
  sendResult(id, { ok: true });
}

function waitForCodexTurnSettlement(
  session: CodexBridgeSession,
  codexTurnId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (!session.openCodexTurnIds.has(codexTurnId)) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const waiters = session.turnSettledWaiters.get(codexTurnId);
      if (waiters !== undefined) {
        session.turnSettledWaiters.set(
          codexTurnId,
          waiters.filter((waiter) => waiter !== onSettled),
        );
      }
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onSettled = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const waiters = session.turnSettledWaiters.get(codexTurnId) ?? [];
    waiters.push(onSettled);
    session.turnSettledWaiters.set(codexTurnId, waiters);
  });
}

interface ThreadRefParamsShape {
  threadId: string;
  providerThreadId: string;
}

async function handleThreadMaintenance(
  id: string | number,
  params: ThreadRefParamsShape,
  request: { method: string; params: Record<string, unknown> },
  options?: {
    releaseAfter?: boolean;
    alreadyInRequestedState?: RegExp;
  },
): Promise<void> {
  const settle = async (): Promise<void> => {
    if (options?.releaseAfter) {
      const session = sessionsByBbThreadId.get(params.threadId);
      if (session) {
        await releaseSession(session);
      }
    }
    sendResult(id, { ok: true });
  };
  try {
    await withChildForThread(params.threadId, (connection) =>
      sendMaintenanceRequestWithRetries(connection, request),
    );
    await settle();
  } catch (error) {
    if (
      error instanceof Error &&
      options?.alreadyInRequestedState?.test(error.message) === true
    ) {
      await settle();
      return;
    }
    rejectWithCodexError(id, error);
  }
}

function rejectWithCodexError(id: string | number, error: unknown): void {
  const message = describeCodexLaunchError(error);
  const recovery = archivedSessionHint(message);
  if (recovery !== null) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, message, { recovery });
    return;
  }
  sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, message);
}

async function sendMaintenanceRequestWithRetries(
  connection: CodexAppServerConnection,
  request: { method: string; params: Record<string, unknown> },
): Promise<void> {
  const sendOnce = (): Promise<unknown> =>
    connection.request({
      method: request.method,
      params: request.params,
      resultSchema: ignoredChildResultSchema,
      timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
    });
  if (request.method !== "thread/name/set") {
    await sendOnce();
    return;
  }
  for (const retryDelayMs of CODEX_RENAME_RETRY_DELAYS_MS) {
    try {
      await sendOnce();
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !CODEX_EMPTY_ROLLOUT_RENAME_ERROR_PATTERN.test(error.message)
      ) {
        throw error;
      }
      process.stderr.write(
        `codex rollout is not ready; retrying rename in ${retryDelayMs}ms.\n`,
      );
      await delay(retryDelayMs);
    }
  }
  await sendOnce();
}

async function handleSkillsConfigure(
  id: string | number,
  params: z.infer<typeof skillsConfigureParamsSchema>,
): Promise<void> {
  configuredSkillExtraRoots = params.roots.map((root) => root.path);
  try {
    for (const session of sessionsByBbThreadId.values()) {
      if (
        session.closing ||
        session.connection === null ||
        session.connection.exited
      ) {
        continue;
      }
      await session.connection.request({
        method: "skills/extraRoots/set",
        params: { extraRoots: configuredSkillExtraRoots },
        resultSchema: ignoredChildResultSchema,
        timeoutMs: CHILD_REQUEST_TIMEOUT_MS,
      });
    }
    sendResult(id, { ok: true });
  } catch (error) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleRequest(
  request: CodexBridgeCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize":
      handleInitialize(request.id);
      break;
    case "model/list":
      await handleModelList(request.id);
      break;
    case "provider/health":
      sendResult(request.id, await getCodexProviderHealth());
      break;
    case "provider/usage":
      sendResult(request.id, await getCodexProviderUsage());
      break;
    case "provider/installation/status":
      sendResult(
        request.id,
        await getCodexProviderInstallationStatus(request.params.requirement),
      );
      break;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getCodexProviderInstallationRun(request.params.action),
      );
      break;
    case "thread/start":
      await handleThreadConstruction(request.id, request.params, {
        kind: "start",
      });
      break;
    case "thread/resume":
      await handleThreadConstruction(request.id, request.params, {
        kind: "resume",
        providerThreadId: request.params.providerThreadId,
      });
      break;
    case "thread/fork":
      await handleThreadConstruction(request.id, request.params, {
        kind: "fork",
        sourceProviderThreadId: request.params.sourceProviderThreadId,
        ...(request.params.sourceProviderCheckpointId !== undefined
          ? {
              sourceProviderCheckpointId:
                request.params.sourceProviderCheckpointId,
            }
          : {}),
      });
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
      await handleThreadMaintenance(
        request.id,
        request.params,
        {
          method: "thread/archive",
          params: { threadId: request.params.providerThreadId },
        },
        { releaseAfter: true },
      );
      break;
    case "thread/name/set":
      await handleThreadMaintenance(request.id, request.params, {
        method: "thread/name/set",
        params: {
          threadId: request.params.providerThreadId,
          name: request.params.title,
        },
      });
      break;
    case "thread/archive":
      await handleThreadMaintenance(
        request.id,
        request.params,
        {
          method: "thread/archive",
          params: { threadId: request.params.providerThreadId },
        },
        {
          releaseAfter: true,
          alreadyInRequestedState: CODEX_ALREADY_ARCHIVED_ERROR_PATTERN,
        },
      );
      break;
    case "thread/unarchive":
      await handleThreadMaintenance(
        request.id,
        request.params,
        {
          method: "thread/unarchive",
          params: { threadId: request.params.providerThreadId },
        },
        { alreadyInRequestedState: CODEX_NOT_ARCHIVED_ERROR_PATTERN },
      );
      break;
    case "thread/goal/clear":
      await handleThreadMaintenance(request.id, request.params, {
        method: "thread/goal/clear",
        params: { threadId: request.params.providerThreadId },
      });
      break;
    case "skills/configure":
      await handleSkillsConfigure(request.id, request.params);
      break;
  }
}

function handleParsedMessage(parsed: unknown): void {
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response && typeof response.id === "number") {
    const pending = pendingRuntimeRequests.get(response.id);
    if (pending) {
      pendingRuntimeRequests.delete(response.id);
      pending(response);
      return;
    }
  }

  const decoded = decodeCodexBridgeJsonRpcRequest(parsed);
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

function killAllChildren(): void {
  for (const session of sessionsByBbThreadId.values()) {
    session.closing = true;
    session.connection?.kill();
    session.connection = null;
  }
  sessionsByBbThreadId.clear();
  modelListConnection = null;
  modelListConnectionPromise = null;
  for (const connection of maintenanceConnections) {
    connection.kill();
  }
  maintenanceConnections.clear();
}

/** @internal Test cleanup for bridge tests that create a persistent child. */
export const experimental_killAllChildrenForTests = killAllChildren;

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  onClose: () => {
    killAllChildren();
    process.exit(0);
  },
  onSigterm: () => {
    killAllChildren();
    process.exit(0);
  },
  onSigint: () => {
    killAllChildren();
    process.exit(0);
  },
});
