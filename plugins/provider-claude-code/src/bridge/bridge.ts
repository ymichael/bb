#!/usr/bin/env node

import {
  type PendingInteractionGrantedPermissionProfile,
  type PendingInteractionPayload,
  type PermissionEscalation,
  type ReasoningLevel,
  type ThreadDelta,
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  threadStartParamsSchema as canonicalThreadStartParamsSchema,
  turnStartParamsSchema as canonicalTurnStartParamsSchema,
  turnSteerParamsSchema as canonicalTurnSteerParamsSchema,
  type InitializeResult,
  createBridgeIo,
  createBridgeLineHandler,
  createPendingToolCallTracker,
  decodeBridgeJsonRpcResponse,
  runBridgeRequest,
  shouldAutoDenyInteractiveRequest,
  withoutBridgeRuntimeEnv,
  type BridgeToolCallRequest,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  forkSession,
  type CanUseTool,
  type HookCallback,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createClaudeDeltaTranslator,
  type ClaudeDeltaTranslator,
} from "../delta-translation.js";
import {
  buildClaudeApprovalInteractionPayload,
  buildClaudeInteractiveResponse,
  claudeInteractionOutcomeSchema,
  buildClaudeUserQuestionPayload,
} from "../interactions.js";
import {
  buildClaudeSessionParams,
  buildClaudeTurnParams,
  type ClaudeCodeSkillRoot,
} from "../session-params.js";
import { SdkSession, type SdkSessionOptions } from "./sdk-session.js";
import { createClaudeCodeBridgeModelListMemo } from "./model-list.js";
import {
  claudeThreadForkParamsSchema,
  claudeThreadResumeParamsSchema,
  claudeThreadStartParamsSchema,
  claudeTurnStartParamsSchema,
  claudeTurnSteerParamsSchema,
  decodeClaudeCodeJsonRpcRequest,
  type ClaudeCodeJsonRpcRequest,
  type ThreadForkParams,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadStopParams,
  type TurnStartParams,
  type TurnSteerParams,
} from "./commands.js";
import {
  getClaudeProviderHealth,
  getClaudeProviderInstallationRun,
  getClaudeProviderInstallationStatus,
  getClaudeProviderUsage,
} from "./provider-maintenance.js";
import {
  buildChromeExtraArgs,
  buildReadonlyDenialMessage,
  buildMutableFlagSettings,
  buildSessionOptions,
  buildWorkspaceWriteDenialMessage,
  toSdkEffort,
  type BuildSessionOptionsArgs,
  type PermissionEscalationWorkContext,
} from "./session-options.js";
import {
  createClaudeSkillPluginsRoot,
  ensureClaudeSkillPlugin,
} from "./skill-plugins.js";
import { buildReadonlyBashUpdatedInput } from "./readonly-bash-policy.js";
import {
  buildBridgeMcpServer,
  getAllowedToolNames,
  BRIDGE_MCP_SERVER_NAME,
  type ToolCallForwarder,
} from "./tool-proxy-mcp.js";
import {
  type ClaudeInteractiveResponse,
  type ClaudePermissionMode,
  type ClaudePermissionRequestApprovalParams,
  type ClaudeSuggestedPermissionUpdate,
  type ClaudeUserQuestionInput,
  type ClaudeUserQuestionRequestParams,
  CLAUDE_EXIT_PLAN_MODE_TOOL_NAME,
  CLAUDE_USER_QUESTION_TOOL_NAME,
  claudeExitPlanModeInputSchema,
  claudeSuggestedPermissionUpdateSchema,
  claudeUserQuestionInputSchema,
  shouldRequestClaudePermissionApproval,
  toPendingInteractionPermissionProfile,
} from "../interactive-contract.js";

const promptInputItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("image"),
    url: z.string(),
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
  }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    sizeBytes: z.number().optional(),
    mimeType: z.string().optional(),
  }),
]);

const CLAUDE_PROVIDER_SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const CLAUDE_WORKFLOW_TOOL_NAME = "Workflow";

interface SdkMessageNotification {
  jsonrpc: "2.0";
  method: "sdk/message";
  params: { threadId: string; message: SDKMessage };
}

interface BridgeEventNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface ThreadIdRef {
  current: string;
}

interface CurrentThreadSessionArgs {
  sessionSerial: number;
  threadId: string;
}

interface CreateSdkCallbackArgs {
  sessionSerial: number;
  threadIdRef: ThreadIdRef;
}

interface PendingInteractiveRequestBase {
  itemId: string;
  resolve: (value: PermissionResult) => void;
  payload: PendingInteractionPayload;
}

interface PendingPermissionRequest extends PendingInteractiveRequestBase {
  kind: "permission_request";
  originalInput: Record<string, unknown>;
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string;
}

interface PendingUserQuestionRequest extends PendingInteractiveRequestBase {
  kind: "user_question";
}

type PendingInteractiveRequest =
  | PendingPermissionRequest
  | PendingUserQuestionRequest;

interface ClaudeSessionPermissionGrant {
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string | null;
}

interface ClaudeSessionPermissionCoverageArgs {
  grants: ClaudeSessionPermissionGrant[];
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string;
}

interface ClaudeSessionPermissionGrantCoverageArgs {
  grant: ClaudeSessionPermissionGrant;
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string;
}

type ClaudeSdkSessionState = Extract<
  SDKMessage,
  { type: "system"; subtype: "session_state_changed" }
>["state"];

interface ClaudeSessionRestart {
  reason: string;
  showRuntimeNote: boolean;
}

interface ThreadSession {
  session: SdkSession;
  attachment: ThreadAttachment;
  sessionSerial: number;
  closing: boolean;
  pendingForwardedToolCalls: number;
  pendingSessionCronIds: Set<string>;
  restartBeforeNextTurn: ClaudeSessionRestart | null;
  recoveryHintRaisedThisTurn: "authRequired" | "rateLimited" | null;
  sdkSessionState: ClaudeSdkSessionState | undefined;
  streamEnded: boolean;
  translator: ClaudeDeltaTranslator;
  pendingInteractiveRequests: Map<string | number, PendingInteractiveRequest>;
  permissionEscalationByAgentId: Map<string, PermissionEscalation | null>;
  permissionEscalationByPromptId: Map<string, PermissionEscalation | null>;
  permissionEscalationBySubagentParentToolUseId: Map<
    string,
    PermissionEscalation | null
  >;
  permissionEscalationByToolUseId: Map<string, PermissionEscalation | null>;
}

interface ThreadAttachment {
  envSignature: string;
  sessionConstructionConfig: SessionConstructionConfig;
  sessionOptions: SdkSessionOptions;
  closing: boolean;
  residentSession: ThreadSession | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  residencyGeneration: number;
  wakePromise: Promise<ThreadSession | undefined> | null;
  idleQueryReleaseEnabled: boolean;
  permissionEscalation: PermissionEscalation | null;
  permissionMode: ClaudePermissionMode;
  liveSettings: ClaudeLiveSessionSettings;
  approvedPlanPermissionMode: ClaudePermissionMode;
  providerThreadId?: string;
  sessionPermissionGrants: ClaudeSessionPermissionGrant[];
  threadIdRef: ThreadIdRef;
}

interface CreateThreadAttachmentArgs {
  permissionEscalation: PermissionEscalation | null;
  permissionMode: ClaudePermissionMode;
  liveSettings: ClaudeLiveSessionSettings;
  idleQueryReleaseEnabled: boolean;
  approvedPlanPermissionMode: ClaudePermissionMode;
  providerThreadId?: string;
  sessionConstructionConfig: SessionConstructionConfig;
  sessionOptions: SdkSessionOptions;
  sessionPermissionGrants?: ClaudeSessionPermissionGrant[];
  threadIdRef: ThreadIdRef;
}

type CanonicalTurnStartParams = z.infer<typeof canonicalTurnStartParamsSchema>;
type CanonicalTurnSteerParams = z.infer<typeof canonicalTurnSteerParamsSchema>;

interface CanonicalTurnAcceptance {
  clientRequestId: CanonicalTurnStartParams["clientRequestId"];
  providerThreadId: string;
}

interface SessionConstructionConfig {
  config: ThreadResumeParams["config"];
  dynamicTools: ThreadResumeParams["dynamicTools"];
  sessionOptions: Omit<
    BuildSessionOptionsArgs,
    | "getPermissionEscalation"
    | "memoryEnabled"
    | "model"
    | "reasoningLevel"
    | "workflowsEnabled"
  >;
}

interface ClaudeLiveSessionSettings {
  memoryEnabled: boolean;
  model?: string;
  providerSubagentsEnabled: boolean;
  reasoningLevel?: ReasoningLevel;
  workflowsEnabled: boolean;
}

type SessionConstructionParams =
  | ThreadStartParams
  | ThreadResumeParams
  | ThreadForkParams;

interface ReplaceThreadSessionArgs {
  attachment: ThreadAttachment;
  providerThreadId: string;
  restart: ClaudeSessionRestart;
  threadId: string;
  threadSession: ThreadSession;
}

interface ReplaceThreadSessionBeforeNextTurnArgs {
  attachment: ThreadAttachment;
  restart: ClaudeSessionRestart;
  threadId: string;
  threadSession: ThreadSession;
}

interface ClaudeCodeThreadStopResult {
  ok: true;
}

interface ClaudeCanUseToolDecisionContext {
  blockedPath: string | undefined;
  decisionReason: string | undefined;
  suggestions: ClaudeSuggestedPermissionUpdate[] | undefined;
  toolName: string;
}

interface BuildInteractiveRequestParamsArgs {
  providerThreadId: string;
  threadId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  decisionReason: string | undefined;
  promptText: string | undefined;
  blockedPath: string | undefined;
  suggestions: ClaudeSuggestedPermissionUpdate[] | undefined;
}

interface ForwardInteractiveRequestArgs extends BuildInteractiveRequestParamsArgs {
  signal: AbortSignal;
}

interface BuildUserQuestionRequestParamsArgs {
  input: ClaudeUserQuestionInput;
  providerThreadId: string;
  threadId: string;
  toolUseId: string;
}

interface ForwardUserQuestionRequestArgs extends BuildUserQuestionRequestParamsArgs {
  signal: AbortSignal;
}

let sessionSerialCounter = 0;
let interactiveRequestIdCounter = 0;

function nextInteractiveRequestId(): string {
  interactiveRequestIdCounter += 1;
  return `interaction-${interactiveRequestIdCounter}`;
}
let configuredSkillRoots: ClaudeCodeSkillRoot[] | null = null;
let skillPluginsRoot: string | null = null;
let bridgeTempDir: string | null = null;

function assembleSkillPlugins(
  roots: readonly { id: string; path: string }[],
): ClaudeCodeSkillRoot[] {
  const takenNames = new Map<string, string>();
  const assembled: ClaudeCodeSkillRoot[] = [];
  for (const root of roots) {
    try {
      assembled.push({
        id: root.id,
        localPluginPath: ensureClaudeSkillPlugin({
          pluginsRoot: requireSkillPluginsRoot(),
          root: { id: root.id, path: root.path },
          takenNames,
        }),
      });
    } catch (error) {
      process.stderr.write(
        `claude bridge: skipping injected skill root "${root.id}": could not assemble its plugin: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return assembled;
}

function requireSkillPluginsRoot(): string {
  if (skillPluginsRoot === null) {
    skillPluginsRoot = createClaudeSkillPluginsRoot(
      bridgeTempDir === null ? undefined : joinPath(bridgeTempDir, "skills"),
    );
  }
  return skillPluginsRoot;
}

const THREAD_STOP_CLOSE_TIMEOUT_MS = 4_000;
export const CLAUDE_IDLE_QUERY_GRACE_MS = 30_000;
const CLAUDE_CHROME_SETTING_RESTART_REASON = "Claude in Chrome setting changed";

const { send, sendResult, sendError } = createBridgeIo<
  SdkMessageNotification | BridgeEventNotification | BridgeToolCallRequest
>();

const threadAttachments = new Map<string, ThreadAttachment>();
const closingSessions = new Map<string, Promise<void>>();
const toolCallTracker = createPendingToolCallTracker({ sendToolCall: send });
const { forwardToolCall, handleToolCallResponse } = toolCallTracker;

function resolvePendingSessionWork(
  threadSession: ThreadSession,
  message: string,
): void {
  toolCallTracker.resolvePendingToolCalls(threadSession, message);
  resolvePendingInteractiveRequests(threadSession, message);
}

function cancelIdleQueryRelease(attachment: ThreadAttachment): void {
  attachment.residencyGeneration += 1;
  if (attachment.idleTimer !== null) {
    clearTimeout(attachment.idleTimer);
    attachment.idleTimer = null;
  }
}

function isThreadSessionQuiescent(
  threadSession: ThreadSession,
  threadId: string,
): boolean {
  return (
    !threadSession.translator.hasOpenSessionWork(threadId) &&
    threadSession.pendingForwardedToolCalls === 0 &&
    threadSession.pendingInteractiveRequests.size === 0 &&
    threadSession.pendingSessionCronIds.size === 0 &&
    (threadSession.sdkSessionState === undefined ||
      threadSession.sdkSessionState === "idle")
  );
}

function scheduleIdleQueryRelease(
  threadSession: ThreadSession,
  threadId: string,
): void {
  const attachment = threadSession.attachment;
  if (
    attachment.closing ||
    threadSession.closing ||
    attachment.residentSession !== threadSession
  ) {
    return;
  }
  if (!attachment.idleQueryReleaseEnabled) {
    cancelIdleQueryRelease(attachment);
    return;
  }
  cancelIdleQueryRelease(attachment);
  const generation = attachment.residencyGeneration;
  attachment.idleTimer = setTimeout(() => {
    attachment.idleTimer = null;
    if (
      attachment.closing ||
      attachment.residencyGeneration !== generation ||
      threadAttachments.get(threadId) !== attachment ||
      attachment.residentSession !== threadSession ||
      threadSession.closing
    ) {
      return;
    }
    if (!isThreadSessionQuiescent(threadSession, threadId)) {
      scheduleIdleQueryRelease(threadSession, threadId);
      return;
    }
    threadSession.closing = true;
    attachment.residentSession = null;
    attachment.residencyGeneration += 1;
    threadSession.session.stop();
  }, CLAUDE_IDLE_QUERY_GRACE_MS);
}

function refreshIdleQueryRelease(
  threadSession: ThreadSession,
  threadId: string,
): void {
  if (threadSession.attachment.idleTimer !== null) {
    scheduleIdleQueryRelease(threadSession, threadId);
  }
}

function applyIdleQueryReleaseSetting(
  attachment: ThreadAttachment,
  enabled: boolean | undefined,
): void {
  if (enabled === undefined || attachment.idleQueryReleaseEnabled === enabled) {
    return;
  }
  attachment.idleQueryReleaseEnabled = enabled;
  if (!enabled) {
    cancelIdleQueryRelease(attachment);
  }
}

function applyChromeSetting(
  attachment: ThreadAttachment,
  enabled: boolean | undefined,
): void {
  const sessionOptions = attachment.sessionConstructionConfig.sessionOptions;
  if (enabled === undefined || sessionOptions.chromeEnabled === enabled) {
    return;
  }
  sessionOptions.chromeEnabled = enabled;
  const extraArgs = buildChromeExtraArgs(enabled);
  if (extraArgs) {
    attachment.sessionOptions.extraArgs = extraArgs;
  } else {
    delete attachment.sessionOptions.extraArgs;
  }
  if (attachment.residentSession) {
    attachment.residentSession.restartBeforeNextTurn = {
      reason: CLAUDE_CHROME_SETTING_RESTART_REASON,
      showRuntimeNote: false,
    };
  }
}

function createForwardToolCall(getThreadId: () => string): ToolCallForwarder {
  return (toolName, args) => {
    const threadId = getThreadId();
    const attachment = threadAttachments.get(threadId);
    const threadSession = attachment?.residentSession;
    if (
      !attachment ||
      attachment.closing ||
      !threadSession ||
      threadSession.closing
    ) {
      return Promise.resolve({
        content: "Thread session not found",
        isError: true,
      });
    }
    threadSession.pendingForwardedToolCalls += 1;
    return forwardToolCall({
      arguments: args,
      providerThreadId: attachment.providerThreadId ?? threadId,
      scope: threadSession,
      threadId,
      toolName,
    }).finally(() => {
      threadSession.pendingForwardedToolCalls -= 1;
      refreshIdleQueryRelease(threadSession, threadId);
    });
  };
}

async function closeThreadSession(args: {
  graceful?: boolean;
  message: string;
  threadId: string;
}): Promise<void> {
  const existingClose = closingSessions.get(args.threadId);
  if (existingClose) {
    return existingClose;
  }

  const attachment = threadAttachments.get(args.threadId);
  if (!attachment) {
    return;
  }

  attachment.closing = true;
  cancelIdleQueryRelease(attachment);
  const threadSession = attachment.residentSession;
  if (threadSession) {
    threadSession.closing = true;
    resolvePendingSessionWork(threadSession, args.message);
  }
  const closePromise = Promise.resolve()
    .then(async () => {
      await attachment.wakePromise;
      const residentSession = attachment.residentSession;
      if (residentSession) {
        residentSession.closing = true;
        resolvePendingSessionWork(residentSession, args.message);
        await closeClaudeThreadSession(
          residentSession,
          args.graceful !== false,
        );
      }
    })
    .finally(() => {
      if (threadAttachments.get(args.threadId) === attachment) {
        threadAttachments.delete(args.threadId);
      }
      closingSessions.delete(args.threadId);
    });
  closingSessions.set(args.threadId, closePromise);
  return closePromise;
}

async function closeThreadSessionsGracefully(message: string): Promise<void> {
  await Promise.all(
    Array.from(threadAttachments.keys()).map((threadId) =>
      closeThreadSession({ graceful: true, message, threadId }),
    ),
  );
}

function permissionPathCovers(
  grantPath: string,
  requestedPath: string,
): boolean {
  const normalizedGrantPath = resolvePath(grantPath);
  const normalizedRequestedPath = resolvePath(requestedPath);
  if (normalizedGrantPath === normalizedRequestedPath) {
    return true;
  }
  const grantPrefix = normalizedGrantPath.endsWith("/")
    ? normalizedGrantPath
    : `${normalizedGrantPath}/`;
  return normalizedRequestedPath.startsWith(grantPrefix);
}

function permissionPathListCovers(
  grantedPaths: string[],
  requestedPaths: string[],
): boolean {
  return requestedPaths.every((requestedPath) =>
    grantedPaths.some((grantedPath) =>
      permissionPathCovers(grantedPath, requestedPath),
    ),
  );
}

function fileSystemPermissionsCover(
  granted: PendingInteractionGrantedPermissionProfile["fileSystem"],
  requested: PendingInteractionGrantedPermissionProfile["fileSystem"],
): boolean {
  if (requested === null) {
    return true;
  }
  if (granted === null) {
    return false;
  }
  const grantedReadPaths = [...granted.read, ...granted.write];
  return (
    permissionPathListCovers(grantedReadPaths, requested.read) &&
    permissionPathListCovers(granted.write, requested.write)
  );
}

function networkPermissionsCover(
  granted: PendingInteractionGrantedPermissionProfile["network"],
  requested: PendingInteractionGrantedPermissionProfile["network"],
): boolean {
  return requested?.enabled === true ? granted?.enabled === true : true;
}

function sessionPermissionGrantCovers(
  args: ClaudeSessionPermissionGrantCoverageArgs,
): boolean {
  if (args.grant.toolName !== null && args.grant.toolName !== args.toolName) {
    return false;
  }
  return (
    networkPermissionsCover(
      args.grant.permissions.network,
      args.permissions.network,
    ) &&
    fileSystemPermissionsCover(
      args.grant.permissions.fileSystem,
      args.permissions.fileSystem,
    )
  );
}

function hasClaudeSessionPermissionGrant(
  args: ClaudeSessionPermissionCoverageArgs,
): boolean {
  return args.grants.some((grant) =>
    sessionPermissionGrantCovers({
      grant,
      permissions: args.permissions,
      toolName: args.toolName,
    }),
  );
}

function shouldCacheClaudeSessionPermission(
  response: ClaudeInteractiveResponse,
): boolean {
  return (
    response.kind === "permission_request" &&
    response.behavior === "allow" &&
    (response.decisionClassification === "user_permanent" ||
      response.updatedPermissions !== undefined)
  );
}

function logBridgeError(message: string): void {
  process.stderr.write(`claude-code bridge: ${message}\n`);
}

function pushPromptInput(
  threadSession: ThreadSession,
  input: string,
  permissionEscalation: PermissionEscalation | null,
): Promise<void> {
  const promptId = randomUUID();
  threadSession.permissionEscalationByPromptId.set(
    promptId,
    permissionEscalation,
  );
  return threadSession.session.pushInput(input, promptId).catch((error) => {
    threadSession.permissionEscalationByPromptId.delete(promptId);
    throw error;
  });
}

async function applyLiveSessionSettings(
  threadSession: ThreadSession,
  threadId: string,
  next: ClaudeLiveSessionSettings,
): Promise<void> {
  const current = threadSession.attachment.liveSettings;
  if (current.model !== next.model) {
    await threadSession.session.setModel(next.model);
    seedModelContextWindowHint(threadSession, threadId, next.model);
  }

  if (
    current.memoryEnabled !== next.memoryEnabled ||
    current.reasoningLevel !== next.reasoningLevel ||
    current.workflowsEnabled !== next.workflowsEnabled
  ) {
    await threadSession.session.applyMutableSettings({
      effort:
        next.reasoningLevel === undefined
          ? undefined
          : toSdkEffort(next.reasoningLevel),
      settings: buildMutableFlagSettings({
        memoryEnabled: next.memoryEnabled,
        reasoningLevel: next.reasoningLevel,
        workflowsEnabled: next.workflowsEnabled,
      }),
    });
  }

  threadSession.attachment.liveSettings = next;
}

function applyDormantLiveSessionSettings(
  attachment: ThreadAttachment,
  next: ClaudeLiveSessionSettings,
): void {
  attachment.sessionOptions.model = next.model;
  attachment.sessionOptions.effort =
    next.reasoningLevel === undefined
      ? undefined
      : toSdkEffort(next.reasoningLevel);
  const mutableSettings = buildMutableFlagSettings({
    memoryEnabled: next.memoryEnabled,
    reasoningLevel: next.reasoningLevel,
    workflowsEnabled: next.workflowsEnabled,
  });
  const { effortLevel: _effortLevel, ...sessionSettings } = mutableSettings;
  const currentSettings =
    typeof attachment.sessionOptions.settings === "object"
      ? attachment.sessionOptions.settings
      : {};
  attachment.sessionOptions.settings = {
    ...currentSettings,
    ...sessionSettings,
  };
  attachment.liveSettings = next;
}

const MODEL_LIST_MEMO_TTL_MS = 2 * 60_000;
const listModelsMemoized = createClaudeCodeBridgeModelListMemo({
  ttlMs: MODEL_LIST_MEMO_TTL_MS,
});

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

function sendSessionReset(threadId: string): void {
  sendThreadDeltas(threadId, [{ kind: "session.reset" }]);
}

function emitForSession(
  threadSession: ThreadSession,
  threadId: string,
  method: string,
  params: Record<string, unknown>,
): void {
  const deltas = threadSession.translator.translate(
    { jsonrpc: "2.0", method, params },
    { threadId },
  );
  sendThreadDeltas(threadId, deltas);
  for (const delta of deltas) {
    if (delta.kind === "provider.error" && delta.willRetry !== true) {
      const category = delta.errorInfo?.category;
      const kind =
        category === "unauthorized"
          ? "authRequired"
          : category === "rate-limit"
            ? "rateLimited"
            : null;
      if (kind !== null) {
        emitTerminalAccountErrorHint(
          threadSession,
          threadId,
          kind,
          delta.detail ?? delta.message,
        );
      }
    }
    if (delta.kind === "turn.boundary" || delta.kind === "session.reset") {
      threadSession.recoveryHintRaisedThisTurn = null;
    }
    if (delta.kind === "turn.boundary") {
      scheduleIdleQueryRelease(threadSession, threadId);
    }
  }
}

function emitTerminalAccountErrorHint(
  threadSession: ThreadSession,
  threadId: string,
  kind: "authRequired" | "rateLimited",
  message: string,
): void {
  if (threadSession.recoveryHintRaisedThisTurn === kind) {
    return;
  }
  threadSession.recoveryHintRaisedThisTurn = kind;
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.providerRecovery,
    params: {
      threadId,
      kind,
      message,
      retryable: false,
    },
  });
}

function getAssistantMessageErrorText(message: SDKMessage): string {
  if (message.type === "assistant") {
    const text = message.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
    return `Claude reported ${message.error ?? "an account error"}`;
  }
  return "Claude reported an account error";
}

function getAssistantMessageRecoveryKind(
  message: SDKMessage,
): "authRequired" | "rateLimited" | null {
  if (message.type !== "assistant") {
    return null;
  }
  switch (message.error) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "authRequired";
    case "rate_limit":
      return "rateLimited";
    default:
      return null;
  }
}

function emitSessionError(
  threadSession: ThreadSession,
  threadId: string,
  message: string,
): void {
  if (threadSession.translator.hasOpenTurn(threadId)) {
    emitForSession(threadSession, threadId, "error", { threadId, message });
  }
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.error,
    params: {
      threadId,
      providerThreadId: threadSession.attachment.providerThreadId ?? threadId,
      message,
    },
  });
}

function emitSessionReplacement(args: {
  contextLost: boolean;
  providerThreadId: string | null;
  reason: string;
  showRuntimeNote?: boolean;
  threadId: string;
  threadSession: ThreadSession;
}): void {
  sendThreadDeltas(
    args.threadId,
    args.threadSession.translator.buildSessionSettlementDeltas(args.threadId),
  );
  send({
    jsonrpc: "2.0",
    method: BRIDGE_NOTIFICATION_METHODS.sessionReplaced,
    params: {
      threadId: args.threadId,
      providerThreadId: args.providerThreadId,
      reason: args.reason,
      contextLost: args.contextLost,
      showRuntimeNote: args.showRuntimeNote ?? false,
    },
  });
}

function emitCanonicalTurnInputAccepted(
  threadSession: ThreadSession,
  acceptance: CanonicalTurnAcceptance,
  threadId: string,
): void {
  sendThreadDeltas(
    threadId,
    threadSession.translator.acceptInput(threadId, acceptance.clientRequestId),
  );
}

function sendThreadIdentity(threadId: string, providerThreadId: string): void {
  send({
    jsonrpc: "2.0",
    method: "thread/identity",
    params: {
      threadId,
      providerThreadId,
      sessionRestorable: true,
    },
  });
}

function nextSessionSerial(): number {
  sessionSerialCounter += 1;
  return sessionSerialCounter;
}

function toSessionConstructionConfig(
  params: SessionConstructionParams,
): SessionConstructionConfig {
  return {
    config: params.config,
    dynamicTools: params.dynamicTools,
    sessionOptions: {
      additionalWorkspaceWriteRoots: params.additionalWorkspaceWriteRoots,
      baseInstructions: params.baseInstructions,
      chromeEnabled: params.chromeEnabled,
      cwd: params.cwd,
      disallowedTools: params.disallowedTools,
      instructionMode: params.instructionMode,
      permissionMode: params.permissionMode,
      permissionScope: params.permissionScope,
      plugins: params.plugins,
    },
  };
}

function toInitialLiveSessionSettings(
  params: SessionConstructionParams,
): ClaudeLiveSessionSettings {
  return {
    memoryEnabled: params.memoryEnabled ?? true,
    ...(params.model !== undefined ? { model: params.model } : {}),
    providerSubagentsEnabled: params.providerSubagentsEnabled ?? true,
    ...(params.reasoningLevel !== undefined
      ? { reasoningLevel: params.reasoningLevel }
      : {}),
    workflowsEnabled: params.workflowsEnabled,
  };
}

function withTurnLiveSessionSettings(
  current: ClaudeLiveSessionSettings,
  params: TurnStartParams | TurnSteerParams,
): ClaudeLiveSessionSettings {
  const model = params.model ?? current.model;
  const reasoningLevel = params.reasoningLevel ?? current.reasoningLevel;
  return {
    memoryEnabled: params.memoryEnabled ?? current.memoryEnabled,
    ...(model !== undefined ? { model } : {}),
    providerSubagentsEnabled:
      params.providerSubagentsEnabled ?? current.providerSubagentsEnabled,
    ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
    workflowsEnabled: params.workflowsEnabled ?? current.workflowsEnabled,
  };
}

function withTrackedPermissionEscalation(
  params: SessionConstructionParams,
  threadIdRef: ThreadIdRef,
): BuildSessionOptionsArgs {
  return {
    ...toSessionConstructionConfig(params).sessionOptions,
    ...toInitialLiveSessionSettings(params),
    getPermissionEscalation: (context) => {
      const threadSession = threadAttachments.get(
        threadIdRef.current,
      )?.residentSession;
      return threadSession
        ? resolvePermissionEscalationForWork(threadSession, context)
        : null;
    },
  };
}

function seedModelContextWindowHint(
  threadSession: ThreadSession,
  threadId: string,
  model: string | undefined,
): void {
  if (model === undefined) {
    return;
  }
  threadSession.translator.setClaudeModelContextWindowHint(threadId, model);
}

function createThreadAttachment(
  args: CreateThreadAttachmentArgs,
): ThreadAttachment {
  const attachment: ThreadAttachment = {
    envSignature: environmentSignature(
      readConfigEnvOverrides(args.sessionConstructionConfig.config),
    ),
    sessionConstructionConfig: args.sessionConstructionConfig,
    sessionOptions: args.sessionOptions,
    closing: false,
    residentSession: null,
    idleTimer: null,
    residencyGeneration: 0,
    wakePromise: null,
    idleQueryReleaseEnabled: args.idleQueryReleaseEnabled,
    permissionEscalation: args.permissionEscalation,
    permissionMode: args.permissionMode,
    liveSettings: args.liveSettings,
    approvedPlanPermissionMode: args.approvedPlanPermissionMode,
    ...(args.providerThreadId
      ? { providerThreadId: args.providerThreadId }
      : {}),
    sessionPermissionGrants: [...(args.sessionPermissionGrants ?? [])],
    threadIdRef: args.threadIdRef,
  };
  attachment.residentSession = createThreadSession(attachment);
  return attachment;
}

function createThreadSession(attachment: ThreadAttachment): ThreadSession {
  const sessionSerial = nextSessionSerial();
  const session = new SdkSession(
    attachment.sessionOptions,
    createOnSdkMessage({
      sessionSerial,
      threadIdRef: attachment.threadIdRef,
    }),
    createOnSdkDone({
      sessionSerial,
      threadIdRef: attachment.threadIdRef,
    }),
  );

  const translator = createClaudeDeltaTranslator({
    cwd: attachment.sessionConstructionConfig.sessionOptions.cwd,
    sandboxEnabled: attachment.sessionOptions.sandbox?.enabled === true,
  });
  translator.configureInjectedTools(
    (attachment.sessionConstructionConfig.dynamicTools ?? []).map((tool) => ({
      name: tool.name,
      ...(tool.presentation === undefined
        ? {}
        : { presentation: tool.presentation }),
    })),
  );
  const threadSession: ThreadSession = {
    session,
    attachment,
    sessionSerial,
    closing: false,
    pendingForwardedToolCalls: 0,
    pendingSessionCronIds: new Set(),
    restartBeforeNextTurn: null,
    recoveryHintRaisedThisTurn: null,
    sdkSessionState: undefined,
    streamEnded: false,
    translator,
    pendingInteractiveRequests: new Map(),
    permissionEscalationByAgentId: new Map(),
    permissionEscalationByPromptId: new Map(),
    permissionEscalationBySubagentParentToolUseId: new Map(),
    permissionEscalationByToolUseId: new Map(),
  };
  seedModelContextWindowHint(
    threadSession,
    attachment.threadIdRef.current,
    attachment.liveSettings.model,
  );
  return threadSession;
}

function startResidentThreadSession(
  attachment: ThreadAttachment,
  resumeProviderThreadId?: string,
): ThreadSession {
  const threadSession = attachment.residentSession;
  if (!threadSession) {
    throw new Error("Claude thread attachment has no resident session");
  }
  try {
    threadSession.session.start(resumeProviderThreadId);
  } catch (error) {
    threadSession.closing = true;
    attachment.residentSession = null;
    throw error;
  }
  return threadSession;
}

function startAttachedResidentThreadSession(
  attachment: ThreadAttachment,
  resumeProviderThreadId?: string,
): ThreadSession {
  const threadSession = startResidentThreadSession(
    attachment,
    resumeProviderThreadId,
  );
  scheduleIdleQueryRelease(threadSession, attachment.threadIdRef.current);
  return threadSession;
}

function getTrackedPermissionEscalation(
  values: Map<string, PermissionEscalation | null>,
  key: string | undefined,
): PermissionEscalation | null | undefined {
  if (key === undefined || !values.has(key)) {
    return undefined;
  }
  return values.get(key) ?? null;
}

function resolvePermissionEscalationForWork(
  threadSession: ThreadSession,
  context: PermissionEscalationWorkContext,
): PermissionEscalation | null {
  const toolPermissionEscalation = getTrackedPermissionEscalation(
    threadSession.permissionEscalationByToolUseId,
    context.toolUseId,
  );
  if (toolPermissionEscalation !== undefined) {
    return toolPermissionEscalation;
  }

  const agentPermissionEscalation = getTrackedPermissionEscalation(
    threadSession.permissionEscalationByAgentId,
    context.agentId,
  );
  if (agentPermissionEscalation !== undefined) {
    return agentPermissionEscalation;
  }

  const promptPermissionEscalation = getTrackedPermissionEscalation(
    threadSession.permissionEscalationByPromptId,
    context.promptId,
  );
  return promptPermissionEscalation === undefined
    ? threadSession.attachment.permissionEscalation
    : promptPermissionEscalation;
}

function trackSdkAssistantPermissionEscalation(
  threadSession: ThreadSession,
  message: SDKMessage,
): void {
  if (message.type !== "assistant") {
    return;
  }

  const parentToolUseId = message.parent_tool_use_id ?? undefined;
  const parentPermissionEscalation = getTrackedPermissionEscalation(
    threadSession.permissionEscalationBySubagentParentToolUseId,
    parentToolUseId,
  );
  const permissionEscalation =
    parentPermissionEscalation === undefined
      ? threadSession.attachment.permissionEscalation
      : parentPermissionEscalation;

  for (const content of message.message.content) {
    if (content.type !== "tool_use") {
      continue;
    }
    threadSession.permissionEscalationByToolUseId.set(
      content.id,
      permissionEscalation,
    );
    if (CLAUDE_PROVIDER_SUBAGENT_TOOL_NAMES.has(content.name)) {
      threadSession.permissionEscalationBySubagentParentToolUseId.set(
        content.id,
        permissionEscalation,
      );
    }
  }
}

function buildSessionTrackingHooks(
  threadIdRef: ThreadIdRef,
): NonNullable<SdkSessionOptions["hooks"]> {
  const trackPermissionRequest: HookCallback = async (input, toolUseId) => {
    if (
      input.hook_event_name !== "PermissionRequest" ||
      toolUseId === undefined
    ) {
      return { continue: true };
    }
    const threadSession = threadAttachments.get(
      threadIdRef.current,
    )?.residentSession;
    if (threadSession) {
      threadSession.permissionEscalationByToolUseId.set(
        toolUseId,
        resolvePermissionEscalationForWork(threadSession, {
          ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
          ...(input.prompt_id !== undefined
            ? { promptId: input.prompt_id }
            : {}),
        }),
      );
    }
    return { continue: true };
  };

  const trackPreToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") {
      return { continue: true };
    }
    const threadSession = threadAttachments.get(
      threadIdRef.current,
    )?.residentSession;
    if (threadSession) {
      const permissionEscalation = resolvePermissionEscalationForWork(
        threadSession,
        {
          ...(input.agent_id !== undefined ? { agentId: input.agent_id } : {}),
          ...(input.prompt_id !== undefined
            ? { promptId: input.prompt_id }
            : {}),
        },
      );
      threadSession.permissionEscalationByToolUseId.set(
        input.tool_use_id,
        permissionEscalation,
      );
      if (CLAUDE_PROVIDER_SUBAGENT_TOOL_NAMES.has(input.tool_name)) {
        threadSession.permissionEscalationBySubagentParentToolUseId.set(
          input.tool_use_id,
          permissionEscalation,
        );
      }
      if (
        !threadSession.attachment.liveSettings.providerSubagentsEnabled &&
        CLAUDE_PROVIDER_SUBAGENT_TOOL_NAMES.has(input.tool_name)
      ) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "bb has disabled Claude Code native subagents; use bb delegation instead.",
          },
        };
      }
      if (
        !threadSession.attachment.liveSettings.workflowsEnabled &&
        input.tool_name === CLAUDE_WORKFLOW_TOOL_NAME
      ) {
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "bb has disabled the Claude Code Workflow tool.",
          },
        };
      }
    }
    return { continue: true };
  };

  const trackSubagentStart: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStart") {
      return { continue: true };
    }
    const threadSession = threadAttachments.get(
      threadIdRef.current,
    )?.residentSession;
    if (threadSession) {
      threadSession.permissionEscalationByAgentId.set(
        input.agent_id,
        resolvePermissionEscalationForWork(threadSession, {
          ...(input.prompt_id !== undefined
            ? { promptId: input.prompt_id }
            : {}),
        }),
      );
    }
    return { continue: true };
  };

  const clearSubagent: HookCallback = async (input) => {
    if (input.hook_event_name === "SubagentStop") {
      threadAttachments
        .get(threadIdRef.current)
        ?.residentSession?.permissionEscalationByAgentId.delete(input.agent_id);
    }
    return { continue: true };
  };

  const clearToolUse: HookCallback = async (input) => {
    if (
      input.hook_event_name === "PostToolUse" ||
      input.hook_event_name === "PostToolUseFailure" ||
      input.hook_event_name === "PermissionDenied"
    ) {
      threadAttachments
        .get(threadIdRef.current)
        ?.residentSession?.permissionEscalationByToolUseId.delete(
          input.tool_use_id,
        );
    }
    return { continue: true };
  };

  const trackSessionCrons: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop" || input.session_crons === undefined) {
      return { continue: true };
    }
    const threadSession = threadAttachments.get(
      threadIdRef.current,
    )?.residentSession;
    if (threadSession) {
      threadSession.pendingSessionCronIds = new Set(
        input.session_crons.map((cron) => cron.id),
      );
      refreshIdleQueryRelease(threadSession, threadIdRef.current);
    }
    return { continue: true };
  };

  return {
    PermissionDenied: [{ hooks: [clearToolUse] }],
    PermissionRequest: [{ hooks: [trackPermissionRequest] }],
    PostToolUse: [{ hooks: [clearToolUse] }],
    PostToolUseFailure: [{ hooks: [clearToolUse] }],
    PreToolUse: [{ hooks: [trackPreToolUse] }],
    Stop: [{ hooks: [trackSessionCrons] }],
    SubagentStart: [{ hooks: [trackSubagentStart] }],
    SubagentStop: [{ hooks: [clearSubagent] }],
  };
}

function addSessionTrackingHooks(
  sessionOptions: SdkSessionOptions,
  threadIdRef: ThreadIdRef,
): void {
  const existingHooks = sessionOptions.hooks;
  const trackingHooks = buildSessionTrackingHooks(threadIdRef);
  sessionOptions.hooks = {
    ...existingHooks,
    PermissionDenied: [
      ...(trackingHooks.PermissionDenied ?? []),
      ...(existingHooks?.PermissionDenied ?? []),
    ],
    PermissionRequest: [
      ...(trackingHooks.PermissionRequest ?? []),
      ...(existingHooks?.PermissionRequest ?? []),
    ],
    PostToolUse: [
      ...(trackingHooks.PostToolUse ?? []),
      ...(existingHooks?.PostToolUse ?? []),
    ],
    PostToolUseFailure: [
      ...(trackingHooks.PostToolUseFailure ?? []),
      ...(existingHooks?.PostToolUseFailure ?? []),
    ],
    PreToolUse: [
      ...(trackingHooks.PreToolUse ?? []),
      ...(existingHooks?.PreToolUse ?? []),
    ],
    Stop: [...(trackingHooks.Stop ?? []), ...(existingHooks?.Stop ?? [])],
    SubagentStart: [
      ...(trackingHooks.SubagentStart ?? []),
      ...(existingHooks?.SubagentStart ?? []),
    ],
    SubagentStop: [
      ...(trackingHooks.SubagentStop ?? []),
      ...(existingHooks?.SubagentStop ?? []),
    ],
  };
}

function buildTrackedSessionOptions(
  params: SessionConstructionParams,
  env: NodeJS.ProcessEnv,
  threadIdRef: ThreadIdRef,
): SdkSessionOptions {
  const sessionOptions = buildSessionOptions(
    withTrackedPermissionEscalation(params, threadIdRef),
    env,
  );
  addSessionTrackingHooks(sessionOptions, threadIdRef);
  sessionOptions.recordThreadId = () => threadIdRef.current;
  return sessionOptions;
}

function replaceThreadSession(args: ReplaceThreadSessionArgs): ThreadSession {
  args.threadSession.closing = true;
  resolvePendingSessionWork(args.threadSession, args.restart.reason);
  emitSessionReplacement({
    contextLost: false,
    providerThreadId: args.providerThreadId,
    reason: args.restart.reason,
    showRuntimeNote: args.restart.showRuntimeNote,
    threadId: args.threadId,
    threadSession: args.threadSession,
  });
  args.threadSession.session.stop();

  const replacementSession = createThreadSession(args.attachment);
  args.attachment.residentSession = replacementSession;
  startResidentThreadSession(args.attachment, args.providerThreadId);
  sendThreadIdentity(args.threadId, args.providerThreadId);
  sendSessionReset(args.threadId);
  return replacementSession;
}

function replaceThreadSessionBeforeNextTurn(
  args: ReplaceThreadSessionBeforeNextTurnArgs,
): ThreadSession | undefined {
  const providerThreadId =
    args.attachment.providerThreadId ??
    args.threadSession.session.getSessionId();
  if (!providerThreadId) {
    return undefined;
  }

  args.attachment.providerThreadId = providerThreadId;
  return replaceThreadSession({
    attachment: args.attachment,
    providerThreadId,
    restart: args.restart,
    threadId: args.threadId,
    threadSession: args.threadSession,
  });
}

async function getWritableThreadSession(
  threadId: string,
  intent: "new-turn" | "steer",
): Promise<ThreadSession | undefined> {
  const attachment = threadAttachments.get(threadId);
  if (!attachment || attachment.closing) {
    return undefined;
  }
  cancelIdleQueryRelease(attachment);

  const existingWake = attachment.wakePromise;
  if (existingWake) {
    return existingWake;
  }

  const threadSession = attachment.residentSession;
  const replacement: ClaudeSessionRestart | null = !threadSession
    ? {
        reason: "Claude query resumed after idle release",
        showRuntimeNote: false,
      }
    : threadSession.streamEnded
      ? {
          reason: "Thread session replaced after Claude SDK stream ended",
          showRuntimeNote: false,
        }
      : intent === "new-turn"
        ? threadSession.restartBeforeNextTurn
        : null;
  if (threadSession && replacement === null) {
    return threadSession;
  }

  if (!threadSession && intent === "steer") {
    return undefined;
  }

  const wakePromise = Promise.resolve().then(() => {
    if (attachment.closing || threadAttachments.get(threadId) !== attachment) {
      return undefined;
    }

    const currentSession = attachment.residentSession;
    if (currentSession) {
      const currentRestart: ClaudeSessionRestart | null =
        currentSession.streamEnded
          ? {
              reason: "Thread session replaced after Claude SDK stream ended",
              showRuntimeNote: false,
            }
          : intent === "new-turn"
            ? currentSession.restartBeforeNextTurn
            : null;
      return currentRestart === null
        ? currentSession
        : replaceThreadSessionBeforeNextTurn({
            attachment,
            restart: currentRestart,
            threadId,
            threadSession: currentSession,
          });
    }

    const providerThreadId = attachment.providerThreadId;
    if (!providerThreadId) {
      return undefined;
    }
    const replacementSession = createThreadSession(attachment);
    attachment.residentSession = replacementSession;
    startResidentThreadSession(attachment, providerThreadId);
    send({
      jsonrpc: "2.0",
      method: BRIDGE_NOTIFICATION_METHODS.sessionReplaced,
      params: {
        threadId,
        providerThreadId,
        reason: "Claude query resumed after idle release",
        contextLost: false,
      },
    });
    sendThreadIdentity(threadId, providerThreadId);
    sendSessionReset(threadId);
    return replacementSession;
  });
  attachment.wakePromise = wakePromise;
  try {
    return await wakePromise;
  } finally {
    if (attachment.wakePromise === wakePromise) {
      attachment.wakePromise = null;
    }
  }
}

function getAuthenticationFailureRestartReason(
  message: SDKMessage,
): string | null {
  if (message.type !== "assistant") {
    return null;
  }
  switch (message.error) {
    case "authentication_failed":
      return "Claude session restarted after authentication failed";
    case "oauth_org_not_allowed":
      return "Claude session restarted after OAuth organization authorization failed";
    default:
      return null;
  }
}

function getCurrentThreadSession(
  args: CurrentThreadSessionArgs,
): ThreadSession | undefined {
  const threadSession = threadAttachments.get(args.threadId)?.residentSession;
  if (
    !threadSession ||
    threadSession.closing ||
    threadSession.sessionSerial !== args.sessionSerial
  ) {
    return undefined;
  }
  return threadSession;
}

function createOnSdkMessage(
  args: CreateSdkCallbackArgs,
): (message: SDKMessage) => void {
  return (message: SDKMessage) => {
    const threadSession = getCurrentThreadSession({
      sessionSerial: args.sessionSerial,
      threadId: args.threadIdRef.current,
    });
    if (!threadSession) return;
    const providerThreadId = message.session_id?.trim() ?? "";
    if (
      providerThreadId.length > 0 &&
      threadSession.attachment.providerThreadId !== providerThreadId
    ) {
      threadSession.attachment.providerThreadId = providerThreadId;
      sendThreadIdentity(args.threadIdRef.current, providerThreadId);
    }
    const authenticationFailureRestartReason =
      getAuthenticationFailureRestartReason(message);
    if (authenticationFailureRestartReason !== null) {
      threadSession.restartBeforeNextTurn = {
        reason: authenticationFailureRestartReason,
        showRuntimeNote: false,
      };
    }
    trackSdkAssistantPermissionEscalation(threadSession, message);
    if (
      message.type === "system" &&
      message.subtype === "session_state_changed"
    ) {
      threadSession.sdkSessionState = message.state;
    }
    emitForSession(threadSession, args.threadIdRef.current, "sdk/message", {
      threadId: args.threadIdRef.current,
      message,
    });
    const recoveryKind = getAssistantMessageRecoveryKind(message);
    if (recoveryKind !== null) {
      emitTerminalAccountErrorHint(
        threadSession,
        args.threadIdRef.current,
        recoveryKind,
        getAssistantMessageErrorText(message),
      );
    }
    refreshIdleQueryRelease(threadSession, args.threadIdRef.current);
  };
}

function createOnSdkDone(
  args: CreateSdkCallbackArgs,
): (error?: unknown) => void {
  return (error?: unknown) => {
    const threadSession = getCurrentThreadSession({
      sessionSerial: args.sessionSerial,
      threadId: args.threadIdRef.current,
    });
    if (!threadSession) return;

    threadSession.streamEnded = true;
    resolvePendingSessionWork(
      threadSession,
      "Claude SDK stream ended before pending work completed",
    );

    if (!error) return;

    const message = error instanceof Error ? error.message : String(error);

    emitSessionError(threadSession, args.threadIdRef.current, message);
  };
}

function findSessionByPendingInteractiveRequest(
  id: string | number,
): ThreadSession | undefined {
  for (const attachment of threadAttachments.values()) {
    const threadSession = attachment.residentSession;
    if (threadSession?.pendingInteractiveRequests.has(id)) {
      return threadSession;
    }
  }

  return undefined;
}

function resolvePendingInteractiveRequests(
  threadSession: ThreadSession,
  message: string,
): void {
  for (const [requestId, pending] of threadSession.pendingInteractiveRequests) {
    threadSession.pendingInteractiveRequests.delete(requestId);
    pending.resolve({
      behavior: "deny",
      interrupt: true,
      message,
      toolUseID: pending.itemId,
    });
  }
}

async function closeClaudeThreadSession(
  threadSession: ThreadSession,
  graceful: boolean,
): Promise<void> {
  if (graceful) {
    await threadSession.session.closeGracefully(THREAD_STOP_CLOSE_TIMEOUT_MS);
  } else {
    threadSession.session.stop();
  }
}

function buildSessionEnv(
  envOverrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const sessionEnv: NodeJS.ProcessEnv = {
    ...withoutBridgeRuntimeEnv(process.env),
    ...envOverrides,
    CLAUDE_CODE_ENTRYPOINT: "cli",
  };
  delete sessionEnv.CLAUDE_AGENT_SDK_CLIENT_APP;
  return sessionEnv;
}

const sessionConfigEnvVarsSchema = z.record(z.string(), z.string());

function readConfigEnvOverrides(
  config: Record<string, unknown> | undefined,
): Record<string, string> {
  const parsed = sessionConfigEnvVarsSchema.safeParse(config?.["envVars"]);
  return parsed.success ? parsed.data : {};
}

function environmentSignature(env: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function applyTurnEnvironment(
  attachment: ThreadAttachment,
  config: TurnStartParams["config"],
): void {
  if (config === undefined) {
    return;
  }
  const envOverrides = readConfigEnvOverrides(config);
  const signature = environmentSignature(envOverrides);
  if (attachment.envSignature === signature) {
    return;
  }
  attachment.envSignature = signature;
  attachment.sessionConstructionConfig = {
    ...attachment.sessionConstructionConfig,
    config,
  };
  attachment.sessionOptions.env = buildSessionEnv(envOverrides);
  if (attachment.residentSession) {
    attachment.residentSession.restartBeforeNextTurn = {
      reason:
        "Execution settings changed; the Claude session was rebuilt to apply them.",
      showRuntimeNote: true,
    };
  }
}

function parseClaudeSuggestedPermissionUpdates(
  value: unknown,
): ClaudeSuggestedPermissionUpdate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsedUpdates = value.flatMap((entry) => {
    const parsed = claudeSuggestedPermissionUpdateSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });

  return parsedUpdates.length > 0 ? parsedUpdates : undefined;
}

function buildInteractiveRequestParams(
  args: BuildInteractiveRequestParamsArgs,
): ClaudePermissionRequestApprovalParams {
  return {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    turnId: null,
    itemId: args.toolUseId,
    toolName: args.toolName,
    input: args.input,
    reason: args.decisionReason ?? args.promptText ?? null,
    permissions: toPendingInteractionPermissionProfile({
      toolName: args.toolName,
      blockedPath: args.blockedPath,
      suggestions: args.suggestions,
    }),
  };
}

function buildUserQuestionRequestParams(
  args: BuildUserQuestionRequestParamsArgs,
): ClaudeUserQuestionRequestParams {
  return {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    turnId: null,
    itemId: args.toolUseId,
    questions: args.input.questions,
  };
}

function decodePendingInteractiveResponse(
  pending: PendingInteractiveRequest,
  result: unknown,
): ClaudeInteractiveResponse | null {
  const outcome = claudeInteractionOutcomeSchema.safeParse({
    payload: pending.payload,
    resolution: result,
  });
  if (!outcome.success) {
    return null;
  }
  try {
    return buildClaudeInteractiveResponse(outcome.data);
  } catch {
    return null;
  }
}

function buildInteractivePermissionResult(
  pending: PendingInteractiveRequest,
  response: ClaudeInteractiveResponse,
): PermissionResult {
  switch (pending.kind) {
    case "permission_request":
      if (response.kind !== "permission_request") {
        return {
          behavior: "deny",
          message: "Interactive response kind mismatch",
          toolUseID: pending.itemId,
        };
      }
      if (response.behavior === "deny") {
        return {
          behavior: "deny",
          message: response.message,
          ...(response.interrupt === undefined
            ? {}
            : { interrupt: response.interrupt }),
          ...(response.decisionClassification === undefined
            ? {}
            : { decisionClassification: response.decisionClassification }),
          toolUseID: pending.itemId,
        };
      }
      return {
        behavior: "allow",
        updatedInput: pending.originalInput,
        ...(response.updatedPermissions === undefined
          ? {}
          : { updatedPermissions: response.updatedPermissions }),
        ...(response.decisionClassification === undefined
          ? {}
          : { decisionClassification: response.decisionClassification }),
        toolUseID: pending.itemId,
      };
    case "user_question":
      if (response.kind !== "user_question") {
        return {
          behavior: "deny",
          message: "Interactive response kind mismatch",
          toolUseID: pending.itemId,
        };
      }
      return {
        behavior: "allow",
        updatedInput: response.updatedInput,
        toolUseID: pending.itemId,
      };
  }
}

function createForwardInteractiveRequest(
  threadIdRef: ThreadIdRef,
): (args: ForwardInteractiveRequestArgs) => Promise<PermissionResult> {
  return (args) =>
    new Promise<PermissionResult>((resolve) => {
      const threadSession = threadAttachments.get(
        threadIdRef.current,
      )?.residentSession;
      if (!threadSession) {
        resolve({
          behavior: "deny",
          message: "Thread session not found",
          toolUseID: args.toolUseId,
        });
        return;
      }

      let params: ClaudePermissionRequestApprovalParams;
      try {
        params = buildInteractiveRequestParams(args);
      } catch (error) {
        resolve({
          behavior: "deny",
          message: error instanceof Error ? error.message : String(error),
          toolUseID: args.toolUseId,
        });
        return;
      }

      const requestId = nextInteractiveRequestId();

      const finish = (result: PermissionResult): void => {
        args.signal.removeEventListener("abort", onAbort);
        resolve(result);
        refreshIdleQueryRelease(threadSession, threadIdRef.current);
      };

      const onAbort = (): void => {
        if (!threadSession.pendingInteractiveRequests.delete(requestId)) {
          return;
        }
        finish({
          behavior: "deny",
          message: "Interactive request cancelled",
          toolUseID: args.toolUseId,
        });
      };

      const payload = buildClaudeApprovalInteractionPayload(params);

      args.signal.addEventListener("abort", onAbort, { once: true });
      threadSession.pendingInteractiveRequests.set(requestId, {
        itemId: args.toolUseId,
        kind: "permission_request",
        payload,
        originalInput: args.input,
        permissions: params.permissions,
        resolve: finish,
        toolName: args.toolName,
      });

      send({
        jsonrpc: "2.0",
        id: requestId,
        method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
        params: {
          threadId: args.threadId,
          providerThreadId: args.providerThreadId,
          turnId: null,
          providerNativeIds: true,
          payload,
        },
      });
    });
}

function createForwardUserQuestionRequest(
  threadIdRef: ThreadIdRef,
): (args: ForwardUserQuestionRequestArgs) => Promise<PermissionResult> {
  return (args) =>
    new Promise<PermissionResult>((resolve) => {
      const threadSession = threadAttachments.get(
        threadIdRef.current,
      )?.residentSession;
      if (!threadSession) {
        resolve({
          behavior: "deny",
          message: "Thread session not found",
          toolUseID: args.toolUseId,
        });
        return;
      }

      const params = buildUserQuestionRequestParams(args);
      const requestId = nextInteractiveRequestId();

      const finish = (result: PermissionResult): void => {
        args.signal.removeEventListener("abort", onAbort);
        resolve(result);
        refreshIdleQueryRelease(threadSession, threadIdRef.current);
      };

      const onAbort = (): void => {
        if (!threadSession.pendingInteractiveRequests.delete(requestId)) {
          return;
        }
        finish({
          behavior: "deny",
          message: "User question request cancelled",
          toolUseID: args.toolUseId,
        });
      };

      const payload = buildClaudeUserQuestionPayload(params);

      args.signal.addEventListener("abort", onAbort, { once: true });
      threadSession.pendingInteractiveRequests.set(requestId, {
        itemId: args.toolUseId,
        kind: "user_question",
        payload,
        resolve: finish,
      });

      send({
        jsonrpc: "2.0",
        id: requestId,
        method: BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest,
        params: {
          threadId: args.threadId,
          providerThreadId: args.providerThreadId,
          turnId: null,
          providerNativeIds: true,
          payload,
        },
      });
    });
}

async function enterPlanModeIfRequested(
  threadSession: ThreadSession,
  params: TurnStartParams | TurnSteerParams,
): Promise<void> {
  if (
    params.claudeCodePermissionMode !== "plan" ||
    threadSession.attachment.permissionMode === "plan"
  ) {
    return;
  }
  await threadSession.session.setPermissionMode("plan");
  threadSession.attachment.permissionMode = "plan";
}

function restoreApprovedPlanPermissionMode(threadSession: ThreadSession): void {
  if (
    threadSession.attachment.permissionMode ===
    threadSession.attachment.approvedPlanPermissionMode
  ) {
    return;
  }
  threadSession.attachment.permissionMode =
    threadSession.attachment.approvedPlanPermissionMode;
  void threadSession.session
    .setPermissionMode(threadSession.attachment.approvedPlanPermissionMode)
    .catch((error: unknown) => {
      logBridgeError(
        `Failed to leave Plan mode: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

function createCanUseTool(threadIdRef: ThreadIdRef): CanUseTool {
  const forwardInteractiveRequest =
    createForwardInteractiveRequest(threadIdRef);
  const forwardUserQuestionRequest =
    createForwardUserQuestionRequest(threadIdRef);

  return async (toolName, input, options) => {
    await new Promise<void>((resolve) => setImmediate(resolve));

    const threadSession = threadAttachments.get(
      threadIdRef.current,
    )?.residentSession;
    if (!threadSession) {
      return {
        behavior: "deny",
        message: "Thread session not found",
        toolUseID: options.toolUseID,
      };
    }

    if (toolName === CLAUDE_USER_QUESTION_TOOL_NAME) {
      const parsedInput = claudeUserQuestionInputSchema.safeParse(input);
      if (!parsedInput.success) {
        return {
          behavior: "deny",
          message: "Invalid AskUserQuestion input",
          toolUseID: options.toolUseID,
        };
      }
      return forwardUserQuestionRequest({
        threadId: threadIdRef.current,
        providerThreadId:
          threadSession.attachment.providerThreadId ?? threadIdRef.current,
        toolUseId: options.toolUseID,
        input: parsedInput.data,
        signal: options.signal,
      });
    }

    if (toolName === CLAUDE_EXIT_PLAN_MODE_TOOL_NAME) {
      if (!claudeExitPlanModeInputSchema.safeParse(input).success) {
        return {
          behavior: "deny",
          message: "Invalid ExitPlanMode input",
          toolUseID: options.toolUseID,
        };
      }
      return forwardInteractiveRequest({
        threadId: threadIdRef.current,
        providerThreadId:
          threadSession.attachment.providerThreadId ?? threadIdRef.current,
        toolName,
        toolUseId: options.toolUseID,
        input,
        decisionReason: undefined,
        promptText: undefined,
        blockedPath: undefined,
        suggestions: undefined,
        signal: options.signal,
      });
    }

    const interactiveRequestPolicy = {
      permissionEscalation: resolvePermissionEscalationForWork(threadSession, {
        ...(options.agentID !== undefined ? { agentId: options.agentID } : {}),
        toolUseId: options.toolUseID,
      }),
    };
    const suggestions = parseClaudeSuggestedPermissionUpdates(
      options.suggestions,
    );

    const requestContext: ClaudeCanUseToolDecisionContext = {
      toolName,
      blockedPath: options.blockedPath,
      decisionReason: options.decisionReason,
      suggestions,
    };
    const requestedPermissions =
      toPendingInteractionPermissionProfile(requestContext);
    if (
      toolName === "Bash" &&
      shouldAutoDenyInteractiveRequest(interactiveRequestPolicy) &&
      typeof input === "object" &&
      input !== null &&
      (input as { dangerouslyDisableSandbox?: unknown })
        .dangerouslyDisableSandbox === true
    ) {
      return {
        behavior: "deny",
        message: buildWorkspaceWriteDenialMessage(),
        toolUseID: options.toolUseID,
      };
    }
    if (
      hasClaudeSessionPermissionGrant({
        grants: threadSession.attachment.sessionPermissionGrants,
        permissions: requestedPermissions,
        toolName,
      })
    ) {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
        decisionClassification: "user_permanent",
      };
    }

    if (
      toolName === "Bash" &&
      (threadSession.attachment.permissionMode === "default" ||
        threadSession.attachment.permissionMode === "dontAsk")
    ) {
      const updatedInput = buildReadonlyBashUpdatedInput(input);
      if (updatedInput) {
        return {
          behavior: "allow",
          updatedInput,
          toolUseID: options.toolUseID,
        };
      }
    }

    const shouldRequestApproval =
      shouldRequestClaudePermissionApproval(requestContext) ||
      (options.suggestions?.length ?? 0) > 0;

    if (!shouldRequestApproval) {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
      };
    }

    if (threadSession.attachment.permissionMode === "bypassPermissions") {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
      };
    }

    if (
      shouldAutoDenyInteractiveRequest(interactiveRequestPolicy) ||
      threadSession.attachment.permissionMode === "dontAsk"
    ) {
      const policyMessage =
        threadSession.attachment.permissionMode === "acceptEdits" ||
        threadSession.attachment.permissionMode === "auto"
          ? buildWorkspaceWriteDenialMessage()
          : buildReadonlyDenialMessage();
      return {
        behavior: "deny",
        message: options.decisionReason ?? policyMessage,
        toolUseID: options.toolUseID,
      };
    }

    return forwardInteractiveRequest({
      threadId: threadIdRef.current,
      providerThreadId:
        threadSession.attachment.providerThreadId ?? threadIdRef.current,
      toolName,
      toolUseId: options.toolUseID,
      input,
      decisionReason: options.decisionReason,
      promptText: options.title ?? options.description,
      blockedPath: options.blockedPath,
      suggestions,
      signal: options.signal,
    });
  };
}

async function handleRequest(request: ClaudeCodeJsonRpcRequest): Promise<void> {
  switch (request.method) {
    case "initialize":
      const result: InitializeResult = {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: true,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "checkpoint",
          approvalEnforcedBy: "provider",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "inject",
          skills: { configure: true },
        },
      };
      sendResult(request.id, result);
      break;
    case "model/list":
      sendResult(request.id, await listModelsMemoized());
      break;
    case "provider/health":
      sendResult(request.id, await getClaudeProviderHealth());
      break;
    case "provider/usage":
      sendResult(request.id, await getClaudeProviderUsage());
      break;
    case "provider/installation/status":
      sendResult(request.id, await getClaudeProviderInstallationStatus());
      break;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getClaudeProviderInstallationRun(request.params.action),
      );
      break;
    case "thread/start":
      await handleThreadStart(
        request.id,
        claudeThreadStartParamsSchema.parse(
          toClaudeSessionParams(request.params),
        ),
      );
      break;
    case "thread/resume":
      await handleThreadResume(
        request.id,
        claudeThreadResumeParamsSchema.parse({
          ...toClaudeSessionParams(request.params),
          providerThreadId: request.params.providerThreadId,
        }),
      );
      break;
    case "thread/fork":
      await handleThreadFork(
        request.id,
        claudeThreadForkParamsSchema.parse({
          ...toClaudeSessionParams(request.params),
          sourceProviderThreadId: request.params.sourceProviderThreadId,
          ...(request.params.sourceProviderCheckpointId !== undefined
            ? {
                sourceProviderCheckpointId:
                  request.params.sourceProviderCheckpointId,
              }
            : {}),
        }),
      );
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
      sendResult(request.id, await closeThreadForStop(request.params.threadId));
      break;
    case "skills/configure":
      configuredSkillRoots = assembleSkillPlugins(request.params.roots);
      sendResult(request.id, { ok: true });
      break;
  }
}

async function handleThreadStart(
  id: string | number,
  params: ThreadStartParams,
): Promise<void> {
  const threadIdRef = { current: params.threadId };

  const existing = threadAttachments.get(threadIdRef.current);
  if (existing) {
    await closeThreadSession({
      graceful: false,
      message: "Thread session replaced while awaiting permission approval",
      threadId: threadIdRef.current,
    });
  }

  const env = buildSessionEnv(readConfigEnvOverrides(params.config));
  const sessionOptions = buildTrackedSessionOptions(params, env, threadIdRef);
  const providerThreadId = randomUUID();
  sessionOptions.sessionId = providerThreadId;
  sessionOptions.canUseTool = createCanUseTool(threadIdRef);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(() => threadIdRef.current),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }

  const attachment = createThreadAttachment({
    liveSettings: toInitialLiveSessionSettings(params),
    idleQueryReleaseEnabled: params.idleQueryReleaseEnabled,
    permissionEscalation: params.permissionEscalation,
    permissionMode: params.permissionMode,
    approvedPlanPermissionMode: params.approvedPlanPermissionMode,
    providerThreadId,
    sessionConstructionConfig: toSessionConstructionConfig(params),
    sessionOptions,
    sessionPermissionGrants: [],
    threadIdRef,
  });
  threadAttachments.set(threadIdRef.current, attachment);
  startAttachedResidentThreadSession(attachment);

  sendThreadIdentity(threadIdRef.current, providerThreadId);
  sendSessionReset(threadIdRef.current);
  sendResult(id, { providerThreadId, sessionRestorable: true });
}

async function handleThreadResume(
  id: string | number,
  params: ThreadResumeParams,
): Promise<void> {
  const threadId = params.threadId;
  const requestedProviderThreadId = params.providerThreadId ?? undefined;
  if (requestedProviderThreadId === undefined) {
    sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      "thread/resume requires a providerThreadId",
    );
    return;
  }
  const sessionConstructionConfig = toSessionConstructionConfig(params);

  const existing = threadAttachments.get(threadId);
  const existingSession = existing?.residentSession;
  if (
    existing &&
    requestedProviderThreadId &&
    !existing.closing &&
    !existingSession?.streamEnded &&
    existing.providerThreadId === requestedProviderThreadId &&
    isDeepStrictEqual(
      existing.sessionConstructionConfig,
      sessionConstructionConfig,
    )
  ) {
    const liveSettings = toInitialLiveSessionSettings(params);
    applyIdleQueryReleaseSetting(existing, params.idleQueryReleaseEnabled);
    if (existingSession) {
      await applyLiveSessionSettings(
        existingSession,
        params.threadId,
        liveSettings,
      );
      scheduleIdleQueryRelease(existingSession, threadId);
    } else {
      applyDormantLiveSessionSettings(existing, liveSettings);
    }
    existing.permissionEscalation = params.permissionEscalation;
    sendResult(id, {
      providerThreadId: requestedProviderThreadId,
      sessionRestorable: true,
    });
    return;
  }

  if (existing) {
    if (!existing.closing && existingSession) {
      emitSessionReplacement({
        contextLost: false,
        providerThreadId: requestedProviderThreadId ?? null,
        reason:
          "Claude session restarted: construction-scoped settings changed",
        threadId,
        threadSession: existingSession,
      });
    }
    await closeThreadSession({
      graceful: false,
      message: "Thread session replaced while awaiting permission approval",
      threadId,
    });
  }

  const env = buildSessionEnv(readConfigEnvOverrides(params.config));
  const threadIdRef = { current: threadId };
  const sessionOptions = buildTrackedSessionOptions(params, env, threadIdRef);
  sessionOptions.canUseTool = createCanUseTool(threadIdRef);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(() => threadIdRef.current),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }
  const attachment = createThreadAttachment({
    liveSettings: toInitialLiveSessionSettings(params),
    idleQueryReleaseEnabled: params.idleQueryReleaseEnabled,
    permissionEscalation: params.permissionEscalation,
    permissionMode: params.permissionMode,
    approvedPlanPermissionMode: params.approvedPlanPermissionMode,
    ...(requestedProviderThreadId
      ? { providerThreadId: requestedProviderThreadId }
      : {}),
    sessionConstructionConfig,
    sessionOptions,
    sessionPermissionGrants: [],
    threadIdRef,
  });
  threadAttachments.set(threadId, attachment);
  startAttachedResidentThreadSession(attachment, requestedProviderThreadId);

  sendThreadIdentity(threadId, requestedProviderThreadId);
  sendSessionReset(threadId);
  sendResult(id, {
    providerThreadId: requestedProviderThreadId,
    sessionRestorable: true,
  });
}

async function handleThreadFork(
  id: string | number,
  params: ThreadForkParams,
): Promise<void> {
  const threadId = params.threadId;

  const existing = threadAttachments.get(threadId);
  if (existing) {
    await closeThreadSession({
      graceful: false,
      message: "Thread session replaced while awaiting permission approval",
      threadId,
    });
  }

  let forkedProviderThreadId: string;
  try {
    const forkResult = await forkSession(params.sourceProviderThreadId, {
      ...(params.sourceProviderCheckpointId !== undefined
        ? { upToMessageId: params.sourceProviderCheckpointId }
        : {}),
    });
    forkedProviderThreadId = forkResult.sessionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(id, -32000, message);
    return;
  }

  const env = buildSessionEnv(readConfigEnvOverrides(params.config));
  const threadIdRef = { current: threadId };
  const sessionOptions = buildTrackedSessionOptions(params, env, threadIdRef);
  sessionOptions.canUseTool = createCanUseTool(threadIdRef);
  if (params.dynamicTools && params.dynamicTools.length > 0) {
    const mcpServer = buildBridgeMcpServer(
      params.dynamicTools,
      createForwardToolCall(() => threadIdRef.current),
    );
    sessionOptions.mcpServers = { [BRIDGE_MCP_SERVER_NAME]: mcpServer };
    sessionOptions.allowedTools = getAllowedToolNames(params.dynamicTools);
  }
  const attachment = createThreadAttachment({
    liveSettings: toInitialLiveSessionSettings(params),
    idleQueryReleaseEnabled: params.idleQueryReleaseEnabled,
    permissionEscalation: params.permissionEscalation,
    permissionMode: params.permissionMode,
    approvedPlanPermissionMode: params.approvedPlanPermissionMode,
    providerThreadId: forkedProviderThreadId,
    sessionConstructionConfig: toSessionConstructionConfig(params),
    sessionOptions,
    sessionPermissionGrants: [],
    threadIdRef,
  });
  threadAttachments.set(threadId, attachment);
  startAttachedResidentThreadSession(attachment, forkedProviderThreadId);

  sendThreadIdentity(threadId, forkedProviderThreadId);
  sendSessionReset(threadId);
  sendResult(id, {
    providerThreadId: forkedProviderThreadId,
    sessionRestorable: true,
  });
}

function toClaudeSessionParams(
  params: z.infer<typeof canonicalThreadStartParamsSchema>,
): Record<string, unknown> {
  return buildClaudeSessionParams({
    threadId: params.threadId,
    cwd: params.cwd,
    options: params.options,
    instructionMode: params.instructionMode,
    dynamicTools: params.dynamicTools,
    disallowedTools: params.disallowedTools,
    skillRoots: configuredSkillRoots ?? undefined,
  });
}

async function runTurnStart(
  id: string | number,
  params: TurnStartParams,
  acceptance: CanonicalTurnAcceptance,
): Promise<void> {
  const promptText = buildPromptText(params.input);
  if (promptText === undefined) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }

  const attachment = threadAttachments.get(params.threadId);
  if (attachment) {
    applyTurnEnvironment(attachment, params.config);
    applyIdleQueryReleaseSetting(attachment, params.idleQueryReleaseEnabled);
    applyChromeSetting(attachment, params.chromeEnabled);
  }

  const threadSession = await getWritableThreadSession(
    params.threadId,
    "new-turn",
  );
  if (!threadSession) {
    sendError(id, -32000, "No active session");
    return;
  }

  if (!threadSession.session.canPushInput()) {
    scheduleIdleQueryRelease(threadSession, params.threadId);
    sendError(id, -32000, "Claude SDK input stream is closed");
    return;
  }
  try {
    await applyLiveSessionSettings(
      threadSession,
      params.threadId,
      withTurnLiveSessionSettings(
        threadSession.attachment.liveSettings,
        params,
      ),
    );
    await enterPlanModeIfRequested(threadSession, params);
  } catch (error) {
    scheduleIdleQueryRelease(threadSession, params.threadId);
    const message = error instanceof Error ? error.message : String(error);
    sendError(id, -32000, message);
    return;
  }

  try {
    await pushPromptInput(
      threadSession,
      promptText,
      params.permissionEscalation,
    );
    emitCanonicalTurnInputAccepted(threadSession, acceptance, params.threadId);
    threadSession.attachment.permissionEscalation = params.permissionEscalation;
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    scheduleIdleQueryRelease(threadSession, params.threadId);
    const message = error instanceof Error ? error.message : String(error);
    sendError(id, -32000, message);
  }
}

async function handleTurnStart(
  id: string | number,
  params: CanonicalTurnStartParams,
): Promise<void> {
  await runTurnStart(
    id,
    claudeTurnStartParamsSchema.parse(
      buildClaudeTurnParams({
        threadId: params.threadId,
        providerThreadId: params.providerThreadId,
        input: params.input,
        options: params.options,
      }),
    ),
    {
      clientRequestId: params.clientRequestId,
      providerThreadId: params.providerThreadId,
    },
  );
}

async function runTurnSteer(
  id: string | number,
  params: TurnSteerParams,
  acceptance: CanonicalTurnAcceptance,
): Promise<void> {
  const promptText = buildPromptText(params.input);
  if (promptText === undefined) {
    sendError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, "Missing input text");
    return;
  }

  const attachment = threadAttachments.get(params.threadId);
  if (attachment) {
    applyIdleQueryReleaseSetting(attachment, params.idleQueryReleaseEnabled);
    applyChromeSetting(attachment, params.chromeEnabled);
  }

  const threadSession = await getWritableThreadSession(
    params.threadId,
    "steer",
  );
  if (!threadSession) {
    sendError(id, -32000, "No active session");
    return;
  }

  if (!threadSession.session.canPushInput()) {
    scheduleIdleQueryRelease(threadSession, params.threadId);
    sendError(id, -32000, "Claude SDK input stream is closed");
    return;
  }
  try {
    await applyLiveSessionSettings(
      threadSession,
      params.threadId,
      withTurnLiveSessionSettings(
        threadSession.attachment.liveSettings,
        params,
      ),
    );
    await enterPlanModeIfRequested(threadSession, params);
  } catch (error) {
    scheduleIdleQueryRelease(threadSession, params.threadId);
    const message = error instanceof Error ? error.message : String(error);
    sendError(id, -32000, message);
    return;
  }

  try {
    await pushPromptInput(
      threadSession,
      promptText,
      params.permissionEscalation,
    );
    emitCanonicalTurnInputAccepted(threadSession, acceptance, params.threadId);
    threadSession.attachment.permissionEscalation = params.permissionEscalation;
    sendResult(id, { threadId: params.threadId });
  } catch (error) {
    scheduleIdleQueryRelease(threadSession, params.threadId);
    const message = error instanceof Error ? error.message : String(error);
    sendError(id, -32000, message);
  }
}

async function handleTurnSteer(
  id: string | number,
  params: CanonicalTurnSteerParams,
): Promise<void> {
  await runTurnSteer(
    id,
    claudeTurnSteerParamsSchema.parse(
      buildClaudeTurnParams({
        threadId: params.threadId,
        providerThreadId: params.providerThreadId,
        expectedTurnId: params.expectedTurnId,
        input: params.input,
        options: params.options,
      }),
    ),
    {
      clientRequestId: params.clientRequestId,
      providerThreadId: params.providerThreadId,
    },
  );
}

async function closeThreadForStop(
  threadId: string,
): Promise<ClaudeCodeThreadStopResult> {
  await closeThreadSession({
    graceful: true,
    message: "Thread stopped while awaiting permission approval",
    threadId,
  });
  return { ok: true };
}

async function handleThreadStop(
  id: string | number,
  params: ThreadStopParams,
): Promise<void> {
  const threadSession = threadAttachments.get(params.threadId)?.residentSession;
  if (
    params.intent === "interrupt" &&
    threadSession != null &&
    !threadSession.closing
  ) {
    sendThreadDeltas(
      params.threadId,
      threadSession.translator.buildSessionSettlementDeltas(params.threadId),
    );
  }
  sendResult(id, await closeThreadForStop(params.threadId));
}

function localAttachmentMarker(args: {
  kind: "image" | "file";
  path: string;
  name?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
}): string {
  const namePart = args.name && args.name.length > 0 ? ` "${args.name}"` : "";
  const details: string[] = [];
  if (args.mimeType) details.push(args.mimeType);
  if (args.sizeBytes !== undefined) details.push(`${args.sizeBytes} bytes`);
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `[Attached ${args.kind}${namePart}${suffix}. It is on disk at ${args.path} — use the Read tool to view it.]`;
}

function buildPromptText(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input.length > 0 ? input : undefined;
  }
  if (!Array.isArray(input)) return undefined;

  const chunks: string[] = [];
  for (const item of input) {
    const parsed = promptInputItemSchema.safeParse(item);
    if (!parsed.success) continue;
    const entry = parsed.data;
    switch (entry.type) {
      case "text":
        if (entry.text.length > 0) chunks.push(entry.text);
        break;
      case "image":
        chunks.push(`[Attached image: ${entry.url}]`);
        break;
      case "localImage":
        chunks.push(localAttachmentMarker({ kind: "image", path: entry.path }));
        break;
      case "localFile":
        chunks.push(
          localAttachmentMarker({
            kind: "file",
            path: entry.path,
            name: entry.name,
            mimeType: entry.mimeType,
            sizeBytes: entry.sizeBytes,
          }),
        );
        break;
    }
  }

  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function handleParsedMessage(parsed: unknown): void {
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response && handleToolCallResponse(response)) {
    return;
  }

  if (response && findSessionByPendingInteractiveRequest(response.id)) {
    const threadSession = findSessionByPendingInteractiveRequest(response.id)!;
    const pending = threadSession.pendingInteractiveRequests.get(response.id)!;
    threadSession.pendingInteractiveRequests.delete(response.id);
    if ("error" in response) {
      pending.resolve({
        behavior: "deny",
        message: response.error.message ?? "Interactive request failed",
        toolUseID: pending.itemId,
      });
      return;
    }

    const interactiveResponse = decodePendingInteractiveResponse(
      pending,
      response.result,
    );
    if (interactiveResponse === null) {
      pending.resolve({
        behavior: "deny",
        message: "Invalid interactive response payload",
        toolUseID: pending.itemId,
      });
      return;
    }
    if (
      pending.kind === "permission_request" &&
      shouldCacheClaudeSessionPermission(interactiveResponse)
    ) {
      threadSession.attachment.sessionPermissionGrants.push({
        permissions: pending.permissions,
        toolName: pending.toolName,
      });
    }

    if (
      pending.kind === "permission_request" &&
      pending.toolName === CLAUDE_EXIT_PLAN_MODE_TOOL_NAME &&
      interactiveResponse.behavior === "allow"
    ) {
      restoreApprovedPlanPermissionMode(threadSession);
    }

    pending.resolve(
      buildInteractivePermissionResult(pending, interactiveResponse),
    );
    return;
  }

  const decoded = decodeClaudeCodeJsonRpcRequest(parsed);
  switch (decoded.kind) {
    case "not_a_request":
      return;
    case "unknown_method":
      logBridgeError(`Unknown method: ${decoded.method}`);
      sendError(
        decoded.id,
        BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Unknown method: ${decoded.method}`,
      );
      return;
    case "invalid_params": {
      const message = `Invalid params for ${decoded.method}: ${decoded.issues}`;
      logBridgeError(message);
      sendError(decoded.id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, message);
      return;
    }
    case "request": {
      runBridgeRequest({
        request: decoded.request,
        handleRequest,
        sendError,
      });
      return;
    }
  }
}

export const handleLine = createBridgeLineHandler({ handleParsedMessage });

let shuttingDown = false;

function shutdownGracefully(message: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  void closeThreadSessionsGracefully(message).finally(() => {
    process.exit(0);
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start: (context) => {
    bridgeTempDir = context.tempDir;
  },
  onSigterm: () => {
    shutdownGracefully(
      "Bridge shutting down while awaiting permission approval",
    );
  },
  onSigint: () => {
    shutdownGracefully("Bridge interrupted while awaiting permission approval");
  },
  onClose: () => {
    shutdownGracefully("Bridge closed while awaiting permission approval");
  },
});
