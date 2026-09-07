import {
  isStandaloneBuiltinCompactCommand,
  pendingInteractionResolutionSchema,
  reasoningEffortsForLevels,
} from "@bb/domain";
import type { AvailableModel, PromptInput, ReasoningLevel } from "@bb/domain";
import { acpLaunchSpecSchema, type AcpLaunchSpec } from "../launch-spec.js";
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
} from "@bb/provider-bridge-protocol";
import type {
  InitializeResult,
  ThreadDelta,
} from "@bb/provider-bridge-protocol";
import {
  BridgeRecoveryError,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  experimental_defineProviderBridge,
  mimeTypeFromExtension,
  runBridgeRequest,
  withoutBridgeRuntimeEnv,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { BridgeJsonRpcResponse } from "@bb/provider-bridge-protocol/bridge-kit";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

type DecodedToolCallResponse = ReturnType<typeof decodeToolCallResponsePayload>;
type BridgeToolCallContent = DecodedToolCallResponse["contentBlocks"][number];
type BridgeToolCallImage = DecodedToolCallResponse["images"][number];
import {
  ACP_BRIDGE_NO_ACTIVE_TURN_ERROR_CODE,
  ACP_COMPACTION_COMPLETED_METHOD,
  ACP_COMPACTION_STARTED_METHOD,
  ACP_DEFAULT_MODEL_ID,
  ACP_FS_WRITE_METHOD,
  ACP_TURN_COMPLETED_METHOD,
  ACP_TURN_STARTED_METHOD,
  ACP_UPDATE_METHOD,
  ACP_WARNING_METHOD,
  acpBridgeCommandSchema,
  type AcpBridgeCommand,
  type AcpBridgeNativeReasoning,
  type AcpBridgePermissionCli,
  type AcpBridgeReasoningCli,
  acpBridgeCommandMethodValues,
} from "../bridge-protocol.js";
import {
  createAcpDeltaTranslator,
  type AcpDeltaTranslator,
} from "../delta-translation.js";
import {
  compactionOutcomeForEndTurn,
  resolveAcpDialect,
  type AcpDialect,
} from "../dialect.js";
import type { AcpMaintenanceDialect } from "./provider-maintenance.js";
import {
  buildAcpPermissionInteractionPayload,
  resolveAcpPermissionDecision,
} from "../interactions.js";
import {
  buildAcpModelListParams,
  buildAcpSessionParams,
  type AcpAgentCommandParam,
  type AcpModelListParams,
  type AcpSessionParams,
  type AcpSkillRoot,
} from "../session-params.js";
import { buildCursorParameterizedModelCatalog } from "../cursor-model-selection.js";
import {
  getAcpProviderHealth,
  getAcpProviderInstallationRun,
  getAcpProviderInstallationStatus,
  getAcpProviderUsage,
} from "./provider-maintenance.js";
import {
  ACP_PROTOCOL_VERSION,
  type AcpConfigOption,
  acpConfigStateResultSchema,
  acpInitializeResultSchema,
  acpPromptResultSchema,
  acpReadTextFileParamsSchema,
  acpRequestPermissionParamsSchema,
  acpSessionForkResultSchema,
  acpSessionNewResultSchema,
  acpSessionNotificationParamsSchema,
  acpAgentMessageChunkUpdateSchema,
  extractAcpContentText,
  acpUsageUpdateSchema,
  type AcpConfigStateResult,
  type AcpSessionModels,
  type AcpUsageUpdate,
  acpStopReasonSchema,
  acpWriteTextFileParamsSchema,
  type AcpContentBlock,
  type AcpPermissionOption,
} from "../wire.js";
import {
  AcpAgentResponseError,
  createAcpAgentConnection,
  type AcpAgentConnection,
  type AcpAgentRequestResponder,
} from "./agent-connection.js";
import {
  approveCursorSessionMcpServer,
  revokeCursorSessionMcpServer,
  type CursorMcpApproval,
} from "./cursor-mcp-approval.js";
import {
  ACP_NATIVE_REASONING_EFFORTS,
  buildAgentModelCatalog,
  buildAcpNativeReasoningSupport,
  buildModelCatalogFromConfigOptions,
  buildModelCatalogFromSessionModels,
  acpNativeReasoningLevelToValue,
  findAcpModelConfigOption,
  findAcpThoughtLevelConfigOption,
  parseAgentModelLines,
  splitPrimaryModels,
  type AcpNativeReasoningSupport,
  type AgentModelCatalog,
} from "./model-catalog.js";
import {
  ACP_BRIDGE_MCP_SERVER_NAME,
  buildAcpMcpServerConfig,
  runAcpDynamicToolMcpServer,
  type AcpMcpServerConfig,
} from "./tool-proxy-mcp.js";

interface AcpSessionPolicy {
  permissionMode: "accept-edits" | "full";
  workspaceWriteRoots: string[];
}

interface PendingAcpPermission {
  responder: AcpAgentRequestResponder;
  options: AcpPermissionOption[];
}

interface AcpPendingTurnInput {
  clientRequestId: string;
  input: PromptInput[];
  requestId: AcpBridgeRequestId | null;
}

interface AcpThreadSession {
  bbThreadId: string;
  providerThreadId: string;
  cwd: string;
  dialect: AcpDialect;
  translator: AcpDeltaTranslator;
  connection: AcpAgentConnection;
  supportsImageInput: boolean;
  supportsLoadSession: boolean;
  policy: AcpSessionPolicy;
  pendingInstructions: string | undefined;
  activePromptKind: "turn" | "compaction" | null;
  compactionAgentMessage: string;
  queuedInputs: AcpPendingTurnInput[];
  promptRequestPending: boolean;
  cancelRequested: boolean;
  loading: boolean;
  loadingSessionId: string | undefined;
  pendingLoadUsageUpdate: AcpUsageUpdate | undefined;
  stopping: boolean;
  turnSettled: Promise<void> | undefined;
  pendingPermissions: Set<PendingAcpPermission>;
  cursorMcpApproval: CursorMcpApproval | undefined;
  deferStartEmit: AcpDeferredStartEmitter | undefined;
}

type AcpDeferredStartEmitter = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => void;

const sessionsByBbThreadId = new Map<string, AcpThreadSession>();
const bbThreadIdByProviderThreadId = new Map<string, string>();
const pendingRuntimeRequests = new Map<
  number,
  (response: BridgeJsonRpcResponse) => void
>();
let runtimeRequestIdCounter = 0;
let dynamicToolBridgePromise: Promise<AcpDynamicToolBridge> | null = null;

const THREAD_STOP_CANCEL_TIMEOUT_MS = 4_000;

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

type AcpBridgeRequestId = Parameters<typeof sendResult>[0];

function sendNotification(
  method: string,
  params: Record<string, unknown>,
): void {
  send({ jsonrpc: "2.0", method, params });
}

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
  send({
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  });
  return responsePromise;
}

let configuredSkillRoots: AcpSkillRoot[] | null = null;

function sendThreadDeltas(
  threadId: string,
  deltas: readonly ThreadDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  sendNotification(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId,
    deltas: [...deltas],
  });
}

function emitForSession(
  session: AcpThreadSession,
  method: string,
  params: Record<string, unknown>,
): void {
  sendThreadDeltas(
    session.bbThreadId,
    session.translator.translateAcpEvent(
      { jsonrpc: "2.0", method, params },
      { threadId: session.bbThreadId },
    ),
  );
}

function emitSessionError(session: AcpThreadSession, message: string): void {
  if (session.activePromptKind !== null) {
    emitForSession(session, "error", {
      threadId: session.bbThreadId,
      message,
    });
  }
  sendNotification(BRIDGE_NOTIFICATION_METHODS.error, {
    threadId: session.bbThreadId,
    ...(session.providerThreadId !== ""
      ? { providerThreadId: session.providerThreadId }
      : {}),
    message,
  });
}

function resolveBridgeProcessArgsForMcpServer(): string[] {
  return [...process.execArgv, fileURLToPath(import.meta.url), "--mcp-stdio"];
}

function resolveBridgeProcessEnvForMcpServer(): AcpMcpServerConfig["env"] {
  const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  if (electronRunAsNode === undefined) {
    return [];
  }

  return [{ name: "ELECTRON_RUN_AS_NODE", value: electronRunAsNode }];
}

async function forwardDynamicToolCall(args: {
  arguments: Record<string, unknown>;
  callId: string;
  threadId: string;
  tool: string;
}): Promise<
  | {
      ok: true;
      content: string;
      contentBlocks: BridgeToolCallContent[];
      images: BridgeToolCallImage[];
      isError?: boolean;
    }
  | { ok: false; error: string }
> {
  const session = sessionsByBbThreadId.get(args.threadId);
  if (!session || !session.providerThreadId || session.stopping) {
    return { ok: false, error: "No active ACP session for dynamic tool call." };
  }

  session.translator.noteInjectedToolCall(session.bbThreadId, args.tool);
  try {
    const result = await sendRuntimeRequest("item/tool/call", {
      providerThreadId: session.providerThreadId,
      threadId: session.bbThreadId,
      turnId: null,
      callId: args.callId,
      tool: args.tool,
      arguments: args.arguments,
    });
    return { ok: true, ...decodeToolCallResponsePayload(result) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function handleDynamicToolBridgeSocket(
  bridge: AcpDynamicToolBridge,
  socket: Socket,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }
    const line = buffer.slice(0, newlineIndex);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "Invalid JSON" })}\n`);
      return;
    }
    const request = dynamicToolBridgeRequestSchema.safeParse(parsed);
    if (!request.success || request.data.token !== bridge.token) {
      socket.end(
        `${JSON.stringify({ ok: false, error: "Invalid dynamic tool request" })}\n`,
      );
      return;
    }
    if (request.data.kind === "initialized") {
      process.stderr.write(
        `acp bridge: "${ACP_BRIDGE_MCP_SERVER_NAME}" answered initialize for thread "${request.data.threadId}" (${request.data.toolCount} tools)\n`,
      );
      socket.end(`${JSON.stringify({ ok: true, content: "" })}\n`);
      return;
    }
    void forwardDynamicToolCall(request.data).then((response) => {
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
}

async function ensureDynamicToolBridge(): Promise<AcpDynamicToolBridge> {
  if (dynamicToolBridgePromise) {
    return dynamicToolBridgePromise;
  }

  dynamicToolBridgePromise = new Promise((resolveBridge, rejectBridge) => {
    const host = "127.0.0.1";
    const server = createServer((socket) => {
      socket.on("error", () => {});
      void dynamicToolBridgePromise?.then((bridge) => {
        handleDynamicToolBridgeSocket(bridge, socket);
      });
    });
    server.once("error", rejectBridge);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectBridge(
          new Error("ACP dynamic tool bridge did not bind a TCP port"),
        );
        return;
      }
      resolveBridge({
        host,
        port: address.port,
        server,
        token: randomBytes(32).toString("hex"),
      });
    });
  });

  return dynamicToolBridgePromise;
}

async function buildSessionMcpServers(
  params: AcpSessionParams,
): Promise<AcpMcpServerConfig[]> {
  const dynamicTools = params.dynamicTools ?? [];
  if (dynamicTools.length === 0) {
    return [];
  }
  const bridge = await ensureDynamicToolBridge();
  const config = buildAcpMcpServerConfig({
    bridgeArgs: resolveBridgeProcessArgsForMcpServer(),
    command: process.execPath,
    dynamicTools,
    host: bridge.host,
    port: bridge.port,
    runtimeEnv: resolveBridgeProcessEnvForMcpServer(),
    threadId: params.threadId,
    token: bridge.token,
  });
  process.stderr.write(
    `acp bridge: built "${config.name}" session MCP config for thread "${params.threadId}" (${dynamicTools.length} tools)\n`,
  );
  return [config];
}

const ACP_DEFAULT_MODEL: AvailableModel = {
  id: ACP_DEFAULT_MODEL_ID,
  model: ACP_DEFAULT_MODEL_ID,
  displayName: "Agent default",
  description: "Model selection is managed by the connected ACP agent.",
  supportedReasoningEfforts: ACP_NATIVE_REASONING_EFFORTS,
  defaultReasoningEffort: "medium",
  isDefault: true,
};

const MODEL_LIST_TIMEOUT_MS = 30_000;
const ACP_NATIVE_REASONING_DISCOVERY_TIMEOUT_MS = 5_000;
const AUTH_REQUIRED_MODEL_LIST_ERROR_MESSAGE =
  "ACP agent is not authenticated.";

function reasoningSupportFromCli(
  reasoningCli:
    | Pick<AcpBridgeReasoningCli, "supportedLevels" | "defaultLevel">
    | undefined,
):
  | Pick<AvailableModel, "supportedReasoningEfforts" | "defaultReasoningEffort">
  | undefined {
  if (reasoningCli === undefined) {
    return undefined;
  }
  const supportedLevels = reasoningCli.supportedLevels;
  const defaultReasoningEffort =
    reasoningCli.defaultLevel !== undefined &&
    supportedLevels.includes(reasoningCli.defaultLevel)
      ? reasoningCli.defaultLevel
      : supportedLevels.includes("medium")
        ? "medium"
        : supportedLevels[0];
  return {
    supportedReasoningEfforts: reasoningEffortsForLevels(supportedLevels),
    defaultReasoningEffort,
  };
}

function applyReasoningCliToModel(
  model: AvailableModel,
  reasoningCli: AcpBridgeReasoningCli | undefined,
): AvailableModel {
  const reasoningSupport = reasoningSupportFromCli(reasoningCli);
  return reasoningSupport === undefined
    ? model
    : {
        ...model,
        ...reasoningSupport,
      };
}

function modelHasOnlyAgentManagedReasoning(model: AvailableModel): boolean {
  return (
    model.supportedReasoningEfforts.length === 1 &&
    model.supportedReasoningEfforts[0]?.reasoningEffort === "medium" &&
    model.defaultReasoningEffort === "medium"
  );
}

function applyNativeReasoningHintToModel(
  model: AvailableModel,
  nativeReasoning: AcpBridgeNativeReasoning | undefined,
): AvailableModel {
  const reasoningSupport = reasoningSupportFromCli(nativeReasoning);
  return reasoningSupport === undefined ||
    !modelHasOnlyAgentManagedReasoning(model)
    ? model
    : {
        ...model,
        ...reasoningSupport,
      };
}

function applyConfiguredReasoningToModel(
  model: AvailableModel,
  args: {
    reasoningCli: AcpBridgeReasoningCli | undefined;
    nativeReasoning: AcpBridgeNativeReasoning | undefined;
  },
): AvailableModel {
  return args.reasoningCli !== undefined
    ? applyReasoningCliToModel(model, args.reasoningCli)
    : applyNativeReasoningHintToModel(model, args.nativeReasoning);
}

function applyConfiguredReasoningToModels(
  models: readonly AvailableModel[],
  args: {
    reasoningCli: AcpBridgeReasoningCli | undefined;
    nativeReasoning: AcpBridgeNativeReasoning | undefined;
  },
): AvailableModel[] {
  return models.map((model) => applyConfiguredReasoningToModel(model, args));
}

function resolveHintReasoningValue(args: {
  hint: Pick<AcpBridgeReasoningCli, "supportedLevels" | "levelValues">;
  reasoningLevel: ReasoningLevel;
}): string | undefined {
  const override = args.hint.levelValues?.[args.reasoningLevel];
  if (override !== undefined) {
    return override;
  }
  return args.hint.supportedLevels.includes(args.reasoningLevel)
    ? args.reasoningLevel
    : undefined;
}

function nativeReasoningToThoughtLevelOption(
  nativeReasoning: AcpBridgeNativeReasoning | undefined,
): AcpConfigOption | undefined {
  if (nativeReasoning === undefined) {
    return undefined;
  }
  const options = nativeReasoning.supportedLevels.flatMap((level) => {
    const value = resolveHintReasoningValue({
      hint: nativeReasoning,
      reasoningLevel: level,
    });
    return value === undefined
      ? []
      : [
          {
            value,
            name: value,
          },
        ];
  });
  const currentValue =
    nativeReasoning.defaultLevel === undefined
      ? undefined
      : resolveHintReasoningValue({
          hint: nativeReasoning,
          reasoningLevel: nativeReasoning.defaultLevel,
        });
  return {
    id: nativeReasoning.configId,
    category: "thought_level",
    type: "select",
    ...(currentValue !== undefined ? { currentValue } : {}),
    options,
  };
}

function permissionCliArgsForMode(
  permissionCli: AcpBridgePermissionCli | undefined,
  permissionMode: AcpSessionPolicy["permissionMode"],
): string[] {
  if (permissionCli === undefined) {
    return [];
  }
  switch (permissionMode) {
    case "full":
      return permissionCli.full ?? [];
    case "accept-edits":
      return permissionCli.workspaceWrite ?? [];
  }
}

function applyPermissionCliArgs(
  agentArgs: readonly string[],
  permissionCli: AcpBridgePermissionCli | undefined,
  permissionMode: AcpSessionPolicy["permissionMode"],
): string[] {
  const permissionArgs = permissionCliArgsForMode(
    permissionCli,
    permissionMode,
  );
  if (permissionArgs.length === 0) {
    return [...agentArgs];
  }
  const insertAfterArgs = Math.min(
    permissionCli?.insertAfterArgs ?? 0,
    agentArgs.length,
  );
  return [
    ...agentArgs.slice(0, insertAfterArgs),
    ...permissionArgs,
    ...agentArgs.slice(insertAfterArgs),
  ];
}

interface AcpDynamicToolBridge {
  host: string;
  port: number;
  server: Server;
  token: string;
}

const dynamicToolBridgeRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initialized"),
    threadId: z.string().min(1),
    token: z.string().min(1),
    toolCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("toolCall"),
    arguments: z.record(z.string(), z.unknown()).default({}),
    callId: z.string().min(1),
    threadId: z.string().min(1),
    token: z.string().min(1),
    tool: z.string().min(1),
  }),
]);

let cachedModelCatalog: { key: string; catalog: AgentModelCatalog } | null =
  null;
const SESSION_MODEL_DISCOVERY_TTL_MS = 60_000;
let cachedSessionDiscoveredModels: {
  key: string;
  models: AvailableModel[];
  fetchedAt: number;
} | null = null;

function resolveAcpAuthMethodId(
  authMethods: readonly { id: string }[] | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  const methodIds = new Set((authMethods ?? []).map((method) => method.id));
  if (methodIds.size === 0) {
    return undefined;
  }
  if (env.XAI_API_KEY && methodIds.has("xai.api_key")) {
    return "xai.api_key";
  }
  if (methodIds.has("cached_token")) {
    return "cached_token";
  }
  return undefined;
}

async function authenticateAcpAgent(args: {
  connection: AcpAgentConnection;
  env: Record<string, string | undefined>;
  initializeResult: { authMethods?: readonly { id: string }[] };
}): Promise<void> {
  const methodId = resolveAcpAuthMethodId(
    args.initializeResult.authMethods,
    args.env,
  );
  if (methodId === undefined) {
    return;
  }
  try {
    await args.connection.request({
      method: "authenticate",
      params: { methodId, _meta: { headless: true } },
      resultSchema: z.unknown(),
    });
  } catch (error) {
    throw new AcpAuthRequiredError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function acpClientCapabilities(
  parameterizedModelPicker: boolean,
  fsAccess = false,
) {
  return {
    fs: { readTextFile: fsAccess, writeTextFile: fsAccess },
    terminal: false,
    ...(parameterizedModelPicker === true
      ? { _meta: { parameterizedModelPicker: true } }
      : {}),
  };
}

async function loadAgentModelCatalog(
  listCommand: AcpAgentCommandParam,
): Promise<AgentModelCatalog | null> {
  const stdout = await new Promise<string | null>((resolveExec, rejectExec) => {
    execFile(
      listCommand.command,
      listCommand.args,
      {
        ...(listCommand.cwd !== undefined ? { cwd: listCommand.cwd } : {}),
        env: {
          ...withoutBridgeRuntimeEnv(process.env),
          ...(listCommand.envVars ?? {}),
        },
        timeout: MODEL_LIST_TIMEOUT_MS,
      },
      (error, out, stderr) => {
        if (!error) {
          resolveExec(out);
          return;
        }
        if (isMissingExecutableError(error)) {
          rejectExec(error);
          return;
        }
        if (isAuthRequiredModelListError(error, out, stderr)) {
          rejectExec(new AcpModelListAuthRequiredError());
          return;
        }
        resolveExec(null);
      },
    );
  });
  const key = JSON.stringify(listCommand);
  if (stdout === null) {
    process.stderr.write(
      `acp bridge: model list command "${listCommand.command}" failed\n`,
    );
    return cachedModelCatalog?.key === key ? cachedModelCatalog.catalog : null;
  }
  const catalog = buildAgentModelCatalog(parseAgentModelLines(stdout));
  if (!catalog) {
    process.stderr.write(
      `acp bridge: model list command "${listCommand.command}" printed no models\n`,
    );
    return cachedModelCatalog?.key === key ? cachedModelCatalog.catalog : null;
  }
  cachedModelCatalog = { key, catalog };
  return catalog;
}

async function loadSessionDiscoveredModels(
  agent: AcpAgentCommandParam,
  reasoningProbePriorityModelIds: readonly string[],
  parameterizedModelPicker: boolean,
): Promise<AvailableModel[] | null> {
  const key = JSON.stringify({
    agent,
    reasoningProbePriorityModelIds,
    parameterizedModelPicker,
  });
  if (
    cachedSessionDiscoveredModels?.key === key &&
    Date.now() - cachedSessionDiscoveredModels.fetchedAt <
      SESSION_MODEL_DISCOVERY_TTL_MS
  ) {
    return cachedSessionDiscoveredModels.models;
  }

  const childEnv = {
    ...withoutBridgeRuntimeEnv(process.env),
    ...(agent.envVars ?? {}),
  };
  const connection = createAcpAgentConnection({
    command: agent.command,
    args: agent.args,
    cwd: agent.cwd ?? process.cwd(),
    env: childEnv,
    recordThreadId: null,
    onNotification: () => {},
    onRequest: (_method, _params, responder) => {
      responder.error(-32601, "ACP model discovery does not support requests");
    },
    onExit: () => {},
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReached = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      connection.kill();
      reject(
        new Error(
          `ACP-native model discovery timed out after ${MODEL_LIST_TIMEOUT_MS}ms`,
        ),
      );
    }, MODEL_LIST_TIMEOUT_MS);
  });

  try {
    const newSession = await Promise.race([
      (async () => {
        const initializeResult = await connection.request({
          method: "initialize",
          params: {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientInfo: { name: "bb", version: "1.0.0" },
            clientCapabilities: acpClientCapabilities(parameterizedModelPicker),
          },
          resultSchema: acpInitializeResultSchema,
        });
        await authenticateAcpAgent({
          connection,
          env: childEnv,
          initializeResult,
        });
        return await connection.request({
          method: "session/new",
          params: { cwd: agent.cwd ?? process.cwd(), mcpServers: [] },
          resultSchema: acpSessionNewResultSchema,
        });
      })(),
      timeoutReached,
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    const modelOption = findAcpModelConfigOption(newSession.configOptions);
    const configOptionModels = buildModelCatalogFromConfigOptions(modelOption);
    const sessionModels = buildModelCatalogFromSessionModels(newSession.models);
    if (configOptionModels.length === 0 && sessionModels.length === 0) {
      return null;
    }

    if (configOptionModels.length === 0) {
      cachedSessionDiscoveredModels = {
        key,
        models: sessionModels,
        fetchedAt: Date.now(),
      };
      return sessionModels;
    }

    const reasoningByModel = await discoverAcpNativeReasoningByModel({
      connection,
      sessionId: newSession.sessionId,
      modelOption,
      reasoningProbePriorityModelIds,
    });
    const models =
      reasoningByModel === null
        ? configOptionModels
        : buildModelCatalogFromConfigOptions(modelOption, reasoningByModel);
    cachedSessionDiscoveredModels = {
      key,
      models,
      fetchedAt: Date.now(),
    };
    return models;
  } catch (error) {
    process.stderr.write(
      `acp bridge: ACP-native model discovery for "${agent.command}" failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return null;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    connection.kill();
  }
}

async function discoverAcpNativeReasoningByModel(args: {
  connection: AcpAgentConnection;
  sessionId: string;
  modelOption: AcpConfigOption | undefined;
  reasoningProbePriorityModelIds: readonly string[];
}): Promise<ReadonlyMap<string, AcpNativeReasoningSupport> | null> {
  const modelOptions = args.modelOption?.options ?? [];
  if (!args.modelOption || modelOptions.length === 0) {
    return null;
  }
  const modelOption = args.modelOption;
  const modelByValue = new Map(
    modelOptions.map((model) => [model.value, model] as const),
  );
  const modelsToProbe: typeof modelOptions = [];
  const addedModels = new Set<string>();
  for (const value of args.reasoningProbePriorityModelIds) {
    const model = modelByValue.get(value);
    if (model && !addedModels.has(model.value)) {
      modelsToProbe.push(model);
      addedModels.add(model.value);
    }
  }
  for (const model of modelOptions) {
    if (!addedModels.has(model.value)) {
      modelsToProbe.push(model);
    }
  }

  const supportByModel = new Map<string, AcpNativeReasoningSupport>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutReached = new Promise<
    ReadonlyMap<string, AcpNativeReasoningSupport>
  >((resolve) => {
    timeout = setTimeout(() => {
      args.connection.kill();
      resolve(supportByModel);
    }, ACP_NATIVE_REASONING_DISCOVERY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      (async () => {
        for (const model of modelsToProbe) {
          const configState = await args.connection.request({
            method: "session/set_config_option",
            params: {
              sessionId: args.sessionId,
              configId: modelOption.id,
              value: model.value,
            },
            resultSchema: acpConfigStateResultSchema,
          });
          supportByModel.set(
            model.value,
            buildAcpNativeReasoningSupport(
              findAcpThoughtLevelConfigOption(configState.configOptions),
            ),
          );
        }
        return supportByModel;
      })(),
      timeoutReached,
    ]);
  } catch {
    return supportByModel.size > 0 ? supportByModel : null;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT" &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn")
  );
}

class AcpAuthRequiredError extends BridgeRecoveryError {
  constructor(message: string) {
    super({
      code: -32000,
      message,
      recovery: { kind: "authRequired", message, retryable: false },
    });
    this.name = "AcpAuthRequiredError";
  }
}

class AcpModelListAuthRequiredError extends AcpAuthRequiredError {
  constructor() {
    super(AUTH_REQUIRED_MODEL_LIST_ERROR_MESSAGE);
    this.name = "AcpModelListAuthRequiredError";
  }
}

function isAcpAuthRequiredText(...texts: readonly string[]): boolean {
  const text = texts.join("\n");
  return (
    text.includes("Authentication required") &&
    (text.includes("agent login") ||
      text.includes("CURSOR_API_KEY") ||
      text.includes("CURSOR_AUTH_TOKEN") ||
      text.includes("auth token") ||
      text.includes("api key") ||
      text.includes("login"))
  );
}

function isAuthRequiredModelListError(
  error: unknown,
  stdout: string,
  stderr: string,
): boolean {
  return isAcpAuthRequiredText(
    error instanceof Error ? error.message : String(error),
    stdout,
    stderr,
  );
}

const ACP_AUTH_REQUIRED_ERROR_CODE = -32000;
const ACP_AUTH_REQUIRED_ERROR_MESSAGE = "Authentication required";

function isAcpAuthRequiredResponse(error: unknown): boolean {
  return (
    error instanceof AcpAgentResponseError &&
    error.code === ACP_AUTH_REQUIRED_ERROR_CODE &&
    error.message.startsWith(ACP_AUTH_REQUIRED_ERROR_MESSAGE)
  );
}

function withAcpAuthRequiredRecovery(error: unknown): unknown {
  if (error instanceof AcpAuthRequiredError) return error;
  if (
    error instanceof Error &&
    (isAcpAuthRequiredResponse(error) || isAcpAuthRequiredText(error.message))
  ) {
    return new AcpAuthRequiredError(error.message);
  }
  return error;
}

async function resolveAgentLaunchArgs(
  params: AcpSessionParams,
): Promise<{ args: string[]; warning: string | undefined }> {
  const selection = params.modelSelection;
  const agentArgs = applyPermissionCliArgs(
    params.agent.args,
    params.permissionCli,
    params.permissionMode,
  );
  const prefixArgs: string[] = [];
  let warning: string | undefined;

  if (selection && "selectFlag" in selection) {
    let resolved: string | undefined;
    const variantReasoningLevel =
      params.reasoningCli === undefined ? selection.reasoningLevel : undefined;
    if (
      variantReasoningLevel !== undefined ||
      selection.serviceTier === "fast"
    ) {
      const key = JSON.stringify(selection.listCommand);
      const catalog =
        cachedModelCatalog?.key === key
          ? cachedModelCatalog.catalog
          : await loadAgentModelCatalog(selection.listCommand);
      resolved = catalog?.resolveVariant({
        model: selection.model,
        reasoningLevel: variantReasoningLevel,
        serviceTier: selection.serviceTier,
      });
      if (resolved === undefined && variantReasoningLevel !== undefined) {
        warning = `Model "${selection.model}" has no ${variantReasoningLevel} reasoning variant; launching it at its default effort.`;
      }
    }
    prefixArgs.push(selection.selectFlag, resolved ?? selection.model);
  }

  if (
    params.reasoningCli !== undefined &&
    params.launchReasoningLevel !== undefined
  ) {
    const reasoningValue = resolveHintReasoningValue({
      hint: params.reasoningCli,
      reasoningLevel: params.launchReasoningLevel,
    });
    if (reasoningValue !== undefined) {
      prefixArgs.push(params.reasoningCli.flag, reasoningValue);
    } else if (warning === undefined) {
      warning = `Reasoning level "${params.launchReasoningLevel}" is not supported by this ACP agent's launch flag; launching it at its default effort.`;
    }
  }

  return {
    args: [...prefixArgs, ...agentArgs],
    warning,
  };
}

async function selectAcpNativeModel(args: {
  connection: AcpAgentConnection;
  sessionId: string;
  configOptions: readonly AcpConfigOption[] | undefined;
  models: AcpSessionModels | undefined;
  modelSelection: AcpSessionParams["modelSelection"];
  nativeReasoning: AcpBridgeNativeReasoning | undefined;
}): Promise<void> {
  const selection = args.modelSelection;
  if (!selection || !("modelId" in selection)) {
    return;
  }
  let configOptions = args.configOptions;
  const modelOption = findAcpModelConfigOption(args.configOptions);
  const availableSessionModels = args.models?.availableModels ?? [];
  const sessionModelsIncludeSelection = availableSessionModels.some(
    (model) => model.modelId === selection.modelId,
  );
  const shouldSetModel =
    (modelOption && modelOption.currentValue !== selection.modelId) ||
    (!modelOption &&
      sessionModelsIncludeSelection &&
      args.models?.currentModelId !== selection.modelId);
  if (shouldSetModel) {
    let configState: AcpConfigStateResult | null = null;
    let setModel = true;
    if (modelOption) {
      try {
        configState = await args.connection.request({
          method: "session/set_config_option",
          params: {
            sessionId: args.sessionId,
            configId: modelOption.id,
            value: selection.modelId,
          },
          resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
        });
        setModel = false;
      } catch {
        setModel = true;
      }
    }
    if (setModel) {
      configState = await args.connection.request({
        method: "session/set_model",
        params: { sessionId: args.sessionId, modelId: selection.modelId },
        resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
      });
    }
    configOptions = configState?.configOptions ?? configOptions;
  }
  await selectAcpNativeReasoning({
    connection: args.connection,
    sessionId: args.sessionId,
    configOptions,
    modelSelection: selection,
    nativeReasoning: args.nativeReasoning,
  });
  await selectAcpNativeServiceTier({
    connection: args.connection,
    sessionId: args.sessionId,
    configOptions,
    modelSelection: selection,
  });
}

async function selectAcpNativeReasoning(args: {
  connection: AcpAgentConnection;
  sessionId: string;
  configOptions: readonly AcpConfigOption[] | undefined;
  modelSelection: Extract<
    AcpSessionParams["modelSelection"],
    { modelId: string }
  >;
  nativeReasoning: AcpBridgeNativeReasoning | undefined;
}): Promise<void> {
  const reasoningLevel = args.modelSelection.reasoningLevel;
  if (reasoningLevel === undefined) {
    return;
  }
  const thoughtLevelOption =
    findAcpThoughtLevelConfigOption(args.configOptions) ??
    nativeReasoningToThoughtLevelOption(args.nativeReasoning);
  if (!thoughtLevelOption) {
    return;
  }
  const value = acpNativeReasoningLevelToValue(
    reasoningLevel,
    thoughtLevelOption,
  );
  if (value === undefined) {
    return;
  }
  try {
    await args.connection.request({
      method: "session/set_config_option",
      params: {
        sessionId: args.sessionId,
        configId: thoughtLevelOption.id,
        value,
      },
      resultSchema: acpConfigStateResultSchema,
    });
  } catch {}
}

async function selectAcpNativeServiceTier(args: {
  connection: AcpAgentConnection;
  sessionId: string;
  configOptions: readonly AcpConfigOption[] | undefined;
  modelSelection: Extract<
    AcpSessionParams["modelSelection"],
    { modelId: string }
  >;
}): Promise<void> {
  const serviceTier = args.modelSelection.serviceTier;
  if (serviceTier === undefined) {
    return;
  }
  const fastOption = (args.configOptions ?? []).find(
    (option) => option.id === "fast" && option.type === "select",
  );
  const value = serviceTier === "fast" ? "true" : "false";
  if (!fastOption?.options?.some((option) => option.value === value)) {
    return;
  }
  await args.connection.request({
    method: "session/set_config_option",
    params: {
      sessionId: args.sessionId,
      configId: fastOption.id,
      value,
    },
    resultSchema: acpConfigStateResultSchema,
  });
}

function buildPromptContentBlocks(
  session: AcpThreadSession,
  input: PromptInput[],
): AcpContentBlock[] {
  const blocks: AcpContentBlock[] = [];

  const instructions = session.pendingInstructions;
  if (instructions) {
    session.pendingInstructions = undefined;
    blocks.push({
      type: "text",
      text: `<system_instructions>\n${instructions}\n</system_instructions>`,
    });
  }

  for (const item of input) {
    switch (item.type) {
      case "text":
        blocks.push({ type: "text", text: item.text });
        break;
      case "image":
        blocks.push({ type: "text", text: `[image attachment: ${item.url}]` });
        break;
      case "localImage": {
        if (!session.supportsImageInput) {
          blocks.push({
            type: "text",
            text: `[image attachment on disk: ${item.path}]`,
          });
          break;
        }
        try {
          const data = readFileSync(item.path).toString("base64");
          blocks.push({
            type: "image",
            data,
            mimeType: mimeTypeFromExtension(item.path),
          });
        } catch {
          blocks.push({
            type: "text",
            text: `[unreadable image attachment: ${item.path}]`,
          });
        }
        break;
      }
      case "localFile":
        blocks.push({
          type: "resource_link",
          uri: `file://${item.path}`,
          name: item.name ?? basename(item.path),
        });
        break;
    }
  }

  return blocks;
}

function findOptionIdByKinds(
  options: AcpPermissionOption[],
  kinds: AcpPermissionOption["kind"][],
): string | undefined {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) {
      return option.optionId;
    }
  }
  return undefined;
}

function pickPermissionOptionId(
  options: AcpPermissionOption[],
  decision: "allow_once" | "allow_for_session" | "deny",
): string | undefined {
  switch (decision) {
    case "allow_once":
      return findOptionIdByKinds(options, ["allow_once", "allow_always"]);
    case "allow_for_session":
      return findOptionIdByKinds(options, ["allow_always", "allow_once"]);
    case "deny":
      return findOptionIdByKinds(options, ["reject_once", "reject_always"]);
  }
}

function respondPermission(
  pending: PendingAcpPermission,
  decision: "allow_once" | "allow_for_session" | "deny" | null,
): void {
  if (decision === null) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }
  const optionId = pickPermissionOptionId(pending.options, decision);
  if (optionId === undefined) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }
  pending.responder.result({ outcome: { outcome: "selected", optionId } });
}

function cancelPendingPermissions(session: AcpThreadSession): void {
  for (const pending of session.pendingPermissions) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
  }
  session.pendingPermissions.clear();
}

function handlePermissionRequest(
  session: AcpThreadSession,
  params: unknown,
  responder: AcpAgentRequestResponder,
): void {
  const parsed = acpRequestPermissionParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid session/request_permission params");
    return;
  }

  if (
    session.stopping ||
    session.cancelRequested ||
    session.activePromptKind !== "turn"
  ) {
    responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }

  const toolCall = parsed.data.toolCall;
  const bound =
    toolCall?.toolCallId !== undefined
      ? session.translator.notePermissionToolCall(session.bbThreadId, {
          toolCallId: toolCall.toolCallId,
          ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
          ...(toolCall.kind !== undefined ? { kind: toolCall.kind } : {}),
          ...(toolCall.rawKind !== undefined
            ? { rawKind: toolCall.rawKind }
            : {}),
          ...(toolCall.locations !== undefined
            ? { locations: toolCall.locations }
            : {}),
          ...(toolCall.rawInput !== undefined
            ? { rawInput: toolCall.rawInput }
            : {}),
          ...(toolCall.rawOutput !== undefined
            ? { rawOutput: toolCall.rawOutput }
            : {}),
        })
      : undefined;
  const pending: PendingAcpPermission = {
    responder,
    options: parsed.data.options,
  };

  if (session.policy.permissionMode === "full") {
    respondPermission(pending, "allow_once");
    return;
  }

  session.pendingPermissions.add(pending);

  const normalizedToolCall =
    toolCall?.toolCallId !== undefined && bound !== undefined
      ? {
          toolCallId: bound.toolCallId,
          ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
          ...(toolCall.kind !== undefined ? { kind: toolCall.kind } : {}),
          ...(toolCall.rawKind !== undefined
            ? { rawKind: toolCall.rawKind }
            : {}),
          ...(toolCall.content !== undefined
            ? { content: toolCall.content }
            : {}),
          ...(toolCall.rawInput !== undefined
            ? { rawInput: toolCall.rawInput }
            : {}),
          ...(toolCall.locations !== undefined
            ? { locations: toolCall.locations }
            : {}),
          startedToolCall: bound.event,
          injectedTool: session.translator.getInjectedToolBinding(
            session.bbThreadId,
            bound.toolCallId,
          ),
        }
      : undefined;

  {
    const payload = buildAcpPermissionInteractionPayload({
      toolCall: normalizedToolCall,
      options: parsed.data.options,
      cwd: session.cwd,
      classifyToolCall: session.dialect.classifyToolCall,
    });
    void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
      providerThreadId: session.providerThreadId,
      threadId: session.bbThreadId,
      turnId: null,
      payload,
    })
      .then((result) => {
        if (!session.pendingPermissions.delete(pending)) {
          return;
        }
        const resolution = pendingInteractionResolutionSchema.safeParse(result);
        const response = resolution.success
          ? resolveAcpPermissionDecision({
              payload,
              resolution: resolution.data,
            })
          : null;
        respondPermission(pending, response?.decision ?? null);
      })
      .catch(() => {
        if (!session.pendingPermissions.delete(pending)) {
          return;
        }
        respondPermission(pending, null);
      });
  }
}

function isPathInsideRoots(targetPath: string, roots: string[]): boolean {
  const resolvedTarget = resolve(targetPath);
  return roots.some((root) => {
    const relativePath = relative(resolve(root), resolvedTarget);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    );
  });
}

function sliceFileContent(
  content: string,
  line: number | null | undefined,
  limit: number | null | undefined,
): string {
  if (line == null && limit == null) {
    return content;
  }
  const lines = content.split("\n");
  const startIndex = line == null ? 0 : Math.max(0, line - 1);
  const endIndex = limit == null ? lines.length : startIndex + limit;
  return lines.slice(startIndex, endIndex).join("\n");
}

async function handleFsReadTextFile(
  params: unknown,
  responder: AcpAgentRequestResponder,
): Promise<void> {
  const parsed = acpReadTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid fs/read_text_file params");
    return;
  }
  try {
    const content = await fs.readFile(parsed.data.path, "utf8");
    responder.result({
      content: sliceFileContent(content, parsed.data.line, parsed.data.limit),
    });
  } catch (error) {
    responder.error(
      -32603,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleFsWriteTextFile(
  session: AcpThreadSession,
  params: unknown,
  responder: AcpAgentRequestResponder,
): Promise<void> {
  const parsed = acpWriteTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid fs/write_text_file params");
    return;
  }

  if (
    session.policy.permissionMode === "accept-edits" &&
    !isPathInsideRoots(parsed.data.path, session.policy.workspaceWriteRoots)
  ) {
    responder.error(
      -32000,
      `File writes outside the workspace are denied by BB's accept-edits permission mode: ${parsed.data.path}`,
    );
    return;
  }

  try {
    let oldText: string | undefined;
    try {
      oldText = await fs.readFile(parsed.data.path, "utf8");
    } catch {
      oldText = undefined;
    }
    await fs.mkdir(dirname(parsed.data.path), { recursive: true });
    await fs.writeFile(parsed.data.path, parsed.data.content, "utf8");

    emitForSession(session, ACP_FS_WRITE_METHOD, {
      threadId: session.bbThreadId,
      path: parsed.data.path,
      kind: oldText === undefined ? "add" : "update",
      ...(oldText === undefined ? {} : { oldText }),
      content: parsed.data.content,
    });
    responder.result(null);
  } catch (error) {
    responder.error(
      -32603,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function liveSessionForThread(
  bbThreadId: string,
): AcpThreadSession | undefined {
  const session = sessionsByBbThreadId.get(bbThreadId);
  if (!session || session.stopping || session.providerThreadId === "") {
    return undefined;
  }
  return session;
}

function removeSession(session: AcpThreadSession): void {
  if (sessionsByBbThreadId.get(session.bbThreadId) === session) {
    sessionsByBbThreadId.delete(session.bbThreadId);
  }
  if (
    bbThreadIdByProviderThreadId.get(session.providerThreadId) ===
    session.bbThreadId
  ) {
    bbThreadIdByProviderThreadId.delete(session.providerThreadId);
  }
}

async function releaseCursorMcpApproval(
  session: AcpThreadSession,
): Promise<void> {
  const approval = session.cursorMcpApproval;
  session.cursorMcpApproval = undefined;
  if (!approval) {
    return;
  }
  try {
    await revokeCursorSessionMcpServer(approval);
  } catch (error) {
    process.stderr.write(
      `acp bridge: failed to remove Cursor session MCP approval for thread "${session.bbThreadId}": ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function getSessionByProviderThreadId(
  providerThreadId: string,
): AcpThreadSession | undefined {
  const bbThreadId = bbThreadIdByProviderThreadId.get(providerThreadId);
  return bbThreadId ? sessionsByBbThreadId.get(bbThreadId) : undefined;
}

type AcpSessionStartRequest =
  | { kind: "start"; params: AcpSessionParams }
  | {
      kind: "resume";
      params: AcpSessionParams;
      resumeProviderThreadId: string;
    }
  | {
      kind: "fork";
      params: AcpSessionParams;
      sourceProviderThreadId: string;
    };

async function startAgentSession(
  request: AcpSessionStartRequest,
): Promise<AcpThreadSession> {
  const params = request.params;
  const bbThreadId = params.threadId;

  const existing = sessionsByBbThreadId.get(bbThreadId);
  if (existing) {
    await stopSession(existing);
  }

  const dialect = resolveAcpDialect({
    ...(params.dialectId === undefined ? {} : { dialectId: params.dialectId }),
    command: params.agent.command,
  });
  const translator = createAcpDeltaTranslator({
    cwd: params.cwd,
    dialect,
  });
  translator.configureInjectedTools(
    (params.dynamicTools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.presentation === undefined
        ? {}
        : { presentation: tool.presentation }),
    })),
  );
  const deferredEmits: {
    method: string;
    params: Record<string, unknown>;
    sessionId: string | undefined;
  }[] = [];
  const emitStartNotification: AcpDeferredStartEmitter = (
    method,
    notificationParams,
    sessionId,
  ) => {
    deferredEmits.push({ method, params: notificationParams, sessionId });
  };

  const launch = await resolveAgentLaunchArgs(params);
  if (launch.warning) {
    emitStartNotification(ACP_WARNING_METHOD, {
      threadId: bbThreadId,
      summary: launch.warning,
    });
  }
  const agentLabel = [params.agent.command, ...params.agent.args].join(" ");
  let session: AcpThreadSession;
  const childEnv = {
    ...withoutBridgeRuntimeEnv(process.env),
    ...params.envVars,
  };
  const connection = createAcpAgentConnection({
    command: params.agent.command,
    args: launch.args,
    cwd: params.cwd,
    env: childEnv,
    recordThreadId: bbThreadId,
    onNotification: (method, notificationParams) =>
      handleAgentNotification(session, method, notificationParams),
    onRequest: (method, requestParams, responder) =>
      handleAgentRequest(session, method, requestParams, responder),
    onExit: (info) => {
      const wasCurrent = sessionsByBbThreadId.get(bbThreadId) === session;
      cancelPendingPermissions(session);
      removeSession(session);
      if (!wasCurrent || session.stopping || session.providerThreadId === "") {
        return;
      }
      void releaseCursorMcpApproval(session);
      emitSessionError(
        session,
        `ACP agent "${agentLabel}" exited unexpectedly` +
          `${info.code !== null ? ` (code ${info.code})` : ""}` +
          `${info.stderrTail ? `: ${info.stderrTail}` : ""}`,
      );
    },
  });
  session = {
    bbThreadId,
    providerThreadId: "",
    cwd: params.cwd,
    dialect,
    translator,
    connection,
    supportsImageInput: false,
    supportsLoadSession: false,
    policy: {
      permissionMode: params.permissionMode,
      workspaceWriteRoots: params.workspaceWriteRoots,
    },
    pendingInstructions: params.instructions,
    activePromptKind: null,
    compactionAgentMessage: "",
    queuedInputs: [],
    promptRequestPending: false,
    cancelRequested: false,
    loading: false,
    loadingSessionId: undefined,
    pendingLoadUsageUpdate: undefined,
    stopping: false,
    turnSettled: undefined,
    pendingPermissions: new Set(),
    cursorMcpApproval: undefined,
    deferStartEmit: emitStartNotification,
  };
  sessionsByBbThreadId.set(bbThreadId, session);

  try {
    const initializeResult = await connection.request({
      method: "initialize",
      params: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: "bb", version: "1.0.0" },
        clientCapabilities: acpClientCapabilities(
          params.parameterizedModelPicker,
          true,
        ),
      },
      resultSchema: acpInitializeResultSchema,
    });
    await authenticateAcpAgent({
      connection,
      env: childEnv,
      initializeResult,
    });
    session.supportsImageInput =
      initializeResult.agentCapabilities?.promptCapabilities?.image ?? false;
    const supportsLoadSession =
      initializeResult.agentCapabilities?.loadSession ?? false;
    const supportsFork =
      initializeResult.agentCapabilities?.sessionCapabilities?.fork != null;
    if (request.kind === "fork" && !supportsFork) {
      throw new Error(
        `ACP agent "${agentLabel}" does not advertise session/fork support.`,
      );
    }
    session.supportsLoadSession = supportsLoadSession;
    const mcpServers = await buildSessionMcpServers(params);
    const mcpServer = mcpServers[0];
    if (mcpServer) {
      session.cursorMcpApproval = await approveCursorSessionMcpServer({
        agentCommand: params.agent.command,
        config: mcpServer,
        cwd: params.cwd,
        env: childEnv,
      });
      if (session.cursorMcpApproval?.installedByBb) {
        process.stderr.write(
          `acp bridge: installed Cursor session MCP approval for thread "${bbThreadId}"\n`,
        );
      }
    }

    let sessionId: string | undefined;
    let loadedConfigOptions: readonly AcpConfigOption[] | undefined;
    let loadedModels: AcpSessionModels | undefined;
    if (request.kind === "fork") {
      const forkedSession = await connection.request({
        method: "session/fork",
        params: {
          sessionId: request.sourceProviderThreadId,
          cwd: params.cwd,
          mcpServers,
        },
        resultSchema: acpSessionForkResultSchema,
      });
      if (
        forkedSession.sessionId === request.sourceProviderThreadId ||
        getSessionByProviderThreadId(forkedSession.sessionId) !== undefined
      ) {
        throw new Error(
          `ACP agent "${agentLabel}" returned an active session ID for session/fork.`,
        );
      }
      sessionId = forkedSession.sessionId;
      loadedConfigOptions = forkedSession.configOptions;
      loadedModels = forkedSession.models;
    } else if (request.kind === "resume" && supportsLoadSession) {
      session.loading = true;
      session.loadingSessionId = request.resumeProviderThreadId;
      session.pendingLoadUsageUpdate = undefined;
      try {
        const configState = await connection.request({
          method: "session/load",
          params: {
            sessionId: request.resumeProviderThreadId,
            cwd: params.cwd,
            mcpServers,
          },
          resultSchema: z.union([acpConfigStateResultSchema, z.null()]),
        });
        loadedConfigOptions = configState?.configOptions;
        loadedModels = configState?.models;
        sessionId = request.resumeProviderThreadId;
      } catch {
        sessionId = undefined;
        session.loading = false;
        session.loadingSessionId = undefined;
        session.pendingLoadUsageUpdate = undefined;
      }
    }

    if (sessionId === undefined) {
      session.loading = false;
      session.loadingSessionId = undefined;
      session.pendingLoadUsageUpdate = undefined;
      const newSession = await connection.request({
        method: "session/new",
        params: { cwd: params.cwd, mcpServers },
        resultSchema: acpSessionNewResultSchema,
      });
      sessionId = newSession.sessionId;
      await selectAcpNativeModel({
        connection,
        sessionId,
        configOptions: newSession.configOptions,
        models: newSession.models,
        modelSelection: params.modelSelection,
        nativeReasoning: params.nativeReasoning,
      });
      if (request.kind === "resume") {
        emitStartNotification(ACP_WARNING_METHOD, {
          threadId: bbThreadId,
          summary: `${agentLabel} could not restore the previous session; continuing in a fresh session without in-agent history.`,
        });
      }
    } else {
      await selectAcpNativeModel({
        connection,
        sessionId,
        configOptions: loadedConfigOptions,
        models: loadedModels,
        modelSelection: params.modelSelection,
        nativeReasoning: params.nativeReasoning,
      });
      const loadUsageUpdate = session.pendingLoadUsageUpdate;
      session.loading = false;
      session.loadingSessionId = undefined;
      session.pendingLoadUsageUpdate = undefined;
      if (loadUsageUpdate) {
        emitStartNotification(ACP_UPDATE_METHOD, {
          threadId: session.bbThreadId,
          update: loadUsageUpdate,
        });
      }
    }

    if (session.stopping) {
      throw new Error(
        `ACP session for thread "${bbThreadId}" was released during construction`,
      );
    }
    session.providerThreadId = sessionId;
    bbThreadIdByProviderThreadId.set(sessionId, bbThreadId);
    sendNotification(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: bbThreadId,
      providerThreadId: sessionId,
      sessionRestorable: session.supportsLoadSession,
    });
    sendThreadDeltas(bbThreadId, [{ kind: "session.reset" }]);
    session.deferStartEmit = undefined;
    for (const deferred of deferredEmits) {
      if (
        deferred.sessionId !== undefined &&
        deferred.sessionId !== sessionId
      ) {
        continue;
      }
      emitForSession(session, deferred.method, deferred.params);
    }
    deferredEmits.length = 0;
    return session;
  } catch (error) {
    session.stopping = true;
    session.deferStartEmit = undefined;
    connection.kill();
    removeSession(session);
    await releaseCursorMcpApproval(session);
    throw error;
  }
}

async function stopSession(session: AcpThreadSession): Promise<void> {
  if (session.stopping) {
    return;
  }
  session.stopping = true;
  dropQueuedTurnInputs(
    session,
    "ACP session stopped before the steer was sent",
  );
  cancelPendingPermissions(session);

  if (session.activePromptKind !== null && !session.connection.exited) {
    session.connection.notify("session/cancel", {
      sessionId: session.providerThreadId,
    });
    if (session.turnSettled) {
      await Promise.race([
        session.turnSettled,
        new Promise<void>((resolveTimeout) =>
          setTimeout(resolveTimeout, THREAD_STOP_CANCEL_TIMEOUT_MS),
        ),
      ]);
    }
  }
  settleInterruptedPrompt(session);

  session.connection.kill();
  removeSession(session);
  await releaseCursorMcpApproval(session);
}

function settleInterruptedPrompt(session: AcpThreadSession): void {
  switch (session.activePromptKind) {
    case "turn":
      finishTurn(session, "cancelled");
      return;
    case "compaction":
      finishCompaction(session, { status: "interrupted" });
      return;
    case null:
      return;
  }
}

async function releaseSession(session: AcpThreadSession): Promise<void> {
  if (session.stopping) {
    return;
  }
  session.stopping = true;
  dropQueuedTurnInputs(
    session,
    "ACP session released before the steer was sent",
  );
  cancelPendingPermissions(session);
  session.connection.kill();
  removeSession(session);
  await releaseCursorMcpApproval(session);
}

function requestSteerCancel(session: AcpThreadSession): void {
  if (
    session.stopping ||
    session.cancelRequested ||
    !session.promptRequestPending ||
    session.connection.exited
  ) {
    return;
  }
  session.cancelRequested = true;
  cancelPendingPermissions(session);
  session.connection.notify("session/cancel", {
    sessionId: session.providerThreadId,
  });
}

function acceptTurnInput(
  session: AcpThreadSession,
  pending: AcpPendingTurnInput,
): void {
  sendThreadDeltas(session.bbThreadId, [
    { kind: "input.accepted", clientRequestId: pending.clientRequestId },
  ]);
  const requestId = takeTurnInputRequestId(pending);
  if (requestId !== null) {
    sendResult(requestId, { threadId: session.bbThreadId });
  }
}

function dropTurnInput(pending: AcpPendingTurnInput, reason: string): void {
  const requestId = takeTurnInputRequestId(pending);
  if (requestId !== null) {
    sendError(requestId, -32000, reason);
  }
}

function takeTurnInputRequestId(
  pending: AcpPendingTurnInput,
): AcpBridgeRequestId | null {
  const requestId = pending.requestId;
  pending.requestId = null;
  return requestId;
}

function dropQueuedTurnInputs(session: AcpThreadSession, reason: string): void {
  for (const pending of session.queuedInputs.splice(0)) {
    dropTurnInput(pending, reason);
  }
}

function finishTurn(
  session: AcpThreadSession,
  stopReason: z.infer<typeof acpStopReasonSchema>,
): void {
  if (session.activePromptKind !== "turn") {
    return;
  }
  session.activePromptKind = null;
  dropQueuedTurnInputs(session, "ACP turn ended before the steer was sent");
  session.promptRequestPending = false;
  session.cancelRequested = false;
  emitForSession(session, ACP_TURN_COMPLETED_METHOD, {
    threadId: session.bbThreadId,
    stopReason,
  });
}

function runTurn(
  session: AcpThreadSession,
  firstInput: AcpPendingTurnInput,
): void {
  session.activePromptKind = "turn";
  emitForSession(session, ACP_TURN_STARTED_METHOD, {
    threadId: session.bbThreadId,
  });

  session.turnSettled = (async () => {
    let pending = firstInput;
    for (;;) {
      if (session.stopping) {
        dropTurnInput(pending, "ACP session is stopping");
        finishTurn(session, "cancelled");
        return;
      }

      let stopReason: z.infer<typeof acpStopReasonSchema>;
      session.cancelRequested = false;
      try {
        session.promptRequestPending = true;
        const promptResult = session.connection.request({
          method: "session/prompt",
          params: {
            sessionId: session.providerThreadId,
            prompt: buildPromptContentBlocks(session, pending.input),
          },
          resultSchema: acpPromptResultSchema,
        });
        acceptTurnInput(session, pending);
        if (session.queuedInputs.length > 0) {
          requestSteerCancel(session);
        }
        const result = await promptResult;
        stopReason = result.stopReason;
      } catch (error) {
        session.promptRequestPending = false;
        dropTurnInput(pending, "ACP turn failed before the prompt was sent");
        dropQueuedTurnInputs(
          session,
          "ACP turn failed before the steer was sent",
        );
        session.cancelRequested = false;
        if (!session.stopping && !session.connection.exited) {
          emitSessionError(
            session,
            error instanceof Error ? error.message : String(error),
          );
        }
        session.activePromptKind = null;
        return;
      }
      session.promptRequestPending = false;

      if (!session.stopping) {
        const next = session.queuedInputs.shift();
        if (next) {
          pending = next;
          continue;
        }
      }

      finishTurn(session, stopReason);
      return;
    }
  })();
}

function startCompaction(
  session: AcpThreadSession,
  pending: AcpPendingTurnInput,
): void {
  session.activePromptKind = "compaction";
  session.compactionAgentMessage = "";
  emitForSession(session, ACP_COMPACTION_STARTED_METHOD, {
    threadId: session.bbThreadId,
  });

  const finish = (outcome: Record<string, unknown>): void => {
    finishCompaction(session, outcome);
  };

  const promptResult = session.connection.request({
    method: "session/prompt",
    params: {
      sessionId: session.providerThreadId,
      prompt: [{ type: "text", text: "/compact" }],
    },
    resultSchema: acpPromptResultSchema,
  });
  acceptTurnInput(session, pending);

  session.turnSettled = promptResult
    .then((result) => {
      finish(
        result.stopReason === "end_turn"
          ? compactionOutcomeForEndTurn(
              session.dialect,
              session.compactionAgentMessage,
            )
          : result.stopReason === "cancelled"
            ? { status: "interrupted" }
            : {
                status: "failed",
                error: `Agent stopped compaction: ${result.stopReason}`,
              },
      );
    })
    .catch((error: unknown) => {
      finish({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function finishCompaction(
  session: AcpThreadSession,
  outcome: Record<string, unknown>,
): void {
  if (session.activePromptKind !== "compaction") {
    return;
  }
  emitForSession(session, ACP_COMPACTION_COMPLETED_METHOD, {
    threadId: session.bbThreadId,
    ...outcome,
  });
  session.activePromptKind = null;
  session.turnSettled = undefined;
}

function handleAgentRequest(
  session: AcpThreadSession,
  method: string,
  params: unknown,
  responder: AcpAgentRequestResponder,
): void {
  switch (method) {
    case "session/request_permission":
      handlePermissionRequest(session, params, responder);
      return;
    case "fs/read_text_file":
      void handleFsReadTextFile(params, responder);
      return;
    case "fs/write_text_file":
      void handleFsWriteTextFile(session, params, responder);
      return;
    default:
      handleDialectRequest(session, method, params, responder);
  }
}

function handleDialectRequest(
  session: AcpThreadSession,
  method: string,
  params: unknown,
  responder: AcpAgentRequestResponder,
): void {
  const outcome = session.dialect.handleClientRequest?.(method, params);
  if (outcome === undefined) {
    responder.error(-32601, `Unsupported ACP client method "${method}"`);
    return;
  }
  if (outcome.delegation !== undefined) {
    sendThreadDeltas(
      session.bbThreadId,
      session.translator.noteDelegationReport(
        session.bbThreadId,
        outcome.delegation,
      ),
    );
  }
  responder.result(outcome.result);
}

function handleAgentNotification(
  session: AcpThreadSession,
  method: string,
  params: unknown,
): void {
  if (method !== "session/update") {
    return;
  }
  if (session.stopping) {
    return;
  }
  const parsed = acpSessionNotificationParamsSchema.safeParse(params);
  if (!parsed.success) {
    return;
  }
  if (session.loading) {
    if (
      parsed.data.sessionId === session.loadingSessionId &&
      parsed.data.update.sessionUpdate === "usage_update"
    ) {
      const usageUpdate = acpUsageUpdateSchema.safeParse(parsed.data.update);
      if (usageUpdate.success) {
        session.pendingLoadUsageUpdate = usageUpdate.data;
      }
    }
    return;
  }
  const update = {
    threadId: session.bbThreadId,
    update: parsed.data.update,
  };
  if (session.providerThreadId === "") {
    session.deferStartEmit?.(ACP_UPDATE_METHOD, update, parsed.data.sessionId);
    return;
  }
  if (parsed.data.sessionId !== session.providerThreadId) {
    return;
  }
  if (session.activePromptKind === "compaction") {
    const chunk = acpAgentMessageChunkUpdateSchema.safeParse(
      parsed.data.update,
    );
    if (chunk.success) {
      session.compactionAgentMessage +=
        extractAcpContentText(chunk.data.content) ?? "";
    }
  }
  emitForSession(session, ACP_UPDATE_METHOD, update);
}

type DecodedAcpBridgeRequest =
  | { kind: "request"; request: AcpBridgeCommand & { id: string | number } }
  | { kind: "unknown-method"; id: string | number; method: string }
  | {
      kind: "invalid-params";
      id: string | number;
      method: string;
      issues: string;
    }
  | { kind: "ignored" };

function decodeAcpBridgeJsonRpcRequest(raw: unknown): DecodedAcpBridgeRequest {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.id === undefined) {
    return { kind: "ignored" };
  }
  const command = acpBridgeCommandSchema.safeParse({
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
    !(acpBridgeCommandMethodValues as readonly string[]).includes(
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

async function handleModelList(
  id: string | number,
  params: AcpModelListParams,
  dialectId: string | undefined,
): Promise<void> {
  const catalog = params.listCommand
    ? await loadAgentModelCatalog(params.listCommand)
    : null;
  if (catalog) {
    const catalogModels =
      params.parameterizedModelPicker && dialectId === "cursor"
        ? buildCursorParameterizedModelCatalog(catalog.models)
        : catalog.models;
    sendResult(
      id,
      splitPrimaryModels(
        applyConfiguredReasoningToModels(catalogModels, {
          reasoningCli: params.reasoningCli,
          nativeReasoning: params.nativeReasoning,
        }),
        params.primaryModels,
      ),
    );
    return;
  }
  const sessionDiscoveredModels =
    params.listCommand === undefined && params.agent
      ? await loadSessionDiscoveredModels(
          params.agent,
          params.reasoningProbePriorityModelIds,
          params.parameterizedModelPicker,
        )
      : null;
  if (sessionDiscoveredModels) {
    sendResult(
      id,
      splitPrimaryModels(
        applyConfiguredReasoningToModels(sessionDiscoveredModels, {
          reasoningCli: params.reasoningCli,
          nativeReasoning: params.nativeReasoning,
        }),
        params.primaryModels,
      ),
    );
    return;
  }
  sendResult(id, {
    models: [
      applyConfiguredReasoningToModel(ACP_DEFAULT_MODEL, {
        reasoningCli: params.reasoningCli,
        nativeReasoning: params.nativeReasoning,
      }),
    ],
    selectedOnlyModels: [],
  });
}

function decodeLaunchSpec(
  providerOptions: Record<string, unknown> | undefined,
): AcpLaunchSpec | null {
  const launchSpec = acpLaunchSpecSchema.safeParse(
    providerOptions?.["acpLaunchSpec"],
  );
  return launchSpec.success ? launchSpec.data : null;
}

const acpProviderOptionsSchema = z
  .object({
    additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
    acpDialect: z.string().min(1).optional(),
    parameterizedModelPicker: z.boolean().optional(),
    primaryModels: z.array(z.string().min(1)).optional(),
    reasoningProbePriorityModelIds: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

interface AcpModelPickerOptions {
  parameterizedModelPicker: boolean;
  primaryModels?: string[];
  reasoningProbePriorityModelIds: string[];
}

function decodeAcpModelPickerOptions(
  providerOptions: Record<string, unknown> | undefined,
): AcpModelPickerOptions {
  const parsed = acpProviderOptionsSchema.parse(providerOptions ?? {});
  return {
    parameterizedModelPicker: parsed.parameterizedModelPicker === true,
    ...(parsed.primaryModels === undefined
      ? {}
      : { primaryModels: [...parsed.primaryModels] }),
    reasoningProbePriorityModelIds: [
      ...(parsed.reasoningProbePriorityModelIds ?? []),
    ],
  };
}

function decodeAdditionalWorkspaceWriteRoots(
  providerOptions: Record<string, unknown> | undefined,
): string[] {
  return (
    acpProviderOptionsSchema.parse(providerOptions ?? {})
      .additionalWorkspaceWriteRoots ?? []
  );
}

function decodeDialectId(
  providerOptions: Record<string, unknown> | undefined,
): string | undefined {
  return acpProviderOptionsSchema.parse(providerOptions ?? {}).acpDialect;
}

function maintenanceForRequest(
  providerOptions: Record<string, unknown> | undefined,
  launchSpec: AcpLaunchSpec | null,
): AcpMaintenanceDialect | undefined {
  const dialectId = decodeDialectId(providerOptions);
  return resolveAcpDialect({
    ...(dialectId === undefined ? {} : { dialectId }),
    command: launchSpec?.command ?? "",
  }).maintenance;
}

async function handleRequest(
  request: AcpBridgeCommand & { id: string | number },
): Promise<void> {
  switch (request.method) {
    case "initialize":
      const result: InitializeResult = {
        ok: true,
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: false,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "tip",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "queue",
          skills: { configure: true },
        },
      };
      sendResult(request.id, result);
      return;

    case "model/list": {
      const modelPicker = decodeAcpModelPickerOptions(
        request.params.providerOptions,
      );
      await handleModelList(
        request.id,
        buildAcpModelListParams(
          decodeLaunchSpec(request.params.providerOptions),
          modelPicker,
        ),
        decodeDialectId(request.params.providerOptions),
      );
      return;
    }

    case "provider/health": {
      const launchSpec = decodeLaunchSpec(request.params.providerOptions);
      sendResult(
        request.id,
        await getAcpProviderHealth({
          maintenance: maintenanceForRequest(
            request.params.providerOptions,
            launchSpec,
          ),
          command: launchSpec?.command ?? null,
        }),
      );
      return;
    }

    case "provider/usage": {
      const launchSpec = decodeLaunchSpec(request.params.providerOptions);
      sendResult(
        request.id,
        await getAcpProviderUsage({
          maintenance: maintenanceForRequest(
            request.params.providerOptions,
            launchSpec,
          ),
          command: launchSpec?.command ?? null,
        }),
      );
      return;
    }

    case "provider/installation/status": {
      const launchSpec = decodeLaunchSpec(request.params.providerOptions);
      sendResult(
        request.id,
        await getAcpProviderInstallationStatus({
          maintenance: maintenanceForRequest(
            request.params.providerOptions,
            launchSpec,
          ),
          command: launchSpec?.command ?? null,
        }),
      );
      return;
    }

    case "provider/installation/run": {
      const launchSpec = decodeLaunchSpec(request.params.providerOptions);
      sendResult(
        request.id,
        await getAcpProviderInstallationRun({
          maintenance: maintenanceForRequest(
            request.params.providerOptions,
            launchSpec,
          ),
          command: launchSpec?.command ?? null,
          action: request.params.action,
        }),
      );
      return;
    }

    case "thread/start":
    case "thread/resume":
    case "thread/fork": {
      if (
        request.method === "thread/fork" &&
        request.params.sourceProviderCheckpointId !== undefined
      ) {
        sendError(
          request.id,
          BRIDGE_JSON_RPC_ERRORS.FORK_CHECKPOINT_UNSUPPORTED,
          "ACP session/fork cannot fork at a checkpoint; only tip forks are supported",
        );
        return;
      }
      const params = request.params;
      const launchSpec = decodeLaunchSpec(params.options.providerOptions);
      if (launchSpec === null) {
        sendError(
          request.id,
          BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
          `Invalid params for "${request.method}": options.providerOptions.acpLaunchSpec is required by the ACP bridge`,
        );
        return;
      }
      const modelPicker = decodeAcpModelPickerOptions(
        params.options.providerOptions,
      );
      const sessionParams = buildAcpSessionParams({
        additionalWorkspaceWriteRoots: decodeAdditionalWorkspaceWriteRoots(
          params.options.providerOptions,
        ),
        dialectId: decodeDialectId(params.options.providerOptions),
        cwd: params.cwd,
        dynamicTools: params.dynamicTools,
        options: {
          ...params.options,
          skillRoots: configuredSkillRoots ?? undefined,
        },
        parameterizedModelPicker: modelPicker.parameterizedModelPicker,
        launchSpec,
        providerLabel: launchSpec.displayName,
        threadId: params.threadId,
      });
      const session = await startAgentSession(
        request.method === "thread/resume"
          ? {
              kind: "resume",
              params: sessionParams,
              resumeProviderThreadId: request.params.providerThreadId,
            }
          : request.method === "thread/fork"
            ? {
                kind: "fork",
                params: sessionParams,
                sourceProviderThreadId: request.params.sourceProviderThreadId,
              }
            : { kind: "start", params: sessionParams },
      );
      sendResult(request.id, {
        providerThreadId: session.providerThreadId,
        sessionRestorable: session.supportsLoadSession,
      });
      return;
    }

    case "turn/start": {
      const params = request.params;
      const session = liveSessionForThread(params.threadId);
      if (session === undefined) {
        sendError(request.id, -32000, "No active ACP session");
        return;
      }
      if (session.activePromptKind !== null) {
        sendError(request.id, -32000, "A turn is already active");
        return;
      }
      const pending: AcpPendingTurnInput = {
        clientRequestId: params.clientRequestId,
        input: params.input,
        requestId: request.id,
      };
      if (isStandaloneBuiltinCompactCommand(params.input)) {
        startCompaction(session, pending);
      } else {
        runTurn(session, pending);
      }
      return;
    }

    case "turn/steer": {
      const params = request.params;
      const session = liveSessionForThread(params.threadId);
      if (session === undefined) {
        sendError(request.id, -32000, "No active ACP session");
        return;
      }
      if (session.activePromptKind !== "turn") {
        const message = "No active turn to steer";
        sendError(request.id, ACP_BRIDGE_NO_ACTIVE_TURN_ERROR_CODE, message, {
          recovery: { kind: "staleTurn", message, retryable: false },
        });
        return;
      }
      session.queuedInputs.push({
        clientRequestId: params.clientRequestId,
        input: params.input,
        requestId: null,
      });
      requestSteerCancel(session);
      sendResult(request.id, { threadId: params.threadId });
      return;
    }

    case "thread/stop": {
      const session = sessionsByBbThreadId.get(request.params.threadId);
      if (session) {
        if (request.params.intent === "release") {
          await releaseSession(session);
        } else {
          await stopSession(session);
        }
      }
      sendResult(request.id, { ok: true });
      return;
    }

    case "thread/discard":
      sendResult(request.id, { ok: true });
      return;

    case "skills/configure":
      configuredSkillRoots = request.params.roots.map((root) => ({
        id: root.id,
        skillDirectoryRootPath: root.path,
        skills: root.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
        })),
      }));
      sendResult(request.id, { ok: true });
      return;
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

  const decoded = decodeAcpBridgeJsonRpcRequest(parsed);
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
  runBridgeRequest({
    request: decoded.request,
    handleRequest: (request) =>
      handleRequest(request).catch((error: unknown) => {
        throw withAcpAuthRequiredRecovery(error);
      }),
    sendError,
  });
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

async function stopAllSessions(): Promise<void> {
  await Promise.all(
    Array.from(sessionsByBbThreadId.values()).map((session) =>
      stopSession(session),
    ),
  );
  const dynamicToolBridge = dynamicToolBridgePromise
    ? await dynamicToolBridgePromise.catch(() => null)
    : null;
  await new Promise<void>((resolveClose) => {
    if (!dynamicToolBridge) {
      resolveClose();
      return;
    }
    dynamicToolBridge.server.close(() => resolveClose());
  });
}

if (process.argv.includes("--mcp-stdio")) {
  runAcpDynamicToolMcpServer();
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  onClose: () => {
    void stopAllSessions().finally(() => {
      process.exit(0);
    });
  },
});
